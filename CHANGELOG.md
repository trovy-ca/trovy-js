# Changelog

All notable changes to `@trovy/sdk`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0.0 a minor version may
contain a breaking change, and it will be called out here.

`@trovy/sdk/widget/core` and `createTrovySignup` exist for Trovy's own builds and
are not covered by semver.

## 0.1.0-rc.1

No changes to the package. Proves the automated release pipeline.

## 0.1.0-rc.1

No changes to the package. Proves the automated release pipeline.

## 0.1.0-rc.0

First release candidate, published under the `next` tag. The API contract is
still being finalised: expect the generated types to change before `0.1.0`.

### Added

- `@trovy/sdk`: the typed server client for the Trovy API, covering customers,
  rewards and gift cards, with idempotency keys, retries with backoff, per-attempt
  timeouts and two error classes. It refuses to start in a browser.
- `@trovy/sdk/react`: `<TrovySignup>`, the sign-up form as a React component.
  Safe under server rendering and Strict Mode, and never remounted by a parent's
  re-render.
- `@trovy/sdk/next`: `createLinkHandler`, a route handler that exchanges the
  form's link token with your secret key and hands you the customer to save.
- `@trovy/sdk/widget`: `mount`, the same form for pages without React.
- `CONTRACT_SHA256`: which API contract this version was generated from.
