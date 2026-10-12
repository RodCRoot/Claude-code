import "dotenv/config";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";

/**
 * Offline recovery for athlete set logging:
 * go offline → log sets (queued in localStorage) → reload while the API is unreachable
 * (entries survive) → server processes a retry but the response is lost (500) → client
 * retries the same clientMutationIds → synced, and the database holds no duplicates.
 */
test("athlete logs sets offline, reloads, reconnects: synced with no duplicates", async ({ page, context }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // A scheduled, untouched workout for Maya (demo seed).
  const { rows } = await pool.query(`
    select w.id, w.scheduled_date::text as date, wi.id as item_id
    from workouts w
    join athletes a on a.id = w.athlete_id join people p on p.id = a.person_id
    join workout_items wi on wi.workout_id = w.id and wi.sort_order = 0
    where p.first_name = 'Maya' and p.last_name = 'Parker' and w.status = 'scheduled'
      and not exists (select 1 from workout_items x join set_logs s on s.workout_item_id = x.id where x.workout_id = w.id)
    order by w.scheduled_date limit 1`);
  expect(rows.length, "seeded scheduled workout for Maya").toBe(1);
  const { date, item_id: itemId } = rows[0] as { date: string; item_id: string };

  // Sign in through the real login form (the demo role switcher is disabled in production builds).
  await page.goto("/login");
  await page.fill("#email", "maya.parker@example.test");
  await page.fill("#password", "teamwork-demo-1");
  await page.click("button[type=submit]");
  await page.waitForURL(/\/today/);
  await page.goto(`/training/today?date=${date}`);
  const item = page.locator(`section:has(#item-${itemId})`);
  await expect(item).toBeVisible();

  // 1) Offline: log two sets (edit reps on the second).
  await context.setOffline(true);
  await item.getByRole("button", { name: /^Log .* Set 1$/ }).click();
  await item.locator(`[id="${itemId}-1-both-reps"]`).fill("2");
  await item.getByRole("button", { name: /^Log .* Set 2$/ }).click();
  await expect(page.getByTestId("unsynced-count")).toHaveText("2");
  await expect(page.getByTestId("sync-status")).toContainText("offline");

  // localStorage holds ids + numbers only (no names / notes).
  const stored = await page.evaluate(() => localStorage.getItem("tw.training.queue.v1") ?? "");
  expect(stored).toContain(itemId);
  expect(stored).not.toMatch(/Maya|Parker|Power Clean/);

  // 2) Reload while the API is still unreachable: entries survive.
  await page.route("**/api/training/sets", (r) => r.abort("internetdisconnected"));
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByTestId("unsynced-count")).toHaveText("2");
  await expect(page.locator(`[data-testid="set-0-both"]`).first()).toContainText("unsynced");

  // 3) Back online, but the first sync's response is lost after the server applied it.
  await page.unroute("**/api/training/sets");
  let lost = 0;
  await page.route("**/api/training/sets", async (r) => {
    const resp = await r.fetch();
    if (lost++ === 0) return r.fulfill({ status: 500, body: "{}" });
    return r.fulfill({ response: resp });
  });
  await page.getByRole("button", { name: "Retry now" }).click();
  await expect(page.getByTestId("sync-status")).toContainText("All entries synced", { timeout: 20_000 });
  expect(lost).toBeGreaterThanOrEqual(2);
  await expect(page.locator(`[data-testid="set-1-both"]`).first()).toContainText("saved");

  // 4) Database: exactly one row per slot, with the edited values.
  const logs = await pool.query("select set_index, reps, side, client_mutation_id from set_logs where workout_item_id = $1 order by set_index", [itemId]);
  expect(logs.rows.map((r) => [r.set_index, r.side])).toEqual([
    [0, "both"],
    [1, "both"],
  ]);
  expect(logs.rows[1].reps).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem("tw.training.queue.v1"))).toBeNull();
  await pool.end();
});
