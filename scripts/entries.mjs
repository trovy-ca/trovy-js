// The package's entry points, in one place for the gates that check them.
// `package.json` `exports` and `tsup.config.ts` say the same thing in their own
// formats; `verify-pack.mjs` fails if either disagrees with this.

/** Entry, and the only modules its built output may import. */
export const ENTRIES = {
  index: [],
  "next/index": ["server-only"],
  "react/index": ["react", "react/jsx-runtime"],
  "widget/index": [],
  "widget/core": [],
};

export const BROWSER_ENTRIES = ["react/index", "widget/index", "widget/core"];
export const SERVER_ENTRIES = ["index", "next/index"];

const OUTPUTS = [".js", ".js.map", ".cjs", ".cjs.map", ".d.ts", ".d.cts"];

export const EXPECTED_DIST_FILES = Object.keys(ENTRIES)
  .flatMap((entry) => OUTPUTS.map((ext) => `dist/${entry}${ext}`))
  .sort();

/** Everything a published tarball contains, and nothing else. */
export const EXPECTED_PACKAGE_FILES = [...EXPECTED_DIST_FILES, "CHANGELOG.md", "LICENSE", "README.md", "package.json"].sort();
