"use client";

import { useRouter } from "next/navigation";
import { TrovySignup } from "@trovy/sdk/react";

/**
 * The whole browser side. `TrovySignup` is a Client Component already; this
 * wrapper exists only because `onLinked` needs the router.
 */
export function JoinRewards({ publishableKey }: { publishableKey: string }) {
  const router = useRouter();

  return (
    <TrovySignup
      publishableKey={publishableKey}
      linkUrl="/api/trovy/link"
      // The route has saved the link by the time this runs. Re-render the server
      // component, which now finds it.
      onLinked={() => router.refresh()}
      // Your error reporting goes here. `stage` says whose problem it is.
      onError={(error) => console.warn("[rewards]", error.stage, error.code, error.message)}
      unavailableFallback={<p>Rewards are unavailable right now. Please try again later.</p>}
      theme={{ accent: "#0f766e", radius: 12 }}
    />
  );
}
