// Install the tarball the way a partner does, somewhere that cannot see this
// repository, and use every entry.
//
//   node scripts/smoke.mjs             import, require and type-check every entry
//   node scripts/smoke.mjs --example   also build examples/next-app-router against the tarball
//
// Needs the network (it installs from the npm registry) and the tarball that
// `pnpm verify` leaves in ./artifacts.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const withExample = process.argv.includes("--example");
const { devDependencies: pinned } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

let tarballs = [];
try {
  tarballs = readdirSync(join(root, "artifacts")).filter((name) => name.endsWith(".tgz"));
} catch {
  // handled below
}
if (tarballs.length !== 1) {
  console.error("smoke: expected exactly one tarball in ./artifacts. Run `pnpm verify` first.");
  process.exit(1);
}
const tarball = join(root, "artifacts", tarballs[0]);

const step = (name) => console.log(`smoke: ${name}`);
const sh = (cwd, command, args, env = {}) =>
  execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, ...env } });

function attempt(name, work) {
  step(name);
  try {
    work();
  } catch (error) {
    console.error(`\nsmoke: FAILED at "${name}"\n`);
    console.error(String(error.stdout ?? ""), String(error.stderr ?? error.message ?? error));
    process.exitCode = 1;
    throw error;
  }
}

const dir = mkdtempSync(join(tmpdir(), "trovy-sdk-smoke-"));
const FIXTURE_SECRET = `trv_test_${"a".repeat(64)}`;
const FIXTURE_PUBLISHABLE = `trv_pk_test_${"a".repeat(32)}`;

const BUILD_ENV = { TROVY_SECRET_KEY: "", NEXT_PUBLIC_TROVY_PUBLISHABLE_KEY: FIXTURE_PUBLISHABLE, NEXT_TELEMETRY_DISABLED: "1" };

const ASSERT = `const assert = (ok, what) => { if (!ok) throw new Error("smoke: " + what); };`;

// What a server bundle does: the client, and the route.
const USE_SERVER_ENTRIES = `
  ${ASSERT}
  assert(typeof root.Trovy === "function", "Trovy is exported");
  assert(/^[0-9a-f]{64}$/.test(root.CONTRACT_SHA256), "CONTRACT_SHA256 is a hash");
  assert(Object.keys(root.OPERATIONS).length > 0, "OPERATIONS is populated");
  const client = new root.Trovy({ apiKey: ${JSON.stringify(FIXTURE_SECRET)} });
  assert(client.environment === "sandbox" && client.baseUrl === "https://api.sandbox.trovy.ca", "a test key reaches the sandbox");

  assert(typeof next.createLinkHandler === "function", "createLinkHandler is exported");
  const handler = next.createLinkHandler({ secretKey: undefined, getUser: () => null, onLinked() {} });
  assert(typeof handler === "function", "a handler is created with no secret key set");
`;

// What a browser bundle does, and what server rendering does with it. Importing
// these in plain Node proves nothing touches a DOM at import.
const USE_BROWSER_ENTRIES = `
  ${ASSERT}
  assert(typeof widget.mount === "function", "mount is exported");
  let refused;
  try { widget.mount("#x", { publishableKey: ${JSON.stringify(FIXTURE_PUBLISHABLE)}, onSuccess() {} }); } catch (error) { refused = error; }
  assert(widget.isTrovyConfigError(refused) && /needs a browser/.test(refused.message), "mount says it needs a browser");
  assert(typeof core.createMount === "function", "createMount is exported");
  let refusedOrigin;
  try { core.createMount({ frameOrigins: { live: "https://evil.example", test: "https://evil.example" } }); } catch (error) { refusedOrigin = error; }
  assert(widget.isTrovyConfigError(refusedOrigin), "createMount refuses a foreign origin");

  assert(react.TrovySignup && typeof react.createTrovySignup === "function", "TrovySignup is exported");
  const html = server.renderToString(React.createElement(react.TrovySignup, { publishableKey: ${JSON.stringify(FIXTURE_PUBLISHABLE)}, linkUrl: "/api/trovy/link" }));
  assert(html === '<div data-trovy-state="loading"><div></div></div>', "TrovySignup renders an empty box on a server, got " + html);
`;

