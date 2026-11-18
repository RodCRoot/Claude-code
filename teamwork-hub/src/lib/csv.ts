/**
 * Spreadsheet formula-injection guard for CSV exports (Papa.unparse `escapeFormulae`).
 * Cells starting with = + - @ TAB or CR are prefixed with ' by Papa, except plain numbers
 * (e.g. "-12.5") so numeric columns stay machine-readable.
 */
export const CSV_FORMULA_ESCAPE = /^(?![-+]?\d+(\.\d+)?$)[=+\-@\t\r]/;
