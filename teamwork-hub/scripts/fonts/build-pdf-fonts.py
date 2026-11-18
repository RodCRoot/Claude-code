"""Rebuild the PDF fonts in assets/fonts/ from the upstream Noto releases (SIL OFL 1.1).

Not part of the app build: the outputs are committed. Re-run only to update the fonts.

    python3 -m venv .venv && .venv/bin/pip install fonttools==4.55.3
    .venv/bin/python scripts/fonts/build-pdf-fonts.py <download-dir> assets/fonts

<download-dir> must contain (from notofonts / noto-cjk):
  NotoSans-{Regular,Bold,Italic,BoldItalic}.ttf  fonts/NotoSans/unhinted/ttf/ (latin-greek-cyrillic)
  NotoSansSC-Regular.otf                         noto-cjk Sans/SubsetOTF/SC/
  NotoSansKR-Regular.otf                         noto-cjk Sans/SubsetOTF/KR/

What it does (the OFL allows modified versions; Reserved Font Names are not used
by the outputs' file names beyond the upstream family names, which Noto does not reserve):
  1. CJK OTFs (CFF outlines) are converted to TrueType outlines. @pdf-lib/fontkit's CFF
     subsetter emits fonts that PDF viewers reject; its TrueType subsetter works.
  2. Korean is reduced to Hangul (syllables + jamo); Han ideographs come from the SC font.
  3. Layout tables (GSUB/GPOS/BASE) and vertical metrics are dropped from the CJK fonts:
     pdf-lib draws left-to-right without shaping, so they are unused weight.
  4. Every glyph record is padded to 4 bytes. fontkit's subsetter copies raw glyph
     records and writes a short `loca` for small subsets, which corrupts odd-length
     records (Noto's unhinted builds are unpadded) — glyphs then render blank.
"""

import os
import sys

from fontTools import subset
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable

DROP = ("VORG", "vhea", "vmtx", "GSUB", "GPOS", "BASE", "DSIG")


def cff_to_ttf(font: TTFont) -> TTFont:
    order = font.getGlyphOrder()
    gs = font.getGlyphSet()
    glyf = newTable("glyf")
    glyf.glyphOrder = order
    glyf.glyphs = {}
    for name in order:
        pen = TTGlyphPen(gs)
        gs[name].draw(Cu2QuPen(pen, max_err=1.0, reverse_direction=True))
        glyf[name] = pen.glyph()
    del font["CFF "]
    font["loca"] = newTable("loca")
    font["glyf"] = glyf
    maxp = font["maxp"]
    maxp.tableVersion = 0x00010000
    for attr in ("maxTwilightPoints", "maxStorage", "maxFunctionDefs", "maxInstructionDefs",
                 "maxStackElements", "maxSizeOfInstructions", "maxComponentElements", "maxComponentDepth"):
        setattr(maxp, attr, 0)
    maxp.maxZones = 1
    font["head"].glyphDataFormat = 0
    font["post"].formatType = 3.0
    font.sfntVersion = "\x00\x01\x00\x00"
    return font


def finish(font: TTFont, out: str) -> None:
    for t in DROP:
        if t in font:
            del font[t]
    font["glyf"].padding = 4
    font.save(out)
    check = TTFont(out)
    loca = check["loca"]
    bad = sum(1 for i in range(len(loca) - 1) if (loca[i + 1] - loca[i]) % 4)
    if bad:
        raise SystemExit(f"{out}: {bad} unpadded glyph records")
    print(f"{out}: {len(check.getGlyphOrder())} glyphs, {os.path.getsize(out)} bytes")


def main(src: str, dst: str) -> None:
    os.makedirs(dst, exist_ok=True)
    for style in ("Regular", "Bold", "Italic", "BoldItalic"):
        f = TTFont(os.path.join(src, f"NotoSans-{style}.ttf"))
        f["glyf"].padding = 4
        f.save(os.path.join(dst, f"NotoSans-{style}.ttf"))
        print(f"NotoSans-{style}.ttf padded")

    sc = cff_to_ttf(TTFont(os.path.join(src, "NotoSansSC-Regular.otf")))
    finish(sc, os.path.join(dst, "NotoSansSC-Regular.ttf"))

    kr = TTFont(os.path.join(src, "NotoSansKR-Regular.otf"))
    opts = subset.Options()
    opts.layout_features = []
    opts.notdef_outline = True
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    sub = subset.Subsetter(opts)
    hangul = list(range(0x1100, 0x1200)) + list(range(0x3130, 0x3190)) + list(range(0xA960, 0xA980)) \
        + list(range(0xAC00, 0xD7B0)) + list(range(0xD7B0, 0xD800)) + [0x20]
    sub.populate(unicodes=hangul)
    sub.subset(kr)
    finish(cff_to_ttf(kr), os.path.join(dst, "NotoSansKR-Hangul.ttf"))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
