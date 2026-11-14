/**
 * Hawkin Dynamics sync from the command line / a scheduler.
 *
 *   pnpm exec tsx --conditions=react-server scripts/hawkin-sync.ts --org <org-slug> [--as <owner email>] incremental
 *   pnpm exec tsx --conditions=react-server scripts/hawkin-sync.ts --org <org-slug> historical 2026-01-01 2026-03-31 [--chunk 30]
 *   pnpm exec tsx --conditions=react-server scripts/hawkin-sync.ts --org <org-slug> forcetime <import-batch-id>
 *
 * (--conditions=react-server lets server-only modules load outside Next.js.)
 * Requires HAWKIN_REFRESH_TOKEN (and HAWKIN_API_BASE for EU/APAC). The token is never printed.
 * Runs as an owner/admin of the organization so the same authorization and audit trail apply.
 */
import "dotenv/config";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, getPool } from "../src/db";
import { organizations, users } from "../src/db/schema";
import type { Viewer } from "../src/lib/authz/policy";
import { hawkinClientFromEnv } from "../src/lib/integrations/hawkin/client";
import { archiveForceTime, runHawkinSync } from "../src/lib/integrations/hawkin/sync";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("org");
  if (!slug) throw new Error("--org <slug> is required");
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) throw new Error(`No organization with slug ${slug}`);
  const as = arg("as");
  const [u] = await db
    .select()
    .from(users)
    .where(and(eq(users.orgId, org.id), inArray(users.role, ["owner", "admin"]), isNull(users.disabledAt), as ? eq(users.email, as) : undefined))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!u) throw new Error("No active owner/admin to run the sync as");
  const v: Viewer = { userId: u.id, orgId: org.id, role: u.role, personId: u.personId, displayName: u.displayName, mfaVerified: true };

  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
  const [mode, a1, a2] = positional;
  if (mode === "forcetime") {
    const client = hawkinClientFromEnv();
    if (!client) throw new Error("HAWKIN_REFRESH_TOKEN is not set");
    console.log(JSON.stringify(await archiveForceTime(db, v, client, a1)));
    return;
  }
  const result =
    mode === "historical"
      ? await runHawkinSync(db, v, { mode: "historical", from: new Date(`${a1}T00:00:00Z`), to: new Date(`${a2}T23:59:59Z`), chunkDays: Number(arg("chunk") ?? 30) })
      : await runHawkinSync(db, v, { mode: "incremental" });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed" || result.status === "not_configured") process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
