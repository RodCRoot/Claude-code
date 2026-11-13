import { redirect } from "next/navigation";
import { db } from "@/db";
import { CheckinTrends } from "@/components/checkins/trends";
import { ButtonLink, EmptyState, PageHeader, Select, buttonClass } from "@/components/ui";
import { requireStaff } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { CHECKIN_METHODS } from "@/lib/checkins/baseline";
import { athleteCheckinTrends } from "@/lib/checkins/views";
import { scopedAthletes } from "@/lib/science/access";

export const metadata = { title: "Check-in trends" };

/** Staff view of one athlete's check-in history. Scope and health access are decided in athleteCheckinTrends. */
export default async function AthleteCheckinsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const v = await requireStaff();
  const { id } = await searchParams;
  const athletes = await scopedAthletes(db, v, "profile.read");
  // Never trust an id outside the viewer's own list.
  const athlete = athletes.find((a) => a.id === id) ?? null;
  if (id && !athlete) redirect("/denied");
  let trends: Awaited<ReturnType<typeof athleteCheckinTrends>> | null = null;
  if (athlete) {
    try {
      trends = await db.transaction((tx) => athleteCheckinTrends(tx, v, athlete.id));
    } catch (e) {
      if (e instanceof AuthzError) redirect("/denied");
      throw e;
    }
  }
  return (
    <>
      <PageHeader
        kicker="Session check-ins"
        title={athlete ? athlete.name : "Check-in trends"}
        description="The last 12 weeks of ready checks and after checks, against this athlete's own baseline."
        actions={
          <ButtonLink href="/check-ins" variant="secondary">
            All check-ins
          </ButtonLink>
        }
      />
      <form method="get" className="mb-5 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="athlete" className="block text-xs font-medium text-ink-3">
            Athlete
          </label>
          <Select id="athlete" name="id" defaultValue={athlete?.id ?? ""} className="min-w-52">
            {athlete ? null : <option value="">Choose an athlete…</option>}
            {athletes.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        <button type="submit" className={buttonClass("secondary", "md")}>
          Show
        </button>
      </form>
      {!trends || !athlete ? (
        <EmptyState title="Choose an athlete">Only athletes in your scope are listed.</EmptyState>
      ) : (
        <>
          <CheckinTrends t={trends} simple={false} firstName={athlete.firstName} />
          <details className="mt-5 rounded-md border border-edge bg-surface px-4 py-3 text-sm">
            <summary className="cursor-pointer font-semibold">How these numbers are calculated</summary>
            <dl className="mt-2 space-y-2">
              {Object.entries(CHECKIN_METHODS).map(([k, text]) => (
                <div key={k}>
                  <dt className="font-mono text-xs font-semibold">{k}</dt>
                  <dd className="text-ink-2">{text}</dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </>
  );
}
