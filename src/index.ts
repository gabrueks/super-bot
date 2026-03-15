import cron from 'node-cron';
import { botConfig } from './config';
import { runCycle } from './bot';
import { initMarketStreams, shutdownMarketStreams } from './services/market-cache.service';
import { refreshBalanceCache, startBalanceReconciler } from './services/portfolio.service';
import { log } from './logger';

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
  log('INIT', 'WebSocket streams ready, waiting 3s for initial ticker data...');
  await new Promise((r) => setTimeout(r, 3000));

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
    await runCycle();
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

main();
