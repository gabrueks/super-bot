import { botConfig } from './config';
import { MarketData, CycleResult } from './types';
import { fetchTicker, fetchOrderBook } from './services/binance.service';
import { analyzeSymbol } from './services/analysis.service';
import {
  buildPortfolioState,
  getRecentTrades,
  saveDailySnapshot,
  getDailyStartValue,
} from './services/portfolio.service';
import { getTradeDecisions } from './services/claude.service';
import { executeDecisions } from './services/trading.service';
import { log, logError } from './logger';

let running = false;

export async function runCycle(): Promise<CycleResult | null> {
  if (running) {
    log('CYCLE', 'Skipped -- previous cycle still running');
    return null;
  }
  running = true;

  const cycleStart = Date.now();
  log('CYCLE', '=== Starting new cycle ===');

  try {
    log('CYCLE', 'Gathering market data...');
    const marketData = await gatherMarketData();
    log('CYCLE', `Market data gathered for ${marketData.length} pairs (${Date.now() - cycleStart}ms)`);

    log('CYCLE', 'Building portfolio state...');
    const portfolio = await buildPortfolioState();
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

async function gatherMarketData(): Promise<MarketData[]> {
  const results: MarketData[] = [];

  for (const symbol of botConfig.tradingPairs) {
    const start = Date.now();
    log('MARKET', `Fetching ${symbol}...`);
    try {
      const [ticker, orderBook, technicalAnalysis] = await Promise.all([
        fetchTicker(symbol),
        fetchOrderBook(symbol),
        analyzeSymbol(symbol),
      ]);

      results.push({ symbol, ticker, orderBook, technicalAnalysis });
      log('MARKET', `${symbol} done: $${ticker.price.toFixed(2)} (${ticker.priceChangePercent.toFixed(2)}%) [${Date.now() - start}ms]`);
    } catch (err) {
      logError('MARKET', `Failed to fetch ${symbol}`, err);
      results.push({
        symbol,
        ticker: {
          symbol,
          price: 0,
          priceChangePercent: 0,
          highPrice: 0,
          lowPrice: 0,
          volume: 0,
          quoteVolume: 0,
        },
        orderBook: {
          symbol,
          bidAskRatio: 1,
          topBidPrice: 0,
          topAskPrice: 0,
          bidDepth: 0,
          askDepth: 0,
        },
        technicalAnalysis: {
          symbol,
          currentPrice: 0,
          timeframes: [],
        },
      });
    }
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
