# @trovy/sdk

[Trovy](https://www.trovy.ca) loyalty for your own app. Your customers join your
rewards program from your site, and your checkout earns and redeems rewards
through a typed API client. You take the payment; Trovy tracks the loyalty.

```bash
npm install @trovy/sdk
```

Zero runtime dependencies. Node 20 or newer on the server. React 18 or newer if
you use the component.

| Import | Runs | What it is |
| --- | --- | --- |
| `@trovy/sdk` | server | The API client: customers, rewards, gift cards. Takes your **secret** key. |
| `@trovy/sdk/react` | browser | `<TrovySignup>`, the sign-up form as a React component. Takes your **publishable** key. |
| `@trovy/sdk/next` | server | `createLinkHandler`, the route that joins the two. |
| `@trovy/sdk/widget` | browser | `mount`, the same form without a framework. |

Two keys, never swapped. The secret key (`trv_live_…`, `trv_test_…`) can move
money and stays on your server: the client refuses to start in a browser. The
publishable key (`trv_pk_live_…`, `trv_pk_test_…`) only opens the sign-up form
and is safe in a page: the form refuses anything else.

## Next.js in three steps

You need a Trovy business with the Developer API switched on, and both keys from
its dashboard. Start with the **test** pair: a test key reaches the sandbox, sends
no real texts, and accepts the fictional numbers listed in the
[docs](https://developers.trovy.ca/guides/customers).

**1. Keys.** In the dashboard, add your site's origin (`https://shop.example`,
and `http://localhost:3000` for development) to the publishable key's allowed
origins. Then:

```bash
# .env.local
TROVY_SECRET_KEY=trv_test_…
NEXT_PUBLIC_TROVY_PUBLISHABLE_KEY=trv_pk_test_…
```

**2. The route.** It learns who is signed in from *your* session, exchanges the
form's token for a Trovy customer id with the secret key, and hands you both to
save together.

```ts
// app/api/trovy/link/route.ts
import { createLinkHandler } from "@trovy/sdk/next";
import { auth } from "@/auth";
import { db } from "@/db";

export const POST = createLinkHandler({
  secretKey: process.env.TROVY_SECRET_KEY,
  getUser: async () => (await auth())?.user?.id ?? null,
  onLinked: async ({ userId, customer }) => {
    await db.user.update({ where: { id: userId }, data: { trovyCustomerId: customer.id } });
  },
});
```

**3. The form.** Anywhere in a page. It is a Client Component already, so a
Server Component can render it directly.

```tsx
import { TrovySignup } from "@trovy/sdk/react";

<TrovySignup
  publishableKey={process.env.NEXT_PUBLIC_TROVY_PUBLISHABLE_KEY!}
  linkUrl="/api/trovy/link"
  onLinked={({ name }) => router.refresh()}
/>;
```

That is the whole integration. The customer types a phone number and a texted
code into a form served by Trovy, inside your page; your route saves their Trovy
customer id against your user; and from then on your checkout can reward them:

```ts
import { Trovy } from "@trovy/sdk";

const trovy = new Trovy({ apiKey: process.env.TROVY_SECRET_KEY! });

await trovy.rewards.earn(
  { customerId: user.trovyCustomerId, orderId: order.id, amountCents: order.totalCents },
  { idempotencyKey: order.id }
);
```

A complete app is in [`examples/next-app-router`](./examples/next-app-router).

## `<TrovySignup>`

```tsx
<TrovySignup
  publishableKey="trv_pk_live_…"
  linkUrl="/api/trovy/link"                       // or onSuccess, never both
  onLinked={({ name, isNew }) => {}}              // linked AND saved by your route
  onError={({ stage, code, recovery }) => {}}
  onStateChange={(state) => {}}
  theme={{ accent: "#0f766e", radius: 12, mode: "system" }}
  title="Join our rewards"                        // the form's accessible name
  unavailableFallback={<p>Rewards are unavailable right now.</p>}
  renderLinkFailed={({ error, retry, reset }) => <MyNotice />}
  className="…" style={{}} id="…"
/>
```

- **It never throws.** A wrong key or `linkUrl` is reported through `onError`
  with `stage: "config"`, logged once, and shown on the page in development. A
  sign-up form should not be able to take a checkout page down.
- **It never remounts by accident.** Inline callbacks and a fresh `theme` object
  with the same values leave the form exactly as it was, with whatever the
  customer has typed. It starts over only when the key, the title, `linkUrl` or a
  theme *value* changes.
- **Server rendering.** It renders an empty box on the server and the same box
  on the first client render, so there is nothing to mismatch. Strict Mode leaves
  one form, not two.
- **`onLinked` never receives the customer id.** That stays on your server, in
  the route's `onLinked`. The browser learns `name` and `isNew`.
- A `ref` gives you `reset()` (start the form over) and `retry()` (send the same
  token to `linkUrl` again).

### States

`onStateChange`, and `data-trovy-state` on the component's outer element:

| State | Meaning |
| --- | --- |
| `loading` | The frame exists and has not spoken yet. Space is reserved; nothing is shown. |
| `ready` | The form is up. |
| `unavailable` | Ten seconds of silence. `unavailableFallback` is shown. Not final: a form that was only slow moves to `ready`. |
| `linking` | The customer verified; the token is on its way to `linkUrl`. |
| `linked` | Your route answered: linked and saved. |
| `link-failed` | `onError` has the reason and what can be done. |
| `success` | With `onSuccess` only: you have the token. |

### Errors

Every error has a `stage`, a `code` to branch on, and a `message` for your logs.
New codes can appear; handle the ones you know and treat the rest by `stage`.

| Stage | Codes | What to do |
| --- | --- | --- |
| `config` | `INVALID_CONFIG` | Fix the props. |
| `widget` | `WIDGET_UNAVAILABLE`, `WIDGET_ERROR`, and the form's own, such as `SMS_UNAVAILABLE` | Mostly nothing: the form tells the customer what to do. `WIDGET_UNAVAILABLE` on every load means this page's origin is not on the key's allowed list. |
| `link` | below | Follow `recovery`. |

A `link` error says what can be done *now*, in `recovery`:

| `recovery` | Codes | Meaning |
| --- | --- | --- |
| `retry` | `LINK_NETWORK_ERROR`, `LINK_UPSTREAM_UNAVAILABLE` | Nothing was decided. The same token can be sent again (`retry()`). The component already tried twice. |
| `sign-in` | `LINK_NOT_SIGNED_IN` | Your `getUser` returned null. The token is unspent: sign the customer in, then `retry()`. |
| `verify-again` | `LINK_TOKEN_INVALID`, `LINK_UNCONFIRMED`, `LINK_SAVE_FAILED` | This token is finished. `reset()` and the customer verifies again, which returns the same customer. |
| `developer` | `LINK_FORBIDDEN`, `LINK_BAD_REQUEST`, `LINK_ENDPOINT_INVALID`, `LINK_SERVER_ERROR` | The integration is wrong; nothing the customer does will help. See the route's log. |

A token gets three attempts and five minutes. Once either runs out, `retry`
becomes `verify-again`, so the default notice never offers a button that cannot
work. The default notice is unstyled and inherits your page; target
`[data-trovy-notice]` to dress it, or replace it with `renderLinkFailed`.

`LINK_ENDPOINT_INVALID` most often means `linkUrl` is mistyped, the route does
not export `POST`, or a sign-in middleware answers it with a redirect. Exclude the
route from redirecting middleware and let `getUser` return null instead: that is
a `sign-in` the customer can recover from, where a redirect is a dead end.

### Content Security Policy

The form is an iframe from one host, and the package loads no script from
anywhere:

```
frame-src https://js.trovy.ca;
```

## `createLinkHandler`

```ts
createLinkHandler({
  secretKey,        // string | undefined. Checked on the first request, not at import: a build has no secrets.
  getUser,          // (request) => user id, or null. Runs BEFORE the token is spent.
  onLinked,         // ({ userId, customer, request }) => save customer.id against userId
  onError,          // optional: failures your server should hear about. Defaults to console.error.
  allowedOrigins,   // optional: only behind a proxy that hides the public host
});
```

It is a web-standard `(Request) => Promise<Response>` and runs on the Node and
edge runtimes alike. Missing `getUser` or `onLinked` throws when the module loads,
where your build shows it.

- **Make `onLinked` idempotent.** A customer who verifies twice links twice, with
  the same `customer.id`.
- **Do not silently overwrite a different id.** If this user already has another
  Trovy customer id stored, something unusual is happening (a shared device, or a
  script on your page acting for the user). Keep the old one and look into it.
- **If `onLinked` throws**, the token is already spent. The browser is told
  `LINK_SAVE_FAILED`, and your `onError` receives `userId` and `customer`, so the
  link can be saved by other means. Verifying again also returns the same id.
- **What it refuses.** Anything but a JSON `POST` from your own pages: it requires
  a custom header (which a cross-site page cannot send without a preflight the
  route never answers), checks fetch metadata or `Origin` against the host it was
  reached on, and reads at most 2 KB.
- **What it never says.** Responses carry a fixed sentence per code. Nothing Trovy
  answered, no key and no token appears in a response, in `onError`, or in a log
  line.

A script running on your own page (an XSS) acts as your user and can submit a
token like any other request from that page. No route can tell the difference;
the second bullet above is the defence.

## Without React

```ts
import { mount } from "@trovy/sdk/widget";

const form = mount("#rewards", {
  publishableKey: "trv_pk_live_…",
  linkUrl: "/api/trovy/link",
  onLinked: ({ name }) => showThanks(name),
  onError: ({ stage, code, recovery }) => {},
});

form.retryLink(); // after a `retry` or `sign-in` failure
form.reset();     // after `verify-again`
form.unmount();
```

Same options, states and errors as the component. `mount` throws a
`TrovyConfigError` for wrong options (check with `isTrovyConfigError`), before it
creates anything or makes any request. Importing the module on a server is safe;
calling `mount` there is not, and says so.

## Exchanging the token yourself

If you would rather own the request, pass `onSuccess` instead of `linkUrl`:

```tsx
<TrovySignup
  publishableKey="trv_pk_live_…"
  onSuccess={({ linkToken }) => fetch("/api/my-own-route", { method: "POST", body: JSON.stringify({ linkToken }) })}
/>
```

```ts
// on your server
const { customer } = await trovy.customers.link({ linkToken });
```

The token is single-use and lives five minutes. `customers.link` is the one call
the client never retries, because the first attempt spends the token.

## The server client

```ts
import { Trovy, isTrovyError } from "@trovy/sdk";

const trovy = new Trovy({ apiKey: process.env.TROVY_SECRET_KEY! });

// The base URL comes from the key: a test key reaches the sandbox, a live key
// reaches production. There is nothing to configure and no way to cross over.
const { business } = await trovy.business.get();
console.log(business.name, business.currency); // "Sunny Threads" "CAD"
```

### Earn on a paid order

```ts
const earn = await trovy.rewards.earn(
  {
    customerId: user.trovyCustomerId, // from the link, not a phone number
    orderId: "ORD-10233",             // your own id
    amountCents: 5000,                // what the customer paid you
  },
  { idempotencyKey: "ORD-10233" }
);

console.log(earn.earnedCents, earn.reward?.valueCents);
```

### Redeem on the next one

`reward` is `null` when the order was too small to earn a whole dollar, so check it
rather than asserting it:

```ts
if (!earn.reward) return; // nothing to redeem yet

const redeem = await trovy.rewards.redeem(
  {
    customerId: user.trovyCustomerId,
    rewardId: earn.reward.id,
    orderId: "ORD-10456",
    amountCents: 4200,
  },
  { idempotencyKey: "ORD-10456" }
);
```

Redeem **before** you capture payment: the response tells you how much came off,
and the amount you charge is yours to compute from it.

### Refund

```ts
await trovy.rewards.refund(
  { orderId: "ORD-10233", amountCents: 5000 },
  { idempotencyKey: "refund-ORD-10233" }
);
```

### Idempotency

Every write that moves money takes an `Idempotency-Key`. Supply your own — **your
order id is the right choice** — so that a retry from a *different process* (a
redeployed worker, a queue redelivery, a user double-tapping Pay) replays the first
result instead of applying a second reward.

Keys must be 1–128 characters of letters, digits, `.`, `_` or `-`. If your order
ids look like `#1001` or `ORD/2026/01`, strip or translate the rest — the SDK
refuses an invalid key before sending, so you find out in development rather than
at a customer's checkout.

If you omit it the SDK generates a UUID. That covers the SDK's own retries within
one call and nothing beyond them: a new process generates a new key and would
apply the write twice.

Replaying a key with a *different* body is refused with `IDEMPOTENCY_MISMATCH`
(409) rather than silently returning the old answer.

### Errors

```ts
try {
  await trovy.rewards.redeem(body, { idempotencyKey: order.id });
} catch (err) {
  if (isTrovyError(err)) {
    // The API answered and said no. Branch on `code`, never on the message.
    if (err.code === "REWARD_NOT_FOUND") return showNoRewardAvailable();
    if (err.code === "MINIMUM_ORDER_NOT_MET") return showThreshold(err.message);
    if (err.status === 429) return backOff(err.retryAfterSeconds);
    console.error(err.code, err.requestId); // quote requestId to support
  }
  throw err; // a TrovyConnectionError, or something of yours
}
```

| Class | Meaning |
| --- | --- |
| `TrovyError` | The API answered. `status`, `code`, `requestId`, `details`, `retryAfterSeconds`. The decision is final for this request. |
| `TrovyConnectionError` | No answer came back after every retry. `attempts`, and the underlying failure as `cause`. The write **may or may not** have been applied — retry with the same idempotency key. |

Use `isTrovyError` / `isTrovyConnectionError` rather than `instanceof`, which
breaks when two copies of the package end up in one dependency tree.

### Retries and timeouts

```ts
const trovy = new Trovy({
  apiKey: process.env.TROVY_SECRET_KEY!,
  maxRetries: 2,    // default; 0 disables retrying
  timeoutMs: 30_000 // default, per attempt
});
```

The SDK retries a network failure, a timeout, and a 5xx other than 501, with
jittered backoff, honouring `Retry-After`. It never retries a 4xx — **including
429**: a rate limit comes back as a `TrovyError` carrying `retryAfterSeconds`, so
your own queue decides when to go again rather than a checkout request stalling
for thirty seconds.

`timeoutMs` is **per attempt**, so the worst case for a write is roughly
`(maxRetries + 1) × timeoutMs` plus backoff. Size it against whatever deadline your
own request is under.

Pass a `signal` to cancel. An abort stops the SDK immediately, including partway
through a backoff wait. The rejection is your signal's own reason, so an
`AbortSignal.timeout` rejects with a `TimeoutError` rather than a Trovy error:

```ts
await trovy.business.get({ signal: AbortSignal.timeout(2_000) });
```

### Currency

Every `…Cents` field is counted in the business's own currency, which
`business.get()` reports. One business has one currency and it cannot change once
it has transacted, so read it at setup rather than on every call. Trovy does no
conversion.

### API surface

| Method | Operation |
| --- | --- |
| `business.get()` | The business behind the key, its program and its currency |
| `business.listStores()` | Active locations |
| `customers.link(body)` | Exchange a link token for your customer id |
| `customers.lookup(body)` | Whether a phone number is already linked to you |
| `rewards.list(customerId)` | A customer's live rewards |
| `rewards.earn(body, opts)` | Record a paid order and earn |
| `rewards.redeem(body, opts)` | Apply a reward to an order |
| `rewards.refund(body, opts)` | Reverse an order and claw the reward back |
| `giftCards.create(body, opts)` | Issue a card you sold |
| `giftCards.lookup(body)` | Balance and status by code |
| `giftCards.redeem(body, opts)` | Spend against a card |
| `giftCards.reverseRedemption(id, body, opts)` | Put a debit back |
| `giftCards.void(id)` | Void a card you issued |

Every request and response type is generated from the same OpenAPI document the
API serves, so what your editor shows is what goes over the wire. The schemas are
exported too:

```ts
import type { components } from "@trovy/sdk";
type EarnRequest = components["schemas"]["EarnRequest"];
```

`CONTRACT_SHA256` names the exact contract this version was generated from.

## Documentation

Guides, the API reference and a sandbox to try calls against:
[developers.trovy.ca](https://developers.trovy.ca). How the form talks to the
page is in [PROTOCOL.md](./PROTOCOL.md); how to report a vulnerability is in
[SECURITY.md](./SECURITY.md).

## License

MIT
