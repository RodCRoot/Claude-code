import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { Badge, Tabs } from "@/components/ui";
import type { AnywhereSession } from "@/lib/anywhere/sessions";
import { CATEGORY_LABEL, EQUIPMENT_LABEL, SAFETY_COPY } from "@/lib/anywhere/common";
import { requireViewer } from "@/lib/auth/viewer";
import { isStaff } from "@/lib/authz/policy";
import { familyAthletes, type FamilyChild } from "@/lib/dashboards";

/** Athlete and guardian pages: the viewer plus the linked athlete they are looking at. Staff use the coach pages. */
export async function familyContext(selected: string | undefined) {
  const v = await requireViewer();
  if (isStaff(v)) redirect("/training/anywhere");
  const children = await familyAthletes(db, v);
  // Only athletes this viewer is linked to are ever selectable; an unknown id falls back to the first.
  const child: FamilyChild | undefined = children.find((c) => c.athleteId === selected) ?? children[0];
  return { v, children, child, isAthlete: v.role === "athlete" };
}

export function AthletePills({ base, items, current, extra }: { base: string; items: FamilyChild[]; current?: string; extra?: string }) {
  if (items.length < 2) return null;
  return (
    <nav aria-label="Choose athlete" className="flex flex-wrap gap-2">
      {items.map((c) => {
        const on = c.athleteId === current;
        return (
          <Link
            key={c.athleteId}
            href={`${base}?athlete=${c.athleteId}${extra ?? ""}`}
            aria-current={on ? "true" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold ${on ? "bg-[#4fc3f7] text-[#0b1a2e]" : "bg-white/10 text-white ring-1 ring-white/25 hover:bg-white/20"}`}
          >
            {c.name.split(" ")[0]}
          </Link>
        );
      })}
    </nav>
  );
}

export function AnywhereTabs({ current, athleteId, multi }: { current: "sessions" | "season"; athleteId?: string; multi: boolean }) {
  const q = multi && athleteId ? `?athlete=${athleteId}` : "";
  return (
    <Tabs
      current={current}
      tabs={[
        { key: "sessions", href: `/anywhere${q}`, label: "Sessions" },
        { key: "season", href: `/anywhere/season${q}`, label: "My Season" },
      ]}
    />
  );
}

/** The same line on every session, everywhere it is shown. */
export function SafetyNote({ className }: { className?: string }) {
  return (
    <p role="note" className={`rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm font-semibold text-ink ${className ?? ""}`}>
      {SAFETY_COPY}
    </p>
  );
}

export function SessionMeta({ s }: { s: Pick<AnywhereSession, "category" | "durationMinutes" | "equipment" | "isSample"> }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant="brand">{CATEGORY_LABEL[s.category]}</Badge>
      <Badge>{s.durationMinutes} min</Badge>
      {s.equipment.map((e) => (
        <Badge key={e}>{EQUIPMENT_LABEL[e]}</Badge>
      ))}
      {s.isSample ? <Badge variant="yellow">Sample</Badge> : null}
    </span>
  );
}
