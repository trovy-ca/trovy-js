// What was built is what was meant to be built.
//
//   node scripts/verify-dist.mjs           checks ./dist
//   node scripts/verify-dist.mjs <dir>     checks <dir>/dist (an unpacked tarball)
//
// The tests exercise the source. A partner installs `dist`, and the ways a build
// can go wrong are ones no test of the source can see: a directive dropped, a
// peer dependency bundled in, the server client inlined into a browser entry.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_ENTRIES as BROWSER, ENTRIES, EXPECTED_DIST_FILES, SERVER_ENTRIES as SERVER } from "./entries.mjs";

const root = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Every module a built file pulls in at run time. */
function importsOf(code) {
  const found = new Set();
  for (const match of code.matchAll(/^\s*import\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gm)) found.add(match[1]);
  for (const match of code.matchAll(/^\s*export\s+[^"'()]*?\s+from\s+["']([^"']+)["']/gm)) found.add(match[1]);
  for (const match of code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) found.add(match[1]);
  for (const match of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.add(match[1]);
  return [...found].sort();
}

/** The directives a file opens with: string statements before any other code. */
function prologue(code) {
  const directives = [];
  for (const line of code.split("\n")) {
    const match = /^\s*(["'])(.*)\1;?\s*$/.exec(line);
    if (!match) break;
    directives.push(match[2]);
  }
  return directives;
}

// 1. Exactly the files the package.json's `exports` point at. No hashed chunk,
//    nothing left over from another build.
let actual = [];
try {
  actual = walk(dist).map((path) => relative(root, path).split("\\").join("/")).sort();
} catch {
  console.error("verify-dist: there is no dist. Run `pnpm build` first.");
  process.exit(1);
}
check(
  JSON.stringify(actual) === JSON.stringify(EXPECTED_DIST_FILES),
  `dist holds ${actual.length} files, expected ${EXPECTED_DIST_FILES.length}.\n` +
    `    unexpected: ${actual.filter((f) => !EXPECTED_DIST_FILES.includes(f)).join(", ") || "none"}\n` +
    `    missing:    ${EXPECTED_DIST_FILES.filter((f) => !actual.includes(f)).join(", ") || "none"}`,
);

const read = (file) => {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return "";
  }
};

for (const [entry, allowed] of Object.entries(ENTRIES)) {
  for (const ext of [".js", ".cjs"]) {
    const file = `dist/${entry}${ext}`;
    const code = read(file);

    // 2. Imports. A bundled devDependency is how private or unlicensed code
    //    reaches a tarball; an unexpected external is a crash on a partner's machine.
    const imports = importsOf(code);
    check(
      JSON.stringify(imports) === JSON.stringify([...allowed].sort()),
      `${file} imports [${imports.join(", ")}], expected [${allowed.join(", ")}].`,
    );

    // 3. Nothing the build was meant to replace is left.
    check(!code.includes("__SDK_VERSION__"), `${file} still contains the __SDK_VERSION__ placeholder.`);
  }
}

// 4. "use client" opens both React outputs. Without it a Server Component that
//    renders <TrovySignup> fails with an error about hooks, in the partner's app.
for (const ext of [".js", ".cjs"]) {
  const file = `dist/react/index${ext}`;
  const directives = prologue(read(file));
  check(directives.includes("use client"), `${file} does not open with "use client" (it opens with: ${JSON.stringify(directives)}).`);
  if (ext === ".js") check(directives[0] === "use client", `${file}: "use client" is not the first line.`);
}
for (const entry of Object.keys(ENTRIES).filter((name) => name !== "react/index")) {
  for (const ext of [".js", ".cjs"]) {
    check(!prologue(read(`dist/${entry}${ext}`)).includes("use client"), `dist/${entry}${ext} is marked "use client" and should not be.`);
  }
}

// 5. The version the client reports is the version being published.
for (const entry of SERVER) {
  for (const ext of [".js", ".cjs"]) {
    check(read(`dist/${entry}${ext}`).includes(JSON.stringify(version)), `dist/${entry}${ext} does not carry version ${version}.`);
  }
}

// 6. Browser entries hold no server client: no secret-key handling, no API host.
for (const entry of BROWSER) {
  for (const ext of [".js", ".cjs"]) {
    const code = read(`dist/${entry}${ext}`);
    for (const marker of ["Authorization", "Bearer ", "api.trovy.ca", "Idempotency-Key"]) {
      check(!code.includes(marker), `dist/${entry}${ext} contains ${JSON.stringify(marker)}: the server client was bundled into a browser entry.`);
    }
  }
}

// 7. Whether a partner's build is a production one is the partner's bundler's
//    call. A literal baked in here would show customers the developer error box.
for (const ext of [".js", ".cjs"]) {
  const code = read(`dist/react/index${ext}`);
  check(code.includes("process.env.NODE_ENV"), `dist/react/index${ext} no longer reads process.env.NODE_ENV: the build replaced it.`);
}

// 8. Server entries run where there is no Node: nothing from `node:`.
for (const entry of SERVER) {
  for (const ext of [".js", ".cjs"]) {
    check(!/["']node:/.test(read(`dist/${entry}${ext}`)), `dist/${entry}${ext} imports a node: module and would not run on the edge.`);
  }
}

// 9. Source maps point into src and carry no source text.
for (const file of actual.filter((name) => name.endsWith(".map"))) {
  const map = JSON.parse(read(file) || "{}");
  check(!("sourcesContent" in map), `${file} embeds sourcesContent.`);
  for (const source of map.sources ?? []) {
    const resolved = relative(root, resolve(join(root, file, ".."), source)).split("\\").join("/");
    check(resolved.startsWith("src/"), `${file} maps to ${source}, which is outside src/.`);
  }
}

if (problems.length > 0) {
  console.error(`verify-dist: ${problems.length} problem(s)\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`verify-dist: ${actual.length} files, ${Object.keys(ENTRIES).length} entries, version ${version}`);
