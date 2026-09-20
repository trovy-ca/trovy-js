import { cookies } from "next/headers";

/**
 * A stand-in for your real authentication, and nothing like it: the "session" is
 * a cookie holding whatever name was typed. It exists so that the example has a
 * signed-in user to link a customer to. In your app this file is NextAuth,
 * Clerk, Lucia, or whatever you already have.
 */
const COOKIE = "demo_user";

export async function currentUserId(): Promise<string | null> {
  return (await cookies()).get(COOKIE)?.value ?? null;
}

export async function signInAs(name: string): Promise<void> {
  (await cookies()).set(COOKIE, name, { httpOnly: true, sameSite: "lax", path: "/" });
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
