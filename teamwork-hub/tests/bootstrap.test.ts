import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeTestDb, testDb, seedOrg } from "./helpers/db";
import { bootstrapOwner } from "@/lib/auth/bootstrap";

beforeAll(async () => {
  await seedOrg(undefined, { modules: [] });
});
afterAll(closeTestDb);

const valid = { orgName: "Teamwork Bloomington", slug: "teamwork-bloomington", email: "owner@example.test", displayName: "Owner" };

describe("bootstrapOwner", () => {
  it("refuses when any organization exists (no second owner / takeover)", async () => {
    const db = testDb();
    const before = (await db.execute(sql`select count(*)::int as n from users where role = 'owner'`)).rows[0];
    await expect(db.transaction((tx) => bootstrapOwner(tx, valid))).rejects.toThrow(/already exists/);
    expect((await db.execute(sql`select count(*)::int as n from users where role = 'owner'`)).rows[0]).toEqual(before);
  });

  it("validates input before touching the database", async () => {
    const db = testDb();
    await expect(db.transaction((tx) => bootstrapOwner(tx, { ...valid, slug: "Bad Slug!" }))).rejects.toThrow(/slug/);
    await expect(db.transaction((tx) => bootstrapOwner(tx, { ...valid, email: "nope" }))).rejects.toThrow();
  });
});
