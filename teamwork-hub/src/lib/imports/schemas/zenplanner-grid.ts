import { matchVocab, PROSPECT_STATUS_TO_STAGE, type VocabKey } from "@/lib/zenplanner/vocab";
import { asText, parseNumber, syntheticId, zonedLocalToInstant } from "../normalize";
import type { Evidence, FieldDef, FieldValue, ImportSchemaDef, NormalizeCtx, NormalizedRow } from "../types";
import { emptyRow, identityFrom, resolveName } from "./common";

/**
 * Exact presets for Zen Planner's report grids (Person, Membership, Bill, Attendance).
 * Field labels are the grid column names from docs/ZENPLANNER-MAP.md (2026-11-13). The CSV header
 * spellings may differ slightly from the grid labels, so every field carries a few aliases and
 * headers are compared without case or punctuation; anything unmatched is listed, never fatal.
 *
 * Not yet tested against a real export file.
 */
export const GRID_EVIDENCE: Evidence = "built from the 2026-11-13 account map; not yet tested against a real export file";

const GRID_LIMITS =
  "Preset built from the 2026-11-13 Zen Planner account map; not yet tested against a real export file. Check the first import's mapping and preview carefully. Billing stays in Zen Planner: nothing here creates invoices, charges, subscriptions, messages, or jobs, and nothing is ever written back to Zen Planner.";

const EXPORT_BASE = "studio.zenplanner.com/zenplanner/studio/";

const PERSON_ID: FieldDef = { key: "source_person_id", label: "Person ID", type: "text", aliases: ["person id", "personid", "member id", "zp id", "id"], hint: "Optional. Without it, people are matched by exact name plus birth date or email and always confirmed by staff." };
const NAME_FIELDS: FieldDef[] = [
  { key: "first_name", label: "First Name", type: "text", aliases: ["first name", "firstname", "first"] },
  { key: "last_name", label: "Last Name", type: "text", aliases: ["last name", "lastname", "last"] },
  { key: "full_name", label: "Name", type: "text", aliases: ["name", "full name", "person", "member", "member name"] },
];

const yes = (v: FieldValue, label: string, warnings: string[]): boolean | null => {
  const s = asText(v);
  if (s === null) return null;
  const t = s.trim().toLowerCase();
  if (["yes", "y", "true", "1", "x"].includes(t)) return true;
  if (["no", "n", "false", "0"].includes(t)) return false;
  warnings.push(`${label}: "${s}" is not Yes/No; left empty.`);
  return null;
};

/** "$178.99", "1,234.50", "(12.00)" → integer cents. Null (never 0) when empty; warns when unreadable. */
const money = (v: FieldValue, label: string, warnings: string[]): number | null => {
  const s = asText(v);
  if (s === null) return null;
  const neg = /^\(.*\)$/.test(s.trim()) || /^-/.test(s.trim());
  const n = parseNumber(s.trim().replace(/^[-(]\s*/, "").replace(/\)$/, "").replace(/^\$\s*/, ""));
  if (!n) {
    warnings.push(`${label}: "${s}" is not an amount; left empty.`);
    return null;
  }
  return Math.round(n.value * 100) * (neg ? -1 : 1);
};

const int = (v: FieldValue, label: string, warnings: string[]): number | null => {
  const s = asText(v);
  if (s === null) return null;
  const n = parseNumber(s);
  if (!n || !Number.isInteger(n.value)) {
    warnings.push(`${label}: "${s}" is not a whole number; left empty.`);
    return null;
  }
  return n.value;
};

/** Canonical list value, or the value as-is plus a flag when it is not on the list. */
function vocab(key: VocabKey, label: string, v: FieldValue, ctx: NormalizeCtx, flags: string[], warnings: string[]): string | null {
  const m = matchVocab(key, asText(v), ctx.vocab?.[key] ?? []);
  if (!m) return null;
  if (!m.known) {
    flags.push(`${label}: ${m.value}`);
    warnings.push(`${label} "${m.value}" is not on the hub's list; imported as written and flagged.`);
  }
  return m.value;
}

// ---------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------

/** Tag names that are sports: the tag is kept AND the athlete's sport is set from it. */
export const KNOWN_SPORTS = [
  "Baseball", "Basketball", "Football", "Soccer", "Volleyball", "Softball", "Track", "Track and Field", "Cross Country", "Wrestling",
  "Swimming", "Tennis", "Golf", "Lacrosse", "Hockey", "Cheerleading", "Gymnastics", "Dance",
];

