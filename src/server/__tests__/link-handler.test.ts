import { afterEach, describe, expect, it, vi } from "vitest";
import { TrovyConnectionError, TrovyError } from "../../errors.js";
import { createLinkHandler, type LinkHandlerOptions } from "../link-handler.js";

const SECRET = `trv_test_${"a".repeat(64)}`;
const TOKEN = "lt_SECRET_TOKEN_VALUE";
const URL_ = "https://shop.example/api/trovy/link";
const CUSTOMER = { id: "cus_123", name: "Maria", isNew: true };

const OWN_PAGE = {
  "content-type": "application/json",
  "x-trovy-link": "1",
  "sec-fetch-site": "same-origin",
};

function request(over: { method?: string; headers?: Record<string, string>; body?: BodyInit | null } = {}): Request {
  const method = over.method ?? "POST";
  return new Request(URL_, {
    method,
    headers: over.headers ?? OWN_PAGE,
    ...(method === "GET"
      ? {}
      : { body: over.body === undefined ? JSON.stringify({ linkToken: TOKEN, environment: "sandbox" }) : over.body }),
  });
}

function setup(over: Partial<LinkHandlerOptions> = {}) {
  const calls: string[] = [];
  const link = vi.fn(async (_body: { linkToken: string }, _options?: { timeoutMs?: number }) => {
    calls.push("link");
    return { customer: CUSTOMER };
  });
  const getUser = vi.fn(async (_request: Request): Promise<string | null> => {
    calls.push("getUser");
    return "user_1";
  });
  const onLinked = vi.fn(async () => {
    calls.push("onLinked");
  });
  const onError = vi.fn();
  const handler = createLinkHandler({
    trovy: { environment: "sandbox", customers: { link } },
    getUser,
    onLinked,
    onError,
    ...over,
  });
  return { handler, link, getUser, onLinked, onError, calls };
}

const body = (response: Response) => response.json() as Promise<Record<string, unknown>>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a link that works", () => {
  it("asks who the user is, THEN spends the token, then saves", async () => {
    const { handler, calls, link, onLinked } = setup();

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(calls).toEqual(["getUser", "link", "onLinked"]);
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith({ linkToken: TOKEN }, { timeoutMs: 8_000 });
    expect(onLinked).toHaveBeenCalledWith({ userId: "user_1", customer: CUSTOMER, request: expect.any(Request) });
  });

  it("tells the browser the name and whether they are new, and never the customer id", async () => {
    const { handler } = setup();

    const response = await handler(request());

    expect(await body(response)).toEqual({ ok: true, customer: { name: "Maria", isNew: true } });
  });

  it("hands getUser a request it can still read", async () => {
    const seen: unknown[] = [];
    const { handler } = setup({
      getUser: async (incoming) => {
        seen.push(await incoming.json());
        return "user_1";
      },
    });

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ linkToken: TOKEN, environment: "sandbox" }]);
  });

  // The protocol only grows: a newer component may say more than this version knows.
  it("ignores fields it does not know", async () => {
    const { handler } = setup();

    const response = await handler(
      request({ body: JSON.stringify({ linkToken: TOKEN, environment: "sandbox", clientReference: "later", v: 2 }) }),
    );

    expect(response.status).toBe(200);
  });

  it("accepts a caller that does not say which environment it ran in", async () => {
    const { handler } = setup();

    const response = await handler(request({ body: JSON.stringify({ linkToken: TOKEN }) }));

    expect(response.status).toBe(200);
  });

  it("uses the secret key against the API the key belongs to", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ customer: CUSTOMER }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { handler } = setup({ trovy: undefined, secretKey: SECRET });

    const response = await handler(request());

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.sandbox.trovy.ca/v1/customers/link");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body as string)).toEqual({ linkToken: TOKEN });
  });
});

