#!/usr/bin/env python3
"""Build a printable half-letter (5.5x8.5in) hole-by-hole visual guide (yardage book)
for a course from course.json + an OSM feature dump + Esri World Imagery tiles.

Usage:
  python3 yardage_book.py <course-dir> [--dpi 300]

Inputs (in <course-dir>):
  course.json                          holes, pars, yardages, names
  references/osm-course-features.json  golf=hole routings, bunkers, water (Overpass dump)
  references/course_overview_annotated.jpg   optional, used on the overview page

Outputs (in <course-dir>/graphics/):
  yardage-book.pdf           half-letter pages, reading order
  yardage-book-print.pdf     2-up letter-landscape saddle-stitch imposition
"""
import argparse, json, math, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

Z = 19
TILE = 256
ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
YD = 1.09361

INK = (26, 26, 26)
GREEN_DK = (16, 54, 34)
GOLD = (201, 162, 75)
PAPER = (255, 255, 255)
SOFT = (240, 238, 232)

FONT_DIR = "/usr/share/fonts/truetype/dejavu"


# ---------------- geo helpers ----------------

def gpx(lat, lon):
    n = TILE * (2 ** Z)
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def meters_per_gpx(lat):
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** Z)


def bearing_deg(a, b):
    dn = (b[0] - a[0]) * 111320.0
    de = (b[1] - a[1]) * 111320.0 * math.cos(math.radians(a[0]))
    return math.degrees(math.atan2(de, dn)) % 360


