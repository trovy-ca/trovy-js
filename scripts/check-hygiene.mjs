// Nothing private in a public repository, and nothing private in the tarball.
//
//   node scripts/check-hygiene.mjs              every file git would publish
//   node scripts/check-hygiene.mjs --dir <path> every file under <path> (an unpacked tarball)
//
// This package was split out of a private codebase, and this is the check that
// keeps the split clean. Its rules describe SHAPES, never names: a list of the
// private hosts and words to look for would itself publish them.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// The only Trovy hosts that are public knowledge. Any other name under the
// domain is an internal one, whatever it happens to be called.
const PUBLIC_HOSTS = new Set(["trovy.ca", "www.trovy.ca", "api.trovy.ca", "api.sandbox.trovy.ca", "js.trovy.ca", "developers.trovy.ca"]);
// Made up, for the tests that prove which origins the loader refuses.
const INVENTED_HOSTS = new Set(["js.preview.trovy.ca", "xjs.trovy.ca", "js.a.b.trovy.ca", "js.-a.trovy.ca"]);

const TEST_DOMAINS = /(^|\.)(example|test|invalid|localhost)$|(^|\.)example\.(com|org|net)$/;

/** @type {{ name: string, pattern: RegExp, secret?: boolean, allow?: (match: RegExpExecArray) => boolean, skip?: (file: string) => boolean }[]} */
const RULES = [
  {
    name: "a Trovy host that is not one of the public ones",
    pattern: /(?<![a-z0-9.-])((?:[a-z0-9-]+\.)*trovy\.ca)(?![a-z0-9-]|\.[a-z])/gi,
    allow: (match) => PUBLIC_HOSTS.has(match[1].toLowerCase()) || INVENTED_HOSTS.has(match[1].toLowerCase()),
  },
  {
    name: "a hosting provider's domain (deployment detail)",
    pattern: /\b[a-z0-9.-]*\.(?:railway\.app|vercel\.app|supabase\.(?:co|com|in)|herokuapp\.com|netlify\.app|fly\.dev|onrender\.com|ngrok(?:-free)?\.(?:io|app|dev)|amazonaws\.com|azurewebsites\.net|run\.app|workers\.dev|pages\.dev)\b/gi,
  },
  { name: "a path into another repository's layout", pattern: /\b(?:apps|packages)\/[a-z][a-z0-9-]*\//g },
  { name: "a reference to an internal decision record", pattern: /\bADR-\d+\b/g },
  { name: "a reference to an internal context file", pattern: /\bCONTEXT\.md\b/g },
  { name: "a workspace protocol dependency", pattern: /\bworkspace:[*^~\d]/g },
  { name: "the name of a pre-production environment", pattern: /\bstaging\b/gi },
  {
    name: "something shaped like a real secret key",
    secret: true,
    pattern: /\btrv_(?:live|test)_([0-9a-f]{64})\b|\btrv_pk_(?:live|test)_([0-9a-f]{32})\b/g,
    // Fixtures are one character repeated. A real key never is.
    allow: (match) => new Set(match[1] ?? match[2]).size === 1,
  },
  {
    name: "a credential",
    secret: true,
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bnpm_[A-Za-z0-9]{36}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJhbGciOi[A-Za-z0-9_-]{10,}/g,
  },
  {
    name: "somebody's home directory",
    pattern: /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[A-Za-z0-9._-]+/g,
    allow: (match) => /\/(runner|node|user|you|me)$/i.test(match[0]),
  },
  {
    name: "an address other than hello@trovy.ca, or a personal one",
    pattern: /\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g,
    allow: (match) => {
      const domain = match[1].toLowerCase();
      // One Trovy mailbox is read. Any other would send a partner somewhere nobody answers.
      if (domain === "trovy.ca") return match[0].toLowerCase() === "hello@trovy.ca";
      return domain === "users.noreply.github.com" || TEST_DOMAINS.test(domain);
    },
    // Integrity hashes and peer-dependency notation read like addresses to a regex.
    skip: (file) => file === "pnpm-lock.yaml",
  },
];

// This file is the rules, so it matches them. It is the one exemption, by path.
const SELF = "scripts/check-hygiene.mjs";

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|tgz|gz|zip)$/i;
const NEVER_PUBLISHED = new Set(["node_modules", ".git", "dist", "coverage", "artifacts", ".next"]);

function walk(dir, skipBuildOutput) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (skipBuildOutput && NEVER_PUBLISHED.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path, skipBuildOutput));
    else found.push(path);
  }
  return found;
}

function filesOf(base, isTarball) {
  if (isTarball) return walk(base, false);
  try {
    // What git would publish: tracked, plus untracked-but-not-ignored.
    const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: base,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return listed.split("\0").filter(Boolean).map((file) => join(base, file));
  } catch {
    // Not a repository yet. Everything that is not build output.
    return walk(base, true).filter((file) => !file.endsWith(".tgz"));
  }
}

const flag = process.argv.indexOf("--dir");
const base = flag === -1 ? root : resolve(process.argv[flag + 1] ?? "");
const files = filesOf(base, flag !== -1);

const findings = [];
for (const path of files) {
  const file = relative(base, path).split("\\").join("/");
  if (BINARY.test(file) || (flag === -1 && file === SELF)) continue;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue; // listed by git, deleted on disk
  }
  const lines = text.split("\n");
  for (const rule of RULES) {
    if (rule.skip?.(file)) continue;
    lines.forEach((line, index) => {
      rule.pattern.lastIndex = 0;
      for (let match; (match = rule.pattern.exec(line)); ) {
        if (rule.allow?.(match)) continue;
        // This runs in a public CI log. It says where a secret is, not what it is.
        const shown = rule.secret ? `${match[0].slice(0, 10)}…` : match[0].slice(0, 60);
        findings.push(`${file}:${index + 1}  ${rule.name}: ${shown}`);
      }
    });
  }
}

if (findings.length > 0) {
  console.error(`hygiene: ${findings.length} finding(s) in ${files.length} files\n`);
  for (const finding of findings) console.error(`  ${finding}`);
  console.error("\nIf one of these is public after all, widen the rule that caught it, in scripts/check-hygiene.mjs, and say why.");
  process.exit(1);
}
console.log(`hygiene: ${files.length} files clean`);
