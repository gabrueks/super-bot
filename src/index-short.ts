import cron from 'node-cron';
import { shortBotConfig } from './config';
import { runShortCycle } from './short-bot';
import { initMarketStreams, isCacheReady, shutdownMarketStreams } from './services/market-cache.service';
import { log } from './logger';
import { MarketDataUnavailableError } from './errors/domain-errors';
import { fetchFuturesAccountState } from './services/binance-futures.service';

function printBanner(): void {
  const lines = [
    '',
    '  SUPER-BOT | Claude-Powered Futures Short Trader',
    `  Pairs: ${shortBotConfig.tradingPairs.join(', ')}`,
    `  Schedule: ${shortBotConfig.cronInterval}`,
    `  Model: ${shortBotConfig.claudeModel}`,
    `  Leverage: ${shortBotConfig.riskParams.defaultLeverage}x`,
    '',
    '  Starting...',
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

async function waitForCacheReady(timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (isCacheReady(shortBotConfig.tradingPairs)) {
      log('SHORT-INIT', 'Market cache is ready for first cycle');
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new MarketDataUnavailableError(`Market cache did not become ready within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  printBanner();
  log('SHORT-INIT', 'Connecting WebSocket market data streams...');
  await initMarketStreams(shortBotConfig.tradingPairs);
  await waitForCacheReady(20_000);
  const accountState = await fetchFuturesAccountState();
  log(
    'SHORT-INIT',
    `Futures balance precheck: available=$${accountState.availableUsdt.toFixed(2)} wallet=$${accountState.totalWalletBalance.toFixed(2)} shorts=${accountState.positions.length}`,
  );

  log('SHORT-INIT', 'Running initial cycle...');
  await runShortCycle();

  const task = cron.schedule(shortBotConfig.cronInterval, async () => {
    try {
      await runShortCycle();
    } catch (error) {
      log('SHORT-CYCLE', `Scheduled cycle crashed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const shutdown = (): void => {
    log('SHORT-SHUTDOWN', 'Closing WebSocket connections...');
    shutdownMarketStreams();
    task.stop();
    log('SHORT-SHUTDOWN', 'Done.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  log('SHORT-INIT', `Fatal startup failure: ${error instanceof Error ? error.message : String(error)}`);
  shutdownMarketStreams();
  process.exit(1);
});
