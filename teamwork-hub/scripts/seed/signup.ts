import { ensureSampleAgreementTemplate } from "../../src/lib/agreements/issue";
import type { SeedCtx } from "./context";

/**
 * Sign-up module seed: the SAMPLE membership agreement template (clearly labelled sample text),
 * so the guided sign-up flow works in the demo. No memberships, methods or money are created.
 */
export async function seedSignup(ctx: SeedCtx) {
  await ensureSampleAgreementTemplate(ctx.tx, { orgId: ctx.orgId, actorUserId: ctx.users.rod ?? null, actorRole: "owner" }, { isDemo: true });
}
