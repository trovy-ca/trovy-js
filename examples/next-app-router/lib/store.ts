import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * A stand-in for your database: one JSON file mapping your user id to their
 * Trovy customer id. In your app this is a column on your users table.
 */
const FILE = join(process.cwd(), ".data", "links.json");

async function readAll(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function customerIdFor(userId: string): Promise<string | null> {
  return (await readAll())[userId] ?? null;
}

/**
 * Idempotent, and careful: the same id again is a no-op, and a DIFFERENT id for a
 * user who already has one is refused rather than silently overwritten.
 */
export async function saveLink(userId: string, customerId: string): Promise<void> {
  const links = await readAll();
  const existing = links[userId];
  if (existing === customerId) return;
  if (existing !== undefined) {
    throw new Error(`User ${userId} is already linked to a different Trovy customer. Not overwriting.`);
  }
  links[userId] = customerId;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(links, null, 2));
}
