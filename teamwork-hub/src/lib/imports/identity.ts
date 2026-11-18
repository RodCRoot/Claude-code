import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, externalIds, people } from "@/db/schema";
import type { IdentityInput } from "./types";

export type Candidate = { personId: string; reason: string };

export type MatchResult = {
  confidence: "exact_source_id" | "strong" | "name_only" | "ambiguous" | "none";
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
 *  (b) exactly one person with this exact first+last name, AND the same DOB or the same email, AND no
 *      conflicting DOB → "strong" (still confirmed by staff)
 *      The same holds when several people share the name and exactly one of them has the DOB or the email.
 *  (b2) only when the caller asks (`nameOnlyTier`: files that follow a Person import and cannot create people):
 *      exactly one person with this exact first+last name, no conflicting DOB, but neither DOB nor email to
 *      back it up → "name_only": a suggestion that staff confirm one by one or with a separate bulk action
 *  (c) anything else with candidates (name-only, shared surname+DOB, shared email) → ambiguous
 *  (d) no candidates → none (create new when the schema allows)
 */
export async function matchPerson(tx: Tx, orgId: string, idSource: string, i: IdentityInput, opts: { nameOnlyTier?: boolean } = {}): Promise<MatchResult> {
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

  // Exactly one person in the organization carries this exact first + last name. Other candidates (a parent
  // or sibling sharing the family email, a relative sharing surname + birth date) do not make it ambiguous:
  // in the first real export most children carry a parent's email and half the rows have no birth date.
  const isName = (p: (typeof rows)[number]) => !!first && !!last && p.firstName.toLowerCase() === first && p.lastName.toLowerCase() === last;
  const sameName = rows.filter(isName);
  // Several people share the name (a parent and a junior, two unrelated members): the row still points at one of
  // them when exactly one has its birth date or its email and no conflicting birth date. When the email fits two
  // of them it stays ambiguous.
  const backs = (p: (typeof rows)[number]) => ((!!i.dob && p.dob === i.dob) || (!!email && p.email?.toLowerCase() === email)) && !(!!i.dob && !!p.dob && p.dob !== i.dob);
  const backedSameName = sameName.filter(backs);
  const pick = sameName.length === 1 ? sameName[0] : backedSameName.length === 1 ? backedSameName[0] : null;
  if (pick) {
    const p = pick;
    const at = rows.indexOf(p);
    const dobEq = !!i.dob && p.dob === i.dob;
    const dobConflict = !!i.dob && !!p.dob && p.dob !== i.dob;
    // Email alone is enough for adults, or for anyone when nobody else shares the name (rows.length covers
    // every same-name person, so two people with one name and one email, such as a parent and a junior, stay ambiguous).
    const emailEq = !!email && p.email?.toLowerCase() === email;
    const backed = dobEq || emailEq;
    if (!dobConflict && (backed || opts.nameOnlyTier)) {
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
          candidates[at].reason += `; already linked to ${idSource} id ${other.map((o) => o.sourceId).join(", ")}`;
          return { confidence: "ambiguous", personId: null, candidates };
        }
      }
      return { confidence: backed ? "strong" : "name_only", personId: p.id, candidates: [candidates[at], ...candidates.filter((_, k) => k !== at)] };
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
