/**
 * `@trovy/sdk/next` — the route that links a verified customer to your user.
 *
 *   // app/api/trovy/link/route.ts
 *   import { createLinkHandler } from "@trovy/sdk/next";
 *
 *   export const POST = createLinkHandler({
 *     secretKey: process.env.TROVY_SECRET_KEY,
 *     getUser: async () => (await auth())?.user?.id ?? null,
 *     onLinked: async ({ userId, customer }) => {
 *       await db.user.update({ where: { id: userId }, data: { trovyCustomerId: customer.id } });
 *     },
 *   });
 *
 * Server only: it holds the secret key. The line below turns an import of this
 * file from a Client Component into a build error, instead of a key in a bundle.
 * Next resolves `server-only` itself; nothing needs installing there. Anywhere
 * else the import fails on purpose, and the README says how to test a route
 * (install `server-only`, run the tests under the `react-server` condition).
 */
import "server-only";

export { createLinkHandler } from "../server/link-handler.js";
export type {
  LinkClient,
  LinkHandlerFailure,
  LinkHandlerOptions,
  LinkedCustomerRecord,
} from "../server/link-handler.js";
export type { LinkHandlerCode } from "../link-protocol.js";
