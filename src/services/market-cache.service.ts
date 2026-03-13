import { Kline, TickerStats, OrderBookSnapshot } from '../types';
import { botConfig, TIMEFRAMES, Timeframe } from '../config';
import { getClient } from './binance.service';
import { log } from '../logger';

const KLINE_BUFFER_SIZE = 60;

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

  const raw = await getClient().candles({ symbol, interval: tf, limit: KLINE_BUFFER_SIZE });
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

function startCandleStream(symbol: string, tf: Timeframe): void {
  const key = cacheKey(symbol, tf);

  const cleanup = getClient().ws.candles(symbol, tf, (event) => {
    const buffer = klineBuffers.get(key);
    if (!buffer) return;

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

export async function initMarketStreams(): Promise<void> {
  log('WS-CACHE', 'Initializing WebSocket market streams...');
  const pairs = botConfig.tradingPairs;

  const backfillPromises: Promise<void>[] = [];
  for (const symbol of pairs) {
    for (const tf of TIMEFRAMES) {
      backfillPromises.push(backfillKlines(symbol, tf));
    }
  }
  await Promise.all(backfillPromises);
  log('WS-CACHE', `Backfill complete for ${pairs.length} pairs x ${TIMEFRAMES.length} timeframes`);

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
    } catch {}
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

export function isCacheReady(): boolean {
  const pairs = botConfig.tradingPairs;
  for (const symbol of pairs) {
    if (!tickerCache.has(symbol)) return false;
    for (const tf of TIMEFRAMES) {
      const key = cacheKey(symbol, tf);
      if (!klineBuffers.has(key) || klineBuffers.get(key)!.length === 0) return false;
    }
  }
  return true;
}
