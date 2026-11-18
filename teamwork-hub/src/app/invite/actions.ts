"use server";

import { redirect } from "next/navigation";
import { db } from "@/db";
import { redeemToken } from "@/lib/auth/accounts";
import { createSession } from "@/lib/auth/session";
import { safeAction, type ActionState } from "@/lib/actions";

export const redeemAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const kind = fd.get("kind") === "reset" ? "reset" : "invite";
  const pw = String(fd.get("password") ?? "");
  if (pw !== String(fd.get("confirm") ?? "")) return { ok: false, error: "Passwords don't match.", fieldErrors: { confirm: "Doesn't match" } };
  const u = await db.transaction((tx) => redeemToken(tx, kind, String(fd.get("token")), pw));
  await createSession(u.id, { mfaVerified: !u.mfaEnabled });
  redirect(u.mfaEnabled ? "/login/mfa" : "/today");
});
