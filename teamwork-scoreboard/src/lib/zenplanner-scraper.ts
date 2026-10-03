/**
 * Zen Planner scheduled browser sync ("chrome inquiry").
 *
 * Zen Planner offers no public API without a partner key, so this connector
 * drives a headless Chromium session instead: it signs in to the Zen Planner
 * web app with the owner's staff credentials, opens each configured report,
 * captures the CSV export, and feeds it through the same mapping + import
 * pipeline as manual uploads (with dedupe, so re-running never double-counts).
 *
 * Everything variable lives in Admin → Settings:
 *   - `zen_login_config`: login URL and form selectors
 *   - `zen_scrape_jobs`:  one entry per report (page URL or direct CSV URL,
 *     export-link selector, target entity, saved mapping name, enabled flag)
 * Credentials come only from env (ZEN_PLANNER_EMAIL / ZEN_PLANNER_PASSWORD).
 *
 * Honesty rules carried over from the connector framework:
 *   - jobs ship DISABLED with placeholder URLs — nothing pretends to sync
 *     until the owner points a job at a real report and enables it
 *   - any failure records the exact reason in sync history and saves a
 *     screenshot + HTML snapshot under data/debug/ for troubleshooting
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "@/db";
import { importMappings } from "@/db/schema";
import { getSetting } from "./settings";
import { parseCsv, commitImport, IMPORT_TARGETS } from "./importer";
import { EXTRACT_TABLES_JS, scoreTable, tablesToCsv } from "./zp-table";
import { autoMapHeaders, missingRequired } from "./import-mapping";

export interface ZenLoginConfig {
  loginUrl: string;
  userSelector: string;
  passSelector: string;
  submitSelector: string;
  /** Optional selector that must appear after a successful login. */
  successSelector?: string;
}

export interface ZenScrapeJob {
  name: string;
  /** Import target: leads | athletes | attendance | payments | kpi_values */
  entity: string;
  /** Report page to open. */
  url?: string;
  /**
   * How to get the data off the page:
   *   "table"  — read the report grid out of the page (the default, and the
   *              only one that works on a stock Zen Planner report)
   *   "export" — click `exportSelector` and capture the download
   *   "csv"    — fetch `csvUrl` directly with the logged-in session
   * Left unset, it is inferred from whichever of the fields below is present.
   */
  mode?: "table" | "export" | "csv";
  /** Selector of the CSV/export link on the report page (mode "export"). */
  exportSelector?: string;
  /** Direct CSV URL fetched with the logged-in session cookies (mode "csv"). */
  csvUrl?: string;
  /** Saved mapping (Data → Import) to apply; auto-mapping is the fallback. */
  mappingName?: string;
  enabled?: boolean;
}

/** Which strategy a job uses, filling in the default for older saved jobs. */
export function jobMode(job: ZenScrapeJob): "table" | "export" | "csv" {
  if (job.mode) return job.mode;
  if (job.csvUrl) return "csv";
  if (job.exportSelector) return "export";
  return "table";
}

export interface ScrapeOutcome {
  processed: number;
  rejected: number;
  skipped: number;
  message: string;
}

const DEBUG_DIR = path.join(
  path.dirname(process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "teamwork.db")),
  "debug"
);

/** Saved mapping by name, else best-effort auto-map of CSV headers to fields. */
function resolveMapping(job: ZenScrapeJob, headers: string[]): Record<string, string> {
  const target = IMPORT_TARGETS[job.entity];
  if (!target) throw new Error(`Job "${job.name}": unknown entity "${job.entity}"`);

  const saved = db
    .select()
    .from(importMappings)
    .all()
    .find(
      (m) =>
        m.targetEntity === job.entity &&
        (m.name === (job.mappingName ?? job.name) || m.name === job.name)
    );
  let mapping: Record<string, string> = {};
  if (saved) {
    try {
      mapping = JSON.parse(saved.mapping);
    } catch {
      mapping = {};
    }
    // keep only columns that exist in this CSV
    mapping = Object.fromEntries(
      Object.entries(mapping).filter(([col]) => headers.includes(col))
    );
  }
  if (Object.keys(mapping).length === 0) {
    mapping = autoMapHeaders(target.fields, headers);
  }
  const missing = missingRequired(target.fields, mapping);
  if (missing.length > 0) {
    throw new Error(
      `Job "${job.name}": could not map required field(s) ${missing
        .map((f) => f.label)
        .join(", ")}. CSV headers were: ${headers.join(", ")}. ` +
        `Fix: run this export once through Data → Import and save the mapping as "${
          job.mappingName ?? job.name
        }".`
    );
  }
  return mapping;
}

/**
 * Find an export control anywhere on the page, including inside iframes.
 * Zen Planner renders each report in a nested frame, so the top-level
 * document usually does not contain the export link at all. Returns the first
 * visible match across all frames, or null.
 */
