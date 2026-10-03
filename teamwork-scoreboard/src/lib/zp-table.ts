/**
 * Turning a Zen Planner report grid into CSV.
 *
 * Zen Planner has no API and its report grids have no reliable "export CSV"
 * link, so the browser sync reads the grid out of the page itself. These are the
 * pure parts of that job — picking the real data table out of a page full of
 * layout tables, tidying the rows, and emitting CSV — kept separate from
 * Playwright so they can be tested against captured markup.
 *
 * Zen Planner renders each report inside an iframe, and the surrounding
 * ColdFusion pages nest tables for layout, so neither "the first table" nor
 * "the biggest table" is good enough on its own. See chooseReportTable.
 */

/** A table as scraped from the page: a list of rows, each a list of cell texts. */
export type ScrapedTable = string[][];

/**
 * Browser-side expression that returns every table in the document as a 2-D
 * array of cell text. Evaluated with Playwright's `frame.evaluate`.
 *
 * Deliberately a string of plain ES5-ish JavaScript rather than a TypeScript
 * function. Handing `evaluate` a compiled function does not work here: the
 * build step rewrites function declarations to call its own `__name` helper to
 * preserve names, and that helper does not exist inside the page, so the
 * injected code dies with "__name is not defined". A string passes through the
 * bundler untouched. It is covered end-to-end by `npm run test:scraper`, which
 * runs it in a real browser against Zen-Planner-shaped markup.
 *
 * Only direct-descendant rows and cells are collected, so a layout table that
 * wraps the real grid does not swallow the grid's rows into its own.
 */
export const EXTRACT_TABLES_JS = `(function () {
  var clean = function (s) {
    return String(s == null ? "" : s).replace(/\\s+/g, " ").trim();
  };
  var slice = function (list) { return Array.prototype.slice.call(list); };
  return slice(document.querySelectorAll("table")).map(function (table) {
    var rows = slice(table.querySelectorAll(
      ":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr"
    ));
    return rows.map(function (tr) {
      return slice(tr.querySelectorAll(":scope > td, :scope > th")).map(function (cell) {
        return clean(cell.innerText || cell.textContent || "");
      });
    });
  });
})()`;

/** The most common row width in a table — the shape of its actual data rows. */
function modalWidth(table: ScrapedTable): number {
  const counts = new Map<number, number>();
  for (const row of table) {
    counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [width, count] of counts) {
    // On a tie prefer the wider shape: a grid with one stray short row should
    // still be measured by its real columns.
    if (count > bestCount || (count === bestCount && width > best)) {
      best = width;
      bestCount = count;
    }
  }
  return best;
}

/**
 * How much this table looks like a report grid. Zero means "not a data table".
 *
 * A report grid is more than one column wide and has at least one row of that
 * width. Layout tables are typically a single cell wide, which is what rules
 * them out.
 *
 * A header-only grid — an empty report, which is a perfectly normal thing for
 * "cancellations this week" to be — scores low but not zero. Scoring it zero
 * would make an empty report indistinguishable from a wrong URL, and the two
 * need very different answers. A populated grid always out-scores a navigation
 * strip, since it has more rows to multiply by.
 */
export function scoreTable(table: ScrapedTable): number {
  const width = modalWidth(table);
  if (width < 2) return 0;
  const nonEmpty = table.filter(
    (r) => r.length === width && r.some((c) => c !== "")
  ).length;
  if (nonEmpty < 1) return 0;
  return nonEmpty * width;
}

/**
 * Pick the report grid out of every table on the page.
 *
 * Returns null when nothing on the page looks like a data table, which the
 * caller reports as a failure rather than importing an empty file.
 */
export function chooseReportTable(tables: string[][][]): ScrapedTable | null {
  let best: ScrapedTable | null = null;
  let bestScore = 0;
  for (const table of tables) {
    const score = scoreTable(table);
    if (score > bestScore) {
      best = table;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Drop the grid furniture and square the rows off.
 *
 * Zen Planner grids carry pager rows, totals rows, and "Add" action rows that
 * span the full width as a single cell. Those have a different width from the
 * data rows, which is how they are recognised. Repeated header rows (the grid
 * reprints them when it paginates) are dropped too, since a second copy would
 * otherwise import as a record.
 */
export function cleanReportRows(table: ScrapedTable): ScrapedTable {
  const width = modalWidth(table);
  if (width < 2) return [];

  const squared = table.filter((row) => row.length === width);
  const out: ScrapedTable = [];
  let header: string | null = null;

  for (const row of squared) {
    if (row.every((cell) => cell === "")) continue;
    const key = row.join("\u0000").toLowerCase();
    if (header === null) {
      header = key;
      out.push(row);
      continue;
    }
    if (key === header) continue; // reprinted header on a later page
    out.push(row);
  }
  return out;
}

/** One CSV field, quoted only when it has to be. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180 CSV. */
export function rowsToCsv(rows: ScrapedTable): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\n");
}

export interface TableCsvResult {
  csv: string;
  /** Data rows, not counting the header. */
  dataRows: number;
  headers: string[];
}

/**
 * Whole pipeline: every table on a page in, one report CSV out.
 *
 * Throws only when the page has no grid at all, which means the URL or the
 * report is wrong. A grid with a header and no rows is NOT an error — "no
 * cancellations this week" is a normal answer — so that returns dataRows: 0 and
 * lets the caller record it as a quiet nil return. Treating it as a failure
 * would put a red FAILED next to a perfectly healthy sync and teach the owner
 * to ignore the ones that matter.
 */
export function tablesToCsv(tables: string[][][]): TableCsvResult {
  const chosen = chooseReportTable(tables);
  if (!chosen) {
    throw new Error(
      `no report grid found on the page (saw ${tables.length} table(s), none with ` +
        "a row of two or more columns). If the report renders as a chart or a list " +
        "rather than a grid, point the job at a tabular version."
    );
  }
  const rows = cleanReportRows(chosen);
  if (rows.length < 2) {
    return { csv: "", dataRows: 0, headers: rows[0] ?? [] };
  }
  return { csv: rowsToCsv(rows), dataRows: rows.length - 1, headers: rows[0] };
}
