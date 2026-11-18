"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { buttonClass } from "@/components/ui";

/** A caption draft with a Copy button. Falls back to selecting the text when the clipboard is unavailable. */
export function CopyCaption({ id, label, text }: { id: string; label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-semibold text-ink-2">
          {label}
        </label>
        <button
          type="button"
          className={buttonClass("secondary", "sm")}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(ref.current?.value ?? text);
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            } catch {
              ref.current?.select();
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
          <span className="sr-only">: {label} caption</span>
        </button>
      </div>
      <textarea ref={ref} id={id} readOnly rows={3} defaultValue={text} className="mt-1 w-full rounded-md border border-edge bg-surface-2 px-3 py-2 text-sm text-ink" />
      <p aria-live="polite" className="sr-only">
        {copied ? "Caption copied to the clipboard" : ""}
      </p>
    </div>
  );
}

/** Add or replace a win photo. Posts to the auth-checked route handler, then refreshes the page. */
export function PhotoUpload({ winId, has }: { winId: string; has: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const id = `win-photo-${winId}`;
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const file = (form.elements.namedItem("photo") as HTMLInputElement | null)?.files?.[0];
        if (!file) return setState({ busy: false, error: "Choose a photo first.", done: false });
        if (file.size > 5 * 1024 * 1024) return setState({ busy: false, error: "Photos can be up to 5 MB.", done: false });
        setState({ busy: true, error: null, done: false });
        try {
          const body = new FormData();
          body.set("photo", file);
          const res = await fetch(`/api/wins/${winId}/photo`, { method: "POST", body, credentials: "same-origin" });
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) return setState({ busy: false, error: data.error ?? "The photo could not be saved. Please try again.", done: false });
          form.reset();
          setState({ busy: false, error: null, done: true });
          router.refresh();
        } catch {
          setState({ busy: false, error: "The photo could not be sent. Check your connection and try again.", done: false });
        }
      }}
    >
      <label htmlFor={id} className="block text-sm font-medium text-ink-2">
        {has ? "Replace the photo" : "Add a photo (optional)"}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} name="photo" type="file" accept="image/jpeg,image/png" aria-describedby={`${id}-hint`} className="min-h-11 max-w-full text-sm file:mr-3 file:min-h-10 file:rounded-md file:border file:border-edge file:bg-surface-2 file:px-3 file:text-sm file:font-semibold" />
        <button type="submit" disabled={state.busy} className={buttonClass("secondary", "sm")}>
          {state.busy ? "Sending…" : "Upload"}
        </button>
      </div>
      <p id={`${id}-hint`} className="text-xs text-ink-3">
        JPEG or PNG, up to 5 MB. Location and camera details are removed. Staff approve a photo before anyone outside your family sees it.
      </p>
      {state.error ? (
        <p role="alert" className="text-sm font-medium text-bad">
          {state.error}
        </p>
      ) : null}
      {state.done ? (
        <p role="status" className="text-sm text-ok">
          Photo saved. It is waiting for staff approval.
        </p>
      ) : null}
    </form>
  );
}
