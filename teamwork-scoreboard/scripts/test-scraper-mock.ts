/**
 * End-to-end verification of the Zen Planner browser-sync machinery against a
 * LOCAL MOCK site. It proves the whole chain works — headless-Chrome login,
 * hash-route SPA, nested iframe, grid extraction, the idle-timeout
 * interstitial, mapping, dedupe and sync history — without touching the real
 * Zen Planner.
 *
 *   npm run test:scraper
 *
 * The mock is shaped after the real thing on purpose:
 *   - reports live behind a `#/main/iframe/...` hash route
 *   - the grid renders inside an iframe, wrapped in layout tables
 *   - the grid carries a navigation strip, an "Add" action row and a pager row
 *   - the first visit returns the "Reset Session" idle interstitial
 * Against the real site only the login selectors and report URLs differ, and
 * both are editable in Admin → Settings.
 *
 * Uses a throwaway database (.test-data/scraper.db); your real data/ is
 * untouched.
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

const PORT = 4855;

/** Wraps a grid the way Zen Planner does: layout table around a nested grid. */
function gridPage(headers: string[], rows: string[][], furniture = true): string {
  const cell = (t: string, tag = "td") => `<${tag}>${t}</${tag}>`;
  const grid = `
    <table id="report-grid">
      <thead><tr>${headers.map((h) => cell(h, "th")).join("")}</tr></thead>
      <tbody>
        ${rows.map((r) => `<tr>${r.map((c) => cell(c)).join("")}</tr>`).join("")}
        ${furniture ? `<tr><td colspan="${headers.length}">Add</td></tr>` : ""}
        ${furniture ? `<tr><td colspan="${headers.length}">Showing 1-${rows.length} of ${rows.length}</td></tr>` : ""}
      </tbody>
    </table>`;
  // A navigation strip and an outer layout table, both of which the extractor
  // has to see past.
  return `<html><body>
    <table id="nav"><tr><td>People</td><td>Calendar</td><td>Reports</td><td>Financial</td></tr></table>
    <table id="layout"><tr><td>${grid}</td></tr></table>
  </body></html>`;
}

const MEMBER_HEADERS = ["Name", "Start Date", "Program"];
const MEMBER_ROWS = [
  ["Mock Athlete One", "2026-07-01", "High School Performance"],
  ["Mock Athlete Two", "7/15/2026", "Adult Training"],
];

const ATTENDANCE_HEADERS = ["Name", "Date", "Status"];
const ATTENDANCE_ROWS = [
  ["Mock Athlete One", "2026-09-02", "Attended"],
  ["Mock Athlete One", "2026-09-04", "Reserved"], // RSVP only — must NOT count
  ["Mock Athlete Two", "2026-09-03", "Attended"],
  ["Mock Athlete Two", "2026-09-05", "Cancelled"], // must NOT count
];

/** Served once per path, to exercise the idle-timeout recovery. */
const timedOutAlready = new Set<string>();

