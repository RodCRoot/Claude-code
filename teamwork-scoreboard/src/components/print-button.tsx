"use client";

export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button
      onClick={() => window.print()}
      className="rounded-lg border border-edge px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-surface-3"
    >
      {label}
    </button>
  );
}
