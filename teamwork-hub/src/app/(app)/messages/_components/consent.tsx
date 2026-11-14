import { Badge } from "@/components/ui";
import type { PreferencesView } from "@/lib/messaging/preferences";
import { SOURCE_LABEL } from "@/lib/messaging/preferences";
import { fmt } from "@/lib/time";

export function ConsentBadge({ label, consent }: { label: string; consent: string | null | undefined }) {
  const c = consent ?? "unknown";
  return (
    <Badge variant={c === "opted_in" ? "green" : c === "opted_out" ? "red" : "neutral"}>
      {label}: {c === "opted_in" ? "on" : c === "opted_out" ? "off" : "not chosen"}
    </Badge>
  );
}

const hm = (t: string | null) => (t ? t.slice(0, 5) : null);

/** Consent / quiet-hours history, newest first. Every row has its source and timestamp. */
export function ConsentHistory({ history }: { history: PreferencesView["history"] }) {
  if (!history.length) return <p className="text-sm text-ink-3">No changes recorded yet.</p>;
  return (
    <ol className="space-y-1.5 text-sm">
      {history.map((h) => (
        <li key={h.id} className="border-l-2 border-edge pl-3">
          <span className="font-medium">
            {h.kind === "quiet_hours"
              ? `Quiet hours → ${h.quietStartLocal && h.quietEndLocal ? `${hm(h.quietStartLocal)}–${hm(h.quietEndLocal)}` : "facility default"}`
              : `${h.channel === "email" ? "Email" : "Text messages"} → ${h.consent === "opted_in" ? "on" : h.consent === "opted_out" ? "off" : "not chosen"}`}
          </span>{" "}
          <span className="text-xs text-ink-3">
            {SOURCE_LABEL[h.source] ?? h.source}
            {h.detail ? ` — ${h.detail}` : ""}
            {h.actorName ? ` · ${h.actorName}` : ""} · {fmt(h.createdAt)}
          </span>
        </li>
      ))}
    </ol>
  );
}
