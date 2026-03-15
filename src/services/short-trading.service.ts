import { shortBotConfig } from '../config';
import {
  ShortCycleResult,
  ShortPortfolioState,
  ShortRiskCheckResult,
  ShortTradeDecision,
  ShortTradeRecord,
} from '../types';
import { validateShortDecision } from './short-risk.service';
import {
  closeShortPosition,
  isBinanceFuturesCircuitOpen,
  openShortPosition,
} from './binance-futures.service';
import { appendShortTrade } from './short-portfolio.service';
import { ExecutionBlockedError, PositionNotFoundError } from '../errors/domain-errors';
import { log, logError } from '../logger';

const TRADE_EXECUTION_SPACING_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function generateTradeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function floorToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.floor(value / step) * step;
}

function getStepSize(symbol: string): number {
  return shortBotConfig.stepSizes[symbol] ?? 0.001;
}

export async function executeShortDecisions(
  decisions: ShortTradeDecision[],
  portfolio: ShortPortfolioState,
  currentPrices: Record<string, number>,
): Promise<ShortCycleResult> {
  if (isBinanceFuturesCircuitOpen()) {
    throw new ExecutionBlockedError('Binance Futures circuit is open');
  }

  const result: ShortCycleResult = {
    timestamp: Date.now(),
    decisionsReceived: decisions.length,
    decisionsApproved: 0,
    tradesExecuted: 0,
    trades: [],
    errors: [],
  };

  const actionable = decisions.filter((decision) => decision.action !== 'HOLD');
  for (let i = 0; i < actionable.length; i++) {
    const decision = actionable[i];
    const riskCheck = validateShortDecision(decision, portfolio);
    if (!riskCheck.approved) {
      result.errors.push(`REJECTED ${decision.action} ${decision.symbol}: ${riskCheck.reason}`);
      continue;
    }

    result.decisionsApproved++;
    try {
      const trade = await executeSingleShortTrade(decision, portfolio, currentPrices, riskCheck);
      result.tradesExecuted++;
      result.trades.push(trade);
      appendShortTrade(trade);
    } catch (error) {
      logError('SHORT-TRADING', `Failed to execute ${decision.action} ${decision.symbol}`, error);
      result.errors.push(
        `ERROR executing ${decision.action} ${decision.symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (i < actionable.length - 1) {
      await sleep(TRADE_EXECUTION_SPACING_MS);
    }
  }

  return result;
}

async function executeSingleShortTrade(
  decision: ShortTradeDecision,
  portfolio: ShortPortfolioState,
  currentPrices: Record<string, number>,
  riskCheck: ShortRiskCheckResult,
): Promise<ShortTradeRecord> {
  const stepSize = getStepSize(decision.symbol);
  if (decision.action === 'OPEN_SHORT') {
    const price = currentPrices[decision.symbol];
    if (!(price > 0)) {
      throw new ExecutionBlockedError(`Cannot open short for ${decision.symbol}: invalid current price`);
    }
    const baseNotional = portfolio.availableUsdt * (decision.percentageOfAvailable / 100);
    const notionalUsdt = riskCheck.adjustedNotionalUsdt ?? baseNotional;
    const rawQty = notionalUsdt / price;
    const quantity = floorToStep(rawQty, stepSize);
    if (!(quantity > 0)) {
      throw new ExecutionBlockedError(`Calculated quantity is zero for ${decision.symbol}`);
    }

    const order = await openShortPosition(decision.symbol, quantity);
    return {
      id: generateTradeId(),
      symbol: decision.symbol,
      side: 'OPEN_SHORT',
      quantity: order.executedQty,
      price: order.avgPrice,
      total: order.cummulativeQuoteQty,
      timestamp: Date.now(),
      reasoning: decision.reasoning,
    };
  }

  const position = portfolio.positions.find((candidate) => candidate.symbol === decision.symbol);
  if (!position) {
    throw new PositionNotFoundError(`No short position to close for ${decision.symbol}`);
  }
  const boundedPercent = Math.min(100, Math.max(0, decision.percentageOfAvailable));
  const quantity = floorToStep(position.quantity * (boundedPercent / 100), stepSize);
  if (!(quantity > 0)) {
    throw new ExecutionBlockedError(`Calculated close quantity is zero for ${decision.symbol}`);
  }
  const order = await closeShortPosition(decision.symbol, quantity);
  return {
    id: generateTradeId(),
    symbol: decision.symbol,
    side: 'CLOSE_SHORT',
    quantity: order.executedQty,
    price: order.avgPrice,
    total: order.cummulativeQuoteQty,
    timestamp: Date.now(),
    reasoning: decision.reasoning,
  };
}
