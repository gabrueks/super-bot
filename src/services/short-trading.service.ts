import { shortBotConfig } from '../config';
import {
  ShortCycleResult,
  ShortExecutionInput,
  ShortMarketRegime,
  ShortPortfolioState,
  ShortRiskCheckResult,
  ShortSymbolRiskInput,
  ShortTradeDecision,
  ShortTradeRecord,
} from '../types';
import { validateShortDecision } from './short-risk.service';
import {
  closeShortPosition,
  fetchFuturesFundingFees,
  fetchFuturesAccountState,
  isBinanceFuturesCircuitOpen,
  openShortPosition,
  openShortPositionWithFallback,
} from './binance-futures.service';
import { appendShortTrade } from './short-portfolio.service';
import { ExecutionBlockedError, PositionNotFoundError } from '../errors/domain-errors';
import { log, logError } from '../logger';

const TRADE_EXECUTION_SPACING_MS = 300;
const ESTIMATED_FUTURES_TAKER_FEE_RATE = 0.0004;
const FUNDING_LOOKBACK_MS = 72 * 60 * 60 * 1000;

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

function estimateTradingFeeUsdt(notionalUsdt: number): number {
  if (!Number.isFinite(notionalUsdt) || notionalUsdt <= 0) {
    return 0;
  }
  return notionalUsdt * ESTIMATED_FUTURES_TAKER_FEE_RATE;
}

async function estimateCloseFundingUsdt(symbol: string, closeRatio: number): Promise<number> {
  if (!(closeRatio > 0)) {
    return 0;
  }
  try {
    const fundingRows = await fetchFuturesFundingFees(symbol, Date.now() - FUNDING_LOOKBACK_MS);
    const totalFunding = fundingRows.reduce((sum, row) => sum + row.income, 0);
    return totalFunding * Math.min(1, closeRatio);
  } catch {
    return 0;
  }
}

function computeOpenShortQuantity(
  symbol: string,
  notionalUsdt: number,
  currentPrices: Record<string, number>,
): { quantity: number; price: number; stepSize: number } {
  const price = currentPrices[symbol];
  if (!(price > 0)) {
    throw new ExecutionBlockedError(`Cannot open short for ${symbol}: invalid current price`);
  }
  const stepSize = getStepSize(symbol);
  const rawQty = notionalUsdt / price;
  const quantity = floorToStep(rawQty, stepSize);
  return { quantity, price, stepSize };
}

function buildOpenLimitPrice(executionInput: ShortExecutionInput): number {
  const offsetFactor = 1 - (shortBotConfig.riskParams.openLimitOffsetBps / 10_000);
  return executionInput.topAskPrice * offsetFactor;
}

function evaluateOpenExecutionGate(
  symbol: string,
  notionalUsdt: number,
  riskInput: ShortSymbolRiskInput | undefined,
  executionInput: ShortExecutionInput | undefined,
): { approved: boolean; reason?: string } {
  if (!executionInput) {
    return {
      approved: false,
      reason: `Missing execution input for ${symbol}`,
    };
  }
  if (executionInput.spreadPercent > shortBotConfig.riskParams.maxSpreadPercent) {
    return {
      approved: false,
      reason: `Spread too wide (${(executionInput.spreadPercent * 100).toFixed(3)}% > ${(shortBotConfig.riskParams.maxSpreadPercent * 100).toFixed(3)}%)`,
    };
  }
  if (executionInput.bidAskRatio < shortBotConfig.riskParams.minBidAskRatio) {
    return {
      approved: false,
      reason: `Bid/ask ratio too weak (${executionInput.bidAskRatio.toFixed(2)} < ${shortBotConfig.riskParams.minBidAskRatio.toFixed(2)})`,
    };
  }
  const atrPercent = riskInput?.stopDistancePercent
    ? Math.max(executionInput.atrPercent, riskInput.stopDistancePercent)
    : executionInput.atrPercent;
  const expectedMovePercent = atrPercent * shortBotConfig.riskParams.expectedMoveAtrMultiple;
  const estimatedRoundTripFeePercent = ESTIMATED_FUTURES_TAKER_FEE_RATE * 2;
  const estimatedSlippagePercent = executionInput.spreadPercent * 0.5;
  const estimatedTotalCostPercent = estimatedRoundTripFeePercent
    + estimatedSlippagePercent
    + shortBotConfig.riskParams.estimatedFundingCostPercent
    + shortBotConfig.riskParams.minEdgeBufferPercent;

  if (expectedMovePercent <= estimatedTotalCostPercent) {
    return {
      approved: false,
      reason: `Insufficient edge: expected ${(expectedMovePercent * 100).toFixed(3)}% <= cost ${(estimatedTotalCostPercent * 100).toFixed(3)}%`,
    };
  }
  if (!(notionalUsdt > 0) || !Number.isFinite(notionalUsdt)) {
    return {
      approved: false,
      reason: `Invalid notional for ${symbol}`,
    };
  }
  return { approved: true };
}

