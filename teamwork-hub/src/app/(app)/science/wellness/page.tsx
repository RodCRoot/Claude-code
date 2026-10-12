import { ChartFigure } from "@/components/charts/chart-figure";
import { TrendChart } from "@/components/charts/trend-chart";
import { ButtonLink, Card, CardBody, CardHeader, EmptyState, Input, PageHeader, Select } from "@/components/ui";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { can, isStaff } from "@/lib/authz/policy";
import { scopedAthletes } from "@/lib/science/access";
import { FORMULAS, mean } from "@/lib/science/formulas";
import { completionGrid, listQuestionnaires, questionnairesForAthlete, versionHistory, wellnessTrend } from "@/lib/science/wellness";
import { addDaysYmd, fmt, todayLocal } from "@/lib/time";
import { CheckinForm } from "../_components/checkin-form";
import { AthletePicker, FormulaTag, HealthOnly, fmtN, isYmd, pickAthlete, sp1, type SP } from "../_components/shared";
import { HeatLegend, ReadinessHeatTable } from "../_components/ams";
import { ModuleHero } from "../../training/_components/tb";

export const metadata = { title: "Wellness" };

export default async function WellnessPage({ searchParams }: { searchParams: SP }) {
  const v = await requireViewer();
  const p = await searchParams;
  const today = todayLocal();
  const athletes = await scopedAthletes(db, v, "health.read");
  if (!athletes.length) {
    return (
      <>
        <PageHeader kicker="Sports science" title="Wellness questionnaires" />
        <HealthOnly />
      </>
    );
  }
  const qs = await listQuestionnaires(db, v);
  const q = qs.find((x) => x.id === sp1(p.q)) ?? qs.find((x) => x.active) ?? null;
  const date = isYmd(sp1(p.date)) && sp1(p.date) <= today ? sp1(p.date) : today;

  if (!isStaff(v)) {
    const self = athletes[0];
    const mine = await questionnairesForAthlete(db, v, self.id, today);
    return (
      <>
        <PageHeader kicker={today} title="Daily check-in" description="One screen, about a minute. Your coach sees your answers." />
        {mine.length === 0 ? <EmptyState title="No questionnaires assigned to you." /> : null}
        <div className="grid gap-6 lg:grid-cols-2">
          {mine.map((mq) => (
            <Card key={mq.id}>
              <CardHeader title={mq.name} kicker={`Version ${mq.version}${mq.due ? "" : " · not scheduled today"}`} />
              <CardBody>
                {mq.response ? <p className="mb-3 text-sm font-medium text-ok">Submitted {fmt(mq.response.submittedAt, "h:mm a")}. You can update it today.</p> : null}
                <CheckinForm athleteId={self.id} questionnaireId={mq.id} questions={mq.questions} existing={mq.response?.answers ?? null} forDate={today} />
              </CardBody>
            </Card>
          ))}
          {q ? <TrendCard athleteId={self.id} questionnaireId={q.id} item={sp1(p.item)} today={today} /> : null}
        </div>
      </>
    );
  }

  const grid = q ? await completionGrid(db, v, q.id, date) : null;
  const trendAthlete = pickAthlete(athletes, sp1(p.athlete));
  const history = q ? await versionHistory(db, v, q.id) : [];
  return (
    <>
      <ModuleHero
        kicker="Sports science · AMS"
        title="Wellness & readiness"
        description="Athletes × questionnaire items, flags, and per-item trends. 'No response' is its own state and is never treated as a favorable answer."
        actions={can(v, "science.manage") ? <ButtonLink href="/science/wellness/builder">New questionnaire</ButtonLink> : undefined}
      />
      {qs.length === 0 ? (
        <EmptyState title="No questionnaires yet" action={can(v, "science.manage") ? <ButtonLink href="/science/wellness/builder">Build one</ButtonLink> : undefined}>
          Build a questionnaire with scale, number, text, and yes/no items.
        </EmptyState>
      ) : (
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-edge bg-surface p-3">
          <div>
            <label htmlFor="wq" className="block text-xs font-medium text-ink-3">
              Questionnaire
            </label>
            <Select id="wq" name="q" defaultValue={q?.id}>
              {qs.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} (v{x.version}){x.active ? "" : " — inactive"}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="wd" className="block text-xs font-medium text-ink-3">
              Date
            </label>
            <Input id="wd" type="date" name="date" max={today} defaultValue={date} />
          </div>
          <button type="submit" className="h-10 rounded-lg border border-edge px-3 text-sm font-medium hover:bg-surface-2">
            Show
          </button>
        </form>
      )}
      {q && grid ? (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title={`Completion · ${date}`}
              kicker={`${q.name} · v${q.version} · ${q.schedule.frequency.replace("_", " ")}`}
              action={can(v, "science.manage") ? <ButtonLink href={`/science/wellness/builder?id=${q.id}`} variant="outline" size="sm">Edit questionnaire</ButtonLink> : undefined}
            />
            <CardBody>
              <p className="mb-2 text-xs text-ink-3">
                Readiness = <FormulaTag k="tw_readiness_v1" /> {FORMULAS.tw_readiness_v1.definition}
              </p>
              {grid.rows.length === 0 ? (
                <p className="text-sm text-ink-3">None of your athletes are targeted by this questionnaire.</p>
              ) : (
                <>
                  <ReadinessHeatTable rows={grid.rows} questions={grid.q.questions} caption="Wellness completion grid" hrefFor={(id) => `/science/wellness?q=${q.id}&date=${date}&athlete=${id}#trend`} />
                  <HeatLegend className="mt-2" />
                </>
              )}
              <p className="mt-2 text-xs text-ink-3">
                Flag rules:{" "}
                {Object.entries(q.schedule.flagRules).length
                  ? Object.entries(q.schedule.flagRules)
                      .map(([k, r]) => `${q.questions.find((x) => x.key === k)?.label ?? k} ${r.below != null ? `< ${r.below}` : ""}${r.above != null ? `> ${r.above}` : ""}`)
                      .join(" · ")
                  : "none configured"}
              </p>
            </CardBody>
          </Card>
          <div id="trend">
            <div className="mb-3">
              <AthletePicker athletes={athletes} current={trendAthlete?.id ?? null} extra={{ q: q.id, date }} label="Trend for athlete" />
            </div>
            {trendAthlete ? <TrendCard athleteId={trendAthlete.id} questionnaireId={q.id} item={sp1(p.item)} today={today} name={trendAthlete.name} /> : null}
          </div>
          <Card>
            <CardHeader title="Versions" kicker="Editing questions creates a new version; responses keep theirs" />
            <CardBody>
              <ul className="text-sm">
                {history.map((h) => (
                  <li key={h.id} className="flex justify-between border-b border-edge/60 py-1.5">
                    <span>
                      v{h.version} · {h.questions.length} questions
                    </span>
                    <span className="text-ink-3">
                      {h.responses} responses · {fmt(h.createdAt, "MMM d, yyyy")}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      ) : null}
    </>
  );
}

async function TrendCard({ athleteId, questionnaireId, item, today, name }: { athleteId: string; questionnaireId: string; item: string; today: string; name?: string }) {
  const v = await requireViewer();
  const from = addDaysYmd(today, -27);
  const t = await wellnessTrend(db, v, { athleteId, questionnaireId, from, to: today });
  if (!t) return null;
  const itemKey = t.numericKeys.includes(item) ? item : null;
  const itemDef = itemKey ? t.q.questions.find((x) => x.key === itemKey) : null;
  const responded = t.points.filter((p) => p.responded).length;
  const meanReady = mean(t.points.map((p) => p.readiness));
  return (
    <Card>
      <CardHeader title={`Trend${name ? ` · ${name}` : ""}`} kicker={`${from} → ${today} (28 days)`} />
      <CardBody className="space-y-6">
        <ChartFigure
          title="Teamwork readiness (tw_readiness_v1)"
          unit="0–100 Teamwork scale"
          range={`${from} – ${today}`}
          summary={`${responded} of 28 days answered (${28 - responded} with no response, shown as gaps). Mean readiness over answered days: ${fmtN(meanReady, 0)}.`}
          columns={["Date", "Responded", "Readiness"]}
          rows={t.points.map((p) => [p.date, p.responded ? "yes" : "no response", p.readiness === null ? null : Math.round(p.readiness)])}
        >
          <TrendChart data={t.points.map((p) => ({ x: p.date, readiness: p.readiness === null ? null : Math.round(p.readiness) }))} series={[{ key: "readiness", label: "Readiness" }]} unit="/100" digits={0} yDomain={[0, 100]} />
        </ChartFigure>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="q" value={questionnaireId} />
          <input type="hidden" name="athlete" value={athleteId} />
          <div>
            <label htmlFor="item" className="block text-xs font-medium text-ink-3">
              Item trend
            </label>
            <Select id="item" name="item" defaultValue={itemKey ?? ""}>
              <option value="">Choose an item…</option>
              {t.numericKeys.map((k) => (
                <option key={k} value={k}>
                  {t.q.questions.find((x) => x.key === k)?.label ?? k}
                </option>
              ))}
            </Select>
          </div>
          <button type="submit" className="h-10 rounded-lg border border-edge px-3 text-sm font-medium hover:bg-surface-2">
            Show
          </button>
        </form>
        {itemKey && itemDef ? (
          <ChartFigure
            title={itemDef.label}
            unit={itemDef.kind === "scale" ? `scale ${itemDef.min}–${itemDef.max} (${itemDef.polarity === "lower_better" ? "lower is better" : itemDef.polarity === "higher_better" ? "higher is better" : "neutral"})` : itemDef.unit ?? "number"}
            range={`${from} – ${today}`}
            summary={`${t.points.filter((p) => p.values[itemKey] !== null).length} days with a value; mean ${fmtN(mean(t.points.map((p) => p.values[itemKey])), 1)}. Blank days are unanswered.`}
            columns={["Date", itemDef.label]}
            rows={t.points.map((p) => [p.date, p.values[itemKey]])}
          >
            <TrendChart data={t.points.map((p) => ({ x: p.date, value: p.values[itemKey] }))} series={[{ key: "value", label: itemDef.label }]} unit={itemDef.unit ?? ""} digits={1} yDomain={itemDef.kind === "scale" ? [itemDef.min ?? 0, itemDef.max ?? 10] : undefined} />
          </ChartFigure>
        ) : null}
      </CardBody>
    </Card>
  );
}
