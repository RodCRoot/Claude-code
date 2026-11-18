"use client";

import { useEffect } from "react";

/**
 * Client side of the athlete logger's service worker (public/training-sw.js).
 * - `TrainingOfflineSetup` (training/_components/offline-setup.tsx, athlete's own Today page)
 *   registers the worker with scope /training/today and asks it to save today's workout.
 * - `TrainingOfflineGuard` (every signed-in page): purges saved training data that belongs to
 *   someone else, and removes the worker entirely for non-athlete sessions (coaches, guardians,
 *   the shared weight-room tablet).
 * - `TrainingOfflinePurge` (login page, weight room) and `purgeTrainingOffline()` (sign-out):
 *   remove everything.
 */
export const TRAINING_SW_URL = "/training-sw.js";
export const TRAINING_SW_SCOPE = "/training/today";
export const TRAINING_CACHE_PREFIX = "tw-training-";
const DATA_CACHE = `${TRAINING_CACHE_PREFIX}data-v1`;
const OWNER_KEY = "/__tw-training/owner";

export const hasCaches = () => typeof window !== "undefined" && "caches" in window;
export const hasSw = () => typeof navigator !== "undefined" && "serviceWorker" in navigator;
/** Service workers are only used in production builds (dev serves unhashed, changing assets). */
export const swEnabled = () => process.env.NODE_ENV === "production";

async function trainingRegistrations(): Promise<ServiceWorkerRegistration[]> {
  if (!hasSw()) return [];
  const regs = await navigator.serviceWorker.getRegistrations();
  return regs.filter((r) => new URL(r.scope).pathname.startsWith(TRAINING_SW_SCOPE));
}

/** Delete every saved training cache (and, by default, unregister the training service worker). */
export async function purgeTrainingOffline({ unregister = true }: { unregister?: boolean } = {}) {
  try {
    if (hasCaches()) {
      for (const k of await caches.keys()) if (k.startsWith(TRAINING_CACHE_PREFIX)) await caches.delete(k);
    }
    if (unregister) for (const r of await trainingRegistrations()) await r.unregister();
  } catch {
    /* storage blocked: nothing saved either */
  }
}

async function cachedOwner(): Promise<string | null> {
  if (!hasCaches() || !(await caches.has(DATA_CACHE))) return null;
  const r = await caches.match(OWNER_KEY, { cacheName: DATA_CACHE });
  return r ? r.text() : null;
}

export function activeWorker(reg: ServiceWorkerRegistration): Promise<ServiceWorker> {
  if (reg.active) return Promise.resolve(reg.active);
  const sw = reg.installing ?? reg.waiting;
  return new Promise((resolve, reject) => {
    if (!sw) return reject(new Error("no worker"));
    sw.addEventListener("statechange", () => {
      if (sw.state === "activated") resolve(sw);
      if (sw.state === "redundant") reject(new Error("worker redundant"));
    });
  });
}

export function askWorker(sw: ServiceWorker, msg: Record<string, unknown>, timeoutMs = 20_000): Promise<{ ok: boolean; data?: boolean; shell?: boolean }> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve({ ok: false }), timeoutMs);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(e.data as { ok: boolean });
    };
    sw.postMessage(msg, [ch.port2]);
  });
}

export function TrainingOfflineGuard({ owner }: { owner: string | null }) {
  useEffect(() => {
    void (async () => {
      try {
        if (!hasCaches()) return;
        const keys = (await caches.keys()).filter((k) => k.startsWith(TRAINING_CACHE_PREFIX));
        const regs = await trainingRegistrations();
        if (!keys.length && !regs.length) return;
        if (!owner) return await purgeTrainingOffline({ unregister: true });
        const current = await cachedOwner();
        if (current && current !== owner) await purgeTrainingOffline({ unregister: false });
      } catch {
        /* ignore */
      }
    })();
  }, [owner]);
  return null;
}

export function TrainingOfflinePurge() {
  useEffect(() => {
    void purgeTrainingOffline();
  }, []);
  return null;
}
