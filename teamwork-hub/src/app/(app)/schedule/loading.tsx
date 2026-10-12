export default function ScheduleLoading() {
  return (
    <div role="status" aria-live="polite" className="animate-pulse space-y-4">
      <span className="sr-only">Loading schedule…</span>
      <div className="h-8 w-48 rounded bg-surface-2" />
      <div className="h-11 w-full rounded-lg bg-surface-2" />
      <div className="grid gap-3 lg:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="h-40 rounded-xl bg-surface-2" />
        ))}
      </div>
    </div>
  );
}
