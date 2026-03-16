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
const DEFAULT_RECV_WINDOW_MS = 10_000;
const SERVER_TIME_SYNC_TTL_MS = 60_000;

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

export class BinanceFuturesTimestampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinanceFuturesTimestampError';
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

export interface FuturesFundingFee {
  symbol: string;
  income: number;
  timestamp: number;
}

let futuresCircuitOpenUntil = 0;
const leverageConfiguredSymbols = new Set<string>();
const EXCHANGE_FILTER_CACHE_TTL_MS = 60 * 60 * 1000;
let futuresServerTimeOffsetMs = 0;
let futuresServerTimeSyncedAtMs = 0;

type FuturesSymbolFilters = {
  stepSize?: number;
  minQty?: number;
  minNotional?: number;
  tickSize?: number;
};

let exchangeFilterCache: {
  fetchedAt: number;
  bySymbol: Record<string, FuturesSymbolFilters>;
} | null = null;

function getStepPrecision(stepSize: number): number {
  const stepAsText = stepSize.toString();
  const decimals = stepAsText.split('.')[1];
  if (!decimals) {
    return 0;
  }
  return decimals.length;
}

function trimDecimalZeros(value: string): string {
  if (!value.includes('.')) {
    return value;
  }
  return value
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '');
}

function floorToStep(value: number, stepSize: number): number {
  if (!(stepSize > 0)) {
    return value;
  }
  return Math.floor(value / stepSize) * stepSize;
}

function formatFuturesQuantity(
  symbol: string,
  quantity: number,
  filters?: FuturesSymbolFilters,
): string {
  if (!(quantity > 0) || !Number.isFinite(quantity)) {
    throw new ExecutionBlockedError(`Invalid order quantity for ${symbol}`);
  }

  const stepSize = filters?.stepSize ?? shortBotConfig.stepSizes[symbol];
  if (stepSize && stepSize > 0) {
    const normalized = floorToStep(quantity, stepSize);
    if (!(normalized > 0)) {
      throw new ExecutionBlockedError(`Calculated quantity is below step size for ${symbol}`);
    }
    if (filters?.minQty && normalized < filters.minQty) {
      throw new ExecutionBlockedError(
        `Order quantity ${normalized} is below min quantity ${filters.minQty} for ${symbol}`,
      );
    }
    const precision = getStepPrecision(stepSize);
    return trimDecimalZeros(normalized.toFixed(precision));
  }

  return trimDecimalZeros(quantity.toFixed(8));
}

function formatFuturesPrice(
  symbol: string,
  price: number,
  filters?: FuturesSymbolFilters,
): string {
  if (!(price > 0) || !Number.isFinite(price)) {
    throw new ExecutionBlockedError(`Invalid order price for ${symbol}`);
  }
  const tickSize = filters?.tickSize;
  if (tickSize && tickSize > 0) {
    const normalized = floorToStep(price, tickSize);
    if (!(normalized > 0)) {
      throw new ExecutionBlockedError(`Calculated price is below tick size for ${symbol}`);
    }
    const precision = getStepPrecision(tickSize);
    return trimDecimalZeros(normalized.toFixed(precision));
  }
  return trimDecimalZeros(price.toFixed(8));
}

function parseFilterValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

async function refreshExchangeFilterCache(): Promise<void> {
  type ExchangeInfoResponse = {
    symbols: Array<{
      symbol: string;
      filters: Array<{
        filterType: string;
        stepSize?: string;
        minQty?: string;
        minNotional?: string;
        notional?: string;
        tickSize?: string;
      }>;
    }>;
  };

  const exchangeInfo = await executeWithRetries(
    'exchangeInfo',
    () => futuresRequest<ExchangeInfoResponse>('GET', '/fapi/v1/exchangeInfo'),
    2,
  );

  const bySymbol: Record<string, FuturesSymbolFilters> = {};
  for (const symbolInfo of exchangeInfo.symbols) {
    let stepSize: number | undefined;
    let minQty: number | undefined;
    let minNotional: number | undefined;
    let tickSize: number | undefined;

    for (const filter of symbolInfo.filters) {
      if (filter.filterType === 'LOT_SIZE' || filter.filterType === 'MARKET_LOT_SIZE') {
        stepSize = stepSize ?? parseFilterValue(filter.stepSize);
        minQty = minQty ?? parseFilterValue(filter.minQty);
      }
      if (filter.filterType === 'MIN_NOTIONAL' || filter.filterType === 'NOTIONAL') {
        minNotional = minNotional ?? parseFilterValue(filter.minNotional ?? filter.notional);
      }
      if (filter.filterType === 'PRICE_FILTER') {
        tickSize = tickSize ?? parseFilterValue(filter.tickSize);
      }
    }

    bySymbol[symbolInfo.symbol] = { stepSize, minQty, minNotional, tickSize };
  }

  exchangeFilterCache = {
    fetchedAt: Date.now(),
    bySymbol,
  };
}

