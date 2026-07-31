"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  leads,
  leadActivities,
  appointments,
  athletes,
  athleteOnboarding,
  onboardingSteps,
  memberships,
  outreach,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";

const now = () => new Date().toISOString();
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const opt = (fd: FormData, k: string) => str(fd, k) || null;
const int = (fd: FormData, k: string) => {
  const n = parseInt(str(fd, k), 10);
  return Number.isFinite(n) ? n : null;
};

export async function addLead(formData: FormData) {
  const user = await requireUser("edit_records");
  const name = str(formData, "name");
  if (!name) return;
  db.insert(leads)
    .values({
      name,
      contactName: opt(formData, "contactName"),
      phone: opt(formData, "phone"),
      email: opt(formData, "email"),
      source: str(formData, "source") || "other",
      stage: "new",
      qualified: formData.get("qualified") === "0" ? 0 : 1,
      createdAt: now(),
      assignedUserId: user.id,
      notes: opt(formData, "notes"),
    })
    .run();
  revalidatePath("/leads");
  revalidatePath("/");
}

export async function logLeadActivity(formData: FormData) {
  const user = await requireUser("edit_records");
  const leadId = int(formData, "leadId");
  if (!leadId) return;
  const at = now();
  db.insert(leadActivities)
    .values({
      leadId,
      userId: user.id,
      type: str(formData, "type") || "call",
      at,
      note: opt(formData, "note"),
    })
    .run();
  const lead = db.select().from(leads).where(eq(leads.id, leadId)).get();
  if (lead) {
    db.update(leads)
      .set({
        firstContactedAt: lead.firstContactedAt ?? at,
        stage: lead.stage === "new" ? "contacted" : lead.stage,
      })
      .where(eq(leads.id, leadId))
      .run();
  }
  revalidatePath("/leads");
  revalidatePath("/");
}

export async function updateLeadStage(formData: FormData) {
  await requireUser("edit_records");
  const leadId = int(formData, "leadId");
  const stage = str(formData, "stage");
  if (!leadId || !stage) return;
  db.update(leads).set({ stage }).where(eq(leads.id, leadId)).run();
  revalidatePath("/leads");
  revalidatePath("/");
}

export async function scheduleAppointment(formData: FormData) {
  const user = await requireUser("edit_records");
  const scheduledAt = str(formData, "scheduledAt");
  if (!scheduledAt) return;
  const leadId = int(formData, "leadId");
  db.insert(appointments)
    .values({
      leadId,
      athleteId: int(formData, "athleteId"),
      typeKey: str(formData, "typeKey") || "success_session",
      scheduledAt,
      status: "scheduled",
      confirmed: 0,
      assignedUserId: user.id,
      createdAt: now(),
    })
    .run();
  if (leadId) {
    db.update(leads)
      .set({ stage: "appointment_scheduled" })
      .where(eq(leads.id, leadId))
      .run();
  }
  revalidatePath("/leads");
  revalidatePath("/");
}

export async function updateAppointment(formData: FormData) {
  await requireUser("edit_records");
  const id = int(formData, "appointmentId");
  if (!id) return;
  const action = str(formData, "do");
  const appt = db.select().from(appointments).where(eq(appointments.id, id)).get();
  if (!appt) return;
  if (action === "confirm") {
    db.update(appointments).set({ confirmed: 1 }).where(eq(appointments.id, id)).run();
  } else if (["completed", "no_show", "canceled"].includes(action)) {
    db.update(appointments).set({ status: action }).where(eq(appointments.id, id)).run();
    if (action === "completed" && appt.leadId) {
      db.update(leads)
        .set({ stage: "appointment_completed" })
        .where(eq(leads.id, appt.leadId))
        .run();
    }
  }
  revalidatePath("/leads");
  revalidatePath("/");
}

