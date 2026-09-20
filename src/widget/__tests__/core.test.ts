import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMount, isTrovyConfigError, TrovyConfigError } from "../core.js";

// Loopback origins stand in for the frame host: `createMount` accepts nothing
// else that is not Trovy's own, and two different ones prove which key goes where.
const LIVE_ORIGIN = "http://localhost:3005";
const TEST_ORIGIN = "http://127.0.0.1:3006";
const mount = createMount({ frameOrigins: { live: LIVE_ORIGIN, test: TEST_ORIGIN } });

const LIVE_PK = `trv_pk_live_${"a".repeat(32)}`;
const TEST_PK = `trv_pk_test_${"b".repeat(32)}`;
const noop = () => {};

let host: HTMLDivElement;

function iframe(): HTMLIFrameElement {
  const el = host.querySelector("iframe");
  if (!el) throw new Error("no iframe mounted");
  return el;
}

function frameUrl(): URL {
  return new URL(iframe().src);
}

function nonce(): string | null {
  return frameUrl().searchParams.get("nonce");
}

/**
 * Deliver a message as the browser would, with an origin and source we control.
 * `source` has to be the iframe's `contentWindow` for the loader to accept it,
 * and jsdom gives us a real one.
 */
function post(data: unknown, over: { origin?: string; source?: unknown } = {}) {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "origin", { value: over.origin ?? LIVE_ORIGIN });
  Object.defineProperty(event, "source", {
    value: "source" in over ? over.source : iframe().contentWindow,
  });
  window.dispatchEvent(event);
}

const success = (over: Record<string, unknown> = {}) => ({
  trovy: 1,
  nonce: nonce(),
  pk: LIVE_PK,
  type: "trovy:success",
  linkToken: "lt_abc",
  expiresAt: "2026-09-13T10:05:00.000Z",
  ...over,
});

beforeEach(() => {
  host = document.createElement("div");
  host.id = "trovy-widget";
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createMount only binds to Trovy's own frame host", () => {
  it.each([
    "https://js.trovy.ca",
    "https://js.preview.trovy.ca",
    "http://localhost:3005",
    "http://127.0.0.1:3005",
    "http://[::1]:3005",
    "http://localhost",
  ])("accepts %s", (origin) => {
    expect(() => createMount({ frameOrigins: { live: origin, test: origin } })).not.toThrow();
  });

  // Each of these is a way to put a phone-number form the customer trusts on a
  // host somebody else controls.
  it.each([
    "https://evil.example",
    "https://js.trovy.ca.evil.example",
    "https://evil.example/https://js.trovy.ca",
    "https://js.trovy.ca@evil.example",
    "https://xjs.trovy.ca",
    "https://js.a.b.trovy.ca",
    "https://js.-a.trovy.ca",
    "https://www.trovy.ca",
    "http://js.trovy.ca",
    "https://js.trovy.ca:8443",
    "https://js.trovy.ca/",
    "https://JS.TROVY.CA",
    "https://localhost:3005",
    "http://localhost.evil.example",
    "http://192.168.1.10:3005",
    "",
    undefined,
    null,
    42,
  ])("refuses %j", (origin) => {
    expect(() =>
      createMount({ frameOrigins: { live: "https://js.trovy.ca", test: origin as string } }),
    ).toThrow(TrovyConfigError);
    expect(() =>
      createMount({ frameOrigins: { live: origin as string, test: "https://js.trovy.ca" } }),
    ).toThrow(TrovyConfigError);
  });

  it("refuses a missing config rather than mounting nowhere", () => {
    expect(() => createMount(undefined as never)).toThrow(TrovyConfigError);
    expect(() => createMount({} as never)).toThrow(TrovyConfigError);
  });
});

