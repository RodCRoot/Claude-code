import "server-only";
import { z } from "zod";
import { AuthzError } from "@/lib/authz/policy";

/** Standard result for every server action used with <ActionForm>. */
export type ActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Optional data for the client (e.g. created id). */
  data?: Record<string, unknown>;
};

export class UserError extends Error {
  constructor(
    message: string,
    public fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "UserError";
  }
}

/**
 * Wraps a server action so validation, permission, and business-rule errors
 * become a visible state rather than an unhandled exception. Unexpected errors
 * are logged (without payloads) and reported generically.
 */
export function safeAction<T extends unknown[]>(fn: (...args: T) => Promise<ActionState | void>) {
  return async (...args: T): Promise<ActionState> => {
    try {
      return (await fn(...args)) ?? { ok: true };
    } catch (e) {
      if (isRedirectError(e)) throw e;
      if (e instanceof AuthzError) return { ok: false, error: e.message };
      if (e instanceof UserError) return { ok: false, error: e.message, fieldErrors: e.fieldErrors };
      if (e instanceof z.ZodError) {
        const fieldErrors: Record<string, string> = {};
        for (const i of e.issues) fieldErrors[i.path.join(".")] ??= i.message;
        return { ok: false, error: "Please fix the highlighted fields.", fieldErrors };
      }
      const pgCode = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
      if (pgCode === "23P01") return { ok: false, error: "That time conflicts with another booking for the same coach or room." };
      if (pgCode === "23505") return { ok: false, error: "That record already exists (duplicate)." };
      console.error(JSON.stringify({ level: "error", msg: "action_failed", name: (e as Error)?.name, message: (e as Error)?.message }));
      return { ok: false, error: "Something went wrong. Nothing was changed. Please try again." };
    }
  };
}

function isRedirectError(e: unknown): boolean {
  const d = (e as { digest?: string })?.digest;
  return typeof d === "string" && (d.startsWith("NEXT_REDIRECT") || d.startsWith("NEXT_NOT_FOUND") || d.startsWith("NEXT_HTTP_ERROR"));
}

/** FormData → plain object of strings (multi-value keys become arrays). */
export function formToObject(fd: FormData): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v !== "string") continue;
    if (k.startsWith("$ACTION")) continue;
    if (k in out) out[k] = ([] as string[]).concat(out[k] as string, v);
    else out[k] = v;
  }
  return out;
}

export const zEmptyToUndef = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === "" ? undefined : v), s);
