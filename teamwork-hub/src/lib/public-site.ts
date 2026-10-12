import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";

export type PublicSiteContent = {
  headline: string;
  intro: string;
  programs: { name: string; audience: string; description: string }[];
  address?: string;
  draft: boolean;
};

/** Public-site copy lives in org settings (Settings → Public site); defaults are labeled drafts. */
const DEFAULTS: PublicSiteContent = {
  headline: "Train smarter. Move better. Compete with confidence.",
  intro:
    "Teamwork is a sports performance and coaching facility in Bloomington, Indiana for youth and adult athletes — strength, speed, and athletic development coached by people who know your name.",
  programs: [
    { name: "Youth Athletic Development", audience: "Ages ~8–13", description: "Coordination, speed, strength foundations, and a love of training — in small, coached groups." },
    { name: "High School Speed & Strength", audience: "Ages ~14–18", description: "Periodized strength and speed work built around your sport season, with regular testing." },
    { name: "Private & Semi-Private Coaching", audience: "All ages", description: "Individual programming and coaching for return-to-sport progressions, specific goals, or scheduling needs." },
    { name: "Adult Performance", audience: "Adults", description: "Strength and conditioning for adult athletes and active adults who want real coaching." },
    { name: "Athletic Assessment", audience: "New athletes", description: "A movement, speed, and strength baseline so we can build the right plan — the best way to start." },
  ],
  draft: true,
};

export async function getPublicSite(): Promise<{ orgId: string | null; orgName: string; content: PublicSiteContent; timezone: string }> {
  // Single-facility deployment: the first (and only) organization is public.
  const [org] = await db.select().from(organizations).orderBy(organizations.createdAt).limit(1);
  if (!org) return { orgId: null, orgName: "Teamwork", content: DEFAULTS, timezone: "America/Indiana/Indianapolis" };
  const custom = (org.settings?.publicSite ?? {}) as Partial<PublicSiteContent>;
  return {
    orgId: org.id,
    orgName: org.branding?.displayName ?? "Teamwork",
    content: { ...DEFAULTS, ...custom, draft: custom.draft ?? !org.settings?.publicSite },
    timezone: org.timezone,
  };
}

export async function getOrgById(id: string) {
  const [o] = await db.select().from(organizations).where(eq(organizations.id, id));
  return o;
}
