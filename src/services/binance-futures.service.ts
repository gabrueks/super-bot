import { createHmac } from 'crypto';
import { envConfig, shortBotConfig } from '../config';
import { log } from '../logger';
import {
  ExecutionBlockedError,
  LeverageInvalidError,
  MarginUnavailableError,
  PositionNotFoundError,
} from '../errors/domain-errors';

const RATE_LIMIT_STATUS_CODES = new Set([418, 429]);
const MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_RETRY_BASE_MS = 400;

type BinanceFuturesErrorLike = {
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

export class BinanceFuturesRateLimitError extends Error {
  readonly retryAfterMs?: number;
  readonly banUntilMs?: number;

  constructor(message: string, retryAfterMs?: number, banUntilMs?: number) {
    super(message);
    this.name = 'BinanceFuturesRateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.banUntilMs = banUntilMs;
  }
}

export interface FuturesPosition {
  symbol: string;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  notionalValue: number;
}

export interface FuturesAccountState {
  availableUsdt: number;
  totalWalletBalance: number;
  positions: FuturesPosition[];
}

export interface FuturesOrderResult {
  symbol: string;
  side: 'BUY' | 'SELL';
  executedQty: number;
  avgPrice: number;
  cummulativeQuoteQty: number;
  status: string;
}

let futuresCircuitOpenUntil = 0;
const leverageConfiguredSymbols = new Set<string>();

function parseFiniteNumber(value: string, field: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new ExecutionBlockedError(`Invalid ${field} value from Binance Futures`);
  }
  return parsed;
}

function parseAccountBalance(value: string, field: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new MarginUnavailableError(`Invalid ${field} from Binance Futures account state`);
  }
  return parsed;
}

function normalizeShortPositionFromAccount(position: {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unrealizedProfit: string;
  notional: string;
}): FuturesPosition | null {
  const rawAmt = Number.parseFloat(position.positionAmt);
  const quantity = Math.abs(rawAmt);
  const entryPrice = Number.parseFloat(position.entryPrice);

  if (rawAmt >= 0 || !(quantity > 0) || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return null;
  }

  const parsedMarkPrice = Number.parseFloat(position.markPrice);
  const markPrice = Number.isFinite(parsedMarkPrice) && parsedMarkPrice > 0
    ? parsedMarkPrice
    : entryPrice;

  const parsedUnrealizedPnl = Number.parseFloat(position.unrealizedProfit);
  const unrealizedPnl = Number.isFinite(parsedUnrealizedPnl) ? parsedUnrealizedPnl : 0;

  const parsedNotional = Math.abs(Number.parseFloat(position.notional));
  const notionalValue = Number.isFinite(parsedNotional) && parsedNotional > 0
    ? parsedNotional
    : quantity * markPrice;

  return {
    symbol: position.symbol,
    quantity,
    entryPrice,
    markPrice,
    unrealizedPnl,
    notionalValue,
  };
}

function parseOrderResult(
  operation: 'openShort' | 'closeShort',
  symbol: string,
  order: {
    symbol: string;
    side: 'BUY' | 'SELL';
    status: string;
    executedQty: string;
    avgPrice: string;
    cumQuote: string;
  },
): FuturesOrderResult {
  const executedQty = parseFiniteNumber(order.executedQty, `${operation} executedQty for ${symbol}`);
  if (!(executedQty > 0)) {
    throw new ExecutionBlockedError(`Binance Futures ${operation} returned zero executed quantity for ${symbol}`);
  }

  const cummulativeQuoteQty = parseFiniteNumber(order.cumQuote, `${operation} cumQuote for ${symbol}`);
  if (cummulativeQuoteQty < 0) {
    throw new ExecutionBlockedError(`Binance Futures ${operation} returned negative quote quantity for ${symbol}`);
  }

  const parsedAvgPrice = Number.parseFloat(order.avgPrice);
  const avgPrice = Number.isFinite(parsedAvgPrice) && parsedAvgPrice > 0
    ? parsedAvgPrice
    : cummulativeQuoteQty / executedQty;

  if (!(avgPrice > 0)) {
    throw new ExecutionBlockedError(`Binance Futures ${operation} returned invalid average price for ${symbol}`);
  }

  return {
    symbol: order.symbol,
    side: order.side,
    executedQty,
    avgPrice,
    cummulativeQuoteQty,
    status: order.status,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getErrorMessage(error: unknown): string {
  if (!(error && typeof error === 'object')) return String(error);
  const e = error as BinanceFuturesErrorLike;
  return e.message ?? e.response?.data?.msg ?? String(error);
}

function getErrorStatus(error: unknown): number | undefined {
  if (!(error && typeof error === 'object')) return undefined;
  const e = error as BinanceFuturesErrorLike;
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
  const e = error as BinanceFuturesErrorLike;
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
    message.includes('too many requests')
    || message.includes('rate limit')
    || message.includes('ip banned')
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

function toRateLimitError(error: unknown): BinanceFuturesRateLimitError {
  const message = getErrorMessage(error);
  const banUntilMs = parseBanUntilMs(message);
  const retryAfterMs = parseRetryAfterMs(error);
  return new BinanceFuturesRateLimitError(message, retryAfterMs, banUntilMs);
}

async function executeWithRetries<T>(
  operation: string,
  task: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  const now = Date.now();
  if (isBinanceFuturesCircuitOpen(now)) {
    const waitMs = futuresCircuitOpenUntil - now;
    throw new BinanceFuturesRateLimitError(
      `Binance Futures circuit open for ${waitMs}ms`,
      waitMs,
      futuresCircuitOpenUntil,
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
      if (banUntilMs && banUntilMs > futuresCircuitOpenUntil) {
        futuresCircuitOpenUntil = banUntilMs;
      }

      const nowMs = Date.now();
      const banWaitMs = banUntilMs ? Math.max(0, banUntilMs - nowMs) : undefined;
      const backoffMs = computeBackoffMs(attempt, rateLimitError.retryAfterMs);

      if ((banWaitMs && banWaitMs > MAX_RETRY_DELAY_MS) || attempt === maxAttempts) {
        throw new BinanceFuturesRateLimitError(
          `Binance Futures ${operation} rate-limited: ${rateLimitError.message}`,
          banWaitMs ?? backoffMs,
          banUntilMs,
        );
      }

      const delayMs = banWaitMs !== undefined && banWaitMs > 0
        ? Math.min(banWaitMs, MAX_RETRY_DELAY_MS)
        : backoffMs;
      log(
        'BINANCE-FUTURES',
        `Rate limit on ${operation}, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`,
      );
      await sleep(delayMs);
    }
  }
  throw new Error(`Unexpected retry flow for ${operation}`);
}

function signQuery(query: URLSearchParams): string {
  return createHmac('sha256', envConfig.binanceApiSecret)
    .update(query.toString())
    .digest('hex');
}

async function futuresRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const query = new URLSearchParams({
    ...params,
    recvWindow: '5000',
    timestamp: Date.now().toString(),
  });
  query.set('signature', signQuery(query));

  const url = `${envConfig.binanceFuturesBaseUrl}${path}?${query.toString()}`;
  const response = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': envConfig.binanceApiKey,
    },
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`HTTP ${response.status}: ${bodyText}`);
  }
  return response.json() as Promise<T>;
}

