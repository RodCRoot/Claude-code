import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { listLocations } from "@/lib/locations";
import { programOptions, scoreboardContext } from "@/lib/scoreboard/core";
import type { ScoreboardQuery } from "@/components/scoreboard/shell";

export type ScoreboardSearch = { location?: string; program?: string; months?: string; weeks?: string };

/** Common page setup: permission, context (filter ids are validated against the org), filter options. */
export async function loadScoreboard(searchParams: Promise<ScoreboardSearch>, opts: { ignoreFilter?: boolean } = {}) {
  const v = await requireCap("scoreboard.view");
  const sp = await searchParams;
  const c = await scoreboardContext(db, v, opts.ignoreFilter ? {} : { locationId: sp.location, productId: sp.program });
  const locations = (await listLocations(db, v.orgId)).map((l) => ({ id: l.id, name: l.name }));
  const programs = (await programOptions(db, v.orgId)).map((p) => ({ id: p.id, name: p.name }));
  const months = [6, 12, 24].includes(Number(sp.months)) ? Number(sp.months) : 6;
  const weeks = [4, 8, 12, 26].includes(Number(sp.weeks)) ? Number(sp.weeks) : 8;
  const q: ScoreboardQuery = { location: c.filter.locationId, program: c.filter.productId };
  return { v, c, locations, programs, months, weeks, q, canManage: can(v, "scoreboard.manage") };
}
