// Type-checked by scripts/smoke.mjs against the INSTALLED package, with
// skipLibCheck off. It is a partner's integration in miniature, plus the
// mistakes the types are supposed to catch.

import { createRef } from "react";
import { CONTRACT_SHA256, isTrovyError, Trovy, type components } from "@trovy/sdk";
import { createLinkHandler, type LinkHandlerFailure } from "@trovy/sdk/next";
import { TrovySignup, type TrovySignupHandle, type WidgetError } from "@trovy/sdk/react";
import { isTrovyConfigError, mount, type WidgetHandle, type WidgetState } from "@trovy/sdk/widget";
import { createMount } from "@trovy/sdk/widget/core";

// --- the server client --------------------------------------------------------

const trovy = new Trovy({ apiKey: process.env.TROVY_SECRET_KEY!, maxRetries: 2, timeoutMs: 10_000 });

export async function earn(customerId: string, orderId: string, amountCents: number): Promise<number> {
  try {
    const result = await trovy.rewards.earn({ customerId, orderId, amountCents }, { idempotencyKey: orderId });
    return result.earnedCents;
  } catch (error) {
    if (isTrovyError(error) && error.status === 429) return error.retryAfterSeconds ?? 0;
    throw error;
  }
}

export type EarnRequest = components["schemas"]["EarnRequest"];
export const contract: string = CONTRACT_SHA256;

// @ts-expect-error -- a body needs its required fields
void trovy.rewards.earn({ customerId: "c" });

// --- the route ----------------------------------------------------------------

export const POST: (request: Request) => Promise<Response> = createLinkHandler({
  secretKey: process.env.TROVY_SECRET_KEY,
  getUser: async (request) => request.headers.get("x-user"),
  onLinked: async ({ userId, customer }) => {
    const saved: [string, string, string | null, boolean] = [userId, customer.id, customer.name, customer.isNew];
    void saved;
  },
  onError: (failure: LinkHandlerFailure) => void failure.stage,
});

// @ts-expect-error -- getUser is required
createLinkHandler({ secretKey: "x", onLinked: () => {} });

// --- the component ------------------------------------------------------------

const ref = createRef<TrovySignupHandle>();

export const linked = (
  <TrovySignup
    ref={ref}
    publishableKey="trv_pk_test_…"
    linkUrl="/api/trovy/link"
    onLinked={({ name, isNew }) => void [name, isNew]}
    onError={(error: WidgetError) => void [error.stage, error.code, error.recovery]}
    onStateChange={(state: WidgetState) => void state}
    theme={{ accent: "#0f766e", radius: 12, mode: "system" }}
    unavailableFallback={<p>Unavailable</p>}
    renderLinkFailed={({ error, retry, reset }) => (
      <button type="button" onClick={error.recovery === "verify-again" ? reset : retry}>
        {error.code}
      </button>
    )}
  />
);

export const ownExchange = <TrovySignup publishableKey="trv_pk_test_…" onSuccess={({ linkToken }) => void linkToken} />;

// @ts-expect-error -- exactly one of linkUrl and onSuccess
export const both = <TrovySignup publishableKey="trv_pk_test_…" linkUrl="/api/trovy/link" onSuccess={() => {}} />;

// @ts-expect-error -- a form with neither drops the token on the floor
export const neither = <TrovySignup publishableKey="trv_pk_test_…" />;

// @ts-expect-error -- the browser never receives the customer id
export const leaked = <TrovySignup publishableKey="trv_pk_test_…" linkUrl="/l" onLinked={({ id }) => void id} />;

// @ts-expect-error -- there is no option for where the form is served from
export const moved = <TrovySignup publishableKey="trv_pk_test_…" linkUrl="/l" frameOrigin="https://evil.example" />;

// --- without React ------------------------------------------------------------

export function mountIt(target: HTMLElement): WidgetHandle | undefined {
  try {
    const handle = mount(target, { publishableKey: "trv_pk_test_…", linkUrl: "/api/trovy/link" });
    const retried: boolean = handle.retryLink();
    void retried;
    return handle;
  } catch (error) {
    if (isTrovyConfigError(error)) return undefined;
    throw error;
  }
}

export const custom = createMount({ frameOrigins: { live: "https://js.trovy.ca", test: "https://js.trovy.ca" } });