describe("who may call it", () => {
  it("answers only POST", async () => {
    const { handler, calls } = setup();

    const response = await handler(request({ method: "GET" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(calls).toEqual([]);
  });

  // The header cannot be added to a cross-site form post, and adding it to a
  // cross-site fetch needs a preflight this route never answers.
  it.each([
    ["absent", {}],
    ["wrong", { "x-trovy-link": "yes" }],
  ])("refuses a request whose X-Trovy-Link is %s", async (_name, header) => {
    const { handler, calls } = setup();

    const response = await handler(
      request({ headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...header } }),
    );

    expect(response.status).toBe(403);
    expect((await body(response)).code).toBe("LINK_FORBIDDEN");
    expect(calls).toEqual([]);
  });

  const base = { "content-type": "application/json", "x-trovy-link": "1" };

  it.each<[string, Record<string, string>, number]>([
    ["fetch metadata says same-origin", { "sec-fetch-site": "same-origin" }, 200],
    ["no fetch metadata, Origin names the host the route was reached on", { origin: "https://shop.example", host: "shop.example" }, 200],
    ["a proxy rewrote Host and said so", { origin: "https://shop.example", host: "internal:3000", "x-forwarded-host": "shop.example" }, 200],
    ["a chain of proxies: the first forwarded host is the public one", { origin: "https://shop.example", host: "internal:3000", "x-forwarded-host": "shop.example, edge.internal" }, 200],
    ["a port is part of the host", { origin: "http://localhost:3000", host: "localhost:3000" }, 200],
    ["neither header: not a browser, so not a forged one", {}, 200],
    ["a cross-site page", { "sec-fetch-site": "cross-site", origin: "https://evil.example", host: "shop.example" }, 403],
    ["a sibling subdomain", { "sec-fetch-site": "same-site", origin: "https://blog.shop.example", host: "shop.example" }, 403],
    ["Origin names another host", { origin: "https://evil.example", host: "shop.example" }, 403],
    ["Origin names another port", { origin: "http://localhost:3001", host: "localhost:3000" }, 403],
    ["Origin is a look-alike", { origin: "https://shop.example.evil.example", host: "shop.example" }, 403],
    ["a sandboxed frame", { origin: "null", host: "shop.example" }, 403],
    ["a browser that says cross-site and hides its Origin", { "sec-fetch-site": "cross-site" }, 403],
    ["a user-initiated navigation", { "sec-fetch-site": "none" }, 403],
    ["Origin with no host to compare it to", { origin: "https://shop.example" }, 403],
  ])("%s", async (_name, headers, status) => {
    const { handler, link } = setup();

    const response = await handler(request({ headers: { ...base, ...headers } }));

    expect(response.status).toBe(status);
    expect(link).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  });

  it("lets a listed origin through when the route cannot see its own public host", async () => {
    const { handler } = setup({ allowedOrigins: ["https://shop.example"] });

    const response = await handler(
      request({ headers: { ...base, origin: "https://shop.example", host: "internal:3000" } }),
    );

    expect(response.status).toBe(200);
  });
});

describe("what it will read", () => {
  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""])(
    "refuses a %j body: a form post needs no preflight",
    async (contentType) => {
      const { handler, calls } = setup();

      const response = await handler(
        request({ headers: { ...OWN_PAGE, "content-type": contentType } }),
      );

      expect(response.status).toBe(415);
      expect(calls).toEqual([]);
    },
  );

  it("accepts a charset on the content type", async () => {
    const { handler } = setup();

    const response = await handler(request({ headers: { ...OWN_PAGE, "content-type": "application/json; charset=utf-8" } }));

    expect(response.status).toBe(200);
  });

  const padded = JSON.stringify({ linkToken: TOKEN, padding: "x".repeat(4_000) });

  it("refuses a large body by its declared length, without reading any of it", async () => {
    const { handler, calls } = setup();
    const incoming = request({ headers: { ...OWN_PAGE, "content-length": String(padded.length) }, body: padded });

    const response = await handler(incoming);

    expect(response.status).toBe(413);
    expect(incoming.bodyUsed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a large body that declared a small one", async () => {
    const { handler, calls } = setup();

    const response = await handler(request({ headers: { ...OWN_PAGE, "content-length": "64" }, body: padded }));

    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("reads a body of exactly the limit", async () => {
    const { handler } = setup();
    const exact = JSON.stringify({ linkToken: TOKEN, padding: "" });
    const filled = JSON.stringify({ linkToken: TOKEN, padding: "x".repeat(2_048 - exact.length) });
    expect(filled.length).toBe(2_048);

    expect((await handler(request({ body: filled }))).status).toBe(200);
    expect((await handler(request({ body: filled.replace('"}', 'x"}') }))).status).toBe(413);
  });

  // Content-Length is a hint. A streamed body has none, and a hostile one lies.
  it("refuses a large body that never declared a length, without reading all of it", async () => {
    const { handler, calls } = setup();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 50) return controller.close();
        controller.enqueue(new TextEncoder().encode("x".repeat(1_000)));
      },
    });
    const streamed = new Request(URL_, { method: "POST", headers: OWN_PAGE, body: stream, duplex: "half" } as RequestInit);
    expect(streamed.headers.get("content-length")).toBeNull();

    const response = await handler(streamed);

    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(calls).toEqual([]);
  });

  it.each([
    ["not JSON", "linkToken=abc"],
    ["JSON that is not an object", JSON.stringify("lt_abc")],
    ["null", "null"],
    ["no token", JSON.stringify({ environment: "sandbox" })],
    ["an empty token", JSON.stringify({ linkToken: "" })],
    ["a token that is not a string", JSON.stringify({ linkToken: 42 })],
    ["a token longer than any real one", JSON.stringify({ linkToken: "x".repeat(201) })],
    ["an environment that is not one of the two", JSON.stringify({ linkToken: TOKEN, environment: "production\nforged log line" })],
    ["nothing at all", ""],
  ])("refuses %s", async (_name, raw) => {
    const { handler, calls } = setup();

    const response = await handler(request({ body: raw }));

    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe("LINK_BAD_REQUEST");
    expect(calls).toEqual([]);
  });
});

