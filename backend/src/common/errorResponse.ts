/**
 * errorResponse.ts — Issue #283
 *
 * Standard error response shape and helper used by all routes.
 *
 *   { error: string, code: string, details?: unknown }
 */

import type { Response } from 'express';

export interface ErrorResponse {
  /** Human-readable message safe to surface to the frontend. */
  error: string;
  /** Machine-readable code (UPPER_SNAKE), e.g. 'INVALID_ADDRESS'. */
  code: string;
  /** Optional extra info — never include secrets or stack traces. */
  details?: unknown;
}

/**
 * Send a standardised error response and return the Response object so
 * callers can `return errorResponse(...)` from a handler.
 */
export function errorResponse(
  res: Response,
  status: number,
  error: string,
  code: string,
  details?: unknown,
): Response {
  const body: ErrorResponse = { error, code };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

/** Common error codes — reuse rather than inventing per-route strings. */
export const ErrorCodes = {
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_ADDRESS: 'INVALID_ADDRESS',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
