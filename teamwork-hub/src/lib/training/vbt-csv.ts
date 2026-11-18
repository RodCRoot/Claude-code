import { createHash } from "node:crypto";

/**
 * Header handling for bar-speed (VBT) CSV exports. Pure.
 *
 * Device software (GymAware-style exports and others) writes units into the header, e.g.
 * "Mean Velocity (m/s)" or "Weight (kg)". We strip the unit so the column is recognized and keep
 * it so the load unit can be read from "Weight (kg)" when the file has no unit column.
 * Nothing is converted: a unit we do not expect is reported, never guessed.
 */

export type VbtHeader = { key: string; unit: string | null };

/** "Mean Velocity (m/s)" → { key: "mean_velocity", unit: "m/s" }; "Weight [kg]" → { key: "weight", unit: "kg" }. */
export function normalizeVbtHeader(header: string): VbtHeader {
  let h = header.replace(/^﻿/, "").trim().toLowerCase();
  let unit: string | null = null;
  const m = /^(.*?)\s*[([]\s*([^()[\]]{1,12}?)\s*[)\]]$/.exec(h);
  if (m && m[1].trim()) {
    h = m[1];
    unit = m[2].trim();
  }
  const key = h
    .replace(/#/g, " number ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return { key, unit };
}

const LOAD_KEYS = ["load", "weight", "bar_weight", "bar_load", "external_load", "mass"];
const VELOCITY_KEYS = /(^|_)velocity($|_)/;

/** Load unit named in a load column header ("Weight (kg)", "Load (lbs)"). Null when none or not lb/kg. */
export function loadUnitFromHeaders(headers: string[]): "lb" | "kg" | null {
  for (const raw of headers) {
    const h = normalizeVbtHeader(raw);
    if (!LOAD_KEYS.includes(h.key) || !h.unit) continue;
    if (h.unit === "kg" || h.unit === "kgs") return "kg";
    if (h.unit === "lb" || h.unit === "lbs") return "lb";
  }
  return null;
}

/** Velocity columns whose header names a unit other than m/s. These files are refused, not converted. */
export function wrongVelocityUnits(headers: string[]): string[] {
  return headers.filter((raw) => {
    const h = normalizeVbtHeader(raw);
    return VELOCITY_KEYS.test(h.key) && h.unit != null && h.unit.replace(/\s+/g, "") !== "m/s";
  });
}

/** Same reading → same id on every import path, so re-imports and the review path never duplicate. */
export function vbtSourceRecordId(orgId: string, athleteId: string, exerciseId: string, performedAtIso: string, rep: number | null, load: number | null): string {
  return `vbtcsv:${orgId}:${createHash("sha256").update([athleteId, exerciseId, performedAtIso, rep ?? "", load ?? ""].join("|")).digest("hex").slice(0, 32)}`;
}
