import { ChartFigure } from "@/components/charts/chart-figure";
import { TrendChart } from "@/components/charts/trend-chart";
import { Badge, Callout, Card, CardBody, CardHeader, Stat, Table, Td, Th } from "@/components/ui";
import { CHECKIN_METHODS, type Baseline, type CheckinMethod } from "@/lib/checkins/baseline";
import { rpeWord, sorenessWord } from "@/lib/checkins/questions";
import type { AthleteTrends, TrendPoint } from "@/lib/checkins/views";
import { fmtDate } from "@/lib/time";

export function MethodTag({ k }: { k: CheckinMethod }) {
  return (
    <Badge variant="blue" title={CHECKIN_METHODS[k]}>
      Teamwork calc · {k}
    </Badge>
  );
}

const dash = (v: number | null | undefined, suffix = "") => (v === null || v === undefined ? "-" : `${v}${suffix}`);

function NotEnough({ what, have, need }: { what: string; have: number; need: number }) {
  return (
    <p className="rounded-md border border-dashed border-edge px-3 py-4 text-sm text-ink-3">
      Not enough data yet for {what}: {have} of {need} answers. A personal baseline appears once there are {need}.
    </p>
  );
}

function Metric({
  title,
  unit,
  points,
  pick,
  pickBase,
  baseline,
  domain,
  range,
  simple,
  word,
}: {
  title: string;
  unit: string;
  points: TrendPoint[];
  pick: (p: TrendPoint) => number | null;
  pickBase?: (p: TrendPoint) => number | null;
  baseline: Baseline;
  domain: [number, number];
  range: string;
  simple: boolean;
  word?: (n: number) => string;
}) {
  const answered = points.filter((p) => pick(p) !== null);
  // The baseline counts earlier answers only; one more answer exists once the latest is in.
  if (answered.length < baseline.needed) return <NotEnough what={title.toLowerCase()} have={answered.length} need={baseline.needed} />;
  const latest = pick(answered[answered.length - 1])!;
  const series = [{ key: "value", label: title }, ...(pickBase ? [{ key: "usual", label: simple ? "Your usual" : "Own baseline" }] : [])];
  return (
    <ChartFigure
      title={title}
      unit={unit}
      range={range}
      legend={series.map((s, i) => ({ label: s.label, slot: i }))}
      summary={
        <>
          Latest: <strong>{latest}</strong>
          {word ? ` (${word(latest)})` : ""}. {baseline.mean === null ? "No baseline yet." : `${simple ? "Usual" : "Own baseline"}: ${baseline.mean} over the last ${baseline.n} answers.`} Sessions with no answer are gaps, not zeros.
        </>
      }
      columns={["Date", "Session", title, ...(pickBase ? ["Baseline before it"] : [])]}
      rows={points.map((p) => [p.date, p.title, pick(p), ...(pickBase ? [pickBase(p)] : [])])}
    >
      <TrendChart data={points.map((p) => ({ x: p.date, value: pick(p), ...(pickBase ? { usual: pickBase(p) } : {}) }))} series={series} unit="" digits={1} yDomain={domain} />
    </ChartFigure>
  );
}

/**
 * Check-in trends for one athlete. `simple` is the athlete / parent view: fewer numbers, plain
 * words. Everything shown was already filtered by `athleteCheckinTrends` for this viewer, so a
 * section the viewer may not see has no data here at all.
 */
