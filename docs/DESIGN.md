# Design

Why the package is shaped the way it is. The code says what it does; this says
why, so that a future change can tell a load-bearing decision from an accident.

## One package, four entries

An integration has a server half and a browser half, and a partner should be
able to read one README and install one thing. But the two halves must never
mix: the server half holds a key that can move money.

So they are one package and separate entries, kept apart three ways. Lint rules
stop browser code importing anything but the wire protocol and the loader. The
build fails a server entry that imports a Node API, since it is built for no
platform in particular. And `verify-dist` opens the built browser files and
fails if the client's code is inside them.

`react` and `server-only` are optional peers, so installing the package for its
server client pulls in neither. `next` is not a peer at all: nothing imports it.
The route handler is `Request` in, `Response` out, and a peer on a package that
is never imported is a claim with nothing behind it. The example app's build is
the proof of Next support.

## Each entry carries its own copy

The build does no code splitting. Shared chunks get hashed file names, and the
release gate checks the tarball against an exact list of files: a file nobody
listed is a file nobody reviewed.

The cost is that `/next` contains its own copy of the client, and `/react` its
own copy of the loader. That would break `instanceof`, so nothing uses it:
`isTrovyError`, `isTrovyConnectionError` and `isTrovyConfigError` match by
`name`. The same choice protects a partner whose dependency tree ends up with
two versions of the package.

## The loader ships in the package

The alternative was a script tag pointing at Trovy's host. Bundling means a
partner's page runs no third-party script, its Content Security Policy needs one
`frame-src` and nothing else, and the form works with whatever bundler,
framework and deploy process the partner already has.

What it costs is that a loader, once bundled, never updates by itself. That is
why the protocol between the form and the loader is additive only, forever, and
why tests hold both ends to it. See [PROTOCOL.md](../PROTOCOL.md).

One implementation serves every build. `createMount` holds all the behaviour
and takes the frame's origin; the npm entries bind it to `https://js.trovy.ca`,
and Trovy's hosted script binds the same function to the host it is served from.

## Nothing chooses where the form comes from

The form asks a customer for a phone number and a code they were just texted. If
a page could choose the frame's origin, a compromised partner site could show a
look-alike inside a frame the customer has every reason to trust.

So `mount` and `<TrovySignup>` have no origin option, for either kind of key.
`createMount` has to take one, and is reachable by anyone who reads
`package.json`, so it refuses any origin that is not Trovy's own host, a
subdomain label under it, or loopback.

## Reporting instead of throwing

`mount` throws on bad options, synchronously, before it creates anything or
makes any request. A secret key pasted into browser code must not leave the
page, and a typo should be loud in development.

`<TrovySignup>` catches that and reports it through `onError` instead. A thrown
error in a component takes down the nearest error boundary, which for most apps
is the page, and a sign-up form is not worth a checkout page. In development it
also draws the message where the form would be, because a blank box is the
failure a developer cannot debug.

Partner callbacks run inside a try/catch and are rethrown on a fresh task. A
bug in `onLinked` must not stop the loader working, and must not be swallowed
either: the page's error reporting sees it exactly as if nothing had caught it.

## The link flow lives in the loader, not in React

`linkUrl`, the retry budget and the state machine are in `createMount`. The
component is a thin binding. There is one implementation to test, and pages
without React get the same behaviour.

In this mode the link token never leaves the loader's closure. It is not in a
state, an error, a callback argument or the DOM, and tests check each.

**The route answers 409 for a dead token,** not the API's own 404, so the
component can tell "this token is finished" (send the customer round again)
from "there is no such route" (a bug in the page). Those need opposite
responses, and a customer should never be sent through a text-message cooldown
because of a typo in a path.

**`getUser` runs before the token is spent.** Spending is irreversible. If the
session has expired, the customer can sign in and try again with the same
token, which is only possible because nothing was spent finding that out. The
environment check (test key against live key) is early for the same reason.

**The retry window runs on the device's clock,** five minutes from the moment
the token arrived, not from the `expiresAt` the form reports. That timestamp is
the server's, and a phone whose clock is an hour out would read it as "expired
already" or "good for another hour". A local interval is right whatever the
clock says.

**An unknown outcome is remembered.** If a request got no answer, and the next
one is told the token is dead, the first one most likely worked. Reporting
"invalid" would be a guess, and usually the wrong one, so the component reports
`LINK_UNCONFIRMED`. The recovery is the same (verify again, which returns the
same customer), but the log tells the truth.

**`redirect: "manual"`.** A followed 307 re-sends the request body. A sign-in
middleware that answers an expired session with a redirect would have the
browser post the token to the login page.

## `server-only`

`@trovy/sdk/next` begins with `import "server-only"`. Next resolves that module
itself, to nothing in server code and to a build error in client code, which
turns "the secret key's code reached a browser bundle" from a review finding
into a failed build. The smoke test builds the example app without the package
installed, and then builds it again with the route imported from a Client
Component and requires that build to fail, so both halves of the claim are
checked on every release.

The client's own constructor check (it refuses to run where a DOM exists) is
the second line, for frameworks that have no such mechanism.

## Generated types are committed

`src/generated` is checked in, not built on install. A partner reading the
source sees the types their editor shows, `npm pack` has nothing to generate,
and there is no install script. The cost is that the committed files can go
stale, so a test regenerates them with the pinned generator and compares bytes.

`CONTRACT_SHA256` records which contract a release was generated from without
shipping the contract. It hashes a canonical form, keys sorted and code samples
dropped, because the same contract is served minified and decorated by the docs
site and would never match byte for byte.

## No runtime dependencies

Everything a dependency would add, a partner would have to audit, and the
package runs in checkouts. `fetch`, `crypto`, `URL` and `AbortController` are
enough. The release gate fails if `dependencies` is not empty, and fails if any
built file imports something outside its short allowlist, which is also how a
bundled devDependency would be caught.
