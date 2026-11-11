"use client";

import { useEffect, useRef, useState } from "react";
import { BadgeMedallion, Flame, LevelRing } from "@/components/engagement/medallion";
import { badgeDef } from "@/lib/engagement/badges";
import { CHALLENGE_METRIC_LABEL, CHALLENGE_METRIC_UNIT, plural, type BoardPanel, type BoardPayload } from "@/lib/community/shared";

/**
 * The gym TV board. Full screen, dark, readable from across the room, no interaction needed.
 *  - Panels CUT from one to the next: no fades, slides or other animation (a fade lowers text
 *    contrast mid-transition, and cuts are also what `prefers-reduced-motion` asks for).
 *  - Data refreshes in place on an interval; if the network drops the last data stays up and the
 *    footer says when it was last updated. If the screen is disconnected in Settings (401), the
 *    board blanks itself.
 *  - No sound. All timers live here (CSP: no inline handlers or scripts).
 */
const REFRESH_MS = 60_000;

function clock(d: Date, timeZone: string) {
  try {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  } catch {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
}

const T = {
  title: "text-[clamp(1.75rem,7.2vh,5.5rem)] leading-[1.02] font-extrabold tracking-tight",
  big: "text-[clamp(1.25rem,5.2vh,4rem)] leading-tight font-extrabold tracking-tight",
  mid: "text-[clamp(1rem,3.3vh,2.5rem)] leading-tight font-bold",
  small: "text-[clamp(0.875rem,2.4vh,1.8rem)] leading-snug",
  kicker: "text-[clamp(0.8rem,2.1vh,1.6rem)] font-bold uppercase tracking-[0.18em] text-[#7fd3f7]",
};
const ROW = "flex max-h-[19vh] min-h-0 flex-1 items-center gap-[2.2vw] rounded-[1.6vh] bg-white/[0.055] px-[2.2vw] py-[1vh] ring-1 ring-white/10";
const MUTED = "text-[#b9c6da]";

export function DisplayBoard({ initial, pinned, preview }: { initial: BoardPayload; pinned: number | null; preview: boolean }) {
  const [data, setData] = useState(initial);
  const [index, setIndex] = useState(pinned ?? 0);
  const [paused, setPaused] = useState(false);
  const [offline, setOffline] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const count = data.panels.length;
  const countRef = useRef(count);
  useEffect(() => {
    countRef.current = count;
  }, [count]);

  // Clock (set after mount so server and client markup match).
  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  // Refresh the data without reloading the page. Keep the last good data on any failure.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/display/board", { cache: "no-store", credentials: "same-origin" });
        if (!alive) return;
        if (res.status === 401 || res.status === 403) {
          setDisconnected(true);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as BoardPayload;
        if (!alive) return;
        setData(next);
        setOffline(false);
        setDisconnected(false);
      } catch {
        if (alive) setOffline(true);
      }
    };
    const id = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Rotate. A cut: the next panel simply replaces the current one.
  useEffect(() => {
    if (pinned !== null || paused || count < 2) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % Math.max(1, countRef.current)), Math.max(6, data.rotationSeconds) * 1000);
    return () => clearInterval(id);
  }, [pinned, paused, count, data.rotationSeconds]);

  const panel = count ? data.panels[index % count] : null;
  const updated = new Date(data.generatedAt);

  return (
    <div className="flex h-dvh min-h-[34rem] w-full flex-col overflow-hidden bg-[#060b16] bg-[radial-gradient(120%_90%_at_0%_0%,#152a55_0%,#0a1428_45%,#060b16_100%)] text-white">
      <header className="flex shrink-0 items-center justify-between gap-6 px-[3vw] pt-[2.6vh]">
        <div className="flex min-w-0 items-center gap-[1.2vw]">
          <span aria-hidden className="flex size-[clamp(2.25rem,6vh,4.5rem)] shrink-0 items-center justify-center rounded-[1.2vh] bg-[#4fc3f7] text-[clamp(1.2rem,3.6vh,2.8rem)] font-black text-[#0b1a2e]">
            {data.orgName.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[clamp(1.1rem,3.4vh,2.6rem)] leading-none font-extrabold tracking-tight">{data.orgName}</p>
            <p className={`mt-[0.6vh] ${T.kicker}`}>Community board</p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[clamp(1.25rem,4.4vh,3.4rem)] leading-none font-extrabold tabular">{now ? clock(now, data.timeZone) : " "}</p>
          <p className={`mt-[0.6vh] ${T.small} ${MUTED}`}>{data.dateLabel}</p>
        </div>
      </header>

      <main id="main" className="flex min-h-0 flex-1 flex-col px-[3vw] pt-[2.4vh] pb-[1.6vh]">
        <h1 className="sr-only">{data.orgName} community board</h1>
        {disconnected ? (
          <Centered title="This screen was disconnected" body="Ask a gym admin to reconnect it in Settings, Community." />
        ) : !data.enabled ? (
          <Centered title={`Welcome to ${data.orgName}`} body="The community board is turned off right now." />
        ) : panel ? (
          <PanelView panel={panel} />
        ) : (
          <Centered title={`Welcome to ${data.orgName}`} body="Train hard. New PRs, streaks and shoutouts will show up here." />
        )}
      </main>

      <footer className="flex shrink-0 items-center justify-between gap-6 px-[3vw] pb-[2.2vh]">
        <div className="flex min-w-0 items-center gap-[1vw]">
          {count > 1 && !disconnected ? (
            <>
              <ol aria-hidden className="flex items-center gap-[0.5vw]">
                {data.panels.map((p, i) => (
                  <li key={`${p.key}-${i}`} className={`h-[0.9vh] min-h-1.5 rounded-full ${i === index % count ? "w-[3vw] min-w-6 bg-[#4fc3f7]" : "w-[0.9vw] min-w-1.5 bg-white/25"}`} />
                ))}
              </ol>
              <span className="sr-only">
                Panel {(index % count) + 1} of {count}
              </span>
            </>
          ) : null}
          {pinned === null && count > 1 ? (
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              aria-pressed={paused}
              className={`rounded-md px-3 py-1 text-sm font-semibold ring-1 ring-white/40 focus-visible:outline-2 focus-visible:outline-[#4fc3f7] ${paused ? "bg-white/10 text-white" : "sr-only focus:not-sr-only"}`}
            >
              {paused ? "Resume rotation" : "Pause rotation"}
            </button>
          ) : null}
        </div>
        <p className={`shrink-0 text-right text-[clamp(0.75rem,1.7vh,1.25rem)] ${MUTED}`}>
          {preview ? <span className="mr-3 rounded bg-white/10 px-2 py-0.5 font-semibold text-white">Preview</span> : null}
          {offline ? <span className="mr-3 font-semibold text-[#fbbf24]">Offline, showing the last update.</span> : null}
          Last updated <time dateTime={data.generatedAt}>{now ? clock(updated, data.timeZone) : ""}</time>
        </p>
      </footer>
    </div>
  );
}

