import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { isAdmin } from "@/lib/authz/policy";
import { Callout, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { disableMfaAction } from "../actions";
import { MfaEnroll } from "./enroll";

export const metadata = { title: "My security" };

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  const v = await requireViewer();
  const sp = await searchParams;
  const [u] = await db.select().from(users).where(eq(users.id, v.userId));
  return (
    <>
      <PageHeader kicker="Settings" title="My security" />
      {isAdmin(v) ? <SettingsTabs current="security" /> : null}
      {sp.required ? (
        <Callout tone="warn" title="Two-step verification required" className="mb-5">
          Your organization requires staff to use two-step verification. Set it up below to continue.
        </Callout>
      ) : null}
      <Card className="max-w-xl">
        <CardHeader title="Two-step verification (authenticator app)" />
        <CardBody>
          {u.mfaEnabled ? (
            <div className="space-y-3 text-sm">
              <p className="text-ok">On. You&apos;ll be asked for a 6-digit code each time you sign in.</p>
              <form action={disableMfaAction}>
                <input type="hidden" name="userId" value={v.userId} />
                <button type="submit" className="min-h-10 rounded-lg border border-edge px-3 text-sm">
                  Turn off
                </button>
              </form>
            </div>
          ) : (
            <MfaEnroll />
          )}
        </CardBody>
      </Card>
    </>
  );
}
