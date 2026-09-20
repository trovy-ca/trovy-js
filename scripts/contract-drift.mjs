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
// This only reports. The vendored file is replaced by hand, from the API's own
// repository, and `pnpm codegen` follows. See RELEASING.md.

import { readFileSync } from "node:fs";
import { contractHash, VENDORED_CONTRACT } from "./contract-hash.mjs";

const PUBLISHED = "https://developers.trovy.ca/openapi/v1.json";

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

const ours = contractHash(vendored);
const theirs = contractHash(served);

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
