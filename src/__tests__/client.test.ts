import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Trovy } from "../client.js";
import { TrovyConnectionError, TrovyError, isTrovyError } from "../errors.js";

const LIVE_KEY = `trv_live_${"a".repeat(64)}`;
const TEST_KEY = `trv_test_${"b".repeat(64)}`;

/** A `fetch` that answers from a queue, recording every request it was given. */
function stubFetch(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const answer = answers[Math.min(i++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer!;
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const client = (over: Partial<ConstructorParameters<typeof Trovy>[0]> = {}) =>
  new Trovy({ apiKey: TEST_KEY, maxRetries: 0, ...over });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("construction", () => {
  it("sends a live key to production and a test key to the sandbox", () => {
    expect(new Trovy({ apiKey: LIVE_KEY }).baseUrl).toBe("https://api.trovy.ca");
    expect(new Trovy({ apiKey: TEST_KEY }).baseUrl).toBe("https://api.sandbox.trovy.ca");
  });

  it("reports which environment it is talking to", () => {
    expect(new Trovy({ apiKey: LIVE_KEY }).environment).toBe("live");
    expect(new Trovy({ apiKey: TEST_KEY }).environment).toBe("sandbox");
  });

  // A publishable key in server code means someone copied the wrong value out of
  // the dashboard; it would 403 on the first call, so say so before any call.
  it("refuses a publishable key, naming where it belongs", () => {
    expect(() => new Trovy({ apiKey: `trv_pk_live_${"a".repeat(32)}` })).toThrow(TypeError);
    expect(() => new Trovy({ apiKey: `trv_pk_live_${"a".repeat(32)}` })).toThrow(/widget/);
  });

  it("refuses a truncated or empty key without touching the network", () => {
    const { fetch } = stubFetch(json(200, {}));
    expect(() => new Trovy({ apiKey: "trv_live_abc", fetch })).toThrow(TypeError);
    expect(() => new Trovy({ apiKey: "", fetch })).toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("takes an explicit baseUrl and drops a trailing slash", () => {
    expect(new Trovy({ apiKey: TEST_KEY, baseUrl: "http://localhost:3001/" }).baseUrl).toBe(
      "http://localhost:3001"
    );
  });

  it("refuses a negative or fractional maxRetries", () => {
    expect(() => new Trovy({ apiKey: TEST_KEY, maxRetries: -1 })).toThrow(TypeError);
    expect(() => new Trovy({ apiKey: TEST_KEY, maxRetries: 1.5 })).toThrow(TypeError);
  });
});

describe("requests", () => {
  it("sends the key as a bearer token and names itself in the User-Agent", async () => {
    const { fetch, calls } = stubFetch(json(200, { business: { id: "m1" } }));
    await client({ fetch }).business.get();

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe("https://api.sandbox.trovy.ca/v1/business");
    expect(headers["Authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(headers["User-Agent"]).toMatch(/^trovy-sdk-typescript\/\d+\.\d+\.\d+/);
  });

  it("sends no Content-Type on a bodyless call", async () => {
    // The API treats `Content-Type: application/json` with no body as a 400, so
    // a GET must not claim to carry JSON.
    const { fetch, calls } = stubFetch(json(200, { stores: [] }));
    await client({ fetch }).business.listStores();

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("returns the parsed response body", async () => {
    const { fetch } = stubFetch(json(200, { business: { id: "m1", currency: "USD" } }));
    await expect(client({ fetch }).business.get()).resolves.toEqual({
      business: { id: "m1", currency: "USD" },
    });
  });

  it("fills a path parameter and percent-encodes it", async () => {
    const { fetch, calls } = stubFetch(json(200, { rewards: [] }));
    await client({ fetch }).rewards.list("link/1 2");

    expect(calls[0]!.url).toBe("https://api.sandbox.trovy.ca/v1/customers/link%2F1%202/rewards");
  });

  it("refuses an empty path parameter rather than calling a collection endpoint", async () => {
    const { fetch } = stubFetch(json(200, {}));
    await expect(client({ fetch }).rewards.list("")).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("idempotency", () => {
  it("sends the caller's key on a write", async () => {
    const { fetch, calls } = stubFetch(json(201, { earnedCents: 250 }));
    await client({ fetch }).rewards.earn(
      { customerId: "link-1", orderId: "ORD-1", amountCents: 5000 },
      { idempotencyKey: "ORD-1" }
    );

    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("ORD-1");
  });

  it("generates one when the caller does not supply it", async () => {
    const { fetch, calls } = stubFetch(json(201, {}));
    await client({ fetch }).rewards.earn({ customerId: "c", orderId: "o", amountCents: 1 });

    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  // The whole reason the key is computed before the loop: a retried write must
  // replay the first attempt, not apply a second one.
  it("reuses the same key across every retry of one call", async () => {
    const { fetch, calls } = stubFetch(
      json(503, { error: "upstream", code: "UNAVAILABLE" }),
      json(503, { error: "upstream", code: "UNAVAILABLE" }),
      json(201, { earnedCents: 250 })
    );
    await client({ fetch, maxRetries: 2 }).rewards.earn({
      customerId: "c",
      orderId: "o",
      amountCents: 1,
    });

    const keys = calls.map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("sends no key on an operation the API exempts", async () => {
    const { fetch, calls } = stubFetch(json(200, { customer: { id: "link-1" } }));
    await client({ fetch }).customers.link({ linkToken: "t" });

    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  // The API rejects a colon in an idempotency key; catching it here lets the
  // message explain.
  it("refuses a key containing a colon before sending it", async () => {
    const { fetch } = stubFetch(json(201, {}));
    await expect(
      client({ fetch }).rewards.earn(
        { customerId: "c", orderId: "o", amountCents: 1 },
        { idempotencyKey: "order:1" }
      )
    ).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  it("maps an API refusal onto TrovyError with its code and request id", async () => {
    const { fetch } = stubFetch(
      json(
        404,
        { error: "No such customer for your business.", code: "CUSTOMER_NOT_FOUND", requestId: "r1" },
        { "X-Request-Id": "r1" }
      )
    );

    const err = await client({ fetch })
      .rewards.list("link-9")
      .catch((e: unknown) => e);

    expect(isTrovyError(err)).toBe(true);
    const trovyErr = err as TrovyError;
    expect(trovyErr.status).toBe(404);
    expect(trovyErr.code).toBe("CUSTOMER_NOT_FOUND");
    expect(trovyErr.requestId).toBe("r1");
    expect(trovyErr.message).toBe("No such customer for your business.");
  });

  it("falls back to the response header for a request id the body omits", async () => {
    const { fetch } = stubFetch(
      json(401, { error: "Missing key.", code: "API_KEY_MISSING" }, { "X-Request-Id": "r2" })
    );
    const err = (await client({ fetch })
      .business.get()
      .catch((e: unknown) => e)) as TrovyError;

    expect(err.requestId).toBe("r2");
  });

  it("carries field detail from a 400 through", async () => {
    const { fetch } = stubFetch(
      json(400, { error: "Invalid request", code: "VALIDATION_FAILED", details: [{ path: "amountCents" }] })
    );
    const err = (await client({ fetch })
      .rewards.earn({ customerId: "c", orderId: "o", amountCents: -1 })
      .catch((e: unknown) => e)) as TrovyError;

    expect(err.details).toEqual([{ path: "amountCents" }]);
  });

  // A gateway or rate limiter can answer with HTML instead of the API's shape;
  // the caller's error handling must still have one path.
  it("presents a non-JSON failure in the same shape", async () => {
    const { fetch } = stubFetch(new Response("<html>502</html>", { status: 502 }));
    const err = (await client({ fetch })
      .business.get()
      .catch((e: unknown) => e)) as TrovyError;

    expect(isTrovyError(err)).toBe(true);
    expect(err.status).toBe(502);
    expect(err.code).toBe("HTTP_ERROR");
  });

  it("surfaces a 429's Retry-After instead of sleeping through it", async () => {
    const { fetch, calls } = stubFetch(
      json(429, { error: "Too many requests", code: "RATE_LIMITED" }, { "Retry-After": "30" })
    );
    const err = (await client({ fetch, maxRetries: 2 })
      .business.get()
      .catch((e: unknown) => e)) as TrovyError;

    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(30);
    // One attempt: a rate limit is the caller's to pace, not the SDK's to hide.
    expect(calls).toHaveLength(1);
  });
});

describe("retries", () => {
  it("retries a 500 and returns the eventual success", async () => {
    const { fetch, calls } = stubFetch(
      json(500, { error: "boom", code: "INTERNAL" }),
      json(200, { stores: [{ id: "s1" }] })
    );
    await expect(client({ fetch, maxRetries: 2 }).business.listStores()).resolves.toEqual({
      stores: [{ id: "s1" }],
    });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 501, which will not become implemented", async () => {
    const { fetch, calls } = stubFetch(json(501, { error: "nope", code: "NOT_IMPLEMENTED" }));
    await expect(client({ fetch, maxRetries: 3 }).business.get()).rejects.toThrow(TrovyError);
    expect(calls).toHaveLength(1);
  });

  it.each([400, 401, 403, 404, 409, 422])("does not retry a %i", async (status) => {
    const { fetch, calls } = stubFetch(json(status, { error: "no", code: "NOPE" }));
    await expect(client({ fetch, maxRetries: 3 }).business.get()).rejects.toThrow(TrovyError);
    expect(calls).toHaveLength(1);
  });

  it("retries a network failure and gives up as a connection error", async () => {
    const { fetch, calls } = stubFetch(new TypeError("fetch failed"));
    const err = (await client({ fetch, maxRetries: 2 })
      .business.get()
      .catch((e: unknown) => e)) as TrovyConnectionError;

    expect(err).toBeInstanceOf(TrovyConnectionError);
    expect(err.attempts).toBe(3);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(3);
  });

  it("makes exactly one attempt when retries are off", async () => {
    const { fetch, calls } = stubFetch(new TypeError("fetch failed"));
    await expect(client({ fetch, maxRetries: 0 }).business.get()).rejects.toThrow(
      TrovyConnectionError
    );
    expect(calls).toHaveLength(1);
  });

  it("honours Retry-After on a 503 rather than its own backoff", async () => {
    const { fetch, calls } = stubFetch(
      json(503, { error: "draining", code: "UNAVAILABLE" }, { "Retry-After": "1" }),
      json(200, { business: { id: "m1" } })
    );
    await expect(client({ fetch, maxRetries: 1 }).business.get()).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  // The caller asked to stop. Retrying would ignore them, and on a write it
  // would keep spending the idempotency key they have already abandoned.
  it("stops immediately when the caller aborts", async () => {
    const controller = new AbortController();
    const { fetch, calls } = stubFetch(new DOMException("Aborted", "AbortError"));
    controller.abort();

    await expect(
      client({ fetch, maxRetries: 3 }).business.get({ signal: controller.signal })
    ).rejects.toThrow();
    // Aborted before the first attempt, so nothing was sent at all.
    expect(calls).toHaveLength(0);
  });

  it("does not retry after an abort lands mid-flight", async () => {
    const controller = new AbortController();
    const { fetch, calls } = stubFetch(
      new (class extends Error {
        name = "AbortError";
      })("aborted")
    );
    const pending = client({ fetch, maxRetries: 3 }).business.get({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