describe("options", () => {
  // A secret key in browser code is the one mistake that actually costs money,
  // so it fails before an iframe exists and before any network call.
  it("refuses a secret key, says why, and does not repeat it", () => {
    const secret = `trv_live_${"c".repeat(64)}`;
    let thrown: unknown;
    try {
      mount(host, { publishableKey: secret, onSuccess: noop });
    } catch (error) {
      thrown = error;
    }

    expect(isTrovyConfigError(thrown)).toBe(true);
    expect((thrown as Error).message).toMatch(/never appear in a browser/);
    expect((thrown as Error).message).not.toContain("cccc");
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("refuses a malformed publishable key", () => {
    expect(() => mount(host, { publishableKey: "trv_pk_live_short", onSuccess: noop })).toThrow(TrovyConfigError);
    expect(() => mount(host, { publishableKey: "", onSuccess: noop })).toThrow(TrovyConfigError);
    expect(() => mount(host, undefined as never)).toThrow(TrovyConfigError);
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("throws when no element matches the selector", () => {
    expect(() => mount("#nothing-here", { publishableKey: LIVE_PK, onSuccess: noop })).toThrow(/no element/);
  });

  it("accepts a selector as well as an element", () => {
    mount("#trovy-widget", { publishableKey: LIVE_PK, onSuccess: noop });
    expect(host.querySelector("iframe")).not.toBeNull();
  });

  // A form with neither verifies a customer and drops the token on the floor.
  it("refuses a mount with neither onSuccess nor linkUrl", () => {
    expect(() => mount(host, { publishableKey: LIVE_PK } as never)).toThrow(/exactly one of/);
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("refuses both at once, because which of them owns the token would be a guess", () => {
    expect(() =>
      mount(host, { publishableKey: LIVE_PK, onSuccess: noop, linkUrl: "/api/trovy/link" } as never),
    ).toThrow(/exactly one of/);
  });

  it("is structurally the error onError would have received", () => {
    try {
      mount(host, { publishableKey: "nope", onSuccess: noop });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ name: "TrovyConfigError", stage: "config", code: "INVALID_CONFIG" });
    }
  });
});

describe("linkUrl", () => {
  it.each(["/api/trovy/link", "api/trovy/link", "http://localhost:3000/api/trovy/link"])(
    "accepts %s, which is on this page's origin",
    (linkUrl) => {
      expect(window.location.origin).toBe("http://localhost:3000");
      expect(() => mount(host, { publishableKey: LIVE_PK, linkUrl })).not.toThrow();
    },
  );

  // The request carries this site's session cookie and a token worth a customer
  // record. Neither goes anywhere the page itself does not live.
  it.each([
    "https://evil.example/api/trovy/link",
    "//evil.example/api/trovy/link",
    "http://localhost:3001/api/trovy/link",
    "https://localhost:3000/api/trovy/link",
    "javascript:alert(1)",
    "data:text/plain,hi",
    "",
    42,
    null,
  ])("refuses %j", (linkUrl) => {
    expect(() => mount(host, { publishableKey: LIVE_PK, linkUrl: linkUrl as string })).toThrow(TrovyConfigError);
    expect(host.querySelector("iframe")).toBeNull();
  });
});

describe("the frame URL", () => {
  it("sends a live key to the live frame origin and a test key to the test one", () => {
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop });
    expect(frameUrl().origin).toBe(LIVE_ORIGIN);

    mount(host, { publishableKey: TEST_PK, onSuccess: noop });
    expect(frameUrl().origin).toBe(TEST_ORIGIN);
  });

  it("carries the key, the host origin and a nonce", () => {
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop });
    const url = frameUrl();

    expect(url.pathname).toBe("/widget/v1/frame");
    expect(url.searchParams.get("pk")).toBe(LIVE_PK);
    expect(url.searchParams.get("origin")).toBe(window.location.origin);
    expect(url.searchParams.get("nonce")).toBeTruthy();
  });

  it("carries nothing else: not linkUrl, and nothing a later option might add by accident", () => {
    mount(host, { publishableKey: LIVE_PK, linkUrl: "/api/trovy/link", theme: { mode: "dark" } });

    expect([...frameUrl().searchParams.keys()].sort()).toEqual(["mode", "nonce", "origin", "pk"]);
  });

  it("gives each mount its own nonce", () => {
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop });
    const first = nonce();
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop });

    expect(nonce()).not.toBe(first);
  });

  it("falls back to getRandomValues where randomUUID does not exist", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => real.getRandomValues(bytes) });

    mount(host, { publishableKey: LIVE_PK, onSuccess: noop });

    expect(nonce()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses to mount with a guessable nonce where there is no crypto at all", () => {
    vi.stubGlobal("crypto", undefined);

    expect(() => mount(host, { publishableKey: LIVE_PK, onSuccess: noop })).toThrow(TrovyConfigError);
    expect(host.querySelector("iframe")).toBeNull();
  });
});

