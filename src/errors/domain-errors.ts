import { CycleFailureCode } from '../types';

export class DomainError extends Error {
  readonly code: CycleFailureCode;

  constructor(code: CycleFailureCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export class InvalidModelOutputError extends DomainError {
  constructor(message: string) {
    super('invalid_model_output', message);
    this.name = 'InvalidModelOutputError';
  }
}

export class ModelUnavailableError extends DomainError {
  constructor(message: string) {
    super('model_unavailable', message);
    this.name = 'ModelUnavailableError';
  }
}

export class MarketDataUnavailableError extends DomainError {
  constructor(message: string) {
    super('market_data_unavailable', message);
    this.name = 'MarketDataUnavailableError';
  }
}

export class ExecutionBlockedError extends DomainError {
  constructor(message: string) {
    super('execution_blocked', message);
    this.name = 'ExecutionBlockedError';
  }
}

export class MarginUnavailableError extends DomainError {
  constructor(message: string) {
    super('margin_unavailable', message);
    this.name = 'MarginUnavailableError';
  }
}

export class LeverageInvalidError extends DomainError {
  constructor(message: string) {
    super('leverage_invalid', message);
    this.name = 'LeverageInvalidError';
  }
}

export class PositionNotFoundError extends DomainError {
  constructor(message: string) {
    super('position_not_found', message);
    this.name = 'PositionNotFoundError';
  }
}

export function toFailureCode(error: unknown): CycleFailureCode {
  if (error instanceof DomainError) {
    return error.code;
  }
  return 'unknown_error';
}
