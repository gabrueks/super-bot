import { shortBotConfig } from '../config';
import {
  ShortMarketRegime,
  ShortPortfolioState,
  ShortRiskCheckResult,
  ShortSymbolRiskInput,
  ShortTradeDecision,
} from '../types';
import { getRecentShortTrades, getShortDailyStartValue } from './short-portfolio.service';

export function validateShortDecision(
  decision: ShortTradeDecision,
  portfolio: ShortPortfolioState,
  riskInputs: Record<string, ShortSymbolRiskInput>,
  regime: ShortMarketRegime,
): ShortRiskCheckResult {
  if (decision.action === 'HOLD') {
    return { approved: true };
  }

  if (isInCooldown(decision.symbol)) {
    return {
      approved: false,
      reason: `Cooldown active for ${decision.symbol} (traded < ${shortBotConfig.riskParams.cooldownMinutes} min ago)`,
    };
  }

  if (isDailyLossLimitReached(portfolio.totalValue)) {
    return {
      approved: false,
      reason: `Daily loss limit reached (>${(shortBotConfig.riskParams.maxDailyLossPercent * 100).toFixed(0)}% drawdown)`,
    };
  }

  if (decision.action === 'OPEN_SHORT') {
    return validateOpenShort(decision, portfolio, riskInputs, regime);
  }

  return validateCloseShort(decision, portfolio);
}

function validateOpenShort(
  decision: ShortTradeDecision,
  portfolio: ShortPortfolioState,
  riskInputs: Record<string, ShortSymbolRiskInput>,
  regime: ShortMarketRegime,
): ShortRiskCheckResult {
  const requestedNotionalUsdt = portfolio.availableUsdt * (decision.percentageOfAvailable / 100);
  const riskInput = riskInputs[decision.symbol];
  if (!riskInput || !(riskInput.stopDistancePercent > 0)) {
    return {
      approved: false,
      reason: `Missing risk input for ${decision.symbol}`,
    };
  }

  const maxLossUsdt = portfolio.totalValue * shortBotConfig.riskParams.riskPerTradePercent;
  const riskBasedNotionalUsdt = maxLossUsdt / riskInput.stopDistancePercent;
  const regimeMultiplier = getOpenShortRegimeMultiplier(regime);
  if (!(regimeMultiplier > 0)) {
    return {
      approved: false,
      reason: `OPEN_SHORT blocked by regime ${regime.kind} (strength ${regime.strength.toFixed(2)})`,
    };
  }

  const candidateNotionalUsdt = Math.min(requestedNotionalUsdt, riskBasedNotionalUsdt * regimeMultiplier);
  if (candidateNotionalUsdt < shortBotConfig.riskParams.minTradeUsdt) {
    return {
      approved: false,
      reason: `Trade too small after risk sizing: $${candidateNotionalUsdt.toFixed(2)} < min $${shortBotConfig.riskParams.minTradeUsdt}`,
    };
  }

  const existing = portfolio.positions.find((p) => p.symbol === decision.symbol);
  const existingNotional = existing && Number.isFinite(existing.notionalValue) && existing.notionalValue > 0
    ? existing.notionalValue
    : 0;
  const newTotalPositionNotional = existingNotional + candidateNotionalUsdt;
  const maxAllowed = portfolio.totalValue * shortBotConfig.riskParams.maxShortAllocationPerCoin;
  if (newTotalPositionNotional > maxAllowed) {
    const adjusted = Math.max(0, maxAllowed - existingNotional);
    if (adjusted < shortBotConfig.riskParams.minTradeUsdt) {
      return {
        approved: false,
        reason: `Max short allocation reached for ${decision.symbol}: $${existingNotional.toFixed(2)} already allocated, max $${maxAllowed.toFixed(2)}`,
      };
    }
    return {
      approved: true,
      adjustedNotionalUsdt: adjusted,
      reason: `Capped from $${candidateNotionalUsdt.toFixed(2)} to $${adjusted.toFixed(2)} (max short allocation)`,
    };
  }

  const deployed = portfolio.positions.reduce((sum, p) => {
    if (Number.isFinite(p.notionalValue) && p.notionalValue > 0) {
      return sum + p.notionalValue;
    }
    return sum;
  }, 0);
  const deploymentAfterTrade = deployed + candidateNotionalUsdt;
  const maxDeployment = portfolio.totalValue * shortBotConfig.riskParams.maxTotalShortExposure;
  if (deploymentAfterTrade > maxDeployment) {
    const adjusted = Math.max(0, maxDeployment - deployed);
    if (adjusted < shortBotConfig.riskParams.minTradeUsdt) {
      return {
        approved: false,
        reason: `Max total short exposure reached: $${deployed.toFixed(2)} allocated, max $${maxDeployment.toFixed(2)}`,
      };
    }
    return {
      approved: true,
      adjustedNotionalUsdt: adjusted,
      reason: `Capped from $${candidateNotionalUsdt.toFixed(2)} to $${adjusted.toFixed(2)} (max short exposure)`,
    };
  }

  return {
    approved: true,
    adjustedNotionalUsdt: candidateNotionalUsdt,
  };
}

function getOpenShortRegimeMultiplier(regime: ShortMarketRegime): number {
  if (regime.kind === 'BULL_TREND') {
    if (regime.strength >= 0.7) {
      return 0;
    }
    return 0.35;
  }
  if (regime.kind === 'CHOPPY') {
    return 0.6;
  }
  if (regime.kind === 'PANIC') {
    return 0.8;
  }
  if (regime.kind === 'EUPHORIA') {
    return 1;
  }
  return 1;
}

function validateCloseShort(
  decision: ShortTradeDecision,
  portfolio: ShortPortfolioState,
): ShortRiskCheckResult {
  const position = portfolio.positions.find((p) => p.symbol === decision.symbol);
  if (
    !position
    || !Number.isFinite(position.quantity)
    || position.quantity <= 0
  ) {
    return {
      approved: false,
      reason: `No short position to close for ${decision.symbol}`,
    };
  }
  if (!Number.isFinite(position.notionalValue) || position.notionalValue <= 0) {
    return {
      approved: false,
      reason: `Short position has invalid notional value for ${decision.symbol}`,
    };
  }
  if (position.notionalValue < shortBotConfig.riskParams.minTradeUsdt) {
    return {
      approved: false,
      reason: `Short position too small to close: $${position.notionalValue.toFixed(2)} < min $${shortBotConfig.riskParams.minTradeUsdt}`,
    };
  }
  return { approved: true };
}

function isInCooldown(symbol: string): boolean {
  const trades = getRecentShortTrades(20);
  const lastTrade = trades.filter((t) => t.symbol === symbol).pop();
  if (!lastTrade) return false;

  const cooldownMs = shortBotConfig.riskParams.cooldownMinutes * 60 * 1000;
  return Date.now() - lastTrade.timestamp < cooldownMs;
}

function isDailyLossLimitReached(currentTotalValue: number): boolean {
  const startValue = getShortDailyStartValue();
  if (startValue === null) return false;
  const drawdown = (startValue - currentTotalValue) / startValue;
  return drawdown >= shortBotConfig.riskParams.maxDailyLossPercent;
}
