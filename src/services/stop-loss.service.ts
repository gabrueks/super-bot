import fs from 'fs';
import { TrailingStop } from '../types';
import { DATA_DIR, TRAILING_STOPS_FILE, botConfig } from '../config';
import { log } from '../logger';

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStops(): TrailingStop[] {
  ensureDataDir();
  if (!fs.existsSync(TRAILING_STOPS_FILE)) return [];
  const raw = fs.readFileSync(TRAILING_STOPS_FILE, 'utf-8');
  return JSON.parse(raw);
}

function saveStops(stops: TrailingStop[]): void {
  ensureDataDir();
  fs.writeFileSync(TRAILING_STOPS_FILE, JSON.stringify(stops, null, 2));
}

export function registerStop(symbol: string, entryPrice: number): void {
  const stops = loadStops();
  const existing = stops.findIndex((s) => s.symbol === symbol);

  const stop: TrailingStop = {
    symbol,
    entryPrice,
    peakPrice: entryPrice,
    activatedAt: Date.now(),
  };

  if (existing >= 0) {
    stops[existing] = stop;
  } else {
    stops.push(stop);
  }

  saveStops(stops);
  log('STOP-LOSS', `Registered trailing stop for ${symbol} @ $${entryPrice.toFixed(2)}`);
}

export function removeStop(symbol: string): void {
  const stops = loadStops();
  const filtered = stops.filter((s) => s.symbol !== symbol);
  if (filtered.length !== stops.length) {
    saveStops(filtered);
    log('STOP-LOSS', `Removed trailing stop for ${symbol}`);
  }
}

export interface TriggeredStop {
  symbol: string;
  peakPrice: number;
  currentPrice: number;
  dropPercent: number;
}

export function checkTrailingStops(
  currentPrices: Record<string, number>,
): TriggeredStop[] {
  const stops = loadStops();
  if (stops.length === 0) return [];

  const triggered: TriggeredStop[] = [];
  const threshold = botConfig.riskParams.trailingStopPercent;
  let updated = false;

  for (const stop of stops) {
    const price = currentPrices[stop.symbol];
    if (!price || price <= 0) continue;

    if (price > stop.peakPrice) {
      stop.peakPrice = price;
      updated = true;
      log('STOP-LOSS', `${stop.symbol} new peak: $${price.toFixed(2)}`);
    }

    const stopPrice = stop.peakPrice * (1 - threshold);
    if (price < stopPrice) {
      const dropPercent = ((stop.peakPrice - price) / stop.peakPrice) * 100;
      triggered.push({
        symbol: stop.symbol,
        peakPrice: stop.peakPrice,
        currentPrice: price,
        dropPercent,
      });
      log('STOP-LOSS', `TRIGGERED ${stop.symbol}: price $${price.toFixed(2)} < stop $${stopPrice.toFixed(2)} (peak $${stop.peakPrice.toFixed(2)}, -${dropPercent.toFixed(1)}%)`);
    }
  }

  if (updated) {
    saveStops(stops);
  }

  return triggered;
}

export function getActiveStops(): TrailingStop[] {
  return loadStops();
}
