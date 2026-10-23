"""Hawkin Dynamics MCP connector for Teamwork Bloomington.

Holds the Hawkin integration key (HD_REFRESH_TOKEN) server-side so any
Claude chat, Claude Code, or Codex session can read force-plate data
without ever seeing the key. Read-only by design.

Env vars:
  HD_REFRESH_TOKEN  Hawkin integration key (Settings -> Integrations)
  MCP_SECRET        long random string; the connector URL is /<MCP_SECRET>/mcp
  HD_REGION         Americas (default) | Europe | APAC
  LOCAL_TZ          default America/Indiana/Indianapolis
"""

from __future__ import annotations

import difflib
import os
import statistics
import time
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

REGION_HOSTS = {
    "americas": "https://cloud.hawkindynamics.com",
    "europe": "https://eu.cloud.hawkindynamics.com",
    "apac": "https://apac.cloud.hawkindynamics.com",
}
HOST = os.getenv("HD_BASE_URL") or REGION_HOSTS.get(os.getenv("HD_REGION", "Americas").lower(), REGION_HOSTS["americas"])
API = f"{HOST}/api/v1"
TZ = ZoneInfo(os.getenv("LOCAL_TZ", "America/Indiana/Indianapolis"))
SECRET = os.getenv("MCP_SECRET", "").strip()
PORT = int(os.getenv("PORT", "8000"))

# Hawkin canonical test-type IDs (from Hawkin's hdforce package).
TEST_TYPES = {
    "7nNduHeM5zETPjHxvm7s": ["countermovement jump", "cmj"],
    "QEG7m7DhYsD6BrcQ8pic": ["squat jump", "sj"],
    "2uS5XD5kXmWgIZ5HhQ3A": ["isometric test", "iso", "imtp"],
    "gyBETpRXpdr63Ab2E0V8": ["drop jump", "dj"],
    "5pRSUQVSJVnxijpPMck3": ["free run", "free"],
    "pqgf2TPUOQOQs6r0HQWb": ["cmj rebound", "cmjr"],
    "r4fhrkPdYlLxYQxEeM78": ["multi rebound", "mr"],
    "ubeWMPN1lJFbuQbAM97s": ["weigh in", "wi", "weight"],
    "rKgI4y3ItTAzUekTUpvR": ["drop landing", "dl"],
    "4KlQgKmBxbOY6uKTLDFL": ["ts free run", "tsfr"],
    "umnEZPgi6zaxuw0KhUpM": ["ts isometric test", "tsiso"],
}

# Compact default metric set (matched case-insensitively against labels).
DEFAULT_METRICS = [
    "jump height", "mrsi", "rsi", "system weight", "peak propulsive force",
    "peak propulsive power", "avg. braking rfd", "braking rfd", "time to takeoff",
    "peak force", "contact time", "l|r", "asymmetry",
]

mcp = FastMCP(
    "Hawkin Dynamics (Teamwork Bloomington)",
    instructions=(
        "Read-only access to Teamwork Bloomington's Hawkin Dynamics force-plate data. "
        "Start with hawkin_find_athlete to resolve a name, then hawkin_get_tests or "
        "hawkin_metric_summary. Dates are YYYY-MM-DD in Indiana local time. Body weight "
        "is the 'System Weight' metric (recorded on every test)."
    ),
    host="0.0.0.0",
    port=PORT,
    streamable_http_path=f"/{SECRET}/mcp" if SECRET else "/mcp",
    stateless_http=True,
    json_response=True,
)

# --------------------------------------------------------------------------- #
# HTTP + auth


class _Token:
    value: str | None = None
    expires_at: float = 0.0


_tok = _Token()
_cache: dict[str, tuple[float, Any]] = {}
_client = httpx.Client(timeout=60.0, headers={"X-Hawkin-Client": "teamwork-mcp/1.0"})


def _access_token() -> str:
    if _tok.value and time.time() < _tok.expires_at - 120:
        return _tok.value
    refresh = os.getenv("HD_REFRESH_TOKEN", "").strip()
    if not refresh:
        raise RuntimeError("HD_REFRESH_TOKEN is not set on the server.")
    r = _client.get(f"{HOST}/api/token", headers={"Authorization": f"Bearer {refresh}"})
    if r.status_code != 200:
        raise RuntimeError(
            f"Hawkin token request failed ({r.status_code}). The integration key may be "
            "invalid, expired, or revoked."
        )
    body = r.json()
    _tok.value = body["access_token"]
    _tok.expires_at = float(body.get("expires_at") or time.time() + 3600)
    return _tok.value


