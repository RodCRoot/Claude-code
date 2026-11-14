import { Badge, NotConfigured, Tabs, type BadgeVariant } from "@/components/ui";
import { can, type Viewer } from "@/lib/authz/policy";
import { emailConfig } from "@/lib/messaging/channels/email";
import { smsConfig } from "@/lib/messaging/channels/sms";
import { testRecipients } from "@/lib/messaging/channels/types";

export function StaffTabs({
  v,
  current,
}: {
  v: Viewer;
  current: "inbox" | "unmatched" | "campaigns" | "segments" | "templates" | "automations" | "outbox";
}) {
  const tabs = [{ key: "inbox", label: "Inbox", href: "/messages" }];
  if (can(v, "crm.manage")) {
    tabs.push({ key: "unmatched", label: "Unmatched replies", href: "/messages/unmatched" });
    tabs.push({ key: "campaigns", label: "Campaigns", href: "/messages/campaigns" });
    tabs.push({ key: "segments", label: "Segments", href: "/messages/segments" });
    tabs.push({ key: "templates", label: "Templates", href: "/messages/templates" });
    tabs.push({ key: "automations", label: "Automations", href: "/messages/automations" });
  }
  if (can(v, "settings.manage")) tabs.push({ key: "outbox", label: "Outbox", href: "/messages/outbox" });
  return <Tabs tabs={tabs} current={current} />;
}

const DELIVERY: Record<string, { label: string; variant: BadgeVariant }> = {
  queued: { label: "queued", variant: "yellow" },
  sent: { label: "sent", variant: "green" },
  delivered: { label: "delivered", variant: "green" },
  test_redirected: { label: "test redirect", variant: "blue" },
  failed: { label: "failed", variant: "red" },
  not_configured: { label: "not configured", variant: "neutral" },
  suppressed: { label: "suppressed", variant: "neutral" },
};

const CHANNEL: Record<string, string> = { in_app: "In-app", email: "Email", sms: "SMS" };

export const CAMPAIGN_BADGE: Record<string, BadgeVariant> = {
  draft: "neutral",
  pending_approval: "yellow",
  approved: "blue",
  sending: "blue",
  sent: "green",
  cancelled: "neutral",
};

export function DeliveryBadge({ channel, status, reason }: { channel: string; status: string; reason?: string | null }) {
  const d = DELIVERY[status] ?? { label: status, variant: "neutral" as const };
  return (
    <Badge variant={d.variant} title={reason ?? undefined}>
      {CHANNEL[channel] ?? channel}: {d.label}
    </Badge>
  );
}

/** Honest status of external channels. Server-only (reads env names, never values). */
export function ChannelStatus() {
  const email = emailConfig();
  const sms = smsConfig();
  const redirect = testRecipients();
  if (email.configured && sms.configured) {
    return redirect.length ? (
      <p className="mb-4 text-xs text-ink-3">External delivery is in TEST mode: all email/SMS is redirected to DELIVERY_TEST_RECIPIENTS.</p>
    ) : null;
  }
  const missing = [...new Set([...email.missing, ...sms.missing].map((m) => m.replace(/=true$/, "")))].filter((m) => !m.startsWith("a transport"));
  return (
    <div className="mb-4">
      <NotConfigured provider={!email.configured && !sms.configured ? "Email & SMS delivery" : !email.configured ? "Email delivery" : "SMS delivery"} envVars={missing}>
        Messages are always delivered in the app. Email/SMS copies are recorded per recipient with status <em>not configured</em> — no one outside the app is contacted.
        {redirect.length ? " DELIVERY_TEST_RECIPIENTS is set, so once configured all external messages go only to the test inbox." : ""}
      </NotConfigured>
    </div>
  );
}
