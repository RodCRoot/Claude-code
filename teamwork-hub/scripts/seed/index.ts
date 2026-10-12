import { organizations } from "../../src/db/schema";
import type { Tx } from "../../src/db";
import { todayLocal, DEFAULT_TZ } from "../../src/lib/time";
import type { SeedCtx } from "./context";
import { seedCore } from "./core";
import { moduleSeeds } from "./modules";

/** Builds the full synthetic demo dataset inside one transaction. */
export async function seedAll(tx: Tx, opts: { today?: string; slug?: string; modules?: string[] } = {}): Promise<SeedCtx> {
  const [org] = await tx
    .insert(organizations)
    .values({
      name: "Teamwork Bloomington (Demo)",
      slug: opts.slug ?? "teamwork-demo",
      timezone: DEFAULT_TZ,
      currency: "USD",
      isDemo: true,
      branding: { displayName: "Teamwork", primaryColor: "#1d4ed8" },
      settings: {
        requireStaffMfa: false,
        pendingBankPaymentPolicy: "grant_on_settlement",
        quietHours: { start: "21:00", end: "07:30" },
        bookingWindowDays: 21,
        familyBookingCutoffMinutes: 60,
      },
    })
    .returning();
  const ctx: SeedCtx = {
    tx,
    orgId: org.id,
    today: opts.today ?? todayLocal(DEFAULT_TZ),
    tz: DEFAULT_TZ,
    users: {},
    people: {},
    athletes: {},
    households: {},
    payers: {},
    groups: {},
    extra: {},
  };
  await seedCore(ctx);
  for (const [name, fn] of moduleSeeds) {
    if (opts.modules && !opts.modules.includes(name)) continue;
    await fn(ctx);
    if (process.env.SEED_VERBOSE) console.log(`  seeded ${name}`);
  }
  return ctx;
}
