import { TrovyConnectionError, TrovyError, type TrovyErrorBody } from "./errors.js";
import { OPERATIONS, type OperationId, type Payload, type Result } from "./operations.js";

declare const __SDK_VERSION__: string;
/** Replaced at build time by tsup; the fallback is what a source consumer sees. */
const SDK_VERSION = typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.0.0-dev";

const LIVE_BASE_URL = "https://api.trovy.ca";
const SANDBOX_BASE_URL = "https://api.sandbox.trovy.ca";

/** `trv_live_<64 hex>` or `trv_test_<64 hex>` — see the API's own key format. */
const SECRET_KEY_PATTERN = /^trv_(live|test)_[0-9a-f]{64}$/;

export interface TrovyOptions {
  /** Your secret key. Never a publishable `trv_pk_` key — those are for browsers. */
  apiKey: string;
  /**
   * Override the base URL. Inferred from the key's environment otherwise, which
   * is what you want in production: a test key cannot reach live data and a live
   * key cannot reach the sandbox, so there is nothing to configure.
   */
  baseUrl?: string;
  /** Inject a `fetch` for tests or for a proxied environment. */
  fetch?: typeof globalThis.fetch;
  /** Retries after a network failure, a timeout or a 5xx. Default 2 (3 attempts). */
  maxRetries?: number;
  /** Per-attempt deadline in milliseconds. Default 30000. */
  timeoutMs?: number;
  /**
   * Construct the client where a DOM exists. The client refuses by default,
   * because a secret key in a browser belongs to everyone who opens the page.
   * The one good reason to set this is a test environment that fakes a DOM.
   */
  dangerouslyAllowBrowser?: boolean;
}

export interface RequestOptions {
  /**
   * The key that makes a write safe to retry. Supply your own — your order id is
   * the natural choice — so that a retry from a *new process* (a redeployed
   * worker, a queue redelivery) still replays rather than double-applying. When
   * omitted the SDK generates one, which covers its own retries and nothing more.
   *
   * Must not contain `":"`.
   */
  idempotencyKey?: string;
  /** Abort the call. Composed with the client's own timeout. */
  signal?: AbortSignal;
  /** Override the client's per-attempt deadline for this call. */
  timeoutMs?: number;
}

/**
 * What this client's own deadline aborts with, so a timeout is distinguishable
 * from the caller's abort in a stack trace.
 */
const TIMEOUT_REASON = new DOMException("Trovy: request timed out.", "TimeoutError");

/** How long to wait before attempt n (1-indexed), capped and jittered. */
function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 4000);
  // Full jitter: two workers that fail together must not retry together.
  return Math.random() * base;
}

/**
 * A browser, a WebView or React Native: somewhere the person holding the device
 * can read whatever the code holds. Reached through `globalThis` because none of
 * these names exist on the runtimes this client is for.
 */
function runsOnSomeoneElsesDevice(): boolean {
  const scope = globalThis as {
    window?: { document?: unknown };
    navigator?: { product?: string };
  };
  return scope.window?.document !== undefined || scope.navigator?.product === "ReactNative";
}

function baseUrlForKey(apiKey: string): string {
  if (!SECRET_KEY_PATTERN.test(apiKey)) {
    // A TypeError, thrown from the constructor, because this is a programming
    // mistake and not a runtime condition: a publishable key, a truncated
    // paste, or an unset environment variable. Failing here beats 401s at
    // checkout time, and nothing is sent over the wire.
    //
    // The message names the wrong key someone actually pastes, because
    // "invalid key" sends them looking at the value they believe is correct.
    const hint = apiKey.startsWith("trv_pk_")
      ? " That is a publishable key — it belongs in the browser widget, not here."
      : " Publishable keys (trv_pk_…) belong in the browser widget, not here.";
    throw new TypeError(
      `Trovy: apiKey must look like trv_live_<64 hex> or trv_test_<64 hex>.${hint}`
    );
  }
  return apiKey.startsWith("trv_live_") ? LIVE_BASE_URL : SANDBOX_BASE_URL;
}

/**
 * What the API accepts as an idempotency key, checked here so a bad one is a
 * `TypeError` in development rather than a 400 at a customer's checkout.
 *
 * The charset is the API's own. It matters because the README tells partners to
 * use their order id, and plenty of systems name an order `#1001` or
 * `ORD/2026/01` — neither of which the API will take.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The wait a `Retry-After` asks for, in milliseconds, or `null` when it asks for
 * nothing usable.
 *
 * Capped at 60 seconds so a broken or hostile header cannot park a request for an
 * hour. A value that resolves to zero or less — `"-5"`, `"0"`, a date in the past
 * — returns `null` rather than `0`, so the caller falls back to its own backoff
 * instead of retrying in a hot loop. (`Date.parse("-5")` is a real date in 2001,
 * which is how a negative integer used to end up as "wait no time at all".)
 */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.min(seconds, 60) * 1000 : null;
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  const wait = Math.min(date - Date.now(), 60_000);
  return wait > 0 ? wait : null;
}

