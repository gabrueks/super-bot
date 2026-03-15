import fs from 'fs';
import { ShortPortfolioState, ShortPosition, ShortTradeRecord } from '../types';
import {
  DATA_DIR,
  SHORT_DAILY_SNAPSHOT_FILE,
  SHORT_TRADE_HISTORY_FILE,
} from '../config';
import { fetchFuturesAccountState } from './binance-futures.service';

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadShortTradeHistory(): ShortTradeRecord[] {
  ensureDataDir();
  if (!fs.existsSync(SHORT_TRADE_HISTORY_FILE)) return [];
  const raw = fs.readFileSync(SHORT_TRADE_HISTORY_FILE, 'utf-8');
  return JSON.parse(raw) as ShortTradeRecord[];
}

export function saveShortTradeHistory(trades: ShortTradeRecord[]): void {
  ensureDataDir();
  fs.writeFileSync(SHORT_TRADE_HISTORY_FILE, JSON.stringify(trades, null, 2));
}

export function appendShortTrade(trade: ShortTradeRecord): void {
  const trades = loadShortTradeHistory();
  trades.push(trade);
  saveShortTradeHistory(trades);
}

export function getRecentShortTrades(count = 10): ShortTradeRecord[] {
  const trades = loadShortTradeHistory();
  return trades.slice(-count);
}

interface DailySnapshot {
  date: string;
  totalValue: number;
  timestamp: number;
}

function loadDailySnapshots(): DailySnapshot[] {
  ensureDataDir();
  if (!fs.existsSync(SHORT_DAILY_SNAPSHOT_FILE)) return [];
  const raw = fs.readFileSync(SHORT_DAILY_SNAPSHOT_FILE, 'utf-8');
  return JSON.parse(raw) as DailySnapshot[];
}

function saveDailySnapshots(snapshots: DailySnapshot[]): void {
  ensureDataDir();
  fs.writeFileSync(SHORT_DAILY_SNAPSHOT_FILE, JSON.stringify(snapshots, null, 2));
}

export function saveShortDailySnapshot(totalValue: number): void {
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

export function getShortDailyStartValue(): number | null {
  const snapshots = loadDailySnapshots();
  const today = new Date().toISOString().split('T')[0];
  const todaySnapshot = snapshots.find((s) => s.date === today);
  return todaySnapshot?.totalValue ?? null;
}

function toShortPosition(
  symbol: string,
  quantity: number,
  entryPrice: number,
  currentPrice: number,
  unrealizedPnl: number,
  notionalValue: number,
): ShortPosition {
  const unrealizedPnlPercent = entryPrice > 0
    ? ((entryPrice - currentPrice) / entryPrice) * 100
    : 0;
  return {
    symbol,
    quantity,
    entryPrice,
    currentPrice,
    unrealizedPnl,
    unrealizedPnlPercent,
    notionalValue,
  };
}

export async function buildShortPortfolioState(): Promise<ShortPortfolioState> {
  const account = await fetchFuturesAccountState();
  const positions = account.positions.map((position) =>
    toShortPosition(
      position.symbol,
      position.quantity,
      position.entryPrice,
      position.markPrice,
      position.unrealizedPnl,
      position.notionalValue,
    ));

  return {
    availableUsdt: account.availableUsdt,
    totalValue: account.totalWalletBalance,
    positions,
    lastUpdated: Date.now(),
  };
}
