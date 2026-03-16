import { shortBotConfig } from './config';
import {
  MarketData,
  ShortCycleResult,
  ShortExecutionInput,
  ShortMarketRegime,
  ShortMarketRegimeKind,
  ShortSymbolRiskInput,
} from './types';
import { analyzeSymbol } from './services/analysis.service';
import { getCachedBookTicker, getCachedTicker } from './services/market-cache.service';
import {
  buildShortPortfolioState,
  getRecentShortTrades,
  saveShortDailySnapshot,
  getShortDailyStartValue,
} from './services/short-portfolio.service';
import { getShortTradeDecisions } from './services/short-claude.service';
import { executeShortDecisions } from './services/short-trading.service';
import { fetchFearAndGreed } from './services/sentiment.service';
import { recordShortCycleQuality } from './services/short-eval.service';
import { applyShortMeanReversionStrategy } from './services/short-mean-reversion.service';
import { log, logError } from './logger';
import { MarketDataUnavailableError, toFailureCode } from './errors/domain-errors';

let running = false;

function buildPriceMap(marketData: MarketData[]): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const item of marketData) {
    if (item.ticker.price > 0) {
      prices[item.symbol] = item.ticker.price;
    }
  }
  return prices;
}

function gatherMarketData(): MarketData[] {
  const results: MarketData[] = [];
  for (const symbol of shortBotConfig.tradingPairs) {
    const ticker = getCachedTicker(symbol);
    if (!ticker || !Number.isFinite(ticker.price) || ticker.price <= 0) {
      throw new MarketDataUnavailableError(`Ticker data unavailable for ${symbol}`);
    }

    const orderBook = getCachedBookTicker(symbol);
    if (!orderBook || !Number.isFinite(orderBook.topBidPrice) || !Number.isFinite(orderBook.topAskPrice)) {
      throw new MarketDataUnavailableError(`Order book data unavailable for ${symbol}`);
    }

    const technicalAnalysis = analyzeSymbol(symbol);
    results.push({ symbol, ticker, orderBook, technicalAnalysis });
  }
  return results;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildShortRiskInputs(marketData: MarketData[]): Record<string, ShortSymbolRiskInput> {
  const inputs: Record<string, ShortSymbolRiskInput> = {};
  for (const item of marketData) {
    const oneHour = item.technicalAnalysis.timeframes.find((tf) => tf.timeframe === '1h');
    const fallback = item.technicalAnalysis.timeframes.find((tf) => tf.timeframe === '15m');
    const atr = oneHour?.atr ?? fallback?.atr ?? 0;
    const price = item.ticker.price;
    if (!(price > 0)) {
      continue;
    }

    const atrStopUsdt = atr * shortBotConfig.riskParams.atrStopMultiplier;
    const minStopUsdt = price * shortBotConfig.riskParams.minStopDistancePercent;
    const maxStopUsdt = price * shortBotConfig.riskParams.maxStopDistancePercent;
    const stopDistanceUsdt = clamp(atrStopUsdt, minStopUsdt, maxStopUsdt);
    const stopDistancePercent = stopDistanceUsdt / price;

    if (!(stopDistancePercent > 0) || !Number.isFinite(stopDistancePercent)) {
      continue;
    }

    inputs[item.symbol] = {
      symbol: item.symbol,
      currentPrice: price,
      atr,
      stopDistanceUsdt,
      stopDistancePercent,
    };
  }
  return inputs;
}

function buildShortExecutionInputs(
  marketData: MarketData[],
): Record<string, ShortExecutionInput> {
  const inputs: Record<string, ShortExecutionInput> = {};
  for (const item of marketData) {
    const topBid = item.orderBook.topBidPrice;
    const topAsk = item.orderBook.topAskPrice;
    if (!(topBid > 0) || !(topAsk > 0) || topAsk < topBid) {
      continue;
    }
    const midPrice = (topBid + topAsk) / 2;
    if (!(midPrice > 0)) {
      continue;
    }
    const spreadPercent = (topAsk - topBid) / midPrice;
    const oneHour = item.technicalAnalysis.timeframes.find((tf) => tf.timeframe === '1h');
    const fallback = item.technicalAnalysis.timeframes.find((tf) => tf.timeframe === '15m');
    const atr = oneHour?.atr ?? fallback?.atr ?? 0;
    const atrPercent = midPrice > 0 ? atr / midPrice : 0;

    inputs[item.symbol] = {
      symbol: item.symbol,
      midPrice,
      topBidPrice: topBid,
      topAskPrice: topAsk,
      spreadPercent,
      bidAskRatio: item.orderBook.bidAskRatio,
      atrPercent,
    };
  }
  return inputs;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function classifyRegimeKind(
  breadth: number,
  sentimentValue: number,
): ShortMarketRegimeKind {
  if (sentimentValue >= 75 && breadth >= 0.15) {
    return 'EUPHORIA';
  }
  if (sentimentValue <= 25 && breadth <= -0.15) {
    return 'PANIC';
  }
  if (breadth >= 0.45) {
    return 'BULL_TREND';
  }
  if (breadth <= -0.45) {
    return 'BEAR_TREND';
  }
  return 'CHOPPY';
}

function buildShortMarketRegime(
  marketData: MarketData[],
  sentimentValue: number,
): ShortMarketRegime {
  if (marketData.length === 0) {
    return {
      kind: 'CHOPPY',
      strength: 0,
      breadth: 0,
      averageRsi1h: 50,
      sentimentValue,
    };
  }

  const trendVotes: number[] = marketData.map((item) => {
    const tf1h = item.technicalAnalysis.timeframes.find((tf) => tf.timeframe === '1h');
    if (!tf1h) {
      return 0;
    }

    const bullishStack = tf1h.ema9 > tf1h.ema21 && tf1h.ema21 > tf1h.ema50;
    const bearishStack = tf1h.ema9 < tf1h.ema21 && tf1h.ema21 < tf1h.ema50;
    const bullishMomentum = tf1h.macd.histogram > 0;
    const bearishMomentum = tf1h.macd.histogram < 0;

    if (bullishStack && bullishMomentum) return 1;
    if (bearishStack && bearishMomentum) return -1;
    return 0;
  });

  const voteSum = trendVotes.reduce((sum, vote) => sum + vote, 0);
  const breadth = voteSum / marketData.length;
  const averageRsi1h = marketData.reduce((sum, item) => {
    const tf1h = item.technicalAnalysis.timeframes.find((tf) => tf.timeframe === '1h');
    return sum + (tf1h?.rsi ?? 50);
  }, 0) / marketData.length;

  const kind = classifyRegimeKind(breadth, sentimentValue);
  const sentimentDrift = Math.abs(sentimentValue - 50) / 50;
  const strength = clamp01((Math.abs(breadth) * 0.7) + (sentimentDrift * 0.3));

  return {
    kind,
    strength,
    breadth,
    averageRsi1h,
    sentimentValue,
  };
}

export async function runShortCycle(): Promise<ShortCycleResult | null> {
  if (running) {
    log('SHORT-CYCLE', 'Skipped -- previous cycle still running');
    return null;
  }
  running = true;
  const cycleStart = Date.now();
  try {
    const [marketData, sentiment] = await Promise.all([
      Promise.resolve(gatherMarketData()),
      fetchFearAndGreed(),
    ]);
    const priceMap = buildPriceMap(marketData);
    const riskInputs = buildShortRiskInputs(marketData);
    const executionInputs = buildShortExecutionInputs(marketData);
    const regime = buildShortMarketRegime(marketData, sentiment.value);
    log(
      'SHORT-CYCLE',
      `Regime: ${regime.kind} strength=${regime.strength.toFixed(2)} breadth=${regime.breadth.toFixed(2)} sentiment=${regime.sentimentValue}`,
    );
    const portfolio = await buildShortPortfolioState();
    if (getShortDailyStartValue() === null) {
      saveShortDailySnapshot(portfolio.totalValue);
    }
    const recentTrades = getRecentShortTrades(10);
    const response = await getShortTradeDecisions(
      marketData,
      portfolio,
      recentTrades,
      sentiment,
      regime,
    );
    const meanReversionResult = applyShortMeanReversionStrategy(
      response.decisions,
      marketData,
      portfolio,
      regime,
    );
    if (meanReversionResult.adjustedSymbols.length > 0) {
      log(
        'SHORT-STRATEGY',
        `Mean-reversion adjusted: ${meanReversionResult.adjustedSymbols.join(', ')}`,
      );
    }
    const cycleResult = await executeShortDecisions(
      meanReversionResult.decisions,
      portfolio,
      priceMap,
      riskInputs,
      executionInputs,
      regime,
    );
    printShortCycleResult(cycleResult, response.marketSummary);
    log('SHORT-CYCLE', `=== Cycle complete in ${Date.now() - cycleStart}ms ===`);
    recordShortCycleQuality(cycleResult, Date.now() - cycleStart);
    return cycleResult;
  } catch (error) {
    const failureCode = toFailureCode(error);
    logError('SHORT-CYCLE', 'Cycle failed', error);
    const failureResult: ShortCycleResult = {
      timestamp: Date.now(),
      decisionsReceived: 0,
      decisionsApproved: 0,
      tradesExecuted: 0,
      trades: [],
      errors: [`Cycle failed: ${error instanceof Error ? error.message : String(error)}`],
      failureCode,
    };
    recordShortCycleQuality(failureResult, Date.now() - cycleStart);
    return failureResult;
  } finally {
    running = false;
  }
}

function printShortCycleResult(result: ShortCycleResult, marketSummary: string): void {
  const divider = '─'.repeat(60);
  const timestamp = new Date(result.timestamp).toISOString();
  const lines = [
    '',
    divider,
    `SHORT CYCLE COMPLETE | ${timestamp}`,
    divider,
    `Market: ${marketSummary}`,
    `Decisions: ${result.decisionsReceived} received | ${result.decisionsApproved} approved | ${result.tradesExecuted} executed`,
  ];

  if (result.trades.length > 0) {
    const estimatedFeesUsdt = result.trades.reduce((sum, trade) => {
      if (Number.isFinite(trade.estimatedFeesUsdt)) {
        return sum + (trade.estimatedFeesUsdt ?? 0);
      }
      return sum;
    }, 0);
    const estimatedNetPnlUsdt = result.trades.reduce((sum, trade) => {
      if (Number.isFinite(trade.estimatedNetPnlUsdt)) {
        return sum + (trade.estimatedNetPnlUsdt ?? 0);
      }
      return sum;
    }, 0);
    lines.push('Trades:');
    for (const trade of result.trades) {
      const estimatedNetText = Number.isFinite(trade.estimatedNetPnlUsdt)
        ? ` | estNet=$${(trade.estimatedNetPnlUsdt ?? 0).toFixed(2)}`
        : '';
      lines.push(
        `  ${trade.side} ${trade.symbol} | qty=${trade.quantity.toFixed(6)} @ $${trade.price.toFixed(2)} | $${trade.total.toFixed(2)}${estimatedNetText} | ${trade.reasoning}`,
      );
    }
    lines.push(
      `Estimated PnL: net=$${estimatedNetPnlUsdt.toFixed(2)} | fees=$${estimatedFeesUsdt.toFixed(2)}`,
    );
  }

  if (result.errors.length > 0) {
    lines.push('Notes:');
    for (const error of result.errors) {
      lines.push(`  ${error}`);
    }
  }
  lines.push(divider);
  process.stdout.write(lines.join('\n') + '\n');
}
