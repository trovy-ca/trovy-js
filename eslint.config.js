import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Beyond the usual rules, this file keeps the package's entry points apart.
 *
 * `@trovy/sdk` runs in two worlds. The root and `/next` run on a server and hold
 * a secret key; `/widget` and `/react` run in a browser and must never see one.
 * React and Next are optional peers, so an import of either from the wrong entry
 * is a crash for every partner who does not use that framework. The build would
 * not catch any of this: the wrong import resolves fine here, where every peer
 * is installed.
 */

const FRAMEWORK_IMPORTS = [
  { group: ["react", "react/*", "react-dom", "react-dom/*"], message: "React may only be imported under src/react: it is an optional peer." },
  { group: ["next", "next/*"], message: "Next may only be imported under src/next: it is an optional peer." },
  { group: ["server-only"], message: "server-only may only be imported by src/next/index.ts." },
];

// Browser code may reach exactly two things outside its own directory: the wire
// protocol it shares with the route, and the loader. An allowlist, because the
// thing being kept out is the client that holds a secret key, and a list of
// banned paths goes stale the day a file is added.
const SERVER_CODE = {
  group: ["../*", "!../link-protocol.js", "!../widget", "!../widget/*"],
  message: "Browser code may import ../link-protocol.js and ../widget only: everything else is server code, and the client carries a secret key.",
};

const browserOnly = (name) => ({
  name,
  message: `${name} does not exist where this code runs (Node, Workers, the edge). Reach it through globalThis after checking it is there.`,
});

const serverOnly = (name) => ({
  name,
  message: `${name} does not exist in a browser, which is where this code runs.`,
});

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "examples/**", "src/generated/**"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },

  // Everything that is not the React or Next entry: no framework imports.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/react/**", "src/next/**"],
    rules: { "no-restricted-imports": ["error", { patterns: FRAMEWORK_IMPORTS }] },
  },
  {
    files: ["src/react/**/*.{ts,tsx}"],
    ignores: ["src/react/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...FRAMEWORK_IMPORTS.slice(1),
            { group: ["react-dom", "react-dom/*"], message: "The component needs React only; react-dom is the app's business." },
            SERVER_CODE,
          ],
        },
      ],
    },
  },
  {
    files: ["src/next/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [FRAMEWORK_IMPORTS[0]] }],
    },
  },

  // Server code: no DOM.
  {
    files: ["src/*.ts", "src/server/**/*.ts", "src/next/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.test-d.ts"],
    rules: {
      "no-restricted-globals": ["error", ...["window", "document", "navigator", "location", "localStorage", "sessionStorage"].map(browserOnly)],
    },
  },

  // Browser code: no Node, and no way to the server client.
  {
    files: ["src/widget/**/*.ts", "src/react/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-globals": ["error", ...["process", "Buffer", "__dirname", "__filename", "require"].map(serverOnly)],
    },
  },
  {
    files: ["src/widget/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...FRAMEWORK_IMPORTS,
            SERVER_CODE,
          ],
        },
      ],
    },
  },

  // Hooks rules where hooks are.
  {
    files: ["src/react/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },

  // Build and release scripts are plain Node.
  {
    files: ["scripts/**/*.mjs", "*.config.{js,ts}"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly", fetch: "readonly", AbortSignal: "readonly" },
    },
    rules: { "no-console": "off" },
  },
);
