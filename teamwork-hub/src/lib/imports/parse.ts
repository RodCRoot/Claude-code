import Papa from "papaparse";
import { unzipSync } from "fflate";

export type ParsedFile = {
  format: "csv" | "json";
  headers: string[];
  /** Raw cell text per header. Values are kept as strings exactly as written (no type coercion). */
  rows: Record<string, string | null>[];
  /** Files bundled alongside the data (from a .zip upload), keyed by lower-cased base name and path. */
  attachments: Map<string, Uint8Array>;
  /** Name of the data file inside a zip, when applicable. */
  dataFileName?: string;
};

export class ParseError extends Error {}

const MAX_ROWS = 50_000;

function stripBom(s: string) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function jsonCell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function parseCsvText(text: string): { headers: string[]; rows: Record<string, string | null>[] } {
  const res = Papa.parse<string[]>(stripBom(text), { skipEmptyLines: "greedy" });
  if (res.errors.length && !res.data.length) throw new ParseError(`CSV could not be read: ${res.errors[0].message}`);
  const [head, ...body] = res.data;
  if (!head || head.length === 0) throw new ParseError("The file has no header row.");
  const headers = head.map((h, i) => (h ?? "").trim() || `column_${i + 1}`);
  const seen = new Map<string, number>();
  const uniq = headers.map((h) => {
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return n ? `${h} (${n + 1})` : h;
  });
  if (body.length > MAX_ROWS) throw new ParseError(`The file has ${body.length} rows; split it into files of at most ${MAX_ROWS}.`);
  const rows = body.map((cells) => {
    const r: Record<string, string | null> = {};
    uniq.forEach((h, i) => {
      const c = cells[i];
      r[h] = c === undefined || c === "" ? null : c;
    });
    return r;
  });
  return { headers: uniq, rows };
}

/** JSON: an array of flat objects, or { data | rows | items | results: [...] }. Nested objects are kept as JSON text. */
export function parseJsonText(text: string): { headers: string[]; rows: Record<string, string | null>[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(stripBom(text));
  } catch {
    throw new ParseError("The JSON file is not valid JSON.");
  }
  const arr = Array.isArray(doc)
    ? doc
    : doc && typeof doc === "object"
      ? ((["data", "rows", "items", "results", "tests"].map((k) => (doc as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined) ?? null)
      : null;
  if (!arr) throw new ParseError("JSON must be an array of records (or an object with a data/rows/items array).");
  if (arr.length > MAX_ROWS) throw new ParseError(`The file has ${arr.length} records; split it into files of at most ${MAX_ROWS}.`);
  const headers: string[] = [];
  const rows = arr.map((o) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new ParseError("Every JSON record must be an object.");
    const r: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (!headers.includes(k)) headers.push(k);
      r[k] = jsonCell(v);
    }
    return r;
  });
  for (const r of rows) for (const h of headers) if (!(h in r)) r[h] = null;
  return { headers, rows };
}

/** Parse an uploaded file by name. A .zip must contain exactly one .csv/.json data file; other files become attachments. */
export function parseUpload(filename: string, bytes: Uint8Array): ParsedFile {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip")) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw new ParseError("The .zip could not be opened.");
    }
    const names = Object.keys(entries).filter((n) => !n.endsWith("/") && !n.startsWith("__MACOSX/"));
    const data = names.filter((n) => /\.(csv|json)$/i.test(n));
    if (data.length !== 1) throw new ParseError(`A .zip must contain exactly one .csv or .json index file (found ${data.length}).`);
    const inner = parseUpload(data[0], entries[data[0]]);
    const attachments = new Map<string, Uint8Array>();
    for (const n of names) {
      if (n === data[0]) continue;
      attachments.set(n.toLowerCase(), entries[n]);
      attachments.set(n.split("/").pop()!.toLowerCase(), entries[n]);
    }
    return { ...inner, attachments, dataFileName: data[0] };
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    throw new ParseError("Excel files are not read directly. In Excel/Sheets use File → Save as / Download → CSV, then upload the CSV.");
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (lower.endsWith(".json")) return { format: "json", ...parseJsonText(text), attachments: new Map() };
  if (lower.endsWith(".csv") || lower.endsWith(".txt") || lower.endsWith(".tsv")) return { format: "csv", ...parseCsvText(text), attachments: new Map() };
  // Sniff
  const t = text.trimStart();
  if (t.startsWith("[") || t.startsWith("{")) return { format: "json", ...parseJsonText(text), attachments: new Map() };
  return { format: "csv", ...parseCsvText(text), attachments: new Map() };
}
