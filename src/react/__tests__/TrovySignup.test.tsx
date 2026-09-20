import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createMount } from "../../widget/core.js";
import { createTrovySignup, type TrovySignupHandle, type TrovySignupProps } from "../create.js";

// The real loader, bound to a loopback frame origin: what is under test is the
// component AND the loader together, since the seam between them is where a
// remount or a stale callback would hide.
const ORIGIN = "http://localhost:3005";
const TrovySignup = createTrovySignup(createMount({ frameOrigins: { live: ORIGIN, test: ORIGIN } }));

const PK = `trv_pk_test_${"a".repeat(32)}`;
const OTHER_PK = `trv_pk_test_${"b".repeat(32)}`;
const noop = () => {};

let fetchMock: Mock<typeof fetch>;

const iframes = () => Array.from(document.querySelectorAll("iframe"));
function iframe(): HTMLIFrameElement {
  const [el] = iframes();
  if (!el) throw new Error("no iframe mounted");
  return el;
}
const nonce = () => new URL(iframe().src).searchParams.get("nonce");
const wrapper = () => document.querySelector("[data-trovy-state]") as HTMLElement;

function say(message: Record<string, unknown>, pk = PK) {
  const event = new MessageEvent("message", { data: { trovy: 1, nonce: nonce(), pk, ...message } });
  Object.defineProperty(event, "origin", { value: ORIGIN });
  Object.defineProperty(event, "source", { value: iframe().contentWindow });
  act(() => {
    window.dispatchEvent(event);
  });
}
const verify = (pk = PK) =>
  say({ type: "trovy:success", linkToken: "lt_abc", expiresAt: "2026-01-01T00:05:00.000Z", firstName: "Maria" }, pk);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const linked = () => json(200, { ok: true, customer: { name: "Maria", isNew: true } });
const refused = (status: number, code: string) => json(status, { ok: false, code, message: "fixed" });
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("rendering", () => {
  it("puts one form inside a box the page can address and style", () => {
    render(<TrovySignup publishableKey={PK} onSuccess={noop} id="rewards" className="card" style={{ maxWidth: 420 }} />);

    expect(iframes()).toHaveLength(1);
    expect(wrapper().id).toBe("rewards");
    expect(wrapper().className).toBe("card");
    expect(wrapper().style.maxWidth).toBe("420px");
    expect(wrapper().dataset.trovyState).toBe("loading");
    expect(new URL(iframe().src).searchParams.get("pk")).toBe(PK);
  });

  it("passes the theme and the title on", () => {
    render(<TrovySignup publishableKey={PK} onSuccess={noop} theme={{ accent: "#1D9BF0", mode: "dark" }} title="Rejoignez-nous" />);

    const query = new URL(iframe().src).searchParams;
    expect(query.get("accent")).toBe("#1d9bf0");
    expect(query.get("mode")).toBe("dark");
    expect(iframe().title).toBe("Rejoignez-nous");
  });

  it("reflects the loader's state on the box", () => {
    render(<TrovySignup publishableKey={PK} onSuccess={noop} />);

    say({ type: "trovy:ready" });
    expect(wrapper().dataset.trovyState).toBe("ready");

    verify();
    expect(wrapper().dataset.trovyState).toBe("success");
  });
});

describe("server rendering", () => {
  const element = <TrovySignup publishableKey={PK} linkUrl="/api/trovy/link" className="card" />;

  it("renders an empty box and no iframe, without touching a DOM it does not have", () => {
    const html = renderToString(element);

    expect(html).toContain('data-trovy-state="loading"');
    expect(html).not.toContain("<iframe");
  });

  it("hydrates without a mismatch, then mounts the form", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = renderToString(element);

    await act(async () => {
      hydrateRoot(container, element, {
        onRecoverableError: (error) => {
          throw error;
        },
      });
    });

    expect(errors).not.toHaveBeenCalled();
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    container.remove();
  });
});

