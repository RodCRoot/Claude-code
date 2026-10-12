import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { storedObjects } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { loadRequestContext } from "@/lib/forms/context";
import { sha256Bytes } from "@/lib/storage";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

// The route resolves the viewer from the session cookie; tests inject it directly.
const current: { viewer: Viewer | null } = { viewer: null };
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => current.viewer }));

const { GET } = await import("@/app/api/files/[id]/route");

let ctx: Awaited<ReturnType<typeof seedOrg>>;
let pdfId: string;

beforeAll(async () => {
  ctx = await seedOrg();
  const c = await loadRequestContext(testDb(), ctx.orgId, ctx.extra.formRequests.waiverMaya);
  pdfId = c!.req.completedPdfObjectId!;
});
afterAll(closeTestDb);

async function download(userKey: string | null, id = pdfId) {
  current.viewer = userKey ? await viewerFor(ctx, userKey) : null;
  const req = new NextRequest(`http://localhost/api/files/${id}`);
  return GET(req, { params: Promise.resolve({ id }) });
}

describe("/api/files/[id]", () => {
  it("serves the completed PDF to an authorized guardian with matching checksum", async () => {
    const res = await download("alex");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const [obj] = await testDb().select().from(storedObjects).where(eq(storedObjects.id, pdfId));
    expect(sha256Bytes(bytes)).toBe(obj.sha256);
  });

  it("allows the subject athlete, the second guardian, and operations staff", async () => {
    expect((await download("maya")).status).toBe(200);
    expect((await download("jordan")).status).toBe(200);
    expect((await download("erin")).status).toBe(200);
    expect((await download("rod")).status).toBe(200);
  });

  it("denies cross-family access, coaches, other athletes, and kiosks with 404", async () => {
    expect((await download("chris")).status).toBe(404);
    expect((await download("sam")).status).toBe(404);
    expect((await download("dana")).status).toBe(404);
    expect((await download("marcus")).status).toBe(404); // assigned coach: status only, no PDFs
    expect((await download("tess")).status).toBe(404);
    expect((await download("kiosk")).status).toBe(404);
  });

  it("requires a session and rejects malformed / unknown ids", async () => {
    expect((await download(null)).status).toBe(401);
    expect((await download("alex", "not-a-uuid")).status).toBe(404);
    expect((await download("alex", "00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });

  it("does not serve objects from another organization", async () => {
    const other = await seedOrg();
    const c = await loadRequestContext(testDb(), other.orgId, other.extra.formRequests.waiverMaya);
    const otherPdf = c!.req.completedPdfObjectId!;
    expect((await download("rod", otherPdf)).status).toBe(404);
  });
});
