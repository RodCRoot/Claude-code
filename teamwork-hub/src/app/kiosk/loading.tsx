export default function KioskLoading() {
  return (
    <div role="status" aria-live="polite" className="animate-pulse space-y-4">
      <span className="sr-only">Loading today&apos;s sessions…</span>
      <div className="h-14 rounded-xl bg-surface-2" />
      <div className="h-48 rounded-2xl bg-surface-2" />
      <div className="h-48 rounded-2xl bg-surface-2" />
    </div>
  );
}
