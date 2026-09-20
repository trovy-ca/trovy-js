import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OPERATIONS } from "../operations.js";

/**
 * The OPERATIONS table against the committed contract itself.
 *
 * `satisfies Record<keyof operations, …>` already makes a missing or renamed
 * operation a compile error. These tests cover what the type system cannot see:
 * that each entry's method, path and idempotency flag are the ones the API
 * actually implements. A path typo would otherwise ship as a 404 at a partner's
 * checkout, and a wrong `idempotent` flag as either a rejected write (missing
 * header) or a write with no replay protection at all.
 */

interface SpecOperation {
  operationId: string;
  parameters?: Array<{ name: string; in: string }>;
}

const specPath = fileURLToPath(new URL("../../openapi/v1.json", import.meta.url));
const spec = JSON.parse(readFileSync(specPath, "utf8")) as {
  paths: Record<string, Record<string, SpecOperation>>;
  components: {
    schemas: { Error: { properties: { code: { enum?: string[] } } } };
  };
};

/** Every operation in the spec, keyed by operationId. */
const fromSpec = new Map<string, { method: string; path: string; idempotent: boolean }>();
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    fromSpec.set(op.operationId, {
      method: method.toUpperCase(),
      path,
      idempotent: (op.parameters ?? []).some(
        (p) => p.in === "header" && p.name.toLowerCase() === "idempotency-key"
      ),
    });
  }
}

describe("OPERATIONS matches the committed contract", () => {
  it("covers every operation the API publishes, and no others", () => {
    expect(Object.keys(OPERATIONS).sort()).toEqual([...fromSpec.keys()].sort());
  });

  it.each([...fromSpec.entries()])("%s has the spec's method and path", (operationId, expected) => {
    const entry = OPERATIONS[operationId as keyof typeof OPERATIONS];
    expect(entry.method).toBe(expected.method);
    expect(entry.path).toBe(expected.path);
  });

  it.each([...fromSpec.entries()])(
    "%s agrees with the spec on whether an Idempotency-Key is required",
    (operationId, expected) => {
      expect(OPERATIONS[operationId as keyof typeof OPERATIONS].idempotent).toBe(
        expected.idempotent
      );
    }
  );

  // Guards against a path template whose `{…}` never gets substituted: the
  // request would go out with a literal brace and 404.
  it("declares a path parameter only where the spec has one", () => {
    for (const [operationId, entry] of Object.entries(OPERATIONS)) {
      const placeholders = [...entry.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const specOp = fromSpec.get(operationId)!;
      const specParams = [...specOp.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(placeholders).toEqual(specParams);
    }
  });

  it("uses only the two methods the API exposes", () => {
    for (const entry of Object.values(OPERATIONS)) {
      expect(["GET", "POST"]).toContain(entry.method);
    }
  });

  // Every write that touches money must be replayable. A GET never needs a key.
  it("asks for a key on no GET", () => {
    for (const [operationId, entry] of Object.entries(OPERATIONS)) {
      if (entry.method === "GET") {
        expect(entry.idempotent, `${operationId} is a GET`).toBe(false);
      }
    }
  });
});

/**
 * The README is published to npm and is the first thing a partner reads. An error
 * code named there that the API cannot return is advice that silently never
 * matches, and a near-miss of a real code (`MINIMUM_ORDER_NOT_MET` has plausible
 * misspellings) reads as correct to everyone who does not check.
 */
describe("the published README", () => {
  const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
  const codes = new Set(spec.components.schemas.Error.properties.code.enum ?? []);

  it("names only error codes the API can return", () => {
    const quoted = [...readme.matchAll(/"([A-Z][A-Z0-9_]{4,})"/g)].map((m) => m[1]!);
    const invented = [...new Set(quoted)].filter((code) => !codes.has(code));

    expect(invented).toEqual([]);
  });

  it("names at least one, so the check is not vacuous", () => {
    expect(/"[A-Z][A-Z0-9_]{4,}"/.test(readme)).toBe(true);
  });
});
