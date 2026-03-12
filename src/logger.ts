function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function log(context: string, message: string): void {
  process.stdout.write(`[${timestamp()}] [${context}] ${message}\n`);
}

export function logError(context: string, message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err ? String(err) : '';
  const suffix = detail ? ` -- ${detail}` : '';
  process.stderr.write(`[${timestamp()}] [${context}] ERROR: ${message}${suffix}\n`);
}
