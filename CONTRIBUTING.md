# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an
issue first, so nobody writes code that cannot be merged.

Security problems do not go in issues. See [SECURITY.md](./SECURITY.md).

## Setup

Node 22 (`.nvmrc`) and pnpm 9.

```bash
pnpm install
pnpm setup:react-18   # a second React, for the tests' React 18 leg
pnpm verify           # lint, types, tests, hygiene, build, and both release gates
```

`pnpm verify` is what CI runs. `pnpm smoke` then installs the tarball it made
into an empty project outside the repository, and `pnpm smoke:example` also
builds the example app against it. Both need the network.

## The layout

| Path | Runs | Notes |
| --- | --- | --- |
| `src/index.ts`, `client.ts`, `errors.ts`, `operations.ts` | server | The API client. |
| `src/generated/` | | Generated. `pnpm codegen`, never by hand. |
| `src/server/`, `src/next/` | server | The link route. |
| `src/widget/` | browser | The loader. |
| `src/react/` | browser | The component. |
| `src/link-protocol.ts` | both | What the component and the route say to each other. |

The entries are kept apart by lint rules in `eslint.config.js`, because the
build cannot do it: browser code importing the server client resolves perfectly
well here, and would ship a secret key's code path to a browser. If a rule gets
in your way, that is usually the rule working.

## Rules of the house

- **No runtime dependencies.** The package has none and `verify-pack` enforces it.
- **The protocols only grow.** Read the top of [PROTOCOL.md](./PROTOCOL.md) before
  changing a message, a field or a status code.
- **No origin options.** Nothing in the public entries may let a page choose
  where the sign-up form is served from.
- **Secrets never appear in output.** Not in an error, a log line, a response or
  a test snapshot. There are tests that check; add to them when you add output.
- **Tests state behaviour.** One behaviour per test, named as a sentence. When a
  guard matters, break it on purpose and watch a test fail before you trust it.
- **Exact versions.** `.npmrc` pins what you add. Dev tooling that drifts under a
  published package is a change nobody reviewed.

## The API contract

`openapi/v1.json` is Trovy's published contract, vendored. Do not edit it here:
it is replaced from the API's own source when the API changes, and
`pnpm codegen` regenerates `src/generated` from it. `pnpm contract:drift` tells
you whether the vendored copy is behind the published one.

## Hygiene

`pnpm hygiene` scans every file for things that must not be public: internal
hostnames, credentials, key-shaped strings, home directories, personal email
addresses. It runs over the repository and again over the packed tarball. Use
`example.com` addresses and single-character key fixtures
(`` `trv_test_${"a".repeat(64)}` ``) and it will stay out of your way.
