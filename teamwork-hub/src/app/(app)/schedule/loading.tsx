export default function ScheduleLoading() {
  return (
    <div role="status" aria-live="polite" className="animate-pulse space-y-4">
      <span className="sr-only">Loading schedule…</span>
      <div className="h-8 w-48 rounded bg-surface-2" />
      <div className="overflow-hidden rounded-md border border-edge bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-edge px-3 py-2.5">
          <div className="h-9 w-64 rounded-md bg-surface-2" />
          <div className="h-9 w-48 rounded-md bg-surface-2" />
        </div>
        <div className="h-12 border-b border-edge bg-th" />
        <div className="grid h-96 grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] max-lg:hidden">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="border-r border-edge last:border-r-0" />
          ))}
        </div>
        <div className="space-y-2 p-3 lg:hidden">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-20 rounded-md bg-surface-2" />
          ))}
        </div>
      </div>
    </div>
  );
}