export function sportFromTags(tags: string[]): string | null {
  for (const t of tags) {
    const hit = KNOWN_SPORTS.find((s) => s.toLowerCase() === t.trim().toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Zen Planner Person "Status" → hub person status. The exact Zen Planner values are unverified; unknown ones are flagged. */
const ZP_PERSON_STATUS: Record<string, "active" | "inactive" | "prospect"> = {
  member: "active",
  active: "active",
  student: "active",
  prospect: "prospect",
  lead: "prospect",
  alumni: "inactive",
  alumnus: "inactive",
  inactive: "inactive",
  former: "inactive",
  "former member": "inactive",
  "non-member": "inactive",
  "non member": "inactive",
  cancelled: "inactive",
  canceled: "inactive",
};

export const zpPersonGrid: ImportSchemaDef = {
  id: "zenplanner.person_grid",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner: Person grid (exact preset)",
  description:
    "The People report grid exported as CSV. Creates or links people, households from Family ID, guardians from the Parent columns, leads for prospects, tags, and health notes. No column mapping needed when the listed columns are included.",
  evidence: GRID_EVIDENCE,
  recordEntityType: "member",
  allowCreatePerson: true,
  limitations:
    GRID_LIMITS +
    " Existing people are never overwritten (only empty birth date, email and phone are filled). New guardian links get no health access and are not emergency contacts; a parent who matches someone already in Teamwork waits for staff confirmation. Special Needs, Medications and Allergies are health data: stored separately and readable only with health access. Address, Gender Identity, Bar Code and the attendance rollup columns are not imported.",
  exportHelp: {
    grid: "People (Person report grid)",
    path: `${EXPORT_BASE}person/index.cfm`,
    steps: [
      "In Zen Planner Studio open People, then the report grid (person/index.cfm).",
      "Choose columns and add every column in the list below. Clear any location or status filter so prospects and alumni are included (or note the filter you kept).",
      "Export as CSV. The grid's own export link works; the address has the form person/index.cfm?export=CSV&_c=<the chosen column names> (the column list goes in _c).",
      "Upload the file here and choose this preset. Nothing is sent back to Zen Planner.",
    ],
    columns: [
      "First Name", "Last Name", "Birth Date", "Email", "Phone", "Status", "Family ID", "Family", "Parent First", "Parent Last", "Parent Email",
      "Special Needs", "Medications", "Allergies", "Prospect Status", "Source", "Interest", "Referred By", "Prospect Priority", "Sales Rep", "Inquiry Date",
      "Trial End Date", "Tracking Source", "Tracking Name", "Tracking Medium", "Tracking Keywords", "Primary Instructor", "Primary Location", "Signup Date",
      "Has Password?", "Signed Documents", "Groups",
    ],
  },
  fields: [
    PERSON_ID,
    ...NAME_FIELDS,
    { key: "dob", label: "Birth Date", type: "date", aliases: ["birth date", "birthdate", "date of birth", "dob", "birthday"] },
    { key: "email", label: "Email", type: "email", aliases: ["email", "email address", "e mail"] },
    { key: "phone", label: "Phone", type: "text", aliases: ["phone", "phone number", "mobile", "cell", "cell phone", "mobile phone", "home phone"] },
    { key: "status", label: "Status", type: "text", aliases: ["status", "person status", "member status"] },
    { key: "family_id", label: "Family ID", type: "text", aliases: ["family id", "familyid", "family #"], hint: "The household key. People sharing a Family ID join one household." },
    { key: "family_name", label: "Family", type: "text", aliases: ["family", "family name"] },
    { key: "parent_first", label: "Parent First", type: "text", aliases: ["parent first", "parent first name", "parent firstname"] },
    { key: "parent_last", label: "Parent Last", type: "text", aliases: ["parent last", "parent last name", "parent lastname"] },
    { key: "parent_email", label: "Parent Email", type: "email", aliases: ["parent email", "parent e mail", "parent email address"] },
    { key: "special_needs", label: "Special Needs", type: "text", aliases: ["special needs", "specialneeds"], hint: "Health data." },
    { key: "medications", label: "Medications", type: "text", aliases: ["medications", "medication"], hint: "Health data." },
    { key: "allergies", label: "Allergies", type: "text", aliases: ["allergies", "allergy"], hint: "Health data." },
    { key: "prospect_status", label: "Prospect Status", type: "text", aliases: ["prospect status"] },
    { key: "prospect_sub_status", label: "Prospect Sub Status", type: "text", aliases: ["prospect sub status", "prospect substatus", "prospect status sub"] },
    { key: "source", label: "Source", type: "text", aliases: ["source", "prospect source", "lead source"] },
    { key: "source_sub", label: "Sub Source", type: "text", aliases: ["sub source", "source sub", "subsource"] },
    { key: "interest", label: "Interest", type: "text", aliases: ["interest", "prospect interest"] },
    { key: "interest_sub", label: "Sub Interest", type: "text", aliases: ["sub interest", "interest sub", "subinterest"] },
    { key: "referred_by", label: "Referred By", type: "text", aliases: ["referred by", "referredby", "referral"] },
    { key: "priority", label: "Prospect Priority", type: "text", aliases: ["prospect priority", "priority"] },
    { key: "sales_rep", label: "Sales Rep", type: "text", aliases: ["sales rep", "salesrep", "sales representative"] },
    { key: "inquiry_date", label: "Inquiry Date", type: "date", aliases: ["inquiry date", "inquirydate", "inquired"] },
    { key: "trial_end_date", label: "Trial End Date", type: "date", aliases: ["trial end date", "trial end", "trialenddate"] },
    { key: "tracking_source", label: "Tracking Source", type: "text", aliases: ["tracking source", "utm source", "utm_source"] },
    { key: "tracking_name", label: "Tracking Name", type: "text", aliases: ["tracking name", "utm campaign", "utm_campaign", "tracking campaign"] },
    { key: "tracking_medium", label: "Tracking Medium", type: "text", aliases: ["tracking medium", "utm medium", "utm_medium"] },
    { key: "tracking_keywords", label: "Tracking Keywords", type: "text", aliases: ["tracking keywords", "utm term", "utm_term", "tracking keyword"] },
    { key: "primary_instructor", label: "Primary Instructor", type: "text", aliases: ["primary instructor", "instructor", "primary coach"] },
    { key: "primary_location", label: "Primary Location", type: "text", aliases: ["primary location", "location", "home location"] },
    { key: "signup_date", label: "Signup Date", type: "date", aliases: ["signup date", "sign up date", "signupdate", "join date", "member since"] },
    { key: "has_password", label: "Has Password?", type: "text", aliases: ["has password", "haspassword", "password"], hint: "Informational only." },
    { key: "signed_documents", label: "Signed Documents", type: "text", aliases: ["signed documents", "signed docs", "documents"], hint: "Informational only." },
    { key: "tags", label: "Groups (tags)", type: "text", aliases: ["groups", "group", "tags", "tag", "group names"], hint: "Comma or semicolon separated. A tag named after a known sport also sets the athlete's sport." },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    const flags: string[] = [];
    const { first, last } = resolveName(f);
    const statusText = asText(f.status);
    const prospectStatusRaw = asText(f.prospect_status);
    let status: "active" | "inactive" | "prospect" | null = null;
    if (statusText) {
      status = ZP_PERSON_STATUS[statusText.trim().toLowerCase()] ?? null;
      if (!status) {
        flags.push(`Status: ${statusText}`);
        r.warnings.push(`Status "${statusText}" is not recognized; the person is imported as inactive and flagged. Set the right status in People.`);
        status = "inactive";
      }
    } else if (prospectStatusRaw) status = "prospect";
    const isProspect = status === "prospect";
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: !isProspect }, r.errors);

    const prospectStatus = vocab("prospectStatus", "Prospect Status", f.prospect_status, ctx, flags, r.warnings);
    const mapped = prospectStatus ? PROSPECT_STATUS_TO_STAGE[prospectStatus.toLowerCase()] : undefined;
    const source = vocab("source", "Source", f.source, ctx, flags, r.warnings);
    const interest = vocab("interest", "Interest", f.interest, ctx, flags, r.warnings);
    const priority = vocab("priority", "Priority", f.priority, ctx, flags, r.warnings);

    const pFirst = asText(f.parent_first);
    const pLast = asText(f.parent_last);
    const pEmail = asText(f.parent_email);
    let parent: { firstName: string; lastName: string; email: string | null } | null = null;
    if (pFirst && pLast) {
      const self = pFirst.toLowerCase() === (first ?? "").toLowerCase() && pLast.toLowerCase() === (last ?? "").toLowerCase();
      if (!self) parent = { firstName: pFirst, lastName: pLast, email: pEmail };
    } else if (pFirst || pLast || pEmail) {
      r.warnings.push("Parent columns are incomplete (need Parent First and Parent Last); no guardian will be linked from this row.");
    }

    const health = {
      specialNeeds: asText(f.special_needs),
      medications: asText(f.medications),
      allergies: asText(f.allergies),
    };
    const hasHealth = !!(health.specialNeeds || health.medications || health.allergies);
    const tags = (asText(f.tags) ?? "")
      .split(/[,;|]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const utm = {
      source: asText(f.tracking_source),
      campaign: asText(f.tracking_name),
      medium: asText(f.tracking_medium),
      term: asText(f.tracking_keywords),
    };
    const hasUtm = Object.values(utm).some(Boolean);
    const familyId = asText(f.family_id);
    r.data = {
      firstName: first,
      lastName: last,
      dob: asText(f.dob),
      email: asText(f.email),
      phone: asText(f.phone),
      status,
      zpStatus: statusText,
      isProspect,
      familyId,
      familyName: asText(f.family_name),
      parent,
      health: hasHealth ? health : null,
      prospect: isProspect
        ? {
            status: prospectStatus,
            subStatus: asText(f.prospect_sub_status),
            stage: mapped?.stage ?? "new",
            source,
            sourceSub: asText(f.source_sub),
            interest,
            interestSub: asText(f.interest_sub),
            referredBy: asText(f.referred_by),
            priority,
            salesRep: asText(f.sales_rep),
            inquiryDate: asText(f.inquiry_date),
            trialEndDate: asText(f.trial_end_date),
          }
        : null,
      // Members keep their original source for attribution reports even though no lead is created.
      memberSource: !isProspect ? source : null,
      utm: hasUtm ? utm : null,
      primaryInstructor: asText(f.primary_instructor),
      primaryLocation: asText(f.primary_location),
      signupDate: asText(f.signup_date),
      hasPassword: yes(f.has_password, "Has Password?", r.warnings),
      signedDocuments: asText(f.signed_documents),
      tags,
      sport: sportFromTags(tags),
      flags,
    };
    if (prospectStatus && !mapped) r.warnings.push(`Prospect Status "${prospectStatus}" has no stage mapping; the lead starts in the first stage.`);
    r.sourceRecordId = asText(f.source_person_id) ?? syntheticId(ctx.orgId, "zp-person", first?.toLowerCase(), last?.toLowerCase(), asText(f.dob), asText(f.email), familyId);
    for (const d of [asText(f.signup_date), asText(f.inquiry_date)]) if (d) r.dates.push(d);
    return r;
  },
};

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

const ZP_MEMBERSHIP_STATUS: Record<string, string> = {
  active: "active",
  current: "active",
  "on hold": "on_hold",
  hold: "on_hold",
  held: "on_hold",
  frozen: "on_hold",
  cancelled: "cancelled",
  canceled: "cancelled",
  dropped: "cancelled",
  expired: "expired",
  ended: "expired",
  completed: "expired",
  "past due": "past_due",
  pending: "pending",
  future: "pending",
  trial: "trialing",
};

export const zpMembershipGrid: ImportSchemaDef = {
  id: "zenplanner.membership_grid",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner: Membership grid (exact preset)",
  description:
    "The Membership report grid exported as CSV. Creates memberships that stay billed in Zen Planner (external_zenplanner), with the weekly limit, punch-card balance, cancel and hold details, and feeds the discount review. Import the Person grid first.",
  evidence: GRID_EVIDENCE,
  recordEntityType: "membership",
  allowCreatePerson: false,
  limitations:
    GRID_LIMITS +
    " Each distinct plan (and weekly limit) becomes an inactive, unlisted product so it is never sold here; its price is the highest Payment Amount seen for that plan in the file, and each member's own Payment Amount is kept beside the membership. A weekly Att. Limit becomes the weekly class limit; other limit types are recorded but not enforced. Class Card Att. Remaining becomes an imported punch-card balance with no expiry date (Zen Planner's expiry is not in the grid). Installment, Signup Fee and Acct Name columns are not imported.",
  exportHelp: {
    grid: "Memberships (Membership report grid)",
    path: `${EXPORT_BASE}membership/index.cfm`,
    steps: [
      "In Zen Planner Studio open the Membership report grid (membership/index.cfm).",
      "Choose columns and add every column in the list below. Include cancelled and on-hold memberships if you want their history (or filter to current ones and say so in the coverage note).",
      "Export as CSV (membership/index.cfm?export=CSV&_c=<the chosen column names>).",
      "Import the Person grid first, then upload this file and choose this preset.",
    ],
    columns: [
      "First Name", "Last Name", "Membership", "Status", "Mbr. Begin Date", "Mbr. End Date", "Months", "Auto Renew", "Renewal Type", "Trial Member?",
      "Cancel Date", "Cancel By", "Cancel Reason", "Cancel Comments", "Payment Amount", "First Bill Due", "Income Category", "Att. Limit",
      "Att. Limit Type", "Class Card Att. Remaining", "Shared?", "Autopay?", "Family ID", "Birth Date", "Email",
    ],
  },
  fields: [
    { key: "membership_id", label: "Membership ID", type: "text", aliases: ["membership id", "membershipid", "mbr id"] },
    PERSON_ID,
    ...NAME_FIELDS,
    { key: "dob", label: "Birth Date", type: "date", aliases: ["birth date", "birthdate", "dob"] },
    { key: "email", label: "Email", type: "email", aliases: ["email", "email address"] },
    { key: "plan", label: "Membership", type: "text", required: true, aliases: ["membership", "membership name", "mbr name", "membership option", "membership template", "plan", "plan name"] },
    { key: "status", label: "Status", type: "text", aliases: ["status", "mbr status", "membership status"], hint: "When the column is missing the status is worked out from the cancel, end and hold dates." },
    { key: "start_date", label: "Mbr. Begin Date", type: "date", required: true, aliases: ["mbr begin date", "membership begin date", "begin date", "mbr begin", "start date"] },
    { key: "end_date", label: "Mbr. End Date", type: "date", aliases: ["mbr end date", "membership end date", "end date", "mbr end", "expiration date"] },
    { key: "months", label: "Months", type: "text", aliases: ["months", "term months", "term"] },
    { key: "auto_renew", label: "Auto Renew", type: "text", aliases: ["auto renew", "autorenew", "auto renews"] },
    { key: "renewal_type", label: "Renewal Type", type: "text", aliases: ["renewal type", "renewaltype"] },
    { key: "trial_member", label: "Trial Member?", type: "text", aliases: ["trial member", "trialmember", "trial"] },
    { key: "cancel_date", label: "Cancel Date", type: "date", aliases: ["cancel date", "canceled date", "cancelled date", "drop date"] },
    { key: "cancel_by", label: "Cancel By", type: "text", aliases: ["cancel by", "canceled by", "cancelled by"] },
    { key: "cancel_reason", label: "Cancel Reason", type: "text", aliases: ["cancel reason", "drop reason", "cancellation reason"] },
    { key: "cancel_comments", label: "Cancel Comments", type: "text", aliases: ["cancel comments", "cancel comment", "cancellation comments"] },
    { key: "payment_amount", label: "Payment Amount", type: "text", aliases: ["payment amount", "paymentamount", "payment amt", "amount"] },
    { key: "first_bill_due", label: "First Bill Due", type: "date", aliases: ["first bill due", "first bill due date", "first bill"] },
    { key: "income_category", label: "Income Category", type: "text", aliases: ["income category", "incomecategory"] },
    { key: "membership_category", label: "Membership Category", type: "text", aliases: ["membership category", "category", "mbr category"] },
    { key: "att_limit", label: "Att. Limit", type: "text", aliases: ["att limit", "attendance limit", "attlimit"] },
    { key: "att_limit_type", label: "Att. Limit Type", type: "text", aliases: ["att limit type", "attendance limit type", "attlimittype"] },
    { key: "class_card_remaining", label: "Class Card Att. Remaining", type: "text", aliases: ["class card att remaining", "class card remaining", "class card attendance remaining", "att remaining"] },
    { key: "shared", label: "Shared?", type: "text", aliases: ["shared", "is shared"] },
    { key: "autopay", label: "Autopay?", type: "text", aliases: ["autopay", "auto pay", "is autopay"] },
    { key: "discount", label: "Discount", type: "text", aliases: ["discount", "discount name", "discount code"], hint: "Not in the account map's column list; mapped when the export has it." },
    { key: "hold_reason", label: "Hold Reason", type: "text", aliases: ["hold reason", "freeze reason"] },
    { key: "hold_start", label: "Hold Start Date", type: "date", aliases: ["hold start date", "hold start", "hold begin date", "hold from"] },
    { key: "hold_end", label: "Hold End Date", type: "date", aliases: ["hold end date", "hold end", "hold until", "hold to"] },
    { key: "family_id", label: "Family ID", type: "text", aliases: ["family id", "familyid"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    const flags: string[] = [];
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: true }, r.errors);
    const today = ctx.today ?? new Date().toISOString().slice(0, 10);
    const cancelDate = asText(f.cancel_date);
    const endDate = asText(f.end_date);
    const holdStart = asText(f.hold_start);
    const holdEnd = asText(f.hold_end);
    const st = asText(f.status);
    let status = st ? ZP_MEMBERSHIP_STATUS[st.trim().toLowerCase()] : undefined;
    if (st && !status) r.errors.push(`Membership status "${st}" not recognized (expected Active, On Hold, Cancelled, Expired, Past Due, Pending, Trial).`);
    if (!st) {
      if (cancelDate && cancelDate <= today) status = "cancelled";
      else if (endDate && endDate < today) status = "expired";
      else if (holdStart && holdStart <= today && (!holdEnd || holdEnd >= today)) status = "on_hold";
      else if (asText(f.start_date) && asText(f.start_date)! > today) status = "pending";
      else status = "active";
      r.warnings.push(`No Status column; status worked out from the dates as "${status}".`);
    }
    const attLimit = int(f.att_limit, "Att. Limit", r.warnings);
    const attLimitType = asText(f.att_limit_type);
    let classesPerWeek: number | null = null;
    if (attLimit != null && attLimit > 0) {
      if (!attLimitType || /week/i.test(attLimitType)) {
        if (attLimit <= 14) classesPerWeek = attLimit;
        else r.warnings.push(`Att. Limit ${attLimit} per week is above the hub's maximum (14); recorded but not enforced.`);
        if (!attLimitType) r.warnings.push("Att. Limit has no Att. Limit Type; read as a weekly limit.");
      } else {
        r.warnings.push(`Att. Limit Type "${attLimitType}" is not weekly; the limit is recorded but not enforced as a weekly class limit.`);
      }
    }
    const classCard = int(f.class_card_remaining, "Class Card Att. Remaining", r.warnings);
    const payment = money(f.payment_amount, "Payment Amount", r.warnings);
    if (payment === null) r.warnings.push("No Payment Amount; left empty (not 0) and listed as unknown in the discount review.");
    const plan = asText(f.plan);
    r.data = {
      plan,
      status: status ?? null,
      startDate: asText(f.start_date),
      endDate,
      months: int(f.months, "Months", r.warnings),
      autoRenew: yes(f.auto_renew, "Auto Renew", r.warnings),
      renewalType: asText(f.renewal_type),
      trialMember: yes(f.trial_member, "Trial Member?", r.warnings),
      cancelDate,
      cancelBy: asText(f.cancel_by),
      cancelReason: vocab("dropReason", "Cancel Reason", f.cancel_reason, ctx, flags, r.warnings),
      cancelComments: asText(f.cancel_comments),
      paymentAmountMinor: payment,
      firstBillDue: asText(f.first_bill_due),
      incomeCategory: vocab("incomeCategory", "Income Category", f.income_category, ctx, flags, r.warnings),
      membershipCategory: vocab("membershipCategory", "Membership Category", f.membership_category, ctx, flags, r.warnings),
      attLimit,
      attLimitType,
      classesPerWeek,
      classCardRemaining: classCard,
      shared: yes(f.shared, "Shared?", r.warnings),
      autopay: yes(f.autopay, "Autopay?", r.warnings),
      discountName: asText(f.discount),
      holdReason: vocab("holdReason", "Hold Reason", f.hold_reason, ctx, flags, r.warnings),
      holdStart,
      holdEnd,
      familyId: asText(f.family_id),
      inSeason: !!plan && /in[\s-]?season/i.test(plan),
      flags,
    };
    if (classCard != null && classCard < 0) {
      r.warnings.push("Class Card Att. Remaining is negative; no punch-card balance is created.");
    }
    const personKey = asText(f.source_person_id) ?? `${resolveName(f).first}|${resolveName(f).last}|${asText(f.dob) ?? ""}`.toLowerCase();
    r.sourceRecordId = asText(f.membership_id) ?? syntheticId(ctx.orgId, "zp-membership", personKey, plan, asText(f.start_date));
    for (const d of [asText(f.start_date), endDate]) if (d) r.dates.push(d);
    return r;
  },
};

// ---------------------------------------------------------------------------
// Bill
// ---------------------------------------------------------------------------

export const zpBillGrid: ImportSchemaDef = {
  id: "zenplanner.bill_grid",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner: Bill grid (history only)",
  description:
    "The Bill report grid exported as CSV. Stored as imported billing history for the membership audit and scoreboard context. Never creates an invoice, a balance or anything payable.",
  evidence: GRID_EVIDENCE,
  recordEntityType: "bill",
  allowCreatePerson: false,
  limitations:
    GRID_LIMITS +
    " Bills are history: they are kept in their own table, never become Teamwork invoices, and no family is ever asked to pay them here. Autopay Account and approval columns are not imported (payment account details stay in Zen Planner).",
  exportHelp: {
    grid: "Bills (Bill report grid)",
    path: `${EXPORT_BASE}bill/index.cfm`,
    steps: [
      "In Zen Planner Studio open the Bill report grid (bill/index.cfm).",
      "Choose columns and add every column in the list below. Set the due-date range you want as history.",
      "Export as CSV (bill/index.cfm?export=CSV&_c=<the chosen column names>). Do not add the Autopay Account columns.",
      "Import the Person grid first, then upload this file and choose this preset.",
    ],
    columns: ["First Name", "Last Name", "Description", "Due Date", "Amount Due", "Amount Paid", "Amount Unpaid", "Discount Total", "Paid On Time", "Status"],
  },
  fields: [
    { key: "bill_id", label: "Bill ID", type: "text", aliases: ["bill id", "billid", "invoice id", "bill #", "bill number"] },
    PERSON_ID,
    ...NAME_FIELDS,
    { key: "dob", label: "Birth Date", type: "date", aliases: ["birth date", "birthdate", "dob"] },
    { key: "email", label: "Email", type: "email", aliases: ["email", "email address"] },
    { key: "description", label: "Description", type: "text", aliases: ["description", "bill description", "bill for", "item", "membership", "memo"] },
    { key: "due_date", label: "Due Date", type: "date", required: true, aliases: ["due date", "duedate", "bill date", "due"] },
    { key: "amount_due", label: "Amount Due", type: "text", aliases: ["amount due", "amountdue", "bill amount", "billamount", "amount"] },
    { key: "amount_paid", label: "Amount Paid", type: "text", aliases: ["amount paid", "amountpaid", "paid"] },
    { key: "amount_unpaid", label: "Amount Unpaid", type: "text", aliases: ["amount unpaid", "amountunpaid", "unpaid", "balance"] },
    { key: "discount_total", label: "Discount Total", type: "text", aliases: ["discount total", "discounttotal", "discount"] },
    { key: "paid_on_time", label: "Paid On Time", type: "text", aliases: ["paid on time", "paidontime", "on time"] },
    { key: "status", label: "Status", type: "text", aliases: ["status", "bill status"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: false }, r.errors);
    const due = asText(f.due_date);
    r.data = {
      description: asText(f.description),
      dueDate: due,
      amountDueMinor: money(f.amount_due, "Amount Due", r.warnings),
      amountPaidMinor: money(f.amount_paid, "Amount Paid", r.warnings),
      amountUnpaidMinor: money(f.amount_unpaid, "Amount Unpaid", r.warnings),
      discountTotalMinor: money(f.discount_total, "Discount Total", r.warnings),
      paidOnTime: yes(f.paid_on_time, "Paid On Time", r.warnings),
      zpStatus: asText(f.status),
    };
    const personKey = asText(f.source_person_id) ?? `${resolveName(f).first}|${resolveName(f).last}|${asText(f.dob) ?? ""}`.toLowerCase();
    r.sourceRecordId = asText(f.bill_id) ?? syntheticId(ctx.orgId, "zp-bill", personKey, due, asText(f.description), asText(f.amount_due));
    if (due) r.dates.push(due);
    return r;
  },
};

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export const zpAttendanceGrid: ImportSchemaDef = {
  id: "zenplanner.attendance_grid",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner: Attendance grid (exact preset)",
  description:
    "The Attendance report grid exported as CSV. A row is a visit only when Att. = Yes; Rsvp and Canceled are separate columns and rows without Att. = Yes are skipped. Creates historical sessions and attended bookings.",
  evidence: GRID_EVIDENCE,
  recordEntityType: "attendance",
  allowCreatePerson: false,
  limitations:
    GRID_LIMITS +
    " Imported sessions are private historical records under an inactive 'Imported (Zen Planner)' service: they consume no credits, notify nobody, and are not bookable. Location is linked when its name matches a hub location exactly; Session Type, Program and Staff Member are kept as text on the session. Rows without a time are placed at the start of the day.",
  exportHelp: {
    grid: "Attendance (Attendance report grid)",
    path: `${EXPORT_BASE}attendance/index.cfm`,
    steps: [
      "In Zen Planner Studio open the Attendance report grid (attendance/index.cfm).",
      "Choose columns and add every column in the list below. Att. must be included: it is the only column that says a visit happened.",
      "Set the date range, then export as CSV (attendance/index.cfm?export=CSV&_c=<the chosen column names>).",
      "Import the Person grid first, then upload this file and choose this preset.",
    ],
    columns: ["First Name", "Last Name", "Date", "Time", "Att.", "Rsvp", "Canceled", "Session Type", "Program", "Location", "Staff Member"],
  },
  fields: [
    PERSON_ID,
    ...NAME_FIELDS,
    { key: "dob", label: "Birth Date", type: "date", aliases: ["birth date", "birthdate", "dob"] },
    { key: "email", label: "Email", type: "email", aliases: ["email", "email address"] },
    { key: "date", label: "Date", type: "date", required: true, aliases: ["date", "attendance date", "att date", "class date", "session date"] },
    { key: "time", label: "Time", type: "time", aliases: ["time", "start time", "class time", "session time"] },
    { key: "att", label: "Att.", type: "text", required: true, aliases: ["att", "attended", "attendance", "att?"], hint: "Only Yes counts as a visit." },
    { key: "rsvp", label: "Rsvp", type: "text", aliases: ["rsvp", "rsvp?", "reserved", "reservation"] },
    { key: "canceled", label: "Canceled", type: "text", aliases: ["canceled", "cancelled", "canceled?", "cancelled?"] },
    { key: "session_type", label: "Session Type", type: "text", aliases: ["session type", "sessiontype", "type"] },
    { key: "program", label: "Program", type: "text", aliases: ["program", "program name"] },
    { key: "location", label: "Location", type: "text", aliases: ["location", "location name"] },
    { key: "staff", label: "Staff Member", type: "text", aliases: ["staff member", "staff", "instructor", "coach"] },
    { key: "class_name", label: "Class", type: "text", aliases: ["class", "class name", "session", "session name", "event"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: true }, r.errors);
    const date = asText(f.date);
    const time = asText(f.time);
    const attText = asText(f.att);
    const attWarn: string[] = [];
    const att = yes(f.att, "Att.", attWarn);
    if (attText !== null && att === null) r.errors.push(`Att. "${attText}" is not Yes/No.`);
    const rsvp = yes(f.rsvp, "Rsvp", r.warnings);
    const canceled = yes(f.canceled, "Canceled", r.warnings);
    // A row is a visit only when Att. = Yes. Rsvp and Canceled never make (or unmake) a visit.
    let status: "attended" | "not_checkin" = "not_checkin";
    let skipReason: string | null = null;
    if (att === true) {
      status = "attended";
      if (canceled) r.warnings.push("Att. = Yes on a row also marked Canceled; counted as a visit because Att. decides.");
    } else if (canceled) skipReason = "Canceled, Att. is not Yes: not a visit";
    else if (rsvp) skipReason = "Rsvp only, Att. is not Yes: not a visit";
    else skipReason = "Att. is not Yes: not a visit";
    let startsAt: string | null = null;
    if (date) {
      const z = zonedLocalToInstant(date, time ?? "00:00:00", ctx.tz);
      if (z.warning) r.warnings.push(z.warning);
      if (!time && status === "attended") r.warnings.push("No time in export; session placed at start of day.");
      startsAt = z.date.toISOString();
      r.dates.push(date);
    }
    const program = asText(f.program);
    const sessionType = asText(f.session_type);
    r.data = {
      date,
      time,
      startsAt,
      sourceTimestamp: [date, time].filter(Boolean).join(" "),
      className: asText(f.class_name) ?? program ?? sessionType ?? "Zen Planner visit",
      status,
      skipReason,
      att,
      rsvp,
      canceled,
      sessionType,
      program,
      locationName: asText(f.location),
      staffName: asText(f.staff),
      durationMinutes: 60,
    };
    const personKey = asText(f.source_person_id) ?? `${resolveName(f).first}|${resolveName(f).last}|${asText(f.dob) ?? ""}`.toLowerCase();
    r.sourceRecordId = syntheticId(ctx.orgId, "zp-attendance", personKey, date, time, asText(f.class_name) ?? program ?? sessionType, asText(f.location));
    return r;
  },
};

export const ZP_GRID_SCHEMAS = [zpPersonGrid, zpMembershipGrid, zpBillGrid, zpAttendanceGrid];

/** Headers the preset did not recognize (after alias + punctuation-insensitive matching). */
export function unmatchedHeaders(headers: string[], mapping: Record<string, string>): string[] {
  const mapped = new Set(Object.entries(mapping).filter(([k]) => !k.startsWith("$option.")).map(([, v]) => v));
  return headers.filter((h) => !mapped.has(h) && !h.startsWith("_"));
}
