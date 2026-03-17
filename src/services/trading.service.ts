import {
  TradeDecision,
  PortfolioState,
  TradeRecord,
  RiskCheckResult,
  CycleResult,
} from '../types';
import { botConfig } from '../config';
import { validateDecision } from './risk.service';
import {
  placeMarketOrder,
  placeMarketSellByQty,
  isBinanceRestCircuitOpen,
} from './binance.service';
import { appendTrade } from './portfolio.service';
import { registerStop, removeStop } from './stop-loss.service';
import { log, logError } from '../logger';

const TRADE_EXECUTION_SPACING_MS = 300;

function generateTradeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function executeDecisions(
  decisions: TradeDecision[],
  portfolio: PortfolioState,
): Promise<CycleResult> {
  const result: CycleResult = {
    timestamp: Date.now(),
    decisionsReceived: decisions.length,
    decisionsApproved: 0,
    tradesExecuted: 0,
    trades: [],
    errors: [],
  };

  const actionable = decisions.filter((d) => d.action !== 'HOLD');
  log('TRADING', `Processing ${actionable.length} actionable decisions (${decisions.length - actionable.length} HOLDs skipped)`);

  if (isBinanceRestCircuitOpen()) {
    if (actionable.length === 0) {
      log('TRADING', 'Binance REST circuit is open, but no actionable decisions to execute');
      return result;
    }

    for (const decision of actionable) {
      result.errors.push(`REJECTED ${decision.action} ${decision.symbol}: Binance REST circuit is open`);
    }
    log('TRADING', `Binance REST circuit is open -- rejected ${actionable.length} actionable decision(s)`);
    return result;
  }

  for (let i = 0; i < actionable.length; i++) {
    const decision = actionable[i];
    log('TRADING', `Validating: ${decision.action} ${decision.symbol} ${decision.percentageOfAvailable}%`);
    const riskCheck = validateDecision(decision, portfolio);

    if (!riskCheck.approved) {
      log('TRADING', `REJECTED: ${decision.action} ${decision.symbol} -- ${riskCheck.reason}`);
      result.errors.push(
        `REJECTED ${decision.action} ${decision.symbol}: ${riskCheck.reason}`,
      );
      continue;
    }

    if (riskCheck.reason) {
      log('TRADING', `APPROVED with adjustment: ${riskCheck.reason}`);
    } else {
      log('TRADING', `APPROVED: ${decision.action} ${decision.symbol}`);
    }

    result.decisionsApproved++;

    try {
      const trade = await executeSingleTrade(decision, portfolio, riskCheck);
      if (trade) {
        result.tradesExecuted++;
        result.trades.push(trade);
        appendTrade(trade);

        if (trade.side === 'BUY') {
          registerStop(trade.symbol, trade.price);
        } else if (trade.side === 'SELL') {
          removeStop(trade.symbol);
        }

        log('TRADING', `EXECUTED: ${trade.side} ${trade.symbol} qty=${trade.quantity.toFixed(6)} @ $${trade.price.toFixed(2)} = $${trade.total.toFixed(2)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError('TRADING', `Failed to execute ${decision.action} ${decision.symbol}`, err);
      result.errors.push(
        `ERROR executing ${decision.action} ${decision.symbol}: ${message}`,
      );
    }

    if (i < actionable.length - 1) {
      await sleep(TRADE_EXECUTION_SPACING_MS);
    }
  }

  log('TRADING', `Execution complete: ${result.tradesExecuted} trades, ${result.errors.length} errors/rejections`);
  return result;
}

async function executeSingleTrade(
  decision: TradeDecision,
  portfolio: PortfolioState,
  riskCheck: RiskCheckResult,
): Promise<TradeRecord | null> {
  if (decision.action === 'BUY') {
    const baseAmount =
      portfolio.availableUsdt * (decision.percentageOfAvailable / 100);
    const quoteAmount = riskCheck.adjustedQuantity ?? baseAmount;

    log('TRADING', `Buying ${decision.symbol}: spending $${quoteAmount.toFixed(2)} USDT`);

    const orderResult = await placeMarketOrder(
      decision.symbol,
      'BUY',
      quoteAmount,
    );

    return {
      id: generateTradeId(),
      symbol: decision.symbol,
      side: 'BUY',
      quantity: orderResult.executedQty,
      price: orderResult.avgPrice,
      total: orderResult.cummulativeQuoteQty,
      timestamp: Date.now(),
      reasoning: decision.reasoning,
    };
  }

  if (decision.action === 'SELL') {
    const position = portfolio.positions.find(
      (p) => p.symbol === decision.symbol,
    );
    if (!position) return null;

    const boundedPercent = Math.min(100, Math.max(0, decision.percentageOfAvailable));
    const sellQty = position.quantity * (boundedPercent / 100);

    const stepSize = getStepSize(decision.symbol);
    log('TRADING', `Selling ${decision.symbol}: qty=${sellQty.toFixed(8)} (${boundedPercent}% of position)`);

    const orderResult = await placeMarketSellByQty(
      decision.symbol,
      sellQty,
      stepSize,
    );

    return {
      id: generateTradeId(),
      symbol: decision.symbol,
      side: 'SELL',
      quantity: orderResult.executedQty,
      price: orderResult.avgPrice,
      total: orderResult.cummulativeQuoteQty,
      timestamp: Date.now(),
      reasoning: decision.reasoning,
    };
  }

  return null;
}

function getStepSize(symbol: string): number {
  return botConfig.stepSizes[symbol] ?? 0.001;
}
