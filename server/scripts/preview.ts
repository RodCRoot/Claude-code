/* Generates faithful previews of real seeded data (no browser available in CI):
 *  - SAMPLE-PROGRAM.md  : the program as a clean document
 *  - preview-program.svg: program detail rendered in the app's dark theme
 *  - preview-schedule.svg: the week board with the copy-day affordance
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "fs";
import { computeTargets } from "../src/prescription";
import { latestMaxesByExercise } from "../src/maxprofiles";

const prisma = new PrismaClient();

// theme
const BG = "#0f1218", PANEL = "#161a22", PANEL2 = "#1c2230", BORDER = "#2a2f3a";
const TEXT = "#e6e9ef", MUTED = "#8a93a6", TEAL = "#4fd1c5", AMBER = "#e0a85a", GREEN = "#5fbf7f";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function prescriptionLine(it: any, target: any): string {
  const bits: string[] = [];
  if (it.sets || it.reps) bits.push(`${it.sets ?? ""}${it.reps ? " × " + it.reps : ""}`);
  if (it.prescribeBy === "PCT" && it.targetPctE1rm) bits.push(`${Math.round(it.targetPctE1rm * 100)}% e1RM`);
  if (it.prescribeBy === "VELOCITY" && it.targetVelocity) bits.push(`@ ${it.targetVelocity} m/s`);
  if (it.prescribeBy === "ZONE" && it.velocityZone) bits.push(`${it.velocityZone} zone`);
  if (it.load && !bits.some((b) => b.includes(it.load))) bits.push(it.load);
  if (target?.display) bits.push(`→ ${target.display}`);
  return bits.join(" · ");
}

async function main() {
  const workouts = await prisma.workout.findMany({
    include: { blocks: { orderBy: { order: "asc" }, include: { items: { orderBy: { order: "asc" }, include: { exercise: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  // Use the VBT day as the showcase program (richest prescriptions).
  const prog = workouts.find((w) => /VBT/i.test(w.name)) ?? workouts[0];

  // Resolve targets for a representative athlete so the preview shows real loads.
  const athlete = await prisma.athlete.findFirst({ where: {}, orderBy: { lastName: "asc" } });
  const maxes: Record<string, number> = athlete ? await latestMaxesByExercise(athlete.id) : {};

  // ---- Markdown ----------------------------------------------------------
  let md = `# Sample Program — ${prog.name}\n\n`;
  if (prog.description) md += `_${prog.description}_\n\n`;
  md += `Targets shown for **${athlete?.firstName} ${athlete?.lastName}** (auto-scaled to their maxes).\n\n`;
  const rendered: { block: string; rows: { ex: string; line: string; notes: string }[] }[] = [];
  for (const b of prog.blocks) {
    const rows = b.items.map((it) => {
      const target = computeTargets(it as any, maxes[it.exerciseId] ?? null);
      return { ex: it.exercise.name, line: prescriptionLine(it, target), notes: it.notes ?? "" };
    });
    rendered.push({ block: b.name, rows });
    md += `## ${b.name}\n\n`;
    for (const r of rows) md += `- **${r.ex}** — ${r.line}${r.notes ? `  \n  _${r.notes}_` : ""}\n`;
    md += `\n`;
  }
  writeFileSync(`${__dirname}/../../SAMPLE-PROGRAM.md`, md);

  // ---- Program SVG -------------------------------------------------------
  {
    const W = 760;
    let y = 0;
    const parts: string[] = [];
    const line = (x: number, yy: number, t: string, fill: string, size: number, weight = "400", anchor = "start") =>
      `<text x="${x}" y="${yy}" fill="${fill}" font-size="${size}" font-weight="${weight}" font-family="Inter,Segoe UI,sans-serif" text-anchor="${anchor}">${esc(t)}</text>`;
    parts.push(line(28, (y += 44), prog.name, TEXT, 24, "700"));
    if (prog.description) parts.push(line(28, (y += 24), prog.description, MUTED, 13));
    parts.push(line(28, (y += 22), `Targets for ${athlete?.firstName} ${athlete?.lastName} · auto-scaled to maxes`, TEAL, 12));
    y += 14;
    const blockColors = [TEAL, AMBER, GREEN, "#b58cff"];
    rendered.forEach((b, bi) => {
      const rowH = 46, head = 30;
      const h = head + b.rows.length * rowH + 12;
      const top = (y += 16);
      parts.push(`<rect x="20" y="${top}" width="${W - 40}" height="${h}" rx="12" fill="${PANEL}" stroke="${BORDER}"/>`);
      parts.push(`<rect x="20" y="${top}" width="5" height="${h}" rx="2" fill="${blockColors[bi % 4]}"/>`);
      parts.push(line(40, top + 21, b.block, blockColors[bi % 4], 14, "700"));
      b.rows.forEach((r, ri) => {
        const ry = top + head + ri * rowH;
        if (ri > 0) parts.push(`<line x1="40" y1="${ry}" x2="${W - 40}" y2="${ry}" stroke="${BORDER}"/>`);
        parts.push(line(40, ry + 22, r.ex, TEXT, 15, "600"));
        parts.push(line(40, ry + 40, r.line, MUTED, 12.5));
      });
      y = top + h;
    });
    const H = y + 28;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${BG}"/>${parts.join("")}</svg>`;
    writeFileSync(`${__dirname}/../../preview-program.svg`, svg);
  }

  // ---- Schedule board SVG ------------------------------------------------
  {
    const thisMonday = new Date(); thisMonday.setHours(0, 0, 0, 0);
    thisMonday.setDate(thisMonday.getDate() - ((thisMonday.getDay() + 6) % 7));
    // Render the most-populated of the last 4 weeks so the board shows a real,
    // loaded program rather than an empty grid.
    let monday = thisMonday, best = -1;
    for (let w = 0; w < 4; w++) {
      const m = new Date(thisMonday); m.setDate(m.getDate() - w * 7);
      const e = new Date(m); e.setDate(e.getDate() + 7);
      const n = await prisma.workoutAssignment.count({ where: { assignedDate: { gte: m, lt: e }, athlete: {} } });
      if (n > best) { best = n; monday = m; }
    }
    const week = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return d; });
    const start = week[0], end = new Date(week[6]); end.setHours(23, 59, 59);
    const assigns = await prisma.workoutAssignment.findMany({
      where: { assignedDate: { gte: start, lte: end }, athlete: {} },
      include: { workout: { select: { name: true } } },
    });
    const byDay: Record<string, Record<string, { n: number; done: number }>> = {};
    for (const a of assigns) {
      const k = a.assignedDate.toISOString().slice(0, 10);
      const w = ((byDay[k] ||= {})[a.workout.name] ||= { n: 0, done: 0 });
      w.n++; if (a.status === "COMPLETED") w.done++;
    }
    const todayK = new Date().toISOString().slice(0, 10);
    // Pick a populated source day and the next day as the paste target, to
    // showcase the copy-day affordance over real content.
    const populated = week.map((d) => d.toISOString().slice(0, 10)).filter((k) => byDay[k]);
    const srcK = populated[0];
    const pasteIdx = week.findIndex((d) => d.toISOString().slice(0, 10) === srcK) + 1;
    const pasteK = week[Math.min(pasteIdx, 6)]?.toISOString().slice(0, 10);

    const colW = 150, gap = 12, padX = 20, top = 96, colH = 300;
    const W = padX * 2 + 7 * colW + 6 * gap, H = top + colH + 30;
    const t = (x: number, y: number, s: string, fill: string, size: number, weight = "400", anchor = "start") =>
      `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" font-family="Inter,Segoe UI,sans-serif" text-anchor="${anchor}">${esc(s)}</text>`;
    const parts: string[] = [];
    parts.push(t(padX, 44, "Schedule", TEXT, 24, "700"));
    parts.push(t(padX, 68, "Week of " + monday.toLocaleDateString(undefined, { month: "long", day: "numeric" }) + "  ·  column-per-day board", MUTED, 13));
    week.forEach((d, i) => {
      const x = padX + i * (colW + gap), k = d.toISOString().slice(0, 10);
      const isToday = k === todayK, isSrc = k === srcK, isPaste = k === pasteK;
      parts.push(`<rect x="${x}" y="${top}" width="${colW}" height="${colH}" rx="12" fill="${PANEL}" stroke="${isToday ? TEAL : isSrc ? AMBER : BORDER}" stroke-width="${isToday || isSrc ? 2 : 1}" ${isSrc ? 'stroke-dasharray="5 4"' : ""}/>`);
      parts.push(t(x + 14, top + 26, d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase(), isToday ? TEAL : TEXT, 13, "700"));
      parts.push(t(x + 14, top + 44, d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), MUTED, 11));
      // copy-day affordance (showcases the new feature)
      if (isSrc) parts.push(t(x + 14, top + 64, "Copying — pick a day ✕", AMBER, 11, "600"));
      else if (isPaste) parts.push(t(x + 14, top + 64, "↳ Paste here", TEAL, 11, "700"));
      else parts.push(t(x + 14, top + 64, "⧉ Copy day", "#3a6f6a", 11));
      let cy = top + 86;
      const ws = byDay[k] || {};
      const entries = Object.entries(ws);
      if (!entries.length) parts.push(t(x + colW / 2, cy + 10, "—", MUTED, 13, "400", "middle"));
      entries.slice(0, 4).forEach(([name, w]) => {
        parts.push(`<rect x="${x + 10}" y="${cy}" width="${colW - 20}" height="44" rx="8" fill="${PANEL2}"/>`);
        const short = name.length > 18 ? name.slice(0, 17) + "…" : name;
        parts.push(t(x + 20, cy + 19, short, TEXT, 12, "600"));
        parts.push(t(x + 20, cy + 35, `${w.done}/${w.n} done`, w.done === w.n && w.n ? GREEN : MUTED, 11));
        cy += 50;
      });
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${BG}"/>${parts.join("")}</svg>`;
    writeFileSync(`${__dirname}/../../preview-schedule.svg`, svg);
  }

  console.log("Wrote SAMPLE-PROGRAM.md, preview-program.svg, preview-schedule.svg");
}

main().finally(() => prisma.$disconnect());
