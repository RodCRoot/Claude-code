import { readFileSync } from "node:fs";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { StandardFonts, type PDFDocument, type PDFFont } from "pdf-lib";

/**
 * Unicode fonts for generated PDFs: Noto Sans (Latin incl. diacritics, Greek, Cyrillic,
 * Vietnamese) plus Noto Sans SC (Han ideographs, kana) and a Hangul subset of Noto Sans KR
 * as fallbacks. All SIL Open Font License 1.1 — see assets/fonts/OFL-*.txt; rebuilt by
 * scripts/fonts/build-pdf-fonts.py. Fonts are subset-embedded (only used glyphs), and
 * the large CJK fallbacks are loaded only when the text needs them.
 */

export const FONT_DIR = path.join(process.cwd(), "assets", "fonts");

const FILES = {
  regular: "NotoSans-Regular.ttf",
  bold: "NotoSans-Bold.ttf",
  italic: "NotoSans-Italic.ttf",
  boldItalic: "NotoSans-BoldItalic.ttf",
  cjk: "NotoSansSC-Regular.ttf",
  hangul: "NotoSansKR-Hangul.ttf",
} as const;
type FontKey = keyof typeof FILES;

const bytesCache = new Map<FontKey, Uint8Array>();
function fontBytes(key: FontKey): Uint8Array {
  let b = bytesCache.get(key);
  if (!b) {
    b = new Uint8Array(readFileSync(path.join(FONT_DIR, FILES[key])));
    bytesCache.set(key, b);
  }
  return b;
}

/** Code points each font file covers (parsed once per process, without embedding). */
const coverageCache = new Map<FontKey, Set<number>>();
export function fontCoverage(key: FontKey): Set<number> {
  let c = coverageCache.get(key);
  if (!c) {
    c = new Set(fontkit.create(Buffer.from(fontBytes(key))).characterSet);
    coverageCache.set(key, c);
  }
  return c;
}

/** Visual stand-ins for characters no bundled font covers. */
const REPLACEMENTS: Record<string, string> = {
  "✓": "[x]",
  "✔": "[x]",
  "✗": "[ ]",
  " ": " ",
  " ": " ",
  " ": " ",
  "​": "",
  "‍": "",
  "﻿": "",
  "\t": "    ",
};

export type Run = { text: string; font: PDFFont };

export class PdfFonts {
  private covers = new Map<PDFFont, Set<number>>();
  private constructor(
    public regular: PDFFont,
    public bold: PDFFont,
    public italic: PDFFont,
    public boldItalic: PDFFont,
    /** Hex hashes only (ASCII): WinAnsi Courier keeps fixed-width columns. */
    public mono: PDFFont,
    private fallbacks: PDFFont[],
  ) {
    const base = fontCoverage("regular");
    for (const f of [regular, bold, italic, boldItalic]) this.covers.set(f, base);
  }

  /**
   * Embed the fonts into `doc`. `sample` is every string that will be drawn: CJK / Hangul
   * fallbacks are embedded only if it contains characters Noto Sans lacks.
   */
  static async embed(doc: PDFDocument, sample: string): Promise<PdfFonts> {
    doc.registerFontkit(fontkit);
    const embed = (k: FontKey) => doc.embedFont(fontBytes(k), { subset: true });
    const base = fontCoverage("regular");
    let needCjk = false;
    let needHangul = false;
    for (const ch of sample) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80 || base.has(cp)) continue;
      if (!needCjk && fontCoverage("cjk").has(cp)) needCjk = true;
      else if (!needHangul && !fontCoverage("cjk").has(cp) && fontCoverage("hangul").has(cp)) needHangul = true;
      if (needCjk && needHangul) break;
    }
    const fallbacks: PDFFont[] = [];
    const fs = new PdfFonts(
      await embed("regular"),
      await embed("bold"),
      await embed("italic"),
      await embed("boldItalic"),
      await doc.embedFont(StandardFonts.Courier),
      fallbacks,
    );
    if (needCjk) {
      const f = await embed("cjk");
      fallbacks.push(f);
      fs.covers.set(f, fontCoverage("cjk"));
    }
    if (needHangul) {
      const f = await embed("hangul");
      fallbacks.push(f);
      fs.covers.set(f, fontCoverage("hangul"));
    }
    return fs;
  }

  private has(font: PDFFont, cp: number) {
    return this.covers.get(font)?.has(cp) ?? false;
  }

  /** NFC-normalize, flatten newlines, and apply stand-ins only where no font has the glyph. */
  clean(s: string): string {
    let out = "";
    for (const ch of s.normalize("NFC").replace(/\r\n?/g, "\n")) {
      if (ch === "\n") out += " ";
      else if (ch in REPLACEMENTS && !this.covered(ch.codePointAt(0)!)) out += REPLACEMENTS[ch];
      else out += ch;
    }
    return out;
  }

  private covered(cp: number) {
    if (this.has(this.regular, cp)) return true;
    return this.fallbacks.some((f) => this.has(f, cp));
  }

  /** Split text into runs drawable with one font each (preferred style first, then fallbacks). */
  split(text: string, preferred: PDFFont): Run[] {
    const runs: Run[] = [];
    for (const ch of this.clean(text)) {
      const cp = ch.codePointAt(0)!;
      let font = preferred;
      let out = ch;
      if (!this.has(preferred, cp) && !/\s/.test(ch)) {
        const fb = this.fallbacks.find((f) => this.has(f, cp));
        if (fb) font = fb;
        else out = "?"; // nothing bundled covers it (e.g. emoji); the DB keeps the original
      }
      const last = runs[runs.length - 1];
      if (last && last.font === font) last.text += out;
      else runs.push({ text: out, font });
    }
    return runs;
  }
}
