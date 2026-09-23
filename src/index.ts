/**
 * `@trovy/sdk` — the server client for Trovy's loyalty API.
 *
 * This entry is server-side only. It takes a secret key (`trv_live_…` /
 * `trv_test_…`), which can earn, redeem and refund on a customer's behalf: it must
 * never reach a browser, and the constructor refuses to run in one.
 *
 * The browser half of an integration lives in the other entries, which take a
 * publishable key and never see this one:
 *
 *   `@trovy/sdk/react`   the sign-up form as a React component
 *   `@trovy/sdk/widget`  the same form without a framework
 *   `@trovy/sdk/next`    the route handler that joins the form to this client
 *
 * Every type here is generated from the same OpenAPI document the API serves,
 * so the shapes in your editor are the shapes on the wire.
 */

export { Trovy } from "./client.js";
export type { TrovyOptions, RequestOptions } from "./client.js";

export {
  TrovyError,
  TrovyConnectionError,
  isTrovyError,
  isTrovyConnectionError,
} from "./errors.js";
export type { TrovyErrorBody } from "./errors.js";

export { OPERATIONS } from "./operations.js";
export type { OperationId, OperationSpec, Payload, Result } from "./operations.js";

// Which contract this version was generated from. Compare it with the hash of
// the contract your API serves to learn whether the SDK is behind it.
export { CONTRACT_SHA256 } from "./generated/contract.js";

// The generated schema types, for a caller who wants to name one: a function
// that takes an `EarnRequest`, a list of `Reward`s. `operations` and
// `components` are re-exported whole rather than hand-listed, so a new schema is
// available without a release note.
export type { components, operations, paths } from "./generated/openapi.js";