def _get(path: str, params: dict | None = None) -> Any:
    url = f"{API}{path}"
    for attempt in range(2):
        r = _client.get(url, params=params or {}, headers={"Authorization": f"Bearer {_access_token()}"})
        if r.status_code == 401 and attempt == 0:
            _tok.value = None
            continue
        if r.status_code != 200:
            raise RuntimeError(f"Hawkin API {path} returned {r.status_code}: {r.text[:300]}")
        return r.json()


def _cached(key: str, ttl: float, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    val = fn()
    _cache[key] = (time.time(), val)
    return val


def _data(body: Any) -> list:
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for k in ("data", "athletes", "teams", "groups", "tags"):
            if isinstance(body.get(k), list):
                return body[k]
    return []


# --------------------------------------------------------------------------- #
# Helpers


def _epoch(date_str: str | None, end: bool = False) -> int | None:
    if not date_str:
        return None
    d = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=TZ)
    if end:
        d = d + timedelta(days=1) - timedelta(seconds=1)
    return int(d.timestamp())


def _local(ts: Any) -> str:
    try:
        return datetime.fromtimestamp(float(ts), TZ).strftime("%Y-%m-%d %I:%M %p")
    except Exception:
        return str(ts)


def _athletes(include_inactive: bool = True) -> list[dict]:
    return _cached(
        f"athletes:{include_inactive}", 600,
        lambda: _data(_get("/athletes", {"includeInactive": str(include_inactive).lower()})),
    )


def _resolve_athlete(athlete: str) -> tuple[dict | None, list[str]]:
    """Return (match, candidate_names). Accepts an ID or a (partial) name."""
    people = _athletes()
    for a in people:
        if a.get("id") == athlete:
            return a, []
    q = athlete.strip().lower()
    exact = [a for a in people if (a.get("name") or "").lower() == q]
    if len(exact) == 1:
        return exact[0], []
    parts = q.split()
    contains = [a for a in people if all(p in (a.get("name") or "").lower() for p in parts)]
    if len(contains) == 1:
        return contains[0], []
    if contains:
        return None, [a["name"] for a in contains][:15]
    close = difflib.get_close_matches(q, [(a.get("name") or "").lower() for a in people], n=8, cutoff=0.6)
    names = [a["name"] for a in people if (a.get("name") or "").lower() in close]
    return None, names


def _resolve_type(test_type: str | None) -> str | None:
    if not test_type:
        return None
    q = test_type.strip().lower()
    for tid, aliases in TEST_TYPES.items():
        if q == tid.lower() or q in aliases:
            return tid
    for tid, aliases in TEST_TYPES.items():
        if any(q in a for a in aliases):
            return tid
    raise ValueError(f"Unknown test type '{test_type}'. Try CMJ, SJ, ISO, DJ, CMJR, MR, WI, DL, Free Run.")


def _fetch_tests(params: dict) -> list[dict]:
    params = {**params, "paginate": "true", "nestMetrics": "true", "includeInactive": "false"}
    out, cursor = [], None
    for _ in range(50):
        p = dict(params)
        if cursor:
            p["cursor"] = cursor
        body = _get("", p)
        out.extend(_data(body))
        if not (isinstance(body, dict) and body.get("hasMore") and body.get("nextCursor")):
            break
        cursor = body["nextCursor"]
    return out


def _metric_map(test: dict) -> dict[str, tuple[Any, str]]:
    """label -> (value, units). Works with nested or flat metric formats."""
    out: dict[str, tuple[Any, str]] = {}
    if isinstance(test.get("metrics"), list):
        for m in test["metrics"]:
            label = m.get("metricLabel") or m.get("metricId")
            out[label] = (m.get("metricValue"), m.get("metricUnits") or "")
        return out
    skip = {"id", "timestamp", "segment", "active", "athlete", "testType", "lastSyncTime", "eid"}
    for k, v in test.items():
        if k not in skip and isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = (v, "")
    return out