describe("the iframe element", () => {
  it("is named for screen readers, in words the page can replace", () => {
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop });
    expect(iframe().title).toBe("Join the rewards program");

    mount(host, { publishableKey: LIVE_PK, onSuccess: noop, title: "Rejoignez le programme" });
    expect(iframe().title).toBe("Rejoignez le programme");

    mount(host, { publishableKey: LIVE_PK, onSuccess: noop, title: "   " });
    expect(iframe().title).toBe("Join the rewards program");
  });

  it("delegates no permissions and is never lazy", () => {
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop });

    expect(iframe().getAttribute("allow")).toBe("");
    // A lazy frame below the fold never loads, never speaks, and is reported
    // unavailable ten seconds later on a page where nothing is wrong.
    expect(iframe().getAttribute("loading")).toBeNull();
  });

  // Two iframes and two listeners in one element is what React's Strict Mode,
  // a hot reload or a careless re-render would otherwise leave behind.
  it("replaces an earlier mount into the same element", () => {
    const onSuccess = vi.fn();
    const first = mount(host, { publishableKey: LIVE_PK, onSuccess });
    const staleNonce = nonce();
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop });

    expect(host.querySelectorAll("iframe")).toHaveLength(1);
    expect(first.getState()).toBe("unmounted");

    post(success({ nonce: staleNonce }));
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("theme sanitising", () => {
  // The theme becomes query parameters on a page on Trovy's origin, so an
  // unvalidated value is an injection point — and a free-form colour could make
  // the consent text unreadable while leaving it technically present.
  it("passes a well-formed accent, radius and mode", () => {
    mount(host, {
      publishableKey: LIVE_PK,
      onSuccess: noop,
      theme: { accent: "#1D9BF0", radius: 8, mode: "dark" },
    });
    const q = frameUrl().searchParams;

    expect(q.get("accent")).toBe("#1d9bf0");
    expect(q.get("radius")).toBe("8");
    expect(q.get("mode")).toBe("dark");
  });

  it("drops an accent that is not #rrggbb", () => {
    mount(host, {
      publishableKey: LIVE_PK,
      onSuccess: noop,
      theme: { accent: "red; background: url(x)" } as never,
    });
    expect(frameUrl().searchParams.get("accent")).toBeNull();
  });

  it("clamps the radius and rounds it", () => {
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop, theme: { radius: 999 } });
    expect(frameUrl().searchParams.get("radius")).toBe("24");

    mount(host, { publishableKey: LIVE_PK, onSuccess: noop, theme: { radius: -5 } });
    expect(frameUrl().searchParams.get("radius")).toBe("0");

    mount(host, { publishableKey: LIVE_PK, onSuccess: noop, theme: { radius: 7.6 } });
    expect(frameUrl().searchParams.get("radius")).toBe("8");
  });

  it("drops an unknown mode", () => {
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop, theme: { mode: "neon" as never } });
    expect(frameUrl().searchParams.get("mode")).toBeNull();
  });
});

describe("messages from the frame", () => {
  it("calls onSuccess with the link token", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    post(success({ firstName: "Maria" }));

    expect(onSuccess).toHaveBeenCalledWith({
      linkToken: "lt_abc",
      expiresAt: "2026-09-13T10:05:00.000Z",
      firstName: "Maria",
    });
  });

  // The frame's own effect can run twice. A second callback would send a
  // single-use token to the server a second time, and the customer would be told
  // that a sign-up which worked had failed.
  it("delivers a success at most once", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    post(success());
    post(success());
    post(success({ linkToken: "lt_other" }));

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("calls onError with the frame's code, marked as the form's own", () => {
    const onError = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop, onError });

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:error", code: "SMS_UNAVAILABLE", message: "No texts." });

    expect(onError).toHaveBeenCalledWith({ stage: "widget", code: "SMS_UNAVAILABLE", message: "No texts." });
  });

  it("gives an error with no code a code anyway", () => {
    const onError = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop, onError });

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:error" });

    expect(onError).toHaveBeenCalledWith({ stage: "widget", code: "WIDGET_ERROR", message: "Something went wrong." });
  });

  it("resizes the iframe to the frame's own height", () => {
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop });

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:resize", height: 480 });

    expect(iframe().style.height).toBe("480px");
  });

  it("caps a resize so a bug cannot make a page scroll forever", () => {
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop });

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:resize", height: 99999 });

    expect(iframe().style.height).toBe("2000px");
  });

  // The protocol only ever grows. A loader bundled into a partner's app a year
  // ago has to shrug at whatever the frame has learned to say since.
  it("ignores trovy:ready and any type it does not know", () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess, onError });

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:ready" });
    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:something-new", extra: { nested: true } });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reads the fields it knows from a message that carries more", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    post(success({ firstName: "Maria", clientReference: "later", v: 2 }));

    expect(onSuccess).toHaveBeenCalledWith({
      linkToken: "lt_abc",
      expiresAt: "2026-09-13T10:05:00.000Z",
      firstName: "Maria",
    });
  });
});