export function isBinanceFuturesCircuitOpen(now = Date.now()): boolean {
  return futuresCircuitOpenUntil > now;
}

export async function fetchFuturesAccountState(): Promise<FuturesAccountState> {
  type AccountResponse = {
    availableBalance: string;
    totalWalletBalance: string;
    positions: Array<{
      symbol: string;
      positionAmt: string;
      entryPrice: string;
      markPrice: string;
      unrealizedProfit: string;
      notional: string;
    }>;
  };

  const account = await executeWithRetries(
    'futuresAccount',
    () => futuresRequest<AccountResponse>('GET', '/fapi/v2/account'),
    2,
  );

  const positions = account.positions
    .map((position) => normalizeShortPositionFromAccount(position))
    .filter((position): position is FuturesPosition => position !== null);

  return {
    availableUsdt: parseAccountBalance(account.availableBalance, 'availableBalance'),
    totalWalletBalance: parseAccountBalance(account.totalWalletBalance, 'totalWalletBalance'),
    positions,
  };
}

export async function ensureSymbolLeverage(symbol: string): Promise<void> {
  if (leverageConfiguredSymbols.has(symbol)) {
    return;
  }
  const leverage = shortBotConfig.riskParams.defaultLeverage;
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
    throw new LeverageInvalidError(`Invalid configured leverage ${leverage} for ${symbol}`);
  }

  await executeWithRetries(
    `setLeverage:${symbol}`,
    () =>
      futuresRequest('POST', '/fapi/v1/leverage', {
        symbol,
        leverage: leverage.toString(),
      }),
    2,
  );
  leverageConfiguredSymbols.add(symbol);
  log('BINANCE-FUTURES', `Leverage set for ${symbol}: ${leverage}x`);
}

export async function openShortPosition(symbol: string, quantity: number): Promise<FuturesOrderResult> {
  if (!(quantity > 0)) {
    throw new MarginUnavailableError(`Open short quantity must be > 0 for ${symbol}`);
  }
  await ensureSymbolLeverage(symbol);
  type OrderResponse = {
    symbol: string;
    side: 'BUY' | 'SELL';
    status: string;
    executedQty: string;
    avgPrice: string;
    cumQuote: string;
  };

  const order = await executeWithRetries(
    `openShort:${symbol}`,
    () =>
      futuresRequest<OrderResponse>('POST', '/fapi/v1/order', {
        symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: quantity.toFixed(6),
      }),
    3,
  );

  return parseOrderResult('openShort', symbol, order);
}

export async function closeShortPosition(symbol: string, quantity: number): Promise<FuturesOrderResult> {
  if (!(quantity > 0)) {
    throw new PositionNotFoundError(`Close short quantity must be > 0 for ${symbol}`);
  }
  type OrderResponse = {
    symbol: string;
    side: 'BUY' | 'SELL';
    status: string;
    executedQty: string;
    avgPrice: string;
    cumQuote: string;
  };

  const order = await executeWithRetries(
    `closeShort:${symbol}`,
    () =>
      futuresRequest<OrderResponse>('POST', '/fapi/v1/order', {
        symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: quantity.toFixed(6),
        reduceOnly: 'true',
      }),
    3,
  );

  return parseOrderResult('closeShort', symbol, order);
}
