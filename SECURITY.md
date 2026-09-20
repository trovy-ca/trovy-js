# Security

## Reporting a vulnerability

Please do not open a public issue.

Use **Report a vulnerability** under this repository's Security tab. It opens a
private advisory that only the maintainers can see. If you cannot use GitHub,
write to hello@trovy.ca with "SECURITY" in the subject and we will move the
conversation somewhere private.

Tell us what you found, how to reproduce it, and which version. You will get an
answer within three working days. Please give us a reasonable chance to ship a
fix before you publish.

This covers the `@trovy/sdk` package and this repository. A problem with the
Trovy API or the hosted sign-up form itself is just as welcome, through the same
channel.

## Supported versions

The latest release on the `latest` tag, and the latest on `next` while a release
candidate is out. Fixes are not backported.

## What the package is designed to guarantee

If you find a way around one of these, that is a vulnerability.

- **A secret key cannot be used from a browser by accident.** The server client
  refuses to construct where a DOM exists, `@trovy/sdk/next` fails a build that
  imports it into client code, and the browser entries contain no code that
  accepts a secret key.
- **The sign-up form is always Trovy's.** The entries partners import have no
  option for the frame's origin. The one function that takes an origin refuses
  anything but Trovy's own hosts and loopback.
- **A message from the page cannot impersonate the form.** Five checks: origin,
  source window, marker, per-mount nonce, and the echoed publishable key. See
  [PROTOCOL.md](./PROTOCOL.md).
- **The link token does not leak.** With `linkUrl` it never leaves the loader's
  closure: not to a callback, not to the console, not into the DOM. It is sent
  only to the page's own origin, and redirects are not followed.
- **The customer id stays on the server.** The link route never returns it.
- **The link route only answers its own site's pages.** It requires a custom
  header, checks fetch metadata or `Origin`, accepts JSON only, and reads at most
  2 KB.
- **Errors do not carry secrets.** No error message, log line or response
  produced by this package contains a key, a token, or text from an upstream
  response.

## What it cannot do

A script running on the partner's own page, such as an XSS, acts with the
signed-in user's authority and can call the partner's link route like any other
request from that page. The package cannot tell the difference. The README's
advice for `onLinked` (be idempotent, never silently overwrite a different
customer id) is what limits the damage.

## How releases are protected

Releases are published by GitHub Actions through npm trusted publishing, with
provenance, from a tarball that passed `scripts/verify-pack.mjs`. The publishing
job checks out no code and installs nothing. No npm token exists. See
[RELEASING.md](./RELEASING.md).
