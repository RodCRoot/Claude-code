"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import type { ActionState } from "@/lib/actions";
import { createLeadFromInquiry, PREFERRED_TIMES } from "@/lib/crm/intake";
import { publicOrg } from "@/lib/crm/public";
import { bool, domainAction, str, strs } from "@/lib/messaging/action-helpers";

/** Public assessment inquiry. Honeypot + per-IP rate limit + server validation. */
export const submitInquiry = domainAction(async (_prev: ActionState, fd: FormData): Promise<ActionState> => {
  // Honeypot: real people never see or fill this field. Pretend success, store nothing.
  if (str(fd, "website").trim()) redirect("/inquire/thanks");

  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || null;
  const org = await publicOrg(db, str(fd, "org") || null);
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
  await db.transaction((tx) => createLeadFromInquiry(tx, org.id, input, { ip, source: "web_inquiry", isDemo: org.isDemo }));
  redirect("/inquire/thanks");
});
