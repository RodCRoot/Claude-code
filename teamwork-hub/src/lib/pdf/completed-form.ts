import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatInTimeZone } from "date-fns-tz";
import { parseMarkdown, type Inline } from "@/lib/forms/markdown";
import { PdfFonts, type Run } from "./fonts";

/**
 * Renders a completed form to PDF with pdf-lib (no external services).
 * Contents: org name, form title + version + content hash, full body text,
 * submitted field values, signature evidence, and an integrity footer on every page.
 * Text is set in embedded Unicode fonts (Noto Sans + CJK fallbacks, see ./fonts.ts),
 * so names and answers in any bundled script render as typed.
 */

export type PdfSignature = {
  roleLabel: string;
  signerName: string;
  relationship: string | null;
  typedName: string;
  consentText: string;
  signedAt: Date;
  ip: string | null;
  userAgent: string | null;
  /** Human-readable identity verification (describeAuthMethod). */
  authMethodLabel: string;
  /** Raw `auth_method` evidence value, exactly as stored and hashed. */
  authMethod: string;
};

export type CompletedFormPdfInput = {
  orgName: string;
  timezone: string;
  requestId: string;
  templateName: string;
  title: string;
  version: number;
  contentHash: string;
  isSampleText: boolean;
  bodyMarkdown: string;
  subjectName: string;
  fields: { key: string; label: string }[];
  values: Record<string, string>;
  signatures: PdfSignature[];
  completedAt: Date;
  integrityHash: string;
};

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const FOOTER_H = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.38, 0.41, 0.47);
const LINE = rgb(0.82, 0.84, 0.88);
const WARN = rgb(0.6, 0.27, 0.02);

export const PDF_PILOT_NOTICE =
  "Pilot notice: typed-name e-signature pilot with signer identity verification as recorded above. " +
  "This is not a complete production e-signature system and no claim is made about legal enforceability.";

