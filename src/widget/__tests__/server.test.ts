// @vitest-environment node

import { describe, expect, it } from "vitest";

const PK = `trv_pk_live_${"a".repeat(32)}`;

describe("on a server", () => {
  // A framework imports a page's modules while rendering it on the server, long
  // before anything calls `mount`.
  it("imports without touching a DOM it does not have", async () => {
    expect(typeof window).toBe("undefined");

    await expect(import("../index.js")).resolves.toHaveProperty("mount");
  });

  it("refuses to mount, and says where the call belongs", async () => {
    const { mount, isTrovyConfigError } = await import("../index.js");

    let thrown: unknown;
    try {
      mount("#rewards", { publishableKey: PK, onSuccess: () => {} });
    } catch (error) {
      thrown = error;
    }

    expect(isTrovyConfigError(thrown)).toBe(true);
    expect((thrown as Error).message).toMatch(/needs a browser.*from an effect/);
  });
});

describe("the entry partners import", () => {
  it("is bound to Trovy's production form for both kinds of key, with no way to say otherwise", async () => {
    const entry = await import("../index.js");

    // `createMount` is how an origin is chosen, and this entry does not have it.
    expect(Object.keys(entry).sort()).toEqual(["TrovyConfigError", "WIDGET_ERROR_CODES", "isTrovyConfigError", "mount"]);
  });
});
