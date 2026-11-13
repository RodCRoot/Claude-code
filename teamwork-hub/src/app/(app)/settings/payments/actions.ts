"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { agreementSettings, ensureSampleAgreementTemplate, saveAgreementSettings } from "@/lib/agreements/issue";
import { RESIGN_TRIGGERS, type ResignTrigger } from "@/lib/agreements/terms";
import { assertCan } from "@/lib/authz/policy";
import { autopaySettings, saveAutopaySettings, type FeeEstimate } from "@/lib/billing/autopay-settings";
import { UserError as BillingUserError } from "@/lib/billing/errors";
import { parseMoneyToMinor } from "@/lib/money";

async function run(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  const res = await safeAction(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BillingUserError) throw new UserError(e.message, e.fieldErrors);
      throw e;
    }
  })();
  if (res.ok) revalidatePath("/settings/payments");
  return res;
}

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function estimate(fd: FormData, prefix: string): FeeEstimate | null {
  const pct = s(fd, `${prefix}Percent`);
  const fixed = s(fd, `${prefix}Fixed`);
  const cap = s(fd, `${prefix}Cap`);
  if (!pct && !fixed && !cap) return null;
  const p = pct ? Number(pct) : 0;
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new UserError("Enter the estimate percent as a number from 0 to 100, for example 2.9.", { [`${prefix}Percent`]: "0 to 100" });
  const f = fixed ? parseMoneyToMinor(fixed) : 0;
  if (f == null) throw new UserError("Enter the fixed fee estimate as dollars and cents, for example 0.30.", { [`${prefix}Fixed`]: "Invalid amount" });
  const c = cap ? parseMoneyToMinor(cap) : null;
  if (cap && c == null) throw new UserError("Enter the fee cap estimate as dollars and cents, for example 5.00.", { [`${prefix}Cap`]: "Invalid amount" });
  return { percentBps: Math.round(p * 100), fixedMinor: f, capMinor: c };
}

export async function saveAutopaySettingsAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    assertCan(v, "settings.manage");
    const days = s(fd, "cardRetryDays")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (days.some((d) => !Number.isInteger(d))) throw new UserError("Card retry days must be whole numbers separated by commas, for example 3, 7.", { cardRetryDays: "Whole numbers" });
    const kind = s(fd, "bankPayDiscountKind") === "percent" ? "percent" : "fixed";
    const raw = s(fd, "bankPayDiscountValue");
    const value = !raw ? 0 : kind === "percent" ? Number(raw) : parseMoneyToMinor(raw);
    if (value == null || !Number.isInteger(value)) throw new UserError(kind === "percent" ? "Enter the discount as a whole percent." : "Enter the discount as dollars and cents, for example 5.00.", { bankPayDiscountValue: "Invalid" });
    const cur = await autopaySettings(db, v.orgId);
    await db.transaction((tx) =>
      saveAutopaySettings(tx, v, {
        cardRetryDays: days,
        achRetryWaitDays: Number(s(fd, "achRetryWaitDays") || cur.achRetryWaitDays),
        bankPayDiscount: { enabled: fd.get("bankPayDiscountEnabled") === "on", kind, value },
        feeEstimates: { card: estimate(fd, "estCard"), us_bank_account: estimate(fd, "estBank") },
      }),
    );
    return { ok: true, message: "Saved." };
  });
}

export async function saveAgreementSettingsAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const cur = await agreementSettings(db, v.orgId);
    const resignOn = RESIGN_TRIGGERS.map((t) => t.key).filter((k) => fd.get(`resign_${k}`) === "on") as ResignTrigger[];
    await db.transaction((tx) =>
      saveAgreementSettings(tx, v, {
        ...cur,
        blockReservationsUntilSigned: fd.get("blockReservationsUntilSigned") === "on",
        billingWaitsForSignature: fd.get("billingWaitsForSignature") === "on",
        requireForNewMemberships: fd.get("requireForNewMemberships") === "on",
        resignOn,
      }),
    );
    return { ok: true, message: "Saved." };
  });
}

export async function createSampleAgreementAction(_p: ActionState, _fd: FormData) {
  void _fd;
  return run(async () => {
    const v = await requireViewer();
    assertCan(v, "settings.manage");
    const r = await db.transaction((tx) => ensureSampleAgreementTemplate(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }));
    return { ok: true, message: r.created ? "Sample membership agreement template created. Replace its text under Documents, Templates." : "A membership agreement template already exists." };
  });
}
