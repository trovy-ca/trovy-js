"use client";

/**
 * `@trovy/sdk/react` — the sign-up form as a React component.
 *
 *   import { TrovySignup } from "@trovy/sdk/react";
 *
 *   <TrovySignup
 *     publishableKey={process.env.NEXT_PUBLIC_TROVY_KEY!}
 *     linkUrl="/api/trovy/link"
 *     onLinked={() => router.refresh()}
 *   />
 *
 * A Client Component: the directive above is this file's first line in the
 * published build too, so a Server Component can render it directly. It renders
 * the same markup on the server as on the first client render (an empty box), and
 * the form appears once the page is live.
 */

import { createMount } from "../widget/core.js";
import { TROVY_FRAME_ORIGIN } from "../widget/origins.js";
import { createTrovySignup } from "./create.js";

export const TrovySignup = createTrovySignup(
  createMount({ frameOrigins: { live: TROVY_FRAME_ORIGIN, test: TROVY_FRAME_ORIGIN } }),
);

export { createTrovySignup } from "./create.js";
export type {
  LinkFailedView,
  TrovySignupHandle,
  TrovySignupLinkProps,
  TrovySignupProps,
  TrovySignupTokenProps,
} from "./create.js";
export type { SuccessPayload, Theme, WidgetError, WidgetState } from "../widget/core.js";
export type { LinkErrorCode, LinkRecovery, LinkedCustomer } from "../link-protocol.js";
