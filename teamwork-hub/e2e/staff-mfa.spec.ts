import "dotenv/config";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { login, USERS } from "./helpers";

/**
 * Staff MFA enforcement (org setting `requireStaffMfa`, decided by src/lib/auth/mfa-policy.ts and
 * applied in the app layout). The test flips the demo org's setting directly in the database
 * (DATABASE_URL, same seed as `pnpm db:fresh`) and resets it afterwards, so it touches shared state:
 * run it on its own or with --workers=1, e.g.
 *   BASE_URL=http://localhost:3105 npx playwright test e2e/staff-mfa.spec.ts --workers=1
 */
test.describe.configure({ mode: "serial" });

async function setRequireStaffMfa(on: boolean) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`update organizations set settings = settings || $1::jsonb where slug = 'teamwork-demo'`, [JSON.stringify({ requireStaffMfa: on })]);
  } finally {
    await pool.end();
  }
}

test("staff without two-step verification are sent to enrol while the policy is on; guardians are not", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "flips shared org state; runs in the desktop project only");
  await setRequireStaffMfa(true);
  try {
    // Marcus (coach, no second factor) lands on the enrolment page and cannot leave it for other app pages.
    await login(page, USERS.marcus);
    await expect(page).toHaveURL(/\/settings\/security\?required=1$/);
    await expect(page.getByText("Two-step verification required")).toBeVisible();
    await page.goto("/today");
    await expect(page).toHaveURL(/\/settings\/security\?required=1$/);
    await expect(page.getByText("Two-step verification required")).toBeVisible();
    await page.goto("/people");
    await expect(page).toHaveURL(/\/settings\/security\?required=1$/);
    await expect(page.getByText("Two-step verification required")).toBeVisible();

    // A guardian is never affected by the staff policy.
    await page.context().clearCookies();
    await login(page, USERS.alex);
    await page.goto("/today");
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByText("Two-step verification required")).toHaveCount(0);
  } finally {
    await setRequireStaffMfa(false);
  }

  // With the policy off again, the same coach reaches the app normally.
  await page.context().clearCookies();
  await login(page, USERS.marcus);
  await page.goto("/today");
  await expect(page).toHaveURL(/\/today$/);
});
