/**
 * First-run setup on an EMPTY staging/production database (after `pnpm db:migrate`):
 *
 *   pnpm bootstrap:owner --org "Teamwork Bloomington" --slug teamwork-bloomington \
 *     --email you@example.com --name "Rod"
 *
 * Creates the organization and an owner INVITE, and prints the one-time invite link
 * (APP_URL/invite/<token>, valid 72 h). Open it to set the owner password, then enrol MFA.
 * Refuses if any organization already exists.
 */
import "dotenv/config";
import { db, getPool } from "../src/db";
import { bootstrapOwner } from "../src/lib/auth/bootstrap";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (process.env.APP_MODE === "demo") {
    throw new Error("APP_MODE=demo uses the synthetic seed (pnpm db:fresh); bootstrap is for staging/production.");
  }
  const appUrl = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  if (!appUrl) throw new Error("APP_URL is required (the invite link is built from it).");
  const r = await db.transaction((tx) =>
    bootstrapOwner(tx, { orgName: arg("org"), slug: arg("slug"), email: arg("email"), displayName: arg("name") }),
  );
  console.log(`Organization ${r.orgId} created.`);
  console.log(`Owner invite (shown once, valid ${r.expiresInHours} h): ${appUrl}/invite/${r.token}`);
  await getPool().end();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await getPool().end().catch(() => undefined);
  process.exit(1);
});