describe("messages the loader must refuse", () => {
  // Any script on the host page can post a message. Accepting a forged one would
  // hand the page a link token it never earned, or let it fake a success.
  it("ignores a message from another origin", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    post(success(), { origin: "https://evil.example" });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("ignores a test-key frame's origin on a live-key mount", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    post(success(), { origin: TEST_ORIGIN });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("ignores a message from a different window on the right origin", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    post(success(), { source: window });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("ignores a message without the trovy marker", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    post(success({ trovy: undefined }));

    expect(onSuccess).not.toHaveBeenCalled();
  });

  // Two widgets on one page, or a replayed message: the nonce is what makes a
  // success resolve the mount that actually earned it.
  it("ignores a message carrying another mount's nonce", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    post(success({ nonce: "not-mine" }));

    expect(onSuccess).not.toHaveBeenCalled();
  });

  // The attack the nonce does not stop. A script on the page can read the nonce out
  // of `iframe.src` and navigate that same element to the frame with its own
  // publishable key — `event.source` still matches, because it is the same
  // element's contentWindow — so the customer fills in a real Trovy form and is
  // enrolled in the attacker's programme. The echoed key is what makes that
  // navigation visible.
  it("ignores a message from a frame loaded with a different key", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    post(success({ pk: `trv_pk_live_${"c".repeat(32)}` }));

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("ignores a message that echoes no key at all", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    post(success({ pk: undefined }));

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("ignores a success with no token rather than calling back with undefined", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    post(success({ linkToken: undefined }));
    post(success({ expiresAt: undefined }));

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("survives a null or non-object message", () => {
    const onSuccess = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess });

    expect(() => post(null)).not.toThrow();
    expect(() => post("trovy:success")).not.toThrow();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("a frame that never arrives", () => {
  // The browser refuses to draw the frame on a page the business has not listed,
  // and an outage is silence. Neither can post anything, so the loader has to be
  // the one to notice.
  it("tells the page after ten seconds, and hides the browser's error box", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const handle = mount(host, { publishableKey: LIVE_PK, onSuccess: noop, onError });

    vi.advanceTimersByTime(9_999);
    expect(onError).not.toHaveBeenCalled();
    expect(handle.getState()).toBe("loading");

    vi.advanceTimersByTime(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({
      stage: "widget",
      code: "WIDGET_UNAVAILABLE",
      message: "The sign-up form could not be loaded.",
    });
    expect(iframe().style.display).toBe("none");
    expect(handle.getState()).toBe("unavailable");
  });

  // What a browser draws in a refused frame is its own grey error page.
  it("keeps the frame out of sight, in its reserved space, until it announces itself", () => {
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop });
    expect(iframe().style.visibility).toBe("hidden");
    expect(iframe().style.height).toBe("320px");

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:ready" }, { origin: "https://evil.example" });
    expect(iframe().style.visibility).toBe("hidden");

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:ready" });
    expect(iframe().style.visibility).toBe("visible");
  });

  it("says nothing once the frame has announced itself", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop, onError });

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:ready" });
    vi.advanceTimersByTime(60_000);

    expect(onError).not.toHaveBeenCalled();
    expect(iframe().style.display).toBe("block");
  });

  // Only a message that passed all five checks counts: anything else on the page
  // could otherwise keep a dead widget looking alive.
  it("is not reassured by a message it would have refused", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess: noop, onError });

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:ready" }, { origin: "https://evil.example" });
    post({ trovy: 1, nonce: "someone-else", pk: LIVE_PK, type: "trovy:ready" });
    vi.advanceTimersByTime(10_000);

    expect(onError).toHaveBeenCalledTimes(1);
  });

  // Slow is not broken. A frame that turns up late is shown, and works — and the
  // page is told, so it can take down whatever it put up in the meantime.
  it("shows a frame that was only slow, and says it recovered", () => {
    vi.useFakeTimers();
    const onSuccess = vi.fn();
    const onStateChange = vi.fn();
    mount(host, { publishableKey: LIVE_PK, onSuccess, onError: vi.fn(), onStateChange });
    vi.advanceTimersByTime(10_000);
    expect(iframe().style.display).toBe("none");

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:ready" });
    post(success());

    expect(iframe().style.display).toBe("block");
    expect(iframe().style.visibility).toBe("visible");
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual(["unavailable", "ready", "success"]);
  });

  it("does not fire after unmount", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const handle = mount(host, { publishableKey: LIVE_PK, onSuccess: noop, onError });

    handle.unmount();
    vi.advanceTimersByTime(60_000);

    expect(onError).not.toHaveBeenCalled();
  });
});

