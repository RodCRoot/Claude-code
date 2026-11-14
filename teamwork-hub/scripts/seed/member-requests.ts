import { memberRequestAthletes, memberRequests } from "../../src/db/schema";
import { addDaysYmd } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Synthetic member-requests log entries (all is_demo). Shows a forwarded email that sat, a repeat
 * ask by phone (AI Call Recap text is invented sample text), and a resolved card update.
 */
export async function seedMemberRequests(ctx: SeedCtx) {
  const { tx, orgId, today: T } = ctx;
  const add = async (
    athleteKeys: string[],
    v: Omit<typeof memberRequests.$inferInsert, "orgId" | "isDemo">,
  ) => {
    const [r] = await tx.insert(memberRequests).values({ orgId, isDemo: true, ...v }).returning();
    await tx.insert(memberRequestAthletes).values(athleteKeys.map((k) => ({ requestId: r.id, athleteId: ctx.athletes[k] })));
    return r;
  };
  await add(["owen"], {
    type: "hold",
    channel: "email_forwarded",
    requesterPersonId: ctx.people.owen_guardian,
    sentOn: addDaysYmd(T, -12),
    receivedOn: addDaysYmd(T, -4),
    summary: "Hold for hockey season, restart in January (sample)",
    pastedText: "SAMPLE forwarded email: Hi, Owen is starting hockey — can we put his membership on hold until January? Thanks!",
    ownerUserId: ctx.users.erin,
    createdByUserId: ctx.users.erin,
  });
  await add(["owen"], {
    type: "hold",
    channel: "phone_ai_recap",
    requesterPersonId: ctx.people.owen_guardian,
    sentOn: addDaysYmd(T, -3),
    receivedOn: addDaysYmd(T, -3),
    summary: "Called again about the hold (sample)",
    pastedText: "SAMPLE AI Call Recap: Caller (guardian of Owen) asked whether the hold request from last week went through.",
    createdByUserId: ctx.users.erin,
  });
  await add(["dana"], {
    type: "card_update",
    channel: "web_form",
    requesterPersonId: ctx.people.dana_brooks,
    sentOn: addDaysYmd(T, -20),
    receivedOn: addDaysYmd(T, -19),
    summary: "New card on file (sample)",
    status: "resolved",
    resolutionNotes: "Sent the secure card-update link; Dana updated it herself (sample).",
    resolvedAt: new Date(Date.now() - 18 * 86_400_000),
    resolvedByUserId: ctx.users.erin,
    ownerUserId: ctx.users.erin,
    createdByUserId: ctx.users.erin,
  });
}
