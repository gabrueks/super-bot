import fs from 'fs';
import { PortfolioState, Position, TradeRecord } from '../types';
import {
  DATA_DIR,
  TRADE_HISTORY_FILE,
  DAILY_SNAPSHOT_FILE,
  botConfig,
} from '../config';
import {
  AccountBalance,
  BinanceRateLimitError,
  fetchAccountBalances,
} from './binance.service';
import { log, logError } from '../logger';

const BALANCE_CACHE_TTL_MS = 60_000;
const STALE_BALANCE_MAX_AGE_MS = 15 * 60 * 1000;
const STALE_BALANCE_RATE_LIMIT_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const BALANCE_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
const BALANCE_CACHE_FILE = `${DATA_DIR}/balance-cache.json`;

interface BalanceCache {
  balances: AccountBalance[];
  fetchedAt: number;
}

let balanceCache: BalanceCache | null = null;

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

function cacheBalances(balances: AccountBalance[]): void {
  const nextCache: BalanceCache = {
    balances,
    fetchedAt: Date.now(),
  };
  balanceCache = nextCache;
  ensureDataDir();
  fs.writeFileSync(BALANCE_CACHE_FILE, JSON.stringify(nextCache, null, 2));
}

function loadPersistedBalanceCache(): BalanceCache | null {
  ensureDataDir();
  if (!fs.existsSync(BALANCE_CACHE_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(BALANCE_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BalanceCache>;
    if (!Array.isArray(parsed.balances) || typeof parsed.fetchedAt !== 'number') {
      return null;
    }
    return {
      balances: parsed.balances.filter((item) =>
        typeof item.asset === 'string'
        && typeof item.free === 'number'
        && typeof item.locked === 'number'),
      fetchedAt: parsed.fetchedAt,
    };
  } catch {
    return null;
  }
}

function getCachedBalances(maxAgeMs: number): AccountBalance[] | null {
  if (!balanceCache) {
    balanceCache = loadPersistedBalanceCache();
  }
  if (!balanceCache) return null;
  const age = Date.now() - balanceCache.fetchedAt;
  if (age > maxAgeMs) return null;
  return balanceCache.balances;
}

export async function refreshBalanceCache(): Promise<void> {
  const balances = await fetchAccountBalances();
  cacheBalances(balances);
}

export function getBalanceCacheAgeMs(): number | null {
  if (!balanceCache) return null;
  return Date.now() - balanceCache.fetchedAt;
}

export function startBalanceReconciler(): () => void {
  const timer = setInterval(() => {
    refreshBalanceCache()
      .then(() => {
        log('PORTFOLIO', 'Balance cache reconciled from Binance REST');
      })
      .catch((error) => {
        logError('PORTFOLIO', 'Balance reconciler refresh failed', error);
      });
  }, BALANCE_RECONCILIATION_INTERVAL_MS);

  return () => {
    clearInterval(timer);
  };
}

async function getBalancesWithCache(): Promise<{
  balances: AccountBalance[];
  isStale: boolean;
}> {
  const freshCache = getCachedBalances(BALANCE_CACHE_TTL_MS);
  if (freshCache) {
    return {
      balances: freshCache,
      isStale: false,
    };
  }

  try {
    const balances = await fetchAccountBalances();
    cacheBalances(balances);
    return {
      balances,
      isStale: false,
    };
  } catch (error) {
    if (error instanceof BinanceRateLimitError) {
      const staleCache = getCachedBalances(STALE_BALANCE_RATE_LIMIT_MAX_AGE_MS);
      if (staleCache) {
        const ageMs = getBalanceCacheAgeMs() ?? -1;
        log(
          'PORTFOLIO',
          `Using cached balances due to Binance rate-limit (cache age ${ageMs}ms)`,
        );
        return {
          balances: staleCache,
          isStale: true,
        };
      }
    }
    throw error;
  }
}

export async function buildPortfolioState(
  knownPrices?: Record<string, number>,
): Promise<PortfolioState> {
  log('PORTFOLIO', 'Fetching account balances from Binance...');
  const { balances, isStale } = await getBalancesWithCache();
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
    const currentPrice = knownPrices?.[symbol];
    if (!currentPrice || currentPrice <= 0) {
      log('PORTFOLIO', `No price available for ${symbol}, skipping`);
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

  const staleSuffix = isStale ? ' [stale-balances]' : '';
  log('PORTFOLIO', `Portfolio built: $${availableUsdt.toFixed(2)} USDT + ${positions.length} positions = $${totalValue.toFixed(2)} total${staleSuffix}`);

  return {
    availableUsdt,
    totalValue,
    positions,
    lastUpdated: Date.now(),
    isBalanceDataStale: isStale,
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