try {
  attempt("install the tarball into an empty project", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }, null, 2));
    const peers = ["react", "react-dom", "typescript", "@types/react", "@types/react-dom", "@types/node", "server-only"];
    sh(dir, "npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball, ...peers.map((name) => `${name}@${pinned[name]}`)]);
  });

  attempt("import every entry as ESM", () => {
    writeFileSync(
      join(dir, "server.mjs"),
      `import * as root from "@trovy/sdk";
       import * as next from "@trovy/sdk/next";
       ${USE_SERVER_ENTRIES}`,
    );
    // `react-server` is the condition a framework sets for server code, and the
    // one under which `server-only` resolves to nothing instead of throwing.
    sh(dir, process.execPath, ["--conditions=react-server", "server.mjs"]);

    writeFileSync(
      join(dir, "browser.mjs"),
      `import * as widget from "@trovy/sdk/widget";
       import * as core from "@trovy/sdk/widget/core";
       import * as react from "@trovy/sdk/react";
       import React from "react";
       import * as server from "react-dom/server";
       ${USE_BROWSER_ENTRIES}`,
    );
    sh(dir, process.execPath, ["browser.mjs"]);
  });

  attempt("require every entry as CommonJS", () => {
    writeFileSync(
      join(dir, "server.cjs"),
      `const root = require("@trovy/sdk");
       const next = require("@trovy/sdk/next");
       ${USE_SERVER_ENTRIES}`,
    );
    sh(dir, process.execPath, ["--conditions=react-server", "server.cjs"]);

    writeFileSync(
      join(dir, "browser.cjs"),
      `const widget = require("@trovy/sdk/widget");
       const core = require("@trovy/sdk/widget/core");
       const react = require("@trovy/sdk/react");
       const React = require("react");
       const server = require("react-dom/server");
       ${USE_BROWSER_ENTRIES}`,
    );
    sh(dir, process.execPath, ["browser.cjs"]);
  });

  attempt("refuse to load the server route outside a server environment", () => {
    writeFileSync(join(dir, "client.mjs"), `import "@trovy/sdk/next";`);
    let loaded = true;
    try {
      sh(dir, process.execPath, ["client.mjs"]);
    } catch {
      loaded = false;
    }
    if (loaded) throw new Error("@trovy/sdk/next loaded without the react-server condition: server-only is not doing its job.");
  });

  attempt("type-check a project that uses every entry, under both module resolutions", () => {
    cpSync(join(root, "scripts/smoke-sample.tsx"), join(dir, "sample.tsx"));
    for (const [module, moduleResolution] of [
      ["NodeNext", "NodeNext"],
      ["ESNext", "Bundler"],
    ]) {
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            module,
            moduleResolution,
            jsx: "react-jsx",
            strict: true,
            // The point: our declarations are checked, not skipped.
            skipLibCheck: false,
            noEmit: true,
            types: ["node"],
          },
          files: ["sample.tsx"],
        }),
      );
      sh(dir, join(dir, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
    }
  });

  if (withExample) {
    const app = join(dir, "example");
    attempt("build examples/next-app-router against the tarball", () => {
      cpSync(join(root, "examples/next-app-router"), app, {
        recursive: true,
        filter: (source) => !/(^|[\\/])(node_modules|\.next)([\\/]|$)/.test(source.slice(root.length)),
      });
      const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
      manifest.dependencies["@trovy/sdk"] = `file:${tarball}`;
      writeFileSync(join(app, "package.json"), JSON.stringify(manifest, null, 2));
      sh(app, "npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]);
      // Deliberately not installed: Next has to resolve it by itself.
      try {
        readFileSync(join(app, "node_modules/server-only/package.json"));
        throw new Error("server-only is installed in the example; the build would not prove Next resolves it alone.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // A Server Component renders the form directly, with no wrapper of its
      // own marked "use client". Only the package's directive makes that legal.
      mkdirSync(join(app, "app/direct"), { recursive: true });
      writeFileSync(
        join(app, "app/direct/page.tsx"),
        `import { TrovySignup } from "@trovy/sdk/react";
         export default function Page() {
           return <TrovySignup publishableKey=${JSON.stringify(FIXTURE_PUBLISHABLE)} linkUrl="/api/trovy/link" />;
         }`,
      );
      sh(app, join(app, "node_modules/.bin/next"), ["build"], BUILD_ENV);
    });

    attempt("fail the build when client code imports the route entry", () => {
      writeFileSync(
        join(app, "app/direct/leak.tsx"),
        `"use client";
         import { createLinkHandler } from "@trovy/sdk/next";
         export function Leak() { return <p>{typeof createLinkHandler}</p>; }`,
      );
      writeFileSync(
        join(app, "app/direct/page.tsx"),
        `import { Leak } from "./leak";
         export default function Page() { return <Leak />; }`,
      );
      let built = true;
      let output = "";
      try {
        sh(app, join(app, "node_modules/.bin/next"), ["build"], BUILD_ENV);
      } catch (error) {
        built = false;
        output = String(error.stdout ?? "") + String(error.stderr ?? "");
      }
      if (built) throw new Error("the build accepted @trovy/sdk/next inside a Client Component: the secret key's code can reach a browser bundle.");
      if (!/server-only|Server Component|only works in/i.test(output)) {
        throw new Error("the build failed, but not because of server-only:\n" + output.slice(-2000));
      }
    });
  }

  console.log("smoke: ok");
} catch {
  // `attempt` has already said what failed.
} finally {
  rmSync(dir, { recursive: true, force: true });
}
