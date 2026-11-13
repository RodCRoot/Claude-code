import type { Tx } from "@/db";
import type { Viewer } from "@/lib/authz/policy";

/** Placeholder until the agreements module lands (same commit series). */
export async function onAutopayChanged(_tx: Tx, _v: Viewer | null, _membershipId: string) {
  return;
}
