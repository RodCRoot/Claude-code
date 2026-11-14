import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isFileHref } from "@/components/ui";

/**
 * next/link prefetches whatever it points at once the link is on screen. Pointed at a CSV export
 * that ran the whole report again on every report page view and left a request that never settled
 * (the page never reached "network idle"; the a11y sweep waited out its 10 second cap on every
 * report page). Downloads and route handlers must be plain anchors.
 */
describe("links to files and route handlers are never prefetched", () => {
  it("ButtonLink treats downloads and /api/ hrefs as plain anchors", () => {
    expect(isFileHref("/api/reports/attendance?from=2026-01-01&to=2026-01-31", true)).toBe(true);
    expect(isFileHref("/api/reports/attendance")).toBe(true);
    expect(isFileHref("/somewhere/file.csv", "")).toBe(true);
    expect(isFileHref("/reports")).toBe(false);
    expect(isFileHref("/reports", false)).toBe(false);
  });

  it("no <Link> in the app points at an /api/ route", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".tsx")) {
          const src = fs.readFileSync(p, "utf8");
          for (const m of src.matchAll(/<Link\b[^>]*?href=\{?[`"']\/api\//g)) offenders.push(`${path.relative(process.cwd(), p)}: ${m[0].slice(0, 80)}`);
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});
