import fontkit from "@pdf-lib/fontkit";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, type PDFObject } from "pdf-lib";

/**
 * Minimal text extraction for PDFs written by pdf-lib (tests only): follows each font's
 * ToUnicode CMap, so it reads back exactly what a PDF viewer would copy/search.
 * Also reports, per drawn character, whether the embedded glyph has an outline.
 */

type FontInfo = {
  name: string;
  baseFont: string;
  /** CID (hex, 4 digits) → text, for Type0 fonts. */
  toUnicode: Map<string, string> | null;
  /** Parsed embedded TrueType program (subset), for glyph checks. */
  program: ReturnType<typeof fontkit.create> | null;
};

function bytesOf(doc: PDFDocument, obj: PDFObject | undefined): Uint8Array | null {
  const o = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  if (o instanceof PDFRawStream) return decodePDFRawStream(o).decode();
  return null;
}

function parseCMap(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const utf16 = (hex: string) => {
    let s = "";
    for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  };
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(m[1].toUpperCase().padStart(4, "0"), utf16(m[2]));
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const dst = utf16(m[3]);
      for (let c = lo; c <= hi; c++) map.set(c.toString(16).toUpperCase().padStart(4, "0"), dst.slice(0, -1) + String.fromCharCode(dst.charCodeAt(dst.length - 1) + (c - lo)));
    }
  }
  return map;
}

export type ExtractedPdf = {
  text: string;
  fonts: string[];
  /** Characters drawn with an embedded glyph that has no outline (should be only spaces). */
  blankGlyphs: string[];
};

export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedPdf> {
  const doc = await PDFDocument.load(bytes);
  let text = "";
  const blank: string[] = [];
  const allFonts = new Set<string>();
  for (const page of doc.getPages()) {
    const fontsDict = page.node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
    const fonts = new Map<string, FontInfo>();
    for (const [key, ref] of fontsDict?.entries() ?? []) {
      const fd = doc.context.lookup(ref, PDFDict);
      const baseFont = fd.get(PDFName.of("BaseFont"))?.toString().replace(/^\//, "") ?? "";
      allFonts.add(baseFont);
      const tu = bytesOf(doc, fd.get(PDFName.of("ToUnicode")));
      let program: FontInfo["program"] = null;
      const desc = fd.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
      if (desc) {
        const cid = doc.context.lookup(desc.get(0), PDFDict);
        const fdesc = cid.lookup(PDFName.of("FontDescriptor"), PDFDict);
        const file = bytesOf(doc, fdesc.get(PDFName.of("FontFile2")));
        if (file) program = fontkit.create(Buffer.from(file));
      }
      fonts.set(key.toString(), { name: key.toString(), baseFont, toUnicode: tu ? parseCMap(Buffer.from(tu).toString("latin1")) : null, program });
    }
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    for (const s of streams) {
      const raw = bytesOf(doc, s);
      if (!raw) continue;
      const src = Buffer.from(raw).toString("latin1");
      let font: FontInfo | undefined;
      for (const m of src.matchAll(/(\/[^\s/]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
        if (m[1]) {
          font = fonts.get(m[1]);
          continue;
        }
        if (m[2] !== undefined && font?.toUnicode) {
          for (let i = 0; i < m[2].length; i += 4) {
            const cid = m[2].slice(i, i + 4).toUpperCase();
            const ch = font.toUnicode.get(cid) ?? "�";
            text += ch;
            if (font.program && !/\s/.test(ch)) {
              let drawn = false;
              try {
                const box = font.program.getGlyph(parseInt(cid, 16)).path.bbox; // empty path: ±Infinity
                drawn = box.maxX > box.minX && box.maxY > box.minY;
              } catch {
                drawn = false; // corrupt glyph record (e.g. a broken subset)
              }
              if (!drawn) blank.push(ch);
            }
          }
        } else if (m[2] !== undefined) {
          text += Buffer.from(m[2], "hex").toString("latin1");
        } else if (m[3] !== undefined) {
          text += m[3].replace(/\\(.)/g, "$1");
        }
      }
      text += "\n";
    }
  }
  return { text, fonts: [...allFonts], blankGlyphs: blank };
}
