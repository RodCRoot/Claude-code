import { Badge, Table, Td, Th } from "@/components/ui";
import type { ReportSections, ReportSnapshot } from "@/lib/science/reports";
import { VENDOR_LABEL } from "@/lib/science/kpis";
import { fmtDate } from "@/lib/time";

const n = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));

/** Renders a frozen report snapshot. Callers decide (server-side) whether wellness is allowed. */
export function ReportBody({ snapshot, sections, summary }: { snapshot: ReportSnapshot; sections: ReportSections; summary: string | null }) {
  return (
    <div className="space-y-5 text-sm">
      <p className="text-xs text-ink-3">
        Period {fmtDate(snapshot.period.start)} – {fmtDate(snapshot.period.end)} · snapshot taken {fmtDate(snapshot.generatedAt)}
      </p>
      {summary ? (
        <section>
          <h3 className="mb-1 font-semibold">Coach summary</h3>
          <p className="whitespace-pre-wrap text-ink-2">{summary}</p>
        </section>
      ) : null}
      {sections.kpis ? (
        <section>
          <h3 className="mb-1 font-semibold">Testing results</h3>
          {snapshot.kpis.length ? (
            <Table caption="Testing results">
              <thead>
                <tr>
                  <Th>Metric</Th>
                  <Th align="right">Latest</Th>
                  <Th align="right">Baseline</Th>
                  <Th align="right">Target</Th>
                  <Th align="right">Change</Th>
                </tr>
              </thead>
              <tbody>
                {snapshot.kpis.map((k) => (
                  <tr key={k.metric}>
                    <Td>
                      {k.metric} <span className="text-xs text-ink-3">({k.unit})</span> <Badge variant={k.source === "hawkin" ? "yellow" : "neutral"}>{VENDOR_LABEL[k.source] ?? k.source}</Badge>
                      {k.excludedNote ? <div className="text-xs text-ink-3">{k.excludedNote}</div> : null}
                    </Td>
                    <Td align="right">
                      {n(k.latest, k.precision)}
                      <div className="text-[11px] text-ink-3">{k.latestDate ?? ""}</div>
                    </Td>
                    <Td align="right">{n(k.baseline, k.precision)}</Td>
                    <Td align="right">{n(k.target, k.precision)}</Td>
                    <Td align="right">{k.changePct === null ? "—" : `${k.changePct > 0 ? "+" : ""}${k.changePct.toFixed(1)}%`}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="text-ink-3">No testing in this period.</p>
          )}
        </section>
      ) : null}
      {sections.strength ? (
        <section>
          <h3 className="mb-1 font-semibold">Strength (best recorded max)</h3>
          {snapshot.strength.length ? (
            <ul className="space-y-1">
              {snapshot.strength.map((s) => (
                <li key={s.exercise}>
                  {s.exercise}: <strong className="tabular">{s.value} {s.unit}</strong> <span className="text-xs text-ink-3">({s.method}, {s.date})</span> {s.prInPeriod ? <Badge variant="green">PR this period</Badge> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-3">No maxes recorded.</p>
          )}
        </section>
      ) : null}
      {sections.habits ? (
        <section>
          <h3 className="mb-1 font-semibold">Habits</h3>
          {snapshot.habits.length ? (
            <ul className="space-y-1">
              {snapshot.habits.map((h) => (
                <li key={h.name}>
                  {h.name}: <strong className="tabular">{h.adherencePct === null ? "—" : `${h.adherencePct.toFixed(0)}%`}</strong> adherence ({h.done} done, {h.partial} partial, {h.missed} missed, {h.noCheckin} no check-in of {h.expected}) · streak {h.streak}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-3">No habits assigned.</p>
          )}
        </section>
      ) : null}
      {sections.attendance ? (
        <section>
          <h3 className="mb-1 font-semibold">Attendance</h3>
          {snapshot.attendance ? (
            <p>
              {snapshot.attendance.ratePct === null ? "—" : `${snapshot.attendance.ratePct.toFixed(0)}%`} ({snapshot.attendance.attended} attended, {snapshot.attendance.noShow} no-show)
            </p>
          ) : (
            <p className="text-ink-3">No attendance records in this period.</p>
          )}
        </section>
      ) : null}
      {sections.wellness && snapshot.wellness ? (
        <section>
          <h3 className="mb-1 font-semibold">Wellness (shared with health access only)</h3>
          <p>
            {snapshot.wellness.respondedDays} check-ins over {snapshot.wellness.periodDays} days. Mean Teamwork readiness ({snapshot.wellness.formula}): {n(snapshot.wellness.meanReadiness, 0)}/100.
          </p>
        </section>
      ) : null}
    </div>
  );
}
