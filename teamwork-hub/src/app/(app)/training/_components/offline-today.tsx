"use client";

import { useCallback, useEffect, useState } from "react";
import type { OfflineTodayPayload } from "@/lib/training/offline";
import { fmtDate } from "@/lib/time";
import { Callout, StatusBadge } from "@/components/ui";
import { CompleteWorkoutForm, SyncBanner, useRefreshOnSync, WorkoutItemsList } from "./workout-logger";

type State =
  | { status: "loading" }
  | { status: "ok"; data: OfflineTodayPayload; fromCache: boolean; savedAt: string | null }
  | { status: "none"; offline: boolean; error: string };

/**
 * The athlete logger rendered from /api/training/today — live when online, from the service
 * worker's saved copy when not. Logging goes through the same localStorage queue as the main page.
 */
async function fetchToday(): Promise<State> {
  try {
    const res = await fetch("/api/training/today", { cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as Partial<OfflineTodayPayload> & { error?: string };
    if (!res.ok || !Array.isArray(body.workouts)) {
      return { status: "none", offline: res.headers.get("X-Training-Offline") === "none", error: body.error ?? `Error ${res.status}` };
    }
    return { status: "ok", data: body as OfflineTodayPayload, fromCache: res.headers.get("X-Training-Offline") === "cache", savedAt: res.headers.get("X-Training-Offline-Saved") };
  } catch {
    return { status: "none", offline: true, error: "You're offline and today's workout isn't saved on this device." };
  }
}

export function OfflineToday() {
  const [s, setS] = useState<State>({ status: "loading" });
  useEffect(() => {
    let live = true;
    void fetchToday().then((r) => live && setS(r));
    return () => {
      live = false;
    };
  }, []);
  // After the queue syncs, reload (the service worker also refreshes its saved copy from this fetch).
  useRefreshOnSync(useCallback(() => void fetchToday().then(setS), []));

  if (s.status === "loading") return <p className="text-sm text-ink-3">Loading today&apos;s workout…</p>;
  if (s.status === "none") {
    return (
      <Callout tone="warn" title={s.offline ? "Offline" : "Not available"}>
        {s.error}
      </Callout>
    );
  }
  const { data } = s;
  return (
    <div className="space-y-4">
      {s.fromCache ? (
        <Callout tone="info" title="Offline copy">
          <span data-testid="offline-copy">Saved</span> {s.savedAt ? new Date(s.savedAt).toLocaleString() : "earlier"} for {fmtDate(data.date)}. Sets you log are kept on this device and sync when you&apos;re back online.
        </Callout>
      ) : null}
      <SyncBanner />
      {data.workouts.length === 0 ? <p className="text-sm text-ink-3">No workout scheduled for {fmtDate(data.date)}.</p> : null}
      {data.workouts.map((w) => (
        <article key={w.id} aria-labelledby={`w-${w.id}`} className="space-y-3">
          <header className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge bg-surface p-4">
            <div className="min-w-0">
              <div className="kicker">Session</div>
              <h2 id={`w-${w.id}`} className="text-xl leading-tight font-extrabold">
                {w.title}
              </h2>
            </div>
            <StatusBadge status={w.status} />
          </header>
          {w.status === "skipped" ? <Callout tone="warn">This workout is marked skipped. Reopen it online before logging.</Callout> : null}
          <WorkoutItemsList workout={w} canLog showLinks={!s.fromCache} />
          {w.status !== "skipped" ? <CompleteWorkoutForm workout={w} /> : null}
        </article>
      ))}
    </div>
  );
}