def _pick(metrics: dict, wanted: list[str] | None) -> dict:
    wanted_l = [w.lower() for w in (wanted or DEFAULT_METRICS)]
    res = {}
    for label, (val, units) in metrics.items():
        if val is None:
            continue
        if any(w in label.lower() for w in wanted_l):
            key = f"{label} ({units})" if units and f"({units})" not in label else label
            res[key] = round(val, 4) if isinstance(val, float) else val
    return res


def _query(athlete, test_type, from_date, to_date, team_id, group_id):
    params: dict[str, Any] = {}
    f, t = _epoch(from_date), _epoch(to_date, end=True)
    if f:
        params["from"] = f
    if t:
        params["to"] = t
    who = None
    if athlete:
        who, cands = _resolve_athlete(athlete)
        if not who:
            return None, None, {"error": f"No single athlete matched '{athlete}'.", "did_you_mean": cands}
        params["athleteId"] = who["id"]
    elif team_id:
        params["teamId"] = team_id
    elif group_id:
        params["groupId"] = group_id
    type_id = _resolve_type(test_type)
    if type_id and not (athlete or team_id or group_id):
        params["testTypeId"] = type_id
    tests = _fetch_tests(params)
    if type_id:
        tests = [x for x in tests if (x.get("testType") or {}).get("canonicalId", (x.get("testType") or {}).get("id")) == type_id
                 or (x.get("testType") or {}).get("id") == type_id]
    tests.sort(key=lambda x: x.get("timestamp") or 0)
    return who, tests, None


# --------------------------------------------------------------------------- #
# Tools


@mcp.tool()
def hawkin_find_athlete(name: str = "", include_inactive: bool = True) -> dict:
    """Search Hawkin athletes by (partial) name. Empty name lists everyone.
    Returns id, name, teams, groups, sport, position and last-tested date."""
    people = _athletes(include_inactive)
    q = name.strip().lower().split()
    rows = []
    for a in people:
        if q and not all(p in (a.get("name") or "").lower() for p in q):
            continue
        rows.append({
            "id": a.get("id"), "name": a.get("name"), "active": a.get("active"),
            "teams": a.get("teams"), "groups": a.get("groups"),
            "sport": a.get("sport"), "position": a.get("position"),
            "last_tested": _local(a["lastTestedOn"]) if a.get("lastTestedOn") else None,
        })
    if q and not rows:
        _, cands = _resolve_athlete(name)
        return {"count": 0, "did_you_mean": cands}
    return {"count": len(rows), "athletes": rows[:300]}


@mcp.tool()
def hawkin_list_teams_groups() -> dict:
    """List Hawkin teams, groups and tags (id + name) for filtering tests."""
    def slim(items):
        return [{"id": i.get("id"), "name": i.get("name")} for i in items]
    return {
        "teams": slim(_data(_get("/teams"))),
        "groups": slim(_data(_get("/groups"))),
        "tags": slim(_data(_get("/tags"))),
    }


@mcp.tool()
def hawkin_get_tests(
    athlete: str = "",
    test_type: str = "",
    from_date: str = "",
    to_date: str = "",
    metrics: list[str] | None = None,
    all_metrics: bool = False,
    team_id: str = "",
    group_id: str = "",
    limit: int = 200,
) -> dict:
    """Get force-plate test trials. Filter by athlete (name or id), test_type
    (CMJ, SJ, ISO, DJ, CMJR, MR, WI, DL...), date range (YYYY-MM-DD, local time),
    team_id or group_id. `metrics` = label substrings to return (e.g.
    ["jump height", "system weight"]); default is a compact key set; all_metrics=True
    returns every metric. Most recent `limit` trials are returned, oldest first."""
    who, tests, err = _query(athlete, test_type, from_date, to_date, team_id, group_id)
    if err:
        return err
    total = len(tests)
    tests = tests[-max(1, limit):]
    rows = []
    for x in tests:
        mm = _metric_map(x)
        rows.append({
            "test_id": x.get("id"),
            "when": _local(x.get("timestamp")),
            "athlete": (x.get("athlete") or {}).get("name"),
            "test_type": (x.get("testType") or {}).get("name"),
            "tags": [t.get("name") for t in (x.get("testType") or {}).get("tags", []) or []],
            "metrics": {k: (round(v[0], 4) if isinstance(v[0], float) else v[0]) for k, v in mm.items() if v[0] is not None}
            if all_metrics else _pick(mm, metrics),
        })
    return {
        "athlete": who.get("name") if who else None,
        "total_matching": total,
        "returned": len(rows),
        "tests": rows,
    }