const server = http.createServer((req, res) => {
  const url = (req.url ?? "").split("?")[0];
  const html = (body: string) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  };

  if (url === "/login") {
    html(`<html><body>
      <form method="POST" action="/do-login">
        <input name="username" type="email" />
        <input name="password" type="password" />
        <button type="submit">Sign in</button>
      </form></body></html>`);
  } else if (url === "/do-login") {
    res.writeHead(302, { location: "/studio", "set-cookie": "mocksession=1; Path=/" });
    res.end();
  } else if (url === "/studio" || url === "/studio/index.html") {
    // Hash-route shell: reads the fragment and mounts the report in an iframe,
    // exactly the pattern that defeats a top-level-only selector search.
    html(`<html><body><h1>Studio</h1><div id="main"></div>
      <script>
        var frag = location.hash.replace(/^#/, "");
        var src = frag ? frag.replace(/^\\/main\\/iframe/, "") : "/grid/members";
        var f = document.createElement("iframe");
        f.setAttribute("src", src);
        f.setAttribute("width", "1000"); f.setAttribute("height", "600");
        document.getElementById("main").appendChild(f);
      </script></body></html>`);
  } else if (url === "/grid/members" || url === "/grid/attendance") {
    if (!timedOutAlready.has(url)) {
      timedOutAlready.add(url);
      // Zen Planner's idle interstitial. Not a logout — a button restores it.
      html(`<html><body>
        <h2>It looks like you've left us...</h2>
        <a href="${url}">Reset Session</a>
      </body></html>`);
      return;
    }
    html(
      url === "/grid/members"
        ? gridPage(MEMBER_HEADERS, MEMBER_ROWS)
        : gridPage(ATTENDANCE_HEADERS, ATTENDANCE_ROWS)
    );
  } else if (url === "/grid/empty") {
    html(gridPage(["Name", "Effective Date", "Drop Reason"], [], false));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

async function main() {
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  const base = `http://localhost:${PORT}`;

  // Import AFTER env is set so the throwaway DB is used.
  const { setSetting } = await import("../src/lib/settings");
  const { runSync } = await import("../src/lib/connectors");
  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");

  setSetting("zen_login_config", {
    loginUrl: `${base}/login`,
    userSelector: 'input[name="username"]',
    passSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successSelector: "h1",
  });
  setSetting("zen_scrape_jobs", [
    {
      name: "Mock Members",
      entity: "athletes",
      // Hash route, like the real reports.
      url: `${base}/studio/index.html#/main/iframe/grid/members`,
      mode: "table",
      mappingName: "Mock Members",
      enabled: true,
    },
    {
      name: "Mock Attendance",
      entity: "attendance",
      url: `${base}/studio/index.html#/main/iframe/grid/attendance`,
      mode: "table",
      mappingName: "Mock Attendance",
      enabled: true,
    },
  ]);

  console.log("Run 1 (fresh import through the grid reader)…");
  const r1 = await runSync("zen_planner", "manual");
  console.log(" ", r1.ok ? "OK" : "FAILED", "-", r1.message);

  console.log("Run 2 (dedupe — nothing new)…");
  const r2 = await runSync("zen_planner", "manual");
  console.log(" ", r2.ok ? "OK" : "FAILED", "-", r2.message);

  const athletes = db.all<{ name: string; start_date: string }>(
    sql`SELECT name, start_date FROM athletes ORDER BY id`
  );
  const attendance = db.all<{ date: string; status: string }>(
    sql`SELECT date, status FROM attendance ORDER BY date`
  );
  const runs = db.all<{ status: string; records_processed: number; message: string }>(
    sql`SELECT status, records_processed, message FROM sync_runs ORDER BY id`
  );
  console.log("Athletes imported:", athletes);
  console.log("Attendance imported:", attendance);
  console.log("Sync history:", runs.map((r) => `${r.status}/${r.records_processed}`).join(" "));

  // An empty report must read as empty, not as a broken URL.
  console.log("\nRun 3 (empty report — a normal nil return, not a failure)…");
  setSetting("zen_scrape_jobs", [
    {
      name: "Mock Cancellations",
      entity: "cancellations",
      url: `${base}/studio/index.html#/main/iframe/grid/empty`,
      mode: "table",
      mappingName: "Mock Cancellations",
      enabled: true,
    },
  ]);
  const r3 = await runSync("zen_planner", "manual");
  console.log(" ", r3.ok ? "OK" : "reported failure", "-", r3.message);

  const checks: [string, boolean][] = [
    ["run 1 succeeded", r1.ok],
    ["run 2 succeeded", r2.ok],
    ["both athletes imported from the grid", athletes.length === 2],
    ["dates normalized (7/15/2026 → 2026-07-15)", athletes[1]?.start_date === "2026-07-15"],
    ["grid furniture excluded (no 'Add' row imported)", !athletes.some((a) => a.name === "Add")],
    // Each job must load its OWN report. Navigating between two fragments of
    // the same page is a same-document navigation, so without a forced reload
    // every job after the first scrapes the first job's grid.
    [
      "each job read its own report, not the previous job's grid",
      !/could not map required field/.test(r1.message),
    ],
    // Four attendance rows in the report, only two are real check-ins.
    ["RSVP'd and cancelled rows not counted as check-ins", attendance.length === 2],
    ["only attended rows stored", attendance.every((a) => a.status === "attended")],
    ["second run imported nothing new (dedupe)", runs[1]?.records_processed === 0],
    ["empty report succeeds rather than failing the sync", r3.ok],
    ["empty report explained as empty", /empty/i.test(r3.message)],
    ["empty report not blamed on a bad URL", !/no report grid found/i.test(r3.message)],
  ];

  console.log("");
  let pass = true;
  for (const [label, ok] of checks) {
    console.log(` ${ok ? "✔" : "✘"} ${label}`);
    if (!ok) pass = false;
  }
  console.log(
    pass
      ? "\n✔ Zen Planner grid sync verified end-to-end (login → hash route → iframe → " +
          "idle interstitial → grid → import → dedupe)."
      : "\n✘ VERIFICATION FAILED"
  );
  server.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
