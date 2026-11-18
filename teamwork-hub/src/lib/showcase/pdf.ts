import { createHash } from "node:crypto";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { PdfFonts } from "@/lib/pdf/fonts";
import { SHOWCASE_DATA_KEYS, prettyDate, sparklinePoints, type ShowcaseData } from "./compose";

/**
 * One-page Showcase PDF (pdf-lib, the same embedded Noto Sans fonts as completed forms). It is
 * drawn from the SAME payload as the public page (`ShowcaseData`), so it cannot show anything
 * the allowlist does not. The content hash (SHA-256 of that payload) is printed in the footer
 * and stored in the PDF keywords, so a copy can be matched to what was shown on a given day.
 */

const PAGE_W = 612;
const PAGE_H = 792;
const M = 42;
const W = PAGE_W - 2 * M;

const NAVY = rgb(0.075, 0.125, 0.227);
const NAVY_2 = rgb(0.102, 0.176, 0.322);
const CYAN = rgb(0.498, 0.827, 0.969);
const INK = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.36, 0.4, 0.47);
const LINE = rgb(0.86, 0.88, 0.92);
const PANEL = rgb(0.96, 0.97, 0.985);
const GREEN = rgb(0.02, 0.45, 0.27);
const WHITE = rgb(1, 1, 1);
const SOFT = rgb(0.79, 0.83, 0.9);

type Color = ReturnType<typeof rgb>;

function hexColor(hex: string): Color {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0.11, 0.31, 0.85);
}

/** SHA-256 over the payload with a fixed key order. */
export function showcaseContentHash(data: ShowcaseData): string {
  const ordered = Object.fromEntries(SHOWCASE_DATA_KEYS.map((k) => [k, data[k]]));
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

class Sheet {
  page: PDFPage;
  y: number;
  pages: PDFPage[] = [];
  constructor(
    private doc: PDFDocument,
    public fonts: PdfFonts,
  ) {
    this.page = doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - M;
  }
  ensure(h: number) {
    if (this.y - h < M + 34) {
      this.page = this.doc.addPage([PAGE_W, PAGE_H]);
      this.pages.push(this.page);
      this.y = PAGE_H - M;
    }
  }
  width(text: string, size: number, font: PDFFont) {
    return this.fonts.split(text, font).reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, size), 0);
  }
  /** Draw one line at (x, y) on a given page; returns its width. */
  draw(text: string, x: number, y: number, size: number, font: PDFFont, color: Color, page = this.page) {
    let cx = x;
    for (const r of this.fonts.split(text, font)) {
      page.drawText(r.text, { x: cx, y, size, font: r.font, color });
      cx += r.font.widthOfTextAtSize(r.text, size);
    }
    return cx - x;
  }
  wrap(text: string, maxW: number, size: number, font: PDFFont): string[] {
    const lines: string[] = [];
    for (const para of this.fonts.clean(text.replace(/\n/g, "   ")).split(" ")) {
      let line = "";
      for (const word of para.trim().split(/\s+/)) {
        if (!word) continue;
        const next = line ? `${line} ${word}` : word;
        if (line && this.width(next, size, font) > maxW) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      if (line) lines.push(line);
    }
    return lines;
  }
  /** Wrapped paragraph at the cursor; moves the cursor down. */
  para(text: string, opts: { size: number; font?: PDFFont; color?: Color; x?: number; maxW?: number; leading?: number }) {
    const font = opts.font ?? this.fonts.regular;
    const x = opts.x ?? M;
    const lead = opts.leading ?? opts.size * 1.38;
    for (const line of this.wrap(text, opts.maxW ?? W - (x - M), opts.size, font)) {
      this.ensure(lead);
      this.y -= lead;
      this.draw(line, x, this.y, opts.size, font, opts.color ?? INK);
    }
  }
  heading(text: string) {
    this.ensure(30);
    this.y -= 20;
    this.draw(text.toUpperCase(), M, this.y, 8, this.fonts.bold, MUTED);
    this.y -= 5;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: PAGE_W - M, y: this.y }, thickness: 0.6, color: LINE });
  }
}

