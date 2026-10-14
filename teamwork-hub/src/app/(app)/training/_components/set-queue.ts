"use client";

import { useSyncExternalStore } from "react";

/**
 * Offline-tolerant set-log queue.
 * - Persists ONLY ids and numbers (no names, notes, or other personal details) in localStorage.
 * - Every entry carries a clientMutationId; the server upserts idempotently, so retries
 *   after lost responses never duplicate rows.
 * - Retries with exponential backoff (1s → 30s) and immediately when the browser comes online.
 */
export type QueuedSet = {
  clientMutationId: string;
  workoutItemId: string;
  setIndex: number;
  side: "both" | "left" | "right";
  reps: number | null;
  load: number | null;
  loadUnit: "lb" | "kg" | null;
  rpe: number | null;
  durationS: number | null;
  distanceM: number | null;
  completed: boolean;
  loggedAt: number;
};

export type QueueState = {
  items: QueuedSet[];
  syncing: boolean;
  lastError: string | null;
  nextRetryAt: number | null;
  rejected: { setIndex: number; workoutItemId: string; error: string }[];
  lastSyncedAt: number | null;
  /**
   * Entries the server confirmed (applied or duplicate) in this page session, newest per slot.
   * Memory only (never persisted). Lets the logger show "saved" right away instead of depending
   * on the follow-up page refresh, which can be slow or superseded.
   */
  confirmed: QueuedSet[];
};

export const QUEUE_KEY = "tw.training.queue.v1";
const EMPTY: QueueState = { items: [], syncing: false, lastError: null, nextRetryAt: null, rejected: [], lastSyncedAt: null, confirmed: [] };
const slotOf = (q: Pick<QueuedSet, "workoutItemId" | "setIndex" | "side">) => `${q.workoutItemId}:${q.setIndex}:${q.side}`;

let state: QueueState = EMPTY;
let loaded = false;
let via: "athlete_app" | "weight_room" = "athlete_app";
let attempts = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function sanitize(x: unknown): QueuedSet | null {
  const o = x as Partial<QueuedSet>;
  if (!o || typeof o.clientMutationId !== "string" || typeof o.workoutItemId !== "string" || typeof o.setIndex !== "number") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    clientMutationId: o.clientMutationId,
    workoutItemId: o.workoutItemId,
    setIndex: o.setIndex,
    side: o.side === "left" || o.side === "right" ? o.side : "both",
    reps: n(o.reps),
    load: n(o.load),
    loadUnit: o.loadUnit === "kg" ? "kg" : o.loadUnit === "lb" ? "lb" : null,
    rpe: n(o.rpe),
    durationS: n(o.durationS),
    distanceM: n(o.distanceM),
    completed: o.completed !== false,
    loggedAt: n(o.loggedAt) ?? Date.now(),
  };
}

function ensureLoaded() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { items?: unknown[] }) : null;
    const items = (parsed?.items ?? []).map(sanitize).filter(Boolean) as QueuedSet[];
    state = { ...state, items };
  } catch {
    /* storage unavailable: queue still works in memory */
  }
  window.addEventListener("online", () => flush());
  window.addEventListener("storage", (e) => {
    if (e.key !== QUEUE_KEY) return;
    loaded = false;
    ensureLoaded();
    emit();
  });
  if (state.items.length) setTimeout(() => schedule(500), 0);
}

function persist() {
  try {
    if (state.items.length) window.localStorage.setItem(QUEUE_KEY, JSON.stringify({ v: 1, items: state.items }));
    else window.localStorage.removeItem(QUEUE_KEY);
  } catch {
    /* ignore */
  }
}

function set(next: Partial<QueueState>) {
  state = { ...state, ...next };
  emit();
}
function emit() {
  for (const l of listeners) l();
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  set({ nextRetryAt: ms > 0 ? Date.now() + ms : null });
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, ms);
}

export function setQueueVia(v: "athlete_app" | "weight_room") {
  via = v;
}

export function newMutationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** Add (or replace the pending entry for the same set slot) and try to sync right away. */
export function enqueue(entry: Omit<QueuedSet, "clientMutationId" | "loggedAt">) {
  ensureLoaded();
  const m: QueuedSet = { ...entry, clientMutationId: newMutationId(), loggedAt: Date.now() };
  const items = state.items.filter((i) => !(i.workoutItemId === m.workoutItemId && i.setIndex === m.setIndex && i.side === m.side));
  items.push(m);
  set({ items });
  persist();
  attempts = 0;
  schedule(0);
  return m;
}

let inFlight: Promise<void> | null = null;

export function flush(): Promise<void> {
  ensureLoaded();
  if (inFlight) return inFlight;
  if (!state.items.length) return Promise.resolve();
  // `run` can settle synchronously (offline → throws before any await), so `inFlight` is cleared in
  // a `.finally` callback — always async — which runs after the assignment below. Clearing it inside
  // `run` would happen *before* the assignment and wedge the queue until the page reloads.
  const run = async () => {
    const batch = state.items.slice(0, 200);
    set({ syncing: true });
    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("offline");
      const res = await fetch("/api/training/sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ via, mutations: batch }),
        cache: "no-store",
      });
      if (res.status === 401) throw new Error("Signed out — sign in again to sync. Entries are kept on this device.");
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const { results } = (await res.json()) as { results: { clientMutationId: string; status: string; error?: string }[] };
      const done = new Set<string>();
      const rejected = [...state.rejected];
      const confirmed = new Map(state.confirmed.map((c) => [slotOf(c), c]));
      let retryable = false;
      for (const r of results) {
        if (r.status === "error") {
          retryable = true;
          continue;
        }
        done.add(r.clientMutationId);
        const q = batch.find((b) => b.clientMutationId === r.clientMutationId);
        if (r.status === "rejected") {
          if (q) rejected.push({ setIndex: q.setIndex, workoutItemId: q.workoutItemId, error: r.error ?? "Rejected" });
        } else if (q && (r.status === "applied" || r.status === "duplicate")) {
          confirmed.set(slotOf(q), q);
        }
      }
      set({
        items: state.items.filter((i) => !done.has(i.clientMutationId)),
        rejected: rejected.slice(-10),
        confirmed: [...confirmed.values()].slice(-300),
        lastError: retryable ? "Some entries hit a server error; retrying." : null,
        lastSyncedAt: Date.now(),
      });
      persist();
      if (retryable) throw new Error("retry");
      attempts = 0;
      if (state.items.length) schedule(0);
      else set({ nextRetryAt: null });
    } catch (e) {
      const msg = (e as Error).message;
      attempts++;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5));
      set({ lastError: msg === "offline" || msg === "Failed to fetch" || e instanceof TypeError ? "You're offline or the server is unreachable. Entries are saved on this device." : msg === "retry" ? state.lastError : msg });
      schedule(delay);
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

export function pendingCount(): number {
  ensureLoaded();
  return state.items.length;
}

export function retryNow() {
  attempts = 0;
  return flush();
}

/** Wipe all local training state (weight-room exit). */
export function clearQueue() {
  ensureLoaded();
  if (timer) clearTimeout(timer);
  timer = null;
  state = { ...EMPTY };
  persist();
  emit();
}

function subscribe(l: () => void) {
  ensureLoaded();
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSetQueue(): QueueState {
  return useSyncExternalStore(
    subscribe,
    () => {
      ensureLoaded();
      return state;
    },
    () => EMPTY,
  );
}
