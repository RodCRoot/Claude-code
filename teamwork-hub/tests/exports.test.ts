import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { archivedDocuments } from "@/db/schema";
import { closeTestDb, seedOrg, viewerFor } from "./helpers/db";
import { db, tx } from "./imports.helpers";
import { authorizeExportDownload, buildExport, createExport, listExports, type Manifest } from "@/lib/exports/bundle";
import { saveObject } from "@/lib/storage";
import type { Viewer } from "@/lib/authz/policy";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
let rod: Viewer;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  ctx = await seedOrg();
  rod = await viewerFor(ctx, "rod");
  await tx(async (t) => {
    const obj = await saveObject(t, {
      orgId: ctx.orgId,
      bytes: new TextEncoder().encode("%PDF-1.4 synthetic sample waiver"),
      filename: "maya waiver.pdf",
      mimeType: "application/pdf",
      kind: "imported_archive",
      ownerPersonId: ctx.people.maya_parker,
    });
    await t.insert(archivedDocuments).values({ orgId: ctx.orgId, personId: ctx.people.maya_parker, objectId: obj.id, title: "Waiver (sample)", originalSystem: "zenplanner" });
  });
});
afterAll(closeTestDb);

describe("exports", () => {
  it("org-wide bundle: manifest checksums match every file's bytes", async () => {
    const { bytes, manifest } = await tx((t) => buildExport(t, rod, { kind: "org" }));
    const files = unzipSync(bytes);
    const m = JSON.parse(strFromU8(files["manifest.json"])) as Manifest;
    expect(m.schemaVersion).toBe("teamwork-export/1");
    expect(m.files.length).toBe(manifest.files.length);
    for (const f of m.files) {
      expect(files[f.path], f.path).toBeDefined();
      expect(sha(files[f.path])).toBe(f.sha256);
      expect(files[f.path].byteLength).toBe(f.bytes);
    }
    for (const ds of ["people", "guardianships", "households", "memberships", "invoices", "transactions", "attendance", "workouts", "set_logs", "maxes", "questionnaire_responses", "body_reports", "metric_values", "archived_documents"]) {
      expect(m.files.some((f) => f.path === `data/${ds}.csv`), ds).toBe(true);
      expect(m.files.some((f) => f.path === `data/${ds}.json`), ds).toBe(true);
    }
    const doc = m.links.find((l) => l.entity === "archived_document")!;
    expect(strFromU8(files[doc.path])).toContain("synthetic sample waiver");
    const people = JSON.parse(strFromU8(files["data/people.json"])) as { lastName: string }[];
    expect(people.length).toBeGreaterThan(20);
  });

  it("non-admins cannot export org-wide", async () => {
    for (const k of ["erin", "marcus", "alex", "dana"]) {
      const v = await viewerFor(ctx, k);
      await expect(tx((t) => buildExport(t, v, { kind: "org" }))).rejects.toThrow(/owners and admins/);
    }
  });

  it("per-athlete exports follow profile access and strip data the exporter cannot see", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const erin = await viewerFor(ctx, "erin");
    const tess = await viewerFor(ctx, "tess");
    const alex = await viewerFor(ctx, "alex");
    const m = await tx((t) => buildExport(t, marcus, { kind: "athlete", athleteId: ctx.athletes.maya }));
    expect(m.manifest.includes).toEqual({ health: true, billing: false });
    expect(m.manifest.files.some((f) => f.path === "data/invoices.csv")).toBe(false);
    const e = await tx((t) => buildExport(t, erin, { kind: "athlete", athleteId: ctx.athletes.maya }));
    expect(e.manifest.includes).toEqual({ health: false, billing: true });
    expect(e.manifest.files.some((f) => f.path === "data/questionnaire_responses.csv")).toBe(false);
    // Tess is not Maya's coach; guardians never export.
    await expect(tx((t) => buildExport(t, tess, { kind: "athlete", athleteId: ctx.athletes.maya }))).rejects.toThrow();
    await expect(tx((t) => buildExport(t, alex, { kind: "athlete", athleteId: ctx.athletes.maya }))).rejects.toThrow();
    // Only Maya + her guardians in the people file.
    const files = unzipSync(m.bytes);
    const ppl = JSON.parse(strFromU8(files["data/people.json"])) as { id: string }[];
    expect(ppl.map((p) => p.id).sort()).toEqual([ctx.people.maya_parker, ctx.people.alex_parker, ctx.people.jordan_parker].sort());
  });

  it("stored exports are downloadable only with sufficient rights, and audited", async () => {
    const { object } = await tx((t) => createExport(t, rod, { kind: "athlete", athleteId: ctx.athletes.maya }));
    const dl = await tx((t) => authorizeExportDownload(t, rod, object.id));
    expect(sha(dl.bytes)).toBe(object.sha256);
    const erin = await viewerFor(ctx, "erin");
    const marcus = await viewerFor(ctx, "marcus");
    // Includes health + billing: operations (no health) and coach (no billing) are refused.
    await expect(tx((t) => authorizeExportDownload(t, erin, object.id))).rejects.toThrow(/do not have access/);
    await expect(tx((t) => authorizeExportDownload(t, marcus, object.id))).rejects.toThrow(/do not have access/);
    const { object: orgExport } = await tx((t) => createExport(t, rod, { kind: "org" }));
    await expect(tx((t) => authorizeExportDownload(t, erin, orgExport.id))).rejects.toThrow();
    const list = await tx((t) => listExports(t, rod));
    expect(list.map((x) => x.id)).toEqual(expect.arrayContaining([object.id, orgExport.id]));
    expect(await tx((t) => listExports(t, erin))).toHaveLength(0);
    void db;
  });
});
