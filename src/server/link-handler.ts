/**
 * The route that joins the sign-up form to the server client.
 *
 * The form verifies a customer and gets a link token: single use, five minutes.
 * The component posts that token here, to the partner's own origin; this handler
 * works out which of the partner's users is asking, exchanges the token for a
 * Trovy customer id with the secret key, and hands both to `onLinked` to be saved
 * together. The customer id never goes back to the browser.
 *
 * Web-standard `Request` in, `Response` out, no framework and no Node API, so
 * it runs on Node and on the edge alike.
 */

import { Trovy } from "../client.js";
import { isTrovyConnectionError, isTrovyError } from "../errors.js";
import {
  LINK_HEADER,
  LINK_HEADER_VALUE,
  LINK_MESSAGES,
  MAX_LINK_BODY_BYTES,
  type LinkEnvironment,
  type LinkHandlerCode,
  type LinkResponseBody,
} from "../link-protocol.js";

/** The customer as your server sees them. `id` is what you store. */
export interface LinkedCustomerRecord {
  /** Your customer id for this member. Verifying again returns the same one. */
  id: string;
  name: string | null;
  /** True when this verification created the member; false when an existing member linked to you. */
  isNew: boolean;
}

/** The part of the server client this handler uses. `new Trovy(…)` is one. */
export interface LinkClient {
  readonly environment: LinkEnvironment;
  customers: {
    link(
      body: { linkToken: string },
      options?: { timeoutMs?: number }
    ): Promise<{ customer: LinkedCustomerRecord }>;
  };
}

/** Told to `onError` when the handler fails for a reason your server should know about. */
export interface LinkHandlerFailure {
  /**
   *   config     the secret key is missing or malformed, or is for the other environment
   *   getUser    your `getUser` threw, or returned something that is not a string
   *   link       Trovy refused the key, or could not be reached
   *   onLinked   your `onLinked` threw AFTER the customer was linked: `userId` and `customer` are set, so you can repair
   */
  stage: "config" | "getUser" | "link" | "onLinked";
  /** What the browser was told. */
  code: LinkHandlerCode;
  error: unknown;
  userId?: string;
  customer?: LinkedCustomerRecord;
}

export interface LinkHandlerOptions {
  /**
   * Your secret key, usually `process.env.TROVY_SECRET_KEY`. It may be undefined
   * when this module is first evaluated (a build has no secrets), so it is
   * checked on the first request, not here.
   */
  secretKey?: string | undefined;
  /** Instead of `secretKey`: a client you constructed yourself. */
  trovy?: LinkClient;
  /**
   * Who is asking, from your own session. Runs BEFORE the token is spent, so a
   * signed-out customer can sign in and try again with the same token. Return
   * null when nobody is signed in.
   */
  getUser: (request: Request) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Save `customer.id` against `userId`. Make it idempotent: a customer who
   * verifies twice links twice, with the same id. If a different customer id is
   * already stored for this user, do not silently overwrite it.
   */
  onLinked: (event: { userId: string; customer: LinkedCustomerRecord; request: Request }) => void | Promise<void>;
  /** Failures your server should hear about. Defaults to `console.error`. Never receives the token or the key. */
  onError?: (failure: LinkHandlerFailure) => void | Promise<void>;
  /**
   * Origins, besides the route's own, whose pages may call it. Only needed when
   * a proxy changes the host the route sees and does not set `X-Forwarded-Host`.
   */
  allowedOrigins?: readonly string[];
}

/** How long Trovy gets. Inside the component's own 15 seconds, with room for `getUser` and `onLinked`. */
const LINK_CALL_TIMEOUT_MS = 8_000;

const STATUS: Record<LinkHandlerCode, number> = {
  LINK_BAD_REQUEST: 400,
  LINK_NOT_SIGNED_IN: 401,
  LINK_FORBIDDEN: 403,
  LINK_TOKEN_INVALID: 409,
  LINK_SAVE_FAILED: 500,
  LINK_SERVER_ERROR: 500,
  LINK_UPSTREAM_UNAVAILABLE: 502,
};

