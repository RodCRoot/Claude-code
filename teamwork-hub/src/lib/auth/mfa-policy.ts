import type { Role } from "@/db/schema";
import { policiesOf } from "@/lib/settings";
import { STAFF_ROLES } from "./session";

/** Where staff are sent to enrol when the organization requires two-step verification. */
export const MFA_SETUP_PATH = "/settings/security";
export const MFA_REQUIRED_REDIRECT = `${MFA_SETUP_PATH}?required=1`;

/**
 * Staff MFA policy (pure): when the org setting `requireStaffMfa` is on, a staff user whose
 * account has no second factor is sent to enrol, except on the enrolment pages themselves.
 * Guardians, athletes and kiosk logins are never affected by the policy.
 */
export function shouldRequireMfa(viewer: { role: Role; mfaEnabled?: boolean | null }, orgSettings: Record<string, unknown> | null | undefined, pathname: string): boolean {
  if (!policiesOf(orgSettings).requireStaffMfa) return false;
  if (!STAFF_ROLES.includes(viewer.role)) return false;
  if (viewer.mfaEnabled) return false;
  return !pathname.startsWith(MFA_SETUP_PATH);
}
