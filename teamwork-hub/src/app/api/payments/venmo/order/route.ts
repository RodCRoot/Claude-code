import { z } from "zod";
import { db } from "@/db";
import { createVenmoOrder } from "@/lib/billing/venmo";
import { billingJson, withBillingViewer } from "../../http";

const body = z.object({ invoiceId: z.string().uuid() });

/** Creates the PayPal order for the Venmo SDK button. Amount = invoice balance, computed server-side. */
export async function POST(req: Request) {
  return withBillingViewer(req, async (v) => {
    const { invoiceId } = body.parse(await req.json().catch(() => ({})));
    const r = await createVenmoOrder(db, v, { invoiceId });
    if (!r.ok) return billingJson({ error: r.error, notConfigured: !!r.notConfigured }, r.notConfigured ? 503 : 422);
    return billingJson({ orderID: r.orderId, attemptId: r.attemptId });
  });
}