function respond(body: LinkResponseBody, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

/** Fixed text per code. Nothing Trovy said, no key and no token is ever part of an answer. */
function refuse(code: LinkHandlerCode, status = STATUS[code], headers?: Record<string, string>): Response {
  return respond({ ok: false, code, message: LINK_MESSAGES[code] }, status, headers);
}

/**
 * Whether the request came from one of this site's own pages.
 *
 * The custom header already forces a preflight on any cross-site attempt; this
 * is the second lock. A browser that sends fetch metadata settles it outright.
 * Otherwise `Origin` has to name an allowed origin or the host the route was
 * reached on. A request with neither header is not from a browser at all, and a
 * forged cross-site request needs one.
 */
function isOwnPage(request: Request, allowedOrigins: readonly string[]): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin") return true;

  const origin = request.headers.get("origin");
  if (origin === null) return site === null;
  if (allowedOrigins.includes(origin)) return true;

  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0]!.trim();
  try {
    return host !== "" && new URL(origin).host === host;
  } catch {
    return false;
  }
}

const TOO_LARGE = Symbol("too large");

/**
 * The body, read up to a hard cap. `Content-Length` is only a hint — it can be
 * absent or untrue — so the bytes are counted as they arrive. Read from a clone:
 * `getUser` is handed a request it can still read.
 */
async function readBody(request: Request): Promise<string | typeof TOO_LARGE> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_LINK_BODY_BYTES) return TOO_LARGE;

  const stream = request.clone().body;
  if (!stream) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_LINK_BODY_BYTES) {
      // Not awaited. A clone is one half of a tee, and cancelling half a tee
      // settles only when the other half is cancelled too: the route would hang
      // on exactly the request it is trying to get rid of.
      void reader.cancel().catch(() => {});
      return TOO_LARGE;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseBody(text: string): { linkToken: string; environment?: LinkEnvironment } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  // Fields this version does not know are ignored, not refused: a newer
  // component may send more.
  const { linkToken, environment } = parsed as Record<string, unknown>;
  if (typeof linkToken !== "string" || linkToken.length < 1 || linkToken.length > 200) return undefined;
  // Optional, so that a caller other than the component can use the route. When
  // it is there it is one of two words: it ends up in a log line.
  if (environment !== undefined && environment !== "live" && environment !== "sandbox") return undefined;
  return { linkToken, environment };
}

