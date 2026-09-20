/**
 * The sign-up form's loader: everything except where the form is served from.
 *
 * It runs on someone else's site, so it is small and has no dependencies. It
 * creates an iframe pointing at Trovy's own origin and relays what that frame
 * says. Everything that touches a phone number, a code or a consent checkbox
 * lives inside the iframe, on Trovy's origin, where the embedding page cannot
 * read or alter it.
 *
 * The frame's origin is the one thing this file does not know. `createMount`
 * takes it, so that one implementation serves every build: the npm entries bind
 * it to `https://js.trovy.ca`, and Trovy's hosted script binds it to whatever
 * that deployment serves the frame from. One implementation of the five message
 * checks, not several that drift. See PROTOCOL.md for what the frame says.
 *
 * Nothing here runs at import: importing this file on a server is safe, and
 * `mount` says so plainly if it is called there.
 */

import {
  LINK_MESSAGES,
  LINK_RECOVERY,
  type LinkEnvironment,
  type LinkErrorCode,
  type LinkRecovery,
  type LinkedCustomer,
} from "../link-protocol.js";
import { postLinkToken } from "./link-client.js";
import { isTrovyFrameOrigin } from "./origins.js";

/** Where the frame is served from, per kind of key. */
export interface FrameOrigins {
  live: string;
  test: string;
}

const PUBLISHABLE_KEY_PATTERN = /^trv_pk_(live|test)_[0-9a-f]{32}$/;

/**
 * How long the frame has to say it is there. It covers a cold start on Trovy's
 * side and a slow phone; past it, something is wrong rather than slow.
 */
const READY_TIMEOUT_MS = 10_000;

/** POSTs per token, the automatic retry included. */
const MAX_LINK_ATTEMPTS = 3;
const AUTO_RETRY_DELAY_MS = 1_000;
/**
 * What a link token lives for, counted on this device's clock from the moment
 * the token arrived. The frame's `expiresAt` is the server's clock, and a phone
 * whose own clock is an hour out would read it as "expired already" or "good
 * for another hour".
 */
const LINK_TOKEN_LIFETIME_MS = 5 * 60_000;

const DEFAULT_TITLE = "Join the rewards program";

type Mode = "light" | "dark" | "system";

export interface Theme {
  /** `#rrggbb`. Anything else is ignored rather than passed through. */
  accent?: string;
  /** 0–24 px. Clamped. */
  radius?: number;
  mode?: Mode;
}

export interface SuccessPayload {
  /** Single-use, 5-minute token. Send it to YOUR server, which calls Trovy. */
  linkToken: string;
  expiresAt: string;
  /** What the member typed, so the page can say "Thanks, Maria". */
  firstName?: string;
}

/**
 *   loading       the iframe exists and has not spoken yet
 *   ready         the form is up
 *   unavailable   ten seconds passed in silence. Not final: a frame that was only slow moves to `ready`
 *   success       verified, and `onSuccess` has the token (when you exchange it yourself)
 *   linking       verified, and the token is on its way to `linkUrl`
 *   linked        `linkUrl` answered: the customer is linked
 *   link-failed   `onError` has said why, and what can be done about it
 *   unmounted
 */
export type WidgetState =
  | "loading"
  | "ready"
  | "unavailable"
  | "success"
  | "linking"
  | "linked"
  | "link-failed"
  | "unmounted";

/**
 *   config   the options are wrong; a developer fixes the code
 *   widget   the form could not load, or reported a failure of its own
 *   link     the customer verified, and handing the token to `linkUrl` failed
 */
export type ErrorStage = "config" | "widget" | "link";

export interface WidgetError {
  stage: ErrorStage;
  /** Branch on this, never on `message`. New codes may appear; handle the ones you know. */
  code: string;
  /** For a developer's log, not for a customer. */
  message: string;
  /** `link` stage only: what can be done now, given the attempts the token has left. */
  recovery?: LinkRecovery;
}

/** Codes this package produces itself. The frame reports its own, and the API's, under `widget`. */
export const WIDGET_ERROR_CODES = {
  config: ["INVALID_CONFIG"],
  widget: ["WIDGET_UNAVAILABLE", "WIDGET_ERROR"],
  link: Object.keys(LINK_RECOVERY) as LinkErrorCode[],
} as const;

