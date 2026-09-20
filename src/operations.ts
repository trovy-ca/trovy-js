import type { operations } from "./generated/openapi.js";

/**
 * Every operation in the contract, with the three facts the transport needs:
 * the method, the path template, and whether the API requires an
 * `Idempotency-Key`.
 *
 * The `satisfies Record<keyof operations, OperationSpec>` is the point of this
 * file. `operations` is generated from the committed spec, so if an operation is
 * added, renamed or removed and this table is not updated, `pnpm type-check`
 * fails here rather than the SDK silently shipping without the new call or with
 * a path that 404s. The `idempotent` flags are checked the same way by
 * `__tests__/operations.test.ts`, which reads the spec itself.
 */

export interface OperationSpec {
  method: "GET" | "POST";
  /** Path template; `{id}` segments are filled from the call's arguments. */
  path: string;
  /** True when the API requires an `Idempotency-Key` header on this call. */
  idempotent: boolean;
  /**
   * Whether the SDK may retry this call by itself after a network failure, a
   * timeout or a 5xx.
   *
   * True for every read, for every write that carries an idempotency key (the key
   * is what makes the retry safe), and for `voidGiftCard`, which is idempotent by
   * nature. False for `linkCustomer` alone: its token is single-use and the first
   * attempt spends it, so retrying turns an unknown outcome into a definitive
   * `LINK_TOKEN_INVALID` for a customer who is in fact now linked. That one is the
   * partner's to decide, because only they know whether to re-run the widget.
   */
  retryable: boolean;
}

export const OPERATIONS = {
  getBusiness: { method: "GET", path: "/v1/business", idempotent: false, retryable: true },
  listStores: { method: "GET", path: "/v1/stores", idempotent: false, retryable: true },

  // A link token is single-use by itself, so there is nothing for an idempotency
  // key to protect — and nothing the SDK can safely retry, because the first
  // attempt spends the token. See OperationSpec.retryable.
  linkCustomer: {
    method: "POST",
    path: "/v1/customers/link",
    idempotent: false,
    retryable: false,
  },
  // A read that takes a POST so the phone number travels in the body.
  lookupCustomer: {
    method: "POST",
    path: "/v1/customers/lookup",
    idempotent: false,
    retryable: true,
  },
  listCustomerRewards: {
    method: "GET",
    path: "/v1/customers/{id}/rewards",
    idempotent: false,
    retryable: true,
  },

  earnReward: { method: "POST", path: "/v1/earn", idempotent: true, retryable: true },
  redeemReward: { method: "POST", path: "/v1/redeem", idempotent: true, retryable: true },
  createRefund: { method: "POST", path: "/v1/refunds", idempotent: true, retryable: true },

  createGiftCard: { method: "POST", path: "/v1/gift-cards", idempotent: true, retryable: true },
  // A read, for the same reason as lookupCustomer: the card code stays out of
  // the URL, where it would reach logs and browser history.
  lookupGiftCard: {
    method: "POST",
    path: "/v1/gift-cards/lookup",
    idempotent: false,
    retryable: true,
  },
  redeemGiftCard: {
    method: "POST",
    path: "/v1/gift-cards/redeem",
    idempotent: true,
    retryable: true,
  },
  reverseGiftCardRedemption: {
    method: "POST",
    path: "/v1/gift-cards/redemptions/{id}/reverse",
    idempotent: true,
    retryable: true,
  },
  // Voiding is idempotent by nature: the card is either void or it now is.
  voidGiftCard: {
    method: "POST",
    path: "/v1/gift-cards/{id}/void",
    idempotent: false,
    retryable: true,
  },
} as const satisfies Record<keyof operations, OperationSpec>;

export type OperationId = keyof typeof OPERATIONS;

// --- Deriving the request and response types from the generated spec ---------
// The method signatures below are hand-written for readability, but every type
// in them comes from here, so a changed schema changes the SDK's types too.

type JsonOf<T> = T extends { content: { "application/json": infer J } } ? J : never;

type ResponsesOf<K extends OperationId> = operations[K]["responses"];

/** The body of whichever 2xx the operation answers with (200 or 201). */
export type Result<K extends OperationId> = JsonOf<
  ResponsesOf<K>[Extract<keyof ResponsesOf<K>, 200 | 201>]
>;

/**
 * The JSON request body, or `never` for operations that take none.
 *
 * `requestBody?` rather than `requestBody`, because openapi-typescript marks the
 * body optional when every field in it is optional — as it is on
 * `reverseGiftCardRedemption`. Matching only the required form collapsed that
 * one operation's payload to `never`, which made its body impossible to pass at
 * all. Operations with genuinely no body have `requestBody?: never`, and
 * `JsonOf<never>` is still `never`, so that case is unchanged.
 */
export type Payload<K extends OperationId> = operations[K] extends {
  requestBody?: infer B;
}
  ? JsonOf<NonNullable<B>>
  : never;