type Color = ReturnType<typeof rgb>;
const isSpace = (t: Run) => /^\s+$/.test(t.text);

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];

  constructor(
    private doc: PDFDocument,
    public fonts: PdfFonts,
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  ensure(h: number) {
    if (this.y - h < MARGIN + FOOTER_H) this.newPage();
  }

  gap(h: number) {
    this.y -= h;
  }

  /** Whitespace-separated tokens, each split into single-font runs. */
  tokens(text: string, font: PDFFont): Run[] {
    const out: Run[] = [];
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) out.push({ text: " ", font });
      else out.push(...this.fonts.split(part, font));
    }
    return out;
  }

  width(t: Run, size: number) {
    return t.font.widthOfTextAtSize(t.text, size);
  }

  /** Greedy wrap; tokens longer than a line (hashes, CJK without spaces) are broken by code point. */
  lines(toks: Run[], size: number, maxW: number): Run[][] {
    const lines: Run[][] = [];
    let line: Run[] = [];
    let w = 0;
    const flush = () => {
      while (line.length && isSpace(line[line.length - 1])) line.pop();
      lines.push(line);
      line = [];
      w = 0;
    };
    const push = (t: Run, tw: number) => {
      line.push(t);
      w += tw;
    };
    for (const t of toks) {
      const tw = this.width(t, size);
      if (isSpace(t)) {
        if (line.length) push(t, tw);
        continue;
      }
      if (w + tw <= maxW) {
        push(t, tw);
        continue;
      }
      if (line.length && tw <= maxW) {
        flush();
        push(t, tw);
        continue;
      }
      // Longer than the remaining space and than a whole line: break by code point.
      const chars = Array.from(t.text);
      let i = 0;
      while (i < chars.length) {
        const wOf = (end: number) => t.font.widthOfTextAtSize(chars.slice(i, end).join(""), size);
        let cut = chars.length;
        while (cut > i + 1 && w + wOf(cut) > maxW) cut--;
        if (cut === i + 1 && line.length && w + wOf(cut) > maxW) {
          flush();
          continue;
        }
        push({ text: chars.slice(i, cut).join(""), font: t.font }, wOf(cut));
        i = cut;
        if (i < chars.length) flush();
      }
    }
    if (line.length) flush();
    if (!lines.length) lines.push([]);
    return lines;
  }

  drawLine(line: Run[], x: number, size: number, color: Color) {
    for (const t of line) {
      this.page.drawText(t.text, { x, y: this.y - size, size, font: t.font, color });
      x += this.width(t, size);
    }
  }

  /** Word-wrapped rich text (mixed bold/italic runs). */
  rich(runs: Inline[], opts: { size?: number; indent?: number; color?: Color; lineGap?: number; baseBold?: boolean; prefix?: string } = {}) {
    const size = opts.size ?? 10;
    const lh = size * (opts.lineGap ?? 1.4);
    const indent = opts.indent ?? 0;
    const f = this.fonts;
    const toks: Run[] = [];
    for (const r of runs) {
      const bold = r.bold || opts.baseBold;
      const font = bold && r.italic ? f.boldItalic : bold ? f.bold : r.italic ? f.italic : f.regular;
      toks.push(...this.tokens(r.text, font));
    }
    this.lines(toks, size, CONTENT_W - indent).forEach((ln, i) => {
      this.ensure(lh);
      if (i === 0 && opts.prefix) this.drawLine(this.fonts.split(opts.prefix, f.regular), MARGIN + indent - 12, size, opts.color ?? INK);
      this.drawLine(ln, MARGIN + indent, size, opts.color ?? INK);
      this.y -= lh;
    });
  }

  text(s: string, opts: { size?: number; bold?: boolean; color?: Color; indent?: number; mono?: boolean } = {}) {
    // Courier (WinAnsi) only for plain ASCII such as hashes; anything else uses the Unicode fonts.
    if (opts.mono && /^[\x20-\x7e]*$/.test(s)) {
      const size = opts.size ?? 8;
      const font = this.fonts.mono;
      const maxW = CONTENT_W - (opts.indent ?? 0);
      let rest = s;
      while (rest.length) {
        let cut = rest.length;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxW) cut--;
        this.ensure(size * 1.4);
        this.page.drawText(rest.slice(0, cut), { x: MARGIN + (opts.indent ?? 0), y: this.y - size, size, font, color: opts.color ?? INK });
        this.y -= size * 1.4;
        rest = rest.slice(cut);
      }
      return;
    }
    this.rich([{ text: s, bold: opts.bold }], { size: opts.size, color: opts.color, indent: opts.indent });
  }

  rule() {
    this.ensure(10);
    this.page.drawLine({ start: { x: MARGIN, y: this.y - 4 }, end: { x: PAGE_W - MARGIN, y: this.y - 4 }, thickness: 0.6, color: LINE });
    this.y -= 12;
  }

  /** Two-column key/value row, wrapping both columns. */
  kv(label: string, value: string, opts: { labelW?: number; size?: number } = {}) {
    const size = opts.size ?? 9;
    const labelW = opts.labelW ?? 150;
    const lh = size * 1.4;
    const valueLines = this.lines(this.tokens(value || "—", this.fonts.regular), size, CONTENT_W - labelW);
    const labelLines = this.lines(this.tokens(label, this.fonts.bold), size, labelW - 10);
    const n = Math.max(valueLines.length, labelLines.length);
    for (let i = 0; i < n; i++) {
      this.ensure(lh);
      if (labelLines[i]) this.drawLine(labelLines[i], MARGIN, size, MUTED);
      if (valueLines[i]) this.drawLine(valueLines[i], MARGIN + labelW, size, INK);
      this.y -= lh;
    }
  }
}

function zoned(d: Date, tz: string) {
  return formatInTimeZone(d, tz, "yyyy-MM-dd HH:mm:ss zzz (xxx)");
}

