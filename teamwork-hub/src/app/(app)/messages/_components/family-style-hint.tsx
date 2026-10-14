"use client";

import { useEffect, useState } from "react";
import { hasEmDash, lintFamilyMessage, replaceEmDashes, type LintIssue } from "@/lib/messaging/family-style";

/**
 * Live family-style check under a composer textarea (by element id). Blocking issues (em dashes,
 * card numbers, SSNs, security codes) are also enforced on the server; this shows them as you type
 * and offers to replace em dashes in place.
 */
export function FamilyStyleHint({ target, subjectTarget, requireSignOff = true }: { target: string; subjectTarget?: string; requireSignOff?: boolean }) {
  const [issues, setIssues] = useState<LintIssue[]>([]);
  const [dash, setDash] = useState(false);

  useEffect(() => {
    const els = [document.getElementById(target), subjectTarget ? document.getElementById(subjectTarget) : null].filter(Boolean) as (HTMLTextAreaElement | HTMLInputElement)[];
    if (!els.length) return;
    const run = () => {
      const body = (document.getElementById(target) as HTMLTextAreaElement | null)?.value ?? "";
      const subject = subjectTarget ? ((document.getElementById(subjectTarget) as HTMLInputElement | null)?.value ?? "") : "";
      const text = `${subject ? `${subject}\n` : ""}${body}`;
      setIssues(body.trim() || subject.trim() ? lintFamilyMessage(text, { requireSignOff }).issues : []);
      setDash(hasEmDash(text));
    };
    run();
    els.forEach((el) => el.addEventListener("input", run));
    const form = els[0].form;
    form?.addEventListener("reset", () => setTimeout(run, 0));
    return () => els.forEach((el) => el.removeEventListener("input", run));
  }, [target, subjectTarget, requireSignOff]);

  const fix = (style: "comma" | "period") => {
    for (const id of [target, subjectTarget]) {
      if (!id) continue;
      const el = document.getElementById(id) as HTMLTextAreaElement | HTMLInputElement | null;
      if (!el) continue;
      el.value = replaceEmDashes(el.value, style);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  if (!issues.length) return null;
  return (
    <div role="status" aria-live="polite" className="space-y-1.5 rounded-lg border border-edge bg-surface-2 p-3 text-sm">
      <p className="font-medium">Family message check</p>
      <ul className="space-y-1">
        {issues.map((i, k) => (
          <li key={`${i.code}-${k}`} className={i.severity === "block" ? "text-bad" : "text-ink-2"}>
            <span className="font-semibold">{i.severity === "block" ? "Must fix: " : "Suggestion: "}</span>
            {i.message}
          </li>
        ))}
      </ul>
      {dash ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" onClick={() => fix("comma")} className="min-h-10 rounded-lg border border-edge bg-surface px-3 text-sm font-medium hover:bg-surface-2">
            Replace dashes with commas
          </button>
          <button type="button" onClick={() => fix("period")} className="min-h-10 rounded-lg border border-edge bg-surface px-3 text-sm font-medium hover:bg-surface-2">
            Replace dashes with periods
          </button>
        </div>
      ) : null}
    </div>
  );
}
