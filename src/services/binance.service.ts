import Binance, { BinanceRest, OrderSide } from 'binance-api-node';
import { envConfig } from '../config';
import { TradeSide } from '../types';
import { log } from '../logger';

let client: BinanceRest;

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

