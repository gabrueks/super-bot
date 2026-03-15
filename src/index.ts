import cron from 'node-cron';
import { botConfig } from './config';
import { runCycle } from './bot';
import { initMarketStreams, isCacheReady, shutdownMarketStreams } from './services/market-cache.service';
import { refreshBalanceCache, startBalanceReconciler } from './services/portfolio.service';
import { log } from './logger';
import { MarketDataUnavailableError } from './errors/domain-errors';

function printBanner(): void {
  const lines = [
    '',
    '  SUPER-BOT | Claude-Powered Crypto Trader',
    `  Pairs: ${botConfig.tradingPairs.join(', ')}`,
    `  Schedule: ${botConfig.cronInterval}`,
    `  Model: ${botConfig.claudeModel}`,
    `  Data: WebSocket streams (real-time)`,
    `  Risk: max ${(botConfig.riskParams.maxAllocationPerCoin * 100).toFixed(0)}%/coin, ${(botConfig.riskParams.maxTotalDeployment * 100).toFixed(0)}% total, ${(botConfig.riskParams.maxDailyLossPercent * 100).toFixed(0)}% daily loss limit`,
    '',
    '  Starting...',
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  printBanner();

  log('INIT', 'Connecting WebSocket market data streams...');
  await initMarketStreams();
  await waitForCacheReady(20_000);

  try {
    await refreshBalanceCache();
    log('INIT', 'Balance cache warmed from Binance REST');
  } catch (error) {
    log('INIT', `Balance cache warmup skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  const stopBalanceReconciler = startBalanceReconciler();

  log('INIT', 'Running initial cycle...');
  await runCycle();

  const task = cron.schedule(botConfig.cronInterval, async () => {
    try {
      await runCycle();
    } catch (error) {
      log('CYCLE', `Scheduled cycle crashed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const shutdown = (): void => {
    log('SHUTDOWN', 'Closing WebSocket connections...');
    shutdownMarketStreams();
    stopBalanceReconciler();
    task.stop();
    log('SHUTDOWN', 'Done.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function waitForCacheReady(timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (isCacheReady()) {
      log('INIT', 'Market cache is ready for first cycle');
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new MarketDataUnavailableError(`Market cache did not become ready within ${timeoutMs}ms`);
}

main().catch((error) => {
  log('INIT', `Fatal startup failure: ${error instanceof Error ? error.message : String(error)}`);
  shutdownMarketStreams();
  process.exit(1);
});