describe("Strict Mode", () => {
  // React mounts, unmounts and mounts again in development. What is left must be
  // what one mount leaves.
  it("leaves one iframe and one listener", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    render(
      <StrictMode>
        <TrovySignup publishableKey={PK} onSuccess={noop} />
      </StrictMode>,
    );

    const count = (spy: typeof add | typeof remove) => spy.mock.calls.filter(([type]) => type === "message").length;
    expect(iframes()).toHaveLength(1);
    expect(count(add) - count(remove)).toBe(1);
  });

  it("delivers a success once", () => {
    const onSuccess = vi.fn();
    render(
      <StrictMode>
        <TrovySignup publishableKey={PK} onSuccess={onSuccess} />
      </StrictMode>,
    );

    verify();

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("re-rendering", () => {
  // A remount throws away whatever the customer has typed, and a code they were
  // texted a moment ago. Nothing a parent does by re-rendering may cause one.
  it("keeps the same iframe when given new inline callbacks and an equal theme", () => {
    const { rerender } = render(
      <TrovySignup publishableKey={PK} onSuccess={() => {}} onError={() => {}} theme={{ accent: "#1d9bf0", radius: 8 }} />,
    );
    const before = iframe();
    const beforeNonce = nonce();

    rerender(
      <TrovySignup publishableKey={PK} onSuccess={() => {}} onError={() => {}} onStateChange={() => {}} theme={{ radius: 8.2, accent: "#1D9BF0" }} className="now-with-a-class" />,
    );

    expect(iframe()).toBe(before);
    expect(nonce()).toBe(beforeNonce);
  });

  it("calls the callback from the latest render, not the one it mounted with", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<TrovySignup publishableKey={PK} onSuccess={first} />);

    rerender(<TrovySignup publishableKey={PK} onSuccess={second} />);
    verify();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the key", <TrovySignup key="a" publishableKey={OTHER_PK} onSuccess={noop} />],
    ["a theme value", <TrovySignup key="a" publishableKey={PK} onSuccess={noop} theme={{ radius: 12 }} />],
    ["the title", <TrovySignup key="a" publishableKey={PK} onSuccess={noop} title="Another" />],
  ])("starts a fresh form when %s changes, since the frame itself is different", (_name, next) => {
    const { rerender } = render(<TrovySignup key="a" publishableKey={PK} onSuccess={noop} />);
    const beforeNonce = nonce();

    rerender(next);

    expect(iframes()).toHaveLength(1);
    expect(nonce()).not.toBe(beforeNonce);
  });
});

describe("linking through the partner's route", () => {
  it("posts the token to linkUrl and reports the customer, without the token reaching the page", async () => {
    fetchMock.mockResolvedValue(linked());
    const onLinked = vi.fn();
    const onStateChange = vi.fn();
    render(<TrovySignup publishableKey={PK} linkUrl="/api/trovy/link" onLinked={onLinked} onStateChange={onStateChange} />);

    verify();
    expect(wrapper().dataset.trovyState).toBe("linking");
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:3000/api/trovy/link");
    expect(onLinked).toHaveBeenCalledWith({ name: "Maria", isNew: true });
    expect(wrapper().dataset.trovyState).toBe("linked");
    expect(JSON.stringify([onLinked.mock.calls, onStateChange.mock.calls])).not.toContain("lt_abc");
    expect(document.body.innerHTML).not.toContain("lt_abc");
  });

  it("offers another try when nothing was decided, and links on it", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    render(<TrovySignup publishableKey={PK} linkUrl="/api/trovy/link" />);
    verify();
    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(screen.getByRole("alert")).toHaveTextContent("We could not connect your rewards to your account.");
    expect(screen.getByRole("alert").dataset.trovyNotice).toBe("retry");

    fetchMock.mockResolvedValue(linked());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(wrapper().dataset.trovyState).toBe("linked");
  });

  it("sends the customer round the form again when the token is finished", async () => {
    fetchMock.mockResolvedValue(refused(409, "LINK_TOKEN_INVALID"));
    render(<TrovySignup publishableKey={PK} linkUrl="/api/trovy/link" />);
    const beforeNonce = nonce();
    verify();
    await settle();

    expect(screen.getByRole("alert").dataset.trovyNotice).toBe("verify-again");
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));

    expect(iframes()).toHaveLength(1);
    expect(nonce()).not.toBe(beforeNonce);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(wrapper().dataset.trovyState).toBe("loading");
  });

  it("asks a signed-out customer to sign in, and tries again when asked", async () => {
    fetchMock.mockResolvedValueOnce(refused(401, "LINK_NOT_SIGNED_IN")).mockResolvedValueOnce(linked());
    render(<TrovySignup publishableKey={PK} linkUrl="/api/trovy/link" />);
    verify();
    await settle();

    expect(screen.getByRole("alert")).toHaveTextContent("Sign in to connect your rewards");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();

    expect(wrapper().dataset.trovyState).toBe("linked");
  });

  it("offers the customer nothing to press for a bug only a developer can fix", async () => {
    fetchMock.mockResolvedValue(refused(403, "LINK_FORBIDDEN"));
    render(<TrovySignup publishableKey={PK} linkUrl="/api/trovy/link" />);
    verify();
    await settle();

    expect(screen.getByRole("alert").dataset.trovyNotice).toBe("developer");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lets the page replace the notice, with everything it needs to act", async () => {
    fetchMock.mockResolvedValueOnce(refused(401, "LINK_NOT_SIGNED_IN")).mockResolvedValueOnce(linked());
    render(
      <TrovySignup
        publishableKey={PK}
        linkUrl="/api/trovy/link"
        renderLinkFailed={({ error, retry }) => (
          <button type="button" onClick={retry}>
            {error.code} / {error.recovery}
          </button>
        )}
      />,
    );
    verify();
    await settle();

    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "LINK_NOT_SIGNED_IN / sign-in" }));
    await settle();

    expect(wrapper().dataset.trovyState).toBe("linked");
  });

  it("does not abort a link request when it unmounts: aborting does not un-spend a token", async () => {
    let answer!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const onLinked = vi.fn();
    const { unmount } = render(<TrovySignup publishableKey={PK} linkUrl="/api/trovy/link" onLinked={onLinked} />);
    verify();
    const signal = fetchMock.mock.calls[0]![1]!.signal!;

    unmount();
    answer(linked());
    await settle();

    expect(signal.aborted).toBe(false);
    expect(onLinked).not.toHaveBeenCalled();
  });
});

