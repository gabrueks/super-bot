import { spawn, ChildProcess } from 'child_process';

function startBot(name: string, entryFile: string): ChildProcess {
  const child = spawn('npx', ['tsx', entryFile], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    process.stdout.write(`[PARALLEL] ${name} exited (code=${code ?? 'null'} signal=${signal ?? 'null'})\n`);
  });

  child.on('error', (error) => {
    process.stderr.write(`[PARALLEL] ${name} process error: ${error.message}\n`);
  });

  return child;
}

function main(): void {
  const spot = startBot('spot-bot', 'src/index.ts');
  const short = startBot('short-bot', 'src/index-short.ts');

  const shutdown = (): void => {
    if (!spot.killed) {
      spot.kill('SIGTERM');
    }
    if (!short.killed) {
      short.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
