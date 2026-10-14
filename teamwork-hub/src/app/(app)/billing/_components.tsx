import { redirect } from "next/navigation";
import { Badge, StatusBadge, Tabs } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { can, type Viewer } from "@/lib/authz/policy";
import { formatMoney } from "@/lib/money";

/** Billing is for billing staff and payers. Coaches and kiosks never see it. */
export async function requireBillingViewer(): Promise<Viewer> {
  const v = await requireViewer();
  if (!["owner", "admin", "operations", "guardian", "athlete"].includes(v.role)) redirect("/denied");
  return v;
}

export async function requireBillingStaff(): Promise<Viewer> {
  const v = await requireViewer();
  if (!can(v, "billing.view_all")) redirect("/denied");
  return v;
}

export function BillingTabs({ current, staff }: { current: string; staff: boolean }) {
  const tabs = staff
    ? [
        { key: "overview", href: "/billing", label: "Overview" },
        { key: "memberships", href: "/billing/memberships", label: "Memberships" },
        { key: "invoices", href: "/billing/invoices", label: "Invoices" },
        { key: "products", href: "/billing/products", label: "Products" },
        { key: "pos", href: "/billing/pos", label: "Point of sale" },
        { key: "reconciliation", href: "/billing/reconciliation", label: "Reconciliation" },
        { key: "providers", href: "/billing/providers", label: "Payment providers" },
      ]
    : [
        { key: "overview", href: "/billing", label: "Overview" },
        { key: "invoices", href: "/billing/invoices", label: "Invoices & receipts" },
        { key: "memberships", href: "/billing/memberships", label: "Memberships" },
      ];
  return <Tabs tabs={tabs} current={current} />;
}

export function Money({ minor, currency = "USD", className }: { minor: number | null | undefined; currency?: string; className?: string }) {
  return <span className={`tabular ${className ?? ""}`}>{formatMoney(minor, currency)}</span>;
}

/** Provider-verified (webhook-confirmed) vs staff-attested (offline, recorded by a person). */
export function VerificationBadge({ verification }: { verification: string }) {
  return verification === "provider_verified" ? (
    <Badge variant="green" title="Confirmed by a signature-verified provider webhook">
      Provider verified
    </Badge>
  ) : (
    <Badge variant="yellow" title="Recorded by staff (cash, check, personal Venmo/Zelle). Not verified by a payment provider.">
      Staff attested
    </Badge>
  );
}

export function TxnStatus({ status }: { status: string }) {
  if (status === "pending") return <Badge variant="yellow" title="Money in flight (e.g. bank debit). Not counted as paid.">Pending — not settled</Badge>;
  return <StatusBadge status={status} />;
}

export function InvoiceStatus({ status, dueDate, today }: { status: string; dueDate: string | null; today: string }) {
  if (status === "open" && dueDate && dueDate < today) return <StatusBadge status="past_due" />;
  return <StatusBadge status={status} />;
}

export const PROVIDER_LABEL: Record<string, string> = {
  stripe: "Stripe",
  paypal: "PayPal",
  venmo: "Venmo (PayPal)",
  manual: "Offline",
  external_zenplanner: "Zen Planner (external)",
  none: "No billing",
};

export const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  check: "Check",
  personal_venmo: "Personal Venmo",
  zelle: "Zelle",
  other: "Other offline",
  card: "Card",
  us_bank_account: "Bank (ACH)",
  offline_refund: "Offline refund",
  echeck: "eCheck",
};
