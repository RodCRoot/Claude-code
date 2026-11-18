"use client";

import { useSyncExternalStore } from "react";

/**
 * Save-and-retry queue for finished On Your Own sessions (same idea as the training set queue).
 * - Persists ONLY ids, counts and numbers in localStorage: no names, titles or notes.
 * - Every entry carries a clientKey made when the athlete taps Finish. The server is idempotent on
 *   it, so a retry after a lost response never creates a second completion.
 * - Retries with backoff (1s to 30s), when the browser comes back online, and on the next visit.
 * There is no service worker here: a page that is already open keeps working without a
 * connection, but opening a session for the first time needs one.
 */
export type QueuedCompletion = {
  clientKey: string;
  athleteId: string;
  sessionId: string;
  stepsDone: number;
  durationMinutes: number | null;
  rpe: number | null;
  /** ISO time the athlete finished. */
  completedAt: string;
};

export type AnywhereQueueState = { items: QueuedCompletion[]; syncing: boolean; lastError: string | null; saved: string[]; rejected: { clientKey: string; error: string }[] };

export const ANYWHERE_QUEUE_KEY = "tw.anywhere.queue.v1";
const EMPTY: AnywhereQueueState = { items: [], syncing: false, lastError: null, saved: [], rejected: [] };
const UUID = /^[0-9a-f-]{36}$/i;

let state: AnywhereQueueState = EMPTY;
let loaded = false;
let attempts = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function sanitize(x: unknown): QueuedCompletion | null {
  const o = x as Partial<QueuedCompletion>;
  if (!o || typeof o.clientKey !== "string" || typeof o.athleteId !== "string" || typeof o.sessionId !== "string" || !UUID.test(o.athleteId) || !UUID.test(o.sessionId)) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { clientKey: o.clientKey, athleteId: o.athleteId, sessionId: o.sessionId, stepsDone: n(o.stepsDone) ?? 0, durationMinutes: n(o.durationMinutes), rpe: n(o.rpe), completedAt: typeof o.completedAt === "string" ? o.completedAt : new Date().toISOString() };
}

function emit() {
  for (const l of listeners) l();
}
function set(next: Partial<AnywhereQueueState>) {
  state = { ...state, ...next };
  emit();
}

function persist() {
  try {
    if (state.items.length) window.localStorage.setItem(ANYWHERE_QUEUE_KEY, JSON.stringify({ v: 1, items: state.items }));
    else window.localStorage.removeItem(ANYWHERE_QUEUE_KEY);
  } catch {
    /* storage unavailable: the queue still works in memory */
  }
}

function ensureLoaded() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(ANYWHERE_QUEUE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { items?: unknown[] }) : null;
    state = { ...state, items: (parsed?.items ?? []).map(sanitize).filter(Boolean).slice(0, 50) as QueuedCompletion[] };
  } catch {
    /* ignore */
  }
  window.addEventListener("online", () => {
    attempts = 0;
    void flushAnywhere();
  });
  if (state.items.length) setTimeout(() => schedule(300), 0);
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushAnywhere();
  }, ms);
}

export function newClientKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

/** Save a finished session on the device and try to send it right away. */
export function enqueueCompletion(entry: QueuedCompletion) {
  ensureLoaded();
  set({ items: [...state.items.filter((i) => i.clientKey !== entry.clientKey), entry] });
  persist();
  attempts = 0;
  return flushAnywhere();
}

export function flushAnywhere(): Promise<void> {
  ensureLoaded();
  if (inFlight) return inFlight;
  if (!state.items.length) return Promise.resolve();
  const run = async () => {
    const batch = state.items.slice(0, 25);
    set({ syncing: true });
    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("offline");
      const res = await fetch("/api/anywhere/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: batch }), cache: "no-store" });
      if (res.status === 401) throw new Error("signed-out");
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const { results } = (await res.json()) as { results: { clientKey: string; status: string; error?: string }[] };
      const done = new Set<string>();
      const saved = [...state.saved];
      const rejected = [...state.rejected];
      let retry = false;
      for (const r of results) {
        if (r.status === "error") {
          retry = true;
          continue;
        }
        done.add(r.clientKey);
        if (r.status === "rejected") rejected.push({ clientKey: r.clientKey, error: r.error ?? "Not saved" });
        else saved.push(r.clientKey);
      }
      set({ items: state.items.filter((i) => !done.has(i.clientKey)), saved: saved.slice(-50), rejected: rejected.slice(-10), lastError: retry ? "The server had a problem. Trying again." : null });
      persist();
      if (retry) throw new Error("retry");
      attempts = 0;
      if (state.items.length) schedule(0);
    } catch (e) {
      const msg = (e as Error).message;
      attempts++;
      set({
        lastError:
          msg === "signed-out"
            ? "You are signed out. Sign in again and it will send. It is saved on this device."
            : msg === "retry"
              ? state.lastError
              : "No connection right now. It is saved on this device and will send when you are back online.",
      });
      schedule(Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)));
    } finally {
      set({ syncing: false });
    }
  };
  const p: Promise<void> = run().finally(() => {
    if (inFlight === p) inFlight = null;
  });
  inFlight = p;
  return p;
}

function subscribe(l: () => void) {
  ensureLoaded();
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAnywhereQueue(): AnywhereQueueState {
  return useSyncExternalStore(
    subscribe,
    () => {
      ensureLoaded();
      return state;
    },
    () => EMPTY,
  );
}
