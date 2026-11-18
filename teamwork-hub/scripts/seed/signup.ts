import { ensureSampleAgreementTemplate } from "../../src/lib/agreements/issue";
import { eq } from "drizzle-orm";
import { payerBeneficiaries } from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import { startSignupFlow } from "../../src/lib/signup/flow";
import type { SeedCtx } from "./context";

/**
 * Sign-up module seed: the SAMPLE membership agreement template (clearly labelled sample text),
 * so the guided sign-up flow works in the demo. No memberships, methods or money are created.
 */
export async function seedSignup(ctx: SeedCtx) {
  await ensureSampleAgreementTemplate(ctx.tx, { orgId: ctx.orgId, actorUserId: ctx.users.rod ?? null, actorRole: "owner" }, { isDemo: true });
}

/**
 * Demo only (opt-in, see HISTORY_SEEDS): one sign-up the front desk started for Harper and left on the
 * first step, so the staff list of open sign-ups and the flow page have something to show. No plan is
 * chosen, so there is no membership, no document, no bill and nothing to pay.
 */
export async function seedSignupDemoFlow(ctx: SeedCtx) {
  const athleteId = ctx.athletes.harper;
  if (!athleteId || !ctx.users.erin) return;
  const [pb] = await ctx.tx.select({ payerAccountId: payerBeneficiaries.payerAccountId }).from(payerBeneficiaries).where(eq(payerBeneficiaries.athleteId, athleteId));
  if (!pb) return;
  const erin: Viewer = { userId: ctx.users.erin, orgId: ctx.orgId, role: "operations", personId: ctx.people.erin ?? null, displayName: "Erin (Operations)", mfaVerified: true };
  await startSignupFlow(ctx.tx, erin, { athleteId, payerAccountId: pb.payerAccountId });
}
