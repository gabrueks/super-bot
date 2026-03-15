import { shortBotConfig } from './config';
import { MarketData, ShortCycleResult } from './types';
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
    );
    const cycleResult = await executeShortDecisions(response.decisions, portfolio, priceMap);
    printShortCycleResult(cycleResult, response.marketSummary);
    log('SHORT-CYCLE', `=== Cycle complete in ${Date.now() - cycleStart}ms ===`);
    return cycleResult;
  } catch (error) {
    const failureCode = toFailureCode(error);
    logError('SHORT-CYCLE', 'Cycle failed', error);
    return {
      timestamp: Date.now(),
      decisionsReceived: 0,
      decisionsApproved: 0,
      tradesExecuted: 0,
      trades: [],
      errors: [`Cycle failed: ${error instanceof Error ? error.message : String(error)}`],
      failureCode,
    };
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
    lines.push('Trades:');
    for (const trade of result.trades) {
      lines.push(
        `  ${trade.side} ${trade.symbol} | qty=${trade.quantity.toFixed(6)} @ $${trade.price.toFixed(2)} | $${trade.total.toFixed(2)} | ${trade.reasoning}`,
      );
    }
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
