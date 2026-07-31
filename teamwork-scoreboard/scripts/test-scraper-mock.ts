/**
 * End-to-end verification of the Zen Planner browser-sync machinery against a
 * LOCAL MOCK site (login form → report page → CSV download). It proves the
 * whole chain works — headless-Chrome login, export capture, mapping, dedupe,
 * sync history — without touching the real Zen Planner.
 *
 *   npm run test:scraper
 *
 * Uses a throwaway database (.test-data/scraper.db); your real data/ is
 * untouched. On the real site, only the login selectors and report URLs
 * differ — both are editable in Admin → Settings.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

process.env.DATABASE_PATH = path.resolve(".test-data", "scraper.db");
process.env.ZEN_PLANNER_EMAIL = "mock@example.com";
process.env.ZEN_PLANNER_PASSWORD = "mock-password";
if (!process.env.ZEN_CHROMIUM_PATH && fs.existsSync("/opt/pw-browsers/chromium")) {
  process.env.ZEN_CHROMIUM_PATH = "/opt/pw-browsers/chromium";
}
fs.rmSync(path.dirname(process.env.DATABASE_PATH), { recursive: true, force: true });

const CSV = [
  "Athlete Name,Start Date,Program",
  "Mock Athlete One,2026-07-01,High School Performance",
  "Mock Athlete Two,7/15/2026,Adult Training",
].join("\n");

const PORT = 4855;
const server = http.createServer((req, res) => {
  if (req.url === "/login") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body>
      <form method="POST" action="/do-login">
        <input name="username" type="email" />
        <input name="password" type="password" />
        <button type="submit">Sign in</button>
      </form></body></html>`);
  } else if (req.url === "/do-login") {
    res.writeHead(302, { location: "/dashboard", "set-cookie": "mocksession=1; Path=/" });
    res.end();
  } else if (req.url === "/dashboard") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><h1>Dashboard</h1><a href="/report">Members report</a></body></html>`);
  } else if (req.url === "/report") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><h1>Members</h1><a href="/report.csv" download>Export CSV</a></body></html>`);
  } else if (req.url === "/report.csv") {
    res.writeHead(200, {
      "content-type": "text/csv",
      "content-disposition": 'attachment; filename="members.csv"',
    });
    res.end(CSV);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

async function main() {
  await new Promise<void>((resolve) => server.listen(PORT, resolve));

  // Import AFTER env is set so the throwaway DB is used.
  const { setSetting } = await import("../src/lib/settings");
  const { runSync } = await import("../src/lib/connectors");
  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");

  setSetting("zen_login_config", {
    loginUrl: `http://localhost:${PORT}/login`,
    userSelector: 'input[name="username"]',
    passSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successSelector: "h1",
  });
  setSetting("zen_scrape_jobs", [
    {
      name: "Mock Members",
      entity: "athletes",
      url: `http://localhost:${PORT}/report`,
      exportSelector: 'a:has-text("Export CSV")',
      mappingName: "Mock Members",
      enabled: true,
    },
  ]);

  console.log("Run 1 (fresh import)…");
  const r1 = await runSync("zen_planner", "manual");
  console.log(" ", r1.ok ? "OK" : "FAILED", "-", r1.message);

  console.log("Run 2 (dedupe — nothing new)…");
  const r2 = await runSync("zen_planner", "manual");
  console.log(" ", r2.ok ? "OK" : "FAILED", "-", r2.message);

  const athletes = db.all<{ name: string; start_date: string }>(
    sql`SELECT name, start_date FROM athletes ORDER BY id`
  );
  const runs = db.all<{ status: string; records_processed: number; message: string }>(
    sql`SELECT status, records_processed, message FROM sync_runs ORDER BY id`
  );
  console.log("Athletes imported:", athletes);
  console.log("Sync history:", runs);

  const pass =
    r1.ok &&
    r2.ok &&
    athletes.length === 2 &&
    athletes[1].start_date === "2026-07-15" &&
    runs[0]?.records_processed === 2 &&
    runs[1]?.records_processed === 0;
  console.log(pass ? "\n✔ Browser-sync machinery verified end-to-end." : "\n✘ VERIFICATION FAILED");
  server.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
