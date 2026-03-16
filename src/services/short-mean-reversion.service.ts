import {
  MarketData,
  ShortMarketRegime,
  ShortPortfolioState,
  ShortTradeDecision,
} from '../types';

const MEAN_REVERSION_SMALL_SIZE_PERCENT = 8;
const RSI_15M_BLOWOFF = 74;
const RSI_1H_OVERHEATED = 68;
const MAX_EXHAUSTION_VOLUME_RATIO = 1.25;
const MACD_HISTOGRAM_EXHAUSTION_MAX = 0.02;

function hasOpenShortPosition(symbol: string, portfolio: ShortPortfolioState): boolean {
  const position = portfolio.positions.find((p) => p.symbol === symbol);
  return Boolean(position && position.quantity > 0);
}

function isMeanReversionSignal(marketData: MarketData): boolean {
  const tf15m = marketData.technicalAnalysis.timeframes.find((tf) => tf.timeframe === '15m');
  const tf1h = marketData.technicalAnalysis.timeframes.find((tf) => tf.timeframe === '1h');
  if (!tf15m || !tf1h) {
    return false;
  }

  const blowoffRsi = tf15m.rsi >= RSI_15M_BLOWOFF && tf1h.rsi >= RSI_1H_OVERHEATED;
  const nearUpperBand = tf15m.bollingerBands.percentB >= 0.95;
  const exhaustedMomentum = tf15m.macd.histogram <= MACD_HISTOGRAM_EXHAUSTION_MAX;
  const fadingVolume = tf15m.volumeRatio <= MAX_EXHAUSTION_VOLUME_RATIO;

  return blowoffRsi && nearUpperBand && exhaustedMomentum && fadingVolume;
}

export function applyShortMeanReversionStrategy(
  decisions: ShortTradeDecision[],
  marketData: MarketData[],
  portfolio: ShortPortfolioState,
  regime: ShortMarketRegime,
): { decisions: ShortTradeDecision[]; adjustedSymbols: string[] } {
  if (regime.kind !== 'CHOPPY') {
    return {
      decisions,
      adjustedSymbols: [],
    };
  }

  const dataBySymbol = new Map(marketData.map((item) => [item.symbol, item]));
  const adjustedSymbols: string[] = [];

  const adjustedDecisions = decisions.map((decision) => {
    if (decision.action === 'CLOSE_SHORT') {
      return decision;
    }
    if (hasOpenShortPosition(decision.symbol, portfolio)) {
      return decision;
    }
    const symbolData = dataBySymbol.get(decision.symbol);
    if (!symbolData || !isMeanReversionSignal(symbolData)) {
      return decision;
    }

    const targetPercent = Math.min(
      MEAN_REVERSION_SMALL_SIZE_PERCENT,
      decision.action === 'OPEN_SHORT' ? decision.percentageOfAvailable : MEAN_REVERSION_SMALL_SIZE_PERCENT,
    );
    if (decision.action === 'OPEN_SHORT' && decision.percentageOfAvailable <= targetPercent) {
      return decision;
    }

    adjustedSymbols.push(decision.symbol);
    return {
      symbol: decision.symbol,
      action: 'OPEN_SHORT' as const,
      percentageOfAvailable: targetPercent,
      reasoning: `${decision.reasoning} | Mean-reversion addon: overbought blowoff/exhaustion in CHOPPY regime, using tight-risk small entry.`,
    };
  });

  return {
    decisions: adjustedDecisions,
    adjustedSymbols,
  };
}
