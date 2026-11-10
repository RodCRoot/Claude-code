import { prettyDate, sparklinePoints, type ShowcaseData, type ShowcaseTile } from "@/lib/showcase/compose";

/**
 * The Showcase one-pager. Purely presentational (no hooks, no data access), so the public page,
 * the builder's live preview and tests all render the same thing from the same `ShowcaseData`.
 * Colors are fixed, not themed: the page looks the same in light mode, dark mode and on paper.
 */

const HEADLINE_LABELS = new Set(["Sport", "Position", "Class of"]);

function VerifiedMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={className} fill="none">
      <path d="M10 1.8l6.5 2.4v5.1c0 4.1-2.8 7.2-6.5 8.9-3.7-1.7-6.5-4.8-6.5-8.9V4.2z" fill="currentColor" />
      <path d="M6.6 10.1l2.3 2.3 4.5-4.7" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Sparkline({ tile, color }: { tile: ShowcaseTile; color: string }) {
  if (!tile.trend) return null;
  const w = 104;
  const h = 40;
  const pts = sparklinePoints(tile.trend.values, w, h, 4);
  const last = pts[pts.length - 1];
  const line = pts.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`${tile.name} trend. ${tile.trend.summary}.`} className="shrink-0 [print-color-adjust:exact] print:h-6 print:w-16">
      <polygon points={`${pts[0].x},${h} ${line} ${last.x},${h}`} fill={color} opacity="0.1" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
      {pts.slice(0, -1).map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="1.6" fill={color} />
      ))}
      <circle cx={last.x} cy={last.y} r="3.6" fill="#fff" stroke={color} strokeWidth="2.25" />
    </svg>
  );
}

function SectionTitle({ children, id }: { children: React.ReactNode; id: string }) {
  return (
    <h2 id={id} className="mb-3 flex items-center gap-3 text-[11px] font-extrabold tracking-[0.14em] text-[#4a5568] uppercase print:mb-1.5">
      <span>{children}</span>
      <span aria-hidden className="h-px flex-1 bg-[#dfe5ee]" />
    </h2>
  );
}

function DateLine({ verified, date, org }: { verified: boolean; date: string; org: string }) {
  return verified ? (
    <span className="inline-flex items-center gap-1 font-semibold text-[#0a6a3d]">
      <VerifiedMark className="size-3.5 shrink-0" />
      Verified by {org} on {prettyDate(date)}
    </span>
  ) : (
    <span className="text-[#4a5568]">Recorded {prettyDate(date)} (not verified)</span>
  );
}

