import Link from "next/link";
import { getPublicSite } from "@/lib/public-site";
import { ButtonLink } from "@/components/ui";

export default async function Home() {
  const { content, orgName } = await getPublicSite();
  return (
    <>
      <section className="bg-gradient-to-b from-brand/10 to-transparent">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
          {content.draft ? (
            <p className="mb-4 inline-block rounded-full bg-warn/15 px-3 py-1 text-xs font-semibold text-warn">Draft website copy — edit in Settings → Public site</p>
          ) : null}
          <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">{content.headline}</h1>
          <p className="mt-4 max-w-2xl text-lg text-ink-2">{content.intro}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/inquire" size="lg">
              Book an athletic assessment
            </ButtonLink>
            <ButtonLink href="/programs" size="lg" variant="outline">
              Explore programs
            </ButtonLink>
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-4 py-12">
        <h2 className="text-2xl font-bold">How {orgName} works</h2>
        <ol className="mt-6 grid gap-4 sm:grid-cols-3">
          {[
            ["Assess", "Start with an assessment so we understand how you move, sprint, jump, and lift."],
            ["Train", "Join a coached group or private sessions with a plan built for your sport and season."],
            ["Track", "Families and athletes see schedules, workouts, and coach-approved progress in one place."],
          ].map(([t, d], i) => (
            <li key={t} className="rounded-xl border border-edge bg-surface p-5">
              <div className="kicker">Step {i + 1}</div>
              <div className="mt-1 text-lg font-semibold">{t}</div>
              <p className="mt-1 text-sm text-ink-2">{d}</p>
            </li>
          ))}
        </ol>
        <p className="mt-8 text-sm">
          Already a member?{" "}
          <Link href="/login" className="font-medium text-brand underline">
            Sign in to book sessions, sign forms, and see your training
          </Link>
          .
        </p>
      </section>
    </>
  );
}