function Centered({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <p className={T.title}>{title}</p>
      <p className={`mt-[2vh] max-w-[70vw] ${T.mid} ${MUTED}`}>{body}</p>
    </div>
  );
}

function Head({ kicker, title, aside }: { kicker: string; title: string; aside?: React.ReactNode }) {
  return (
    <div className="mb-[2.2vh] flex shrink-0 flex-wrap items-end justify-between gap-x-8 gap-y-2">
      <div className="min-w-0">
        <p className={T.kicker}>{kicker}</p>
        <h2 className={`mt-[0.6vh] line-clamp-2 ${T.title}`}>{title}</h2>
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
  );
}

const Chip = ({ children, tone = "sky" }: { children: React.ReactNode; tone?: "sky" | "gold" | "green" | "plain" }) => (
  <span
    className={`inline-flex items-center rounded-full px-[1.2vw] py-[0.5vh] text-[clamp(0.8rem,2.3vh,1.75rem)] font-extrabold whitespace-nowrap ${
      tone === "gold" ? "bg-[#fbbf24] text-[#3b2a00]" : tone === "green" ? "bg-[#4ade80] text-[#06310f]" : tone === "plain" ? "bg-white/10 text-white ring-1 ring-white/25" : "bg-[#4fc3f7] text-[#0b1a2e]"
    }`}
  >
    {children}
  </span>
);

