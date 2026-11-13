"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { UserError as BillingUserError } from "@/lib/billing/errors";
import { choosePayment, choosePlan, completeSignup, startSignupFlow } from "@/lib/signup/flow";
import { todayLocal } from "@/lib/time";

async function run(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  const res = await safeAction(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BillingUserError) throw new UserError(e.message, e.fieldErrors);
      throw e;
    }
  })();
  if (res.ok) revalidatePath("/billing", "layout");
  return res;
}

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function startSignupAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  let id: string | null = null;
  const res = await run(async () => {
    const v = await requireViewer();
    // Staff pick "athlete|payer" from one list; families post both ids from their own account.
    const [athleteId, payerAccountId] = s(fd, "pair") ? s(fd, "pair").split("|") : [s(fd, "athleteId"), s(fd, "payerAccountId")];
    if (!athleteId || !payerAccountId) throw new UserError("Choose who is signing up.", { pair: "Required" });
    const r = await db.transaction((tx) => startSignupFlow(tx, v, { athleteId, payerAccountId }));
    id = r.flow.id;
  });
  if (id) redirect(`/billing/signup/${id}`);
  return res;
}

export async function choosePlanAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => choosePlan(tx, v, { flowId: s(fd, "flowId"), productVersionId: s(fd, "productVersionId"), startDate: s(fd, "startDate"), today: todayLocal() }));
    return { ok: true, message: "Plan saved. Next: review and sign." };
  });
}

export async function choosePaymentAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const choice = s(fd, "choice") === "autopay" ? "autopay" : "manual";
    await db.transaction((tx) => choosePayment(tx, v, { flowId: s(fd, "flowId"), choice, methodId: s(fd, "methodId") || null }));
    return { ok: true, message: choice === "autopay" ? "Automatic payments are set up." : "You will pay each bill yourself." };
  });
}

export async function completeSignupAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    await completeSignup(db, v, { flowId: s(fd, "flowId"), today: todayLocal() });
    return { ok: true, message: "All set." };
  });
}
