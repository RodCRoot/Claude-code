import { getPublicSite } from "@/lib/public-site";
import { ButtonLink } from "@/components/ui";

export const metadata = { title: "Programs" };

export default async function ProgramsPage() {
  const { content } = await getPublicSite();
  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="text-3xl font-bold">Programs</h1>
      <p className="mt-2 max-w-2xl text-ink-2">Every program starts with an assessment. Pricing depends on program and schedule — ask us during your assessment.</p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2">
        {content.programs.map((p) => (
          <li key={p.name} className="rounded-xl border border-edge bg-surface p-5">
            <div className="kicker">{p.audience}</div>
            <h2 className="mt-1 text-lg font-semibold">{p.name}</h2>
            <p className="mt-1 text-sm text-ink-2">{p.description}</p>
          </li>
        ))}
      </ul>
      <ButtonLink href="/inquire" className="mt-8" size="lg">
        Book an assessment
      </ButtonLink>
    </div>
  );
}