/**
 * Whether a response is worth another attempt.
 *
 * 5xx only, and not 501: a Not Implemented answer will be Not Implemented again.
 * Never a 4xx — including 429. A rate limit is surfaced with
 * `retryAfterSeconds` so the caller decides, because a checkout that silently
 * sleeps for thirty seconds is worse for the customer standing there than one
 * told to back off. Never a 2xx, obviously, and never a 3xx: `fetch` follows
 * redirects itself and the API issues none.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 && status !== 501;
}

export class Trovy {
  readonly baseUrl: string;
  readonly environment: "live" | "sandbox";

  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;

  constructor(options: TrovyOptions) {
    // First, before the key is read or stored anywhere.
    if (!options.dangerouslyAllowBrowser && runsOnSomeoneElsesDevice()) {
      throw new Error(
        "Trovy: this client takes a secret key and is running in a browser, where anyone " +
          "can read it. Call the API from your server. In the browser, use @trovy/sdk/react " +
          "or @trovy/sdk/widget with a publishable key. If this is a test environment with a " +
          "fake DOM, pass dangerouslyAllowBrowser: true."
      );
    }

    const inferred = baseUrlForKey(options.apiKey);
    this.#apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? inferred).replace(/\/+$/, "");
    this.environment = options.apiKey.startsWith("trv_live_") ? "live" : "sandbox";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#timeoutMs = options.timeoutMs ?? 30_000;

    if (typeof this.#fetch !== "function") {
      throw new TypeError("Trovy: no fetch available. Pass one, or run on Node 20+.");
    }
    if (!Number.isInteger(this.#maxRetries) || this.#maxRetries < 0) {
      throw new TypeError("Trovy: maxRetries must be a non-negative integer.");
    }
  }

  /** This business, and the currency every `...Cents` figure is counted in. */
  readonly business = {
    get: (options?: RequestOptions) => this.#call("getBusiness", undefined, undefined, options),
    listStores: (options?: RequestOptions) =>
      this.#call("listStores", undefined, undefined, options),
  };

  readonly customers = {
    /** Exchange a widget link token for your customer id. Single use. */
    link: (body: Payload<"linkCustomer">, options?: RequestOptions) =>
      this.#call("linkCustomer", body, undefined, options),
    /** Whether a phone number is already a member linked to you. */
    lookup: (body: Payload<"lookupCustomer">, options?: RequestOptions) =>
      this.#call("lookupCustomer", body, undefined, options),
  };

  readonly rewards = {
    list: (customerId: string, options?: RequestOptions) =>
      this.#call("listCustomerRewards", undefined, { id: customerId }, options),
    earn: (body: Payload<"earnReward">, options?: RequestOptions) =>
      this.#call("earnReward", body, undefined, options),
    redeem: (body: Payload<"redeemReward">, options?: RequestOptions) =>
      this.#call("redeemReward", body, undefined, options),
    refund: (body: Payload<"createRefund">, options?: RequestOptions) =>
      this.#call("createRefund", body, undefined, options),
  };

  readonly giftCards = {
    create: (body: Payload<"createGiftCard">, options?: RequestOptions) =>
      this.#call("createGiftCard", body, undefined, options),
    lookup: (body: Payload<"lookupGiftCard">, options?: RequestOptions) =>
      this.#call("lookupGiftCard", body, undefined, options),
    redeem: (body: Payload<"redeemGiftCard">, options?: RequestOptions) =>
      this.#call("redeemGiftCard", body, undefined, options),
    reverseRedemption: (
      redemptionId: string,
      body: Payload<"reverseGiftCardRedemption">,
      options?: RequestOptions
    ) => this.#call("reverseGiftCardRedemption", body, { id: redemptionId }, options),
    void: (giftCardId: string, options?: RequestOptions) =>
      this.#call("voidGiftCard", undefined, { id: giftCardId }, options),
  };

  async #call<K extends OperationId>(
    operationId: K,
    body: unknown,
    pathParams: Record<string, string> | undefined,
    options: RequestOptions | undefined
  ): Promise<Result<K>> {
    const spec = OPERATIONS[operationId];

    let path: string = spec.path;
    if (pathParams) {
      for (const [name, value] of Object.entries(pathParams)) {
        if (!value) {
          throw new TypeError(`Trovy: ${operationId} needs a non-empty ${name}.`);
        }
        path = path.replace(`{${name}}`, encodeURIComponent(value));
      }
    }
    if (path.includes("{")) {
      // A template whose parameter name stopped matching what the caller passes
      // would otherwise send a literal "{id}" and 404 every call. Nothing can
      // reach this today — the table and the spec are checked against each other
      // — so it guards a future rename rather than a runtime condition.
      throw new TypeError(
        `Trovy: ${operationId} has an unsubstituted path parameter in ${path}.`
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
      "User-Agent": `trovy-sdk-typescript/${SDK_VERSION}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    if (spec.idempotent) {
      // `crypto` is global on every runtime this package supports (Node 20+,
      // Deno, Workers), so the package stays import-free and bundles wherever a
      // partner's server code runs.
      // A blank or whitespace-only key is treated as absent rather than sent: it
      // would be a 400, and it almost always means an upstream value was empty.
      const supplied = options?.idempotencyKey?.trim();
      const key = supplied || globalThis.crypto.randomUUID();
      if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
        // Checked against the API's own charset. The README tells partners to use their order
        // id, and an order named "#1001" or "ORD/2026/01" would otherwise be a 400
        // at a customer's checkout rather than an error in development.
        throw new TypeError(
          "Trovy: idempotencyKey must be 1-128 characters of letters, digits, '.', '_' or '-'. " +
            `Got ${JSON.stringify(key)}.`
        );
      }
      // Computed once, outside the retry loop below, which is the whole point:
      // every attempt at this call carries the same key, so a retry after a
      // timeout replays the first attempt rather than applying a second one.
      headers["Idempotency-Key"] = key;
    }

    const payload = body === undefined ? undefined : JSON.stringify(body);
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = options?.timeoutMs ?? this.#timeoutMs;
    const attempts = this.#maxRetries + 1;

    let lastConnectionError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      // A caller who aborted between attempts gets their abort, not a retry.
      options?.signal?.throwIfAborted();

      // An AbortController with its own timer, rather than `AbortSignal.any` over
      // `AbortSignal.timeout`. Two reasons. `any` registers a dependent signal on
      // the caller's signal and nothing removes it, so one long-lived application
      // signal passed to every call accumulated a dependent per attempt — a leak
      // measured at 480MB over 200,000 calls. And `AbortSignal.any` only landed in
      // Node 20.3, while this package claims Node 20.
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort(options?.signal?.reason);
      const timer = setTimeout(() => controller.abort(TIMEOUT_REASON), timeoutMs);
      options?.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const release = () => {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onCallerAbort);
      };

      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: spec.method,
          headers,
          body: payload,
          signal: controller.signal,
        });

        if (response.ok) {
          // Read inside the try, not after it. A 2xx whose body is not JSON — a
          // proxy answering 200 with an HTML page — or whose read is cut short by
          // this attempt's own timeout used to throw a raw SyntaxError or
          // AbortError that escaped both error classes and skipped the retry
          // entirely. That second case is precisely "the write may have landed",
          // which is the one case that must be retryable.
          const text = await response.text();
          if (text.trim() === "") {
            // No operation in the contract answers with an empty body. Returning
            // `undefined` cast to the result type surfaced as a TypeError on the
            // caller's first property access, a long way from the cause.
            throw new TrovyError(response.status, {
              error: `Trovy: ${operationId} returned ${response.status} with an empty body.`,
              code: "HTTP_ERROR",
            });
          }
          return JSON.parse(text) as Result<K>;
        }
      } catch (cause) {
        // A refusal built above is the answer, not a transport failure.
        if (cause instanceof TrovyError) throw cause;
        // The caller's own abort is final: they asked to stop, so stopping is the
        // correct outcome and a retry would ignore them.
        options?.signal?.throwIfAborted();
        lastConnectionError = cause;
        if (attempt === attempts || !spec.retryable) break;
        await sleep(backoffMs(attempt), options?.signal);
        continue;
      } finally {
        // In a `finally`, because the success path returns from inside the try —
        // releasing after the try/catch leaked the listener on every successful
        // call, which is the common one.
        release();
      }

      // `retryable` is false only for a write that carries no idempotency key and
      // is not replay-safe — `linkCustomer`, whose token the first attempt spends.
      // Retrying that turns an unknown outcome into a definitive
      // LINK_TOKEN_INVALID for a customer who is, in fact, now linked.
      if (isRetryableStatus(response.status) && spec.retryable && attempt < attempts) {
        await sleep(retryAfterMs(response) ?? backoffMs(attempt), options?.signal);
        continue;
      }

      throw await toTrovyError(response);
    }

    throw new TrovyConnectionError(
      `Trovy: could not reach ${this.baseUrl} after ${attempts} attempt${attempts === 1 ? "" : "s"}.`,
      attempts,
      { cause: lastConnectionError }
    );
  }
}

async function toTrovyError(response: Response): Promise<TrovyError> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  let body: TrovyErrorBody;
  try {
    body = (await response.json()) as TrovyErrorBody;
  } catch {
    // A proxy, a gateway or a rate limiter answered instead of the API. Present
    // it in the same shape so a caller's error handling has one path.
    body = { error: `HTTP ${response.status} from ${response.url}`, code: "HTTP_ERROR" };
  }
  if (typeof body?.code !== "string") {
    body = { error: body?.error ?? `HTTP ${response.status}`, code: "HTTP_ERROR" };
  }
  const retryAfter = retryAfterMs(response);
  return new TrovyError(response.status, body, {
    requestId,
    ...(retryAfter !== null ? { retryAfterSeconds: Math.ceil(retryAfter / 1000) } : {}),
  });
}

/**
 * A backoff wait that a caller's abort cuts short.
 *
 * Without the signal, an abort was noticed only at the top of the next attempt: a
 * `Retry-After: 3` made an aborted call settle three seconds later, and with two
 * retries against the 60-second cap a write could sit in a checkout for two
 * minutes after the caller had given up. The README promises an abort stops the
 * SDK; now it stops it promptly rather than eventually.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
