/**
 * Two error classes, because a partner's checkout has to treat two situations
 * differently and nothing else.
 *
 * `TrovyError` means something answered. The `code` is stable and documented;
 * branch on it.
 *
 * For a **4xx** that answer came from the API itself: the request reached the
 * ledger, a decision was made, and it is final for this request. For a **5xx** it
 * may not have. A 502 or 504 can come from a proxy *after* the API committed the
 * write, so the outcome is unknown in exactly the way a connection failure is —
 * and the SDK has already retried it up to `maxRetries` with the same idempotency
 * key before surfacing it. Treat a surviving 5xx the way you treat
 * `TrovyConnectionError`: queue a retry with the same key, do not assume nothing
 * happened.
 *
 * `TrovyConnectionError` means no answer came back at all — a socket failure, a
 * DNS failure, or the client's own timeout. Same rule: retry with the same key.
 */

/** The error body every `/v1` failure answers with. */
export interface TrovyErrorBody {
  error: string;
  code: string;
  requestId?: string;
  details?: unknown;
}

export class TrovyError extends Error {
  readonly name = "TrovyError";
  /** HTTP status. */
  readonly status: number;
  /** Stable machine-readable code, e.g. `"CUSTOMER_NOT_FOUND"`. */
  readonly code: string;
  /** Quote this when you email developers@trovy.ca; it identifies the exact request in our logs. */
  readonly requestId: string | undefined;
  /**
   * Machine-readable detail, when the API sends some: the failing fields on a 400,
   * and on several 409s the figure to act on (`minimumOrderCents`,
   * `remainingRefundableCents`, the waiting `reward`).
   */
  readonly details: unknown;
  /**
   * Seconds to wait, from the response's `Retry-After`, on the two statuses that
   * set it: 429 and 503. Present so a rate-limited caller can back off on its
   * own terms — the SDK deliberately does not sleep through a 429 for you, since
   * a checkout stalling for thirty seconds is worse than one told to slow down.
   */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    body: TrovyErrorBody,
    extra?: { requestId?: string; retryAfterSeconds?: number }
  ) {
    super(body.error);
    this.status = status;
    this.code = body.code;
    this.requestId = body.requestId ?? extra?.requestId;
    this.details = body.details;
    this.retryAfterSeconds = extra?.retryAfterSeconds;
  }
}

export class TrovyConnectionError extends Error {
  readonly name = "TrovyConnectionError";
  /** How many attempts were made in total, including the first. */
  readonly attempts: number;

  constructor(message: string, attempts: number, options?: { cause?: unknown }) {
    super(message, options);
    this.attempts = attempts;
  }
}

/**
 * Whether a thrown value is a Trovy API refusal. Written as a type guard rather
 * than leaving callers to `instanceof`, which breaks across duplicate copies of
 * the package in a dependency tree.
 */
export function isTrovyError(value: unknown): value is TrovyError {
  return value instanceof Error && value.name === "TrovyError";
}

export function isTrovyConnectionError(value: unknown): value is TrovyConnectionError {
  return value instanceof Error && value.name === "TrovyConnectionError";
}