async function findExportControl(
  page: import("playwright").Page,
  selector: string
): Promise<import("playwright").Locator | null> {
  // Poll briefly: the report grid mounts asynchronously after the frame loads.
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const frame of page.frames()) {
      try {
        const loc = frame.locator(selector).first();
        if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
      } catch {
        // frame detached mid-search (SPA navigation) — just try the next one
      }
    }
    await page.waitForTimeout(2000);
  }
  return null;
}

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 300).toLowerCase();
  return head.includes("<html") || head.includes("<!doctype html");
}

/**
 * Clear Zen Planner's idle-timeout interstitial if it is showing.
 *
 * After a quiet spell Zen Planner replaces the page with "It looks like you've
 * left us..." and a Reset Session button. That is not a logout — clicking the
 * button restores the session — but a sync that ignored it would scrape the
 * interstitial instead of the report.
 */
async function clearSessionTimeout(page: import("playwright").Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const reset = frame
        .locator('input[value*="Reset Session" i], button:has-text("Reset Session"), a:has-text("Reset Session")')
        .first();
      if ((await reset.count()) > 0 && (await reset.isVisible())) {
        await reset.click({ timeout: 10000 });
        await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => undefined);
        return true;
      }
    } catch {
      // frame detached mid-check — nothing to clear there
    }
  }
  return false;
}

/**
 * Open a report URL, forcing a real document load.
 *
 * Zen Planner addresses every report as a fragment on one page
 * (`index.html#/main/iframe/...`). Navigating from one fragment to another is a
 * same-document navigation: the browser fires no load, the SPA may not re-route,
 * and the iframe keeps showing the previous report. A sync that ignored this
 * would scrape the first report once per job and import it under every job's
 * mapping. Hopping through about:blank guarantees the next goto is a fresh load
 * with the fragment present at bootstrap.
 */
async function gotoReport(page: import("playwright").Page, url: string): Promise<void> {
  const current = page.url();
  const sameDocument =
    current.split("#")[0] === url.split("#")[0] && current !== url;
  if (sameDocument) {
    await page.goto("about:blank", { timeout: 30000 }).catch(() => undefined);
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => undefined);
}

/**
 * Read the report grid out of whichever frame is showing it.
 *
 * Zen Planner is a hash-route SPA that renders each report in a nested frame,
 * and the frame mounts after the outer page settles, so this polls. Every frame
 * is scored and the best grid across all of them wins — the outer document
 * usually holds only navigation chrome.
 */
