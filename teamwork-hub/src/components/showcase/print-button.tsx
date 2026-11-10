"use client";

/** Opens the browser's print dialog. Light-on-dark, for the hero band. Hidden on paper. */
export function PrintPageButton({ label = "Print" }: { label?: string }) {
  return (
    <button type="button" onClick={() => window.print()} className="no-print inline-flex min-h-10 items-center justify-center rounded-md bg-white/10 px-4 text-sm font-bold whitespace-nowrap text-white ring-1 ring-white/25 hover:bg-white/20">
      {label}
    </button>
  );
}
