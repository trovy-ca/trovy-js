import { describe, it, expect, vi } from "vitest";
import { Trovy } from "../client.js";
import { TrovyConnectionError, TrovyError, isTrovyError } from "../errors.js";
import { OPERATIONS } from "../operations.js";

/**
 * Regressions. Each test names the defect it pins. They are grouped separately
 * from `client.test.ts` so the list reads as what it is: the things a careful
 * reading caught that the first pass of tests did not think to ask.
 */

const TEST_KEY = `trv_test_${"b".repeat(64)}`;

function stubFetch(...answers: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const answer = answers[Math.min(i++, answers.length - 1)];
    if (typeof answer === "function") return answer();
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

const EARN = { customerId: "cus_1", orderId: "ORD-1", amountCents: 5000 };

describe("a backoff wait is abortable", () => {
  // Before: `sleep` ignored the signal and the abort was only noticed at the top
  // of the next attempt, so a `Retry-After: 3` made an aborted call settle three
  // seconds later. Against the 60-second cap, a write could sit in a checkout for
  // two minutes after the caller gave up — while the README promised it stopped.
  it("rejects promptly instead of waiting the Retry-After out", async () => {
    const { fetch } = stubFetch(
      json(503, { error: "draining", code: "UNAVAILABLE" }, { "Retry-After": "30" })
    );
    const controller = new AbortController();
    const started = Date.now();

    const pending = client({ fetch, maxRetries: 2 }).rewards.earn(EARN, {
      idempotencyKey: "ORD-1",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toBeDefined();
    // Nowhere near the 30 seconds the header asked for.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects with the caller's own reason, not a Trovy error", async () => {
    const { fetch } = stubFetch(
      json(503, { error: "draining", code: "UNAVAILABLE" }, { "Retry-After": "30" })
    );
    const controller = new AbortController();
    const reason = new Error("shutting down");

    const pending = client({ fetch, maxRetries: 2 }).business.get({ signal: controller.signal });
    setTimeout(() => controller.abort(reason), 20);

    await expect(pending).rejects.toBe(reason);
  });

  it("stops retrying once aborted, rather than making the remaining attempts", async () => {
    const { fetch, calls } = stubFetch(
      json(503, { error: "draining", code: "UNAVAILABLE" }, { "Retry-After": "5" })
    );
    const controller = new AbortController();

    const pending = client({ fetch, maxRetries: 3 }).business.get({ signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });
});

describe("a 2xx whose body is unusable", () => {
  // Before: the success-path `response.json()` sat outside the try, so a proxy
  // answering 200 with HTML threw a raw SyntaxError that escaped both error
  // classes and skipped the retry entirely.
  it("is a Trovy error, not a raw SyntaxError", async () => {
    const { fetch } = stubFetch(
      new Response("<html>ok</html>", { status: 200, headers: { "Content-Type": "text/html" } })
    );

    const err = await client({ fetch })
      .rewards.earn(EARN, { idempotencyKey: "ORD-1" })
      .catch((e: unknown) => e);

    expect(isTrovyError(err) || err instanceof TrovyConnectionError).toBe(true);
    expect(err).not.toBeInstanceOf(SyntaxError);
  });

  // The case that matters most: the body read is cut short by this attempt's own
  // timeout. The write may well have landed, so it has to be retryable.
  it("is retried when the read fails midway", async () => {
    let call = 0;
    const { fetch, calls } = stubFetch(async () => {
      call += 1;
      if (call === 1) {
        return new Response("{ truncated", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json(201, { replayed: false, earnedCents: 300 });
    });

    const result = await client({ fetch, maxRetries: 2 }).rewards.earn(EARN, {
      idempotencyKey: "ORD-1",
    });

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ earnedCents: 300 });
  });

  it("carries the same idempotency key into that retry", async () => {
    let call = 0;
    const { fetch, calls } = stubFetch(async () => {
      call += 1;
      if (call === 1) return new Response("not json", { status: 200 });
      return json(201, { earnedCents: 300 });
    });

    await client({ fetch, maxRetries: 1 }).rewards.earn(EARN, { idempotencyKey: "ORD-1" });

    const keys = calls.map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys).toEqual(["ORD-1", "ORD-1"]);
  });

  // Before: an empty 2xx returned `undefined` cast to the result type, which
  // surfaced as a TypeError on the caller's first property access.
  it("an empty 2xx body is an error, not undefined", async () => {
    // A 200 with nothing in it, which is what a gateway or a misconfigured proxy
    // actually sends. (A real 204 cannot even be constructed with a body.)
    const { fetch } = stubFetch(new Response(null, { status: 200 }));

    const err = await client({ fetch })
      .business.get()
      .catch((e: unknown) => e);

    expect(isTrovyError(err)).toBe(true);
    expect((err as TrovyError).code).toBe("HTTP_ERROR");
  });
});

describe("idempotency keys are checked the way the API checks them", () => {
  // Before: only ":" was rejected, so a Shopify order name went out verbatim and
  // was a 400 at checkout — while the README told partners to use their order id.
  it.each(["#1001", "ORD/2026/01", "key with space", "a".repeat(129), "order:1"])(
    "refuses %j before sending",
    async (key) => {
      const { fetch } = stubFetch(json(201, {}));

      await expect(
        client({ fetch }).rewards.earn(EARN, { idempotencyKey: key })
      ).rejects.toThrow(TypeError);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each(["ORD-10233", "order_1.2", "a", "A1-_."])("accepts %j", async (key) => {
    const { fetch, calls } = stubFetch(json(201, { earnedCents: 0 }));

    await client({ fetch }).rewards.earn(EARN, { idempotencyKey: key });

    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(key);
  });

  // An empty string almost always means an upstream value was missing. Sending it
  // is a guaranteed 400; generating one is the same behaviour as omitting it.
  it.each(["", "   "])("treats %j as absent and generates one", async (key) => {
    const { fetch, calls } = stubFetch(json(201, { earnedCents: 0 }));

    await client({ fetch }).rewards.earn(EARN, { idempotencyKey: key });

    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-/
    );
  });

  it("trims a key rather than sending the whitespace", async () => {
    const { fetch, calls } = stubFetch(json(201, { earnedCents: 0 }));

    await client({ fetch }).rewards.earn(EARN, { idempotencyKey: "  ORD-1  " });

    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("ORD-1");
  });
});

describe("Retry-After that asks for no wait", () => {
  // Before: "-5" failed the seconds branch, then Date.parse("-5") resolved to a
  // date in 2001, so `max(0, past - now)` was 0 and the retries ran in a hot loop.
  it.each(["-5", "0", "Thu, 01 Jan 2001 00:00:00 GMT"])(
    "falls back to backoff for %j rather than retrying instantly",
    async (header) => {
      const { fetch, calls } = stubFetch(
        json(503, { error: "nope", code: "UNAVAILABLE" }, { "Retry-After": header })
      );
      const started = Date.now();

      await expect(client({ fetch, maxRetries: 2 }).business.get()).rejects.toBeInstanceOf(
        TrovyError
      );

      expect(calls).toHaveLength(3);
      // Two jittered backoffs, each up to 500ms and 1000ms. Zero would mean the
      // header had removed the backoff entirely.
      expect(Date.now() - started).toBeGreaterThan(0);
    }
  );

  it("still honours a positive Retry-After", async () => {
    const { fetch, calls } = stubFetch(
      json(503, { error: "nope", code: "UNAVAILABLE" }, { "Retry-After": "1" }),
      json(200, { business: { id: "m1" } })
    );

    await expect(client({ fetch, maxRetries: 1 }).business.get()).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
  });
});

describe("a write with no idempotency key is not retried for us", () => {
  // linkCustomer's token is spent by the first attempt, so a retry reports
  // LINK_TOKEN_INVALID for a customer who is in fact now linked. The partner has
  // to decide that one — only they know whether to re-run the widget.
  it("makes one attempt at linkCustomer on a 5xx", async () => {
    const { fetch, calls } = stubFetch(json(500, { error: "boom", code: "INTERNAL" }));

    await expect(client({ fetch, maxRetries: 3 }).customers.link({ linkToken: "lt" })).rejects.toThrow(
      TrovyError
    );
    expect(calls).toHaveLength(1);
  });

  it("makes one attempt at linkCustomer on a network failure", async () => {
    const { fetch, calls } = stubFetch(new TypeError("fetch failed"));

    await expect(
      client({ fetch, maxRetries: 3 }).customers.link({ linkToken: "lt" })
    ).rejects.toThrow(TrovyConnectionError);
    expect(calls).toHaveLength(1);
  });

  it("still retries the reads and the keyed writes", async () => {
    const { fetch, calls } = stubFetch(
      json(500, { error: "boom", code: "INTERNAL" }),
      json(200, { linked: false })
    );

    await client({ fetch, maxRetries: 2 }).customers.lookup({ phone: "+14165550100" });

    expect(calls).toHaveLength(2);
  });

  it("marks exactly one operation unretryable, and names it", () => {
    const unretryable = Object.entries(OPERATIONS)
      .filter(([, spec]) => !spec.retryable)
      .map(([id]) => id);

    expect(unretryable).toEqual(["linkCustomer"]);
  });

  // Every keyed write must be retryable: the key is what makes it safe, and not
  // retrying would waste the protection.
  it("retries every write that carries a key", () => {
    for (const [id, spec] of Object.entries(OPERATIONS)) {
      if (spec.idempotent) expect(spec.retryable, id).toBe(true);
    }
  });
});

describe("a caller's signal is not leaked across attempts", () => {
  // Before: AbortSignal.any registered a dependent on the caller's signal per
  // attempt and nothing removed it, so one long-lived application signal passed to
  // every call accumulated dependents — 480MB over 200,000 calls.
  it("leaves no abort listeners on a shared signal", async () => {
    // A factory, because a Response body can only be read once and this makes
    // five calls.
    const { fetch } = stubFetch(async () => json(200, { business: { id: "m1" } }));
    const controller = new AbortController();
    const added: string[] = [];
    const removed: string[] = [];
    const original = {
      add: controller.signal.addEventListener.bind(controller.signal),
      remove: controller.signal.removeEventListener.bind(controller.signal),
    };
    controller.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (original.add as unknown as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (original.remove as unknown as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof controller.signal.removeEventListener;

    const trovy = client({ fetch });
    for (let i = 0; i < 5; i++) {
      await trovy.business.get({ signal: controller.signal });
    }

    expect(added.filter((t) => t === "abort")).toHaveLength(5);
    expect(removed.filter((t) => t === "abort")).toHaveLength(5);
  });

  it("releases the listener on a failure path too", async () => {
    const { fetch } = stubFetch(json(404, { error: "no", code: "NOT_FOUND" }));
    const controller = new AbortController();
    let removals = 0;
    const original = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = ((...a: unknown[]) => {
      removals += 1;
      return (original as unknown as (...x: unknown[]) => void)(...a);
    }) as typeof controller.signal.removeEventListener;

    await expect(
      client({ fetch }).business.get({ signal: controller.signal })
    ).rejects.toThrow(TrovyError);

    expect(removals).toBeGreaterThan(0);
  });
});

describe("key validation names the key someone actually pasted", () => {
  it("says a publishable key belongs in the widget", () => {
    expect(() => new Trovy({ apiKey: `trv_pk_live_${"a".repeat(32)}` })).toThrow(/widget/);
  });
});

describe("an unsubstituted path parameter never reaches the wire", () => {
  it("throws rather than requesting a literal brace", async () => {
    const { fetch } = stubFetch(json(200, {}));
    // Reaching this needs the template and the call to disagree, which the
    // operations test prevents — so it is driven directly.
    const trovy = client({ fetch }) as unknown as {
      rewards: { list: (id: string) => Promise<unknown> };
    };
    const spec = OPERATIONS.listCustomerRewards as { path: string };
    const original = spec.path;
    Object.defineProperty(spec, "path", { value: "/v1/customers/{customerId}/rewards" });

    try {
      await expect(trovy.rewards.list("cus_1")).rejects.toThrow(/unsubstituted/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(spec, "path", { value: original });
    }
  });
});
