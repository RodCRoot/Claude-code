import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, externalIds, people } from "@/db/schema";
import type { IdentityInput } from "./types";

export type Candidate = { personId: string; reason: string };

export type MatchResult = {
  confidence: "exact_source_id" | "strong" | "ambiguous" | "none";
  personId: string | null;
  candidates: Candidate[];
};

/** Stable key so every row about the same source person shares one decision. */
export function identityKey(i: IdentityInput): string {
  if (i.sourceId) return `${i.sourceEntityType}:${i.sourceId}`;
  return `name:${(i.firstName ?? "").toLowerCase()}|${(i.lastName ?? "").toLowerCase()}|${i.dob ?? ""}|${(i.email ?? "").toLowerCase()}`;
}

/**
 * Identity matching rules (never merges silently):
 *  (a) external_ids exact source id → linked
 *  (b) exact first+last AND exact DOB (or exact email for adults) with exactly one
 *      candidate overall → "strong" (still confirmed by staff)
 *  (c) anything else with candidates (name-only, shared surname+DOB, shared email) → ambiguous
 *  (d) no candidates → none (create new when the schema allows)
 */
export async function matchPerson(tx: Tx, orgId: string, idSource: string, i: IdentityInput): Promise<MatchResult> {
  if (i.sourceId) {
    const [ext] = await tx
      .select({ localId: externalIds.localId })
      .from(externalIds)
      .where(
        and(
          eq(externalIds.orgId, orgId),
          eq(externalIds.source, idSource),
          eq(externalIds.sourceEntityType, i.sourceEntityType),
          eq(externalIds.sourceId, i.sourceId),
          eq(externalIds.localEntityType, "person"),
        ),
      );
    if (ext) return { confidence: "exact_source_id", personId: ext.localId, candidates: [{ personId: ext.localId, reason: `${idSource} ${i.sourceEntityType} id ${i.sourceId}` }] };
  }

  const first = i.firstName?.trim().toLowerCase() ?? null;
  const last = i.lastName?.trim().toLowerCase() ?? null;
  const email = i.email?.trim().toLowerCase() ?? null;
  const conds = [];
  if (first && last) conds.push(sql`(lower(${people.firstName}) = ${first} and lower(${people.lastName}) = ${last})`);
  if (email) conds.push(sql`lower(${people.email}) = ${email}`);
  if (last && i.dob) conds.push(sql`(lower(${people.lastName}) = ${last} and ${people.dateOfBirth} = ${i.dob})`);
  if (!conds.length) return { confidence: "none", personId: null, candidates: [] };

  const rows = await tx
    .select({ id: people.id, firstName: people.firstName, lastName: people.lastName, dob: people.dateOfBirth, email: people.email, archivedAt: people.archivedAt })
    .from(people)
    .where(and(eq(people.orgId, orgId), sql`(${sql.join(conds, sql` or `)})`))
    .limit(25);
  if (!rows.length) return { confidence: "none", personId: null, candidates: [] };

  const candidates: Candidate[] = rows.map((p) => {
    const reasons: string[] = [];
    const nameEq = !!first && !!last && p.firstName.toLowerCase() === first && p.lastName.toLowerCase() === last;
    if (nameEq) reasons.push("same first + last name");
    else if (last && p.lastName.toLowerCase() === last) reasons.push("same surname");
    if (i.dob && p.dob === i.dob) reasons.push("same date of birth");
    else if (i.dob && p.dob && p.dob !== i.dob) reasons.push(`different DOB (${p.dob})`);
    if (email && p.email?.toLowerCase() === email) reasons.push("same email");
    return { personId: p.id, reason: reasons.join(", ") };
  });

  if (rows.length === 1) {
    const p = rows[0];
    const nameEq = !!first && !!last && p.firstName.toLowerCase() === first && p.lastName.toLowerCase() === last;
    const dobEq = !!i.dob && p.dob === i.dob;
    const emailEq = !!email && p.email?.toLowerCase() === email && !!i.adult;
    if (nameEq && (dobEq || emailEq)) {
      // A person already tied to a *different* record of the same source is not the same person.
      if (i.sourceId) {
        const other = await tx
          .select({ sourceId: externalIds.sourceId })
          .from(externalIds)
          .where(
            and(
              eq(externalIds.orgId, orgId),
              eq(externalIds.source, idSource),
              eq(externalIds.sourceEntityType, i.sourceEntityType),
              eq(externalIds.localEntityType, "person"),
              eq(externalIds.localId, p.id),
            ),
          );
        if (other.length) {
          candidates[0].reason += `; already linked to ${idSource} id ${other.map((o) => o.sourceId).join(", ")}`;
          return { confidence: "ambiguous", personId: null, candidates };
        }
      }
      return { confidence: "strong", personId: p.id, candidates };
    }
  }
  return { confidence: "ambiguous", personId: null, candidates };
}

/** Candidate display info (name, DOB, athlete?) for the review UI. */
export async function describePeople(tx: Tx, orgId: string, ids: string[]) {
  if (!ids.length) return new Map<string, { name: string; dob: string | null; email: string | null; athleteId: string | null; status: string }>();
  const rows = await tx
    .select({ id: people.id, first: people.firstName, last: people.lastName, dob: people.dateOfBirth, email: people.email, status: people.status, athleteId: athletes.id })
    .from(people)
    .leftJoin(athletes, eq(athletes.personId, people.id))
    .where(and(eq(people.orgId, orgId), inArray(people.id, ids)));
  return new Map(rows.map((r) => [r.id, { name: `${r.first} ${r.last}`, dob: r.dob, email: r.email, athleteId: r.athleteId, status: r.status }]));
}
