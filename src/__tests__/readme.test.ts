import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LINK_MESSAGES, LINK_RECOVERY } from "../link-protocol.js";
import { WIDGET_ERROR_CODES } from "../widget/core.js";

/**
 * The README's error tables are what a partner writes their `onError` against.
 * A code the package produces and the README does not mention is a branch nobody
 * wrote; a code the README invents is a branch that never runs.
 */
const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

describe("the README's sign-up error codes", () => {
  const produced = [...WIDGET_ERROR_CODES.config, ...WIDGET_ERROR_CODES.widget, ...WIDGET_ERROR_CODES.link].sort();

  it("are exactly the codes the package produces", () => {
    const documented = [...readme.matchAll(/`((?:LINK|WIDGET)_[A-Z_]+|INVALID_CONFIG)`/g)].map((match) => match[1]!);

    expect([...new Set(documented)].sort()).toEqual(produced);
  });

  it("files every link code under the recovery the package reports for it", () => {
    for (const [code, recovery] of Object.entries(LINK_RECOVERY)) {
      const row = readme.split("\n").find((line) => line.startsWith(`| \`${recovery}\` |`));

      expect(row, `a row for ${recovery}`).toBeDefined();
      expect(row, `${code} under ${recovery}`).toContain(`\`${code}\``);
    }
  });

  it("has a fixed sentence for every link code", () => {
    expect(Object.keys(LINK_MESSAGES).sort()).toEqual(Object.keys(LINK_RECOVERY).sort());
  });
});

describe("the README's promises about hosts", () => {
  it("names the one frame host a Content Security Policy needs", () => {
    expect(readme).toContain("frame-src https://js.trovy.ca;");
  });
});