async function getFuturesSymbolFilters(symbol: string): Promise<FuturesSymbolFilters | undefined> {
  const isCacheMissing = exchangeFilterCache === null;
  const isCacheExpired = exchangeFilterCache !== null
    ? Date.now() - exchangeFilterCache.fetchedAt > EXCHANGE_FILTER_CACHE_TTL_MS
    : false;

  if (isCacheMissing || isCacheExpired) {
    try {
      await refreshExchangeFilterCache();
    } catch (error) {
      log(
        'BINANCE-FUTURES',
        `Exchange filters refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return exchangeFilterCache?.bySymbol[symbol];
}

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

function parseOrderResultAllowEmpty(
  order: {
    symbol: string;
    side: 'BUY' | 'SELL';
    status: string;
    executedQty: string;
    avgPrice: string;
    cumQuote: string;
  },
): FuturesOrderResult {
  const executedQty = Number.parseFloat(order.executedQty);
  const cummulativeQuoteQty = Number.parseFloat(order.cumQuote);
  const parsedAvgPrice = Number.parseFloat(order.avgPrice);
  const avgPrice = Number.isFinite(parsedAvgPrice) && parsedAvgPrice > 0
    ? parsedAvgPrice
    : (Number.isFinite(cummulativeQuoteQty) && Number.isFinite(executedQty) && executedQty > 0
      ? cummulativeQuoteQty / executedQty
      : 0);

  return {
    symbol: order.symbol,
    side: order.side,
    executedQty: Number.isFinite(executedQty) && executedQty > 0 ? executedQty : 0,
    avgPrice: Number.isFinite(avgPrice) ? avgPrice : 0,
    cummulativeQuoteQty: Number.isFinite(cummulativeQuoteQty) && cummulativeQuoteQty > 0 ? cummulativeQuoteQty : 0,
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

function isTimestampWindowError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('outside of the recvwindow')
    || message.includes('timestamp for this request')
    || message.includes('"code":-1021')
    || message.includes('code=-1021');
}

function shouldSyncServerTime(): boolean {
  return Date.now() - futuresServerTimeSyncedAtMs > SERVER_TIME_SYNC_TTL_MS;
}

async function syncFuturesServerTime(force = false): Promise<void> {
  if (!force && !shouldSyncServerTime()) {
    return;
  }
  try {
    const url = `${envConfig.binanceFuturesBaseUrl}/fapi/v1/time`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      return;
    }
    const data = await response.json() as { serverTime?: number };
    if (typeof data.serverTime !== 'number' || !Number.isFinite(data.serverTime)) {
      return;
    }
    futuresServerTimeOffsetMs = data.serverTime - Date.now();
    futuresServerTimeSyncedAtMs = Date.now();
  } catch {
    return;
  }
}

function getSyncedTimestampMs(): number {
  return Date.now() + futuresServerTimeOffsetMs;
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
      if (isTimestampWindowError(error)) {
        if (attempt === maxAttempts) {
          throw new BinanceFuturesTimestampError(
            `Binance Futures ${operation} timestamp drift: ${getErrorMessage(error)}`,
          );
        }
        await syncFuturesServerTime(true);
        await sleep(100);
        continue;
      }

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
  await syncFuturesServerTime();
  const query = new URLSearchParams({
    ...params,
    recvWindow: DEFAULT_RECV_WINDOW_MS.toString(),
    timestamp: getSyncedTimestampMs().toString(),
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
  const symbolFilters = await getFuturesSymbolFilters(symbol);
  const formattedQuantity = formatFuturesQuantity(symbol, quantity, symbolFilters);
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
        quantity: formattedQuantity,
        newOrderRespType: 'RESULT',
      }),
    3,
  );

  return parseOrderResult('openShort', symbol, order);
}

export async function openShortPositionWithFallback(
  symbol: string,
  quantity: number,
  limitPrice: number,
  minFillRatio: number,
): Promise<FuturesOrderResult> {
  if (!(quantity > 0)) {
    throw new MarginUnavailableError(`Open short quantity must be > 0 for ${symbol}`);
  }

  const symbolFilters = await getFuturesSymbolFilters(symbol);
  const formattedQuantity = formatFuturesQuantity(symbol, quantity, symbolFilters);
  const formattedPrice = formatFuturesPrice(symbol, limitPrice, symbolFilters);
  await ensureSymbolLeverage(symbol);

  type OrderResponse = {
    symbol: string;
    side: 'BUY' | 'SELL';
    status: string;
    executedQty: string;
    avgPrice: string;
    cumQuote: string;
  };

  const limitOrder = await executeWithRetries(
    `openShortLimitIoc:${symbol}`,
    () =>
      futuresRequest<OrderResponse>('POST', '/fapi/v1/order', {
        symbol,
        side: 'SELL',
        type: 'LIMIT',
        timeInForce: 'IOC',
        quantity: formattedQuantity,
        price: formattedPrice,
        newOrderRespType: 'RESULT',
      }),
    2,
  );
  const parsedLimit = parseOrderResultAllowEmpty(limitOrder);
  if (parsedLimit.executedQty > 0) {
    const fillRatio = parsedLimit.executedQty / quantity;
    if (fillRatio >= Math.max(0, Math.min(1, minFillRatio))) {
      return parseOrderResult('openShort', symbol, {
        symbol: parsedLimit.symbol,
        side: parsedLimit.side,
        status: parsedLimit.status,
        executedQty: parsedLimit.executedQty.toString(),
        avgPrice: parsedLimit.avgPrice.toString(),
        cumQuote: parsedLimit.cummulativeQuoteQty.toString(),
      });
    }
  }

  const remainingQty = Math.max(0, quantity - parsedLimit.executedQty);
  if (!(remainingQty > 0)) {
    return parseOrderResult('openShort', symbol, {
      symbol: parsedLimit.symbol,
      side: parsedLimit.side,
      status: parsedLimit.status,
      executedQty: parsedLimit.executedQty.toString(),
      avgPrice: parsedLimit.avgPrice.toString(),
      cumQuote: parsedLimit.cummulativeQuoteQty.toString(),
    });
  }

  const marketRemainder = await openShortPosition(symbol, remainingQty);
  const totalQty = parsedLimit.executedQty + marketRemainder.executedQty;
  const totalQuote = parsedLimit.cummulativeQuoteQty + marketRemainder.cummulativeQuoteQty;
  const avgPrice = totalQty > 0 ? totalQuote / totalQty : 0;
  return parseOrderResult('openShort', symbol, {
    symbol,
    side: marketRemainder.side,
    status: marketRemainder.status,
    executedQty: totalQty.toString(),
    avgPrice: avgPrice.toString(),
    cumQuote: totalQuote.toString(),
  });
}

export async function closeShortPosition(symbol: string, quantity: number): Promise<FuturesOrderResult> {
  if (!(quantity > 0)) {
    throw new PositionNotFoundError(`Close short quantity must be > 0 for ${symbol}`);
  }
  const symbolFilters = await getFuturesSymbolFilters(symbol);
  const formattedQuantity = formatFuturesQuantity(symbol, quantity, symbolFilters);
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
        quantity: formattedQuantity,
        reduceOnly: 'true',
        newOrderRespType: 'RESULT',
      }),
    3,
  );

  return parseOrderResult('closeShort', symbol, order);
}

export async function fetchFuturesFundingFees(
  symbol: string,
  startTimeMs: number,
): Promise<FuturesFundingFee[]> {
  type IncomeResponseItem = {
    symbol: string;
    income: string;
    incomeType: string;
    time: number;
  };

  const fromTime = Number.isFinite(startTimeMs) && startTimeMs > 0
    ? Math.floor(startTimeMs)
    : Date.now() - 72 * 60 * 60 * 1000;

  const incomeRows = await executeWithRetries(
    `fundingFees:${symbol}`,
    () =>
      futuresRequest<IncomeResponseItem[]>('GET', '/fapi/v1/income', {
        symbol,
        incomeType: 'FUNDING_FEE',
        startTime: fromTime.toString(),
        limit: '100',
      }),
    2,
  );

  return incomeRows
    .map((row) => {
      const income = Number.parseFloat(row.income);
      return {
        symbol: row.symbol,
        income,
        timestamp: row.time,
      };
    })
    .filter((row) => Number.isFinite(row.income));
}
