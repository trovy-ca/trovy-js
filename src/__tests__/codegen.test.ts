import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_SHA256 } from "../generated/contract.js";

/**
 * `src/generated` is committed rather than built on install, so that someone
 * reading the SDK's source sees the same types their editor does and `npm pack`
 * has nothing to generate. That only works if the committed files are actually
 * what the generator produces from the committed contract.
 *
 * This test re-runs `scripts/codegen.mjs` into a temp directory and compares. It
 * fails when someone edits a generated file by hand, or changes `openapi/v1.json`
 * and forgets `pnpm codegen`.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const GENERATED = ["openapi.ts", "contract.ts"] as const;

describe("generated files", () => {
  it("are exactly what the pinned generator produces from the committed contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "trovy-sdk-codegen-"));
    try {
      execFileSync(process.execPath, [join(root, "scripts/codegen.mjs"), "--out", dir], {
        cwd: root,
        stdio: "pipe",
      });
      for (const file of GENERATED) {
        expect(readFileSync(join(dir, file), "utf8"), file).toBe(
          readFileSync(join(root, "src/generated", file), "utf8"),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(GENERATED)("%s carries the header that says not to edit it", (file) => {
    expect(readFileSync(join(root, "src/generated", file), "utf8")).toMatch(
      /do not make direct changes to the file/i,
    );
  });
});

describe("CONTRACT_SHA256", () => {
  it("is a SHA-256 in hex", () => {
    expect(CONTRACT_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not change when the contract is reformatted or given code samples", () => {
    // What a docs site does to the file it serves: minify, reorder, decorate.
    const dir = mkdtempSync(join(tmpdir(), "trovy-sdk-hash-"));
    try {
      const contract = JSON.parse(readFileSync(join(root, "openapi/v1.json"), "utf8")) as {
        paths: Record<string, Record<string, Record<string, unknown>>>;
      };
      for (const operations of Object.values(contract.paths)) {
        for (const operation of Object.values(operations)) {
          operation["x-codeSamples"] = [{ lang: "curl", source: "curl https://example.test" }];
        }
      }
      const reordered = Object.fromEntries(Object.entries(contract).reverse());
      const served = join(dir, "served.json");
      writeFileSync(served, JSON.stringify(reordered));

      const hash = execFileSync(process.execPath, [join(root, "scripts/contract-hash.mjs"), served], {
        encoding: "utf8",
      }).trim();

      expect(hash).toBe(CONTRACT_SHA256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The API's own repository hashes contracts with a copy of this algorithm, and
  // compares its result with CONTRACT_SHA256. If the canonical form changed here
  // alone, every such comparison would fail, or worse, pass by accident. Both
  // copies are pinned to this one vector.
  it("hashes the shared vector to the value the API's repository also expects", () => {
    const dir = mkdtempSync(join(tmpdir(), "trovy-sdk-hash-"));
    try {
      const vector = join(dir, "vector.json");
      writeFileSync(vector, JSON.stringify({ b: 1, a: { "x-codeSamples": [{ lang: "curl" }], z: [{ d: 1, c: 2 }] } }));

      const hash = execFileSync(process.execPath, [join(root, "scripts/contract-hash.mjs"), vector], {
        encoding: "utf8",
      }).trim();

      expect(hash).toBe("3023e1a3740c3e14335e0846faff8d38d78d75dca91cc2df6f9425b7ff13f679");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes when the contract says something different", () => {
    const dir = mkdtempSync(join(tmpdir(), "trovy-sdk-hash-"));
    try {
      const contract = JSON.parse(readFileSync(join(root, "openapi/v1.json"), "utf8")) as {
        paths: Record<string, unknown>;
      };
      contract.paths["/v1/not-a-real-operation"] = { get: { responses: {} } };
      const changed = join(dir, "changed.json");
      writeFileSync(changed, JSON.stringify(contract));

      const hash = execFileSync(process.execPath, [join(root, "scripts/contract-hash.mjs"), changed], {
        encoding: "utf8",
      }).trim();

      expect(hash).not.toBe(CONTRACT_SHA256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
