import type { ImportSchemaDef } from "../types";
import { genericMetricValues, genericPeople, wearableDaily } from "./generic";
import { hawkinApi, hawkinCsv } from "./hawkin";
import { tbMaxes, tbQuestionnaire, tbWorkoutLog } from "./teambuildr";
import { ghlContacts } from "./gohighlevel";
import { zpAttendance, zpDocumentsIndex, zpFamilyLinks, zpMembers, zpMemberships } from "./zenplanner";

/** Registry of every import schema, in wizard order. */
export const IMPORT_SCHEMAS: ImportSchemaDef[] = [
  zpMembers,
  zpFamilyLinks,
  zpMemberships,
  zpAttendance,
  zpDocumentsIndex,
  tbMaxes,
  tbWorkoutLog,
  tbQuestionnaire,
  hawkinCsv,
  genericPeople,
  genericMetricValues,
  wearableDaily,
  ghlContacts,
  hawkinApi,
];

export function getSchema(id: string): ImportSchemaDef {
  const s = IMPORT_SCHEMAS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown import schema ${id}`);
  return s;
}

export function findSchema(id: string): ImportSchemaDef | undefined {
  return IMPORT_SCHEMAS.find((x) => x.id === id);
}

export const uploadableSchemas = () => IMPORT_SCHEMAS.filter((s) => !s.internal);
