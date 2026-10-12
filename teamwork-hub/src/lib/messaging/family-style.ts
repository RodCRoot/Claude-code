/**
 * Family message style lint. Pure and dependency-free so the same rules run in the composers
 * (live, client side) and on the server (templates, campaigns, staff replies to families).
 *
 * Teamwork house rules for parent-facing text:
 * - never an em dash (blocked; offer to replace with commas or periods);
 * - no staff jargon / internal system names (warning);
 * - never card numbers, SSNs or card security codes (blocked); bank account/routing numbers (warning);
 * - end with a sign-off (warning).
 */

export type LintSeverity = "block" | "warn";
export type LintCode = "em_dash" | "jargon" | "card_number" | "ssn" | "card_security_code" | "bank_number" | "sign_off";
export type LintIssue = { code: LintCode; severity: LintSeverity; message: string; excerpt?: string };
export type LintResult = { ok: boolean; issues: LintIssue[]; blocks: LintIssue[]; warnings: LintIssue[] };

/** Em dash, horizontal bar, and the typed "--" stand-in. (En dashes in ranges like 3–5 are left alone.) */
const DASH = /\s*(?:—|―|(?<=\s)--(?=\s))\s*/g;
const HAS_DASH = /—|―|\s--\s/;

/** Internal words families shouldn't see, with a plainer alternative. Matched as whole words, case-insensitive. */
export const STAFF_JARGON: { term: string; pattern: RegExp; suggest: string }[] = [
  { term: "comp / comped", pattern: /\bcomp(?:'?ed|'d|s)?\b/i, suggest: "complimentary / on us" },
  { term: "entitlement", pattern: /\bentitlements?\b/i, suggest: "membership or session credits" },
  { term: "credit bucket", pattern: /\bcredit buckets?\b/i, suggest: "session credits" },
  { term: "payer account", pattern: /\bpayer accounts?\b/i, suggest: "billing account" },
  { term: "service type", pattern: /\bservice types?\b/i, suggest: "class or session" },
  { term: "segment", pattern: /\bsegments?\b/i, suggest: "(leave out)" },
  { term: "no-show", pattern: /\bno[- ]shows?\b/i, suggest: "missed session" },
  { term: "late cancel", pattern: /\blate[- ]cancel(?:led|lation|s)?\b/i, suggest: "cancelled less than the notice window ahead" },
  { term: "Zen Planner / ZP", pattern: /\b(?:zen ?planner|ZP)\b/i, suggest: "our system / the app" },
  { term: "GoHighLevel / GHL", pattern: /\b(?:go ?high ?level|GHL)\b/i, suggest: "(leave out)" },
  { term: "TeamBuildr", pattern: /\bteam ?buildr\b/i, suggest: "your training program" },
  { term: "PIF", pattern: /\bPIF\b/, suggest: "paid in full" },
  { term: "EFT", pattern: /\bEFT\b/, suggest: "automatic payment" },
  { term: "MRR / churn", pattern: /\b(?:MRR|churn(?:ed)?)\b/i, suggest: "(internal metric, leave out)" },
  { term: "NS / LC", pattern: /\b(?:NS|LC)\b/, suggest: "missed session / late cancellation" },
  { term: "roster", pattern: /\brosters?\b/i, suggest: "class list" },
];

/** Sign-offs we accept on the last non-empty line(s). */
const SIGN_OFF = /(\bthanks?\b|\bthank you\b|\bbest\b|\bcheers\b|\bsee you\b|\bregards\b|\bsincerely\b|\bcoach\s+\w+|\bteam\b|\bteamwork\b|\{\{\s*org_name\s*\}\}|^\s*[-~]\s*\w+)/i;

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function mask(s: string): string {
  const digits = s.replace(/\D/g, "");
  return digits.length > 4 ? `${"•".repeat(Math.min(digits.length - 4, 12))}${digits.slice(-4)}` : s;
}