interface CommonOptions {
  publishableKey: string;
  theme?: Theme;
  /** The iframe's accessible name. Translate it if your page is not in English. */
  title?: string;
  onError?: (error: WidgetError) => void;
  onStateChange?: (state: WidgetState) => void;
}

/** You exchange the token yourself: post it to your server, which calls `customers.link`. */
export interface TokenOptions extends CommonOptions {
  onSuccess: (payload: SuccessPayload) => void;
  linkUrl?: never;
  onLinked?: never;
}

/** The loader posts the token to your own route (`createLinkHandler`) and tells you how it went. */
export interface LinkOptions extends CommonOptions {
  /** A path or URL on this page's own origin. */
  linkUrl: string;
  onLinked?: (customer: LinkedCustomer) => void;
  onSuccess?: never;
}

/**
 * Exactly one of `onSuccess` or `linkUrl`. A form with neither would verify a
 * customer and drop the token on the floor.
 */
export type MountOptions = TokenOptions | LinkOptions;

export interface WidgetHandle {
  /** Remove the iframe, stop listening, and call nothing from then on. Safe to call twice. */
  unmount: () => void;
  /** Start over with a fresh form: what "verify again" does. */
  reset: () => void;
  /**
   * Send the same token to `linkUrl` again. Returns false, and does nothing,
   * unless the last failure's `recovery` was `retry` or `sign-in` and the token
   * still has attempts and time left.
   */
  retryLink: () => boolean;
  getState: () => WidgetState;
}

/**
 * The options are wrong. Thrown synchronously by `mount`, before anything is
 * created and with no network call: a secret key pasted here must not leave the
 * page, and a typo should be an error in development rather than a blank box.
 */
export class TrovyConfigError extends Error implements WidgetError {
  override readonly name = "TrovyConfigError";
  readonly stage = "config" as const;
  readonly code = "INVALID_CONFIG" as const;
}

/** By `name`, not `instanceof`: each entry of this package carries its own copy of the class. */
export function isTrovyConfigError(error: unknown): error is TrovyConfigError {
  return error instanceof Error && error.name === "TrovyConfigError";
}

/** A message from the frame. `trovy: 1` marks it as ours before anything else. */
interface FrameMessage {
  trovy?: number;
  nonce?: string;
  /** The key the frame was actually loaded with. See the check in onMessage. */
  pk?: string;
  type?: string;
  height?: number;
  linkToken?: string;
  expiresAt?: string;
  firstName?: string;
  code?: string;
  message?: string;
}

/** One link token's budget. The token lives here and nowhere else. */
interface PendingLink {
  token: string;
  deadlineMs: number;
  attempts: number;
  autoRetried: boolean;
  /** Some earlier attempt may have spent the token without our hearing so. */
  outcomeUnknown: boolean;
  lastRecovery?: LinkRecovery;
}

/** One iframe and everything that listens to it. `reset` throws one away and makes another. */
interface FrameSession {
  stop: () => void;
}

// A second mount into an element replaces the first rather than stacking a
// second iframe and a second listener on top of it.
const liveMounts = new WeakMap<Element, WidgetHandle>();

/**
 * Only the three knobs a partner is allowed, each validated rather than passed
 * through. A theme arrives as query parameters on the frame URL, so an
 * unvalidated value would be an injection point into Trovy's own page — and a
 * free-form `color` could be used to make the consent text unreadable while
 * leaving it technically present.
 */
export function sanitiseTheme(theme: Theme | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  if (!theme) return params;

  if (typeof theme.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(theme.accent)) {
    params.accent = theme.accent.toLowerCase();
  }
  if (typeof theme.radius === "number" && Number.isFinite(theme.radius)) {
    params.radius = String(Math.max(0, Math.min(24, Math.round(theme.radius))));
  }
  if (theme.mode === "light" || theme.mode === "dark" || theme.mode === "system") {
    params.mode = theme.mode;
  }
  return params;
}

function randomNonce(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Older Safari has getRandomValues but not randomUUID.
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  throw new TrovyConfigError("Trovy: this browser has no crypto.getRandomValues.");
}

