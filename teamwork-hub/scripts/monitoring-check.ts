/**
 * Sends one synthetic, redaction-test error through the monitoring pipeline so you can confirm
 * SENTRY_DSN works (and that secrets / emails / health fields arrive redacted).
 *
 *   SENTRY_DSN=... pnpm monitoring:check
 *
 * Exits 1 when SENTRY_DSN is not set. Contains no real data.
 */
import "dotenv/config";
import { flushMonitoring, initMonitoring, reportError } from "../src/lib/observability";

async function main() {
  if (!process.env.SENTRY_DSN) {
    console.error("monitoring-check: SENTRY_DSN is not set — nothing to test.");
    process.exit(1);
  }
  const sentry = await initMonitoring("worker");
  if (!sentry) process.exit(1);
  reportError(new Error("Monitoring check (synthetic) for test.user@example.test"), {
    where: "monitoring-check",
    password: "should-be-redacted",
    wellness: { soreness: 9 },
    note: "synthetic",
  });
  await flushMonitoring(5000);
  console.log("monitoring-check: event sent. Look for 'Monitoring check (synthetic)' in Sentry → Issues.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
