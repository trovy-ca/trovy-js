/**
 * Where the sign-up form is served from.
 *
 * The form asks a customer for a phone number and a texted code, so which host
 * serves it is the one thing in this package that must not be configurable. The
 * entries partners use (`@trovy/sdk/widget`, `@trovy/sdk/react`) are bound to
 * this constant and take no origin option at all.
 */
export const TROVY_FRAME_ORIGIN = "https://js.trovy.ca";

// `js.trovy.ca`, or `js.<one label>.trovy.ca` for Trovy's own pre-production
// hosts. Anchored at both ends, lower case only, no port, no path: this is
// compared against `URL.origin`-shaped strings and nothing looser.
const TROVY_HOST = /^https:\/\/js\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)?trovy\.ca$/;

// A developer's own machine. Reachable only by whoever is sitting at it, so it
// cannot be used to put the form in front of somebody else's customer.
const LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

/**
 * Whether `createMount` may be bound to this origin.
 *
 * The check exists because `@trovy/sdk/widget/core` is reachable by anyone who
 * reads `package.json`. Without it, that entry would be a supported way to put a
 * look-alike phone form inside a frame the customer has every reason to trust.
 */
export function isTrovyFrameOrigin(origin: unknown): origin is string {
  return typeof origin === "string" && (TROVY_HOST.test(origin) || LOOPBACK.test(origin));
}
