import { requireApiUser } from "@/lib/auth";
import { parseCsv, IMPORT_TARGETS } from "@/lib/importer";
import { db } from "@/db";
import { importMappings } from "@/db/schema";

function sheetsCsvUrl(url: string): string | null {
  const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

export async function POST(req: Request) {
  const auth = await requireApiUser("manage_imports");
  if ("error" in auth) return auth.error;

  const form = await req.formData();
  const target = String(form.get("target") ?? "");
  if (!IMPORT_TARGETS[target]) {
    return Response.json({ error: "Unknown import target" }, { status: 400 });
  }

  let csvText = "";
  const file = form.get("file");
  const sheetUrl = String(form.get("sheetUrl") ?? "").trim();
  let sourceLabel = "CSV upload";

  if (file instanceof File && file.size > 0) {
    if (file.size > 5 * 1024 * 1024) {
      return Response.json({ error: "File too large (max 5 MB)" }, { status: 400 });
    }
    csvText = await file.text();
    sourceLabel = file.name;
  } else if (sheetUrl) {
    const exportUrl = sheetsCsvUrl(sheetUrl);
    if (!exportUrl) {
      return Response.json(
        { error: "That does not look like a Google Sheets URL." },
        { status: 400 }
      );
    }
    try {
      const res = await fetch(exportUrl, { redirect: "follow" });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || contentType.includes("text/html")) {
        return Response.json(
          {
            error:
              "Could not read the sheet. Make sure link-sharing is set to “anyone with the link can view”.",
          },
          { status: 400 }
        );
      }
      csvText = await res.text();
      sourceLabel = "Google Sheets";
    } catch (e) {
      return Response.json(
        { error: `Fetching the sheet failed: ${e instanceof Error ? e.message : e}` },
        { status: 502 }
      );
    }
  } else {
    return Response.json({ error: "Provide a CSV file or a Google Sheets URL" }, { status: 400 });
  }

  const parsed = parseCsv(csvText);
  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    return Response.json({ error: "No rows found in that data." }, { status: 400 });
  }

  const saved = db
    .select()
    .from(importMappings)
    .all()
    .filter((m) => m.targetEntity === target)
    .map((m) => ({ id: m.id, name: m.name, mapping: JSON.parse(m.mapping) }));

  return Response.json({
    headers: parsed.headers,
    sample: parsed.rows.slice(0, 5),
    rowCount: parsed.rows.length,
    csvText,
    sourceLabel,
    fields: IMPORT_TARGETS[target].fields,
    savedMappings: saved,
  });
}
