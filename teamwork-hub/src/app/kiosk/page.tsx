import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { kioskRoster } from "@/lib/scheduling/kiosk";
import { DEFAULT_TZ, fmtTime } from "@/lib/time";
import { kioskPinOnly } from "@/lib/scheduling/common";
import { kioskCheckInAction } from "./actions";
import { boundLocationId, getLocation } from "@/lib/locations";
import { KioskPinPad } from "./pin-pad";

export const dynamic = "force-dynamic";

export default async function KioskPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const v = await requireViewer();
  const { q } = await searchParams;
  const tz = (await getOrg(v.orgId))?.timezone ?? DEFAULT_TZ;
  const pinOnly = await kioskPinOnly(db, v.orgId);
  const boundId = v.role === "kiosk" ? await boundLocationId(db, v) : null;
  const locationLabel = boundId ? <p className="text-sm font-medium text-ink-3">{(await getLocation(db, v.orgId, boundId)).name} check-in</p> : null;
  if (pinOnly && v.role === "kiosk") {
    return (
      <div className="mx-auto max-w-md space-y-6">
        {locationLabel}
        <h1 className="text-2xl font-bold">Welcome! Enter your PIN to check in.</h1>
        <KioskPinPad />
        <p className="text-center text-ink-3">No PIN yet? Please see the front desk.</p>
      </div>
    );
  }
  const sessions = await kioskRoster(db, v, { q });
  const now = new Date();

  return (
    <div className="space-y-6">
      {locationLabel}
      <h1 className="text-2xl font-bold">Welcome! Enter your PIN or find your name to check in.</h1>
      <details className="rounded-2xl border border-edge bg-surface sm:max-w-md" open={!q}>
        <summary className="flex min-h-14 cursor-pointer items-center px-4 text-lg font-semibold">Check in with a PIN</summary>
        <div className="px-2 pb-2">
          <KioskPinPad bare />
        </div>
      </details>
      <form method="get" role="search" className="flex gap-2">
        <label htmlFor="kq" className="sr-only">
          Find your name
        </label>
        <input
          id="kq"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Type your first name"
          autoComplete="off"
          className="h-14 w-full rounded-xl border border-edge bg-surface px-4 text-lg focus:outline-2 focus:outline-brand"
        />
        <button type="submit" className="h-14 rounded-xl bg-brand px-6 text-lg font-semibold text-brand-ink">
          Find
        </button>
        {q ? (
          <Link href="/kiosk" className="inline-flex h-14 items-center rounded-xl border border-edge px-4 text-lg">
            Clear
          </Link>
        ) : null}
      </form>

      {sessions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-edge px-6 py-16 text-center">
          <p className="text-xl font-semibold">{q ? `No one named “${q}” is booked today.` : "No sessions with bookings today."}</p>
          <p className="mt-2 text-ink-3">Please see the front desk.</p>
        </div>
      ) : (
        sessions.map((s) => {
          const live = now >= new Date(s.startsAt.getTime() - 60 * 60_000) && now <= s.endsAt;
          return (
            <section key={s.id} aria-labelledby={`k-${s.id}`} className="rounded-2xl border border-edge bg-surface p-4 sm:p-6">
              <h2 id={`k-${s.id}`} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xl font-bold">{s.title}</span>
                <span className="text-base font-medium tabular text-ink-3">
                  {fmtTime(s.startsAt, tz)} – {fmtTime(s.endsAt, tz)}
                  {live ? <span className="ml-2 rounded-full bg-ok/15 px-2 py-0.5 text-xs font-bold text-ok">NOW</span> : null}
                </span>
              </h2>
              {s.athletes.length === 0 ? (
                <p className="mt-3 text-ink-3">No one booked yet.</p>
              ) : (
                <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {s.athletes.map((a) => (
                    <li key={a.bookingId} className="rounded-xl border border-edge p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-lg font-semibold">{a.displayName}</span>
                        {a.status === "attended" ? <span className="text-sm font-bold text-ok">✓ Checked in</span> : null}
                      </div>
                      {a.alerts.map((m, i) => (
                        <p key={i} className="mt-1 rounded-md bg-warn/10 px-2 py-1 text-sm font-medium text-warn" role="note">
                          {m}
                        </p>
                      ))}
                      {a.status === "booked" ? (
                        <ActionForm action={kioskCheckInAction} className="mt-2">
                          <input type="hidden" name="bookingId" value={a.bookingId} />
                          <SubmitButton size="lg" className="min-h-14 w-full text-lg" pendingText="Checking in…">
                            Check in {a.displayName.split(" ")[0]}
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
