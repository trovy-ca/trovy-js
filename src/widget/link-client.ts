import {
  LINK_HEADER,
  LINK_HEADER_VALUE,
  isLinkHandlerCode,
  type LinkEnvironment,
  type LinkErrorCode,
  type LinkedCustomer,
  type LinkRequestBody,
} from "../link-protocol.js";

/** Long enough for a cold serverless route plus Trovy's own call; short enough that the customer is still there. */
export const LINK_TIMEOUT_MS = 15_000;

export interface LinkFailure {
  ok: false;
  code: LinkErrorCode;
  /** Worth one automatic retry: the failure was quick and says nothing about the token. */
  transient: boolean;
  /** The request may have reached Trovy and spent the token before the answer was lost. */
  outcomeUnknown: boolean;
}

export type LinkOutcome = { ok: true; customer: LinkedCustomer } | LinkFailure;

export interface LinkRequest {
  /** Absolute, and already checked to be on the page's own origin. */
  url: string;
  linkToken: string;
  environment: LinkEnvironment;
}

const failure = (code: LinkErrorCode, flags: { transient?: boolean; outcomeUnknown?: boolean } = {}): LinkFailure => ({
  ok: false,
  code,
  transient: flags.transient ?? false,
  outcomeUnknown: flags.outcomeUnknown ?? false,
});

/** What a bare status means, when the answer did not come from the link route itself. */
const BY_STATUS: Record<number, LinkFailure> = {
  400: failure("LINK_BAD_REQUEST"),
  401: failure("LINK_NOT_SIGNED_IN"),
  403: failure("LINK_FORBIDDEN"),
  404: failure("LINK_ENDPOINT_INVALID"),
  405: failure("LINK_ENDPOINT_INVALID"),
  409: failure("LINK_TOKEN_INVALID"),
  413: failure("LINK_BAD_REQUEST"),
  415: failure("LINK_BAD_REQUEST"),
  429: failure("LINK_UPSTREAM_UNAVAILABLE", { transient: true }),
  502: failure("LINK_UPSTREAM_UNAVAILABLE", { transient: true, outcomeUnknown: true }),
  503: failure("LINK_UPSTREAM_UNAVAILABLE", { transient: true }),
  504: failure("LINK_UPSTREAM_UNAVAILABLE", { transient: true, outcomeUnknown: true }),
};

function isLinkedCustomer(value: unknown): value is LinkedCustomer {
  if (!value || typeof value !== "object") return false;
  const { name, isNew } = value as Record<string, unknown>;
  return (typeof name === "string" || name === null) && typeof isNew === "boolean";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Send the link token to the partner's own route, once.
 *
 * It never throws and never retries: every way this can end is one `LinkOutcome`,
 * and deciding what to do about it belongs to the caller, which knows how many
 * attempts the token has left.
 */
export async function postLinkToken(request: LinkRequest): Promise<LinkOutcome> {
  const body: LinkRequestBody = { linkToken: request.linkToken, environment: request.environment };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", [LINK_HEADER]: LINK_HEADER_VALUE },
      body: JSON.stringify(body),
      // The route is the partner's own. Never anywhere else, and never with
      // somebody else's cookies.
      mode: "same-origin",
      credentials: "same-origin",
      // A sign-in middleware answers an expired session with a redirect, and a
      // followed 307 re-posts the body: the token would be sent to the login page.
      redirect: "manual",
      cache: "no-store",
      // A page that navigates on success must not cancel the request that links.
      keepalive: true,
      signal: controller.signal,
    });
  } catch {
    // Rejected, aborted by the deadline, or blocked. A quick rejection is worth
    // one more try; after fifteen seconds the customer has waited long enough.
    return failure("LINK_NETWORK_ERROR", { transient: !controller.signal.aborted, outcomeUnknown: true });
  } finally {
    clearTimeout(timer);
  }

  // `redirect: "manual"` turns any redirect into this: no status, no headers.
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return failure("LINK_ENDPOINT_INVALID");
  }

  const payload = (await readJson(response)) as { ok?: unknown; code?: unknown; customer?: unknown } | undefined;

  if (response.status === 200) {
    // Strictly this shape. A catch-all page, a proxy's cached answer or some
    // other route all answer 200 too, and none of them linked anybody.
    return payload?.ok === true && isLinkedCustomer(payload.customer)
      ? { ok: true, customer: { name: payload.customer.name, isNew: payload.customer.isNew } }
      : failure("LINK_ENDPOINT_INVALID");
  }

  // The route's own code is more precise than its status: `LINK_SAVE_FAILED`
  // and a misconfigured key are both a 500, and only one of them spent the token.
  if (payload?.ok === false && isLinkHandlerCode(payload.code)) {
    const known = BY_STATUS[response.status];
    return failure(payload.code, {
      transient: known?.code === payload.code && known.transient,
      outcomeUnknown: known?.outcomeUnknown ?? false,
    });
  }

  // Not our route's answer: a proxy, a platform error page, a crash.
  return BY_STATUS[response.status] ?? failure("LINK_SERVER_ERROR", { outcomeUnknown: response.status >= 500 });
}
