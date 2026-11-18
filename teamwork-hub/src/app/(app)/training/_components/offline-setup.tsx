"use client";

import { useEffect, useState } from "react";
import { activeWorker, askWorker, hasCaches, hasSw, purgeTrainingOffline, swEnabled, TRAINING_SW_SCOPE, TRAINING_SW_URL } from "@/components/training-offline";
import { useSetQueue } from "./set-queue";

/**
 * On the athlete's own Today page: register the scoped service worker and have it save today's
 * workout (minimized JSON) + the offline shell. After each queue sync the saved copy is refreshed
 * so an offline reload shows the synced sets.
 */
export function TrainingOfflineSetup({ owner }: { owner: string }) {
  const { lastSyncedAt } = useSetQueue();
  const [state, setState] = useState<"idle" | "ready" | "failed">("idle");
  const [worker, setWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!hasSw() || !hasCaches() || !window.isSecureContext) return;
      if (!swEnabled()) {
        await purgeTrainingOffline();
        return;
      }
      try {
        const reg = await navigator.serviceWorker.register(TRAINING_SW_URL, { scope: TRAINING_SW_SCOPE, updateViaCache: "none" });
        const sw = await activeWorker(reg);
        const r = await askWorker(sw, { type: "owner", key: owner });
        if (cancelled) return;
        setWorker(sw);
        setState(r.ok && r.data && r.shell ? "ready" : "failed");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [owner]);

  useEffect(() => {
    if (worker && lastSyncedAt) void askWorker(worker, { type: "refresh" });
  }, [worker, lastSyncedAt]);

  if (state === "idle") return null;
  return (
    <p className="text-xs text-ink-3" data-testid="offline-ready" data-state={state}>
      {state === "ready" ? "Today's workout is saved on this device — it opens even without a connection." : "Couldn't save today's workout for offline use on this device."}
    </p>
  );
}