function resolveElement(target: Element | string): Element {
  const el = typeof target === "string" ? document.querySelector(target) : target;
  if (!el) throw new TrovyConfigError(`Trovy: no element matched ${String(target)}.`);
  return el;
}

/**
 * `linkUrl`, made absolute. Same-origin only: the request carries the customer's
 * session cookie for this site and a token worth a customer record, and neither
 * is sent anywhere the page itself does not live.
 */
function resolveLinkUrl(linkUrl: unknown): string {
  if (typeof linkUrl !== "string" || linkUrl === "") {
    throw new TrovyConfigError("Trovy: linkUrl must be a path on your own site, such as /api/trovy/link.");
  }
  let url: URL;
  try {
    url = new URL(linkUrl, window.location.href);
  } catch {
    throw new TrovyConfigError("Trovy: linkUrl is not a valid URL.");
  }
  if (url.origin !== window.location.origin) {
    throw new TrovyConfigError(
      "Trovy: linkUrl must be on this page's own origin. Point it at a route of your own app, " +
        "which calls Trovy from the server."
    );
  }
  return url.href;
}

/**
 * A partner's callback that throws must not stop the form working, and must not
 * be swallowed either: it is rethrown on its own task, where the page's error
 * reporting sees it exactly as if nothing had caught it.
 */
function callOut<T>(callback: ((value: T) => void) | undefined, value: T): void {
  if (typeof callback !== "function") return;
  try {
    callback(value);
  } catch (error) {
    setTimeout(() => {
      throw error;
    });
  }
}

/**
 * Bind the loader to the origins the frame is served from.
 *
 * Never from an option a page can set: a configurable origin would let a
 * compromised partner site point the iframe at a look-alike and harvest phone
 * numbers and codes through a form the customer has every reason to trust. For
 * the same reason this refuses any origin that is not Trovy's own or a
 * developer's loopback.
 */
export function createMount(config: {
  frameOrigins: FrameOrigins;
}): (target: Element | string, options: MountOptions) => WidgetHandle {
  const live = config?.frameOrigins?.live;
  const test = config?.frameOrigins?.test;
  if (!isTrovyFrameOrigin(live) || !isTrovyFrameOrigin(test)) {
    throw new TrovyConfigError(
      "Trovy: createMount only binds to Trovy's own frame host. Use mount from @trovy/sdk/widget, " +
        "or TrovySignup from @trovy/sdk/react."
    );
  }
  const frameOrigins: FrameOrigins = { live, test };
  return (target, options) => mountWith(frameOrigins, target, options);
}