export function CheckinTrends({ t, simple, firstName }: { t: AthleteTrends; simple: boolean; firstName: string }) {
  const range = `${fmtDate(t.from)} – ${fmtDate(t.to)}`;
  const b = t.baselines;
  const recent = [...t.points].reverse().slice(0, 12);
  const pct = (n: number) => (t.attended ? `${Math.round((n / t.attended) * 100)}%` : "—");
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Sessions attended" value={t.attended} hint={range} />
        <Stat label="Ready checks" value={`${t.readyCount} of ${t.attended}`} hint={pct(t.readyCount)} />
        <Stat label="After checks" value={`${t.afterCount} of ${t.attended}`} hint={pct(t.afterCount)} />
      </div>
      {!t.access.health ? (
        <Callout tone="info">
          {simple ? `Readiness, sleep, soreness and anything that hurt are health answers. Your account does not have health access for ${firstName}, so they are not shown here.` : "Your role does not include health access for this athlete, so readiness, sleep, soreness and pain answers are not shown."}
        </Callout>
      ) : null}
      {t.access.health && b ? (
        <Card>
          <CardHeader title="Before sessions" kicker="Ready check" action={simple ? undefined : <MethodTag k="checkin_baseline_v1" />} />
          <CardBody className="space-y-6">
            <Metric title="Readiness" unit="1 (not ready) to 5 (ready to go)" points={t.points} pick={(p) => p.readiness} pickBase={(p) => p.readinessBaseline} baseline={b.readiness} domain={[1, 5]} range={range} simple={simple} />
            <Metric title="Soreness" unit="0 (not sore) to 10 (worst ever)" points={t.points} pick={(p) => p.soreness} pickBase={(p) => p.sorenessBaseline} baseline={b.soreness} domain={[0, 10]} range={range} simple={simple} word={sorenessWord} />
            <Metric title="Sleep quality" unit="1 (very poor) to 5 (excellent)" points={t.points} pick={(p) => p.sleepQuality} baseline={b.sleepQuality} domain={[1, 5]} range={range} simple={simple} />
            {simple ? null : <p className="text-xs text-ink-3">Baselines are each athlete&apos;s own rolling average, not a good or bad cutoff. Self-reported answers; not a diagnosis.</p>}
          </CardBody>
        </Card>
      ) : null}
      {t.access.effort && b ? (
        <Card>
          <CardHeader title="How hard sessions felt" kicker="After check" action={simple ? undefined : <MethodTag k="srpe_load_v1" />} />
          <CardBody className="space-y-6">
            <Metric title="Session RPE" unit="0 (rest) to 10 (max effort)" points={t.points} pick={(p) => p.rpe} baseline={b.rpe} domain={[0, 10]} range={range} simple={simple} word={rpeWord} />
            {!simple && t.points.some((p) => p.load !== null) ? (
              <ChartFigure
                title="Session load"
                unit="AU (minutes × RPE)"
                range={range}
                summary="One value per answered session. This is the same number Sports Science → Load uses; it is not a second load figure."
                columns={["Date", "Session", "Minutes", "RPE", "Load (AU)", "Planned RPE"]}
                rows={t.points.map((p) => [p.date, p.title, p.minutes, p.rpe, p.load, p.intendedRpe])}
              >
                <TrendChart data={t.points.map((p) => ({ x: p.date, load: p.load }))} series={[{ key: "load", label: "Load" }]} unit=" AU" digits={0} />
              </ChartFigure>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
      {t.access.health ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Where it hurt" kicker={range} />
            <CardBody>
              {t.painBySpot.length === 0 ? (
                <p className="text-sm text-ink-3">No spots marked in check-ins in this period. That only means none were marked.</p>
              ) : (
                <Table caption="Body spots marked in check-ins">
                  <thead>
                    <tr>
                      <Th>Spot</Th>
                      <Th align="right">Times</Th>
                      <Th align="right">Sharp</Th>
                      <Th>Last</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.painBySpot.map((s) => (
                      <tr key={s.label}>
                        <Td>{s.label}</Td>
                        <Td align="right">{s.count}</Td>
                        <Td align="right">{s.sharp}</Td>
                        <Td>{fmtDate(s.lastDate)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
          {simple ? null : (
            <Card>
              <CardHeader title="Next-day soreness after a session" action={<MethodTag k="soreness_response_v1" />} />
              <CardBody>
                {t.sorenessResponse.length === 0 ? (
                  <p className="text-sm text-ink-3">Not enough data yet. This fills in when the next ready check asks how sore the athlete was after the last session.</p>
                ) : (
                  <Table caption="Session load and the soreness reported the day after">
                    <thead>
                      <tr>
                        <Th>Session</Th>
                        <Th align="right">Load (AU)</Th>
                        <Th align="right">Next-day soreness</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.sorenessResponse.map((s) => (
                        <tr key={`${s.date}-${s.title}`}>
                          <Td>
                            {fmtDate(s.date)} · {s.title}
                          </Td>
                          <Td align="right">{dash(s.load)}</Td>
                          <Td align="right">{s.nextDaySoreness} of 10</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      ) : null}
      {t.access.experience !== "none" ? (
        <Card>
          <CardHeader title="Likes and dislikes" kicker={t.access.experience === "shared" ? "Only answers the family chose to share with you" : range} />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["Liked", t.liked],
                ["Did not like", t.disliked],
              ] as const
            ).map(([label, chips]) => (
              <div key={label}>
                <h3 className="mb-1 text-sm font-semibold">{label}</h3>
                {chips.length === 0 ? (
                  <p className="text-sm text-ink-3">Nothing tapped yet.</p>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {chips.map((c) => (
                      <li key={c.key}>
                        <Badge>
                          {c.label} × {c.count}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="Recent sessions" kicker="Newest first" />
        <CardBody>
          {recent.length === 0 ? (
            <p className="text-sm text-ink-3">No attended sessions in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table caption="Recent sessions and check-in answers">
                <thead>
                  <tr>
                    <Th>Session</Th>
                    {t.access.health ? <Th align="right">Ready</Th> : null}
                    {t.access.health ? <Th align="right">Sore</Th> : null}
                    {t.access.effort ? <Th align="right">RPE</Th> : null}
                    {t.access.experience !== "none" ? <Th align="right">Rating</Th> : null}
                    <Th>Check-ins</Th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((p) => (
                    <tr key={p.bookingId}>
                      <Td>
                        <span className="block font-medium">{p.title}</span>
                        <span className="text-xs text-ink-3">{fmtDate(p.date)}</span>
                      </Td>
                      {t.access.health ? <Td align="right">{dash(p.readiness, "/5")}</Td> : null}
                      {t.access.health ? (
                        <Td align="right">
                          {dash(p.soreness, "/10")}
                          {p.spots.length ? <span className="block text-xs text-ink-3">{p.spots.map((s) => `${s.label} (${s.kind === "sharp" ? "sharp" : "achy"})`).join(", ")}</span> : null}
                        </Td>
                      ) : null}
                      {t.access.effort ? <Td align="right">{dash(p.rpe, "/10")}</Td> : null}
                      {t.access.experience !== "none" ? <Td align="right">{dash(p.rating, "/5")}</Td> : null}
                      <Td>
                        <span className="text-xs text-ink-2">
                          {p.readyDone ? "Ready ✓" : "Ready: none"} · {p.afterDone ? "After ✓" : "After: none"}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          <p className="mt-2 text-xs text-ink-3">A dash means no answer. It never means zero, and it never means fine.</p>
        </CardBody>
      </Card>
    </div>
  );
}
