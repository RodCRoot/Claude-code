/**
 * End-to-end check of the cancellation import against a realistic Zen Planner
 * drop export — including the duplicate rows the real report produces (one per
 * dropped membership, so multi-membership families repeat).
 *   npm run test:cancellations
 * Uses a throwaway database; real data is untouched.
 */
import fs from "node:fs";
import path from "node:path";

process.env.DATABASE_PATH = path.resolve(".test-data", "cancellations.db");
fs.rmSync(path.dirname(process.env.DATABASE_PATH), { recursive: true, force: true });

// Mirrors the columns of Rod's drop bookmark:
// effectiveDate, dropReason, CancelledBy, subDropReason, firstName, lastName, status
const CSV = [
  "effectiveDate,dropReason,CancelledBy,subDropReason,firstName,lastName,status",
  // same person, three membership rows, one real cancellation
  "8/5/2026,Distance Too Far,Erin Parks,Moved to Ohio,Avery,Cole,Inactive",
  "8/5/2026,Distance Too Far,Erin Parks,Moved to Ohio,Avery,Cole,Inactive",
  "8/7/2026,Distance Too Far,Erin Parks,Moved to Ohio,Avery,Cole,Inactive",
  // ghosted — the number Rod can act on
  "8/9/2026,Administrative Drop,System,,Blake,Reed,Inactive",
  "8/9/2026,Administrative Drop,System,,Blake,Reed,Inactive",
  // college kid leaving
  "8/12/2026,Other,Rod Root,Leaving for college,Carter,Stone,Inactive",
  // unrecognized reason -> "other", not guessed
  "8/14/2026,Switched to another program,Rod Root,,Dana,Frost,Inactive",
].join("\n");

async function main() {
  const { parseCsv, commitImport } = await import("../src/lib/importer");
  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");

  const parsed = parseCsv(CSV);
  const mapping: Record<string, string> = {
    effectiveDate: "effective_date",
    dropReason: "drop_reason",
    CancelledBy: "cancelled_by",
    subDropReason: "sub_drop_reason",
    firstName: "first_name",
    lastName: "last_name",
    status: "status",
  };

  console.log(`Raw rows in export: ${parsed.rows.length}`);
  const first = commitImport("cancellations", parsed, mapping, null, { dedupe: true });
  console.log(`Import 1 → ${first.processed} counted, ${first.skipped} duplicates merged`);

  // Re-import the identical file: a nightly sync must not double-count.
  const second = commitImport("cancellations", parsed, mapping, null, { dedupe: true });
  console.log(`Import 2 (same file again) → ${second.processed} counted, ${second.skipped} skipped`);

  const rows = db.all<{
    athlete_name: string;
    effective_date: string;
    category: string;
    duplicate_rows: number;
  }>(sql`SELECT athlete_name, effective_date, category, duplicate_rows
         FROM cancellations ORDER BY effective_date`);
  console.log("\nDeduped cancellations:");
  for (const r of rows) {
    console.log(
      `  ${r.athlete_name.padEnd(14)} ${r.effective_date}  ${r.category.padEnd(12)} (${r.duplicate_rows} raw row${r.duplicate_rows > 1 ? "s" : ""})`
    );
  }

  const byCat = db.all<{ category: string; n: number }>(
    sql`SELECT category, COUNT(*) AS n FROM cancellations GROUP BY category ORDER BY category`
  );
  console.log("\nBy category:", byCat.map((c) => `${c.category}=${c.n}`).join("  "));

  const counts = Object.fromEntries(byCat.map((c) => [c.category, c.n]));
  const pass =
    parsed.rows.length === 7 &&
    first.processed === 4 && // 4 real people out of 7 raw rows
    first.skipped === 3 &&
    second.processed === 0 && // re-import adds nothing
    rows.length === 4 &&
    counts.expected === 2 && // Avery (moved) + Carter (college)
    counts.controllable === 1 && // Blake (ghosted)
    counts.other === 1; // Dana — unrecognized, not guessed

  console.log(
    pass
      ? "\n✔ Dedupe + reason classification verified end-to-end."
      : "\n✘ VERIFICATION FAILED"
  );
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
