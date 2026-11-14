"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type PaypalButtons = { isEligible(): boolean; render(el: HTMLElement): Promise<void> };
type PaypalNamespace = {
  Buttons(options: {
    fundingSource: string;
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }) => Promise<void>;
    onCancel?: () => void;
    onError?: (err: unknown) => void;
  }): PaypalButtons;
  FUNDING: { VENMO: string };
};

type CaptureResult = { ok: boolean; state: "paid" | "pending" | "failed" | "confirming"; message: string; error?: string };

const SCRIPT_ID = "paypal-js-sdk";

/**
 * Renders PayPal's Venmo button (PayPal JavaScript SDK, `enable-funding=venmo`). The order is created and
 * captured by our server; this component only relays the order id and shows what the server recorded.
 * It never marks anything paid by itself.
 */
export function VenmoButton({ clientId, sandbox, invoiceId }: { clientId: string; sandbox: boolean; invoiceId: string }) {
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const attemptId = useRef<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "ineligible" | "error" | "working" | "done">("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const render = () => {
      const paypal = (window as unknown as { paypal?: PaypalNamespace }).paypal;
      if (!paypal || !container.current || cancelled) return;
      const button = paypal.Buttons({
        fundingSource: paypal.FUNDING.VENMO,
        createOrder: async () => {
          setMessage(null);
          const res = await fetch("/api/payments/venmo/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoiceId }) });
          const json = (await res.json().catch(() => ({}))) as { orderID?: string; attemptId?: string; error?: string };
          if (!res.ok || !json.orderID) {
            setMessage(json.error ?? "Could not start the Venmo payment. Nothing was charged.");
            throw new Error(json.error ?? "order failed");
          }
          attemptId.current = json.attemptId ?? null;
          return json.orderID;
        },
        onApprove: async (data) => {
          setState("working");
          const res = await fetch("/api/payments/venmo/capture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attemptId: attemptId.current, orderID: data.orderID }) });
          const json = (await res.json().catch(() => ({}))) as CaptureResult;
          setMessage(json.message ?? json.error ?? "We're confirming your payment with PayPal.");
          setState("done");
          router.refresh();
        },
        onCancel: () => setMessage("Venmo payment cancelled. Nothing was charged."),
        onError: () => {
          setState((s) => (s === "working" ? "done" : "ready"));
          setMessage((m) => m ?? "Venmo couldn't complete the payment. Nothing was marked paid; try again or pay another way.");
        },
      });
      if (!button.isEligible()) {
        setState("ineligible");
        return;
      }
      setState("ready");
      void button.render(container.current);
    };

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if ((window as unknown as { paypal?: unknown }).paypal) render();
    else if (existing) existing.addEventListener("load", render, { once: true });
    else {
      const params = new URLSearchParams({ "client-id": clientId, currency: "USD", intent: "capture", components: "buttons", "enable-funding": "venmo" });
      if (sandbox) params.set("buyer-country", "US"); // sandbox-only parameter for simulating a US buyer
      const s = document.createElement("script");
      s.id = SCRIPT_ID;
      s.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
      s.async = true;
      s.addEventListener("load", render, { once: true });
      s.addEventListener("error", () => !cancelled && setState("error"), { once: true });
      document.head.appendChild(s);
    }
    return () => {
      cancelled = true;
    };
  }, [clientId, sandbox, invoiceId, router]);

  return (
    <div className="space-y-3">
      <div ref={container} aria-label="Venmo payment button" />
      {state === "loading" ? <p className="text-sm text-ink-3">Loading Venmo…</p> : null}
      {state === "ineligible" ? (
        <p className="text-sm">Venmo isn&apos;t available on this device or browser. It needs the Venmo app (iOS Safari or Android Chrome) or a desktop QR scan, a US account, and USD. Pay another way from the invoice.</p>
      ) : null}
      {state === "error" ? <p className="text-sm">Couldn&apos;t load PayPal&apos;s Venmo button. Nothing was charged.</p> : null}
      {state === "working" ? <p className="text-sm">Confirming with PayPal…</p> : null}
      {message ? <p role="status" className="text-sm font-medium">{message}</p> : null}
    </div>
  );
}
