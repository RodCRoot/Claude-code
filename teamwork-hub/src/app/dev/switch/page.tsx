import { notFound, redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession } from "@/lib/auth/session";
import { isDemoMode } from "@/lib/env";
import { ROLE_LABEL } from "@/lib/nav";
import { Badge } from "@/components/ui";

export const metadata = { title: "Demo sign-in" };

/**
 * Development-only role switcher. Disabled unless APP_MODE=demo and NODE_ENV is
 * not production, and it only ever signs in as users flagged is_demo.
 */
function enabled() {
  return isDemoMode() && process.env.NODE_ENV !== "production";
}

async function signInAs(fd: FormData) {
  "use server";
  if (!enabled()) notFound();
  const id = String(fd.get("userId"));
  const [u] = await db.select().from(users).where(and(eq(users.id, id), eq(users.isDemo, true), isNull(users.disabledAt)));
  if (!u) notFound();
  await createSession(u.id, { mfaVerified: true });
  redirect(u.role === "kiosk" ? "/kiosk" : "/today");
}

export default async function DevSwitch() {
  if (!enabled()) notFound();
  const demoUsers = await db.select().from(users).where(eq(users.isDemo, true)).orderBy(asc(users.role), asc(users.displayName));
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold">Demo sign-in</h1>
      <p className="mt-1 text-sm text-ink-3">
        Development only. Every account here is synthetic. This page is unavailable when <code>APP_MODE</code> is not <code>demo</code> or in production builds.
      </p>
      <ul className="mt-6 divide-y divide-edge rounded-xl border border-edge bg-surface">
        {demoUsers.map((u) => (
          <li key={u.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="truncate font-medium">{u.displayName}</div>
              <div className="truncate text-xs text-ink-3">{u.email}</div>
            </div>
            <div className="flex items-center gap-3">
              <Badge>{ROLE_LABEL[u.role]}</Badge>
              <form action={signInAs}>
                <input type="hidden" name="userId" value={u.id} />
                <button className="min-h-11 rounded-lg bg-brand px-3 text-sm font-medium text-brand-ink" type="submit">
                  Sign in
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
      {demoUsers.length === 0 ? <p className="mt-4 text-sm">No demo users. Run <code>npm run db:seed</code>.</p> : null}
    </main>
  );
}
