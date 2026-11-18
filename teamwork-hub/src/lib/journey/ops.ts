/**
 * Daily and weekly operations checklist (opening, closing, cleaning, weekly tasks): a small
 * configurable list per location, ticked per facility-local day by whoever is on shift, with a
 * month grid. Weekly items are ticked once per week (stored on the Monday).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { OPS_SECTIONS, locations, opsChecklistItems, opsChecklistTicks, users, type OpsSection } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { AuthzError, assertCan, isAdmin, type Viewer } from "@/lib/authz/policy";
import { addDaysYmd, startOfWeekYmd, todayLocal } from "@/lib/time";
import { journeyContext } from "./sync";

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

export const OPS_SECTION_LABEL: Record<OpsSection, string> = { opening: "Opening", closing: "Closing", cleaning: "Cleaning", weekly: "Weekly tasks" };

/** SAMPLE starter list (invented wording). Added only when an owner or admin asks for it; edit freely. */
export const SAMPLE_OPS_ITEMS: [OpsSection, string][] = [
  ["opening", "Unlock doors and turn on lights"],
  ["opening", "Check-in kiosk is on and signed in"],
  ["opening", "Walk the floor: equipment racked, nothing broken"],
  ["closing", "Equipment put away and floor clear"],
  ["closing", "Lost property collected"],
  ["closing", "Lights off and doors locked"],
  ["cleaning", "Wipe down benches, bars and handles"],
  ["cleaning", "Restrooms checked and restocked"],
  ["cleaning", "Bins emptied"],
  ["weekly", "Deep clean turf and mats"],
  ["weekly", "First-aid kit and AED checked"],
  ["weekly", "Supplies ordered"],
];

/** The local date a tick is stored on: the day itself, or the Monday for a weekly item. */
export const tickDate = (section: OpsSection, day: string) => (section === "weekly" ? startOfWeekYmd(day) : day);

async function checkLocation(tx: Tx, orgId: string, locationId: string | null) {
  if (!locationId) return null;
  const [l] = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.id, locationId), eq(locations.orgId, orgId)));
  if (!l) throw new UserError("Unknown location.");
  return l.id;
}

const forLocation = (locationId: string | null) => (locationId ? sql`(${opsChecklistItems.locationId} = ${locationId} or ${opsChecklistItems.locationId} is null)` : sql`${opsChecklistItems.locationId} is null`);

export type OpsItemView = { id: string; section: OpsSection; label: string; locationId: string | null; tick: { by: string; byUserId: string; at: Date } | null };

/** The checklist for one location (plus items that apply everywhere) on one local day. */
export async function opsChecklistForDay(tx: Tx, v: Viewer, opts: { locationId: string | null; day?: string }): Promise<{ day: string; today: string; items: OpsItemView[] }> {
  assertCan(v, "ops_checklist.use");
  const { tz } = await journeyContext(tx, v.orgId);
  const today = todayLocal(tz);
  const day = opts.day ?? today;
  const locationId = await checkLocation(tx, v.orgId, opts.locationId);
  const rows = await tx
    .select({ i: opsChecklistItems, tickBy: users.displayName, tickUser: opsChecklistTicks.tickedBy, tickAt: opsChecklistTicks.tickedAt })
    .from(opsChecklistItems)
    .leftJoin(
      opsChecklistTicks,
      and(eq(opsChecklistTicks.itemId, opsChecklistItems.id), sql`${opsChecklistTicks.localDate} = case when ${opsChecklistItems.section} = 'weekly' then ${startOfWeekYmd(day)}::date else ${day}::date end`),
    )
    .leftJoin(users, eq(users.id, opsChecklistTicks.tickedBy))
    .where(and(eq(opsChecklistItems.orgId, v.orgId), eq(opsChecklistItems.active, true), forLocation(locationId)))
    .orderBy(asc(opsChecklistItems.sortOrder), asc(opsChecklistItems.createdAt));
  return { day, today, items: rows.map((r) => ({ id: r.i.id, section: r.i.section, label: r.i.label, locationId: r.i.locationId, tick: r.tickUser ? { by: r.tickBy ?? "Staff", byUserId: r.tickUser, at: r.tickAt! } : null })) };
}

