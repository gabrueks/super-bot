import fs from 'fs';
import path from 'path';
import { PortfolioState, Position, TradeRecord } from '../types';
import {
  DATA_DIR,
  PORTFOLIO_STATE_FILE,
  TRADE_HISTORY_FILE,
  DAILY_SNAPSHOT_FILE,
  botConfig,
} from '../config';
import { fetchAccountBalances, fetchCurrentPrice } from './binance.service';
import { log, logError } from '../logger';

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadTradeHistory(): TradeRecord[] {
  ensureDataDir();
  if (!fs.existsSync(TRADE_HISTORY_FILE)) return [];
  const raw = fs.readFileSync(TRADE_HISTORY_FILE, 'utf-8');
  return JSON.parse(raw);
}

export function saveTradeHistory(trades: TradeRecord[]): void {
  ensureDataDir();
  fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(trades, null, 2));
}

export function appendTrade(trade: TradeRecord): void {
  const trades = loadTradeHistory();
  trades.push(trade);
  saveTradeHistory(trades);
}

export function getRecentTrades(count = 10): TradeRecord[] {
  const trades = loadTradeHistory();
  return trades.slice(-count);
}

interface DailySnapshot {
  date: string;
  totalValue: number;
  timestamp: number;
}

function loadDailySnapshots(): DailySnapshot[] {
  ensureDataDir();
  if (!fs.existsSync(DAILY_SNAPSHOT_FILE)) return [];
  const raw = fs.readFileSync(DAILY_SNAPSHOT_FILE, 'utf-8');
  return JSON.parse(raw);
}

function saveDailySnapshots(snapshots: DailySnapshot[]): void {
  ensureDataDir();
  fs.writeFileSync(DAILY_SNAPSHOT_FILE, JSON.stringify(snapshots, null, 2));
}

export function saveDailySnapshot(totalValue: number): void {
  const snapshots = loadDailySnapshots();
  const today = new Date().toISOString().split('T')[0];

  const existingIndex = snapshots.findIndex((s) => s.date === today);
  if (existingIndex === -1) {
    snapshots.push({ date: today, totalValue, timestamp: Date.now() });
  }

  if (snapshots.length > 90) {
    snapshots.splice(0, snapshots.length - 90);
  }

  saveDailySnapshots(snapshots);
}

export function getDailyStartValue(): number | null {
  const snapshots = loadDailySnapshots();
  const today = new Date().toISOString().split('T')[0];
  const todaySnap = snapshots.find((s) => s.date === today);
  return todaySnap?.totalValue ?? null;
}

export async function buildPortfolioState(): Promise<PortfolioState> {
  log('PORTFOLIO', 'Fetching account balances from Binance...');
  const balances = await fetchAccountBalances();
  const usdtBalance = balances.find((b) => b.asset === 'USDT');
  const availableUsdt = usdtBalance?.free ?? 0;

  const positions: Position[] = [];
  let totalValue = availableUsdt;

  const pairAssets = botConfig.tradingPairs.map((pair) =>
    pair.replace('USDT', ''),
  );

  for (const balance of balances) {
    if (balance.asset === 'USDT') continue;
    if (!pairAssets.includes(balance.asset)) continue;

    const totalQty = balance.free + balance.locked;
    if (totalQty <= 0) continue;

    const symbol = `${balance.asset}USDT`;
    let currentPrice: number;
    try {
      log('PORTFOLIO', `Fetching price for ${symbol}...`);
      currentPrice = await fetchCurrentPrice(symbol);
    } catch (err) {
      logError('PORTFOLIO', `Failed to fetch price for ${symbol}, skipping`, err);
      continue;
    }

    const positionValue = totalQty * currentPrice;
    const costBasis = getAverageCostBasis(symbol);
    const unrealizedPnl = costBasis > 0
      ? positionValue - totalQty * costBasis
      : 0;
    const unrealizedPnlPercent = costBasis > 0
      ? ((currentPrice - costBasis) / costBasis) * 100
      : 0;

    totalValue += positionValue;

    if (positionValue < botConfig.riskParams.minTradeUsdt) {
      log('PORTFOLIO', `Dust skipped: ${symbol} qty=${totalQty.toFixed(6)} @ $${currentPrice.toFixed(2)} = $${positionValue.toFixed(2)}`);
      continue;
    }

    positions.push({
      symbol,
      quantity: totalQty,
      costBasis,
      currentPrice,
      unrealizedPnl,
      unrealizedPnlPercent,
    });

    log('PORTFOLIO', `Position: ${symbol} qty=${totalQty.toFixed(6)} @ $${currentPrice.toFixed(2)} = $${positionValue.toFixed(2)}`);
  }

  log('PORTFOLIO', `Portfolio built: $${availableUsdt.toFixed(2)} USDT + ${positions.length} positions = $${totalValue.toFixed(2)} total`);

  return {
    availableUsdt,
    totalValue,
    positions,
    lastUpdated: Date.now(),
  };
}

function getAverageCostBasis(symbol: string): number {
  const trades = loadTradeHistory();
  const symbolTrades = trades
    .filter((t) => t.symbol === symbol)
    .sort((a, b) => a.timestamp - b.timestamp);

  let totalQty = 0;
  let totalCost = 0;

  for (const trade of symbolTrades) {
    if (trade.side === 'BUY') {
      totalQty += trade.quantity;
      totalCost += trade.total;
    } else {
      const sellRatio = trade.quantity / totalQty;
      totalCost *= 1 - sellRatio;
      totalQty -= trade.quantity;
    }
    if (totalQty <= 0) {
      totalQty = 0;
      totalCost = 0;
    }
  }

  return totalQty > 0 ? totalCost / totalQty : 0;
}