describe("the secret key", () => {
  // A build evaluates the route module with no secrets set.
  it("may be undefined when the handler is created", () => {
    expect(() => createLinkHandler({ secretKey: undefined, getUser: () => null, onLinked: () => {} })).not.toThrow();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["malformed", "trv_test_nope"],
    ["a publishable key", `trv_pk_test_${"b".repeat(32)}`],
  ])("fails the request, not the import, when it is %s", async (_name, secretKey) => {
    const { handler, calls, onError } = setup({ trovy: undefined, secretKey });

    const response = await handler(request());

    expect(response.status).toBe(500);
    expect((await body(response)).code).toBe("LINK_SERVER_ERROR");
    expect(calls).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ stage: "config", code: "LINK_SERVER_ERROR" }));
  });

  // A test form with a live key can only fail, and would spend a token finding out.
  it("refuses a form that ran in the other environment before anything is spent", async () => {
    const { handler, calls, onError } = setup();

    const response = await handler(request({ body: JSON.stringify({ linkToken: TOKEN, environment: "live" }) }));

    expect(response.status).toBe(500);
    expect(calls).toEqual([]);
    expect(String(onError.mock.calls[0]![0].error)).toMatch(/live publishable key.*sandbox secret key/);
  });
});

describe("getUser", () => {
  it.each([null, undefined, ""])("answers 401 for %j and leaves the token unspent", async (nobody) => {
    const { handler, link, onError } = setup({ getUser: () => nobody as null });

    const response = await handler(request());

    expect(response.status).toBe(401);
    expect((await body(response)).code).toBe("LINK_NOT_SIGNED_IN");
    expect(link).not.toHaveBeenCalled();
    // Ordinary traffic, not a fault.
    expect(onError).not.toHaveBeenCalled();
  });

  it("answers 500 when it throws, and leaves the token unspent", async () => {
    const boom = new Error("session store down");
    const { handler, link, onError } = setup({
      getUser: () => {
        throw boom;
      },
    });

    const response = await handler(request());

    expect(response.status).toBe(500);
    expect(link).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith({ stage: "getUser", code: "LINK_SERVER_ERROR", error: boom });
  });

  it("refuses an id that is not a string rather than saving against it", async () => {
    const { handler, link, onLinked } = setup({ getUser: () => 42 as never });

    const response = await handler(request());

    expect(response.status).toBe(500);
    expect(link).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
  });
});

describe("what Trovy answers", () => {
  const apiError = (status: number, code: string, retryAfterSeconds?: number) =>
    new TrovyError(status, { error: "upstream text that must not travel", code, requestId: "req_1" }, { retryAfterSeconds });

  it.each<[string, () => unknown, number, string, boolean]>([
    // 409, not Trovy's 404: the component has to tell a dead token from a mistyped linkUrl.
    ["a dead token", () => apiError(404, "LINK_TOKEN_INVALID"), 409, "LINK_TOKEN_INVALID", false],
    ["a token the API cannot parse", () => apiError(400, "VALIDATION_ERROR"), 409, "LINK_TOKEN_INVALID", false],
    ["a revoked key", () => apiError(401, "API_KEY_REVOKED"), 500, "LINK_SERVER_ERROR", true],
    ["an API that is not enabled", () => apiError(403, "API_NOT_ENABLED"), 500, "LINK_SERVER_ERROR", true],
    ["a rate limit", () => apiError(429, "RATE_LIMITED", 7), 503, "LINK_UPSTREAM_UNAVAILABLE", false],
    ["a Trovy outage", () => apiError(503, "INTERNAL_ERROR"), 502, "LINK_UPSTREAM_UNAVAILABLE", true],
    ["no answer at all", () => new TrovyConnectionError("timed out", 1), 502, "LINK_UPSTREAM_UNAVAILABLE", true],
    ["something nobody planned for", () => new Error("bug"), 500, "LINK_SERVER_ERROR", true],
  ])("%s", async (_name, thrown, status, code, reported) => {
    const error = thrown();
    const { handler, onLinked, onError } = setup({
      trovy: { environment: "sandbox", customers: { link: vi.fn().mockRejectedValue(error) } },
    });

    const response = await handler(request());
    const answered = await body(response);

    expect(response.status).toBe(status);
    expect(answered.code).toBe(code);
    expect(JSON.stringify(answered)).not.toContain("upstream text");
    expect(onLinked).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(reported ? 1 : 0);
    if (reported) expect(onError).toHaveBeenCalledWith({ stage: "link", code, error, userId: "user_1" });
  });

  it("passes a rate limit's wait on, within reason", async () => {
    const wait = async (seconds: number | undefined) => {
      const { handler } = setup({
        trovy: { environment: "sandbox", customers: { link: vi.fn().mockRejectedValue(apiError(429, "RATE_LIMITED", seconds)) } },
      });
      return (await handler(request())).headers.get("retry-after");
    };

    expect(await wait(7)).toBe("7");
    expect(await wait(0.2)).toBe("1");
    expect(await wait(86_400)).toBe("60");
    expect(await wait(undefined)).toBe("1");
  });

  // Two copies of this package in one tree: `instanceof` would miss this one.
  it("recognises an error thrown by another copy of the client", async () => {
    const foreign = Object.assign(new Error("dead"), { name: "TrovyError", status: 404, code: "LINK_TOKEN_INVALID" });
    const { handler } = setup({
      trovy: { environment: "sandbox", customers: { link: vi.fn().mockRejectedValue(foreign) } },
    });

    expect((await handler(request())).status).toBe(409);
  });
});

