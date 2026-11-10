"use client";

import { useState } from "react";
import { buttonClass } from "@/components/ui";

/** Read-only link field with a Copy button. Falls back to selecting the text when the clipboard is unavailable. */
export function CopyLink({ id, value, label }: { id: string; value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink-2">
        {label}
      </label>
      <div className="mt-1 flex flex-wrap gap-2">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="h-10 min-w-0 flex-1 rounded-md border border-edge bg-surface-2 px-3 font-mono text-sm text-ink"
        />
        <button
          type="button"
          className={buttonClass("primary", "md")}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            } catch {
              (document.getElementById(id) as HTMLInputElement | null)?.select();
            }
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <p aria-live="polite" className="sr-only">
        {copied ? "Link copied to the clipboard" : ""}
      </p>
    </div>
  );
}
