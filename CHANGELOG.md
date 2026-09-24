# Changelog

All notable changes to `@trovy/sdk`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0.0 a minor version may
contain a breaking change, and it will be called out here.

`@trovy/sdk/widget/core` and `createTrovySignup` exist for Trovy's own builds and
are not covered by semver.

## Unreleased

### Changed

- The README's errors section no longer calls every `TrovyError` final. A `5xx` that
  survives the SDK's retries may still have been applied, as the type docs already
  said, so the example retries it later with the same idempotency key.
- The README names the dashboard control where a publishable key's websites are set,
  says a newly saved website can take a minute to start working, and states exactly
  when an earn's `reward` is `null`.
- `TrovyError.requestId`'s hover text and the README say to quote it to
  hello@trovy.ca.

## 0.1.0

### Changed

- Gift cards are not generally available yet, so the README no longer lists them and
  the package's keywords no longer name them. `giftCards` stays on the client, marked
  `@experimental`: Trovy switches gift cards on per business, and they are not covered
  by semver until they launch.
- The README keys a refund by the refund's own id. Keyed by its order, as it was, a
  second partial refund of the same amount replayed the first and changed nothing.
  The redeem example no longer captures a negative amount on an order worth less than
  the reward, and says which refusals after capture leave the customer their reward.
- `pnpm contract:drift` compares with the API's own contract. The docs site's copy
  leaves out features that have not launched, so it would never match.

### Fixed

- `rewards.earn()`'s `reward` and `rewards.redeem()`'s `newReward` are typed
  `Reward | null`. They were typed as never null, so `earn.reward.id` compiled
  without a check and threw on an order too small to earn. Code that already
  checks (`earn.reward?.id`) is unaffected; code that did not now fails to
  compile where it would have failed at runtime.
- `WIDGET_UNAVAILABLE`'s message names this page's origin and says where to list
  it. It used to say only "The sign-up form could not be loaded", while the cause
  was visible only in the browser console.
- A secret key passed as `publishableKey` is called one, test or live alike. The
  message used to name only `trv_live_…`.
- `<TrovySignup>` calls `onStateChange("unavailable")` when its props are wrong,
  matching `data-trovy-state`. It used to leave a page that follows the callback
  on `loading`.
- The hover docs of `TrovyError.details` and `idempotencyKey` match the guides.

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
