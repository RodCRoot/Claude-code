import "server-only";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { DomainError } from "./errors";

/** safeAction + translation of domain errors (CRM/messaging/automation) into UserError. */
export function domainAction<T extends unknown[]>(fn: (...args: T) => Promise<ActionState | void>) {
  return safeAction(async (...args: T) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof DomainError) throw new UserError(e.message, e.fieldErrors);
      throw e;
    }
  });
}

export const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};
export const strs = (fd: FormData, k: string) => fd.getAll(k).filter((x): x is string => typeof x === "string");
export const bool = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return v === "on" || v === "true" || v === "1";
};
