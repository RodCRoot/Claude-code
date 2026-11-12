/**
 * Win photos: type sniffing and metadata stripping. Phone photos carry GPS position, device and
 * time in EXIF; for a photo of a minor that must not travel with the file, so it is removed
 * before the bytes are stored. Pure functions, no image library.
 */
import { PHOTO_MAX_BYTES } from "./shared";

export type PhotoKind = "image/jpeg" | "image/png";

export function sniffPhoto(b: Uint8Array): PhotoKind | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length > 8 && png.every((x, i) => b[i] === x)) return "image/png";
  return null;
}

/** Drop APP1..APP15 (EXIF, XMP, IPTC, maker notes) and comments. Keeps APP0 and the picture. */
function stripJpeg(b: Uint8Array): Uint8Array | null {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xda) {
      // Start of scan: the rest is image data.
      out.push(b.subarray(i));
      return concat(out);
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return null;
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

/** Keep only the chunks a picture needs; drops eXIf, text and time chunks. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "pHYs", "acTL", "fcTL", "fdAT"]);
function stripPng(b: Uint8Array): Uint8Array | null {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") return concat(out);
  }
  return null;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export type PreparedPhoto = { bytes: Uint8Array; mimeType: PhotoKind; ext: "jpg" | "png" };

/** Validate and strip. Returns an error message in plain words when the file cannot be used. */
export function preparePhoto(bytes: Uint8Array): { photo: PreparedPhoto | null; error: string | null } {
  if (bytes.length === 0) return { photo: null, error: null };
  if (bytes.length > PHOTO_MAX_BYTES) return { photo: null, error: "Photos can be up to 5 MB." };
  const kind = sniffPhoto(bytes);
  if (!kind) return { photo: null, error: "Use a JPEG or PNG photo." };
  const stripped = kind === "image/jpeg" ? stripJpeg(bytes) : stripPng(bytes);
  if (!stripped) return { photo: null, error: "That photo could not be read. Try saving it again as a JPEG." };
  return { photo: { bytes: stripped, mimeType: kind, ext: kind === "image/jpeg" ? "jpg" : "png" }, error: null };
}