export async function addAthlete(formData: FormData) {
  await requireUser("edit_records");
  const name = str(formData, "name");
  const startDate = str(formData, "startDate") || now().slice(0, 10);
  if (!name) return;
  const birthYear = int(formData, "birthYear");
  const res = db
    .insert(athletes)
    .values({
      name,
      guardianName: opt(formData, "guardianName"),
      birthYear,
      program: opt(formData, "program"),
      startDate,
      status: "active",
      leadSource: opt(formData, "leadSource"),
      expectedSessionsPerWeek: int(formData, "expectedSessionsPerWeek") ?? 2,
      assignedUserId: int(formData, "assignedUserId"),
      notes: opt(formData, "notes"),
    })
    .run();
  const athleteId = Number(res.lastInsertRowid);

  // Kick off the onboarding pipeline for every active step.
  const steps = db
    .select()
    .from(onboardingSteps)
    .where(eq(onboardingSteps.active, 1))
    .all();
  for (const s of steps) {
    db.insert(athleteOnboarding)
      .values({ athleteId, stepId: s.id, status: "pending" })
      .onConflictDoNothing()
      .run();
  }

  // Optional membership
  const plan = opt(formData, "plan");
  const rate = parseFloat(str(formData, "monthlyRate"));
  if (plan) {
    db.insert(memberships)
      .values({
        athleteId,
        plan,
        monthlyRate: Number.isFinite(rate) ? rate : 0,
        isTrial: formData.get("isTrial") === "1" ? 1 : 0,
        status: "active",
        startDate,
      })
      .run();
  }

  // If the athlete came from a lead, mark that lead a member.
  const leadId = int(formData, "leadId");
  if (leadId) {
    db.update(leads).set({ stage: "member" }).where(eq(leads.id, leadId)).run();
  }
  revalidatePath("/athletes");
  revalidatePath("/onboarding");
  revalidatePath("/");
}

export async function logOutreach(formData: FormData) {
  const user = await requireUser("edit_records");
  const athleteId = int(formData, "athleteId");
  if (!athleteId) return;
  db.insert(outreach)
    .values({
      athleteId,
      userId: user.id,
      type: str(formData, "type") || "call",
      at: now(),
      note: opt(formData, "note"),
    })
    .run();
  revalidatePath("/athletes");
  revalidatePath("/");
}

export async function setAthleteRisk(formData: FormData) {
  await requireUser("edit_records");
  const athleteId = int(formData, "athleteId");
  if (!athleteId) return;
  const v = str(formData, "riskOverride");
  db.update(athletes)
    .set({ riskOverride: v === "auto" ? null : v })
    .where(eq(athletes.id, athleteId))
    .run();
  revalidatePath("/athletes");
}

export async function updateAthleteStatus(formData: FormData) {
  await requireUser("edit_records");
  const athleteId = int(formData, "athleteId");
  const status = str(formData, "status");
  if (!athleteId || !["active", "hold", "canceled"].includes(status)) return;
  const today = now().slice(0, 10);
  const prev = db.select().from(athletes).where(eq(athletes.id, athleteId)).get();
  db.update(athletes)
    .set({
      status,
      reactivatedAt:
        status === "active" && prev && prev.status !== "active"
          ? now()
          : prev?.reactivatedAt,
    })
    .where(eq(athletes.id, athleteId))
    .run();
  // Keep the athlete's current membership in sync.
  const mem = db
    .select()
    .from(memberships)
    .where(eq(memberships.athleteId, athleteId))
    .all()
    .find((m) => m.status === "active" || m.status === "hold");
  if (mem) {
    if (status === "canceled") {
      db.update(memberships)
        .set({ status: "canceled", endDate: today })
        .where(eq(memberships.id, mem.id))
        .run();
    } else if (status === "hold") {
      db.update(memberships)
        .set({ status: "hold", holdStart: today })
        .where(eq(memberships.id, mem.id))
        .run();
    } else {
      db.update(memberships)
        .set({ status: "active", holdStart: null })
        .where(eq(memberships.id, mem.id))
        .run();
    }
  }
  revalidatePath("/athletes");
  revalidatePath("/");
}

export async function toggleOnboardingStep(formData: FormData) {
  const user = await requireUser("edit_records");
  const athleteId = int(formData, "athleteId");
  const stepId = int(formData, "stepId");
  if (!athleteId || !stepId) return;
  const row = db
    .select()
    .from(athleteOnboarding)
    .where(eq(athleteOnboarding.athleteId, athleteId))
    .all()
    .find((r) => r.stepId === stepId);
  const target = str(formData, "target"); // done | pending | na
  if (row) {
    db.update(athleteOnboarding)
      .set({
        status: target || (row.status === "done" ? "pending" : "done"),
        completedAt: target === "pending" ? null : now(),
        completedByUserId: target === "pending" ? null : user.id,
      })
      .where(eq(athleteOnboarding.id, row.id))
      .run();
  } else {
    db.insert(athleteOnboarding)
      .values({
        athleteId,
        stepId,
        status: target || "done",
        completedAt: now(),
        completedByUserId: user.id,
      })
      .run();
  }
  revalidatePath("/onboarding");
  revalidatePath("/");
}
