import { requireApiUser } from "@/lib/auth";
import { parseCsv, commitImport, IMPORT_TARGETS } from "@/lib/importer";
import { recordImportRun } from "@/lib/connectors";
import { db } from "@/db";
import { importMappings } from "@/db/schema";
import { revalidatePath } from "next/cache";

export async function POST(req: Request) {
  const auth = await requireApiUser("manage_imports");
  if ("error" in auth) return auth.error;

  let body: {
    target?: string;
    csvText?: string;
    mapping?: Record<string, string>;
    mappingName?: string;
    connectorKey?: string;
    sourceLabel?: string;
    dedupe?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { target, csvText, mapping } = body;
  if (!target || !IMPORT_TARGETS[target] || !csvText || !mapping) {
    return Response.json({ error: "Missing target, csvText, or mapping" }, { status: 400 });
  }

  // Required-field check
  const mapped = new Set(Object.values(mapping));
  const missing = IMPORT_TARGETS[target].fields
    .filter((f) => f.required && !mapped.has(f.key))
    .map((f) => f.label);
  if (missing.length > 0) {
    return Response.json(
      { error: `Map these required fields first: ${missing.join(", ")}` },
      { status: 400 }
    );
  }

  const parsed = parseCsv(csvText);
  const outcome = commitImport(target, parsed, mapping, auth.user.id, {
    dedupe: body.dedupe === true,
  });

  // Save mapping for reuse
  if (body.mappingName) {
    db.insert(importMappings)
      .values({
        name: body.mappingName,
        targetEntity: target,
        connectorKey: body.connectorKey ?? "csv",
        mapping: JSON.stringify(mapping),
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  recordImportRun(
    body.connectorKey === "google_sheets" ? "google_sheets" : "csv",
    outcome.processed,
    outcome.rejected,
    `${IMPORT_TARGETS[target].label} import (${body.sourceLabel ?? "CSV"}): ${outcome.processed} in, ${outcome.skipped} already known, ${outcome.rejected} rejected` +
      (outcome.errors.length ? ` — ${outcome.errors[0]}` : "")
  );

  revalidatePath("/");
  revalidatePath("/data");
  revalidatePath("/scoreboard");
  return Response.json(outcome);
}