async function extractGridCsv(
  page: import("playwright").Page,
  job: ZenScrapeJob
): Promise<{ csv: string; dataRows: number; headers: string[] }> {
  let lastError = "no frame produced a report grid";
  const frameErrors = new Set<string>();
  for (let attempt = 0; attempt < 6; attempt++) {
    let bestTables: string[][][] = [];
    let bestScore = 0;
    for (const frame of page.frames()) {
      try {
        const tables = (await frame.evaluate(EXTRACT_TABLES_JS)) as string[][][];
        const score = Math.max(0, ...tables.map(scoreTable));
        if (score > bestScore) {
          bestScore = score;
          bestTables = tables;
        }
      } catch (e) {
        // A frame may be detached mid-read or cross-origin, which is normal and
        // not worth failing over. But keep the reason: if NO frame yields a
        // grid, these errors are the only explanation available.
        frameErrors.add(e instanceof Error ? e.message.split("\n")[0] : String(e));
      }
    }
    if (bestScore > 0) {
      try {
        return tablesToCsv(bestTables);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    // Maybe we are staring at the idle interstitial rather than the report.
    if (await clearSessionTimeout(page)) continue;
    await page.waitForTimeout(2000);
  }
  throw new Error(
    `${lastError}. Checked ${page.frames().length} frame(s) on ${job.url}. ` +
      "Open that URL yourself and confirm the report renders as a table of rows." +
      (frameErrors.size > 0 ? ` Frame errors: ${[...frameErrors].join("; ")}` : "")
  );
}

export async function runZenPlannerScrape(): Promise<ScrapeOutcome> {
  const email = process.env.ZEN_PLANNER_EMAIL;
  const password = process.env.ZEN_PLANNER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Not configured: set ZEN_PLANNER_EMAIL and ZEN_PLANNER_PASSWORD to enable the browser sync."
    );
  }
  const jobs = (getSetting("zen_scrape_jobs") as unknown as ZenScrapeJob[]).filter(
    (j) => j.enabled
  );
  if (jobs.length === 0) {
    throw new Error(
      "Not configured: no enabled Zen Planner scrape jobs. Open Admin → Settings → " +
        "“Zen Planner scrape jobs”, point each job at a real report URL, and set enabled: true."
    );
  }
  const cfg = getSetting("zen_login_config") as unknown as ZenLoginConfig;

  // Playwright is imported lazily so the app runs fine on hosts without it.
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error(
      "Playwright is not installed on this server. Run `npm install` and " +
        "`npx playwright install --with-deps chromium` (see README → Zen Planner browser sync)."
    );
  }

  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZEN_CHROMIUM_PATH || undefined,
  });
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();

    // ---- Login -----------------------------------------------------------
    try {
      await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.locator(cfg.userSelector).first().fill(email, { timeout: 15000 });
      await page.locator(cfg.passSelector).first().fill(password, { timeout: 15000 });
      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => undefined),
        page.locator(cfg.submitSelector).first().click({ timeout: 15000 }),
      ]);
      if (cfg.successSelector) {
        await page.waitForSelector(cfg.successSelector, { timeout: 20000 });
      } else {
        // Heuristic: a still-visible password field means the login was refused.
        const stillThere = await page
          .locator(cfg.passSelector)
          .first()
          .isVisible()
          .catch(() => false);
        if (stillThere) {
          throw new Error(
            "login appears to have been refused (password field still visible — check credentials, " +
              "or set zen_login_config.successSelector for a more reliable check)"
          );
        }
      }
    } catch (e) {
      const shot = path.join(DEBUG_DIR, `zen-login-${stamp}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      throw new Error(
        `Zen Planner login failed: ${e instanceof Error ? e.message : e}. ` +
          `Screenshot saved to ${shot}`
      );
    }

    // ---- Jobs ------------------------------------------------------------
    let processed = 0;
    let rejected = 0;
    let skipped = 0;
    const jobNotes: string[] = [];
    const jobErrors: string[] = [];

    for (const job of jobs) {
      try {
        let csvText: string;
        const mode = jobMode(job);
        if (mode === "csv") {
          if (!job.csvUrl) throw new Error('mode "csv" needs a csvUrl');
          const resp = await ctx.request.get(job.csvUrl, { timeout: 60000 });
          if (!resp.ok()) {
            throw new Error(`CSV URL returned HTTP ${resp.status()}`);
          }
          csvText = await resp.text();
          if (looksLikeHtml(csvText)) {
            throw new Error(
              "CSV URL returned an HTML page instead of CSV — the session may lack access " +
                "to that report, or the URL is a report page rather than an export link"
            );
          }
        } else if (mode === "table") {
          if (!job.url) throw new Error('mode "table" needs a url');
          await gotoReport(page, job.url);
          await clearSessionTimeout(page);
          const grid = await extractGridCsv(page, job);
          if (grid.dataRows === 0) {
            // A real report that is simply empty for its date range. Not a
            // failure, and nothing to import.
            jobNotes.push(`${job.name}: report is empty for its date range (0 rows)`);
            continue;
          }
          csvText = grid.csv;
          jobNotes.push(`${job.name}: read ${grid.dataRows} row(s) from the report grid`);
        } else if (job.url && job.exportSelector) {
          // Zen Planner is a hash-route SPA that renders each report inside an
          // iframe, so the export link usually is NOT in the top-level page.
          // Load the route properly, then search every frame for it.
          await gotoReport(page, job.url);
          await clearSessionTimeout(page);
          const target = await findExportControl(page, job.exportSelector);
          if (!target) {
            const frameCount = page.frames().length;
            throw new Error(
              `export control "${job.exportSelector}" not found in any of the ` +
                `${frameCount} frame(s) on that page. Open the report yourself, ` +
                "right-click the export link → Inspect, and put a matching selector " +
                "in the job's exportSelector (Admin → Settings → Zen Planner scrape jobs)."
            );
          }
          const [download] = await Promise.all([
            // download events surface on the page regardless of which frame fired them
            page.waitForEvent("download", { timeout: 60000 }),
            target.click({ timeout: 15000 }),
          ]);
          const file = await download.path();
          csvText = fs.readFileSync(file, "utf8");
        } else {
          throw new Error('job needs a url (mode "table"/"export") or a csvUrl (mode "csv")');
        }

        const parsed = parseCsv(csvText);
        if (parsed.rows.length === 0) {
          jobNotes.push(`${job.name}: 0 rows`);
          continue;
        }
        const mapping = resolveMapping(job, parsed.headers);
        const outcome = commitImport(job.entity, parsed, mapping, null, { dedupe: true });
        processed += outcome.processed;
        rejected += outcome.rejected;
        skipped += outcome.skipped;
        jobNotes.push(
          `${job.name}: ${outcome.processed} new, ${outcome.skipped} already known` +
            (outcome.rejected ? `, ${outcome.rejected} rejected (${outcome.errors[0] ?? ""})` : "")
        );
      } catch (e) {
        const safe = job.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
        const shot = path.join(DEBUG_DIR, `zen-${safe}-${stamp}.png`);
        await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        jobErrors.push(
          `${job.name}: ${e instanceof Error ? e.message : e} (screenshot: ${shot})`
        );
      }
    }

    const message = [...jobNotes, ...jobErrors.map((e) => `FAILED — ${e}`)].join(" · ");
    if (jobErrors.length === jobs.length) {
      // every job failed → surface as a sync error, not a hollow success
      throw new Error(message);
    }
    return { processed, rejected, skipped, message };
  } finally {
    await browser.close();
  }
}