class TileCache:
    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)

    def get(self, tx, ty):
        p = os.path.join(self.root, f"{tx}_{ty}.jpg")
        if not os.path.exists(p):
            url = ESRI.format(z=Z, y=ty, x=tx)
            req = urllib.request.Request(url, headers={"User-Agent": "golf-flyover-yardagebook/1.0"})
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(req, timeout=30) as r:
                        data = r.read()
                    open(p, "wb").write(data)
                    break
                except Exception:
                    if attempt == 2:
                        raise
        return Image.open(p).convert("RGB")

    def stitch(self, lat_n, lon_w, lat_s, lon_e):
        x0, y0 = gpx(lat_n, lon_w)
        x1, y1 = gpx(lat_s, lon_e)
        tx0, ty0, tx1, ty1 = int(x0 // TILE), int(y0 // TILE), int(x1 // TILE), int(y1 // TILE)
        img = Image.new("RGB", ((tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE))
        coords = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
        with ThreadPoolExecutor(max_workers=8) as ex:
            for (tx, ty), tile in zip(coords, ex.map(lambda c: self.get(*c), coords)):
                img.paste(tile, ((tx - tx0) * TILE, (ty - ty0) * TILE))
        return img, (tx0 * TILE, ty0 * TILE)


# ---------------- per-hole geometry analysis ----------------

class HoleFrame:
    """Local rotated frame: u = along-hole toward green (up), v = cross (right)."""

    def __init__(self, path):
        self.path = path
        self.lat0 = sum(p[0] for p in path) / len(path)
        self.lon0 = sum(p[1] for p in path) / len(path)
        self.mlat = 111320.0
        self.mlon = 111320.0 * math.cos(math.radians(self.lat0))
        b = math.radians(bearing_deg(path[0], path[-1]))
        self.sinb, self.cosb = math.sin(b), math.cos(b)
        self.bearing = math.degrees(b)
        self.uv_path = [self.to_uv(p) for p in path]

    def to_uv(self, p):
        n = (p[0] - self.lat0) * self.mlat
        e = (p[1] - self.lon0) * self.mlon
        return (e * self.sinb + n * self.cosb, e * self.cosb - n * self.sinb)

    def along_side(self, p):
        """(along_m, offset_m, side) of a point relative to the routing polyline."""
        pt = self.to_uv(p)
        best = (1e18, 0.0, 1)
        total = 0.0
        for a, b in zip(self.uv_path, self.uv_path[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            L2 = dx * dx + dy * dy
            t = 0 if L2 == 0 else max(0.0, min(1.0, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / L2))
            cx, cy = a[0] + t * dx, a[1] + t * dy
            d = math.hypot(pt[0] - cx, pt[1] - cy)
            if d < best[0]:
                cross = dx * (pt[1] - a[1]) - dy * (pt[0] - a[0])
                best = (d, total + t * math.sqrt(L2), 1 if cross > 0 else -1)
            total += math.sqrt(L2)
        return best[1], best[0], best[2]

    def point_at(self, along_m):
        total = 0.0
        for a, b in zip(self.uv_path, self.uv_path[1:]):
            seg = math.hypot(b[0] - a[0], b[1] - a[1])
            if total + seg >= along_m and seg > 0:
                t = (along_m - total) / seg
                return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
            total += seg
        return self.uv_path[-1]

    @property
    def length_m(self):
        return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(self.uv_path, self.uv_path[1:]))


def analyze(frame, osm):
    """Auto-derive bunkers/water/dogleg facts near this hole's corridor."""
    facts = {"bunkers": [], "waterL": [], "waterR": [], "dogleg": None}
    L = frame.length_m
    for el in osm["elements"]:
        t = el.get("tags", {})
        g = t.get("golf", "")
        pts = [(p["lat"], p["lon"]) for p in el.get("geometry", [])]
        if not pts:
            continue
        if g == "bunker":
            c = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
            along, off, side = frame.along_side(c)
            if off < 55 and -20 < along < L + 45:
                facts["bunkers"].append((along * YD, side))
        elif t.get("natural") == "water" or "water" in g:
            near = [frame.along_side(p) for p in pts]
            near = [n for n in near if n[1] < 45 and -20 < n[0] < L + 45]
            for side, key in ((1, "waterR"), (-1, "waterL")):
                sided = [n[0] * YD for n in near if n[2] == side]
                if sided:
                    facts[key].append((min(sided), max(sided)))
    for key in ("waterL", "waterR"):  # merge overlapping ranges
        rng = sorted(facts[key])
        merged = []
        for a, b in rng:
            if merged and a <= merged[-1][1] + 30:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        facts[key] = merged
    if len(frame.uv_path) >= 3:  # dogleg from largest bearing change between segments
        best = (0, None, 0)
        total = 0.0
        for i in range(len(frame.path) - 2):
            b1 = bearing_deg(frame.path[i], frame.path[i + 1])
            b2 = bearing_deg(frame.path[i + 1], frame.path[i + 2])
            total += math.hypot(*(x - y for x, y in zip(frame.uv_path[i + 1], frame.uv_path[i])))
            turn = (b2 - b1 + 540) % 360 - 180
            if abs(turn) > abs(best[0]):
                best = (turn, total * YD, 1 if turn > 0 else -1)
        if abs(best[0]) > 15:
            facts["dogleg"] = ("R" if best[0] > 0 else "L", best[1])
    return facts


# ---------------- map rendering ----------------

def render_hole_map(frame, cache, box_px, dpi):
    """Rotated tee-at-bottom satellite map fitted to box_px, plus uv->px transform."""
    us = [p[0] for p in frame.uv_path]
    vs = [p[1] for p in frame.uv_path]
    u_min, u_max = min(us) - 45, max(us) + 55
    v_min, v_max = min(vs) - 70, max(vs) + 70
    if v_max - v_min < 230:  # keep skinny holes from becoming a sliver
        mid = (v_max + v_min) / 2
        v_min, v_max = mid - 115, mid + 115
    W, H = box_px
    mpp = max((v_max - v_min) / W, (u_max - u_min) / H, 0.22)
    out_w, out_h = int((v_max - v_min) / mpp), int((u_max - u_min) / mpp)

    # stitch source imagery covering the rotated rect
    corners = []
    for u, v in ((u_min, v_min), (u_min, v_max), (u_max, v_min), (u_max, v_max)):
        e = u * frame.sinb + v * frame.cosb
        n = u * frame.cosb - v * frame.sinb
        corners.append((frame.lat0 + n / frame.mlat, frame.lon0 + e / frame.mlon))
    pad = 30 / frame.mlat
    lat_n = max(c[0] for c in corners) + pad
    lat_s = min(c[0] for c in corners) - pad
    lon_w = min(c[1] for c in corners) - pad * 1.3
    lon_e = max(c[1] for c in corners) + pad * 1.3
    stitch, (ox, oy) = cache.stitch(lat_n, lon_w, lat_s, lon_e)

    px0, py0 = gpx(frame.lat0, frame.lon0)
    mpx = meters_per_gpx(frame.lat0)
    k = mpp / mpx
    a, b = k * frame.cosb, -k * frame.sinb
    c = (px0 - ox) + (frame.sinb * u_max + frame.cosb * v_min) / mpx
    d, e = k * frame.sinb, k * frame.cosb
    f = (py0 - oy) - (frame.cosb * u_max - frame.sinb * v_min) / mpx
    img = stitch.transform((out_w, out_h), Image.AFFINE, (a, b, c, d, e, f), resample=Image.BICUBIC)

    def uv2px(u, v):
        return (v - v_min) / mpp, (u_max - u) / mpp

    return img, uv2px, mpp


def draw_overlays(img, frame, uv2px, hole, dpi):
    scale = dpi / 300.0
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dr = ImageDraw.Draw(layer)
    f_sm = ImageFont.truetype(f"{FONT_DIR}/DejaVuSans-Bold.ttf", int(30 * scale))

    pts = [uv2px(u, v) for u, v in frame.uv_path]
    for aa, bb in zip(pts, pts[1:]):  # dashed centerline
        seg = math.hypot(bb[0] - aa[0], bb[1] - aa[1])
        n = max(1, int(seg / (26 * scale)))
        for i in range(n):
            t0, t1 = i / n, min((i + 0.55) / n, 1)
            dr.line([(aa[0] + (bb[0] - aa[0]) * t0, aa[1] + (bb[1] - aa[1]) * t0),
                     (aa[0] + (bb[0] - aa[0]) * t1, aa[1] + (bb[1] - aa[1]) * t1)],
                    fill=(255, 255, 255, 150), width=int(5 * scale))

    r = 12 * scale
    tx, ty = pts[0]
    dr.ellipse([tx - r, ty - r, tx + r, ty + r], fill=GOLD + (255,), outline=(255, 255, 255, 255), width=int(3 * scale))
    gx, gy = pts[-1]
    dr.ellipse([gx - r, gy - r, gx + r, gy + r], fill=(255, 255, 255, 235), outline=GREEN_DK + (255,), width=int(3 * scale))

    if hole["par"] >= 4:  # distance ticks from the tee
        for yd in (150, 200, 250):
            m = yd / YD
            if m > frame.length_m - 40:
                continue
            u, v = frame.point_at(m)
            x, y = uv2px(u, v)
            u2, v2 = frame.point_at(min(m + 8, frame.length_m))
            x2, y2 = uv2px(u2, v2)
            dx, dy = x2 - x, y2 - y
            L = math.hypot(dx, dy) or 1
            nx, ny = -dy / L, dx / L
            t = 16 * scale
            dr.line([(x - nx * t, y - ny * t), (x + nx * t, y + ny * t)], fill=(255, 255, 255, 220), width=int(4 * scale))
            label = str(yd)
            lx, ly = x + nx * t * 1.6, y + ny * t * 1.6
            dr.text((lx, ly), label, font=f_sm, fill=(255, 255, 255, 240), anchor="lm" if nx >= 0 else "rm",
                    stroke_width=int(3 * scale), stroke_fill=(0, 0, 0, 170))

    # north arrow, top-right
    nxv, nyv = -frame.sinb, -frame.cosb
    cxp, cyp = img.size[0] - 52 * scale, 56 * scale
    ln = 26 * scale
    dr.line([(cxp - nxv * ln, cyp - nyv * ln), (cxp + nxv * ln, cyp + nyv * ln)], fill=(255, 255, 255, 210), width=int(4 * scale))
    dr.text((cxp + nxv * (ln + 14 * scale), cyp + nyv * (ln + 14 * scale)), "N", font=f_sm,
            fill=(255, 255, 255, 230), anchor="mm", stroke_width=int(3 * scale), stroke_fill=(0, 0, 0, 170))

    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


# ---------------- facts line ----------------

def facts_bits(hole, facts, elev, hole_len_yd):
    bits = []
    if facts["dogleg"]:
        side, at = facts["dogleg"]
        bits.append(f"Dogleg {side} ~{int(round(at, -1))}")
    for key, label in (("waterR", "Water R"), ("waterL", "Water L")):
        for a, b in facts[key]:
            if b < 25:  # sliver at the tee box — not in play
                continue
            hi = "green" if b > hole_len_yd - 30 else str(int(round(b, -1)))
            span = f"{int(round(a, -1))}→{hi}" if b - a > 40 else f"~{int(round((a + b) / 2, -1))}"
            bits.append(f"{label} {span}")
    fw = sorted(d for d, s in facts["bunkers"] if d <= hole_len_yd - 35)
    gs_l = sum(1 for d, s in facts["bunkers"] if d > hole_len_yd - 35 and s < 0)
    gs_r = sum(1 for d, s in facts["bunkers"] if d > hole_len_yd - 35 and s > 0)
    if fw:
        sides = {int(round(d, -1)): s for d, s in sorted(facts["bunkers"]) if d <= hole_len_yd - 35}
        left = sorted({r for r, s in sides.items() if s < 0})
        right = sorted({r for r, s in sides.items() if s > 0})
        if left:
            bits.append("Sand L " + "/".join(map(str, left)))
        if right:
            bits.append("Sand R " + "/".join(map(str, right)))
    if gs_l or gs_r:
        g = [f"{n}{s}" for n, s in ((gs_l, "L"), (gs_r, "R")) if n]
        bits.append("Green sand " + "·".join(g))
    if elev and elev[0] is not None and elev[1] is not None:
        dz = elev[1] - elev[0]
        if abs(dz) >= 8:
            bits.append(("Green +%d ft" if dz > 0 else "Green %d ft") % round(dz))
    return bits or ["—"]


# ---------------- PDF composition ----------------

def build(course_dir, dpi):
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas as pdfcanvas

    pdfmetrics.registerFont(TTFont("DVS", f"{FONT_DIR}/DejaVuSans.ttf"))
    pdfmetrics.registerFont(TTFont("DVSB", f"{FONT_DIR}/DejaVuSans-Bold.ttf"))

    course = json.load(open(os.path.join(course_dir, "course.json")))
    osm = json.load(open(os.path.join(course_dir, "references", "osm-course-features.json")))
    elevs = {}
    epath = os.path.join(course_dir, "references", "elevations.json")
    if os.path.exists(epath):
        elevs = {int(k): v for k, v in json.load(open(epath)).items()}

    # hole routings from OSM; disambiguate duplicate refs by matching par to course.json
    routes = {}
    pending = []
    par_by_n = {h["holeNumber"]: h["par"] for h in course["holes"]}
    for el in osm["elements"]:
        t = el.get("tags", {})
        if t.get("golf") == "hole" and t.get("ref", "").isdigit():
            n = int(t["ref"])
            path = [(p["lat"], p["lon"]) for p in el["geometry"]]
            if n in routes or (t.get("par") and int(t["par"]) != par_by_n.get(n)):
                pending.append((path, int(t.get("par", 0))))
            else:
                routes[n] = path
    for path, par in pending:  # e.g. OSM has two "hole 4"s; slot into the missing number
        missing = [n for n in par_by_n if n not in routes and par_by_n[n] == par]
        if missing:
            routes[min(missing)] = path

    PW, PH = 396, 612  # 5.5x8.5in in points
    M = 30
    out_dir = os.path.join(course_dir, "graphics")
    os.makedirs(out_dir, exist_ok=True)
    pdf_path = os.path.join(out_dir, "yardage-book.pdf")
    c = pdfcanvas.Canvas(pdf_path, pagesize=(PW, PH))
    cache = TileCache(os.path.join(os.environ.get("TILE_CACHE", "/tmp"), f"esri_z{Z}"))

    name = course["courseName"].upper()
    loc = course["location"]
    total_white = sum(h["yardage"] for h in course["holes"])

    def cover():
        c.setFillColorRGB(*[v / 255 for v in GREEN_DK])
        c.rect(0, 0, PW, PH, fill=1, stroke=0)
        c.setStrokeColorRGB(*[v / 255 for v in GOLD])
        c.setLineWidth(1.2)
        c.line(M, PH - 150, PW - M, PH - 150)
        c.line(M, 150, PW - M, 150)
        c.setFillColorRGB(*[v / 255 for v in GOLD])
        c.setFont("DVSB", 30)
        for i, word in enumerate(name.split()):
            c.drawCentredString(PW / 2, PH - 205 - i * 38, word)
        c.setFillColorRGB(0.92, 0.9, 0.85)
        c.setFont("DVS", 12.5)
        c.drawCentredString(PW / 2, PH - 205 - 38 * len(name.split()) - 8, loc)
        c.setFont("DVSB", 11)
        c.setFillColorRGB(*[v / 255 for v in GOLD])
        c.drawCentredString(PW / 2, 190, "HOLE-BY-HOLE VISUAL GUIDE")
        c.setFillColorRGB(0.92, 0.9, 0.85)
        c.setFont("DVS", 10)
        c.drawCentredString(PW / 2, 122, f"White Tees · {total_white:,} Yards · Par 72")
        c.showPage()

    def overview():
        c.setFillColorRGB(*[v / 255 for v in PAPER])
        c.rect(0, 0, PW, PH, fill=1, stroke=0)
        header("THE COURSE", "", "")
        ov = os.path.join(course_dir, "references", "course_overview_annotated.jpg")
        y_img_top = PH - 78
        if os.path.exists(ov):
            img = Image.open(ov)
            w = PW - 2 * M
            h = w * img.size[1] / img.size[0]
            c.drawImage(ov, M, y_img_top - h, w, h)
            y = y_img_top - h - 24
        else:
            y = y_img_top - 24
        rows = [("Black", 7242), ("Blue", 6848), ("White", 6404), ("W/G Combo", 6161), ("Green", 5890), ("Red", 5010)]
        c.setFont("DVSB", 9)
        c.setFillColorRGB(*[v / 255 for v in INK])
        c.drawString(M, y, "TEES")
        c.drawRightString(PW - M, y, "YARDS")
        y -= 5
        c.setLineWidth(0.6)
        c.setStrokeColorRGB(*[v / 255 for v in GOLD])
        c.line(M, y, PW - M, y)
        for i, (tee, yds) in enumerate(rows):
            y -= 15
            if i % 2 == 0:
                c.setFillColorRGB(*[v / 255 for v in SOFT])
                c.rect(M - 3, y - 4, PW - 2 * M + 6, 14, fill=1, stroke=0)
            c.setFillColorRGB(*[v / 255 for v in INK])
            c.setFont("DVS", 9.5)
            c.drawString(M, y, tee)
            c.setFont("DVSB", 9.5)
            c.drawRightString(PW - M, y, f"{yds:,}")
        p = course.get("player")
        if p:
            y -= 24
            c.setFillColorRGB(*[v / 255 for v in GOLD])
            c.setFont("DVSB", 8)
            c.drawString(M, y, "MY PLAY NOTES CALIBRATED FOR")
            c.setFillColorRGB(*[v / 255 for v in INK])
            c.setFont("DVS", 8.5)
            shape = p["shape"].split(",")[0]
            c.drawString(M, y - 13,
                         f"{p['driverTotal']} driver ({shape}) · 150 = {p['club150']} · "
                         f"safety 7-wood · layup {p['wedgeNumber']}")
        footer(2)
        c.showPage()

    def header(big, mid, right):
        c.setFillColorRGB(*[v / 255 for v in GREEN_DK])
        c.rect(0, PH - 64, PW, 64, fill=1, stroke=0)
        c.setFillColorRGB(*[v / 255 for v in GOLD])
        c.setFont("DVSB", 30)
        c.drawString(M, PH - 48, big)
        if mid:
            c.setFillColorRGB(0.95, 0.94, 0.9)
            c.setFont("DVSB", 10)
            c.drawRightString(PW - M, PH - 30, mid)
        if right:
            c.setFillColorRGB(*[v / 255 for v in GOLD])
            c.setFont("DVSB", 15)
            c.drawRightString(PW - M, PH - 50, right)

    def footer(pageno, note=""):
        c.setFillColorRGB(0.45, 0.45, 0.45)
        c.setFont("DVS", 6.5)
        c.drawString(M, 18, note or f"{course['courseName']} · White tees")
        c.drawRightString(PW - M, 18, str(pageno))

    def hole_page(h, pageno):
        n = h["holeNumber"]
        frame = HoleFrame(routes[n])
        facts = analyze(frame, osm)
        c.setFillColorRGB(*[v / 255 for v in PAPER])
        c.rect(0, 0, PW, PH, fill=1, stroke=0)
        header(f"HOLE {n}", f"PAR {h['par']}  ·  HCP {h.get('handicap', '—')}", f"{h['yardage']} YDS")

        map_w_pt, map_h_pt = PW - 2 * M, PH - 64 - 112
        box_px = (int(map_w_pt / 72 * dpi), int(map_h_pt / 72 * dpi))
        img, uv2px, _ = render_hole_map(frame, cache, box_px, dpi)
        img = draw_overlays(img, frame, uv2px, h, dpi)
        w_pt = img.size[0] * 72 / dpi
        h_pt = img.size[1] * 72 / dpi
        s = min(map_w_pt / w_pt, map_h_pt / h_pt)
        w_pt, h_pt = w_pt * s, h_pt * s
        x = (PW - w_pt) / 2
        y = 112 + (map_h_pt - h_pt) / 2
        buf = BytesIO()  # embed as JPEG (DCT) — lossless embedding balloons the file
        img.save(buf, "JPEG", quality=82)
        buf.seek(0)
        c.drawImage(ImageReader(buf), x, y, w_pt, h_pt)
        c.setStrokeColorRGB(*[v / 255 for v in GREEN_DK])
        c.setLineWidth(1)
        c.rect(x, y, w_pt, h_pt, fill=0, stroke=1)

        from reportlab.pdfbase.pdfmetrics import stringWidth
        c.setFillColorRGB(*[v / 255 for v in INK])
        c.setFont("DVSB", 8.5)
        bits = facts_bits(h, facts, elevs.get(n), frame.length_m * YD)
        lines, cur = [], ""
        for bit in bits:  # wrap the facts bits to the page width
            trial = (cur + "   ·   " + bit) if cur else bit
            if stringWidth(trial, "DVSB", 8.5) > PW - 2 * M and cur:
                lines.append(cur)
                cur = bit
            else:
                cur = trial
        lines.append(cur)
        y = 96
        for ln in lines[:2]:
            c.drawString(M, y, ln)
            y -= 11
        play = h.get("myPlay", "")
        if play:
            c.setFillColorRGB(*[v / 255 for v in GOLD])
            c.setFont("DVSB", 8)
            c.drawString(M, 68, "MY PLAY")
            label_w = stringWidth("MY PLAY", "DVSB", 8) + 8
            c.setFillColorRGB(*[v / 255 for v in INK])
            c.setFont("DVS", 8.5)
            words, wlines, cur = play.split(), [], ""
            first_w = PW - 2 * M - label_w
            for w in words:
                trial = (cur + " " + w) if cur else w
                width = first_w if not wlines else PW - 2 * M
                if stringWidth(trial, "DVS", 8.5) > width and cur:
                    wlines.append(cur)
                    cur = w
                else:
                    cur = trial
            wlines.append(cur)
            c.drawString(M + label_w, 68, wlines[0])
            if len(wlines) > 1:
                c.drawString(M, 57, " ".join(wlines[1:]))
        strat = h.get("strategy", "")
        if strat:
            c.setFillColorRGB(0.35, 0.35, 0.35)
            c.setFont("DVS", 8)
            c.drawString(M, 42, strat)
        footer(pageno)
        c.showPage()

    def notes_page(pageno):
        c.setFillColorRGB(*[v / 255 for v in PAPER])
        c.rect(0, 0, PW, PH, fill=1, stroke=0)
        header("NOTES", "", "")
        c.setStrokeColorRGB(0.75, 0.75, 0.72)
        c.setLineWidth(0.5)
        y = PH - 110
        while y > 60:
            c.line(M, y, PW - M, y)
            y -= 26
        footer(pageno)
        c.showPage()

    def colophon(pageno):
        c.setFillColorRGB(*[v / 255 for v in GREEN_DK])
        c.rect(0, 0, PW, PH, fill=1, stroke=0)
        c.setFillColorRGB(0.92, 0.9, 0.85)
        c.setFont("DVS", 7)
        lines = [
            "Distances are computed along each hole's routing from OpenStreetMap",
            "course mapping and are approximate (±10 yds). Verify on the ground.",
            "",
            "Imagery © Esri — Maxar, Earthstar Geographics, USDA FSA, USGS.",
            "Course data © OpenStreetMap contributors (ODbL).",
            "Scorecard data via BlueGolf / Indiana Golf. Elevations: USGS 3DEP.",
            "",
            "Produced with the golf-flyover pipeline.",
        ]
        y = 150
        for ln in reversed(lines):
            c.drawCentredString(PW / 2, y, ln)
            y += 11
        c.showPage()

    cover()
    overview()
    page = 3
    for h in course["holes"]:
        if h["holeNumber"] not in routes:
            print(f"WARNING: no OSM routing for hole {h['holeNumber']}; skipping map page")
            continue
        hole_page(h, page)
        print(f"  hole {h['holeNumber']} page done")
        page += 1
    while page % 4 != 0:  # pad so total (incl. colophon, written at `page`) is a multiple of 4
        notes_page(page)
        page += 1
    colophon(page)
    c.save()
    print(f"wrote {pdf_path} ({page} pages)")
    return pdf_path


def impose_booklet(pdf_path):
    """2-up saddle-stitch imposition onto letter landscape."""
    # A broken system `cryptography` package can crash pypdf's import with a rust
    # panic; blocking it forces pypdf's clean pure-Python fallback (we never open
    # encrypted PDFs here).
    if "cryptography" not in sys.modules:
        try:
            import cryptography.exceptions  # noqa: F401
        except BaseException:  # pyo3 PanicException does not derive from Exception
            sys.modules["cryptography"] = None
    from pypdf import PdfReader, PdfWriter, Transformation
    from pypdf.generic import RectangleObject

    reader = PdfReader(pdf_path)
    n = len(reader.pages)
    assert n % 4 == 0, f"page count {n} not a multiple of 4"
    writer = PdfWriter()
    LW, LH = 792, 612
    order = []
    l, r = n, 1
    for _ in range(n // 4):
        order.append((l, r)); l, r = l - 1, r + 1
        order.append((r, l)); r, l = r + 1, l - 1
    for left, right in order:
        page = writer.add_blank_page(width=LW, height=LH)
        for src_no, xoff in ((left, 0), (right, LW / 2)):
            src = reader.pages[src_no - 1]
            page.merge_transformed_page(src, Transformation().translate(xoff, 0))
        page.mediabox = RectangleObject([0, 0, LW, LH])
    out = pdf_path.replace(".pdf", "-print.pdf")
    writer.write(out)
    print(f"wrote {out} ({n // 2} letter sheets sides)")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("course_dir")
    ap.add_argument("--dpi", type=int, default=300)
    args = ap.parse_args()
    p = build(args.course_dir, args.dpi)
    impose_booklet(p)
