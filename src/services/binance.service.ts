import Binance, { BinanceRest, OrderSide } from 'binance-api-node';
import { envConfig } from '../config';
import { TradeSide } from '../types';
import { log } from '../logger';

let client: BinanceRest;
let restCircuitOpenUntil = 0;

const RATE_LIMIT_STATUS_CODES = new Set([418, 429]);
const MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_RETRY_BASE_MS = 400;

type BinanceErrorLike = {
  message?: string;
  status?: number;
  statusCode?: number;
  code?: number | string;
  response?: {
    status?: number;
    statusCode?: number;
    data?: {
      msg?: string;
    };
    headers?: Record<string, string | number>;
  };
};

export class BinanceRateLimitError extends Error {
  readonly retryAfterMs?: number;
  readonly banUntilMs?: number;

  constructor(message: string, retryAfterMs?: number, banUntilMs?: number) {
    super(message);
    this.name = 'BinanceRateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.banUntilMs = banUntilMs;
  }
}

export function getClient(): BinanceRest {
  if (!client) {
    log('BINANCE', 'Initializing Binance client');
    client = Binance({
      apiKey: envConfig.binanceApiKey,
      apiSecret: envConfig.binanceApiSecret,
    });
  }
  return client;
}

export interface AccountBalance {
  asset: string;
  free: number;
  locked: number;
}

export interface CandleRequest {
  symbol: string;
  interval: string;
  limit: number;
}

function getErrorMessage(error: unknown): string {
  if (!(error && typeof error === 'object')) return String(error);
  const e = error as BinanceErrorLike;
  return (
    e.message ??
    e.response?.data?.msg ??
    String(error)
  );
}

function getErrorStatus(error: unknown): number | undefined {
  if (!(error && typeof error === 'object')) return undefined;
  const e = error as BinanceErrorLike;
  const candidates = [
    e.status,
    e.statusCode,
    typeof e.code === 'number' ? e.code : undefined,
    e.response?.status,
    e.response?.statusCode,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function parseBanUntilMs(message: string): number | undefined {
  const match = message.match(/banned until\s+(\d{10,})/i);
  if (!match) return undefined;
  const ts = Number(match[1]);
  return Number.isFinite(ts) && ts > 0 ? ts : undefined;
}

function parseRetryAfterMs(error: unknown): number | undefined {
  if (!(error && typeof error === 'object')) return undefined;
  const e = error as BinanceErrorLike;
  const headerValue = e.response?.headers?.['retry-after'];
  if (headerValue === undefined) return undefined;
  const numeric = typeof headerValue === 'number'
    ? headerValue
    : Number(String(headerValue));
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric * 1000;
}

function isRateLimitError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== undefined && RATE_LIMIT_STATUS_CODES.has(status)) {
    return true;
  }
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('too much request weight') ||
    message.includes('ip banned') ||
    message.includes('too many requests') ||
    message.includes('rate limit')
  );
}

function computeBackoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  }
  const exp = DEFAULT_RETRY_BASE_MS * (2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 150);
  return Math.min(exp + jitter, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toRateLimitError(error: unknown): BinanceRateLimitError {
  const message = getErrorMessage(error);
  const banUntilMs = parseBanUntilMs(message);
  const retryAfterMs = parseRetryAfterMs(error);
  return new BinanceRateLimitError(message, retryAfterMs, banUntilMs);
}

export function isBinanceRestCircuitOpen(now = Date.now()): boolean {
  return restCircuitOpenUntil > now;
}

export function getBinanceRestCircuitOpenUntil(): number {
  return restCircuitOpenUntil;
}

async function executeRestCall<T>(
  operation: string,
  task: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  const now = Date.now();
  if (isBinanceRestCircuitOpen(now)) {
    const waitMs = restCircuitOpenUntil - now;
    throw new BinanceRateLimitError(
      `Binance REST circuit open for ${waitMs}ms`,
      waitMs,
      restCircuitOpenUntil,
    );
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (!isRateLimitError(error)) {
        throw error;
      }

      const rateLimitError = toRateLimitError(error);
      const banUntilMs = rateLimitError.banUntilMs;
      if (banUntilMs && banUntilMs > restCircuitOpenUntil) {
        restCircuitOpenUntil = banUntilMs;
      }

      const nowMs = Date.now();
      const banWaitMs = banUntilMs ? Math.max(0, banUntilMs - nowMs) : undefined;
      const backoffMs = computeBackoffMs(attempt, rateLimitError.retryAfterMs);

      if ((banWaitMs && banWaitMs > MAX_RETRY_DELAY_MS) || attempt === maxAttempts) {
        throw new BinanceRateLimitError(
          `Binance ${operation} rate-limited: ${rateLimitError.message}`,
          banWaitMs ?? backoffMs,
          banUntilMs,
        );
      }

      const delayMs = banWaitMs !== undefined && banWaitMs > 0
        ? Math.min(banWaitMs, MAX_RETRY_DELAY_MS)
        : backoffMs;

      log(
        'BINANCE',
        `Rate limit on ${operation}, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`Unexpected retry flow while executing ${operation}`);
}

export async function fetchAccountBalances(): Promise<AccountBalance[]> {
  log('BINANCE', 'Fetching account balances');
  const info = await executeRestCall(
    'accountInfo',
    () => getClient().accountInfo(),
    2,
  );
  const balances = info.balances
    .map((b) => ({
      asset: b.asset,
      free: parseFloat(b.free),
      locked: parseFloat(b.locked),
    }))
    .filter((b) => b.free > 0 || b.locked > 0);
  log('BINANCE', `Found ${balances.length} non-zero balances`);
  return balances;
}

export async function fetchCandles(req: CandleRequest): Promise<any[]> {
  return executeRestCall(
    `candles:${req.symbol}:${req.interval}`,
    () => getClient().candles(req),
    2,
  );
}

export interface OrderResult {
  symbol: string;
  orderId: number;
  side: string;
  executedQty: number;
  cummulativeQuoteQty: number;
  avgPrice: number;
  status: string;
}

export async function placeMarketOrder(
  symbol: string,
  side: TradeSide,
  quoteOrderQty: number,
): Promise<OrderResult> {
  log('BINANCE', `Placing MARKET ${side} ${symbol} for $${quoteOrderQty.toFixed(2)}`);
  const result = await executeRestCall(
    'order',
    () => getClient().order({
      symbol,
      side: side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
      type: 'MARKET' as any,
      quoteOrderQty: quoteOrderQty.toFixed(2),
    }),
    3,
  );

  const executedQty = parseFloat(result.executedQty);
  const cummQuoteQty = parseFloat(result.cummulativeQuoteQty);
  const avgPrice = executedQty > 0 ? cummQuoteQty / executedQty : 0;

  log('BINANCE', `Order filled: ${side} ${executedQty} ${symbol} @ avg $${avgPrice.toFixed(2)} | status=${result.status}`);

  return {
    symbol: result.symbol,
    orderId: result.orderId,
    side: result.side,
    executedQty,
    cummulativeQuoteQty: cummQuoteQty,
    avgPrice,
    status: result.status,
  };
}

export async function placeMarketSellByQty(
  symbol: string,
  quantity: number,
  stepSize: number,
): Promise<OrderResult> {
  const precision = stepSize.toString().split('.')[1]?.length ?? 0;
  const adjustedQty = Math.floor(quantity / stepSize) * stepSize;
  const qtyStr = adjustedQty.toFixed(precision);

  log('BINANCE', `Placing MARKET SELL ${symbol} qty=${qtyStr}`);
  const result = await executeRestCall(
    'order',
    () => getClient().order({
      symbol,
      side: OrderSide.SELL,
      type: 'MARKET' as any,
      quantity: qtyStr,
    }),
    3,
  );

  const executedQty = parseFloat(result.executedQty);
  const cummQuoteQty = parseFloat(result.cummulativeQuoteQty);
  const avgPrice = executedQty > 0 ? cummQuoteQty / executedQty : 0;

  log('BINANCE', `Order filled: SELL ${executedQty} ${symbol} @ avg $${avgPrice.toFixed(2)} | status=${result.status}`);

  return {
    symbol: result.symbol,
    orderId: result.orderId,
    side: result.side,
    executedQty,
    cummulativeQuoteQty: cummQuoteQty,
    avgPrice,
    status: result.status,
  };
}