/** Tick or untick an item for today or yesterday (a closing list is often finished after midnight). */
export async function setOpsTick(tx: Tx, v: Viewer, raw: { itemId: string; day: string; done: boolean }) {
  assertCan(v, "ops_checklist.use");
  const input = z.object({ itemId: z.string().uuid(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), done: z.boolean() }).parse(raw);
  const { tz } = await journeyContext(tx, v.orgId);
  const today = todayLocal(tz);
  if (input.day > today || input.day < addDaysYmd(today, -1)) throw new UserError("The checklist can only be ticked for today or yesterday.");
  const [item] = await tx.select().from(opsChecklistItems).where(and(eq(opsChecklistItems.id, input.itemId), eq(opsChecklistItems.orgId, v.orgId)));
  if (!item || !item.active) throw new UserError("That checklist item no longer exists.");
  const localDate = tickDate(item.section, input.day);
  if (input.done) {
    const [t] = await tx.insert(opsChecklistTicks).values({ orgId: v.orgId, itemId: item.id, localDate, tickedBy: v.userId }).onConflictDoNothing().returning({ id: opsChecklistTicks.id });
    if (t) await audit(tx, actor(v), "ops_checklist.tick", "ops_checklist_item", item.id, { summary: `${OPS_SECTION_LABEL[item.section]}: ${item.label} done for ${localDate}` });
    return { changed: !!t };
  }
  const [existing] = await tx.select().from(opsChecklistTicks).where(and(eq(opsChecklistTicks.itemId, item.id), eq(opsChecklistTicks.localDate, localDate)));
  if (!existing) return { changed: false };
  if (existing.tickedBy !== v.userId && !isAdmin(v)) throw new AuthzError("Only the person who ticked it, or an owner or admin, can untick it.");
  await tx.delete(opsChecklistTicks).where(eq(opsChecklistTicks.id, existing.id));
  await audit(tx, actor(v), "ops_checklist.untick", "ops_checklist_item", item.id, { summary: `${OPS_SECTION_LABEL[item.section]}: ${item.label} unticked for ${localDate}` });
  return { changed: true };
}

export type OpsMonthDay = { day: string; done: number; total: number; future: boolean };

/**
 * Month grid: for each local day, how many of the daily items were ticked. Totals use the items
 * that are active now (the list is small and rarely changes; history is not re-based).
 */
export async function opsMonthGrid(tx: Tx, v: Viewer, opts: { locationId: string | null; month?: string }): Promise<{ month: string; days: OpsMonthDay[]; weekly: { weekStart: string; done: number; total: number }[]; dailyTotal: number }> {
  assertCan(v, "ops_checklist.use");
  const { tz } = await journeyContext(tx, v.orgId);
  const today = todayLocal(tz);
  const month = opts.month && /^\d{4}-\d{2}$/.test(opts.month) ? opts.month : today.slice(0, 7);
  const locationId = await checkLocation(tx, v.orgId, opts.locationId);
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = `${month}-01`;
  const end = `${month}-${String(last).padStart(2, "0")}`;
  const items = await tx.select({ id: opsChecklistItems.id, section: opsChecklistItems.section }).from(opsChecklistItems).where(and(eq(opsChecklistItems.orgId, v.orgId), eq(opsChecklistItems.active, true), forLocation(locationId)));
  const daily = new Set(items.filter((i) => i.section !== "weekly").map((i) => i.id));
  const weeklyIds = new Set(items.filter((i) => i.section === "weekly").map((i) => i.id));
  const ticks = await tx
    .select({ itemId: opsChecklistTicks.itemId, localDate: opsChecklistTicks.localDate })
    .from(opsChecklistTicks)
    .where(and(eq(opsChecklistTicks.orgId, v.orgId), sql`${opsChecklistTicks.localDate} >= ${startOfWeekYmd(first)}::date and ${opsChecklistTicks.localDate} <= ${end}::date`));
  const perDay = new Map<string, number>();
  const perWeek = new Map<string, number>();
  for (const t of ticks) {
    if (daily.has(t.itemId)) perDay.set(t.localDate, (perDay.get(t.localDate) ?? 0) + 1);
    else if (weeklyIds.has(t.itemId)) perWeek.set(t.localDate, (perWeek.get(t.localDate) ?? 0) + 1);
  }
  const days: OpsMonthDay[] = [];
  const weeks = new Set<string>();
  for (let d = 1; d <= last; d++) {
    const day = `${month}-${String(d).padStart(2, "0")}`;
    days.push({ day, done: perDay.get(day) ?? 0, total: daily.size, future: day > today });
    weeks.add(startOfWeekYmd(day));
  }
  return { month, days, weekly: [...weeks].sort().map((w) => ({ weekStart: w, done: perWeek.get(w) ?? 0, total: weeklyIds.size })), dailyTotal: daily.size };
}