export function createLinkHandler(options: LinkHandlerOptions): (request: Request) => Promise<Response> {
  // Mistakes in the code itself fail here, where a build or a first import
  // shows them. The secret key is different: it is configuration, and a build
  // has none.
  if (typeof options?.getUser !== "function") {
    throw new TypeError("Trovy: createLinkHandler needs getUser, which returns the signed-in user's id or null.");
  }
  if (typeof options.onLinked !== "function") {
    throw new TypeError("Trovy: createLinkHandler needs onLinked, which saves customer.id against userId.");
  }
  if (options.trovy !== undefined && options.secretKey !== undefined) {
    throw new TypeError("Trovy: pass createLinkHandler either secretKey or trovy, not both.");
  }

  const { getUser, onLinked } = options;
  const allowedOrigins = options.allowedOrigins ?? [];
  let client = options.trovy;

  async function report(failure: LinkHandlerFailure): Promise<void> {
    try {
      if (options.onError) await options.onError(failure);
      else console.error(`[trovy] link route failed at ${failure.stage} (${failure.code})`, failure.error);
    } catch {
      // A reporter that throws must not change what the browser is told.
    }
  }

  return async function handleLink(request: Request): Promise<Response> {
    if (request.method !== "POST") return refuse("LINK_BAD_REQUEST", 405, { Allow: "POST" });
    if (request.headers.get(LINK_HEADER) !== LINK_HEADER_VALUE) return refuse("LINK_FORBIDDEN");
    if (!isOwnPage(request, allowedOrigins)) return refuse("LINK_FORBIDDEN");

    const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== "application/json") return refuse("LINK_BAD_REQUEST", 415);

    const text = await readBody(request);
    if (text === TOO_LARGE) return refuse("LINK_BAD_REQUEST", 413);
    const body = parseBody(text);
    if (!body) return refuse("LINK_BAD_REQUEST");

    // Everything from here on is decided before the token is spent.
    if (!client) {
      try {
        if (!options.secretKey) throw new Error("Trovy: createLinkHandler has no secretKey. Is TROVY_SECRET_KEY set on this server?");
        client = new Trovy({ apiKey: options.secretKey });
      } catch (error) {
        await report({ stage: "config", code: "LINK_SERVER_ERROR", error });
        return refuse("LINK_SERVER_ERROR");
      }
    }

    // A test publishable key with a live secret key (or the reverse) can only
    // fail, and would spend a token finding out.
    if (body.environment !== undefined && body.environment !== client.environment) {
      await report({
        stage: "config",
        code: "LINK_SERVER_ERROR",
        error: new Error(
          `Trovy: the form ran with a ${body.environment} publishable key and this route has a ` +
            `${client.environment} secret key. Use a test key with a test key, a live key with a live key.`
        ),
      });
      return refuse("LINK_SERVER_ERROR");
    }

    let userId: string | null | undefined;
    try {
      userId = await getUser(request);
    } catch (error) {
      await report({ stage: "getUser", code: "LINK_SERVER_ERROR", error });
      return refuse("LINK_SERVER_ERROR");
    }
    if (userId === null || userId === undefined || userId === "") return refuse("LINK_NOT_SIGNED_IN");
    if (typeof userId !== "string") {
      await report({
        stage: "getUser",
        code: "LINK_SERVER_ERROR",
        error: new TypeError("Trovy: getUser must return the user's id as a string, or null."),
      });
      return refuse("LINK_SERVER_ERROR");
    }

    let customer: LinkedCustomerRecord;
    try {
      // Once. The token is single-use and the first attempt spends it, so a
      // retry here could only turn a success into "token invalid".
      ({ customer } = await client.customers.link({ linkToken: body.linkToken }, { timeoutMs: LINK_CALL_TIMEOUT_MS }));
    } catch (error) {
      if (isTrovyError(error)) {
        // 409 rather than Trovy's own 404, so that the component can tell a dead
        // token from a mistyped linkUrl.
        if (error.code === "LINK_TOKEN_INVALID" || error.status === 404 || error.status === 400) {
          return refuse("LINK_TOKEN_INVALID");
        }
        if (error.status === 429) {
          const wait = Math.min(Math.max(Math.ceil(error.retryAfterSeconds ?? 1), 1), 60);
          return refuse("LINK_UPSTREAM_UNAVAILABLE", 503, { "Retry-After": String(wait) });
        }
        if (error.status >= 500) {
          await report({ stage: "link", code: "LINK_UPSTREAM_UNAVAILABLE", error, userId });
          return refuse("LINK_UPSTREAM_UNAVAILABLE");
        }
        // 401 and 403: the key is revoked, disabled or not enabled for the API.
        // The browser learns only that the route failed.
        await report({ stage: "link", code: "LINK_SERVER_ERROR", error, userId });
        return refuse("LINK_SERVER_ERROR");
      }
      const code = isTrovyConnectionError(error) ? "LINK_UPSTREAM_UNAVAILABLE" : "LINK_SERVER_ERROR";
      await report({ stage: "link", code, error, userId });
      return refuse(code);
    }

    try {
      await onLinked({ userId, customer, request });
    } catch (error) {
      // The token is spent and nothing was saved. The failure carries what
      // `onLinked` was given, so it can be saved by other means; and verifying
      // again returns the same customer id.
      await report({ stage: "onLinked", code: "LINK_SAVE_FAILED", error, userId, customer });
      return refuse("LINK_SAVE_FAILED");
    }

    return respond({ ok: true, customer: { name: customer.name, isNew: customer.isNew } }, 200);
  };
}