export async function renderCompletedFormPdf(input: CompletedFormPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${input.title} — v${input.version}`);
  doc.setSubject(`Completed form ${input.requestId}`);
  doc.setAuthor(input.orgName);
  doc.setCreator("Teamwork Hub");
  doc.setProducer("Teamwork Hub (pdf-lib)");
  doc.setKeywords([`integrity:${input.integrityHash}`, `content:${input.contentHash}`]);
  doc.setCreationDate(input.completedAt);
  doc.setModificationDate(input.completedAt);

  // Every drawn string, so CJK fallbacks are embedded only when needed.
  const fonts = await PdfFonts.embed(doc, JSON.stringify(input));
  const w = new Writer(doc, fonts);

  // Header
  w.text(input.orgName, { size: 11, bold: true, color: MUTED });
  w.gap(2);
  w.text(input.title, { size: 18, bold: true });
  w.text(`${input.templateName} · Version ${input.version} · Subject: ${input.subjectName}`, { size: 9, color: MUTED });
  w.text(`Completed ${zoned(input.completedAt, input.timezone)} · Request ${input.requestId}`, { size: 9, color: MUTED });
  w.text(`Template content SHA-256: ${input.contentHash}`, { size: 7.5, mono: true, color: MUTED });
  if (input.isSampleText) {
    w.gap(4);
    w.text("SAMPLE TEXT — replace with Teamwork-approved language. This document was signed on sample wording.", { size: 9, bold: true, color: WARN });
  }
  w.rule();

  // Body
  for (const b of parseMarkdown(input.bodyMarkdown)) {
    if (b.type === "heading") {
      w.gap(4);
      w.rich(b.inlines, { size: b.level === 1 ? 14 : b.level === 2 ? 12 : 10.5, baseBold: true });
    } else if (b.type === "paragraph") {
      w.rich(b.inlines, { size: 10 });
      w.gap(4);
    } else if (b.type === "list") {
      b.items.forEach((it, i) => w.rich(it, { size: 10, indent: 16, prefix: b.ordered ? `${i + 1}.` : "•" }));
      w.gap(4);
    } else {
      w.rule();
    }
  }

  // Submitted values
  if (input.fields.length) {
    w.rule();
    w.text("Submitted information", { size: 12, bold: true });
    w.gap(2);
    for (const f of input.fields) w.kv(f.label, input.values[f.key] ?? "—");
  }

  // Signature evidence
  w.rule();
  w.text("Signature evidence", { size: 12, bold: true });
  w.text(
    "Each signer typed their full legal name and checked the consent statement below. Identity verification shows how the signer's identity was checked before the signature was accepted. Times are shown in the facility timezone.",
    { size: 8.5, color: MUTED },
  );
  w.gap(4);
  for (const s of input.signatures) {
    w.ensure(130);
    w.text(`${s.roleLabel}: ${s.signerName}`, { size: 10.5, bold: true });
    w.kv("Typed legal name", s.typedName);
    w.kv("Relationship", s.relationship ?? "—");
    w.kv("Signed at", zoned(s.signedAt, input.timezone));
    w.kv("Signed at (UTC)", s.signedAt.toISOString());
    w.kv("IP address", s.ip ?? "not recorded");
    w.kv("Identity verification", s.authMethodLabel);
    w.kv("auth_method (evidence)", s.authMethod, { size: 8 });
    w.kv("User agent", s.userAgent ?? "not recorded", { size: 8 });
    w.kv("Consent statement", s.consentText, { size: 8 });
    w.gap(6);
  }

  w.rule();
  w.text("Integrity", { size: 12, bold: true });
  w.text(
    "The integrity hash is SHA-256 over the template content hash, the submitted data, and every signature's evidence (including its auth_method). Teamwork staff can recompute it in Teamwork Hub (Documents → request → Verify) to detect any change.",
    { size: 8.5, color: MUTED },
  );
  w.text(`Integrity SHA-256: ${input.integrityHash}`, { size: 8, mono: true });
  w.gap(4);
  w.text(PDF_PILOT_NOTICE, { size: 8, color: MUTED });

  // Footer on every page.
  const total = w.pages.length;
  w.pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN + 22 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 22 }, thickness: 0.5, color: LINE });
    p.drawText(`Integrity SHA-256 ${input.integrityHash}`, { x: MARGIN, y: MARGIN + 10, size: 6.5, font: fonts.mono, color: MUTED });
    let x = MARGIN;
    for (const r of fonts.split(`${input.orgName} · Page ${i + 1} of ${total}`, fonts.regular)) {
      p.drawText(r.text, { x, y: MARGIN, size: 7, font: r.font, color: MUTED });
      x += r.font.widthOfTextAtSize(r.text, 7);
    }
  });

  return doc.save({ useObjectStreams: false });
}