export function ShowcaseSheet({ data, preview = false }: { data: ShowcaseData; preview?: boolean }) {
  const org = data.org;
  const chips = data.facts.filter((f) => !HEADLINE_LABELS.has(f.label));
  const empty = !data.tiles.length && !data.lifts.length && !data.consistency.length && !data.bio;
  return (
    <article className="overflow-hidden rounded-2xl bg-white text-[#141b2b] shadow-[0_10px_40px_rgb(15_26_48/0.14)] ring-1 ring-[#d5dce8] print:rounded-none print:shadow-none print:ring-0">
      <header className="relative overflow-hidden bg-[#13203a] bg-[linear-gradient(135deg,#0d1730_0%,#1a2d52_52%,#11486f_100%)] px-5 pt-5 pb-7 text-white [print-color-adjust:exact] sm:px-9 sm:pt-7 sm:pb-9 print:px-7 print:pt-3 print:pb-4">
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-20 size-72 rounded-full border-[28px] border-white/[0.05]" />
        <div aria-hidden className="pointer-events-none absolute -right-6 -bottom-28 size-64 rounded-full border-[22px] border-[#4fc3f7]/[0.09]" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {org.logoPath ? (
              // eslint-disable-next-line @next/next/no-img-element -- same-origin logo path from org settings
              <img src={org.logoPath} alt="" className="size-9 rounded-lg bg-white object-contain p-1" />
            ) : (
              <span aria-hidden className="flex size-9 items-center justify-center rounded-lg bg-[#4fc3f7] text-base font-black text-[#0b1a2e]">
                {org.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="leading-tight">
              <span className="block text-[15px] font-extrabold tracking-tight">{org.name}</span>
              <span className="block text-[10px] font-bold tracking-[0.16em] text-[#7fd3f7] uppercase">Athlete Showcase</span>
            </span>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-bold tracking-wide text-white ring-1 ring-white/20">
            <VerifiedMark className="size-4 text-[#34d399]" />
            Numbers recorded at {org.name}
          </span>
        </div>
        <div className="relative mt-7 sm:mt-9 print:mt-2">
          <h1 className="text-[2.5rem] leading-[1.02] font-black tracking-tight break-words sm:text-6xl print:text-3xl">{data.displayName}</h1>
          {data.headline ? <p className="mt-2.5 text-base font-semibold text-[#7fd3f7] sm:text-lg print:mt-1 print:text-sm">{data.headline}</p> : null}
          {chips.length ? (
            <ul className="mt-4 flex flex-wrap gap-2 print:mt-2">
              {chips.map((f) => (
                <li key={f.label} className="rounded-full bg-white/10 px-3 py-1 text-[13px] ring-1 ring-white/15">
                  <span className="text-[#c9d4e5]">{f.label} </span>
                  <span className="font-bold">{f.value}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-1.5 [print-color-adjust:exact]" style={{ backgroundColor: org.primaryColor }} />
      </header>

      <div className="space-y-7 px-5 py-6 sm:px-9 sm:py-8 print:space-y-1.5 print:px-7 print:py-2">
        {data.bio ? <p className="max-w-2xl text-[15px] leading-relaxed whitespace-pre-line text-[#2a3447] print:text-xs print:leading-snug">{data.bio}</p> : null}

        {empty && preview ? <p className="rounded-xl border border-dashed border-[#c5cedb] px-4 py-8 text-center text-sm text-[#4a5568]">Choose what to show and it will appear here.</p> : null}

        {data.consistency.length ? (
          <section aria-labelledby="sc-consistency">
            <SectionTitle id="sc-consistency">Training consistency</SectionTitle>
            <dl className="grid grid-cols-3 gap-2 sm:gap-3">
              {data.consistency.map((c) => (
                <div key={c.label} className="flex flex-col-reverse justify-end rounded-xl bg-[#13203a] px-3 py-3 text-white sm:px-4 sm:py-3.5 [print-color-adjust:exact] print:py-1.5">
                  <dt className="mt-1 text-[11px] font-semibold tracking-wide text-[#c9d4e5]">{c.label}</dt>
                  <dd className="text-xl leading-none font-black tracking-tight tabular sm:text-[26px] print:text-lg">{c.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {data.tiles.length ? (
          <section aria-labelledby="sc-tests">
            <SectionTitle id="sc-tests">Test results</SectionTitle>
            <ul className="grid gap-3 sm:grid-cols-2 print:grid-cols-3 print:gap-2">
              {data.tiles.map((t) => (
                <li key={t.id} className="break-inside-avoid rounded-xl border border-[#dfe5ee] bg-[#f6f8fc] p-4 [print-color-adjust:exact] print:p-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[13px] leading-tight font-bold text-[#2a3447] print:text-[11px]">{t.name}</h3>
                      <p className="mt-1.5 flex items-baseline gap-1.5 print:mt-0.5">
                        <span className="text-[2.5rem] leading-none font-black tracking-tight tabular print:text-2xl">{t.latest.text}</span>
                        <span className="text-sm font-semibold text-[#4a5568]">{t.unit}</span>
                      </p>
                    </div>
                    <Sparkline tile={t} color={org.primaryColor} />
                  </div>
                  <p className="mt-2.5 text-xs leading-snug print:mt-1 print:text-[9.5px]">
                    <DateLine verified={t.latest.verified} date={t.latest.date} org={org.name} />
                  </p>
                  <p className="mt-1 text-xs leading-snug text-[#4a5568] print:mt-0.5 print:text-[9.5px]">
                    {t.best && t.best.date !== t.latest.date ? (
                      <>
                        Best <span className="font-bold text-[#141b2b] tabular">{t.best.text} {t.unit}</span> on {prettyDate(t.best.date)}
                      </>
                    ) : t.best ? (
                      <span className="font-semibold text-[#141b2b]">Personal best</span>
                    ) : null}
                    {t.best ? " · " : ""}
                    {t.testName}
                  </p>
                  {t.trend ? <p className="mt-1 text-xs leading-snug text-[#4a5568] print:hidden">{t.trend.summary}.</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {data.lifts.length ? (
          <section aria-labelledby="sc-lifts">
            <SectionTitle id="sc-lifts">Strength</SectionTitle>
            <ul className="grid gap-x-8 sm:grid-cols-2 print:grid-cols-2">
              {data.lifts.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 border-b border-[#e6ebf2] py-2.5 print:py-1">
                  <span className="min-w-0">
                    <span className="block text-sm font-bold">{l.name}</span>
                    <span className="block text-xs leading-snug text-[#4a5568]">{l.basisLabel} max</span>
                    <span className="block text-xs leading-snug">{l.verified ? <DateLine verified date={l.date} org={org.name} /> : <span className="text-[#4a5568]">{prettyDate(l.date)}</span>}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="text-2xl leading-none font-black tracking-tight tabular">{l.text}</span> <span className="text-xs font-semibold text-[#4a5568]">{l.unit}</span>
                    {l.relative ? <span className="block text-[11px] font-semibold text-[#4a5568] tabular">{l.relative}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {data.videoUrl || data.contactEmail ? (
          <section aria-labelledby="sc-links">
            <SectionTitle id="sc-links">Film and contact</SectionTitle>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm print:text-xs">
              {data.videoUrl ? (
                <a
                  href={data.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#13203a] px-4 font-bold text-white [print-color-adjust:exact] hover:bg-[#1a2d52] print:hidden"
                >
                  <svg viewBox="0 0 20 20" aria-hidden className="size-4" fill="currentColor">
                    <path d="M6 4.2v11.6a.8.8 0 001.2.7l9.6-5.8a.8.8 0 000-1.4L7.2 3.5a.8.8 0 00-1.2.7z" />
                  </svg>
                  Watch highlight video
                  <span className="sr-only"> (opens {new URL(data.videoUrl).hostname} in a new tab)</span>
                </a>
              ) : null}
              {data.videoUrl ? <span className="hidden text-xs break-all text-[#3a4657] print:inline">Highlight video: {data.videoUrl}</span> : null}
              {data.contactEmail ? (
                <span>
                  <span className="text-[#4a5568]">Contact </span>
                  <a href={`mailto:${data.contactEmail}`} className="font-bold break-all text-[#1d4ed8] underline">
                    {data.contactEmail}
                  </a>
                </span>
              ) : null}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="sc-methods" className="rounded-xl bg-[#f6f8fc] px-4 py-3.5 text-xs leading-relaxed text-[#3a4657] [print-color-adjust:exact] print:px-3 print:py-1.5 print:text-[7.5px] print:leading-[1.25]">
          <h2 id="sc-methods" className="mb-1 text-[11px] font-extrabold tracking-[0.14em] text-[#4a5568] uppercase">
            How these numbers were recorded
          </h2>
          <p>
            Every number on this page was recorded at {org.name}{" "}on the date shown next to it. &quot;Verified&quot; means a coach entered it or it came straight from a testing device. Results typed in by an athlete or family are never marked
            verified. Trend lines join only results measured the same way.
          </p>
          <p className="hidden print:block">
            Shared by the athlete&apos;s family through {org.name}. Page as of {prettyDate(data.asOf)}.
          </p>
          {data.methods.length ? (
            <dl className="mt-1.5 space-y-1 print:columns-2 print:gap-5 print:space-y-0.5">
              {data.methods.map((m) => (
                <div key={m.name}>
                  <dt className="inline font-bold text-[#141b2b]">{m.name}. </dt>
                  <dd className="inline">{m.text}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </section>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-[#dfe5ee] bg-[#f1f4f9] px-5 py-4 sm:px-9 print:hidden">
        <p className="text-xs text-[#3a4657]">
          Shared by the athlete&apos;s family through {org.name}. Page as of {prettyDate(data.asOf)}.
        </p>
        {preview ? (
          <span className="inline-flex min-h-11 items-center rounded-lg px-5 text-sm font-extrabold text-white [print-color-adjust:exact]" style={{ backgroundColor: org.primaryColor }}>
            Train at {org.name}
          </span>
        ) : (
          <a href={data.inquireHref} className="inline-flex min-h-11 items-center rounded-lg px-5 text-sm font-extrabold text-white [print-color-adjust:exact] hover:brightness-110 print:hidden" style={{ backgroundColor: org.primaryColor }}>
            Train at {org.name}
          </a>
        )}
      </footer>
    </article>
  );
}
