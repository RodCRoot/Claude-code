import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";

export const importRouter = Router();
importRouter.use(requireAuth);

// Minimal CSV parser (handles quoted fields and commas inside quotes).
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f !== "")) rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
    return obj;
  });
}

/**
 * Bulk-import metric records from a CSV.
 *
 * Expected columns (header row, case-insensitive):
 *   athleteEmail | athleteId  (one is required to match the athlete)
 *   metricKey                 (must exist in the metric catalog)
 *   value                     (number)
 *   recordedAt                (optional ISO date)
 *   source                    (optional; defaults to CSV)
 *
 * Body: raw CSV text (Content-Type: text/csv or text/plain).
 */
importRouter.post(
  "/metrics-csv",
  requireRole("ADMIN", "COACH"),
  async (req: AuthedRequest, res) => {
    const csv = typeof req.body === "string" ? req.body : req.body?.csv;
    if (!csv || typeof csv !== "string") {
      return res.status(400).json({ error: "Send raw CSV text or { csv: \"...\" }" });
    }

    const rows = parseCsv(csv);
    const orgId = req.auth!.orgId;
    const metricTypes = await prisma.metricType.findMany();
    const byKey = new Map(metricTypes.map((m) => [m.key.toLowerCase(), m]));

    const errors: { row: number; reason: string }[] = [];
    const toCreate: { athleteId: string; metricTypeId: string; value: number; recordedAt: Date; source: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = lowerKeys(rows[i]);
      const mt = byKey.get((r.metrickey || "").toLowerCase());
      if (!mt) { errors.push({ row: i + 2, reason: `Unknown metricKey "${r.metrickey}"` }); continue; }

      let athlete = null;
      if (r.athleteid) {
        athlete = await prisma.athlete.findUnique({ where: { id: r.athleteid } });
      } else if (r.athleteemail) {
        const u = await prisma.user.findUnique({ where: { email: r.athleteemail }, include: { athlete: true } });
        athlete = u?.athlete ?? null;
      }
      if (!athlete || athlete.orgId !== orgId) {
        errors.push({ row: i + 2, reason: "Athlete not found in your org" });
        continue;
      }

      const value = Number(r.value);
      if (Number.isNaN(value)) { errors.push({ row: i + 2, reason: `Invalid value "${r.value}"` }); continue; }

      toCreate.push({
        athleteId: athlete.id,
        metricTypeId: mt.id,
        value,
        recordedAt: r.recordedat ? new Date(r.recordedat) : new Date(),
        source: (r.source || "CSV").toUpperCase(),
      });
    }

    if (toCreate.length) await prisma.metricRecord.createMany({ data: toCreate });
    res.json({ imported: toCreate.length, failed: errors.length, errors });
  }
);

function lowerKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}
