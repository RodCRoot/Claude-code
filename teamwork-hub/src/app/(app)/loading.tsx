export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse space-y-4">
      <div className="h-8 w-56 rounded bg-surface-2" />
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="h-24 rounded-xl bg-surface-2" />
        <div className="h-24 rounded-xl bg-surface-2" />
        <div className="h-24 rounded-xl bg-surface-2" />
      </div>
      <div className="h-64 rounded-xl bg-surface-2" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
