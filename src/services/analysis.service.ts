import { RSI, MACD, EMA, BollingerBands, ATR } from 'technicalindicators';
import { Kline, TimeframeIndicators, TechnicalAnalysis } from '../types';
import { Timeframe, TIMEFRAMES } from '../config';
import { getCachedKlines } from './market-cache.service';
import { log } from '../logger';

function computeIndicators(
  klines: Kline[],
  timeframe: string,
): TimeframeIndicators {
  const closes = klines.map((k) => k.close);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const volumes = klines.map((k) => k.volume);

  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiValues[rsiValues.length - 1] ?? 50;

  const macdResult = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const lastMacd = macdResult[macdResult.length - 1];

  const ema9Values = EMA.calculate({ values: closes, period: 9 });
  const ema21Values = EMA.calculate({ values: closes, period: 21 });
  const ema50Values = EMA.calculate({ values: closes, period: 50 });

  const bbValues = BollingerBands.calculate({
    values: closes,
    period: 20,
    stdDev: 2,
  });
  const lastBB = bbValues[bbValues.length - 1];

  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrValues[atrValues.length - 1] ?? 0;

  const recentVolumes = volumes.slice(-20);
  const avgVolume =
    recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const currentVolume = volumes[volumes.length - 1] ?? 0;
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

  const currentPrice = closes[closes.length - 1] ?? 0;
  const bbRange = lastBB ? lastBB.upper - lastBB.lower : 1;
  const percentB = lastBB && bbRange > 0
    ? (currentPrice - lastBB.lower) / bbRange
    : 0.5;

  return {
    timeframe,
    rsi,
    macd: {
      value: lastMacd?.MACD ?? 0,
      signal: lastMacd?.signal ?? 0,
      histogram: lastMacd?.histogram ?? 0,
    },
    ema9: ema9Values[ema9Values.length - 1] ?? currentPrice,
    ema21: ema21Values[ema21Values.length - 1] ?? currentPrice,
    ema50: ema50Values[ema50Values.length - 1] ?? currentPrice,
    bollingerBands: {
      upper: lastBB?.upper ?? currentPrice,
      middle: lastBB?.middle ?? currentPrice,
      lower: lastBB?.lower ?? currentPrice,
      percentB,
    },
    atr,
    volumeRatio,
  };
}

export function analyzeSymbol(symbol: string): TechnicalAnalysis {
  log('ANALYSIS', `Computing indicators for ${symbol} on ${TIMEFRAMES.join(', ')}...`);

  const klinesByTimeframe = TIMEFRAMES.map((tf: Timeframe) => ({
    timeframe: tf,
    klines: getCachedKlines(symbol, tf),
  }));

  const timeframes = klinesByTimeframe.map(({ timeframe, klines }) =>
    computeIndicators(klines, timeframe),
  );

  const shortKlines = klinesByTimeframe.find((k) => k.timeframe === '15m')?.klines;
  const currentPrice = shortKlines?.[shortKlines.length - 1]?.close ?? 0;

  log('ANALYSIS', `${symbol} indicators done: RSI(1h)=${timeframes.find(t => t.timeframe === '1h')?.rsi.toFixed(1) ?? '?'}, price=$${currentPrice.toFixed(2)}`);

  return {
    symbol,
    currentPrice,
    timeframes,
  };
}
