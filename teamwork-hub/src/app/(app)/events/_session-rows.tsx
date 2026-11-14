"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui";

type Row = { key: number; date: string; start: string; end: string };

const nextDay = (ymd: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);
};

/** Session dates for a new event. "Add day" copies the times and moves to the next day. */
export function SessionRows({ max = 60 }: { max?: number }) {
  const [rows, setRows] = useState<Row[]>([{ key: 1, date: "", start: "09:00", end: "12:00" }]);
  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink-2">
        Sessions <span className="text-bad" aria-hidden>*</span>
      </legend>
      <p className="text-xs text-ink-3">One row per day. A one-day clinic has one row; a three-day camp has three.</p>
      <ul className="mt-2 space-y-2">
        {rows.map((r, i) => (
          <li key={r.key} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <label className="col-span-2 block text-xs font-medium text-ink-2 sm:col-span-1">
              Day {i + 1}
              <Input type="date" name="sessionDate" required value={r.date} onChange={(e) => set(r.key, { date: e.target.value })} className="mt-1 h-11" />
            </label>
            <label className="block text-xs font-medium text-ink-2">
              Starts
              <Input type="time" name="sessionStart" required value={r.start} onChange={(e) => set(r.key, { start: e.target.value })} className="mt-1 h-11" />
            </label>
            <label className="block text-xs font-medium text-ink-2">
              Ends
              <Input type="time" name="sessionEnd" required value={r.end} onChange={(e) => set(r.key, { end: e.target.value })} className="mt-1 h-11" />
            </label>
            {rows.length > 1 ? (
              <Button type="button" variant="ghost" className="col-span-2 h-11 sm:col-span-1" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label={`Remove day ${i + 1}`}>
                Remove
              </Button>
            ) : (
              <span className="hidden sm:block" />
            )}
          </li>
        ))}
      </ul>
      {rows.length < max ? (
        <Button
          type="button"
          variant="secondary"
          className="mt-2"
          onClick={() =>
            setRows((rs) => {
              const last = rs[rs.length - 1];
              return [...rs, { key: Math.max(...rs.map((x) => x.key)) + 1, date: nextDay(last.date), start: last.start, end: last.end }];
            })
          }
        >
          Add day
        </Button>
      ) : null}
    </fieldset>
  );
}
