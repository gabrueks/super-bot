import cron from 'node-cron';
import { botConfig } from './config';
import { runCycle } from './bot';

function printBanner(): void {
  const lines = [
    '',
    '  SUPER-BOT | Claude-Powered Crypto Trader',
    `  Pairs: ${botConfig.tradingPairs.join(', ')}`,
    `  Schedule: ${botConfig.cronInterval}`,
    `  Model: ${botConfig.claudeModel}`,
    `  Risk: max ${(botConfig.riskParams.maxAllocationPerCoin * 100).toFixed(0)}%/coin, ${(botConfig.riskParams.maxTotalDeployment * 100).toFixed(0)}% total, ${(botConfig.riskParams.maxDailyLossPercent * 100).toFixed(0)}% daily loss limit`,
    '',
    '  Starting...',
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  printBanner();

  process.stdout.write('Running initial cycle...\n');
  await runCycle();

  const task = cron.schedule(botConfig.cronInterval, async () => {
    await runCycle();
  });

  const shutdown = (): void => {
    process.stdout.write('\nShutting down...\n');
    task.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