const RANK_TONE = ["bg-[#fbbf24] text-[#3b2a00]", "bg-[#d3dae3] text-[#27313d]", "bg-[#e2a36b] text-[#4a2508]"];
const Rank = ({ n }: { n: number }) => (
  <span className={`flex size-[clamp(2.25rem,6.4vh,4.75rem)] shrink-0 items-center justify-center rounded-full text-[clamp(1rem,3.4vh,2.6rem)] font-black tabular ${RANK_TONE[n - 1] ?? "bg-white/10 text-white ring-1 ring-white/25"}`}>
    <span className="sr-only">Rank </span>
    {n}
  </span>
);

const List = ({ children, cols = 1 }: { children: React.ReactNode; cols?: 1 | 2 }) => (
  <ul className={`grid min-h-0 flex-1 auto-rows-fr gap-[1.4vh] ${cols === 2 ? "grid-cols-1 gap-x-[1.6vw] md:grid-cols-2" : "grid-cols-1"}`}>{children}</ul>
);

function Bell() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className="size-[clamp(2rem,6.5vh,5rem)] shrink-0">
      <path d="M12 2.5a1.5 1.5 0 011.5 1.5v.6A6.5 6.5 0 0118.5 11v3.6l1.8 2.7a.8.8 0 01-.7 1.2H4.4a.8.8 0 01-.7-1.2l1.8-2.7V11a6.5 6.5 0 015-6.4V4A1.5 1.5 0 0112 2.5z" fill="#fbbf24" />
      <path d="M9.5 20a2.5 2.5 0 005 0z" fill="#fff3c4" />
    </svg>
  );
}

