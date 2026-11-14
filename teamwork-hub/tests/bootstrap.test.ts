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
    await expect(db.transaction((tx) => bootstrapOwner(tx, valid))).rejects.toThrow(/already exists/);
    // Nothing of the refused bootstrap exists. (A count of every owner would race with other test files, which seed
    // organizations, each with an owner, in parallel.)
    expect((await db.execute(sql`select count(*)::int as n from organizations where slug = ${valid.slug}`)).rows[0]).toEqual({ n: 0 });
    expect((await db.execute(sql`select count(*)::int as n from users where email = ${valid.email}`)).rows[0]).toEqual({ n: 0 });
  });

  it("validates input before touching the database", async () => {
    const db = testDb();
    await expect(db.transaction((tx) => bootstrapOwner(tx, { ...valid, slug: "Bad Slug!" }))).rejects.toThrow(/slug/);
    await expect(db.transaction((tx) => bootstrapOwner(tx, { ...valid, email: "nope" }))).rejects.toThrow();
  });
});
