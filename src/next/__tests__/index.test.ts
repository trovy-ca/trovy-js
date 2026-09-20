import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isTrovyError, TrovyError } from "../../index.js";

// Outside a React Server environment `server-only` throws on import, which is
// the whole point of it. Next resolves it to an empty module for server code;
// this stands in for that.
vi.mock("server-only", () => ({}));

const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");

describe("@trovy/sdk/next", () => {
  it("exports the handler factory", async () => {
    const entry = await import("../index.js");

    expect(Object.keys(entry)).toEqual(["createLinkHandler"]);
    expect(typeof entry.createLinkHandler).toBe("function");
  });

  // The guard only works as the first thing the module does: an import of this
  // entry from a Client Component has to fail before the client is evaluated.
  it("imports server-only before anything else", () => {
    const imports = source.split("\n").filter((line) => /^(import|export) /.test(line));

    expect(imports[0]).toBe('import "server-only";');
  });

  it("imports nothing from next itself, so it needs no particular version of it", () => {
    expect(source).not.toMatch(/from "next[/"]/);
  });

  // This entry carries its own copy of the client. An error thrown through it has
  // to be recognised by the guard a partner imported from the root entry.
  it("throws errors the root entry's guards recognise", async () => {
    const { createLinkHandler } = await import("../index.js");
    const seen: unknown[] = [];
    const handler = createLinkHandler({
      trovy: {
        environment: "sandbox",
        customers: { link: () => Promise.reject(new TrovyError(401, { error: "revoked", code: "API_KEY_REVOKED" })) },
      },
      getUser: () => "user_1",
      onLinked: () => {},
      onError: ({ error }) => void seen.push(error),
    });

    await handler(
      new Request("https://shop.example/api/trovy/link", {
        method: "POST",
        headers: { "content-type": "application/json", "x-trovy-link": "1" },
        body: JSON.stringify({ linkToken: "lt_abc" }),
      }),
    );

    expect(isTrovyError(seen[0])).toBe(true);
  });
});
