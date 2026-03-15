import { ShortClaudeResponse, ShortTradeAction } from '../types';
import { InvalidModelOutputError } from '../errors/domain-errors';

const SHORT_ACTIONS: ShortTradeAction[] = ['OPEN_SHORT', 'CLOSE_SHORT', 'HOLD'];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateShortDecisionPayload(
  payload: unknown,
  expectedSymbols: string[],
): ShortClaudeResponse {
  if (!isObject(payload)) {
    throw new InvalidModelOutputError('Claude short response must be a JSON object');
  }

  const decisionsRaw = payload.decisions;
  if (!Array.isArray(decisionsRaw)) {
    throw new InvalidModelOutputError('Claude short response must include a decisions array');
  }

  const marketSummaryRaw = payload.marketSummary;
  if (typeof marketSummaryRaw !== 'string' || marketSummaryRaw.trim().length === 0) {
    throw new InvalidModelOutputError('Claude short response must include non-empty marketSummary');
  }

  const expectedSet = new Set(expectedSymbols);
  const seen = new Set<string>();
  const decisions = decisionsRaw.map((item, index) => {
    if (!isObject(item)) {
      throw new InvalidModelOutputError(`Short decision at index ${index} must be an object`);
    }
    const symbol = item.symbol;
    const action = item.action;
    const percentageOfAvailable = item.percentageOfAvailable;
    const reasoning = item.reasoning;

    if (typeof symbol !== 'string' || symbol.length === 0) {
      throw new InvalidModelOutputError(`Short decision at index ${index} has invalid symbol`);
    }
    if (!expectedSet.has(symbol)) {
      throw new InvalidModelOutputError(`Short decision symbol ${symbol} is not configured`);
    }
    if (seen.has(symbol)) {
      throw new InvalidModelOutputError(`Duplicate short decision for symbol ${symbol}`);
    }
    seen.add(symbol);

    if (typeof action !== 'string' || !SHORT_ACTIONS.includes(action as ShortTradeAction)) {
      throw new InvalidModelOutputError(`Short decision for ${symbol} has invalid action`);
    }

    if (
      typeof percentageOfAvailable !== 'number'
      || !Number.isFinite(percentageOfAvailable)
      || percentageOfAvailable < 0
      || percentageOfAvailable > 100
    ) {
      throw new InvalidModelOutputError(`Short decision for ${symbol} has invalid percentageOfAvailable`);
    }

    if (typeof reasoning !== 'string' || reasoning.trim().length === 0) {
      throw new InvalidModelOutputError(`Short decision for ${symbol} must include non-empty reasoning`);
    }

    if (action === 'HOLD' && percentageOfAvailable !== 0) {
      throw new InvalidModelOutputError(`Short decision for ${symbol} must set 0 percentage for HOLD`);
    }

    return {
      symbol,
      action: action as ShortTradeAction,
      percentageOfAvailable,
      reasoning,
    };
  });

  if (seen.size !== expectedSet.size) {
    const missingSymbols = expectedSymbols.filter((symbol) => !seen.has(symbol));
    throw new InvalidModelOutputError(`Missing short decision(s) for: ${missingSymbols.join(', ')}`);
  }

  return {
    decisions,
    marketSummary: marketSummaryRaw.trim(),
  };
}
