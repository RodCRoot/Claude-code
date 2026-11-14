import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/db";
import { undeliverableAddresses } from "@/db/schema";

/** Lower-cased, trimmed email; null when it doesn't look like an address. */
export function normalizeEmail(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  // Accept "Name <a@b.c>" as providers send it.
  const m = /<([^>]+)>/.exec(s);
  const addr = (m ? m[1] : s).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : null;
}

/** Digits-only phone key used for matching (last 10 digits for North American numbers). */
export function phoneKey(v: string | null | undefined): string | null {
  const digits = (v ?? "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export function normalizeAddress(channel: "email" | "sms", v: string | null | undefined): string | null {
  if (channel === "email") return normalizeEmail(v);
  const k = phoneKey(v);
  return k ? `+${k}` : null;
}

/** Normalized addresses (per channel) currently flagged undeliverable in this org. */
export async function undeliverableSet(tx: Tx, orgId: string, items: { channel: "email" | "sms"; address: string | null }[]): Promise<Set<string>> {
  const keys = items.map((i) => ({ channel: i.channel, address: normalizeAddress(i.channel, i.address) })).filter((i): i is { channel: "email" | "sms"; address: string } => !!i.address);
  if (!keys.length) return new Set();
  const rows = await tx
    .select({ channel: undeliverableAddresses.channel, address: undeliverableAddresses.address })
    .from(undeliverableAddresses)
    .where(and(eq(undeliverableAddresses.orgId, orgId), isNull(undeliverableAddresses.clearedAt), inArray(undeliverableAddresses.address, [...new Set(keys.map((k) => k.address))])));
  return new Set(rows.map((r) => `${r.channel}:${r.address}`));
}

export const undeliverableKey = (channel: "email" | "sms", address: string | null) => {
  const a = normalizeAddress(channel, address);
  return a ? `${channel}:${a}` : null;
};