export async function executeShortDecisions(
  decisions: ShortTradeDecision[],
  portfolio: ShortPortfolioState,
  currentPrices: Record<string, number>,
  riskInputs: Record<string, ShortSymbolRiskInput>,
  executionInputs: Record<string, ShortExecutionInput>,
  regime: ShortMarketRegime,
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
    const riskCheck = validateShortDecision(decision, portfolio, riskInputs, regime);
    if (!riskCheck.approved) {
      result.errors.push(`REJECTED ${decision.action} ${decision.symbol}: ${riskCheck.reason}`);
      continue;
    }

    if (decision.action === 'OPEN_SHORT') {
      const baseNotional = portfolio.availableUsdt * (decision.percentageOfAvailable / 100);
      const notionalUsdt = riskCheck.adjustedNotionalUsdt ?? baseNotional;
      const executionGate = evaluateOpenExecutionGate(
        decision.symbol,
        notionalUsdt,
        riskInputs[decision.symbol],
        executionInputs[decision.symbol],
      );
      if (!executionGate.approved) {
        result.errors.push(`REJECTED OPEN_SHORT ${decision.symbol}: ${executionGate.reason}`);
        continue;
      }
      const { quantity, price, stepSize } = computeOpenShortQuantity(
        decision.symbol,
        notionalUsdt,
        currentPrices,
      );
      if (!(quantity > 0)) {
        const minNotionalForStep = stepSize * price;
        result.errors.push(
          `REJECTED OPEN_SHORT ${decision.symbol}: notional $${notionalUsdt.toFixed(2)} below minimum ~$${minNotionalForStep.toFixed(2)} required for step size ${stepSize}`,
        );
        continue;
      }
    }

    result.decisionsApproved++;
    try {
      const trade = await executeSingleShortTrade(
        decision,
        portfolio,
        currentPrices,
        riskCheck,
        executionInputs,
      );
      result.tradesExecuted++;
      result.trades.push(trade);
      appendShortTrade(trade);
    } catch (error) {
      if (decision.action === 'CLOSE_SHORT' && error instanceof PositionNotFoundError) {
        result.errors.push(`REJECTED CLOSE_SHORT ${decision.symbol}: ${error.message}`);
        continue;
      }
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
  executionInputs: Record<string, ShortExecutionInput>,
): Promise<ShortTradeRecord> {
  const stepSize = getStepSize(decision.symbol);
  if (decision.action === 'OPEN_SHORT') {
    const baseNotional = portfolio.availableUsdt * (decision.percentageOfAvailable / 100);
    const notionalUsdt = riskCheck.adjustedNotionalUsdt ?? baseNotional;
    const { quantity } = computeOpenShortQuantity(decision.symbol, notionalUsdt, currentPrices);
    if (!(quantity > 0)) {
      throw new ExecutionBlockedError(`Calculated quantity is zero for ${decision.symbol}`);
    }

    const executionInput = executionInputs[decision.symbol];
    const order = executionInput
      ? await openShortPositionWithFallback(
        decision.symbol,
        quantity,
        buildOpenLimitPrice(executionInput),
        shortBotConfig.riskParams.openLimitFallbackMinFillPercent,
      )
      : await openShortPosition(decision.symbol, quantity);
    const estimatedFeesUsdt = estimateTradingFeeUsdt(order.cummulativeQuoteQty);
    return {
      id: generateTradeId(),
      symbol: decision.symbol,
      side: 'OPEN_SHORT',
      quantity: order.executedQty,
      price: order.avgPrice,
      total: order.cummulativeQuoteQty,
      estimatedFeesUsdt,
      timestamp: Date.now(),
      reasoning: decision.reasoning,
    };
  }

  const position = portfolio.positions.find((candidate) => candidate.symbol === decision.symbol);
  if (!position) {
    throw new PositionNotFoundError(`No short position to close for ${decision.symbol}`);
  }
  const liveAccountState = await fetchFuturesAccountState();
  const livePosition = liveAccountState.positions.find((candidate) => candidate.symbol === decision.symbol);
  if (!livePosition || !(livePosition.quantity > 0)) {
    throw new PositionNotFoundError(`No live short position to close for ${decision.symbol}`);
  }
  const boundedPercent = Math.min(100, Math.max(0, decision.percentageOfAvailable));
  const closeableQuantity = Math.min(position.quantity, livePosition.quantity);
  const quantity = floorToStep(closeableQuantity * (boundedPercent / 100), stepSize);
  if (!(quantity > 0)) {
    throw new ExecutionBlockedError(`Calculated close quantity is zero for ${decision.symbol}`);
  }
  let order;
  try {
    order = await closeShortPosition(decision.symbol, quantity);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('closeShort returned zero executed quantity')) {
      const refreshedAccountState = await fetchFuturesAccountState();
      const refreshedPosition = refreshedAccountState.positions.find(
        (candidate) => candidate.symbol === decision.symbol,
      );
      if (!refreshedPosition || !(refreshedPosition.quantity > 0)) {
        throw new PositionNotFoundError(`No live short position remained for ${decision.symbol} at execution time`);
      }
    }
    throw error;
  }
  const estimatedCloseFeeUsdt = estimateTradingFeeUsdt(order.cummulativeQuoteQty);
  const estimatedOpenNotionalUsdt = livePosition.entryPrice * order.executedQty;
  const estimatedOpenFeeUsdt = estimateTradingFeeUsdt(estimatedOpenNotionalUsdt);
  const estimatedGrossPnlUsdt = (livePosition.entryPrice - order.avgPrice) * order.executedQty;
  const closeRatio = livePosition.quantity > 0 ? order.executedQty / livePosition.quantity : 0;
  const estimatedFundingUsdt = await estimateCloseFundingUsdt(decision.symbol, closeRatio);
  const estimatedFeesUsdt = estimatedOpenFeeUsdt + estimatedCloseFeeUsdt;
  const estimatedNetPnlUsdt = estimatedGrossPnlUsdt - estimatedFeesUsdt + estimatedFundingUsdt;
  return {
    id: generateTradeId(),
    symbol: decision.symbol,
    side: 'CLOSE_SHORT',
    quantity: order.executedQty,
    price: order.avgPrice,
    total: order.cummulativeQuoteQty,
    estimatedFeesUsdt,
    estimatedFundingUsdt,
    estimatedGrossPnlUsdt,
    estimatedNetPnlUsdt,
    timestamp: Date.now(),
    reasoning: decision.reasoning,
  };
}
