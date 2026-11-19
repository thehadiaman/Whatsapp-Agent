/**
 * Cloud API error codes, from Meta's error-code reference (checked 2026-11-17).
 * Retryable: rate limits and transient server errors. Everything else is
 * permanent: retrying would fail the same way.
 */
export const ERROR_CODES = {
  unknown: 1,
  temporarilyUnavailable: 2,
  appRateLimit: 4,
  invalidParameter: 100,
  accountRateLimit: 80007,
  throughputLimit: 130429,
  unknownSendFailure: 131000,
  serviceUnavailable: 131016,
  undeliverable: 131026,
  windowClosed: 131047,
  invalidParameterValue: 131009,
  pairRateLimit: 131056,
} as const;

const RETRYABLE_CODES = new Set<number>([
  ERROR_CODES.unknown,
  ERROR_CODES.temporarilyUnavailable,
  ERROR_CODES.appRateLimit,
  ERROR_CODES.accountRateLimit,
  ERROR_CODES.throughputLimit,
  ERROR_CODES.unknownSendFailure,
  ERROR_CODES.serviceUnavailable,
  ERROR_CODES.pairRateLimit,
]);

export class GraphApiError extends Error {
  readonly httpStatus: number | null;
  readonly code: number | null;
  readonly retryable: boolean;
  /**
   * True when the request may have reached Meta but we saw no answer (timeout,
   * dropped connection). A retry could deliver the message twice.
   */
  readonly ambiguous: boolean;

  constructor(options: {
    message: string;
    httpStatus: number | null;
    code: number | null;
    ambiguous?: boolean;
  }) {
    super(options.message);
    this.name = 'GraphApiError';
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.ambiguous = options.ambiguous ?? false;
    this.retryable = isRetryable(options.httpStatus, options.code);
  }
}

export function isRetryable(httpStatus: number | null, code: number | null): boolean {
  if (code !== null) return RETRYABLE_CODES.has(code);
  // No Meta error code: network failure, timeout, or a non-Graph response.
  return httpStatus === null || httpStatus === 429 || httpStatus >= 500;
}
