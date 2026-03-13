import { TradeDecision, PortfolioState, RiskCheckResult, TradeRecord } from '../types';
import { botConfig } from '../config';
import { getRecentTrades, getDailyStartValue } from './portfolio.service';

export function validateDecision(
  decision: TradeDecision,
  portfolio: PortfolioState,
): RiskCheckResult {
  if (decision.action === 'HOLD') {
    return { approved: true };
  }

  if (isInCooldown(decision.symbol)) {
    return {
      approved: false,
      reason: `Cooldown active for ${decision.symbol} (traded < ${botConfig.riskParams.cooldownMinutes} min ago)`,
    };
  }

  if (isDailyLossLimitReached(portfolio.totalValue)) {
    return {
      approved: false,
      reason: `Daily loss limit reached (>${(botConfig.riskParams.maxDailyLossPercent * 100).toFixed(0)}% drawdown)`,
    };
  }

  if (decision.action === 'BUY') {
    return validateBuy(decision, portfolio);
  }

  return validateSell(decision, portfolio);
}

function validateBuy(
  decision: TradeDecision,
  portfolio: PortfolioState,
): RiskCheckResult {
  const requestedUsdt =
    portfolio.availableUsdt * (decision.percentageOfAvailable / 100);

  if (requestedUsdt < botConfig.riskParams.minTradeUsdt) {
    return {
      approved: false,
      reason: `Trade too small: $${requestedUsdt.toFixed(2)} < min $${botConfig.riskParams.minTradeUsdt}`,
    };
  }

  const existingPosition = portfolio.positions.find(
    (p) => p.symbol === decision.symbol,
  );
  const existingValue = existingPosition
    ? existingPosition.quantity * existingPosition.currentPrice
    : 0;
  const newTotalPositionValue = existingValue + requestedUsdt;
  const maxAllowed = portfolio.totalValue * botConfig.riskParams.maxAllocationPerCoin;

  if (newTotalPositionValue > maxAllowed) {
    const adjustedUsdt = Math.max(0, maxAllowed - existingValue);
    if (adjustedUsdt < botConfig.riskParams.minTradeUsdt) {
      return {
        approved: false,
        reason: `Max allocation reached for ${decision.symbol}: $${existingValue.toFixed(2)} already allocated, max $${maxAllowed.toFixed(2)}`,
      };
    }
    return {
      approved: true,
      adjustedQuantity: adjustedUsdt,
      reason: `Capped from $${requestedUsdt.toFixed(2)} to $${adjustedUsdt.toFixed(2)} (max allocation)`,
    };
  }

  const totalDeployed = portfolio.positions.reduce(
    (sum, p) => sum + p.quantity * p.currentPrice,
    0,
  );
  const deploymentAfterTrade = totalDeployed + requestedUsdt;
  const maxDeployment = portfolio.totalValue * botConfig.riskParams.maxTotalDeployment;

  if (deploymentAfterTrade > maxDeployment) {
    const adjustedUsdt = Math.max(0, maxDeployment - totalDeployed);
    if (adjustedUsdt < botConfig.riskParams.minTradeUsdt) {
      return {
        approved: false,
        reason: `Max total deployment reached: $${totalDeployed.toFixed(2)} deployed, max $${maxDeployment.toFixed(2)}`,
      };
    }
    return {
      approved: true,
      adjustedQuantity: adjustedUsdt,
      reason: `Capped from $${requestedUsdt.toFixed(2)} to $${adjustedUsdt.toFixed(2)} (max deployment)`,
    };
  }

  return { approved: true };
}

function validateSell(
  decision: TradeDecision,
  portfolio: PortfolioState,
): RiskCheckResult {
  const position = portfolio.positions.find(
    (p) => p.symbol === decision.symbol,
  );

  if (!position || position.quantity <= 0) {
    return {
      approved: false,
      reason: `No position to sell for ${decision.symbol}`,
    };
  }

  const positionValue = position.quantity * position.currentPrice;
  if (positionValue < botConfig.riskParams.minTradeUsdt) {
    return {
      approved: false,
      reason: `Position too small to sell: $${positionValue.toFixed(2)} < min $${botConfig.riskParams.minTradeUsdt} (dust)`,
    };
  }

  return { approved: true };
}

function isInCooldown(symbol: string): boolean {
  const trades = getRecentTrades(20);
  const lastTrade = trades
    .filter((t) => t.symbol === symbol)
    .pop();

  if (!lastTrade) return false;

  const cooldownMs = botConfig.riskParams.cooldownMinutes * 60 * 1000;
  const oppositeSide = lastTrade.side === 'BUY' ? 'SELL' : 'BUY';

  if (lastTrade.side === oppositeSide) {
    return Date.now() - lastTrade.timestamp < cooldownMs;
  }

  return false;
}

function isDailyLossLimitReached(currentTotalValue: number): boolean {
  const startValue = getDailyStartValue();
  if (startValue === null) return false;

  const drawdown = (startValue - currentTotalValue) / startValue;
  return drawdown >= botConfig.riskParams.maxDailyLossPercent;
}