// ---------------------------------------------------------------------------
// Configuration (owner / admin)
// ---------------------------------------------------------------------------

export async function opsItemsForSettings(tx: Tx, v: Viewer) {
  assertCan(v, "settings.manage");
  return tx
    .select({ i: opsChecklistItems, location: locations.name })
    .from(opsChecklistItems)
    .leftJoin(locations, eq(locations.id, opsChecklistItems.locationId))
    .where(eq(opsChecklistItems.orgId, v.orgId))
    .orderBy(asc(locations.name), asc(opsChecklistItems.sortOrder), asc(opsChecklistItems.createdAt));
}

const itemSchema = z.object({
  section: z.enum(OPS_SECTIONS),
  label: z.string().trim().min(2, "Describe the task").max(160),
  locationId: z.preprocess((x) => (x === "" || x == null ? null : x), z.string().uuid().nullable()),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export async function addOpsItem(tx: Tx, v: Viewer, raw: unknown) {
  assertCan(v, "settings.manage");
  const input = itemSchema.parse(raw);
  const locationId = await checkLocation(tx, v.orgId, input.locationId);
  const [row] = await tx.insert(opsChecklistItems).values({ orgId: v.orgId, section: input.section, label: input.label, locationId, sortOrder: input.sortOrder }).returning();
  await audit(tx, actor(v), "ops_checklist.item_add", "ops_checklist_item", row.id, { summary: `${OPS_SECTION_LABEL[row.section]}: ${row.label}`, after: { locationId } });
  return row;
}

export async function updateOpsItem(tx: Tx, v: Viewer, raw: unknown) {
  assertCan(v, "settings.manage");
  const input = itemSchema.extend({ id: z.string().uuid(), active: z.boolean() }).parse(raw);
  const [before] = await tx.select().from(opsChecklistItems).where(and(eq(opsChecklistItems.id, input.id), eq(opsChecklistItems.orgId, v.orgId)));
  if (!before) throw new UserError("That checklist item no longer exists.");
  const locationId = await checkLocation(tx, v.orgId, input.locationId);
  await tx.update(opsChecklistItems).set({ section: input.section, label: input.label, locationId, sortOrder: input.sortOrder, active: input.active }).where(eq(opsChecklistItems.id, input.id));
  await audit(tx, actor(v), "ops_checklist.item_update", "ops_checklist_item", input.id, {
    summary: `${OPS_SECTION_LABEL[input.section]}: ${input.label}${input.active ? "" : " (turned off)"}`,
    before: { section: before.section, label: before.label, locationId: before.locationId, sortOrder: before.sortOrder, active: before.active },
    after: { section: input.section, label: input.label, locationId, sortOrder: input.sortOrder, active: input.active },
  });
}

/** Adds the SAMPLE starter list for one location (or for every location when none is given). */
export async function addSampleOpsItems(tx: Tx, v: Viewer, locationIdRaw: string | null) {
  assertCan(v, "settings.manage");
  const locationId = await checkLocation(tx, v.orgId, locationIdRaw);
  await tx.insert(opsChecklistItems).values(SAMPLE_OPS_ITEMS.map(([section, label], i) => ({ orgId: v.orgId, section, label, locationId, sortOrder: i * 10 })));
  await audit(tx, actor(v), "ops_checklist.sample_add", "organization", v.orgId, { summary: `Sample operations checklist added (${SAMPLE_OPS_ITEMS.length} items)`, after: { locationId } });
}
