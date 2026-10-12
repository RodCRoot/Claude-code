"use client";

export default function KioskError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="rounded-2xl border border-bad/30 bg-bad/5 px-6 py-12 text-center">
      <p className="text-xl font-semibold">Check-in is temporarily unavailable.</p>
      <p className="mt-2 text-ink-3">Please see the front desk.</p>
      <button type="button" onClick={reset} className="mt-6 min-h-14 rounded-xl bg-brand px-6 text-lg font-semibold text-brand-ink">
        Try again
      </button>
    </div>
  );
}
