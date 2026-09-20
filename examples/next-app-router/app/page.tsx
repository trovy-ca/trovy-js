import { Trovy, isTrovyError } from "@trovy/sdk";
import { currentUserId } from "@/lib/session";
import { customerIdFor } from "@/lib/store";
import { signInAction, signOutAction } from "./actions";
import { JoinRewards } from "./join-rewards";

async function rewardsSummary(customerId: string): Promise<string> {
  const secretKey = process.env.TROVY_SECRET_KEY;
  if (!secretKey) return "Set TROVY_SECRET_KEY to list this customer's rewards.";
  try {
    const trovy = new Trovy({ apiKey: secretKey });
    const { rewards } = await trovy.rewards.list(customerId);
    return rewards.length === 0 ? "No rewards yet. They earn on their next paid order." : `${rewards.length} reward(s) waiting.`;
  } catch (error) {
    return isTrovyError(error) ? `Trovy answered ${error.code}.` : "Trovy could not be reached.";
  }
}

export default async function Page() {
  const userId = await currentUserId();
  const publishableKey = process.env.NEXT_PUBLIC_TROVY_PUBLISHABLE_KEY;

  if (!userId) {
    return (
      <main>
        <h1>Trovy + Next.js</h1>
        <p>Sign in first: rewards are linked to one of your own users.</p>
        <form action={signInAction}>
          <input name="name" placeholder="Any name" required aria-label="Name" />
          <button type="submit">Sign in (demo)</button>
        </form>
      </main>
    );
  }

  const customerId = await customerIdFor(userId);

  return (
    <main>
      <h1>Trovy + Next.js</h1>
      <p>
        Signed in as <strong>{userId}</strong>.
      </p>
      <form action={signOutAction}>
        <button type="submit">Sign out</button>
      </form>

      <h2>Rewards</h2>
      {customerId ? (
        <>
          <p>This user is a rewards member.</p>
          <p>{await rewardsSummary(customerId)}</p>
        </>
      ) : publishableKey ? (
        <JoinRewards publishableKey={publishableKey} />
      ) : (
        <p>
          Set <code>NEXT_PUBLIC_TROVY_PUBLISHABLE_KEY</code> in <code>.env.local</code> to show the sign-up form.
        </p>
      )}
    </main>
  );
}
