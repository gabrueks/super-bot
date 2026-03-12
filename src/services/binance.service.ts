import Binance, { BinanceRest, CandleChartResult, OrderSide } from 'binance-api-node';
import { envConfig } from '../config';
import { Kline, TickerStats, OrderBookSnapshot, TradeSide } from '../types';
import { Timeframe } from '../config';
import { log } from '../logger';

let client: BinanceRest;

function getClient(): BinanceRest {
  if (!client) {
    log('BINANCE', 'Initializing Binance client');
    client = Binance({
      apiKey: envConfig.binanceApiKey,
      apiSecret: envConfig.binanceApiSecret,
    });
  }
  return client;
}

function mapCandle(c: CandleChartResult): Kline {
  return {
    openTime: c.openTime,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume),
    closeTime: c.closeTime,
  };
}

export async function fetchKlines(
  symbol: string,
  interval: Timeframe,
  limit = 100,
): Promise<Kline[]> {
  log('BINANCE', `Fetching klines ${symbol} ${interval} (limit=${limit})`);
  const raw = await getClient().candles({ symbol, interval, limit });
  log('BINANCE', `Got ${raw.length} candles for ${symbol} ${interval}`);
  return raw.map(mapCandle);
}

export async function fetchTicker(symbol: string): Promise<TickerStats> {
  log('BINANCE', `Fetching 24h ticker ${symbol}`);
  const raw: any = await getClient().dailyStats({ symbol });
  return {
    symbol,
    price: parseFloat(raw.lastPrice ?? raw.curDayClose ?? '0'),
    priceChangePercent: parseFloat(raw.priceChangePercent ?? '0'),
    highPrice: parseFloat(raw.highPrice ?? raw.high ?? '0'),
    lowPrice: parseFloat(raw.lowPrice ?? raw.low ?? '0'),
    volume: parseFloat(raw.volume ?? '0'),
    quoteVolume: parseFloat(raw.quoteVolume ?? raw.volumeQuote ?? '0'),
  };
}

export async function fetchOrderBook(
  symbol: string,
  limit = 20,
): Promise<OrderBookSnapshot> {
  log('BINANCE', `Fetching order book ${symbol}`);
  const book = await getClient().book({ symbol, limit });

  const bids: any[] = book.bids ?? [];
  const asks: any[] = book.asks ?? [];

  const extractQty = (entry: any): number => {
    if (Array.isArray(entry)) return parseFloat(entry[1] ?? '0');
    if (entry && typeof entry === 'object') return parseFloat(entry.quantity ?? entry.qty ?? '0');
    return 0;
  };

  const extractPrice = (entry: any): number => {
    if (Array.isArray(entry)) return parseFloat(entry[0] ?? '0');
    if (entry && typeof entry === 'object') return parseFloat(entry.price ?? '0');
    return 0;
  };

  const bidDepth = bids.slice(0, 10).reduce((sum, e) => sum + extractQty(e), 0);
  const askDepth = asks.slice(0, 10).reduce((sum, e) => sum + extractQty(e), 0);

  return {
    symbol,
    bidAskRatio: askDepth > 0 ? bidDepth / askDepth : 1,
    topBidPrice: bids.length > 0 ? extractPrice(bids[0]) : 0,
    topAskPrice: asks.length > 0 ? extractPrice(asks[0]) : 0,
    bidDepth,
    askDepth,
  };
}

export interface AccountBalance {
  asset: string;
  free: number;
  locked: number;
}

export async function fetchAccountBalances(): Promise<AccountBalance[]> {
  log('BINANCE', 'Fetching account balances');
  const info = await getClient().accountInfo();
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
  const result = await getClient().order({
    symbol,
    side: side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
    type: 'MARKET' as any,
    quoteOrderQty: quoteOrderQty.toFixed(2),
  });

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
  const result = await getClient().order({
    symbol,
    side: OrderSide.SELL,
    type: 'MARKET' as any,
    quantity: qtyStr,
  });

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

export async function fetchCurrentPrice(symbol: string): Promise<number> {
  const priceMap: Record<string, string> = await (getClient() as any).prices({ symbol });
  const price = priceMap[symbol];
  if (!price) {
    throw new Error(`No price returned for ${symbol}`);
  }
  return parseFloat(price);
}