function mountWith(frameOrigins: FrameOrigins, target: Element | string, options: MountOptions): WidgetHandle {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new TrovyConfigError(
      "Trovy: mount needs a browser. Call it after the page has loaded (in React, from an effect), " +
        "not while rendering on a server."
    );
  }

  const { publishableKey, theme, title, onSuccess, onLinked, onError, onStateChange } = (options ??
    {}) as Partial<TokenOptions> & Partial<LinkOptions>;

  if (typeof publishableKey !== "string" || !PUBLISHABLE_KEY_PATTERN.test(publishableKey)) {
    // The key itself is never repeated: if it was a secret one, it stays out of
    // the console and out of whatever collects the console.
    throw new TrovyConfigError(
      "Trovy: publishableKey must look like trv_pk_live_<32 hex> or trv_pk_test_<32 hex>. " +
        "Secret keys (trv_live_…) must never appear in a browser."
    );
  }

  const wantsToken = typeof onSuccess === "function";
  const wantsLink = options.linkUrl !== undefined;
  if (wantsToken === wantsLink) {
    throw new TrovyConfigError(
      "Trovy: pass exactly one of linkUrl (the package links the customer through your route) or " +
        "onSuccess (you exchange the token yourself)."
    );
  }
  const linkUrl = wantsLink ? resolveLinkUrl(options.linkUrl) : undefined;

  const el = resolveElement(target);
  liveMounts.get(el)?.unmount();

  const frameOrigin = publishableKey.startsWith("trv_pk_live_") ? frameOrigins.live : frameOrigins.test;
  const environment: LinkEnvironment = publishableKey.startsWith("trv_pk_live_") ? "live" : "sandbox";
  const themeParams = sanitiseTheme(theme);

  let state: WidgetState = "loading";
  // Bumped by `reset` and `unmount`. Anything that finishes later compares its
  // own copy and, finding it stale, says nothing.
  let generation = 0;
  let pending: PendingLink | undefined;
  let session: FrameSession;

  function setState(next: WidgetState): void {
    if (state === next) return;
    state = next;
    callOut(onStateChange, next);
  }

  function linkBudgetLeft(link: PendingLink): boolean {
    return link.attempts < MAX_LINK_ATTEMPTS && Date.now() < link.deadlineMs;
  }

  async function sendLink(link: PendingLink, mine: number): Promise<void> {
    setState("linking");
    const unknownBefore = link.outcomeUnknown;
    link.attempts += 1;

    const outcome = await postLinkToken({ url: linkUrl as string, linkToken: link.token, environment });
    if (mine !== generation) return;

    if (outcome.ok) {
      pending = undefined;
      setState("linked");
      callOut(onLinked, outcome.customer);
      return;
    }

    if (outcome.outcomeUnknown) link.outcomeUnknown = true;

    if (outcome.transient && !link.autoRetried && linkBudgetLeft(link)) {
      link.autoRetried = true;
      await new Promise((resolve) => setTimeout(resolve, AUTO_RETRY_DELAY_MS));
      if (mine !== generation) return;
      return sendLink(link, mine);
    }

    // "Already used" after an attempt whose answer never arrived most likely
    // means that attempt worked. Saying "invalid" would be a guess, and the
    // wrong one more often than not.
    const code: LinkErrorCode =
      outcome.code === "LINK_TOKEN_INVALID" && unknownBefore ? "LINK_UNCONFIRMED" : outcome.code;

    let recovery = LINK_RECOVERY[code];
    // An offer to try again that cannot be honoured is worse than none.
    if ((recovery === "retry" || recovery === "sign-in") && !linkBudgetLeft(link)) recovery = "verify-again";
    link.lastRecovery = recovery;
    if (recovery === "verify-again" || recovery === "developer") pending = undefined;

    setState("link-failed");
    callOut(onError, { stage: "link", code, message: LINK_MESSAGES[code], recovery });
  }

  function startSession(): FrameSession {
    const nonce = randomNonce();
    const params = new URLSearchParams({
      pk: publishableKey as string,
      // The frame needs to know which origin to post back to, and it checks this
      // against the key's own allowed origins server-side — so a forged value
      // cannot redirect a link token anywhere.
      origin: window.location.origin,
      nonce,
      ...themeParams,
    });

    const iframe = document.createElement("iframe");
    iframe.src = `${frameOrigin}/widget/v1/frame?${params.toString()}`;
    iframe.title = typeof title === "string" && title.trim() ? title : DEFAULT_TITLE;
    iframe.setAttribute("frameborder", "0");
    iframe.setAttribute("scrolling", "no");
    // No permissions are delegated to the frame: it needs none. The isolation
    // that matters is cross-origin: the host page cannot read into the frame.
    iframe.setAttribute("allow", "");
    iframe.style.width = "100%";
    iframe.style.border = "0";
    iframe.style.display = "block";
    iframe.style.height = "320px";
    iframe.style.colorScheme = "normal";
    // Not shown until it says it is there. What a browser draws in a frame it has
    // refused is its own grey error page, and a customer should never be looking
    // at that in the middle of someone's checkout. The space is kept, so the page
    // does not jump when the form appears.
    iframe.style.visibility = "hidden";

    let alive = false;
    // The frame's success effect can run twice, and a second callback would turn
    // a single-use token into a failure the customer did nothing to cause.
    let delivered = false;

    // A frame that cannot load says nothing. The browser refuses to draw it on a
    // page the business has not listed, a revoked key gets a page that may not be
    // framed at all, and an outage is just silence — so without a deadline
    // `onError` never fires and the page waits on a box it cannot see into. The
    // reserved space is given back too. Not final: a frame that was only slow is
    // shown below.
    const readyTimer = setTimeout(() => {
      if (alive) return;
      iframe.style.display = "none";
      setState("unavailable");
      callOut(onError, {
        stage: "widget",
        code: "WIDGET_UNAVAILABLE",
        message: "The sign-up form could not be loaded.",
      });
    }, READY_TIMEOUT_MS);

    function onMessage(event: MessageEvent): void {
      // Five checks, all required.
      //
      // Origin and source prove the message came from a frame on Trovy's host
      // rather than from another script on the page. The marker and nonce prove it
      // came from *this* mount, so a second widget or a replayed message cannot
      // resolve the wrong one.
      //
      // The key is the fifth, and it closes something the other four do not. A
      // script on the host page (an XSS, a rogue tag) can read the nonce out of
      // `iframe.src` and repoint that same element at the frame with *its own*
      // publishable key — `event.source` is the element's contentWindow either way,
      // so it still matches. The customer then fills in a real Trovy form and is
      // enrolled in the attacker's programme. Requiring the frame to echo the key it
      // was loaded with makes the navigation detectable.
      if (event.origin !== frameOrigin) return;
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as FrameMessage | null;
      if (!data || data.trovy !== 1 || data.nonce !== nonce) return;
      if (data.pk !== publishableKey) return;

      // Any message that passed all five proves the form is up, not only
      // `trovy:ready` — a frame built before that message existed still resizes.
      if (!alive) {
        alive = true;
        clearTimeout(readyTimer);
        iframe.style.display = "block";
        iframe.style.visibility = "visible";
        if (state === "loading" || state === "unavailable") setState("ready");
      }

      switch (data.type) {
        case "trovy:resize": {
          if (typeof data.height === "number" && data.height > 0) {
            iframe.style.height = `${Math.min(Math.round(data.height), 2000)}px`;
          }
          return;
        }
        case "trovy:success": {
          if (delivered || typeof data.linkToken !== "string" || typeof data.expiresAt !== "string") return;
          delivered = true;

          if (!linkUrl) {
            setState("success");
            callOut(onSuccess, {
              linkToken: data.linkToken,
              expiresAt: data.expiresAt,
              ...(typeof data.firstName === "string" ? { firstName: data.firstName } : {}),
            });
            return;
          }

          pending = {
            token: data.linkToken,
            deadlineMs: Date.now() + LINK_TOKEN_LIFETIME_MS,
            attempts: 0,
            autoRetried: false,
            outcomeUnknown: false,
          };
          void sendLink(pending, generation);
          return;
        }
        case "trovy:error": {
          callOut(onError, {
            stage: "widget",
            code: typeof data.code === "string" ? data.code : "WIDGET_ERROR",
            message: typeof data.message === "string" ? data.message : "Something went wrong.",
          });
          return;
        }
        default:
          // "trovy:ready" and anything a later frame version adds.
          return;
      }
    }

    window.addEventListener("message", onMessage);
    el.appendChild(iframe);

    return {
      // Called exactly once per session: `unmount` and `reset` both check the
      // state first.
      stop() {
        clearTimeout(readyTimer);
        window.removeEventListener("message", onMessage);
        iframe.remove();
      },
    };
  }

  const handle: WidgetHandle = {
    unmount() {
      if (state === "unmounted") return;
      generation += 1;
      pending = undefined;
      session.stop();
      if (liveMounts.get(el) === handle) liveMounts.delete(el);
      // Set directly: `unmount` is the caller's own doing, and nothing is called
      // back after it, this included.
      state = "unmounted";
    },
    reset() {
      if (state === "unmounted") return;
      // A link request in flight is left to finish. Aborting it would not
      // un-spend the token; its answer is simply no longer anyone's business.
      generation += 1;
      pending = undefined;
      session.stop();
      session = startSession();
      setState("loading");
    },
    retryLink() {
      const link = pending;
      if (state !== "link-failed" || !link || !linkBudgetLeft(link)) return false;
      if (link.lastRecovery !== "retry" && link.lastRecovery !== "sign-in") return false;
      void sendLink(link, generation);
      return true;
    },
    getState: () => state,
  };

  session = startSession();
  liveMounts.set(el, handle);
  return handle;
}
