import { sql } from "drizzle-orm";
import { db } from "@/db";
import { roles } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { PERMISSIONS, ALL_PERMISSIONS } from "@/lib/permissions";
import { addUser, updateUser, updateRolePermissions, addRole } from "@/app/actions/admin";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Button,
  Input,
  Select,
  Field,
} from "@/components/ui";

export const metadata = { title: "Users & Roles" };

export default async function AdminUsersPage() {
  const me = await requireUser("manage_users");
  const allRoles = db.select().from(roles).all();
  const users = db.all<{
    id: number;
    name: string;
    email: string;
    title: string | null;
    active: number;
    role_id: number;
    role_name: string;
  }>(sql`
    SELECT u.id, u.name, u.email, u.title, u.active, u.role_id, r.name AS role_name
    FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.name
  `);

  return (
    <>
      <PageHeader
        kicker="Admin"
        title="Users & Roles"
        subtitle="Role names are configurable — use generic roles like “Coach” and assign people to them."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader kicker="Team" title="Users" />
          <CardBody className="divide-y divide-edge/60">
            {users.map((u) => (
              <details key={u.id} className="py-2">
                <summary className="flex cursor-pointer items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{u.name}</span>
                    <span className="ml-2 text-xs text-ink-3">{u.email}</span>
                  </span>
                  <span className="flex gap-1.5">
                    <Badge variant="neutral">{u.role_name}</Badge>
                    {!u.active && <Badge variant="red">inactive</Badge>}
                  </span>
                </summary>
                <form action={updateUser} className="mt-3 grid gap-2 rounded-lg bg-surface-3/40 p-3 sm:grid-cols-2">
                  <input type="hidden" name="id" value={u.id} />
                  <Field label="Name"><Input name="name" defaultValue={u.name} /></Field>
                  <Field label="Title"><Input name="title" defaultValue={u.title ?? ""} /></Field>
                  <Field label="Role">
                    <Select name="roleId" defaultValue={String(u.role_id)}>
                      {allRoles.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Reset password (leave blank to keep)">
                    <Input name="password" type="password" autoComplete="new-password" />
                  </Field>
                  <Field label="Active">
                    <Select name="active" defaultValue={String(u.active)} disabled={u.id === me.id}>
                      <option value="1">active</option>
                      <option value="0">inactive</option>
                    </Select>
                  </Field>
                  <div className="flex items-end">
                    <Button size="sm" type="submit">Save user</Button>
                  </div>
                </form>
              </details>
            ))}
            <details className="py-2">
              <summary className="cursor-pointer text-sm font-semibold text-brand-600">+ Add user</summary>
              <form action={addUser} className="mt-3 grid gap-2 rounded-lg bg-surface-3/40 p-3 sm:grid-cols-2">
                <Field label="Name"><Input name="name" required /></Field>
                <Field label="Email"><Input name="email" type="email" required /></Field>
                <Field label="Title"><Input name="title" placeholder="e.g. Coach" /></Field>
                <Field label="Temporary password"><Input name="password" required /></Field>
                <Field label="Role">
                  <Select name="roleId">
                    {allRoles.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </Select>
                </Field>
                <div className="flex items-end">
                  <Button size="sm" type="submit">Create user</Button>
                </div>
              </form>
            </details>
          </CardBody>
        </Card>

        <Card>
          <CardHeader kicker="Access control" title="Role permissions" />
          <CardBody className="divide-y divide-edge/60">
            {allRoles.map((r) => {
              const perms = new Set<string>(JSON.parse(r.permissions || "[]"));
              return (
                <details key={r.id} className="py-2">
                  <summary className="flex cursor-pointer items-center justify-between">
                    <span className="font-medium">{r.name}</span>
                    <span className="text-xs text-ink-3">{perms.size} permissions</span>
                  </summary>
                  <form action={updateRolePermissions} className="mt-3 space-y-1 rounded-lg bg-surface-3/40 p-3">
                    <input type="hidden" name="roleId" value={r.id} />
                    {ALL_PERMISSIONS.map((p) => (
                      <label key={p} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name={`perm_${p}`}
                          defaultChecked={perms.has(p)}
                          className="size-4"
                        />
                        <span className="font-medium">{p}</span>
                        <span className="text-xs text-ink-3">— {PERMISSIONS[p]}</span>
                      </label>
                    ))}
                    <div className="pt-2">
                      <Button size="sm" type="submit">Save permissions</Button>
                    </div>
                  </form>
                </details>
              );
            })}
            <details className="py-2">
              <summary className="cursor-pointer text-sm font-semibold text-brand-600">+ Add role</summary>
              <form action={addRole} className="mt-3 flex items-end gap-2 rounded-lg bg-surface-3/40 p-3">
                <Field label="Role name"><Input name="name" required placeholder="e.g. Front Desk" /></Field>
                <Button size="sm" type="submit">Create role</Button>
              </form>
            </details>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
