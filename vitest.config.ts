import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Three projects, because the package runs in two worlds and on two Reacts.
 *
 *   node       server code, tested where it runs, with no DOM to lean on by accident
 *   dom        the loader and the component, under jsdom, on the repository's React
 *   react-18   the component's tests again, on the oldest React the package supports
 *
 * React 18 lives in its own directory with its own install, so that `react-dom`
 * finds the `react` it was built for. The aliases below send the tests' imports
 * there. Testing Library has to follow: it is inlined, and pointed at its ESM
 * build, because an alias cannot reach the `require` calls of a CommonJS one.
 */
const react18 = fileURLToPath(new URL("./test/react-18/node_modules", import.meta.url));
const testingLibraryEsm = fileURLToPath(
  new URL("./node_modules/@testing-library/react/dist/@testing-library/react.esm.js", import.meta.url),
);

if (!existsSync(`${react18}/react/package.json`)) {
  throw new Error("React 18 is not installed for the react-18 test leg. Run: pnpm --dir test/react-18 install --ignore-workspace");
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/__tests__/**/*.test.ts", "src/server/**/*.test.ts", "src/next/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/widget/**/*.test.{ts,tsx}", "src/react/**/*.test.{ts,tsx}"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        resolve: {
          alias: [
            { find: /^@testing-library\/react$/, replacement: testingLibraryEsm },
            { find: /^react-dom($|\/)/, replacement: `${react18}/react-dom$1` },
            { find: /^react($|\/)/, replacement: `${react18}/react$1` },
          ],
        },
        test: {
          name: "react-18",
          environment: "jsdom",
          include: ["src/react/**/*.test.{ts,tsx}", "test/react-18/*.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
          server: { deps: { inline: [/@testing-library\/react/] } },
        },
      },
    ],
  },
});
