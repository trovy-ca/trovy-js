import { afterEach, describe, expect, it } from "vitest";
import { mount } from "../index.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("mount, as published", () => {
  // Hard-wired. A test key gets the same host and a "test mode" notice; there is
  // no second host for a partner's page to allow, and no option that names one.
  it.each([
    ["live", `trv_pk_live_${"a".repeat(32)}`],
    ["test", `trv_pk_test_${"b".repeat(32)}`],
  ])("serves a %s key's form from js.trovy.ca", (_kind, publishableKey) => {
    const host = document.body.appendChild(document.createElement("div"));

    mount(host, { publishableKey, onSuccess: () => {} });

    expect(new URL(host.querySelector("iframe")!.src).origin).toBe("https://js.trovy.ca");
  });

  it("has no option that moves the frame", () => {
    const host = document.body.appendChild(document.createElement("div"));

    mount(host, {
      publishableKey: `trv_pk_live_${"a".repeat(32)}`,
      onSuccess: () => {},
      ...({ frameOrigin: "https://evil.example", frameOrigins: { live: "https://evil.example" }, origin: "https://evil.example" } as object),
    });

    const url = new URL(host.querySelector("iframe")!.src);
    expect(url.origin).toBe("https://js.trovy.ca");
    expect(url.searchParams.get("origin")).toBe(window.location.origin);
  });
});
