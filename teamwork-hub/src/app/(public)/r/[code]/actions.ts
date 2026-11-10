"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import type { ActionState } from "@/lib/actions";
import { PREFERRED_TIMES } from "@/lib/crm/intake";
import { publicOrg } from "@/lib/crm/public";
import { createReferredInquiry } from "@/lib/growth/intake";
import { bool, domainAction, str, strs } from "@/lib/messaging/action-helpers";

/**
 * Public inquiry from a referral link. Same honeypot, validation and rate limits as /inquire.
 * The response is identical for real, revoked and made-up codes (always the thanks page).
 */
export const submitReferredInquiry = domainAction(async (_prev: ActionState, fd: FormData): Promise<ActionState> => {
  if (str(fd, "website").trim()) redirect("/inquire/thanks");
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || null;
  const org = await publicOrg(db, null);
  if (!org) return { ok: false, error: "This facility isn't set up to take inquiries yet." };
  const input = {
    inquiringFor: str(fd, "inquiringFor") === "self" ? ("self" as const) : ("child" as const),
    contactFirstName: str(fd, "contactFirstName"),
    contactLastName: str(fd, "contactLastName"),
    email: str(fd, "email"),
    phone: str(fd, "phone"),
    athleteFirstName: str(fd, "athleteFirstName"),
    athleteLastName: str(fd, "athleteLastName"),
    athleteAge: str(fd, "athleteAge"),
    sport: str(fd, "sport"),
    goals: str(fd, "goals"),
    preferredTimes: strs(fd, "preferredTimes").filter((t): t is (typeof PREFERRED_TIMES)[number] => (PREFERRED_TIMES as readonly string[]).includes(t)),
    heardFrom: str(fd, "heardFrom"),
    consentEmail: bool(fd, "consentEmail"),
    consentSms: bool(fd, "consentSms"),
  };
  await db.transaction((tx) => createReferredInquiry(tx, org.id, input, str(fd, "ref"), { ip, isDemo: org.isDemo }));
  redirect("/inquire/thanks");
});
