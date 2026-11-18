import { z } from "zod";
import { db } from "@/db";
import { captureVenmoOrder } from "@/lib/billing/venmo";
import { billingJson, withBillingViewer } from "../../http";

const body = z.object({ attemptId: z.string().uuid(), orderID: z.string().min(1).max(64) });

/**
 * Captures the approved order server-side. The response reports what the server recorded from PayPal's
 * capture result; the browser never decides that an invoice is paid.
 */
export async function POST(req: Request) {
  return withBillingViewer(req, async (v) => {
    const { attemptId, orderID } = body.parse(await req.json().catch(() => ({})));
    const r = await captureVenmoOrder(db, v, { attemptId, orderId: orderID });
    return billingJson(r, r.ok ? 200 : 422);
  });
}
