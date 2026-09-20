import { version as reactVersion } from "react";
import { version as domVersion } from "react-dom";
import { expect, it } from "vitest";

// Without this, an alias that quietly stopped working would leave a leg that
// passes on React 19 twice and proves nothing about 18.
it("runs this leg on React 18, and on one React rather than two", () => {
  expect(reactVersion).toMatch(/^18\./);
  expect(domVersion).toBe(reactVersion);
});
