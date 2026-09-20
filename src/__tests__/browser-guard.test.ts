import { afterEach, describe, expect, it, vi } from "vitest";
import { Trovy } from "../client.js";

const SECRET = `trv_test_${"a".repeat(64)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the client refuses to run where a secret key is readable", () => {
  it("constructs on a server, where there is no DOM", () => {
    expect(() => new Trovy({ apiKey: SECRET })).not.toThrow();
  });

  it("throws in a browser, and says where the key belongs instead", () => {
    vi.stubGlobal("window", { document: {} });

    expect(() => new Trovy({ apiKey: SECRET })).toThrow(/running in a browser.*@trovy\/sdk\/react/s);
  });

  it("throws on React Native, which has no document but is still the customer's device", () => {
    vi.stubGlobal("navigator", { product: "ReactNative" });

    expect(() => new Trovy({ apiKey: SECRET })).toThrow(/running in a browser/);
  });

  it("does not mistake a runtime that merely defines `window` for a browser", () => {
    // Deno 1 defined `window` with no document; so do some edge polyfills.
    vi.stubGlobal("window", {});

    expect(() => new Trovy({ apiKey: SECRET })).not.toThrow();
  });

  it("checks before validating the key, so the message is about the real mistake", () => {
    vi.stubGlobal("window", { document: {} });

    expect(() => new Trovy({ apiKey: "not-a-key" })).toThrow(/running in a browser/);
  });

  it("never repeats the key in what it throws", () => {
    vi.stubGlobal("window", { document: {} });

    expect(() => new Trovy({ apiKey: SECRET })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("aaaa") }),
    );
  });

  it("can be told to run anyway, for a test environment with a fake DOM", () => {
    vi.stubGlobal("window", { document: {} });

    expect(() => new Trovy({ apiKey: SECRET, dangerouslyAllowBrowser: true })).not.toThrow();
  });
});