@mcp.tool()
def hawkin_metric_summary(
    athlete: str,
    metric: str,
    test_type: str = "",
    from_date: str = "",
    to_date: str = "",
) -> dict:
    """Summarize one metric for one athlete over a date range: max, min, mean,
    first, latest (with dates) plus the best value per testing day.
    `metric` is a label substring, e.g. "jump height", "mrsi", "system weight"."""
    who, tests, err = _query(athlete, test_type, from_date, to_date, "", "")
    if err:
        return err
    points, label_used, units_used = [], None, ""
    q = metric.lower()
    for x in tests:
        for label, (val, units) in _metric_map(x).items():
            if q in label.lower() and isinstance(val, (int, float)):
                if label_used is None:
                    label_used, units_used = label, units
                if label == label_used:
                    points.append((x.get("timestamp"), float(val), (x.get("testType") or {}).get("name")))
    if not points:
        return {"athlete": who.get("name"), "error": f"No values for '{metric}' in {len(tests)} tests."}
    vals = [p[1] for p in points]
    hi, lo = max(points, key=lambda p: p[1]), min(points, key=lambda p: p[1])
    by_day: dict[str, float] = {}
    for ts, v, _ in points:
        d = _local(ts)[:10]
        by_day[d] = max(by_day.get(d, v), v)
    def lbs(v):
        return round(v / 4.44822, 1) if units_used == "N" and "weight" in (label_used or "").lower() else None

    return {
        "athlete": who.get("name"),
        "metric": label_used,
        "note": "System Weight is in newtons; *_lbs fields give pounds." if lbs(1.0) else None,
        "max_lbs": lbs(hi[1]),
        "latest_lbs": lbs(points[-1][1]),
        "units": units_used,
        "trials": len(points),
        "testing_days": len(by_day),
        "max": {"value": round(hi[1], 4), "when": _local(hi[0]), "test_type": hi[2]},
        "min": {"value": round(lo[1], 4), "when": _local(lo[0]), "test_type": lo[2]},
        "mean": round(statistics.fmean(vals), 4),
        "first": {"value": round(points[0][1], 4), "when": _local(points[0][0])},
        "latest": {"value": round(points[-1][1], 4), "when": _local(points[-1][0])},
        "daily_best": [{"date": d, "value": round(v, 4)} for d, v in sorted(by_day.items())],
    }


@mcp.tool()
def hawkin_metric_definitions(test_type: str = "CMJ") -> dict:
    """List the metric names/units Hawkin calculates for a test type."""
    body = _cached("metrics", 86400, lambda: _get("/metrics"))
    tid = _resolve_type(test_type)
    aliases = TEST_TYPES.get(tid, [])
    items = _data(body) if not isinstance(body, dict) or "data" in body else list(body.items())
    out = []
    for it in items:
        if isinstance(it, tuple):
            name, metrics = it
        else:
            name, metrics = it.get("testTypeName") or it.get("name"), it.get("metrics") or it.get("data")
        if name and (name.lower() in aliases or (aliases and aliases[0] in name.lower())):
            out = metrics
            break
    return {"test_type": test_type, "metrics": out}


@mcp.tool()
def hawkin_force_time(test_id: str, every_nth_sample: int = 20) -> dict:
    """Get the raw force-time curve for one test (1000 Hz), downsampled by
    taking every Nth sample (default 20 -> 50 Hz) to keep the response small."""
    body = _get(f"/forcetime/{test_id}")
    n = max(1, every_nth_sample)
    out = {}
    for k, v in (body.items() if isinstance(body, dict) else []):
        out[k] = v[::n] if isinstance(v, list) and len(v) > 200 else v
    out["_downsample"] = n
    return out


@mcp.custom_route("/", methods=["GET"])
async def health(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "service": "hawkin-mcp", "key_set": bool(os.getenv("HD_REFRESH_TOKEN"))})


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
