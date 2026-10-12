import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatInTimeZone } from "date-fns-tz";
import { parseMarkdown, type Inline } from "@/lib/forms/markdown";

/**
 * Renders a completed form to PDF with pdf-lib (no external services).
 * Contents: org name, form title + version + content hash, full body text,
 * submitted field values, signature evidence, and an integrity footer on every page.
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

const REPLACEMENTS: Record<string, string> = {
  "≤": "<=",
  "≥": ">=",
  "≠": "!=",
  "→": "->",
  "←": "<-",
  "✓": "[x]",
  "✔": "[x]",
  "✗": "[ ]",
  " ": " ",
  " ": " ",
  " ": " ",
  "​": "",
  "\t": "    ",
};

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont; mono: PDFFont };

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  private charset: Set<number>;

  constructor(
    private doc: PDFDocument,
    public fonts: Fonts,
  ) {
    this.charset = new Set(fonts.regular.getCharacterSet());
    this.newPage();
  }

  /** Map text to the WinAnsi subset the standard fonts can encode. */
  clean(s: string): string {
    let out = "";
    for (const ch of s.replace(/\r\n?/g, "\n")) {
      if (ch === "\n") {
        out += " ";
        continue;
      }
      if (ch in REPLACEMENTS) {
        out += REPLACEMENTS[ch];
        continue;
      }
      out += this.charset.has(ch.codePointAt(0)!) ? ch : "?";
    }
    return out;
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

  /** Word-wrapped rich text (mixed bold/italic runs). */
  rich(runs: Inline[], opts: { size?: number; indent?: number; color?: ReturnType<typeof rgb>; lineGap?: number; baseBold?: boolean; prefix?: string } = {}) {
    const size = opts.size ?? 10;
    const lh = size * (opts.lineGap ?? 1.4);
    const indent = opts.indent ?? 0;
    const maxW = CONTENT_W - indent;
    type Tok = { text: string; font: PDFFont };
    const toks: Tok[] = [];
    for (const r of runs) {
      const bold = r.bold || opts.baseBold;
      const font = bold && r.italic ? this.fonts.boldItalic : bold ? this.fonts.bold : r.italic ? this.fonts.italic : this.fonts.regular;
      for (const part of this.clean(r.text).split(/(\s+)/)) if (part) toks.push({ text: part, font });
    }
    const lines: Tok[][] = [];
    let line: Tok[] = [];
    let w = 0;
    const width = (t: Tok) => t.font.widthOfTextAtSize(t.text, size);
    for (const t of toks) {
      const isSpace = /^\s+$/.test(t.text);
      if (isSpace && line.length === 0) continue;
      let tw = width(t);
      if (!isSpace && w + tw > maxW && line.length) {
        while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop();
        lines.push(line);
        line = [];
        w = 0;
      }
      // Hard-break words longer than a full line (hashes, URLs).
      let tok = t;
      while (!isSpace && tw > maxW) {
        let cut = tok.text.length;
        while (cut > 1 && tok.font.widthOfTextAtSize(tok.text.slice(0, cut), size) > maxW) cut--;
        lines.push([{ text: tok.text.slice(0, cut), font: tok.font }]);
        tok = { text: tok.text.slice(cut), font: tok.font };
        tw = width(tok);
      }
      line.push(tok);
      w += tw;
    }
    if (line.length) lines.push(line);
    if (!lines.length) lines.push([]);
    lines.forEach((ln, i) => {
      this.ensure(lh);
      let x = MARGIN + indent;
      if (i === 0 && opts.prefix) {
        this.page.drawText(opts.prefix, { x: x - 12, y: this.y - size, size, font: this.fonts.regular, color: opts.color ?? INK });
      }
      for (const t of ln) {
        this.page.drawText(t.text, { x, y: this.y - size, size, font: t.font, color: opts.color ?? INK });
        x += width(t);
      }
      this.y -= lh;
    });
  }

  text(s: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; mono?: boolean } = {}) {
    if (opts.mono) {
      const size = opts.size ?? 8;
      const font = this.fonts.mono;
      const maxW = CONTENT_W - (opts.indent ?? 0);
      let rest = this.clean(s);
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

  /** Two-column key/value row, wrapping the value. */
  kv(label: string, value: string, opts: { labelW?: number; size?: number; mono?: boolean } = {}) {
    const size = opts.size ?? 9;
    const labelW = opts.labelW ?? 150;
    const lh = size * 1.4;
    const font = opts.mono ? this.fonts.mono : this.fonts.regular;
    const valueLines = this.wrap(this.clean(value || "—"), font, size, CONTENT_W - labelW);
    const labelLines = this.wrap(this.clean(label), this.fonts.bold, size, labelW - 10);
    const n = Math.max(valueLines.length, labelLines.length);
    for (let i = 0; i < n; i++) {
      this.ensure(lh);
      if (labelLines[i]) this.page.drawText(labelLines[i], { x: MARGIN, y: this.y - size, size, font: this.fonts.bold, color: MUTED });
      if (valueLines[i]) this.page.drawText(valueLines[i], { x: MARGIN + labelW, y: this.y - size, size, font, color: INK });
      this.y -= lh;
    }
  }

  /** Greedy word wrap with hard breaks for over-long tokens. */
  wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
    const words = text.split(/(\s+)/).filter(Boolean);
    const lines: string[] = [];
    let cur = "";
    for (const wd of words) {
      const next = cur + wd;
      if (font.widthOfTextAtSize(next.trimEnd(), size) > maxW && cur.trim()) {
        lines.push(cur.trimEnd());
        cur = /^\s+$/.test(wd) ? "" : wd;
      } else cur = next;
      while (font.widthOfTextAtSize(cur, size) > maxW) {
        let cut = cur.length;
        while (cut > 1 && font.widthOfTextAtSize(cur.slice(0, cut), size) > maxW) cut--;
        lines.push(cur.slice(0, cut));
        cur = cur.slice(cut);
      }
    }
    if (cur.trim() || !lines.length) lines.push(cur.trimEnd());
    return lines;
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

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
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
  w.text("Each signer typed their full legal name and checked the consent statement below. Times are shown in the facility timezone.", { size: 8.5, color: MUTED });
  w.gap(4);
  for (const s of input.signatures) {
    w.ensure(110);
    w.text(`${s.roleLabel}: ${s.signerName}`, { size: 10.5, bold: true });
    w.kv("Typed legal name", s.typedName);
    w.kv("Relationship", s.relationship ?? "—");
    w.kv("Signed at", zoned(s.signedAt, input.timezone));
    w.kv("Signed at (UTC)", s.signedAt.toISOString());
    w.kv("IP address", s.ip ?? "not recorded");
    w.kv("Authentication method", s.authMethod);
    w.kv("User agent", s.userAgent ?? "not recorded", { size: 8 });
    w.kv("Consent statement", s.consentText, { size: 8 });
    w.gap(6);
  }

  w.rule();
  w.text("Integrity", { size: 12, bold: true });
  w.text(
    "The integrity hash is SHA-256 over the template content hash, the submitted data, and every signature's evidence. Teamwork staff can recompute it in Teamwork Hub (Documents → request → Verify) to detect any change.",
    { size: 8.5, color: MUTED },
  );
  w.text(`Integrity SHA-256: ${input.integrityHash}`, { size: 8, mono: true });
  w.gap(4);
  w.text(
    "Pilot notice: typed-name e-signature pilot. This is not a complete production e-signature system and no claim is made about legal enforceability.",
    { size: 8, color: MUTED },
  );

  // Footer on every page.
  const total = w.pages.length;
  w.pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN + 22 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 22 }, thickness: 0.5, color: LINE });
    p.drawText(`Integrity SHA-256 ${input.integrityHash}`, { x: MARGIN, y: MARGIN + 10, size: 6.5, font: fonts.mono, color: MUTED });
    const label = `${input.orgName.replace(/[^\x20-\x7e]/g, "")} · Page ${i + 1} of ${total}`;
    p.drawText(label, { x: MARGIN, y: MARGIN, size: 7, font: fonts.regular, color: MUTED });
  });

  return doc.save({ useObjectStreams: false });
}
