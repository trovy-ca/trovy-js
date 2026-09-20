import { defineConfig, type Options } from "tsup";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

/**
 * One build per entry point, none of them sharing a chunk.
 *
 * `splitting: false` keeps the file names in `dist` fixed, which is what lets
 * `scripts/verify-pack.mjs` hold the tarball to an exact list. `treeshake: false`
 * keeps tsup's Rollup pass out of it: that pass drops module directives, and the
 * React entry is only a Client Component because its first line says so. Each
 * entry therefore inlines what it needs — `next` carries its own copy of the
 * client, `react` its own copy of the loader core — which is safe because errors
 * are matched by `name`, never by `instanceof`.
 */
const shared: Options = {
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  splitting: false,
  treeshake: false,
  // Array configs build concurrently; `pnpm build` clears `dist` once, up front.
  clean: false,
  define: {
    // Baked at build time so the User-Agent cannot drift from the published
    // version, and so nothing reads package.json at runtime.
    __SDK_VERSION__: JSON.stringify(version),
    // Left exactly as written. For a browser build esbuild would otherwise
    // replace it with "development", and the partner's production bundle would
    // show customers the component's developer-only error box.
    "process.env.NODE_ENV": "process.env.NODE_ENV",
  },
  esbuildOptions(options) {
    // Maps without embedded sources: stack frames stay useful and the tarball
    // stays small. The source is public; it lives in the repository.
    options.sourcesContent = false;
  },
};

export default defineConfig([
  // Server entries. `neutral` makes "runs on Node, Deno, Workers and the edge"
  // a build-time fact: a stray `node:` import fails the build.
  { ...shared, entry: { index: "src/index.ts" }, platform: "neutral", target: "es2022" },
  {
    ...shared,
    entry: { "next/index": "src/next/index.ts" },
    platform: "neutral",
    target: "es2022",
    external: ["server-only"],
  },
  // Browser entries. One config each, even for the two that share a directory:
  // entries built together share a declaration chunk with a hashed file name,
  // and a hash has no place in a tarball that is checked against an exact list.
  { ...shared, entry: { "widget/index": "src/widget/index.ts" }, platform: "browser", target: "es2019" },
  { ...shared, entry: { "widget/core": "src/widget/core.ts" }, platform: "browser", target: "es2019" },
  {
    ...shared,
    entry: { "react/index": "src/react/index.tsx" },
    platform: "browser",
    target: "es2019",
    external: ["react", "react/jsx-runtime"],
  },
]);
