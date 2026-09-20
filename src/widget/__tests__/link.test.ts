import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createMount, type WidgetError, type WidgetHandle } from "../core.js";

const ORIGIN = "http://localhost:3005";
const mount = createMount({ frameOrigins: { live: ORIGIN, test: ORIGIN } });

const LIVE_PK = `trv_pk_live_${"a".repeat(32)}`;
const TEST_PK = `trv_pk_test_${"b".repeat(32)}`;
const TOKEN = "lt_SECRET_TOKEN_VALUE";
const LINK_URL = "/api/trovy/link";

let host: HTMLDivElement;
let fetchMock: Mock<typeof fetch>;
let onError: Mock<(error: WidgetError) => void>;
let onLinked: Mock;
let onStateChange: Mock;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const linkedResponse = () => json(200, { ok: true, customer: { name: "Maria", isNew: true } });
const refused = (status: number, code: string) => json(status, { ok: false, code, message: "fixed text" });

function iframe(): HTMLIFrameElement {
  const el = host.querySelector("iframe");
  if (!el) throw new Error("no iframe mounted");
  return el;
}

/** The frame says the customer verified. */
function verify(pk = LIVE_PK, linkToken = TOKEN) {
  const nonce = new URL(iframe().src).searchParams.get("nonce");
  const event = new MessageEvent("message", {
    data: { trovy: 1, nonce, pk, type: "trovy:success", linkToken, expiresAt: "2026-01-01T00:05:00.000Z", firstName: "Maria" },
  });
  Object.defineProperty(event, "origin", { value: ORIGIN });
  Object.defineProperty(event, "source", { value: iframe().contentWindow });
  window.dispatchEvent(event);
}

function mountLinked(pk = LIVE_PK): WidgetHandle {
  return mount(host, { publishableKey: pk, linkUrl: LINK_URL, onLinked, onError, onStateChange });
}

