# Trovy + Next.js (App Router)

The whole integration, in an app small enough to read in five minutes.

| File | What it shows |
| --- | --- |
| [`app/api/trovy/link/route.ts`](./app/api/trovy/link/route.ts) | The server side: `createLinkHandler`. |
| [`app/join-rewards.tsx`](./app/join-rewards.tsx) | The browser side: `<TrovySignup>`. |
| [`app/page.tsx`](./app/page.tsx) | Using the saved customer id with the server client. |
| [`next.config.ts`](./next.config.ts) | The one Content Security Policy directive the form needs. |
| `lib/session.ts`, `lib/store.ts` | Stand-ins for **your** auth and **your** database. Not examples of either. |

## Run it

1. In your Trovy dashboard, open Developer API and copy the **test** keys. Add
   `http://localhost:3000` to the publishable key's allowed origins.
2. Then:

```bash
cp .env.example .env.local   # and fill in both keys
npm install
npm run dev
```

3. Open http://localhost:3000, sign in with any name, and join with one of the
   fictional phone numbers from the [docs](https://developers.trovy.ca/guides/customers).
   A test key sends no text; the docs give the code to type.

The page re-renders as a rewards member, and `.data/links.json` holds the link
your `onLinked` saved.

## Things to try

- **Sign out in another tab, then finish the form.** The route answers 401, the
  form offers "Try again", and because the token was never spent, signing back in
  and pressing it works.
- **Put the secret key in `NEXT_PUBLIC_TROVY_PUBLISHABLE_KEY`.** The form refuses
  to mount, says why in the console without printing the key, and the page
  carries on.
- **Import `@trovy/sdk/next` from `join-rewards.tsx`.** The build fails. That is
  `server-only` keeping the secret key's code out of the browser bundle.

## Checking what reaches the browser

The customer id is meant to stay on your server, and you may want to see that
for yourself. Look at a **production** build (`npm run build && npm start`), not
at `npm run dev`. In development, React puts the results of server-side reads
into the page as debugging data for its DevTools, so a dev page's source shows
values (this example's stored link among them) that a production page never
contains.

## Running against a local build of the package

From the repository root, `pnpm verify` leaves a tarball in `artifacts/`. Then,
here:

```bash
npm install ../../artifacts/trovy-sdk-*.tgz
```

Install the tarball rather than linking the folder: a linked package brings its
own copy of React with it, and two Reacts on one page break hooks.
