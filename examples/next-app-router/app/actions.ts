"use server";

import { revalidatePath } from "next/cache";
import { signInAs, signOut } from "@/lib/session";

export async function signInAction(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim().slice(0, 40);
  if (name) await signInAs(name);
  revalidatePath("/");
}

export async function signOutAction(): Promise<void> {
  await signOut();
  revalidatePath("/");
}