describe("a form that cannot load", () => {
  it("shows the fallback after ten seconds, and takes it down if the form turns up", () => {
    const onError = vi.fn();
    render(<TrovySignup publishableKey={PK} onSuccess={noop} onError={onError} unavailableFallback={<p>Rewards are taking a break.</p>} />);
    expect(screen.queryByText("Rewards are taking a break.")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("Rewards are taking a break.")).toBeInTheDocument();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ stage: "widget", code: "WIDGET_UNAVAILABLE" }));

    say({ type: "trovy:ready" });
    expect(screen.queryByText("Rewards are taking a break.")).toBeNull();
    expect(iframe().style.visibility).toBe("visible");
  });
});

describe("a mistake in the props", () => {
  const SECRET = `trv_test_${"c".repeat(64)}`;

  // A component that throws takes the whole page down, in production, over a
  // sign-up form.
  it("never throws: it reports, logs once without the key, and shows the fallback", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();

    expect(() =>
      render(
        <StrictMode>
          <TrovySignup publishableKey={SECRET} onSuccess={noop} onError={onError} unavailableFallback={<p>Rewards are taking a break.</p>} />
        </StrictMode>,
      ),
    ).not.toThrow();

    expect(iframes()).toHaveLength(0);
    expect(screen.getByText("Rewards are taking a break.")).toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ stage: "config", code: "INVALID_CONFIG", message: expect.stringMatching(/never appear in a browser/) });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([log.mock.calls, onError.mock.calls])).not.toContain("cccc");
    expect(document.body.innerHTML).not.toContain("cccc");
  });

  it("shows the developer what is wrong, on the page, outside production", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<TrovySignup publishableKey="nope" onSuccess={noop} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/publishableKey must look like/);
  });

  it("shows a customer nothing of the kind", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");

    render(<TrovySignup publishableKey="nope" onSuccess={noop} />);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["neither linkUrl nor onSuccess", { publishableKey: PK }],
    ["both", { publishableKey: PK, linkUrl: "/api/trovy/link", onSuccess: noop }],
    ["a linkUrl on another origin", { publishableKey: PK, linkUrl: "https://evil.example/link" }],
  ])("reports %s", (_name, props) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();

    render(<TrovySignup {...(props as unknown as TrovySignupProps)} onError={onError} />);

    expect(iframes()).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ stage: "config", code: "INVALID_CONFIG" }));
  });

  it("recovers when the props are fixed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(<TrovySignup publishableKey="nope" onSuccess={noop} />);

    rerender(<TrovySignup publishableKey={PK} onSuccess={noop} />);

    expect(iframes()).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(wrapper().dataset.trovyState).toBe("loading");
  });
});

describe("the ref", () => {
  it("resets the form", () => {
    const ref = createRef<TrovySignupHandle>();
    render(<TrovySignup ref={ref} publishableKey={PK} onSuccess={noop} />);
    const beforeNonce = nonce();

    act(() => ref.current!.reset());

    expect(iframes()).toHaveLength(1);
    expect(nonce()).not.toBe(beforeNonce);
  });

  it("retries a link, and says whether there was anything to retry", async () => {
    fetchMock.mockResolvedValueOnce(refused(401, "LINK_NOT_SIGNED_IN")).mockResolvedValueOnce(linked());
    const ref = createRef<TrovySignupHandle>();
    render(<TrovySignup ref={ref} publishableKey={PK} linkUrl="/api/trovy/link" />);
    expect(ref.current!.retry()).toBe(false);

    verify();
    await settle();
    let started = false;
    act(() => {
      started = ref.current!.retry();
    });
    await settle();

    expect(started).toBe(true);
    expect(wrapper().dataset.trovyState).toBe("linked");
  });
});

describe("unmounting", () => {
  it("removes the iframe and calls nothing afterwards", () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const { unmount } = render(<TrovySignup publishableKey={PK} onSuccess={onSuccess} onError={onError} />);
    const frame = iframe();
    const data = { trovy: 1, nonce: nonce(), pk: PK, type: "trovy:success", linkToken: "lt", expiresAt: "x" };

    unmount();
    const event = new MessageEvent("message", { data });
    Object.defineProperty(event, "origin", { value: ORIGIN });
    Object.defineProperty(event, "source", { value: frame.contentWindow });
    window.dispatchEvent(event);
    vi.advanceTimersByTime(60_000);

    expect(iframes()).toHaveLength(0);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
