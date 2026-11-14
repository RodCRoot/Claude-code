import "dotenv/config";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";

/**
 * Program builder: keyboard-only reordering (move up/down, superset join/separate, move to another
 * day) and native drag-and-drop. Each change is saved atomically and bumps the program version.
 * Uses a fresh throwaway program so it can be re-run against the same demo database.
 */
test.use({ viewport: { width: 1280, height: 900 } });

test("keyboard reordering and drag-and-drop persist and bump the program version", async ({ page }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const org = (await pool.query(`select org_id from users where email = 'rod.demo@teamwork-hub.test'`)).rows[0].org_id as string;
  const ex = Object.fromEntries(
    (await pool.query(`select name, id from exercises where org_id = $1 and name = any($2)`, [org, ["Back Squat", "Box Jump", "Plank", "Bench Press", "Pull-Up"]])).rows.map((r) => [r.name, r.id]),
  ) as Record<string, string>;
  const name = `E2E builder ${Date.now()}`;
  const program = (await pool.query(`insert into programs (org_id, name, status) values ($1, $2, 'draft') returning id`, [org, name])).rows[0].id as string;
  const day1 = (await pool.query(`insert into program_days (program_id, week, day_index, title) values ($1, 1, 1, 'Lower') returning id`, [program])).rows[0].id as string;
  const day2 = (await pool.query(`insert into program_days (program_id, week, day_index, title) values ($1, 1, 2, 'Upper') returning id`, [program])).rows[0].id as string;
  const rx = JSON.stringify([{ sets: 3, reps: 5 }]);
  const add = async (day: string, sort: number, exName: string, label: string, type: string) =>
    (await pool.query(`insert into program_items (day_id, sort_order, exercise_id, block_label, block_type, prescription) values ($1, $2, $3, $4, $5, $6) returning id`, [day, sort, ex[exName], label, type, rx])).rows[0].id as string;
  const squat = await add(day1, 0, "Back Squat", "A1", "straight");
  const box = await add(day1, 1, "Box Jump", "B1", "superset");
  const plank = await add(day1, 2, "Plank", "B2", "superset");
  const bench = await add(day1, 3, "Bench Press", "C1", "straight");
  const pull = await add(day2, 0, "Pull-Up", "A1", "straight");
  const names: Record<string, string> = { [squat]: "Back Squat", [box]: "Box Jump", [plank]: "Plank", [bench]: "Bench Press", [pull]: "Pull-Up" };
  const dbDay = async (day: string) =>
    (await pool.query(`select id, block_label from program_items where day_id = $1 order by sort_order`, [day])).rows.map((r) => `${r.block_label} ${names[r.id]}`);
  const uiDay = async (n: number) => (await page.getByTestId(`builder-day-${n}`).locator("li[data-item-id] > div[draggable]").allTextContents()).map((t) => t.replace(/\s+/g, " "));
  const status = page.getByTestId("builder-status");

  await page.goto("/login");
  await page.fill("#email", "rod.demo@teamwork-hub.test");
  await page.fill("#password", "teamwork-demo-1");
  await page.click("button[type=submit]");
  await page.waitForURL(/\/today/);
  await page.goto(`/training/programs/${program}?week=1`);

  // 1) Keyboard: focus "Move Back Squat down" and press Enter → jumps over the B superset.
  const squatDown = page.getByRole("button", { name: "Move Back Squat down" });
  await squatDown.focus();
  await page.keyboard.press("Enter");
  await expect(status).toContainText("Saved (v2)");
  await expect(squatDown).toBeFocused(); // focus follows the moved item
  expect(await dbDay(day1)).toEqual(["A1 Box Jump", "A2 Plank", "B1 Back Squat", "C1 Bench Press"]);

  // 2) Space on the same button → jumps over Bench Press.
  await page.keyboard.press("Space");
  await expect(status).toContainText("Saved (v3)");
  expect(await dbDay(day1)).toEqual(["A1 Box Jump", "A2 Plank", "B1 Bench Press", "C1 Back Squat"]);

  // 3) Superset Back Squat with the block above (keyboard), focus lands on "Separate".
  await page.getByRole("button", { name: "Join Back Squat to block B above" }).focus();
  await page.keyboard.press("Enter");
  await expect(status).toContainText("Saved (v4)");
  await expect(page.getByRole("button", { name: "Separate Back Squat from block B" })).toBeFocused();
  expect(await dbDay(day1)).toEqual(["A1 Box Jump", "A2 Plank", "B1 Bench Press", "B2 Back Squat"]);

  // 4) Move Plank to Day 2 with the keyboard: focus the day picker, Tab to "Move", Enter.
  await page.getByLabel("Move Plank to day").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Move Plank to the selected day" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(status).toContainText("Saved (v5)");
  expect(await dbDay(day1)).toEqual(["A1 Box Jump", "B1 Bench Press", "B2 Back Squat"]);
  expect(await dbDay(day2)).toEqual(["A1 Pull-Up", "B1 Plank"]);

  // 5) Native drag-and-drop: drag Box Jump below Back Squat (outer edge → its own block at the end).
  const target = page.locator(`li[data-item-id="${squat}"]`);
  const box_ = await target.boundingBox();
  await page.locator(`li[data-item-id="${box}"] > div[draggable]`).dragTo(target, { targetPosition: { x: 40, y: box_!.height - 6 } });
  await expect(status).toContainText("Saved (v6)");
  expect(await dbDay(day1)).toEqual(["A1 Bench Press", "A2 Back Squat", "B1 Box Jump"]);

  // Reload: the UI shows the persisted order; version and audit trail match.
  await page.reload();
  expect(await uiDay(1)).toEqual([
    expect.stringMatching(/A1\s*Bench Press\s*superset/),
    expect.stringMatching(/A2\s*Back Squat\s*superset/),
    expect.stringMatching(/B1\s*Box Jump\s*straight/),
  ]);
  expect(await uiDay(2)).toEqual([expect.stringMatching(/A1\s*Pull-Up/), expect.stringMatching(/B1\s*Plank/)]);
  expect((await pool.query(`select current_version from programs where id = $1`, [program])).rows[0].current_version).toBe(6);
  expect((await pool.query(`select count(*)::int as n from audit_events where entity_id = $1 and action = 'training.program.layout'`, [program])).rows[0].n).toBe(5);
  await pool.end();
});