export function lintFamilyMessage(text: string, opts: { requireSignOff?: boolean } = {}): LintResult {
  const issues: LintIssue[] = [];
  const t = text ?? "";

  const dashCount = (t.match(/—|―|\s--\s/g) ?? []).length;
  if (dashCount) {
    issues.push({
      code: "em_dash",
      severity: "block",
      message: `Em dash${dashCount === 1 ? "" : "es"} (${dashCount}) are not used in family messages. Replace with a comma or a period.`,
    });
  }

  for (const j of STAFF_JARGON) {
    const m = j.pattern.exec(t);
    if (m) issues.push({ code: "jargon", severity: "warn", message: `Staff jargon "${m[0]}": families may not know it. Try: ${j.suggest}.`, excerpt: m[0] });
  }

  // Card numbers: 13–19 digits, optional single spaces/dashes between groups, Luhn-valid.
  for (const m of t.matchAll(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      issues.push({ code: "card_number", severity: "block", message: `Looks like a full card number (${mask(m[0])}). Never send card numbers; refer to the last 4 digits only.`, excerpt: mask(m[0]) });
      break;
    }
  }
  if (/(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/.test(t) || /\b(?:SSN|social security(?: number)?)\b\D{0,12}\d{3}\D?\d{2}\D?\d{4}/i.test(t)) {
    issues.push({ code: "ssn", severity: "block", message: "Looks like a Social Security number. Remove it." });
  }
  if (/\b(?:CVV2?|CVC2?|CID|security code)\b\D{0,12}\d{3,4}\b/i.test(t)) {
    issues.push({ code: "card_security_code", severity: "block", message: "Contains a card security code. Remove it." });
  }
  if (/\b(?:routing|account|acct)\s*(?:number|no\.?|#)?\s*[:#]?\s*\d{6,17}\b/i.test(t)) {
    issues.push({ code: "bank_number", severity: "warn", message: "Looks like a bank routing/account number. Only share the last 4 digits." });
  }

  if (opts.requireSignOff !== false && t.trim()) {
    const lines = t
      .trim()
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const tail = lines.slice(-2).join("\n");
    const lastSentence = tail.split(/(?<=[.!?])\s+/).slice(-2).join(" ");
    if (!SIGN_OFF.test(lastSentence)) issues.push({ code: "sign_off", severity: "warn", message: "No sign-off. End with something like \"Thanks, Coach Name\" or \"Thanks, {{org_name}}\"." });
  }

  const blocks = issues.filter((i) => i.severity === "block");
  return { ok: blocks.length === 0, issues, blocks, warnings: issues.filter((i) => i.severity === "warn") };
}

export function hasEmDash(text: string): boolean {
  return HAS_DASH.test(text ?? "");
}

/**
 * Replace em dashes. "comma": "A — B" → "A, B". "period": "A — b" → "A. B".
 * A dash next to existing punctuation or at a line end never produces doubled punctuation.
 */
export function replaceEmDashes(text: string, style: "comma" | "period" = "comma"): string {
  const out = (text ?? "").replace(DASH, (m, offset: number, whole: string) => {
    const before = whole.slice(0, offset).trimEnd();
    const after = whole.slice(offset + m.length);
    if (m.includes("\n")) return m.slice(m.indexOf("\n"), m.lastIndexOf("\n") + 1); // keep line breaks, drop the dash
    if (!before) return ""; // dash at the very start: drop it
    if (!after.trim() || /^\s*\n/.test(after)) return /[.!?,;:]$/.test(before) ? "" : "."; // at the end
    if (/[.!?,;:]$/.test(before)) return " ";
    return style === "period" ? ". " : ", ";
  });
  if (style !== "period") return out;
  // Capitalize the first letter after a period we inserted (cheap and safe for prose).
  return out.replace(/([.!?]) ([a-z])/g, (_m, p: string, c: string) => `${p} ${c.toUpperCase()}`);
}

/** One-line summary of blocking issues for a server-side refusal. */
export function lintBlockMessage(r: LintResult, what = "This message"): string {
  return `${what} can't be sent to families yet: ${r.blocks.map((b) => b.message).join(" ")}`;
}

/** SAMPLE app-first card-update instructions (no em dashes; never asks for card details in a message). */
export const CARD_UPDATE_SNIPPET =
  "SAMPLE TEXT: Hi {{recipient_first_name}}, the card on file for {{athlete_first_name}}'s membership needs updating. The quickest way is in the app: open the Teamwork app, tap Billing, then Payment methods, and add the new card. If the app gives you any trouble, reply here and we'll send a secure link. Please never text or email card numbers. Thanks, {{org_name}}";