function PanelView({ panel }: { panel: BoardPanel }) {
  switch (panel.key) {
    case "pr_bell":
      return (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={panel.title}>
          <Head kicker="New personal records this week" title={panel.title} aside={<Bell />} />
          <List>
            {panel.items.map((p, i) => (
              <li key={i} className={ROW}>
                <div className="min-w-0 flex-1">
                  <p className={`truncate ${T.big}`}>{p.name}</p>
                  <p className={`truncate ${T.small} ${MUTED}`}>
                    {p.lift} · {p.when}
                  </p>
                </div>
                {p.delta ? <Chip tone="green">{p.delta}</Chip> : null}
                <p className={`shrink-0 text-right text-[#7fd3f7] tabular ${T.big}`}>{p.value}</p>
              </li>
            ))}
          </List>
        </section>
      );
    case "streaks":
      return (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={panel.title}>
          <Head kicker="Weeks in a row with training" title={panel.title} />
          <List cols={2}>
            {panel.items.map((s, i) => (
              <li key={i} className={ROW}>
                <Flame className="size-[clamp(1.75rem,5.6vh,4.25rem)]" />
                <p className={`min-w-0 flex-1 truncate ${T.big}`}>{s.name}</p>
                <p className="shrink-0 text-right leading-none">
                  <span className={`text-[#fbbf24] tabular ${T.big}`}>{s.weeks}</span> <span className={`${T.small} ${MUTED}`}>weeks</span>
                </p>
              </li>
            ))}
          </List>
        </section>
      );
    case "level_ups":
      return (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={panel.title}>
          <Head kicker="This week" title={panel.title} />
          <List cols={2}>
            {panel.items.map((x, i) => {
              const def = x.badgeKey ? badgeDef(x.badgeKey) : null;
              return (
                <li key={i} className={ROW}>
                  <span className="flex w-[clamp(3rem,8.5vh,6.25rem)] shrink-0 items-center justify-center *:h-auto *:w-full">
                    {def ? <BadgeMedallion def={def} size={96} /> : <LevelRing level={x.level ?? 1} pct={100} size={70} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`truncate ${T.big}`}>{x.name}</p>
                    <p className={`truncate ${T.small} ${x.kind === "level" ? "text-[#7fd3f7]" : "text-[#fde68a]"}`}>{x.kind === "level" ? `Reached ${x.label}` : `New badge: ${x.label}`}</p>
                  </div>
                </li>
              );
            })}
          </List>
        </section>
      );
    case "leaderboards":
      return (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={`Leaderboard: ${panel.board.title}`}>
          <Head kicker={`Leaderboard · ${panel.board.label}`} title={panel.board.title} aside={<Chip>{panel.board.cohort}</Chip>} />
          <List>
            {panel.board.rows.map((r, i) => (
              <li key={i} className={ROW}>
                <Rank n={r.rank} />
                <div className="min-w-0 flex-1">
                  <p className={`truncate ${T.big}`}>{r.name}</p>
                  {r.detail ? <p className={`truncate ${T.small} ${MUTED}`}>{r.detail}</p> : null}
                </div>
                {r.value ? <p className={`shrink-0 text-right text-[#7fd3f7] tabular ${T.big}`}>{r.value}</p> : null}
              </li>
            ))}
          </List>
        </section>
      );
    case "classes":
      return (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={panel.title}>
          <Head kicker="On the floor today" title={panel.title} />
          <List>
            {panel.items.map((c, i) => (
              <li key={i} className={`${ROW}`}>
                <p className={`w-[18vw] min-w-28 shrink-0 tabular ${T.big} ${c.state === "done" ? MUTED : "text-white"}`}>{c.time}</p>
                <div className="min-w-0 flex-1">
                  <p className={`truncate ${T.mid}`}>{c.title}</p>
                  <p className={`truncate ${T.small} ${MUTED}`}>{c.coach ? `with ${c.coach}` : "Coach to be announced"}</p>
                </div>
                {c.state === "now" ? <Chip tone="green">Now</Chip> : null}
                {c.state === "done" ? <Chip tone="plain">Finished</Chip> : c.spotsLeft > 0 ? <Chip tone={c.spotsLeft <= 2 ? "gold" : "sky"}>{plural(c.spotsLeft, ["spot", "spots"])} left</Chip> : <Chip tone="plain">Full</Chip>}
              </li>
            ))}
          </List>
        </section>
      );
    case "milestones":
      return (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={panel.title}>
          <Head kicker="Worth a high five" title={panel.title} />
          <List cols={panel.items.length > 4 ? 2 : 1}>
            {panel.items.map((m, i) => (
              <li key={i} className={ROW}>
                <span aria-hidden className="flex size-[clamp(2.25rem,6.4vh,4.75rem)] shrink-0 items-center justify-center rounded-full bg-[#fbbf24] text-[clamp(1.1rem,3.6vh,2.75rem)] font-black text-[#3b2a00]">
                  ★
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`truncate ${T.big}`}>{m.name}</p>
                  <p className={`truncate ${T.small} text-[#fde68a]`}>{m.label}</p>
                </div>
              </li>
            ))}
          </List>
        </section>
      );
    case "shoutouts":
      return (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={panel.title}>
          <Head kicker="From the coaching staff" title={panel.title} />
          <ul className={`grid min-h-0 flex-1 auto-rows-fr gap-[1.6vh] gap-x-[1.6vw] ${panel.items.length > 1 ? "md:grid-cols-2" : ""}`}>
            {panel.items.map((s, i) => (
              <li key={i} className="flex min-h-0 flex-col justify-center rounded-[1.6vh] bg-white/[0.055] px-[2.2vw] py-[1.6vh] ring-1 ring-white/10">
                <div className="flex flex-wrap items-center gap-x-[1.2vw] gap-y-1">
                  <p className={`min-w-0 truncate ${T.big}`}>{s.name}</p>
                  <Chip tone="gold">{s.headline}</Chip>
                </div>
                {s.note ? <p className={`mt-[1vh] line-clamp-3 ${T.mid} text-[#e6edf7]`}>&ldquo;{s.note}&rdquo;</p> : null}
                <p className={`mt-[1vh] truncate ${T.small} ${MUTED}`}>{s.coach}</p>
              </li>
            ))}
          </ul>
        </section>
      );
    case "challenges": {
      const c = panel.challenge;
      const unit = CHALLENGE_METRIC_UNIT[c.metric];
      const when = c.ended ? "Finished" : c.daysLeft === 1 ? "Last day" : `${c.daysLeft} days left`;
      return (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={`Team challenge: ${c.title}`}>
          <Head kicker={`Team challenge${c.groupName ? ` · ${c.groupName}` : ""}`} title={c.title} aside={<Chip tone={c.ended ? "plain" : "gold"}>{when}</Chip>} />
          {c.mode === "group_total" ? (
            <div className="mb-[2vh] shrink-0 rounded-[1.6vh] bg-white/[0.055] px-[2.2vw] py-[2vh] ring-1 ring-white/10">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <p className="leading-none">
                  <span className="text-[clamp(2.5rem,11vh,8.5rem)] leading-none font-black text-[#7fd3f7] tabular">{c.total}</span>
                  <span className={`ml-[1vw] ${T.mid} ${MUTED}`}>
                    of {c.target} {unit[1]}
                  </span>
                </p>
                <p className={`${T.mid} ${c.pct === 100 ? "text-[#4ade80]" : "text-white"}`}>{c.pct === 100 ? "Target reached. Great work, team." : `${c.pct}% there, together`}</p>
              </div>
              <div className="mt-[1.6vh] h-[3vh] min-h-3 w-full overflow-hidden rounded-full bg-white/15" role="img" aria-label={`${c.pct} percent of the team target`}>
                <div className={`h-full rounded-full ${c.pct === 100 ? "bg-[#4ade80]" : "bg-[#4fc3f7]"}`} style={{ width: `${Math.max(2, c.pct ?? 0)}%` }} />
              </div>
            </div>
          ) : (
            <p className={`mb-[1.6vh] shrink-0 ${T.mid} ${MUTED}`}>
              Goal: {plural(c.target, unit)} each · {CHALLENGE_METRIC_LABEL[c.metric].toLowerCase()} · {c.finishers > 0 ? `${c.finishers} finished so far` : `${c.active} on the board`}
            </p>
          )}
          <List cols={c.mode === "group_total" ? 2 : 1}>
            {c.leaders.slice(0, c.mode === "group_total" ? 4 : 5).map((r, i) => (
              <li key={i} className={ROW}>
                <Rank n={r.rank} />
                <p className={`min-w-0 flex-1 truncate ${c.mode === "group_total" ? T.mid : T.big}`}>{r.name}</p>
                {r.detail ? <Chip tone="green">{r.detail}</Chip> : null}
                <p className={`shrink-0 text-right text-[#7fd3f7] tabular ${c.mode === "group_total" ? T.mid : T.big}`}>{r.value}</p>
              </li>
            ))}
          </List>
        </section>
      );
    }
    case "message":
      return (
        <section className="flex min-h-0 flex-1 flex-col items-center justify-center text-center" aria-label={panel.title}>
          <p className={T.kicker}>{panel.title}</p>
          <p className="mt-[3vh] max-w-[84vw] text-[clamp(1.75rem,8.4vh,6.5rem)] leading-[1.12] font-extrabold tracking-tight text-balance">{panel.text}</p>
        </section>
      );
  }
}
