import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { ROLE_LABEL } from "@/lib/nav";
import { fmt } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, DemoBadge, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { changeRoleAction, disableMfaAction, inviteUserAction, resetLinkAction, toggleUserAction } from "../actions";
import { OneTimeLinkForm } from "./client";

export const metadata = { title: "Users" };

const ROLES = ["owner", "admin", "operations", "coach", "guardian", "athlete", "kiosk"] as const;

export default async function UsersPage() {
  const v = await requireCap("settings.manage");
  const rows = await db.select().from(users).where(eq(users.orgId, v.orgId)).orderBy(asc(users.role), asc(users.displayName));
  const grantable = ROLES.filter((r) => v.role === "owner" || !["owner", "admin"].includes(r));
  return (
    <>
      <PageHeader kicker="Settings" title="Users & roles" description="Logins are separate from people records. Role changes and disabling a login sign that user out everywhere." />
      <SettingsTabs current="users" />
      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title={`${rows.length} logins`} />
          <CardBody>
            <Table caption="Users">
              <thead>
                <tr>
                  <Th>User</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Last sign-in</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id} className="align-top">
                    <Td>
                      <div className="font-medium">
                        {u.displayName} {u.isDemo ? <DemoBadge /> : null}
                      </div>
                      <div className="text-xs text-ink-3">{u.email}</div>
                    </Td>
                    <Td>
                      <ActionForm action={changeRoleAction} className="flex items-center gap-1">
                        <input type="hidden" name="userId" value={u.id} />
                        <label className="sr-only" htmlFor={`role-${u.id}`}>
                          Role for {u.displayName}
                        </label>
                        <Select id={`role-${u.id}`} name="role" defaultValue={u.role} className="h-9 w-36" disabled={u.id === v.userId || (u.role === "owner" && v.role !== "owner")}>
                          {ROLES.map((r) => (
                            <option key={r} value={r} disabled={!grantable.includes(r)}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </Select>
                        {u.id !== v.userId ? (
                          <SubmitButton size="sm" variant="ghost">
                            Set
                          </SubmitButton>
                        ) : null}
                      </ActionForm>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {u.disabledAt ? <Badge variant="red">disabled</Badge> : u.passwordHash ? <Badge variant="green">active</Badge> : <Badge variant="yellow">invited</Badge>}
                        {u.mfaEnabled ? <Badge variant="blue">MFA</Badge> : null}
                      </div>
                    </Td>
                    <Td className="text-xs text-ink-3">{u.lastLoginAt ? fmt(u.lastLoginAt) : "never"}</Td>
                    <Td>
                      <div className="flex flex-col items-start gap-1">
                        {u.id !== v.userId ? (
                          <form action={toggleUserAction}>
                            <input type="hidden" name="userId" value={u.id} />
                            <input type="hidden" name="disable" value={u.disabledAt ? "false" : "true"} />
                            <button className="min-h-9 text-xs font-medium underline" type="submit">
                              {u.disabledAt ? "Enable login" : "Disable login"}
                            </button>
                          </form>
                        ) : null}
                        {u.mfaEnabled && u.id !== v.userId ? (
                          <form action={disableMfaAction}>
                            <input type="hidden" name="userId" value={u.id} />
                            <button className="min-h-9 text-xs font-medium underline" type="submit">
                              Reset MFA
                            </button>
                          </form>
                        ) : null}
                        {u.role !== "kiosk" ? (
                          <OneTimeLinkForm action={resetLinkAction} submitLabel="Password reset link" size="sm">
                            <input type="hidden" name="userId" value={u.id} />
                          </OneTimeLinkForm>
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Invite a user" kicker="One-time link" />
          <CardBody>
            <OneTimeLinkForm action={inviteUserAction} submitLabel="Create invite">
              <Field label="Name" htmlFor="inv-name">
                <Input id="inv-name" name="displayName" required />
              </Field>
              <Field label="Email" htmlFor="inv-email">
                <Input id="inv-email" name="email" type="email" required />
              </Field>
              <Field label="Role" htmlFor="inv-role">
                <Select id="inv-role" name="role" defaultValue="coach">
                  {grantable.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Link to person record (optional)" htmlFor="inv-person" hint="Paste the person's id from their People page URL. Guardians and athletes must be linked to see anything.">
                <Input id="inv-person" name="personId" />
              </Field>
            </OneTimeLinkForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
