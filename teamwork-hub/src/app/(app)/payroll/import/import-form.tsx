"use client";

import { startTransition, useActionState } from "react";
import { FormMessage, type ActionState } from "@/components/forms";
import { Badge, buttonClass } from "@/components/ui";
import { importAction } from "../actions";

type Row = {
  line: number;
  status: "entry" | "no_entry" | "skipped" | "error";
  date: string | null;
  clockIn: string | null;
  clockOut: string | null;
  plusDays: number;
  rateMinor: number | null;
  recomputedHundredths: number | null;
  listedHundredths: number | null;
  warnings: string[];
  error: string | null;
};

const money = (m: number | null) => (m == null ? "—" : `$${(m / 100).toFixed(2)}`);
const time = (iso: string | null, tz: string) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }) : "—");

export function ImportForm({ staff, tz }: { staff: { userId: string; name: string }[]; tz: string }) {
  const [state, action, pending] = useActionState(importAction, {} as ActionState);
  const rows = (state.data?.rows as Row[] | undefined) ?? [];
  const configured = state.data?.configuredRateMinor as number | null | undefined;
  return (
    <form
      className="space-y-4"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => action(fd));
      }}
    >
      <div className="space-y-1">
        <label htmlFor="userId" className="block text-sm font-medium text-ink-2">
          Staff member these rows belong to
        </label>
        <select id="userId" name="userId" required className="h-10 w-full max-w-sm rounded-lg border border-edge bg-surface px-3 text-sm">
          {staff.map((s) => (
            <option key={s.userId} value={s.userId}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="text" className="block text-sm font-medium text-ink-2">
          Paste the Zen Planner payroll rows (or CSV)
        </label>
        <textarea
          id="text"
          name="text"
          rows={10}
          required
          className="w-full rounded-lg border border-edge bg-surface px-3 py-2 font-mono text-xs"
          placeholder={"Mon, 05 Oct 2026 | Coach | $15.00 / hour | 3:30 PM | 7:47 PM | 4.28 hours | $64.20\nTue, 06 Oct 2026 | Add"}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" name="commit" value="0" disabled={pending} className={buttonClass("secondary")}>
          {pending ? "Working…" : "Preview"}
        </button>
        <button type="submit" name="commit" value="1" disabled={pending || !rows.length || state.data?.committed === true} className={buttonClass("primary")}>
          Import these rows
        </button>
      </div>
      <FormMessage state={state} />
      {rows.length ? (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Import preview">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">Import preview</caption>
            <thead>
              <tr className="text-left text-xs uppercase text-ink-3">
                <th className="px-2 py-1">Line</th>
                <th className="px-2 py-1">Status</th>
                <th className="px-2 py-1">Date</th>
                <th className="px-2 py-1">In</th>
                <th className="px-2 py-1">Out</th>
                <th className="px-2 py-1 text-right">Hours</th>
                <th className="px-2 py-1 text-right">Rate</th>
                <th className="px-2 py-1">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.line} className="border-t border-edge/60">
                  <td className="px-2 py-1 tabular">{r.line}</td>
                  <td className="px-2 py-1">
                    <Badge variant={r.status === "entry" ? "green" : r.status === "error" ? "red" : "neutral"}>{r.status.replace("_", " ")}</Badge>
                  </td>
                  <td className="px-2 py-1">{r.date ?? "—"}</td>
                  <td className="px-2 py-1">{time(r.clockIn, tz)}</td>
                  <td className="px-2 py-1">
                    {time(r.clockOut, tz)}
                    {r.plusDays ? <span className="ml-1 font-semibold text-bad">+{r.plusDays}d</span> : null}
                  </td>
                  <td className="px-2 py-1 text-right tabular">{r.recomputedHundredths != null ? (r.recomputedHundredths / 100).toFixed(2) : "—"}</td>
                  <td className="px-2 py-1 text-right tabular">
                    {money(r.rateMinor)}
                    {r.rateMinor != null && configured != null && r.rateMinor !== configured ? <span className="block text-[11px] text-warn">differs from configured {money(configured)}</span> : null}
                  </td>
                  <td className="px-2 py-1 text-xs text-ink-3">{[r.error, ...r.warnings].filter(Boolean).join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </form>
  );
}
