"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Select, Field, Badge } from "@/components/ui";

interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
}
interface PreviewData {
  headers: string[];
  sample: Record<string, string>[];
  rowCount: number;
  csvText: string;
  sourceLabel: string;
  fields: FieldDef[];
  savedMappings: { id: number; name: string; mapping: Record<string, string> }[];
}

const TARGETS = [
  { key: "leads", label: "Leads" },
  { key: "athletes", label: "Athletes" },
  { key: "attendance", label: "Attendance" },
  { key: "payments", label: "Payments" },
  { key: "kpi_values", label: "KPI values" },
];

export function ImportWizard() {
  const router = useRouter();
  const [target, setTarget] = useState("leads");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mappingName, setMappingName] = useState("");
  const [dedupe, setDedupe] = useState(true);
  const [fromSheets, setFromSheets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    processed: number;
    rejected: number;
    skipped: number;
    errors: string[];
  } | null>(null);

  async function loadPreview(formData: FormData) {
    setBusy(true);
    setError(null);
    setResult(null);
    formData.set("target", target);
    try {
      const res = await fetch("/api/import/preview", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Preview failed");
        return;
      }
      setPreview(data);
      setFromSheets(data.sourceLabel === "Google Sheets");
      // auto-map columns whose names resemble canonical fields
      const auto: Record<string, string> = {};
      for (const h of data.headers as string[]) {
        const norm = h.toLowerCase().replace(/[^a-z0-9]/g, "_");
        const hit = (data.fields as FieldDef[]).find(
          (f) =>
            f.key === norm ||
            f.key.replace(/_/g, "") === norm.replace(/_/g, "") ||
            f.label.toLowerCase().replace(/[^a-z0-9]/g, "_").startsWith(norm)
        );
        if (hit && !Object.values(auto).includes(hit.key)) auto[h] = hit.key;
      }
      setMapping(auto);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          csvText: preview.csvText,
          mapping,
          mappingName: mappingName || undefined,
          connectorKey: fromSheets ? "google_sheets" : "csv",
          sourceLabel: preview.sourceLabel,
          dedupe,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Import failed");
        return;
      }
      setResult(data);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  const requiredUnmapped =
    preview?.fields.filter((f) => f.required && !Object.values(mapping).includes(f.key)) ?? [];

  return (
    <div className="space-y-6">
      {/* Step 1 */}
      <section className="rounded-xl border border-edge bg-surface-2 p-5">
        <div className="kicker mb-2">Step 1 — What are you importing?</div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Import target">
            <Select value={target} onChange={(e) => { setTarget(e.target.value); setPreview(null); setResult(null); }} className="w-48">
              {TARGETS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            loadPreview(new FormData(e.currentTarget));
          }}
        >
          <Field label="Upload a CSV export" hint="Zen Planner reports, CRM exports, or Gmail-delivered report attachments">
            <Input type="file" name="file" accept=".csv,text/csv" className="py-1.5" />
          </Field>
          <Field
            label="…or paste a Google Sheets URL"
            hint="Sheet must be shared as “anyone with the link can view”"
          >
            <Input name="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/…" />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Reading…" : "Preview data →"}
            </Button>
          </div>
        </form>
      </section>

      {error && (
        <p className="rounded-lg bg-bad/10 px-4 py-3 text-sm font-medium text-bad">{error}</p>
      )}

      {/* Step 2 */}
      {preview && !result && (
        <section className="rounded-xl border border-edge bg-surface-2 p-5">
          <div className="kicker mb-2">
            Step 2 — Map columns ({preview.rowCount} rows from {preview.sourceLabel})
          </div>
          {preview.savedMappings.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-3">Saved mappings:</span>
              {preview.savedMappings.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMapping(m.mapping)}
                  className="rounded-full border border-edge px-2.5 py-1 text-xs font-semibold hover:bg-surface-3"
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border border-edge">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="border-b border-edge bg-surface-3/60 text-left">
                  <th className="px-3 py-2 text-xs font-semibold uppercase text-ink-3">CSV column</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase text-ink-3">Sample values</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase text-ink-3">Maps to</th>
                </tr>
              </thead>
              <tbody>
                {preview.headers.map((h) => (
                  <tr key={h} className="border-b border-edge/60 last:border-0">
                    <td className="px-3 py-2 font-medium">{h}</td>
                    <td className="max-w-56 truncate px-3 py-2 text-xs text-ink-3">
                      {preview.sample.map((r) => r[h]).filter(Boolean).slice(0, 3).join(" · ")}
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        value={mapping[h] ?? ""}
                        onChange={(e) =>
                          setMapping((m) => {
                            const next = { ...m };
                            if (e.target.value) next[h] = e.target.value;
                            else delete next[h];
                            return next;
                          })
                        }
                        className="h-8 w-64 text-xs"
                      >
                        <option value="">— ignore —</option>
                        {preview.fields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                            {f.required ? " *" : ""}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {requiredUnmapped.length > 0 && (
            <p className="mt-2 text-xs font-medium text-warn">
              Still required: {requiredUnmapped.map((f) => f.label).join(", ")}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <Field label="Save this mapping as (optional)">
              <Input
                value={mappingName}
                onChange={(e) => setMappingName(e.target.value)}
                placeholder="e.g. ZP attendance export"
                className="w-64"
              />
            </Field>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={dedupe}
                onChange={(e) => setDedupe(e.target.checked)}
                className="size-4"
              />
              Skip rows that already exist
              <span className="text-xs text-ink-3">(safe to re-import the same report)</span>
            </label>
            <Button onClick={commit} disabled={busy || requiredUnmapped.length > 0}>
              {busy ? "Importing…" : `Import ${preview.rowCount} rows`}
            </Button>
          </div>
        </section>
      )}

      {/* Step 3 */}
      {result && (
        <section className="rounded-xl border border-edge bg-surface-2 p-5">
          <div className="kicker mb-2">Step 3 — Result</div>
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="green">{result.processed} imported</Badge>
            {result.skipped > 0 ? (
              <Badge variant="neutral">{result.skipped} already existed</Badge>
            ) : null}
            {result.rejected > 0 ? (
              <Badge variant="red">{result.rejected} rejected</Badge>
            ) : (
              <Badge variant="neutral">0 rejected</Badge>
            )}
          </div>
          {result.errors.length > 0 && (
            <ul className="mt-3 list-inside list-disc text-xs text-bad">
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm text-ink-2">
            The import was logged to sync history. Numbers on the scoreboard update
            immediately.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" onClick={() => { setPreview(null); setResult(null); }}>
              Import another file
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
