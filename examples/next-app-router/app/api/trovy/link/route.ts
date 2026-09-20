import { createLinkHandler } from "@trovy/sdk/next";
import { currentUserId } from "@/lib/session";
import { saveLink } from "@/lib/store";

/**
 * The whole server side of the sign-up form. The component posts the form's
 * one-time token here; this asks YOUR session who the user is, exchanges the
 * token with the secret key, and hands you both ids to save together.
 */
export const POST = createLinkHandler({
  // May be undefined while this module is evaluated during a build. It is
  // checked on the first request.
  secretKey: process.env.TROVY_SECRET_KEY,

  // Runs before the token is spent. Returning null answers 401, and the customer
  // can sign in and try again with the same token.
  getUser: () => currentUserId(),

  onLinked: async ({ userId, customer }) => {
    await saveLink(userId, customer.id);
  },
});