describe("states", () => {
  it("goes loading, ready, success when you exchange the token yourself", () => {
    const onStateChange = vi.fn();
    const handle = mount(host, { publishableKey: LIVE_PK, onSuccess: noop, onStateChange });
    expect(handle.getState()).toBe("loading");

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:ready" });
    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:resize", height: 400 });
    post(success());

    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual(["ready", "success"]);
    expect(handle.getState()).toBe("success");
  });
});

describe("a callback that throws", () => {
  // The partner's bug must reach the partner's error reporting, and must not
  // leave the form half-working.
  it("is rethrown on its own task, and the loader carries on", () => {
    vi.useFakeTimers();
    const boom = new Error("partner bug");
    const onStateChange = vi.fn();
    const handle = mount(host, {
      publishableKey: LIVE_PK,
      onSuccess: () => {
        throw boom;
      },
      onStateChange,
    });

    expect(() => post(success())).not.toThrow();
    expect(handle.getState()).toBe("success");
    expect(() => vi.runAllTimers()).toThrow(boom);
  });

  it("does not stop a resize that follows it", () => {
    vi.useFakeTimers();
    mount(host, {
      publishableKey: LIVE_PK,
      onSuccess: noop,
      onStateChange: () => {
        throw new Error("partner bug");
      },
    });

    post({ trovy: 1, nonce: nonce(), pk: LIVE_PK, type: "trovy:resize", height: 410 });

    expect(iframe().style.height).toBe("410px");
    expect(() => vi.runAllTimers()).toThrow("partner bug");
  });
});

describe("reset", () => {
  it("starts over with a fresh frame and a fresh nonce", () => {
    const onSuccess = vi.fn();
    const onStateChange = vi.fn();
    const handle = mount(host, { publishableKey: LIVE_PK, onSuccess, onStateChange });
    const firstNonce = nonce();
    post(success());

    handle.reset();

    expect(host.querySelectorAll("iframe")).toHaveLength(1);
    expect(nonce()).not.toBe(firstNonce);
    expect(handle.getState()).toBe("loading");
    expect(iframe().style.visibility).toBe("hidden");

    // The old frame is gone, and so is its say.
    post(success({ nonce: firstNonce, linkToken: "lt_replayed" }));
    expect(onSuccess).toHaveBeenCalledTimes(1);

    // The new one gets its own single delivery.
    post(success({ linkToken: "lt_second" }));
    expect(onSuccess).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenLastCalledWith(expect.objectContaining({ linkToken: "lt_second" }));
  });

  it("restarts the deadline", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const handle = mount(host, { publishableKey: LIVE_PK, onSuccess: noop, onError });

    vi.advanceTimersByTime(9_000);
    handle.reset();
    vi.advanceTimersByTime(9_000);
    expect(onError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does nothing after unmount", () => {
    const handle = mount(host, { publishableKey: LIVE_PK, onSuccess: noop });
    handle.unmount();

    handle.reset();

    expect(host.querySelector("iframe")).toBeNull();
    expect(handle.getState()).toBe("unmounted");
  });
});

describe("unmount", () => {
  it("removes the iframe and stops listening", () => {
    const onSuccess = vi.fn();
    const handle = mount(host, { publishableKey: LIVE_PK, onSuccess });
    const frame = iframe();
    const message = success();

    handle.unmount();

    expect(host.querySelector("iframe")).toBeNull();
    const event = new MessageEvent("message", { data: message });
    Object.defineProperty(event, "origin", { value: LIVE_ORIGIN });
    Object.defineProperty(event, "source", { value: frame.contentWindow });
    window.dispatchEvent(event);

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("leaves exactly as many listeners as it found", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    const handle = mount(host, { publishableKey: LIVE_PK, onSuccess: noop });
    handle.reset();
    handle.unmount();

    const added = add.mock.calls.filter(([type]) => type === "message");
    const removed = remove.mock.calls.filter(([type]) => type === "message");
    expect(added).toHaveLength(2);
    expect(removed.map(([, listener]) => listener)).toEqual(added.map(([, listener]) => listener));
  });

  it("is safe to call twice, and says nothing about itself", () => {
    const onStateChange = vi.fn();
    const handle = mount(host, { publishableKey: LIVE_PK, onSuccess: noop, onStateChange });

    handle.unmount();
    expect(() => handle.unmount()).not.toThrow();

    expect(handle.getState()).toBe("unmounted");
    expect(onStateChange).not.toHaveBeenCalled();
  });
});
