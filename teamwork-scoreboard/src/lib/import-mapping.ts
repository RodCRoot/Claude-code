/**
 * Matching spreadsheet column names to canonical import fields.
 *
 * Kept free of database imports on purpose: the import wizard is a client
 * component, and the browser must not pull in Drizzle to guess a column name.
 * Both the wizard and the scheduled browser sync use these, so the two cannot
 * disagree about what a column means.
 */

export interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  /**
   * Other column names that mean this field. Needed because exports name the
   * same thing differently — Zen Planner's grids head the person column
   * "Name", while the attendance and payment targets call it `athlete_name`.
   * Without aliases every such row is rejected for a missing name.
   */
  aliases?: string[];
}

/**
 * Fold a column heading into a comparable key: "First Name", "firstName" and
 * "FIRST_NAME" all become `first_name`. The camelCase split matters because
 * Zen Planner report URLs name their columns that way (`dueDate`, `billAmount`).
 */
export function normalizeKey(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** `first_name` and `firstname` should compare equal. */
const squash = (s: string) => s.replace(/_/g, "");

/**
 * Guess a column → field mapping.
 *
 * Runs in priority passes rather than per-column, so a confident match always
 * beats a vague one no matter the column order. Given both "Name" and "Athlete
 * Name", the exact alias wins the field and the other column is left unmapped
 * instead of claiming it first by being earlier in the file.
 */
export function autoMapHeaders(
  fields: FieldDef[],
  headers: string[]
): Record<string, string> {
  const mapping: Record<string, string> = {};
  const takenFields = new Set<string>();
  const usedHeaders = new Set<string>();
  const norm = new Map(headers.map((h) => [h, normalizeKey(h)]));

  const matchers: ((field: FieldDef, header: string) => boolean)[] = [
    // 1. The column is named exactly like the field.
    (f, h) => f.key === norm.get(h),
    // 2. The column is a known alias of the field.
    (f, h) => (f.aliases ?? []).some((a) => normalizeKey(a) === norm.get(h)),
    // 3. Same letters, different punctuation.
    (f, h) => squash(f.key) === squash(norm.get(h) ?? ""),
    (f, h) => (f.aliases ?? []).some((a) => squash(normalizeKey(a)) === squash(norm.get(h) ?? "")),
    // 4. The field's human label starts with the column name — the loosest
    //    rule, which is why it runs last.
    (f, h) => {
      const n = norm.get(h);
      return !!n && n.length >= 3 && normalizeKey(f.label).startsWith(n);
    },
  ];

  for (const matches of matchers) {
    for (const header of headers) {
      if (usedHeaders.has(header)) continue;
      const field = fields.find((f) => !takenFields.has(f.key) && matches(f, header));
      if (!field) continue;
      mapping[header] = field.key;
      takenFields.add(field.key);
      usedHeaders.add(header);
    }
  }
  return mapping;
}

/** Required fields a mapping has not covered. */
export function missingRequired(
  fields: FieldDef[],
  mapping: Record<string, string>
): FieldDef[] {
  const mapped = new Set(Object.values(mapping));
  return fields.filter((f) => f.required && !mapped.has(f.key));
}
