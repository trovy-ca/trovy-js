/**
 * `@trovy/sdk/widget` — the sign-up form, without a framework.
 *
 *   import { mount } from "@trovy/sdk/widget";
 *
 *   const form = mount("#rewards", {
 *     publishableKey: "trv_pk_live_…",
 *     linkUrl: "/api/trovy/link",
 *     onLinked: ({ name }) => showThanks(name),
 *   });
 *
 * Browser only, publishable key only. `mount` puts an iframe served by Trovy
 * into your element; the phone number and the texted code are typed into that
 * frame and never pass through your page. There is no option for where the
 * frame comes from, on purpose.
 *
 * Importing this on a server is safe. Calling `mount` there throws and says why.
 * Using React? `@trovy/sdk/react` wraps this.
 */

import { createMount } from "./core.js";
import { TROVY_FRAME_ORIGIN } from "./origins.js";

/**
 * Both kinds of key go to the same host: a test key gets the same form with a
 * "test mode" notice, and sends no real text.
 */
export const mount = createMount({
  frameOrigins: { live: TROVY_FRAME_ORIGIN, test: TROVY_FRAME_ORIGIN },
});

export { TrovyConfigError, isTrovyConfigError, WIDGET_ERROR_CODES } from "./core.js";
export type {
  ErrorStage,
  LinkOptions,
  MountOptions,
  SuccessPayload,
  Theme,
  TokenOptions,
  WidgetError,
  WidgetHandle,
  WidgetState,
} from "./core.js";
export type { LinkErrorCode, LinkRecovery, LinkedCustomer } from "../link-protocol.js";
