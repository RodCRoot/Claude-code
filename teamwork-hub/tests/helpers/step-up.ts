import type { DB } from "@/db";
import type { Viewer } from "@/lib/authz/policy";
import { __setEmailTransport } from "@/lib/messaging/channels/email";
import type { OutboundMessage } from "@/lib/messaging/channels/types";
import { sendStepUpCode, verifyStepUpCode } from "@/lib/forms/step-up";

const EMAIL_ENV = { EMAIL_PROVIDER: "postmark", EMAIL_API_KEY: "test-key", EMAIL_FROM: "forms@teamwork-hub.test", DELIVERY_ENABLED: "true" } as const;

/**
 * Run `fn` with email delivery "configured" and the provider call replaced by an in-memory
 * capture (the adapter still applies DELIVERY_ENABLED / DELIVERY_TEST_RECIPIENTS rules).
 */
export async function withEmailCapture<T>(fn: (outbox: OutboundMessage[]) => Promise<T>, extraEnv: Record<string, string> = {}): Promise<T> {
  const env = { ...EMAIL_ENV, ...extraEnv } as Record<string, string>;
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const outbox: OutboundMessage[] = [];
  __setEmailTransport(async (m) => {
    outbox.push(m);
    return { providerMessageId: `test-${outbox.length}` };
  });
  try {
    return await fn(outbox);
  } finally {
    __setEmailTransport(null);
    for (const [k, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  }
}

export function codeFrom(m: OutboundMessage): string {
  const code = /\b(\d{6})\b/.exec(m.body)?.[1];
  if (!code) throw new Error("no code in email body");
  return code;
}

/** Full email step-up for a self-signer: send a code, read it from the captured email, verify it. */
export async function verifyByEmail(db: DB, v: Viewer, requestId: string, now = new Date()) {
  return withEmailCapture(async (outbox) => {
    const sent = await sendStepUpCode(db, v, requestId, now);
    if (sent.status !== "sent") throw new Error(`step-up email not sent: ${sent.status}`);
    const res = await db.transaction((tx) => verifyStepUpCode(tx, v, requestId, codeFrom(outbox[outbox.length - 1]), now));
    if (!res.ok) throw new Error(res.error);
    return res.challengeId;
  });
}
