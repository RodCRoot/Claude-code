import { randomUUID } from "node:crypto";
import { scheduleSessions, serviceTypes } from "@/db/schema";
import { grantCredits } from "@/lib/credits";
import type { seedOrg } from "./helpers/db";
import { testDb } from "./helpers/db";

type Ctx = Awaited<ReturnType<typeof seedOrg>>;

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Insert a session directly (no auth) starting `startsInMs` from now. */
export async function mkSession(
  ctx: Ctx,
  opts: { serviceTypeId?: string; startsInMs?: number; startsAt?: Date; minutes?: number; capacity?: number; waitlist?: number; coach?: string | null; visibility?: "public" | "members" | "private"; exclusiveCoach?: boolean; title?: string } = {},
) {
  const startsAt = opts.startsAt ?? new Date(Date.now() + (opts.startsInMs ?? 3 * DAY));
  const [s] = await testDb()
    .insert(scheduleSessions)
    .values({
      orgId: ctx.orgId,
      serviceTypeId: opts.serviceTypeId ?? ctx.extra.scheduling.gpt,
      title: opts.title ?? "Test session",
      startsAt,
      endsAt: new Date(startsAt.getTime() + (opts.minutes ?? 60) * 60_000),
      timezone: ctx.tz,
      coachUserId: opts.coach === undefined ? ctx.users.marcus : opts.coach,
      capacity: opts.capacity ?? 10,
      waitlistCapacity: opts.waitlist ?? 0,
      visibility: opts.visibility ?? "members",
      exclusiveCoach: opts.exclusiveCoach ?? false,
    })
    .returning();
  return s;
}

export async function mkServiceType(ctx: Ctx, values: Partial<typeof serviceTypes.$inferInsert> = {}) {
  const [st] = await testDb()
    .insert(serviceTypes)
    .values({ orgId: ctx.orgId, name: `Svc ${randomUUID().slice(0, 6)}`, kind: "class", defaultCapacity: 10, creditCost: 1, ...values })
    .returning();
  return st;
}

export async function giveCredits(ctx: Ctx, athleteKey: string, amount: number) {
  return testDb().transaction((tx) =>
    grantCredits(tx, { orgId: ctx.orgId, athleteId: ctx.athletes[athleteKey], amount, sourceKind: "staff_grant", idempotencyKey: `t-${randomUUID()}` }),
  );
}
