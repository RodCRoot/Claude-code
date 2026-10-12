import { eq, sql } from "drizzle-orm";
import { automationRules, campaigns, inboundMessages, leads, messageTemplates, organizations, segments, users } from "../../src/db/schema";
import { recordConsent } from "../../src/lib/messaging/preferences";
import type { Viewer } from "../../src/lib/authz/policy";
import { convertLead } from "../../src/lib/crm/convert";
import { createLeadFromInquiry, type InquiryInput } from "../../src/lib/crm/intake";
import { addLeadNote, changeStage, markContacted } from "../../src/lib/crm/leads";
import { ensureStages } from "../../src/lib/crm/stages";
import { postMessage, startFamilyThread, startStaffThread } from "../../src/lib/messaging/threads";
import type { SeedCtx } from "./context";

/**
 * CRM + messaging demo data (all synthetic, `.test` addresses, external delivery disabled):
 * pipeline stages, ~8 leads across stages (one possible duplicate, one lost, one converted),
 * family threads with internal notes, consent rows (some opted out), SAMPLE templates and
 * DISABLED automation rules.
 */
export async function seedCrm(ctx: SeedCtx) {
  const { tx, orgId } = ctx;
  ctx.extra.crm = {};

  const viewer = async (key: string): Promise<Viewer> => {
    const [u] = await tx.select().from(users).where(eq(users.id, ctx.users[key]));
    return { userId: u.id, orgId: u.orgId, role: u.role, personId: u.personId, displayName: u.displayName, mfaVerified: true };
  };
  const erin = await viewer("erin");
  const rod = await viewer("rod");

  await tx
    .update(organizations)
    .set({ settings: sql`${organizations.settings} || ${JSON.stringify({ crm: { defaultLeadOwnerUserId: ctx.users.erin }, messaging: { minorAthletesMayMessage: false } })}::jsonb` })
    .where(eq(organizations.id, orgId));
  await ensureStages(tx, orgId);

  // --- Consent (synthetic) ----------------------------------------------------------
  const consent: [string, "email" | "sms", "opted_in" | "opted_out", string][] = [
    ["alex_parker", "email", "opted_in", "family portal settings (sample)"],
    ["alex_parker", "sms", "opted_in", "family portal settings (sample)"],
    ["jordan_parker", "email", "opted_out", "unsubscribe link (sample)"],
    ["sam_rivera", "sms", "opted_in", "front desk paper form (sample)"],
    ["casey_nguyen", "email", "opted_in", "family portal settings (sample)"],
    ["casey_nguyen", "sms", "opted_out", "replied STOP (sample)"],
    ["dana_brooks", "email", "opted_in", "signup (sample)"],
    ["chris_parker", "email", "opted_out", "family portal settings (sample)"],
  ];
  for (const [p, channel, c, source] of consent) {
    // Through recordConsent so every row has history (source + timestamp) like real changes.
    await recordConsent(tx, { orgId, personId: ctx.people[p], channel, consent: c, source: "seed", detail: source });
  }

  // --- Leads -------------------------------------------------------------------------
  const inquiry = (x: Partial<InquiryInput> & Pick<InquiryInput, "contactFirstName" | "contactLastName">): InquiryInput => ({
    inquiringFor: "child",
    consentEmail: true,
    consentSms: false,
    preferredTimes: ["Weekday evenings"],
    ...x,
  });
  const mk = async (key: string, input: InquiryInput, source = "web_inquiry") => {
    const r = await createLeadFromInquiry(tx, orgId, input, { source, isDemo: true });
    ctx.extra.crm[key] = r.leadId;
    return r.leadId;
  };

  await mk("lead_new", inquiry({ contactFirstName: "Priya", contactLastName: "Halvorsen", email: "priya.halvorsen@example.test", athleteFirstName: "Kai", athleteLastName: "Halvorsen", athleteAge: 13, sport: "Soccer", goals: "Get faster for club tryouts (sample)" }));
  await mk("lead_new_adult", inquiry({ inquiringFor: "self", contactFirstName: "Morgan", contactLastName: "Ellery", email: "morgan.ellery@example.test", phone: "+1 812 555 0177", consentSms: true, athleteAge: 29, sport: "Rowing", goals: "Return-to-sport strength after injury (sample)" }), "walk_in");
  // Same email as an existing guardian → flagged as a possible duplicate, never merged.
  await mk("lead_duplicate", inquiry({ contactFirstName: "Alex", contactLastName: "Parker", email: "alex.parker@example.test", athleteFirstName: "Nora", athleteLastName: "Parker", athleteAge: 9, sport: "Gymnastics", goals: "Younger sibling wants to join (sample)" }));
  const contacted = await mk("lead_contacted", inquiry({ contactFirstName: "Devon", contactLastName: "Ashby", email: "devon.ashby@example.test", athleteFirstName: "Rhea", athleteLastName: "Ashby", athleteAge: 16, sport: "Volleyball" }), "referral");
  await markContacted(tx, erin, contacted, "phone");
  await addLeadNote(tx, erin, contacted, "Left voicemail; parent prefers texts after 5pm. (sample note)");
  const booked = await mk("lead_booked", inquiry({ contactFirstName: "Lena", contactLastName: "Okoro", email: "lena.okoro@example.test", athleteFirstName: "Tobi", athleteLastName: "Okoro", athleteAge: 15, sport: "Basketball" }), "instagram");
  await markContacted(tx, erin, booked, "email");
  await changeStage(tx, erin, booked, { stage: "assessment_booked" });
  const done = await mk("lead_done", inquiry({ contactFirstName: "Hank", contactLastName: "Brandvold", email: "hank.brandvold@example.test", athleteFirstName: "Iris", athleteLastName: "Brandvold", athleteAge: 14, sport: "Track & Field" }), "referral");
  await markContacted(tx, erin, done, "in_person");
  await changeStage(tx, erin, done, { stage: "assessment_done" });
  const lost = await mk("lead_lost", inquiry({ contactFirstName: "Wes", contactLastName: "Talbot", email: "wes.talbot@example.test", athleteFirstName: "June", athleteLastName: "Talbot", athleteAge: 11, sport: "Tennis" }), "google");
  await changeStage(tx, erin, lost, { stage: "lost", lostReason: "Schedule conflict with school season (sample)" });
  const won = await mk("lead_won", inquiry({ contactFirstName: "Nadia", contactLastName: "Ferreira", email: "nadia.ferreira@example.test", athleteFirstName: "Luca", athleteLastName: "Ferreira", athleteAge: 12, sport: "Soccer" }), "referral");
  await markContacted(tx, erin, won, "phone");
  const conv = await convertLead(tx, erin, { leadId: won, household: "new", payer: "new" });
  ctx.athletes.luca = conv.athleteId;
  await tx.update(leads).set({ isDemo: true }).where(eq(leads.orgId, orgId));

  // --- Threads -------------------------------------------------------------------------
  const alex = await viewer("alex");
  const casey = await viewer("casey");
  const dana = await viewer("dana");
  const chris = await viewer("chris");
  const marcus = await viewer("marcus");

  const maya = await startStaffThread(tx, erin, {
    athleteId: ctx.athletes.maya,
    subject: "Maya's summer training plan",
    body: "Hi! Coach Marcus put together a summer plan for Maya — 3 sessions/week. Want us to hold those slots? (sample)",
    channels: ["email"],
    mode: "separate",
  });
  const [mayaAlex] = maya.threadIds;
  ctx.extra.crm.thread_maya_alex = mayaAlex;
  ctx.extra.crm.thread_maya_jordan = maya.threadIds[1];
  await postMessage(tx, alex, { threadId: mayaAlex, body: "Yes please — Tuesdays and Thursdays work best. (sample)" });
  await postMessage(tx, erin, { threadId: mayaAlex, body: "Alex prefers Tue/Thu; check with Marcus about Saturday capacity before confirming.", internal: true });

  const leo = await startFamilyThread(tx, casey, { athleteId: ctx.athletes.leo, subject: "Pickup on Wednesdays", body: "I'll be picking Leo up on Wednesdays this month. Anything I need to sign? (sample)" });
  ctx.extra.crm.thread_leo_casey = leo.threadId;
  await postMessage(tx, rod, { threadId: leo.threadId, body: "Custody note on file — both parents may receive training updates. No extra form needed.", internal: true });
  await postMessage(tx, marcus, { threadId: leo.threadId, body: "Thanks Casey — noted. Nothing else to sign. (sample)" });

  const d = await startFamilyThread(tx, dana, { athleteId: ctx.athletes.dana, subject: "Moving to early mornings", body: "Could I switch to the 6am group starting next week? (sample)" });
  ctx.extra.crm.thread_dana = d.threadId;

  const c = await startFamilyThread(tx, chris, { athleteId: ctx.athletes.ava, subject: "Ava missed Saturday", body: "Ava was sick Saturday — can she make it up? (sample)" });
  ctx.extra.crm.thread_ava_chris = c.threadId;

  // --- SAMPLE templates + DISABLED rules ------------------------------------------------
  const templates: { key: string; name: string; channel: "in_app" | "email" | "sms"; subject?: string; body: string }[] = [
    { key: "session_cancelled", name: "Session cancelled (SAMPLE)", channel: "email", subject: "Cancelled: {{session_title}}", body: "SAMPLE TEXT — Hi {{guardian_first_name}}, {{session_title}} on {{session_time}} for {{athlete_first_name}} is cancelled. Any credit used has been returned. — {{org_name}}" },
    { key: "session_changed", name: "Session changed (SAMPLE)", channel: "email", subject: "Updated: {{session_title}}", body: "SAMPLE TEXT — Hi {{guardian_first_name}}, {{session_title}} for {{athlete_first_name}} has moved to {{session_time}}. — {{org_name}}" },
    { key: "form_missing", name: "Form reminder (SAMPLE)", channel: "email", subject: "Reminder: {{form_name}}", body: "SAMPLE TEXT — Hi {{guardian_first_name}}, we still need {{form_name}} for {{athlete_first_name}} before their next session. — {{org_name}}" },
    { key: "payment_failed", name: "Payment failed (SAMPLE)", channel: "email", subject: "Payment issue on invoice {{invoice_number}}", body: "SAMPLE TEXT — Hi {{recipient_first_name}}, a payment of {{invoice_amount}} for invoice {{invoice_number}} didn't go through. Please update your payment method in the family portal. — {{org_name}}" },
    { key: "renewal_upcoming", name: "Renewal reminder (SAMPLE)", channel: "email", subject: "{{athlete_first_name}}'s membership renews {{renewal_date}}", body: "SAMPLE TEXT — Hi {{recipient_first_name}}, {{athlete_first_name}}'s membership renews on {{renewal_date}}. Reply with any questions. — {{org_name}}" },
    { key: "attendance_lapsed", name: "We miss you (SAMPLE)", channel: "sms", body: "SAMPLE TEXT — Hi {{guardian_first_name}}, we haven't seen {{athlete_first_name}} since {{last_attended_date}}. Want help booking the next session? — {{org_name}}" },
    { key: "lead_created", name: "New inquiry thank-you (SAMPLE)", channel: "email", subject: "Thanks for reaching out to {{org_name}}", body: "SAMPLE TEXT — Hi {{recipient_first_name}}, thanks for asking about training for {{lead_first_name}}. A coach will reach out within one business day to set up an assessment. — {{org_name}}" },
    { key: "assessment_completed", name: "Assessment follow-up (SAMPLE)", channel: "email", subject: "Next steps after {{athlete_first_name}}'s assessment", body: "SAMPLE TEXT — Hi {{recipient_first_name}}, thanks for coming in for {{session_title}}. We'll send {{athlete_first_name}}'s recommended plan shortly. — {{org_name}}" },
  ];
  const tplIds: Record<string, string> = {};
  for (const t of templates) {
    const [row] = await tx.insert(messageTemplates).values({ orgId, key: t.key, name: t.name, channel: t.channel, subject: t.subject ?? null, body: t.body, isSample: true }).returning();
    tplIds[t.key] = row.id;
  }
  const rules: { name: string; trigger: keyof typeof tplIds; channels: ("in_app" | "email" | "sms")[]; delay?: number; days?: number; task?: boolean }[] = [
    { name: "Notify families when a session is cancelled", trigger: "session_cancelled", channels: ["in_app", "email"] },
    { name: "Notify families when a session changes", trigger: "session_changed", channels: ["in_app", "email"] },
    { name: "Remind about missing forms after 3 days", trigger: "form_missing", channels: ["in_app", "email"], days: 3 },
    { name: "Payment failed follow-up", trigger: "payment_failed", channels: ["in_app", "email"], days: 7, task: true },
    { name: "Renewal heads-up 7 days out", trigger: "renewal_upcoming", channels: ["in_app", "email"], days: 7 },
    { name: "Check in after 14 days without attendance", trigger: "attendance_lapsed", channels: ["in_app", "sms"], days: 14, task: true },
    { name: "Thank new inquiries", trigger: "lead_created", channels: ["email"], delay: 5 },
    { name: "Assessment follow-up", trigger: "assessment_completed", channels: ["in_app", "email"], delay: 60, task: true },
  ];
  for (const r of rules) {
    await tx.insert(automationRules).values({
      orgId,
      name: r.name,
      trigger: r.trigger as never,
      templateId: tplIds[r.trigger],
      channels: r.channels,
      delayMinutes: r.delay ?? 0,
      createTask: !!r.task,
      conditions: r.days ? { days: r.days } : {},
      enabled: false,
    });
  }

  // --- Broadcasts: a SAMPLE announcement template, two segments, one DRAFT campaign ----------
  const [announce] = await tx
    .insert(messageTemplates)
    .values({
      orgId,
      key: "announcement",
      name: "Facility announcement (SAMPLE)",
      channel: "email",
      subject: "News from {{org_name}}",
      body: "SAMPLE TEXT — Hi {{recipient_first_name}}, a quick update for {{athlete_first_name}}'s family: … — {{org_name}}",
      isSample: true,
    })
    .returning();
  const [activeMembers] = await tx
    .insert(segments)
    .values({ orgId, name: "Active members (families)", description: "Athletes with an active membership → their guardians, or adult athletes themselves. (sample)", filters: { audience: "athletes", athleteActive: "active", membershipStatus: "active" }, createdByUserId: erin.userId, isDemo: true })
    .returning();
  await tx.insert(segments).values({ orgId, name: "Open leads — new", description: "Lead contacts still in the New stage. (sample)", filters: { audience: "leads", leadStage: "new" }, createdByUserId: erin.userId, isDemo: true });
  const [draft] = await tx
    .insert(campaigns)
    .values({ orgId, name: "Holiday hours (sample draft)", templateId: announce.id, segmentId: activeMembers.id, channels: ["in_app", "email"], status: "draft", createdByUserId: erin.userId, isDemo: true })
    .returning();
  ctx.extra.crm.campaign_draft = draft.id;
  ctx.extra.crm.segment_active = activeMembers.id;

  // An inbound text from an unknown number, waiting in the staff-only unmatched queue.
  await tx.insert(inboundMessages).values({
    orgId,
    channel: "sms",
    provider: "twilio",
    providerMessageId: `demo-${orgId}`,
    fromAddress: "+1 812 555 0142",
    body: "Hi, is the Saturday speed clinic still on? (sample)",
    status: "unmatched",
    reason: "Sender not recognized",
  });
}