describe("onLinked", () => {
  it("answers LINK_SAVE_FAILED when it throws, and says what it was given so it can be repaired", async () => {
    const boom = new Error("database down");
    const { handler, onError } = setup({
      onLinked: () => {
        throw boom;
      },
    });

    const response = await handler(request());

    expect(response.status).toBe(500);
    expect((await body(response)).code).toBe("LINK_SAVE_FAILED");
    expect(onError).toHaveBeenCalledWith({
      stage: "onLinked",
      code: "LINK_SAVE_FAILED",
      error: boom,
      userId: "user_1",
      customer: CUSTOMER,
    });
  });
});

describe("what it never says", () => {
  it("marks every answer uncacheable, as JSON", async () => {
    const { handler } = setup();
    const answers = await Promise.all([
      handler(request()),
      handler(request({ method: "GET" })),
      handler(request({ headers: { "content-type": "application/json" } })),
      handler(request({ body: "nope" })),
    ]);

    for (const response of answers) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("application/json");
    }
  });

  it("keeps the token and the key out of every answer, report and log line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const reports: unknown[] = [];
    const outcomes = [
      () => Promise.reject(new TrovyError(404, { error: "no", code: "LINK_TOKEN_INVALID" })),
      () => Promise.reject(new TrovyError(401, { error: "no", code: "API_KEY_REVOKED" })),
      () => Promise.reject(new TrovyConnectionError("timed out", 1)),
      () => Promise.resolve({ customer: CUSTOMER }),
    ];

    const said: string[] = [];
    for (const outcome of outcomes) {
      for (const onError of [undefined, (failure: unknown) => void reports.push(failure)]) {
        const handler = createLinkHandler({
          trovy: { environment: "sandbox", customers: { link: outcome } },
          getUser: () => "user_1",
          onLinked: () => {
            throw new Error("save failed");
          },
          onError,
        });
        said.push(await (await handler(request())).text());
      }
    }
    const misconfigured = createLinkHandler({ secretKey: `trv_test_${"z".repeat(64)}`, getUser: () => "u", onLinked: () => {} });
    said.push(await (await misconfigured(request())).text());

    const everything = [said, reports.map((r) => [r, String((r as { error: unknown }).error)]), log.mock.calls.map((c) => c.map(String))];
    expect(JSON.stringify(everything)).not.toContain(TOKEN);
    expect(JSON.stringify(everything)).not.toContain("zzzz");
    expect(log).toHaveBeenCalled();
  });

  it("answers the same whether or not the reporter itself throws", async () => {
    const { handler } = setup({
      onLinked: () => {
        throw new Error("save failed");
      },
      onError: () => {
        throw new Error("reporter down");
      },
    });

    const response = await handler(request());

    expect(response.status).toBe(500);
    expect((await body(response)).code).toBe("LINK_SAVE_FAILED");
  });
});

describe("mistakes in the code fail where a build shows them", () => {
  it.each<[string, unknown]>([
    ["no options", undefined],
    ["no getUser", { secretKey: SECRET, onLinked: () => {} }],
    ["no onLinked", { secretKey: SECRET, getUser: () => null }],
    ["both a key and a client", { secretKey: SECRET, trovy: { environment: "sandbox", customers: { link: vi.fn() } }, getUser: () => null, onLinked: () => {} }],
  ])("%s", (_name, options) => {
    expect(() => createLinkHandler(options as LinkHandlerOptions)).toThrow(TypeError);
  });
});
