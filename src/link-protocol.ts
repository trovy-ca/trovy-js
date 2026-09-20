/**
 * What the sign-up component and `createLinkHandler` say to each other.
 *
 * Both ends ship in this package, but not always at the same version: a partner
 * can deploy a new server bundle while a customer's tab still runs last week's
 * component. So this is a wire protocol and changes to it are additive only. A
 * reader must ignore fields it does not know and must not require new ones.
 *
 * Nothing here touches a DOM or a server API. Both halves import it.
 */

/**
 * A request header the component always sends. A custom header cannot be added
 * to a cross-site form post or a no-cors fetch, so its presence means the
 * browser either ran same-origin code or passed a CORS preflight the route never
 * answers.
 */
export const LINK_HEADER = "X-Trovy-Link";
export const LINK_HEADER_VALUE = "1";

/** Far above any real body (a token is at most 200 characters). */
export const MAX_LINK_BODY_BYTES = 2048;

export type LinkEnvironment = "live" | "sandbox";

/** The request body. */
export interface LinkRequestBody {
  linkToken: string;
  /** Which kind of publishable key the form ran with, so a mismatched secret key is caught before the token is spent. */
  environment: LinkEnvironment;
}

/** The customer, as far as the browser needs to know. Never the customer id. */
export interface LinkedCustomer {
  name: string | null;
  isNew: boolean;
}

/** Codes the route itself answers with. */
export const LINK_HANDLER_CODES = [
  "LINK_BAD_REQUEST",
  "LINK_FORBIDDEN",
  "LINK_NOT_SIGNED_IN",
  "LINK_TOKEN_INVALID",
  "LINK_UPSTREAM_UNAVAILABLE",
  "LINK_SAVE_FAILED",
  "LINK_SERVER_ERROR",
] as const;
export type LinkHandlerCode = (typeof LINK_HANDLER_CODES)[number];

/** Codes only the browser can arrive at: no answer, the wrong answer, or an answer it cannot trust. */
export const LINK_CLIENT_CODES = [
  "LINK_NETWORK_ERROR",
  "LINK_ENDPOINT_INVALID",
  "LINK_UNCONFIRMED",
] as const;
export type LinkClientCode = (typeof LINK_CLIENT_CODES)[number];

export type LinkErrorCode = LinkHandlerCode | LinkClientCode;

export type LinkResponseBody =
  | { ok: true; customer: LinkedCustomer }
  | { ok: false; code: LinkHandlerCode; message: string };

/**
 * What can be done about a failed link.
 *
 *   retry          nothing was decided; the same token can be sent again
 *   verify-again   this token is finished; the customer goes through the form again
 *   sign-in        the route did not recognise the customer's session
 *   developer      the integration is wrong; nothing the customer does will help
 */
export type LinkRecovery = "retry" | "verify-again" | "sign-in" | "developer";

export const LINK_RECOVERY: Record<LinkErrorCode, LinkRecovery> = {
  LINK_NETWORK_ERROR: "retry",
  LINK_UPSTREAM_UNAVAILABLE: "retry",
  LINK_TOKEN_INVALID: "verify-again",
  LINK_UNCONFIRMED: "verify-again",
  LINK_SAVE_FAILED: "verify-again",
  LINK_NOT_SIGNED_IN: "sign-in",
  LINK_FORBIDDEN: "developer",
  LINK_BAD_REQUEST: "developer",
  LINK_ENDPOINT_INVALID: "developer",
  LINK_SERVER_ERROR: "developer",
};

/**
 * One fixed sentence per code, written for the developer reading a log. Never
 * assembled from a response: nothing an upstream said, no key and no token can
 * end up in one.
 */
export const LINK_MESSAGES: Record<LinkErrorCode, string> = {
  LINK_NETWORK_ERROR: "The link request got no answer. The same token can be sent again.",
  LINK_UPSTREAM_UNAVAILABLE: "Trovy could not be reached from the link route. The same token can be sent again.",
  LINK_TOKEN_INVALID: "The link token is expired, already used or not for this business. The customer verifies again.",
  LINK_UNCONFIRMED:
    "An earlier attempt may have linked this customer before its answer was lost. Verifying again is safe: it returns the same customer.",
  LINK_SAVE_FAILED: "The customer was linked but onLinked threw, so nothing was saved. Verifying again returns the same customer.",
  LINK_NOT_SIGNED_IN: "getUser returned no user for this request.",
  LINK_FORBIDDEN: "The link route refused the request: it did not come from this site's own pages.",
  LINK_BAD_REQUEST: "The link route could not read the request.",
  LINK_ENDPOINT_INVALID:
    "linkUrl did not answer like a Trovy link route. Check the path, that the route exports POST, and that no middleware redirects it.",
  LINK_SERVER_ERROR: "The link route failed. Its server log has the reason.",
};

export function isLinkHandlerCode(value: unknown): value is LinkHandlerCode {
  return typeof value === "string" && (LINK_HANDLER_CODES as readonly string[]).includes(value);
}
