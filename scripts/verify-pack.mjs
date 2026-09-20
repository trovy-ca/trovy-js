// The tarball gate. What this script approves is the file that gets published:
// the release workflow uploads the .tgz made here and publishes that, without
// building or packing again.
//
//   node scripts/verify-pack.mjs      packs into ./artifacts, checks, prints the file and its hash
//
// Run `pnpm build` first. `pnpm verify` does both in order.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRIES, EXPECTED_PACKAGE_FILES } from "./entries.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const bin = (name) => join(root, "node_modules/.bin", name);

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

function run(label, command, args) {
  try {
    execFileSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (error) {
    problems.push(`${label} failed:\n${String(error.stdout ?? "")}${String(error.stderr ?? "")}`.trimEnd());
  }
}

// --- the manifest, before anything is packed -------------------------------

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

check(manifest.name === "@trovy/sdk", `package.json name is ${manifest.name}.`);
check(manifest.private !== true, "package.json is marked private.");
check(manifest.publishConfig?.access === "public", "publishConfig.access must be public: a scoped package is restricted by default.");
// Provenance is set by the release workflow. Set here, it would break the one
// publish that has to be done by hand.
check(manifest.publishConfig?.provenance === undefined, "publishConfig.provenance must not be set in package.json.");
check(Object.keys(manifest.dependencies ?? {}).length === 0, "the package must have no runtime dependencies.");
for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack", "prepublish", "prepublishOnly"]) {
  // Install hooks run on a partner's machine. Pack and publish hooks would
  // rebuild between this gate and the upload.
  check(manifest.scripts?.[hook] === undefined, `package.json has a ${hook} script.`);
}
for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
  check(meta.optional === true, `peer dependency ${name} must be optional.`);
}
check(
  JSON.stringify(Object.keys(manifest.peerDependencies ?? {}).sort()) === JSON.stringify(Object.keys(manifest.peerDependenciesMeta ?? {}).sort()),
  "every peer dependency needs a peerDependenciesMeta entry marking it optional.",
);

// `exports` has to say what the entries table says.
const exported = Object.keys(manifest.exports ?? {}).filter((key) => key !== "./package.json").sort();
const expectedExports = Object.keys(ENTRIES)
  .map((entry) => (entry === "index" ? "." : `./${entry.replace(/\/index$/, "")}`))
  .sort();
check(JSON.stringify(exported) === JSON.stringify(expectedExports), `exports are [${exported.join(", ")}], expected [${expectedExports.join(", ")}].`);

// The example is what a partner copies. It has to name the version being
// released, or the README sends them to an install that does not resolve.
const example = JSON.parse(readFileSync(join(root, "examples/next-app-router/package.json"), "utf8"));
check(
  example.dependencies?.["@trovy/sdk"] === manifest.version,
  `examples/next-app-router depends on @trovy/sdk ${example.dependencies?.["@trovy/sdk"]}, and this is ${manifest.version}.`,
);
check(example.dependencies?.["server-only"] === undefined && example.devDependencies?.["server-only"] === undefined,
  "the example must not install server-only: its build is the proof that Next resolves it alone.");

// --- pack ------------------------------------------------------------------

rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", artifacts], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
);
const tarball = join(artifacts, packed[0].filename.replace(/^@/, "").replace("/", "-"));

const unpacked = mkdtempSync(join(tmpdir(), "trovy-sdk-pack-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
  const pkg = join(unpacked, "package");

  // 1. Exactly these files. Not "at least", and not "nothing that looks wrong":
  //    a file nobody listed is a file nobody reviewed.
  const files = walk(pkg).map((path) => relative(pkg, path).split("\\").join("/")).sort();
  check(
    JSON.stringify(files) === JSON.stringify(EXPECTED_PACKAGE_FILES),
    `the tarball holds ${files.length} files, expected ${EXPECTED_PACKAGE_FILES.length}.\n` +
      `    unexpected: ${files.filter((f) => !EXPECTED_PACKAGE_FILES.includes(f)).join(", ") || "none"}\n` +
      `    missing:    ${EXPECTED_PACKAGE_FILES.filter((f) => !files.includes(f)).join(", ") || "none"}`,
  );

  // 2. The built-output checks, against what was packed rather than what is on disk.
  run("verify-dist on the tarball", process.execPath, [join(root, "scripts/verify-dist.mjs"), pkg]);

  // 3. Nothing private inside it.
  run("hygiene on the tarball", process.execPath, [join(root, "scripts/check-hygiene.mjs"), "--dir", pkg]);

  // 4. The manifest resolves the way Node, bundlers and TypeScript each expect.
  run("publint", bin("publint"), ["--strict", pkg]);
  // node10 cannot see subpath exports at all, by design of the package.
  run("are-the-types-wrong", bin("attw"), [tarball, "--profile", "node16"]);
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}

if (problems.length > 0) {
  rmSync(tarball, { force: true });
  console.error(`verify-pack: ${problems.length} problem(s). The tarball was deleted.\n`);
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
console.log(`verify-pack: ${relative(root, tarball)}`);
console.log(`             ${EXPECTED_PACKAGE_FILES.length} files, ${statSync(tarball).size} bytes, sha256 ${sha256}`);
