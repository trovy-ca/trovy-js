// The canonical hash of an OpenAPI contract.
//
// Two copies of the same contract rarely share bytes: a docs site may minify it
// and inject code samples, an editor may reorder keys. What has to match is what
// the contract SAYS. So: drop every `x-codeSamples`, sort every object's keys,
// serialise without whitespace, SHA-256 the result.
//
//   node scripts/contract-hash.mjs                 hash of openapi/v1.json
//   node scripts/contract-hash.mjs path/to.json    hash of another copy

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DROPPED_KEYS = new Set(["x-codeSamples"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (!DROPPED_KEYS.has(key)) out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

/** @param {unknown} contract a parsed OpenAPI document */
export function contractHash(contract) {
  return createHash("sha256").update(JSON.stringify(canonical(contract))).digest("hex");
}

export const VENDORED_CONTRACT = fileURLToPath(new URL("../openapi/v1.json", import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? VENDORED_CONTRACT;
  console.log(contractHash(JSON.parse(readFileSync(path, "utf8"))));
}
