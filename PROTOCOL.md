# Protocol

Two conversations happen around the sign-up form. This file is their contract.

Both are **additive only, forever**. The loader is bundled into partners' apps,
so a copy built today is still running in somebody's production a year from now,
talking to whatever the form has become. Therefore:

- a field or message type, once shipped, keeps its meaning;
- a reader ignores fields and message types it does not know;
- a reader never requires a field that an older writer did not send.

`src/widget/__tests__/core.test.ts` and `src/server/__tests__/link-handler.test.ts`
hold both ends to this.

## 1. The form and the page

The loader creates one iframe:

```
https://js.trovy.ca/widget/v1/frame?pk=…&origin=…&nonce=…[&accent=…][&radius=…][&mode=…]
```

| Parameter | Value |
| --- | --- |
| `pk` | The publishable key, `trv_pk_live_…` or `trv_pk_test_…`. |
| `origin` | The embedding page's `window.location.origin`. The form posts messages to this origin and no other. Trovy checks it against the key's allowed origins, so a forged value gets a form that cannot be framed, not a token. |
| `nonce` | Random per mount. `crypto.randomUUID()`, or 16 bytes of `getRandomValues` as hex. |
| `accent` | Optional. `#rrggbb`, lower case. |
| `radius` | Optional. An integer, 0 to 24. |
| `mode` | Optional. `light`, `dark` or `system`. |

The loader validates the three theme values and drops anything else. The iframe
gets `allow=""` and is never `loading="lazy"`: a lazy frame below the fold would
not load, would not speak, and would be reported unavailable on a healthy page.

### Messages, form to page

Sent with `postMessage` to exactly `origin`. Every message has this envelope:

```json
{ "trovy": 1, "nonce": "<the mount's nonce>", "pk": "<the key the form loaded with>", "type": "trovy:…" }
```

| `type` | Extra fields | Meaning |
| --- | --- | --- |
| `trovy:ready` | none | The form has rendered. |
| `trovy:resize` | `height` (number, px) | The form's content height. The loader applies it, capped at 2000. |
| `trovy:success` | `linkToken` (string), `expiresAt` (ISO 8601), `firstName` (string, optional) | The customer verified. The token is single use and lives five minutes. |
| `trovy:error` | `code` (string), `message` (string) | The form hit a failure the page may want to know about. The form has already told the customer. |

`trovy:success` may be posted more than once for one verification. The loader
acts on the first.

### The five checks

The loader ignores a message unless all five hold:

1. `event.origin` is the frame's origin.
2. `event.source` is this iframe's `contentWindow`.
3. `data.trovy === 1`.
4. `data.nonce` is this mount's nonce.
5. `data.pk` is this mount's publishable key.

The first two prove the message came from a frame on Trovy's host, not from
another script on the page. The next two prove it belongs to *this* mount. The
fifth closes what the others leave open: a script on the page can read the nonce
from `iframe.src` and navigate that same element to the form with its own key.
`event.source` still matches, since it is the same element. The echoed key makes
the swap visible.

### Silence

A form that cannot load says nothing: a browser will not draw a frame on an
origin the key does not list, and an outage is only silence. So the loader keeps
the iframe hidden in a reserved 320 px until the first message that passes all
five checks, and after 10 seconds without one it hides the frame and reports
`WIDGET_UNAVAILABLE`. That is not final. A form that was only slow is shown when
it does speak, and the state moves back to `ready`.

There are no messages from the page to the form.

## 2. The component and the link route

After `trovy:success`, when the partner gave a `linkUrl`, the loader sends the
token to the partner's own route (`createLinkHandler`).

### Request

```
POST <linkUrl>                       same origin as the page, always
Content-Type: application/json
X-Trovy-Link: 1

{ "linkToken": "…", "environment": "live" | "sandbox" }
```

Sent with `mode: "same-origin"`, `credentials: "same-origin"`, `cache: "no-store"`,
`keepalive: true` and **`redirect: "manual"`**: a followed 307 re-posts its body,
and a sign-in middleware's redirect would deliver the token to a login page.

`environment` is which kind of publishable key the form ran with. The route
compares it with its secret key before spending the token. It is optional, so a
caller other than the component can use the route.

### Response

Always JSON, always `Cache-Control: no-store`.

```json
{ "ok": true, "customer": { "name": "Maria", "isNew": true } }
```

```json
{ "ok": false, "code": "LINK_TOKEN_INVALID", "message": "<a fixed sentence for this code>" }
```

| Status | `code` | Token |
| --- | --- | --- |
| 200 | none | spent; the customer is linked and saved |
| 400, 405, 413, 415 | `LINK_BAD_REQUEST` | unspent |
| 401 | `LINK_NOT_SIGNED_IN` | unspent |
| 403 | `LINK_FORBIDDEN` | unspent |
| 409 | `LINK_TOKEN_INVALID` | dead: expired, used, or not this business's |
| 500 | `LINK_SERVER_ERROR` | unspent |
| 500 | `LINK_SAVE_FAILED` | spent; `onLinked` threw |
| 502 | `LINK_UPSTREAM_UNAVAILABLE` | unknown: Trovy may have answered a connection that then dropped |
| 503 | `LINK_UPSTREAM_UNAVAILABLE` | unspent; carries `Retry-After` |

A dead token is a 409 and never a 404, so that the component can tell it from a
mistyped `linkUrl`. The customer id is never part of a response.

The component treats only `200` with `ok: true` and a well-formed `customer` as
success. Any other 200 is somebody else's page answering, and is reported as
`LINK_ENDPOINT_INVALID`. It trusts the route's `code` when it recognises it, and
otherwise goes by status.

### Trying again

Sending the same token again is harmless, because a second spend is refused, and
worth it, because verifying again can mean waiting out a text-message cooldown.
A token gets three requests within five minutes of arriving, measured on the
device's own clock. The second follows the first automatically, one second
later, after a rejected fetch or a 429, 502, 503 or 504. A request that timed
out (15 seconds) is not repeated automatically.

If a request whose outcome is unknown is followed by `LINK_TOKEN_INVALID`, the
component reports `LINK_UNCONFIRMED` instead: the earlier request most likely
linked the customer, and "invalid" would be a wrong guess.
