import { Kline, TickerStats, OrderBookSnapshot } from '../types';
import { botConfig, TIMEFRAMES, Timeframe } from '../config';
import { fetchCandles, getClient } from './binance.service';
import { log, logError } from '../logger';

const KLINE_BUFFER_SIZE = 60;
const BACKFILL_REST_SPACING_MS = 150;
const BACKFILL_ENABLED = process.env.MARKET_CACHE_BACKFILL === 'true';

const klineBuffers = new Map<string, Kline[]>();
const tickerCache = new Map<string, TickerStats>();
const bookTickerCache = new Map<string, OrderBookSnapshot>();

const cleanupFns: Array<() => void> = [];

function cacheKey(symbol: string, tf: string): string {
  return `${symbol}:${tf}`;
}

async function backfillKlines(symbol: string, tf: Timeframe): Promise<void> {
  const key = cacheKey(symbol, tf);
  log('WS-CACHE', `Backfilling ${symbol} ${tf} klines from REST...`);

  const raw = await fetchCandles({ symbol, interval: tf, limit: KLINE_BUFFER_SIZE });
  const klines: Kline[] = raw.map((c) => ({
    openTime: c.openTime,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume),
    closeTime: c.closeTime,
  }));

  klineBuffers.set(key, klines);
  log('WS-CACHE', `Backfilled ${klines.length} candles for ${symbol} ${tf}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function startCandleStream(symbol: string, tf: Timeframe): void {
  const key = cacheKey(symbol, tf);

  const cleanup = getClient().ws.candles(symbol, tf, (event) => {
    let buffer = klineBuffers.get(key);
    if (!buffer) {
      buffer = [];
      klineBuffers.set(key, buffer);
    }

    const candle: Kline = {
      openTime: event.startTime,
      open: parseFloat(event.open),
      high: parseFloat(event.high),
      low: parseFloat(event.low),
      close: parseFloat(event.close),
      volume: parseFloat(event.volume),
      closeTime: event.closeTime,
    };

    if (event.isFinal) {
      buffer.push(candle);
      if (buffer.length > KLINE_BUFFER_SIZE) {
        buffer.shift();
      }
    } else {
      if (buffer.length > 0 && buffer[buffer.length - 1].openTime === candle.openTime) {
        buffer[buffer.length - 1] = candle;
      } else if (buffer.length === 0 || buffer[buffer.length - 1].openTime < candle.openTime) {
        buffer.push(candle);
        if (buffer.length > KLINE_BUFFER_SIZE + 1) {
          buffer.shift();
        }
      }
    }
  });

  cleanupFns.push(cleanup);
  log('WS-CACHE', `Candle stream started: ${symbol} ${tf}`);
}

function startTickerStream(symbols: string[]): void {
  const cleanup = getClient().ws.ticker(symbols, (event) => {
    const ticker: TickerStats = {
      symbol: event.symbol,
      price: parseFloat(event.curDayClose),
      priceChangePercent: parseFloat(event.priceChangePercent),
      highPrice: parseFloat(event.high),
      lowPrice: parseFloat(event.low),
      volume: parseFloat(event.volume),
      quoteVolume: parseFloat(event.volumeQuote),
    };
    tickerCache.set(event.symbol, ticker);
  });

  cleanupFns.push(cleanup);
  log('WS-CACHE', `Ticker stream started for ${symbols.join(', ')}`);
}

function startBookTickerStream(symbols: string[]): void {
  const cleanup = getClient().ws.bookTicker(symbols, (event) => {
    const bestBid = parseFloat(event.bestBid);
    const bestAsk = parseFloat(event.bestAsk);
    const bidQty = parseFloat(event.bestBidQnt);
    const askQty = parseFloat(event.bestAskQnt);

    const snapshot: OrderBookSnapshot = {
      symbol: event.symbol,
      bidAskRatio: askQty > 0 ? bidQty / askQty : 1,
      topBidPrice: bestBid,
      topAskPrice: bestAsk,
      bidDepth: bidQty,
      askDepth: askQty,
    };
    bookTickerCache.set(event.symbol, snapshot);
  });

  cleanupFns.push(cleanup);
  log('WS-CACHE', `Book ticker stream started for ${symbols.join(', ')}`);
}

export async function initMarketStreams(pairs: string[] = botConfig.tradingPairs): Promise<void> {
  log('WS-CACHE', 'Initializing WebSocket market streams...');

  for (const symbol of pairs) {
    for (const tf of TIMEFRAMES) {
      const key = cacheKey(symbol, tf);
      if (!klineBuffers.has(key)) {
        klineBuffers.set(key, []);
      }
    }
  }

  if (BACKFILL_ENABLED) {
    log('WS-CACHE', 'REST backfill enabled via MARKET_CACHE_BACKFILL=true');
    for (const symbol of pairs) {
      for (const tf of TIMEFRAMES) {
        try {
          await backfillKlines(symbol, tf);
          await sleep(BACKFILL_REST_SPACING_MS);
        } catch (error) {
          logError(
            'WS-CACHE',
            `Backfill failed for ${symbol} ${tf}, continuing with WebSocket-only warmup`,
            error,
          );
        }
      }
    }
    log('WS-CACHE', `Backfill attempt complete for ${pairs.length} pairs x ${TIMEFRAMES.length} timeframes`);
  } else {
    log('WS-CACHE', 'REST backfill disabled (WebSocket-only warmup)');
  }

  for (const symbol of pairs) {
    for (const tf of TIMEFRAMES) {
      startCandleStream(symbol, tf);
    }
  }

  startTickerStream(pairs);
  startBookTickerStream(pairs);

  log('WS-CACHE', `All streams active: ${cleanupFns.length} WebSocket connections`);
}

export function shutdownMarketStreams(): void {
  log('WS-CACHE', `Closing ${cleanupFns.length} WebSocket connections...`);
  for (const cleanup of cleanupFns) {
    try {
      cleanup();
    } catch (error) {
      logError('WS-CACHE', 'Failed to close WebSocket cleanup handler', error);
    }
  }
  cleanupFns.length = 0;
}

export function getCachedKlines(symbol: string, tf: Timeframe): Kline[] {
  const key = cacheKey(symbol, tf);
  return klineBuffers.get(key) ?? [];
}

export function getCachedTicker(symbol: string): TickerStats | null {
  return tickerCache.get(symbol) ?? null;
}

export function getCachedBookTicker(symbol: string): OrderBookSnapshot | null {
  return bookTickerCache.get(symbol) ?? null;
}

export function isCacheReady(pairs: string[] = botConfig.tradingPairs): boolean {
  for (const symbol of pairs) {
    if (!tickerCache.has(symbol)) return false;
    for (const tf of TIMEFRAMES) {
      const key = cacheKey(symbol, tf);
      if (!klineBuffers.has(key) || klineBuffers.get(key)!.length === 0) return false;
    }
  }
  return true;
}