const states = () => onStateChange.mock.calls.map(([state]) => state);
/** Let everything that is ready to run, run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  onError = vi.fn();
  onLinked = vi.fn();
  onStateChange = vi.fn();
});

afterEach(() => {
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the link request", () => {
  it("goes to the page's own route, once, shaped so that nothing else can receive it", async () => {
    fetchMock.mockResolvedValue(linkedResponse());
    mountLinked();

    verify();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:3000/api/trovy/link");
    expect(init).toMatchObject({
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      // A followed 307 re-posts the body: a sign-in middleware would be sent the token.
      redirect: "manual",
      cache: "no-store",
      keepalive: true,
    });
    expect(init!.headers).toEqual({ "Content-Type": "application/json", "X-Trovy-Link": "1" });
    expect(JSON.parse(init!.body as string)).toEqual({ linkToken: TOKEN, environment: "live" });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("says which environment the form ran in, so a mismatched secret key is caught before the token is spent", async () => {
    fetchMock.mockResolvedValue(linkedResponse());
    mountLinked(TEST_PK);

    verify(TEST_PK);
    await settle();

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).environment).toBe("sandbox");
  });

  it("is sent once however many times the frame announces the success", async () => {
    fetchMock.mockResolvedValue(linkedResponse());
    mountLinked();

    verify();
    verify();
    await settle();
    verify();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onLinked).toHaveBeenCalledTimes(1);
  });
});

describe("a link that works", () => {
  it("moves through linking to linked, and hands the page what it may know", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true, customer: { name: "Maria", isNew: true, id: "cus_leaked" } }));
    const handle = mountLinked();

    verify();
    expect(handle.getState()).toBe("linking");
    await settle();

    expect(states()).toEqual(["ready", "linking", "linked"]);
    // Name and isNew, and nothing else the route might have said: never the id.
    expect(onLinked).toHaveBeenCalledWith({ name: "Maria", isNew: true });
    expect(onError).not.toHaveBeenCalled();
  });

  it("accepts a customer with no name", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true, customer: { name: null, isNew: false } }));
    mountLinked();

    verify();
    await settle();

    expect(onLinked).toHaveBeenCalledWith({ name: null, isNew: false });
  });

  it("never lets the token out: not to a callback, not to the console, not into the DOM", async () => {
    const consoles = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    fetchMock.mockResolvedValueOnce(refused(503, "LINK_UPSTREAM_UNAVAILABLE")).mockResolvedValueOnce(refused(409, "LINK_TOKEN_INVALID"));
    mountLinked();

    verify();
    await vi.advanceTimersByTimeAsync(2_000);

    const said = JSON.stringify([
      onError.mock.calls,
      onLinked.mock.calls,
      onStateChange.mock.calls,
      consoles.map((spy) => spy.mock.calls),
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(said).not.toContain(TOKEN);
    expect(document.documentElement.outerHTML).not.toContain(TOKEN);
  });
});

describe("what each answer means", () => {
  const redirect = () => ({ type: "opaqueredirect", status: 0, json: () => Promise.reject(new Error("opaque")) }) as unknown as Response;
  const html = (status: number) => new Response("<!doctype html><title>Not the route</title>", { status, headers: { "Content-Type": "text/html" } });

  it.each<[string, () => Response, string, string]>([
    ["the route says nobody is signed in", () => refused(401, "LINK_NOT_SIGNED_IN"), "LINK_NOT_SIGNED_IN", "sign-in"],
    ["a bare 401 from something in front of the route", () => html(401), "LINK_NOT_SIGNED_IN", "sign-in"],
    ["the route refuses the request's origin", () => refused(403, "LINK_FORBIDDEN"), "LINK_FORBIDDEN", "developer"],
    ["the route cannot read the body", () => refused(400, "LINK_BAD_REQUEST"), "LINK_BAD_REQUEST", "developer"],
    ["the body is too large", () => refused(413, "LINK_BAD_REQUEST"), "LINK_BAD_REQUEST", "developer"],
    ["the body is not JSON", () => refused(415, "LINK_BAD_REQUEST"), "LINK_BAD_REQUEST", "developer"],
    // A mistyped linkUrl has to read differently from a dead token, or the
    // customer is sent round the form again for a bug in the page.
    ["there is no such route", () => html(404), "LINK_ENDPOINT_INVALID", "developer"],
    ["the route exports no POST", () => html(405), "LINK_ENDPOINT_INVALID", "developer"],
    ["a middleware redirects the route", redirect, "LINK_ENDPOINT_INVALID", "developer"],
    ["a catch-all page answers 200", () => html(200), "LINK_ENDPOINT_INVALID", "developer"],
    ["some other JSON answers 200", () => json(200, { ok: true }), "LINK_ENDPOINT_INVALID", "developer"],
    ["a 200 says ok: false", () => json(200, { ok: false, code: "LINK_TOKEN_INVALID" }), "LINK_ENDPOINT_INVALID", "developer"],
    ["the token is dead", () => refused(409, "LINK_TOKEN_INVALID"), "LINK_TOKEN_INVALID", "verify-again"],
    ["onLinked threw after the customer was linked", () => refused(500, "LINK_SAVE_FAILED"), "LINK_SAVE_FAILED", "verify-again"],
    ["the route is misconfigured", () => refused(500, "LINK_SERVER_ERROR"), "LINK_SERVER_ERROR", "developer"],
    ["the route crashed", () => html(500), "LINK_SERVER_ERROR", "developer"],
    ["a status nobody planned for", () => html(418), "LINK_SERVER_ERROR", "developer"],
    ["a code this version has never heard of", () => json(422, { ok: false, code: "LINK_FROM_THE_FUTURE" }), "LINK_SERVER_ERROR", "developer"],
  ])("%s", async (_name, respond, code, recovery) => {
    fetchMock.mockImplementation(async () => respond());
    const handle = mountLinked();

    verify();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handle.getState()).toBe("link-failed");
    expect(onLinked).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ stage: "link", code, recovery, message: expect.any(String) });
  });

  it("never repeats what a response said", async () => {
    fetchMock.mockResolvedValue(json(500, { ok: false, code: "LINK_SERVER_ERROR", message: "upstream said: key trv_live_… rejected" }));
    mountLinked();

    verify();
    await settle();

    expect(onError.mock.calls[0]![0].message).not.toContain("upstream");
  });
});

describe("trying again", () => {
  it("retries once by itself when the request never got an answer", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(linkedResponse());
    const handle = mountLinked();

    verify();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handle.getState()).toBe("linking");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handle.getState()).toBe("linked");
    expect(onError).not.toHaveBeenCalled();
    // The customer saw one uninterrupted "linking".
    expect(states()).toEqual(["ready", "linking", "linked"]);
  });

  it.each([502, 503, 504, 429])("retries once by itself on a %i", async (status) => {
    fetchMock.mockImplementation(async () => new Response("", { status }));
    const handle = mountLinked();

    verify();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handle.getState()).toBe("link-failed");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "LINK_UPSTREAM_UNAVAILABLE", recovery: "retry" }));
  });

  it("then leaves the third attempt to the customer, and that is the last", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    const handle = mountLinked();
    verify();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(handle.retryLink()).toBe(true);
    expect(handle.getState()).toBe("linking");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // An offer to try again that cannot be honoured is worse than none.
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ code: "LINK_UPSTREAM_UNAVAILABLE", recovery: "verify-again" }));
    expect(handle.retryLink()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("links on a manual retry with the same token", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    const handle = mountLinked();
    verify();
    await vi.advanceTimersByTimeAsync(5_000);

    fetchMock.mockResolvedValue(linkedResponse());
    handle.retryLink();
    await settle();

    expect(handle.getState()).toBe("linked");
    expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string).linkToken).toBe(TOKEN);
  });

  it("stops offering a retry once the token has run out of time", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    const handle = mountLinked();
    verify();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ recovery: "retry" }));

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(handle.retryLink()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The server's clock decides when a token dies, but a phone whose own clock is
  // an hour out must still get its retries: the window is measured locally.
  it("does not judge the token by the frame's expiresAt", async () => {
    vi.setSystemTime(new Date("2031-05-05T12:00:00.000Z"));
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    const handle = mountLinked();

    verify();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handle.retryLink()).toBe(true);
  });

  it("lets a customer who has signed in since try again", async () => {
    fetchMock.mockResolvedValueOnce(refused(401, "LINK_NOT_SIGNED_IN")).mockResolvedValueOnce(linkedResponse());
    const handle = mountLinked();
    verify();
    await settle();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ recovery: "sign-in" }));

    expect(handle.retryLink()).toBe(true);
    await settle();

    expect(handle.getState()).toBe("linked");
  });

  it.each([
    ["a dead token", () => refused(409, "LINK_TOKEN_INVALID")],
    ["a bug in the integration", () => refused(403, "LINK_FORBIDDEN")],
  ])("refuses to resend after %s, and forgets the token", async (_name, respond) => {
    fetchMock.mockImplementation(async () => respond());
    const handle = mountLinked();
    verify();
    await settle();

    expect(handle.retryLink()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is nothing to retry", async () => {
    const handle = mountLinked();
    expect(handle.retryLink()).toBe(false);

    fetchMock.mockResolvedValue(linkedResponse());
    verify();
    expect(handle.retryLink()).toBe(false);
    await settle();
    expect(handle.retryLink()).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("an answer that never arrived", () => {
  // "Already used", after an attempt whose answer was lost, most likely means
  // that attempt worked. Calling the token invalid would be a guess.
  it("reports a dead token as unconfirmed when an earlier attempt may have spent it", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(refused(409, "LINK_TOKEN_INVALID"));
    mountLinked();

    verify();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "LINK_UNCONFIRMED", recovery: "verify-again" }));
  });

  it("does the same after a 502, where Trovy may have answered a connection that then dropped", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 502 })).mockResolvedValueOnce(refused(409, "LINK_TOKEN_INVALID"));
    mountLinked();

    verify();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "LINK_UNCONFIRMED" }));
  });

  it("calls a dead token dead when every earlier answer was a clear no", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(refused(409, "LINK_TOKEN_INVALID"));
    mountLinked();

    verify();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "LINK_TOKEN_INVALID" }));
  });

  it("gives up on a route that says nothing for fifteen seconds, without a second wait", async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const handle = mountLinked();

    verify();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(handle.getState()).toBe("linking");

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "LINK_NETWORK_ERROR", recovery: "retry" }));
  });
});

describe("leaving while the request is out", () => {
  it("says nothing after unmount, and does not abort: aborting does not un-spend a token", async () => {
    let answer!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const handle = mountLinked();
    verify();
    const signal = fetchMock.mock.calls[0]![1]!.signal!;

    handle.unmount();
    answer(linkedResponse());
    await settle();

    expect(signal.aborted).toBe(false);
    expect(onLinked).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(handle.getState()).toBe("unmounted");
  });

  it("ignores the old answer after a reset", async () => {
    let answer!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const handle = mountLinked();
    verify();

    handle.reset();
    answer(refused(409, "LINK_TOKEN_INVALID"));
    await settle();

    expect(handle.getState()).toBe("loading");
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not retry on behalf of a mount that has gone", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const handle = mountLinked();
    verify();
    await settle();

    handle.unmount();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("links a second verification after a reset, with the second token", async () => {
    fetchMock.mockResolvedValueOnce(refused(409, "LINK_TOKEN_INVALID")).mockResolvedValueOnce(linkedResponse());
    const handle = mountLinked();
    verify();
    await settle();

    handle.reset();
    verify(LIVE_PK, "lt_second");
    await settle();

    expect(handle.getState()).toBe("linked");
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).linkToken).toBe("lt_second");
  });
});
