import type { UpdateStateInput } from './types.js';

export class ValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function validateStateInput(input: Partial<UpdateStateInput>): void {
  const { balls, strikes, outs, inning, half } = input;

  if (balls !== undefined) {
    if (!isInteger(balls) || balls < 0 || balls > 3) {
      throw new ValidationError('balls must be an integer between 0 and 3');
    }
  }

  if (strikes !== undefined) {
    if (!isInteger(strikes) || strikes < 0 || strikes > 2) {
      throw new ValidationError('strikes must be an integer between 0 and 2');
    }
  }

  if (outs !== undefined) {
    if (!isInteger(outs) || outs < 0 || outs > 2) {
      throw new ValidationError('outs must be an integer between 0 and 2');
    }
  }

  if (inning !== undefined) {
    if (!isInteger(inning) || inning < 1) {
      throw new ValidationError('inning must be an integer >= 1');
    }
  }

  if (half !== undefined) {
    if (half !== 'top' && half !== 'bottom') {
      throw new ValidationError("half must be 'top' or 'bottom'");
    }
  }

  if (input.homeScore !== undefined && (!isInteger(input.homeScore) || input.homeScore < 0)) {
    throw new ValidationError('homeScore must be a non-negative integer');
  }

  if (input.awayScore !== undefined && (!isInteger(input.awayScore) || input.awayScore < 0)) {
    throw new ValidationError('awayScore must be a non-negative integer');
  }

  if (input.gameId !== undefined && input.gameId !== null && typeof input.gameId !== 'string') {
    throw new ValidationError('gameId must be a string or null');
  }

  // Baserunners — accept booleans only (REST validation is stricter than
  // the socket `validateStateFields` which also accepts 0/1 for back-compat).
  for (const field of ['runnerOnFirst', 'runnerOnSecond', 'runnerOnThird'] as const) {
    const v = input[field];
    if (v !== undefined && typeof v !== 'boolean') {
      throw new ValidationError(`${field} must be a boolean`);
    }
  }

  // Batter / pitcher — short text strings. Accept strings or numbers,
  // reject other types. Stored as text so positions like "1B" / "C" work.
  for (const field of ['batterName', 'batterNumber', 'pitcherName', 'pitcherNumber'] as const) {
    const v = input[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' && typeof v !== 'number') {
      throw new ValidationError(`${field} must be a string or number`);
    }
    if (String(v).length > 60) {
      throw new ValidationError(`${field} must be at most 60 characters`);
    }
  }
}

export function sanitizeUniqueIdentifier(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('uniqueIdentifier must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('uniqueIdentifier must not be empty');
  }
  if (trimmed.length > 100) {
    throw new ValidationError('uniqueIdentifier must be at most 100 characters');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new ValidationError(
      'uniqueIdentifier may only contain letters, numbers, hyphens, and underscores'
    );
  }
  return trimmed;
}

export function sanitizeOptionalString(
  value: unknown,
  field: string,
  maxLength = 200
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}
