import { loadUnitFromHeaders, wrongVelocityUnits } from "@/lib/training/vbt-csv";
import { asDT, asNum, asText, canonicalUnit, localDateOf, splitName, syntheticId, zonedLocalToInstant } from "../normalize";
import type { ImportSchemaDef } from "../types";
import { DATETIME_HINT, emptyRow } from "./common";

/**
 * Bar-speed (velocity-based training) readings from a device export, e.g. a GymAware-style CSV
 * with headers like "Weight (kg)" and "Mean Velocity (m/s)". Athletes named only by name go to
 * identity review exactly like Hawkin CSV rows: a name is never matched to a person automatically,
 * and a staff-confirmed name is remembered as an alias for later files.
 */
export const vbtReadingsCsv: ImportSchemaDef = {
  id: "vbt.readings",
  source: "generic_csv",
  idSource: "vbt_csv",
  label: "Bar speed (VBT) readings CSV",
  description:
    "One row per rep or set from a velocity device export (GymAware-style headers such as \"Weight (kg)\" and \"Mean Velocity (m/s)\" are recognized). Creates bar-speed readings used for load-velocity estimates. Exercises must already be in the exercise library.",
  evidence: "unverified — configurable",
  recordEntityType: "vbt_reading",
  allowCreatePerson: false,
  limitations:
    "File import only: no device connection is claimed. Column names were not checked against a real vendor export, so every mapping is editable. Velocities must be in m/s and loads in lb or kg; nothing is converted. Rows with a blank or zero mean velocity are rejected; a missing speed is never stored as 0.",
  options: [
    {
      key: "defaultUnit",
      label: "Load unit when the file names none",
      choices: [
        { value: "", label: "None: reject rows without a unit" },
        { value: "lb", label: "Pounds (lb)" },
        { value: "kg", label: "Kilograms (kg)" },
      ],
      hint: "A unit in the header, such as \"Weight (kg)\", is used first. Units are never converted.",
    },
  ],
  fields: [
    { key: "athlete_id", label: "Athlete ID (external)", type: "text", aliases: ["athlete id", "athlete external id", "external id", "athlete_id", "user id"] },
    { key: "athlete_name", label: "Athlete name", type: "text", aliases: ["athlete", "athlete name", "name", "full name", "user"] },
    { key: "email", label: "Athlete email", type: "email", aliases: ["email", "athlete email", "email address"] },
    { key: "exercise", label: "Exercise", type: "text", required: true, aliases: ["exercise", "exercise name", "lift", "movement"] },
    { key: "performed_at", label: "Timestamp (date + time)", type: "datetime", aliases: ["timestamp", "date/time", "datetime", "date time", "performed at", "performed_at"], hint: DATETIME_HINT },
    { key: "date", label: "Date (if separate)", type: "date", aliases: ["date", "session date"] },
    { key: "time", label: "Time (if separate)", type: "time", aliases: ["time", "start time"] },
    { key: "load", label: "Load", type: "number", aliases: ["load", "weight", "weight (kg)", "weight (lb)", "weight (lbs)", "load (kg)", "load (lb)", "load (lbs)", "bar weight (kg)", "bar weight (lb)"] },
    { key: "unit", label: "Load unit", type: "text", aliases: ["unit", "units", "load unit", "weight unit"] },
    { key: "rep", label: "Rep #", type: "integer", aliases: ["rep", "rep #", "rep number", "rep no"] },
    {
      key: "mean_velocity",
      label: "Mean velocity (m/s)",
      type: "number",
      required: true,
      aliases: ["mean velocity", "mean velocity (m/s)", "mean_velocity", "avg velocity", "avg velocity (m/s)", "average velocity (m/s)", "mean concentric velocity (m/s)", "mean velocity [m/s]"],
    },
    { key: "peak_velocity", label: "Peak velocity (m/s)", type: "number", aliases: ["peak velocity", "peak velocity (m/s)", "peak_velocity", "peak velocity [m/s]"] },
    { key: "power", label: "Mean power (W)", type: "number", aliases: ["power", "mean power", "mean power (w)", "avg power (w)", "power (w)"] },
    { key: "device", label: "Device", type: "text", aliases: ["device", "sensor", "unit id"] },
  ],
  normalize(f, raw, ctx) {
    const r = emptyRow();
    const name = asText(f.athlete_name);
    const athleteId = asText(f.athlete_id);
    const { first, last } = splitName(name);
    if (!athleteId && (!first || !last)) r.errors.push("Athlete not identifiable: need an athlete ID or a first and last name.");
    r.identity = {
      // Like Hawkin CSVs: with no ID, the name itself is the source key, so a staff-confirmed
      // name links later files without another review. It never links by itself the first time.
      sourceEntityType: athleteId ? "athlete" : "athlete_name",
      sourceId: athleteId ?? (name ? name.trim().toLowerCase().replace(/\s+/g, " ") : null),
      firstName: first,
      lastName: last,
      email: asText(f.email),
      needsAthlete: true,
    };

    let at = asDT(f.performed_at);
    const date = asText(f.date);
    if (!at && date) {
      const time = asText(f.time);
      const z = zonedLocalToInstant(date, time ?? "00:00:00", ctx.tz);
      if (z.warning) r.warnings.push(z.warning);
      at = { iso: z.date.toISOString(), raw: [date, time].filter(Boolean).join(" "), offset: null, assumedTz: ctx.tz };
    }
    if (!at) r.errors.push("A timestamp (or a date) is required.");
    else {
      if (at.assumedTz) r.warnings.push(`No UTC offset in "${at.raw}"; read as ${ctx.tz} local time.`);
      r.dates.push(localDateOf(at, ctx.tz));
    }

    const headers = Object.keys(raw);
    const bad = wrongVelocityUnits(headers);
    if (bad.length) r.errors.push(`Velocity column "${bad[0]}" is not in m/s. Velocities are not converted.`);

    const load = asNum(f.load);
    let loadUnit: "lb" | "kg" | null = null;
    if (load) {
      const explicit = asText(f.unit);
      const u = canonicalUnit(explicit ?? loadUnitFromHeaders(headers) ?? ctx.options.defaultUnit ?? "");
      if (u === "lb" || u === "kg") loadUnit = u;
      else r.errors.push(explicit ? `Load unit "${explicit}" is not lb or kg.` : "Load given without a unit (name it in the header, add a unit column, or choose a default unit). Not guessed.");
      if (load.value < 0 || load.value > 5000) r.errors.push(`Load "${load.raw}" is out of range.`);
    }
    const speed = (key: "mean_velocity" | "peak_velocity", label: string, max: number): number | null => {
      const n = asNum(f[key]);
      if (!n) return null;
      if (n.value === 0) {
        if (key === "mean_velocity") r.errors.push("Mean velocity is 0 (a failed or unmeasured rep). A missing speed is never stored as 0, so the row is not imported.");
        else r.warnings.push(`${label} is 0; stored as missing, not 0.`);
        return null;
      }
      if (n.value < 0 || n.value > max) {
        r.errors.push(`${label} "${n.raw}" is not a plausible speed in m/s.`);
        return null;
      }
      return n.value;
    };
    const meanVelocity = speed("mean_velocity", "Mean velocity", 10);
    const peakVelocity = speed("peak_velocity", "Peak velocity", 15);
    const power = asNum(f.power);
    const rep = asNum(f.rep);
    if (rep && (rep.value < 1 || rep.value > 100)) r.errors.push(`Rep "${rep.raw}" is out of range.`);
    const exercise = asText(f.exercise);
    r.data = {
      exercise,
      performedAt: at?.iso ?? null,
      sourceTimestamp: at?.raw ?? null,
      load: load ? load.value : null,
      loadUnit,
      rep: rep?.value ?? null,
      meanVelocity,
      peakVelocity,
      power: power && power.value > 0 ? power.value : null,
      device: asText(f.device),
    };
    r.sourceRecordId = syntheticId(ctx.orgId, "vbt", athleteId ?? name?.toLowerCase(), exercise?.toLowerCase(), at?.iso, rep?.raw, load?.raw);
    return r;
  },
};
