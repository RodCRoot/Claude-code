import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { paymentAttempts } from "@/db/schema";
import { getViewer } from "@/lib/auth/viewer";
import { checkoutReturnView } from "@/lib/billing/checkout";
import { capturePaypalOrder } from "@/lib/payments/paypal";

/**
 * Browser return from hosted checkout. It NEVER marks anything paid — query params are
 * attacker-controlled. It only sends the payer back to the invoice, which shows
 * "We're confirming your payment" until a verified webhook arrives.
 *
 * For PayPal, the buyer's approval must be captured server-side; we ask PayPal to capture,
 * but our records still change only when the verified PAYMENT.CAPTURE.* webhook arrives.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const attemptId = url.searchParams.get("attempt") ?? "";
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  let target = "/billing?checkout=unknown";
  try {
    const view = await db.transaction((tx) => checkoutReturnView(tx, viewer, attemptId));
    target = `/billing/invoices/${view.invoiceId}?checkout=returned&attempt=${view.attemptId}`;
    if (view.provider === "paypal" && view.state === "confirming") {
      const [a] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, view.attemptId));
      if (a?.providerRef) await capturePaypalOrder(a.providerRef, `capture:${a.idempotencyKey}`).catch(() => null);
    }
  } catch {
    // Unknown/foreign attempt: fall through to the billing home without revealing anything.
  }
  redirect(target);
}
