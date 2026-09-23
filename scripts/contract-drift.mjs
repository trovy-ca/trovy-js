// Is this repository's copy of the API contract still the one Trovy serves?
//
//   node scripts/contract-drift.mjs            compares with the published contract
//   node scripts/contract-drift.mjs --url <u>  compares with another copy
//
// Exit 0: the same contract. Exit 1: they differ (the difference is printed).
// Exit 2: the published contract could not be fetched, which says nothing either way.
//
// "The same" means the same canonical hash: the served file is minified and has
// code samples added, so its bytes never match the vendored one.
//
// It compares with the API's own copy, not the docs site's. The docs site publishes
// the contract as the docs present it, with a feature that is not launched yet (gift
// cards) taken out and a few sentences reworded, so it is never the whole contract
// this SDK is generated from. The API's copy is whole, but leaves out the error
// codes' descriptions (`x-enumDescriptions`), which are prose added for the docs;
// they are left out of both sides here, and nowhere else: CONTRACT_SHA256 still
// covers them.
//
// This only reports. The vendored file is replaced by hand, from the API's own
// repository, and `pnpm codegen` follows. See RELEASING.md.

import { readFileSync } from "node:fs";
import { contractHash, VENDORED_CONTRACT } from "./contract-hash.mjs";

const PUBLISHED = "https://api.trovy.ca/v1/openapi.json";

/** A copy without the error codes' descriptions, which only the committed contract carries. */
function withoutProse(value) {
  if (Array.isArray(value)) return value.map(withoutProse);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "x-enumDescriptions")
        .map(([key, inner]) => [key, withoutProse(inner)]),
    );
  }
  return value;
}

const flag = process.argv.indexOf("--url");
const url = flag === -1 ? PUBLISHED : process.argv[flag + 1];

const vendored = JSON.parse(readFileSync(VENDORED_CONTRACT, "utf8"));

let served;
try {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  served = await response.json();
} catch (error) {
  console.error(`contract-drift: could not fetch ${url}: ${error.message}`);
  process.exit(2);
}

const ours = contractHash(withoutProse(vendored));
const theirs = contractHash(withoutProse(served));

if (ours === theirs) {
  console.log(`contract-drift: in step with ${url} (${ours.slice(0, 12)})`);
  process.exit(0);
}

/** `METHOD /path` for every operation in a contract. */
const operationsOf = (contract) =>
  new Set(
    Object.entries(contract.paths ?? {}).flatMap(([path, methods]) =>
      Object.keys(methods)
        .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    ),
  );
const schemasOf = (contract) => new Set(Object.keys(contract.components?.schemas ?? {}));
const onlyIn = (a, b) => [...a].filter((item) => !b.has(item)).sort();

console.error(`contract-drift: the published contract differs from openapi/v1.json`);
console.error(`  vendored   ${ours}`);
console.error(`  published  ${theirs}\n`);
for (const [label, extract] of [
  ["operations", operationsOf],
  ["schemas", schemasOf],
]) {
  const added = onlyIn(extract(served), extract(vendored));
  const removed = onlyIn(extract(vendored), extract(served));
  if (added.length) console.error(`  ${label} the SDK does not have yet: ${added.join(", ")}`);
  if (removed.length) console.error(`  ${label} the SDK has and the API no longer publishes: ${removed.join(", ")}`);
}
console.error(`\n  Same operations and schemas? Then a field, a description or an enum changed. Diff the two files.`);
process.exit(1);