export async function renderShowcasePdf(data: ShowcaseData, opts: { generatedAt?: Date; draft?: boolean } = {}): Promise<{ bytes: Uint8Array; contentHash: string }> {
  const contentHash = showcaseContentHash(data);
  const generatedAt = opts.generatedAt ?? new Date();
  const doc = await PDFDocument.create();
  doc.setTitle(`${data.displayName}: Athlete Showcase`);
  doc.setSubject(`Athlete Showcase, numbers recorded at ${data.org.name}`);
  doc.setAuthor(data.org.name);
  doc.setCreator("Teamwork Hub");
  doc.setProducer("Teamwork Hub (pdf-lib)");
  doc.setKeywords([`content:${contentHash}`]);
  doc.setCreationDate(generatedAt);
  doc.setModificationDate(generatedAt);
  const fonts = await PdfFonts.embed(doc, JSON.stringify(data));
  const s = new Sheet(doc, fonts);
  const p = s.page;
  const brand = hexColor(data.org.primaryColor);

  // --- Header band -------------------------------------------------------------------------
  const bandH = 104;
  p.drawRectangle({ x: 0, y: PAGE_H - bandH, width: PAGE_W, height: bandH, color: NAVY });
  p.drawRectangle({ x: PAGE_W * 0.55, y: PAGE_H - bandH, width: PAGE_W * 0.45, height: bandH, color: NAVY_2, opacity: 0.55 });
  p.drawRectangle({ x: 0, y: PAGE_H - bandH - 3, width: PAGE_W, height: 3, color: brand });
  s.draw(`${data.org.name.toUpperCase()}  ·  ATHLETE SHOWCASE${opts.draft ? "  ·  DRAFT, NOT PUBLISHED" : ""}`, M, PAGE_H - 34, 8, fonts.bold, CYAN);
  s.draw(data.displayName, M, PAGE_H - 66, 26, fonts.bold, WHITE);
  if (data.headline) s.draw(data.headline, M, PAGE_H - 86, 11, fonts.regular, SOFT);
  s.y = PAGE_H - bandH - 3;

  // --- Facts and bio ------------------------------------------------------------------------
  const facts = [...data.facts, ...data.consistency];
  if (facts.length) {
    s.y -= 12;
    const perRow = Math.min(4, facts.length);
    const colW = W / perRow;
    for (let i = 0; i < facts.length; i += perRow) {
      s.ensure(34);
      facts.slice(i, i + perRow).forEach((f, j) => {
        s.draw(f.label.toUpperCase(), M + j * colW, s.y - 10, 6.5, fonts.bold, MUTED);
        const lines = s.wrap(f.value, colW - 8, 11, fonts.bold);
        s.draw(lines[0] ?? "", M + j * colW, s.y - 24, 11, fonts.bold, INK);
      });
      s.y -= 32;
    }
  }
  if (data.bio) {
    s.y -= 2;
    s.para(data.bio, { size: 9.5, color: INK, leading: 13.5 });
  }

  // --- Test results: three compact tiles per row ----------------------------------------------
  if (data.tiles.length) {
    s.heading("Test results");
    const cols = 3;
    const gap = 8;
    const tileW = (W - gap * (cols - 1)) / cols;
    const tileH = 66;
    for (let i = 0; i < data.tiles.length; i += cols) {
      s.ensure(tileH + 8);
      s.y -= 8;
      const top = s.y;
      data.tiles.slice(i, i + cols).forEach((t, j) => {
        const x = M + j * (tileW + gap);
        s.page.drawRectangle({ x, y: top - tileH, width: tileW, height: tileH, color: PANEL, borderColor: LINE, borderWidth: 0.6 });
        s.draw(s.wrap(t.name, tileW - 16, 8, fonts.bold)[0] ?? "", x + 8, top - 13, 8, fonts.bold, INK);
        const vw = s.draw(t.latest.text, x + 8, top - 35, 18, fonts.bold, INK);
        s.draw(t.unit, x + 11 + vw, top - 35, 8.5, fonts.regular, MUTED);
        const dateLine = t.latest.verified ? `Verified by ${data.org.name} on ${prettyDate(t.latest.date)}` : `Recorded ${prettyDate(t.latest.date)} (not verified)`;
        s.draw(dateLine, x + 8, top - 47, 6.3, t.latest.verified ? fonts.bold : fonts.regular, t.latest.verified ? GREEN : MUTED);
        const bestLine = t.best && t.best.date !== t.latest.date ? `Best ${t.best.text} ${t.unit} on ${prettyDate(t.best.date)}` : t.best ? `Personal best  ·  ${t.testName}` : t.testName;
        s.draw(s.wrap(bestLine, tileW - 16, 6.3, fonts.regular)[0] ?? "", x + 8, top - 57, 6.3, fonts.regular, MUTED);
        if (t.trend) {
          const sw = 50;
          const sh = 20;
          const sx = x + tileW - sw - 8;
          const sy = top - 38;
          const pts = sparklinePoints(t.trend.values, sw, sh);
          for (let k = 1; k < pts.length; k++) {
            s.page.drawLine({ start: { x: sx + pts[k - 1].x, y: sy + (sh - pts[k - 1].y) }, end: { x: sx + pts[k].x, y: sy + (sh - pts[k].y) }, thickness: 1.3, color: brand });
          }
          const last = pts[pts.length - 1];
          s.page.drawCircle({ x: sx + last.x, y: sy + (sh - last.y), size: 2, color: brand });
        }
      });
      s.y = top - tileH;
    }
  }

  // --- Lift maxes: two columns ----------------------------------------------------------------
  if (data.lifts.length) {
    s.heading("Strength");
    const colW = (W - 20) / 2;
    for (let i = 0; i < data.lifts.length; i += 2) {
      s.ensure(28);
      const top = s.y;
      data.lifts.slice(i, i + 2).forEach((l, j) => {
        const x = M + j * (colW + 20);
        s.draw(l.name, x, top - 14, 9, fonts.bold, INK);
        const val = `${l.text} ${l.unit}`;
        s.draw(val, x + colW - s.width(val, 10.5, fonts.bold), top - 14, 10.5, fonts.bold, INK);
        const detail = [`${l.basisLabel} max`, l.verified ? `verified by ${data.org.name} on ${prettyDate(l.date)}` : prettyDate(l.date), l.relative].filter(Boolean).join("  ·  ");
        s.draw(s.wrap(detail, colW, 6.5, fonts.regular)[0] ?? "", x, top - 23, 6.5, fonts.regular, l.verified ? GREEN : MUTED);
        s.page.drawLine({ start: { x, y: top - 27 }, end: { x: x + colW, y: top - 27 }, thickness: 0.4, color: LINE });
      });
      s.y = top - 27;
    }
  }

  // --- Video and contact --------------------------------------------------------------------
  if (data.videoUrl || data.contactEmail) {
    s.heading("Links");
    if (data.videoUrl) s.para(`Highlight video: ${data.videoUrl}`, { size: 8.5 });
    if (data.contactEmail) s.para(`Contact: ${data.contactEmail}`, { size: 8.5 });
  }

  // --- Methods ------------------------------------------------------------------------------
  s.heading("How these numbers were recorded");
  s.y -= 2;
  s.para(`Every number on this page was recorded at ${data.org.name} on the date shown next to it. "Verified" means a coach entered it or it was imported from a testing device; results an athlete or family typed in are never marked verified.`, { size: 6.8, color: MUTED, leading: 9 });
  for (const m of data.methods) s.para(`${m.name}: ${m.text}`, { size: 6.8, color: MUTED, leading: 9 });

  // --- Footer on every page -----------------------------------------------------------------
  s.pages.forEach((pg, i) => {
    pg.drawLine({ start: { x: M, y: M + 18 }, end: { x: PAGE_W - M, y: M + 18 }, thickness: 0.5, color: LINE });
    s.draw(`${data.org.name}  ·  Showcase as of ${prettyDate(data.asOf)}  ·  Page ${i + 1} of ${s.pages.length}`, M, M + 7, 7, fonts.regular, MUTED, pg);
    pg.drawText(`Content SHA-256 ${contentHash}`, { x: M, y: M - 3, size: 6, font: fonts.mono, color: MUTED });
  });

  return { bytes: await doc.save({ useObjectStreams: false }), contentHash };
}
