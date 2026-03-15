import { botConfig } from './config';
import { MarketData, CycleResult, TradeRecord, PortfolioState } from './types';
import { placeMarketSellByQty } from './services/binance.service';
import { analyzeSymbol } from './services/analysis.service';
import { getCachedTicker, getCachedBookTicker } from './services/market-cache.service';
import {
  buildPortfolioState,
  getRecentTrades,
  saveDailySnapshot,
  getDailyStartValue,
  appendTrade,
} from './services/portfolio.service';
import { getTradeDecisions } from './services/claude.service';
import { executeDecisions } from './services/trading.service';
import { fetchFearAndGreed } from './services/sentiment.service';
import { checkTrailingStops, removeStop } from './services/stop-loss.service';
import { log, logError } from './logger';

let running = false;

function buildPriceMap(marketData: MarketData[]): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const md of marketData) {
    if (md.ticker.price > 0) {
      prices[md.symbol] = md.ticker.price;
    }
  }
  return prices;
}

export async function runCycle(): Promise<CycleResult | null> {
  if (running) {
    log('CYCLE', 'Skipped -- previous cycle still running');
    return null;
  }
  running = true;

  const cycleStart = Date.now();
  log('CYCLE', '=== Starting new cycle ===');

  try {
    const [marketData, sentiment] = await Promise.all([
      Promise.resolve(gatherMarketData()),
      fetchFearAndGreed(),
    ]);
    log('CYCLE', `Market data gathered for ${marketData.length} pairs (${Date.now() - cycleStart}ms)`);

    const priceMap = buildPriceMap(marketData);
    log('CYCLE', 'Building portfolio state...');
    const portfolio = await buildPortfolioState(priceMap);
    await processTrailingStops(priceMap, portfolio);
    log('CYCLE', `Portfolio: $${portfolio.availableUsdt.toFixed(2)} USDT available, $${portfolio.totalValue.toFixed(2)} total, ${portfolio.positions.length} positions`);

    if (getDailyStartValue() === null) {
      saveDailySnapshot(portfolio.totalValue);
      log('CYCLE', `Daily snapshot saved: $${portfolio.totalValue.toFixed(2)}`);
    }

    const recentTrades = getRecentTrades(10);
    log('CYCLE', `Loaded ${recentTrades.length} recent trades`);

    log('CYCLE', 'Sending data to Claude for analysis...');
    const claudeStart = Date.now();
    const claudeResponse = await getTradeDecisions(
      marketData,
      portfolio,
      recentTrades,
      sentiment,
    );
    log('CYCLE', `Claude responded in ${Date.now() - claudeStart}ms with ${claudeResponse.decisions.length} decisions`);

    log('CYCLE', 'Executing decisions...');
    const cycleResult = await executeDecisions(
      claudeResponse.decisions,
      portfolio,
    );

    printCycleResult(cycleResult, claudeResponse.marketSummary);
    log('CYCLE', `=== Cycle complete in ${Date.now() - cycleStart}ms ===`);

    return cycleResult;
  } catch (err) {
    logError('CYCLE', 'Cycle failed', err);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    return {
      timestamp: Date.now(),
      decisionsReceived: 0,
      decisionsApproved: 0,
      tradesExecuted: 0,
      trades: [],
      errors: [`Cycle failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  } finally {
    running = false;
  }
}

const STEP_SIZES: Record<string, number> = {
  BTCUSDT: 0.00001,
  ETHUSDT: 0.0001,
  BNBUSDT: 0.001,
  SOLUSDT: 0.01,
  XRPUSDT: 0.1,
  ADAUSDT: 0.1,
};

async function processTrailingStops(
  priceMap: Record<string, number>,
  portfolio: PortfolioState,
): Promise<void> {
  const triggered = checkTrailingStops(priceMap);
  if (triggered.length === 0) return;

  log('CYCLE', `${triggered.length} trailing stop(s) triggered -- auto-selling`);

  for (const stop of triggered) {
    try {
      const position = portfolio.positions.find((p) => p.symbol === stop.symbol);
      if (!position || position.quantity <= 0) {
        removeStop(stop.symbol);
        continue;
      }

      const stepSize = STEP_SIZES[stop.symbol] ?? 0.001;
      const orderResult = await placeMarketSellByQty(
        stop.symbol,
        position.quantity,
        stepSize,
      );

      const trade: TradeRecord = {
        id: `${Date.now()}-stop-${Math.random().toString(36).slice(2, 8)}`,
        symbol: stop.symbol,
        side: 'SELL',
        quantity: orderResult.executedQty,
        price: orderResult.avgPrice,
        total: orderResult.cummulativeQuoteQty,
        timestamp: Date.now(),
        reasoning: `Trailing stop triggered: price $${stop.currentPrice.toFixed(2)} dropped ${stop.dropPercent.toFixed(1)}% from peak $${stop.peakPrice.toFixed(2)}`,
      };

      appendTrade(trade);
      removeStop(stop.symbol);
      portfolio.availableUsdt += trade.total;
      position.quantity = Math.max(0, position.quantity - trade.quantity);
      if (position.quantity === 0) {
        portfolio.positions = portfolio.positions.filter((p) => p.symbol !== stop.symbol);
      }
      portfolio.totalValue = portfolio.availableUsdt + portfolio.positions.reduce(
        (sum, p) => sum + p.quantity * p.currentPrice,
        0,
      );
      log('CYCLE', `STOP-LOSS SELL ${stop.symbol}: qty=${trade.quantity.toFixed(6)} @ $${trade.price.toFixed(2)} = $${trade.total.toFixed(2)}`);
    } catch (err) {
      logError('CYCLE', `Failed to execute trailing stop sell for ${stop.symbol}`, err);
    }
  }
}

function gatherMarketData(): MarketData[] {
  const results: MarketData[] = [];

  for (const symbol of botConfig.tradingPairs) {
    log('MARKET', `Reading cached data for ${symbol}...`);

    const ticker = getCachedTicker(symbol) ?? {
      symbol,
      price: 0,
      priceChangePercent: 0,
      highPrice: 0,
      lowPrice: 0,
      volume: 0,
      quoteVolume: 0,
    };

    const orderBook = getCachedBookTicker(symbol) ?? {
      symbol,
      bidAskRatio: 1,
      topBidPrice: 0,
      topAskPrice: 0,
      bidDepth: 0,
      askDepth: 0,
    };

    const technicalAnalysis = analyzeSymbol(symbol);

    results.push({ symbol, ticker, orderBook, technicalAnalysis });
    log('MARKET', `${symbol}: $${ticker.price.toFixed(2)} (${ticker.priceChangePercent.toFixed(2)}%)`);
  }

  return results;
}

function printCycleResult(result: CycleResult, marketSummary: string): void {
  const divider = '─'.repeat(60);
  const timestamp = new Date(result.timestamp).toISOString();

  const lines = [
    '',
    divider,
    `CYCLE COMPLETE | ${timestamp}`,
    divider,
    `Market: ${marketSummary}`,
    `Decisions: ${result.decisionsReceived} received | ${result.decisionsApproved} approved | ${result.tradesExecuted} executed`,
  ];

  if (result.trades.length > 0) {
    lines.push('Trades:');
    for (const t of result.trades) {
      lines.push(
        `  ${t.side} ${t.symbol} | qty=${t.quantity.toFixed(6)} @ $${t.price.toFixed(2)} | $${t.total.toFixed(2)} | ${t.reasoning}`,
      );
    }
  }

  if (result.errors.length > 0) {
    lines.push('Notes:');
    for (const e of result.errors) {
      lines.push(`  ${e}`);
    }
  }

  lines.push(divider);
  process.stdout.write(lines.join('\n') + '\n');
}
