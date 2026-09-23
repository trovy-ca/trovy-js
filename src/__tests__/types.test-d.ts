/**
 * Type-level tests. They are checked by `tsc` (this file is in `include`), not
 * run by vitest: every assertion below is a compile error if it stops holding.
 *
 * What they protect is the one thing runtime tests cannot reach — that the
 * hand-written method surface still lines up with the generated spec. A schema
 * change that makes `Payload<"earnReward">` diverge from what `rewards.earn`
 * accepts fails here, at `pnpm type-check`, rather than at a partner's checkout.
 */
import { Trovy } from "../index.js";
import type { Payload, Result } from "../operations.js";
import type { components } from "../generated/openapi.js";

/** Compile error unless `T` is exactly `true`. */
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type IsNever<T> = [T] extends [never] ? true : false;

const trovy = new Trovy({ apiKey: `trv_test_${"a".repeat(64)}` });

// --- The derived types resolve to real schemas, not `never` -----------------
// `Result` and `Payload` are conditional types over the generated `operations`.
// If openapi-typescript changes its output shape they would silently collapse to
// `never`, every method would accept anything, and no runtime test would notice.

type _ResultIsReal = Expect<Equal<IsNever<Result<"getBusiness">>, false>>;
type _PayloadIsReal = Expect<Equal<IsNever<Payload<"earnReward">>, false>>;

type _BusinessResult = Expect<
  Equal<Result<"getBusiness">, components["schemas"]["BusinessResponse"]>
>;
type _EarnPayload = Expect<Equal<Payload<"earnReward">, components["schemas"]["EarnRequest"]>>;

// An operation with no request body has no payload to pass.
type _NoPayload = Expect<Equal<IsNever<Payload<"getBusiness">>, true>>;

// An operation whose every field is optional has an OPTIONAL requestBody in the
// generated types. Matching only the required form collapsed this payload to
// `never` and made the body impossible to pass — caught by the docs snippets,
// which are type-checked against this package.
type _OptionalBodyIsReal = Expect<
  Equal<IsNever<Payload<"reverseGiftCardRedemption">>, false>
>;

// --- The methods return the spec's own response types -----------------------

type _GetReturns = Expect<
  Equal<Awaited<ReturnType<typeof trovy.business.get>>, components["schemas"]["BusinessResponse"]>
>;
type _EarnReturns = Expect<
  Equal<Awaited<ReturnType<typeof trovy.rewards.earn>>, Result<"earnReward">>
>;
type _RewardsListReturns = Expect<
  Equal<Awaited<ReturnType<typeof trovy.rewards.list>>, Result<"listCustomerRewards">>
>;

// --- What the API can answer null is typed nullable ----------------------------
// The contract writes these as `allOf: [{ $ref }, { type: [object, null] }]`, which
// generated `Reward & (Record<string, never> | null)`: never null, so
// `earn.reward.id` compiled without a check and threw when nothing was earned.

type _EarnRewardIsNullable = Expect<
  Equal<Result<"earnReward">["reward"], components["schemas"]["Reward"] | null>
>;
type _RedeemNewRewardIsNullable = Expect<
  Equal<Result<"redeemReward">["newReward"], components["schemas"]["Reward"] | null>
>;

async function _rewardNeedsACheck() {
  const earn = await trovy.rewards.earn({ customerId: "c", orderId: "o", amountCents: 50 });
  // @ts-expect-error reward is null when the order earned nothing
  void earn.reward.id;
  void earn.reward?.id;
}
void _rewardNeedsACheck;

// --- A write's body is the spec's body, and nothing else --------------------

type _EarnAcceptsSpecBody = Expect<
  Equal<Parameters<typeof trovy.rewards.earn>[0], components["schemas"]["EarnRequest"]>
>;
type _VoidTakesAnId = Expect<Equal<Parameters<typeof trovy.giftCards.void>[0], string>>;
type _ReverseTakesIdThenBody = Expect<
  Equal<Parameters<typeof trovy.giftCards.reverseRedemption>[0], string>
>;

// --- Negative checks: the compiler refuses what the API would refuse --------

// @ts-expect-error earn needs a body
void trovy.rewards.earn();
// @ts-expect-error amountCents is a number in the spec
void trovy.rewards.earn({ customerId: "c", orderId: "o", amountCents: "50" });
// @ts-expect-error there is no such field on the earn request
void trovy.rewards.earn({ customerId: "c", orderId: "o", amountCents: 50, currency: "USD" });
// @ts-expect-error getBusiness takes no body, only options
void trovy.business.get({ customerId: "c" });
// @ts-expect-error an unknown request option is a typo, not an extension point
void trovy.business.get({ retries: 5 });

export type {
  _OptionalBodyIsReal,
  _ResultIsReal,
  _PayloadIsReal,
  _BusinessResult,
  _EarnPayload,
  _NoPayload,
  _GetReturns,
  _EarnReturns,
  _RewardsListReturns,
  _EarnAcceptsSpecBody,
  _VoidTakesAnId,
  _ReverseTakesIdThenBody,
  _EarnRewardIsNullable,
  _RedeemNewRewardIsNullable,
};
