import { asDT, asNum, asText, canonicalUnit, decimalsOf, localDateOf, slug, syntheticId } from "../normalize";
import type { FieldValue, ImportSchemaDef } from "../types";
import { emptyRow, identityFrom, personFields, resolveName } from "./common";

const TB_LIMITS =
  "TeamBuildr has no public data API documented in its knowledge base; these are report exports (Max Report, Raw Data Report, Questionnaire Report — also delivered by the Platinum Pro FTP export). Column names are not published, so every mapping is editable. Licensed exercise videos and program templates are not imported.";

const UNIT_OPTION = {
  key: "defaultUnit",
  label: "Load unit when the file has no unit column",
  choices: [
    { value: "", label: "None — reject rows without a unit" },
    { value: "lb", label: "Pounds (lb)" },
    { value: "kg", label: "Kilograms (kg)" },
  ],
  hint: "Units are never converted: a kg value stays kg.",
};

function athleteKey(f: Record<string, FieldValue>) {
  return asText(f.source_person_id) ?? `${resolveName(f).first}|${resolveName(f).last}|${asText(f.email) ?? ""}`.toLowerCase();
}

function loadUnit(unitField: FieldValue, header: string | undefined, options: Record<string, string>, errors: string[], warnings: string[]): "lb" | "kg" | null {
  const explicit = asText(unitField);
  const fromHeader = header ? /\((lb|lbs|kg)\)/i.exec(header)?.[1] : undefined;
  const u = canonicalUnit(explicit ?? fromHeader ?? options.defaultUnit ?? "");
  if (u === "lb" || u === "kg") return u;
  if (explicit) errors.push(`Load unit "${explicit}" is not lb or kg.`);
  else {
    errors.push("No load unit (add a unit column or choose a default unit on the mapping step).");
  }
  void warnings;
  return null;
}

export const tbMaxes: ImportSchemaDef = {
  id: "teambuildr.maxes",
  source: "teambuildr",
  idSource: "teambuildr",
  label: "TeamBuildr — Max report",
  description: "Max Report export. Creates imported max history (append-only) per athlete and exercise. Units preserved exactly.",
  evidence: "unverified — configurable",
  recordEntityType: "max",
  allowCreatePerson: true,
  limitations: TB_LIMITS + " Max values are stored with 2 decimal places; more precise source text is kept on the import row.",
  options: [UNIT_OPTION],
  fields: [
    ...personFields({ idAliases: ["athlete id", "user id", "teambuildr id"] }),
    { key: "exercise", label: "Exercise", type: "text", required: true, aliases: ["exercise", "exercise name", "lift", "movement"] },
    { key: "max", label: "Max value", type: "number", required: true, aliases: ["max", "max value", "value", "weight", "1rm", "result", "max (lb)", "max (kg)"] },
    { key: "unit", label: "Unit", type: "text", aliases: ["unit", "units", "weight unit"] },
    { key: "date", label: "Date", type: "date", required: true, aliases: ["date", "date set", "max date", "recorded", "date recorded"] },
    { key: "max_type", label: "Tested / estimated", type: "text", aliases: ["type", "max type", "source", "tested/estimated", "method"] },
  ],
  normalize(f, raw, ctx) {
    const r = emptyRow();
    r.identity = identityFrom(f, ctx, { sourceEntityType: "athlete", needsAthlete: true }, r.errors);
    const max = asNum(f.max);
    const header = Object.keys(raw).find((h) => /max|1rm|weight/i.test(h) && /\((lb|lbs|kg)\)/i.test(h));
    const unit = loadUnit(f.unit, header, ctx.options, r.errors, r.warnings);
    const t = (asText(f.max_type) ?? "").toLowerCase();
    const kind = /test/.test(t) ? "tested" : /estim|calc|predict/.test(t) ? "estimated" : "imported";
    if (max && decimalsOf(max.raw) > 2) r.warnings.push(`Max "${max.raw}" has more than 2 decimals; stored rounded to 2 (source text kept on the import row).`);
    r.data = { exercise: asText(f.exercise), value: max?.value ?? null, rawValue: max?.raw ?? null, unit, date: asText(f.date), kind, method: `teambuildr_${kind}` };
    if (asText(f.date)) r.dates.push(asText(f.date)!);
    r.sourceRecordId = syntheticId(ctx.orgId, "tb-max", athleteKey(f), asText(f.exercise)?.toLowerCase(), asText(f.date), max?.raw, unit);
    return r;
  },
};

export const tbWorkoutLog: ImportSchemaDef = {
  id: "teambuildr.workout_log",
  source: "teambuildr",
  idSource: "teambuildr",
  label: "TeamBuildr — Workout log (Raw Data report)",
  description: "Raw Data Report export, one row per performed set. Creates completed historical workouts with set logs (logged via import).",
  evidence: "unverified — configurable",
  recordEntityType: "set",
  allowCreatePerson: true,
  limitations: TB_LIMITS + " Prescriptions are not reconstructed; only what was performed (sets, reps, load, RPE) is imported.",
  options: [UNIT_OPTION],
  fields: [
    ...personFields({ idAliases: ["athlete id", "user id", "teambuildr id"] }),
    { key: "date", label: "Date", type: "date", required: true, aliases: ["date", "workout date", "completed date", "day"] },
    { key: "workout", label: "Workout title", type: "text", aliases: ["workout", "workout title", "workout name", "session", "program day"] },
    { key: "exercise", label: "Exercise", type: "text", required: true, aliases: ["exercise", "exercise name", "lift", "movement"] },
    { key: "set_number", label: "Set #", type: "integer", required: true, aliases: ["set", "set #", "set number", "set no"] },
    { key: "reps", label: "Reps", type: "integer", aliases: ["reps", "repetitions", "reps completed"] },
    { key: "load", label: "Load", type: "number", aliases: ["weight", "load", "result", "weight (lb)", "weight (kg)"] },
    { key: "unit", label: "Unit", type: "text", aliases: ["unit", "units", "weight unit"] },
    { key: "rpe", label: "RPE", type: "number", aliases: ["rpe", "effort"] },
    { key: "note", label: "Note", type: "text", aliases: ["note", "notes", "comment"] },
  ],
  normalize(f, raw, ctx) {
    const r = emptyRow();
    r.identity = identityFrom(f, ctx, { sourceEntityType: "athlete", needsAthlete: true }, r.errors);
    const load = asNum(f.load);
    let unit: "lb" | "kg" | null = null;
    if (load) {
      const header = Object.keys(raw).find((h) => /weight|load/i.test(h) && /\((lb|lbs|kg)\)/i.test(h));
      unit = loadUnit(f.unit, header, ctx.options, r.errors, r.warnings);
    }
    const reps = asNum(f.reps);
    const rpe = asNum(f.rpe);
    const set = asNum(f.set_number);
    r.data = {
      date: asText(f.date),
      workout: asText(f.workout) ?? "TeamBuildr workout",
      exercise: asText(f.exercise),
      setIndex: set ? set.value : null,
      reps: reps?.value ?? null,
      load: load?.raw.replace(/,/g, "") ?? null,
      loadUnit: unit,
      rpe: rpe?.raw ?? null,
      note: asText(f.note),
    };
    if (asText(f.date)) r.dates.push(asText(f.date)!);
    r.sourceRecordId = syntheticId(ctx.orgId, "tb-set", athleteKey(f), asText(f.date), asText(f.workout), asText(f.exercise)?.toLowerCase(), set?.raw);
    return r;
  },
};

export const tbQuestionnaire: ImportSchemaDef = {
  id: "teambuildr.questionnaire",
  source: "teambuildr",
  idSource: "teambuildr",
  label: "TeamBuildr — Questionnaire report (AMS)",
  description:
    "Questionnaire Report export in long format (one row per athlete, date, question). Answers for the same athlete/date/questionnaire are combined into one response. Unanswered items stay null.",
  evidence: "unverified — configurable",
  recordEntityType: "questionnaire_answer",
  allowCreatePerson: true,
  limitations:
    TB_LIMITS +
    " Imported questionnaires keep the TeamBuildr question wording; scale anchors and color thresholds are not imported. A missing response row means 'no response', never 'fine'.",
  fields: [
    ...personFields({ idAliases: ["athlete id", "user id", "teambuildr id"] }),
    { key: "date", label: "Date", type: "date", required: true, aliases: ["date", "response date", "submitted", "day"] },
    { key: "questionnaire", label: "Questionnaire", type: "text", aliases: ["questionnaire", "questionnaire name", "survey", "form"] },
    { key: "question", label: "Question", type: "text", required: true, aliases: ["question", "item", "prompt", "metric"] },
    { key: "response", label: "Response", type: "text", aliases: ["response", "answer", "value", "score"] },
    { key: "submitted_at", label: "Submitted at", type: "datetime", aliases: ["submitted at", "timestamp", "time"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    r.identity = identityFrom(f, ctx, { sourceEntityType: "athlete", needsAthlete: true }, r.errors);
    const resp = asText(f.response);
    const n = resp === null ? undefined : Number(resp);
    const sub = asDT(f.submitted_at);
    r.data = {
      date: asText(f.date),
      questionnaire: asText(f.questionnaire) ?? "TeamBuildr questionnaire",
      question: asText(f.question),
      questionKey: slug(asText(f.question) ?? ""),
      answer: resp === null ? null : n !== undefined && Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(resp) ? n : resp,
      submittedAt: sub?.iso ?? null,
      sourceTimestamp: sub?.raw ?? null,
    };
    if (sub && !asText(f.date)) r.data.date = localDateOf(sub, ctx.tz);
    if (r.data.date) r.dates.push(r.data.date as string);
    r.sourceRecordId = syntheticId(ctx.orgId, "tb-q", athleteKey(f), r.data.date, r.data.questionnaire, r.data.questionKey);
    return r;
  },
};
