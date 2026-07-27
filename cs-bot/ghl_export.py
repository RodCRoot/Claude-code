#!/usr/bin/env python3
"""
Export GoHighLevel conversations + messages for analysis.

Pulls conversation threads from the GHL API and writes:
  - conversations.json  raw conversation records
  - messages.json       raw messages, keyed by conversation id
  - transcripts.txt     human-readable threads (this is the file to hand to an LLM)

Standard library only. No pip install required.

Usage:
    export GHL_TOKEN="pit-xxxxxxxx"
    export GHL_LOCATION_ID="xxxxxxxx"
    python3 ghl_export.py --limit 50 --redact

Notes on the API version:
    GHL's current docs are on "v3". The older "2021-04-15" version still works
    for most Private Integration tokens but is no longer maintained. If you get
    401/404s, flip GHL_API_VERSION to the other value and retry -- that is the
    single most common cause of failure here.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = os.environ.get("GHL_BASE_URL", "https://services.leadconnectorhq.com")
TOKEN = os.environ.get("GHL_TOKEN", "")
LOCATION_ID = os.environ.get("GHL_LOCATION_ID", "")
API_VERSION = os.environ.get("GHL_API_VERSION", "2021-04-15")

OUT_DIR = os.environ.get("GHL_OUT_DIR", "ghl_export")

# --- HTTP -------------------------------------------------------------------


def request(path, params=None, retries=5):
    """GET against the GHL API with backoff on 429/5xx."""
    url = BASE_URL.rstrip("/") + path
    if params:
        url += "?" + urllib.parse.urlencode(
            {k: v for k, v in params.items() if v is not None}
        )

    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Version", API_VERSION)
    req.add_header("Accept", "application/json")

    delay = 2
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:500]
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                sys.stderr.write(
                    f"  {e.code} on {path}, retrying in {delay}s...\n"
                )
                time.sleep(delay)
                delay *= 2
                continue
            sys.stderr.write(f"\nHTTP {e.code} on {url}\n{body}\n")
            if e.code in (401, 403):
                sys.stderr.write(
                    "\n-> Auth failed. Check GHL_TOKEN, and that the token's scopes\n"
                    "   include conversations/message.readonly and conversations.readonly.\n"
                )
            if e.code == 404:
                sys.stderr.write(
                    f"\n-> Not found. Try flipping GHL_API_VERSION (currently "
                    f"'{API_VERSION}') to 'v3' or '2021-04-15'.\n"
                )
            raise
        except urllib.error.URLError as e:
            if attempt < retries - 1:
                sys.stderr.write(f"  network error ({e.reason}), retry in {delay}s...\n")
                time.sleep(delay)
                delay *= 2
                continue
            raise
    return None


# --- Fetching ---------------------------------------------------------------


def fetch_conversations(limit=None, debug=False):
    """Page through /conversations/search."""
    out = []
    start_after_date = None
    page = 0

    while True:
        page += 1
        params = {
            "locationId": LOCATION_ID,
            "limit": 100,
            "sortBy": "last_message_date",
            "sort": "desc",
        }
        if start_after_date:
            params["startAfterDate"] = start_after_date

        data = request("/conversations/search", params)

        if debug and page == 1:
            sys.stderr.write(
                "DEBUG first response keys: "
                + json.dumps(list(data.keys()))
                + "\n"
            )

        batch = data.get("conversations") or []
        if not batch:
            break

        out.extend(batch)
        sys.stderr.write(f"  page {page}: +{len(batch)} (total {len(out)})\n")

        if limit and len(out) >= limit:
            out = out[:limit]
            break

        # Cursor forward on the oldest lastMessageDate in this batch.
        next_cursor = batch[-1].get("lastMessageDate")
        if not next_cursor or next_cursor == start_after_date:
            # No progress -> stop rather than loop forever.
            break
        start_after_date = next_cursor

        time.sleep(0.3)  # be polite to the rate limiter

    return out


def fetch_messages(conversation_id, debug=False):
    """Page through messages for one conversation."""
    msgs = []
    last_id = None

    while True:
        params = {"limit": 100}
        if last_id:
            params["lastMessageId"] = last_id

        data = request(f"/conversations/{conversation_id}/messages", params)

        if debug and not msgs:
            sys.stderr.write(
                "DEBUG messages response keys: "
                + json.dumps(list(data.keys()))
                + "\n"
            )

        # Response nests as {"messages": {"messages": [...], "nextPage": bool}}
        container = data.get("messages")
        if isinstance(container, dict):
            batch = container.get("messages") or []
            has_more = container.get("nextPage")
        else:
            batch = container or []
            has_more = False

        if not batch:
            break

        msgs.extend(batch)

        if not has_more:
            break

        new_last = batch[-1].get("id")
        if not new_last or new_last == last_id:
            break
        last_id = new_last

        time.sleep(0.2)

    return msgs


# --- Redaction --------------------------------------------------------------

PHONE_RE = re.compile(
    r"(?:\+?\d{1,2}[\s\-\.])?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}"
)
EMAIL_RE = re.compile(r"[\w\.\-\+]+@[\w\-]+\.[\w\.\-]+")


def redact(text):
    if not text:
        return text
    text = EMAIL_RE.sub("[EMAIL]", text)
    text = PHONE_RE.sub("[PHONE]", text)
    return text


# --- Output -----------------------------------------------------------------


def direction_label(msg):
    d = (msg.get("direction") or "").lower()
    if d == "inbound":
        return "CUSTOMER"
    if d == "outbound":
        return "US"
    return d.upper() or "?"


def write_transcripts(convos, messages_by_id, path, do_redact):
    with open(path, "w", encoding="utf-8") as f:
        for c in convos:
            cid = c.get("id")
            msgs = messages_by_id.get(cid) or []
            if not msgs:
                continue

            name = c.get("fullName") or c.get("contactName") or "Unknown"
            if do_redact:
                name = "Contact-" + (cid or "")[-6:]

            f.write("=" * 70 + "\n")
            f.write(f"CONVERSATION {cid}\n")
            # Contact records are stored under the athlete's name, but the
            # person in the thread is usually the parent.
            f.write(f"Contact (athlete name on record): {name}\n")
            f.write(f"Last message: {c.get('lastMessageDate')}\n")
            f.write(f"Type: {c.get('type')}\n")
            f.write("=" * 70 + "\n")

            # API returns newest-first; read oldest-first.
            for m in reversed(msgs):
                body = m.get("body") or m.get("meta", {}).get("transcript") or ""
                if do_redact:
                    body = redact(body)
                if not body.strip():
                    continue
                stamp = m.get("dateAdded", "")
                f.write(f"\n[{stamp}] {direction_label(m)}:\n{body.strip()}\n")

            f.write("\n\n")


# --- Main -------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, help="max conversations to pull")
    ap.add_argument(
        "--redact",
        action="store_true",
        help="strip names, phone numbers and emails from transcripts",
    )
    ap.add_argument("--debug", action="store_true", help="dump raw response shapes")
    args = ap.parse_args()

    missing = [
        n for n, v in (("GHL_TOKEN", TOKEN), ("GHL_LOCATION_ID", LOCATION_ID)) if not v
    ]
    if missing:
        sys.exit(f"Missing required env var(s): {', '.join(missing)}")

    os.makedirs(OUT_DIR, exist_ok=True)

    sys.stderr.write(f"API version: {API_VERSION}\nFetching conversations...\n")
    convos = fetch_conversations(limit=args.limit, debug=args.debug)
    sys.stderr.write(f"Got {len(convos)} conversations.\n\n")

    if not convos:
        sys.exit("No conversations returned. Re-run with --debug to inspect.")

    messages_by_id = {}
    for i, c in enumerate(convos, 1):
        cid = c.get("id")
        if not cid:
            continue
        sys.stderr.write(f"[{i}/{len(convos)}] messages for {cid}... ")
        try:
            msgs = fetch_messages(cid, debug=args.debug and i == 1)
            messages_by_id[cid] = msgs
            sys.stderr.write(f"{len(msgs)}\n")
        except Exception as e:  # keep going; one bad thread shouldn't kill the run
            sys.stderr.write(f"FAILED ({e})\n")
            messages_by_id[cid] = []
        time.sleep(0.2)

    with open(os.path.join(OUT_DIR, "conversations.json"), "w") as f:
        json.dump(convos, f, indent=2)
    with open(os.path.join(OUT_DIR, "messages.json"), "w") as f:
        json.dump(messages_by_id, f, indent=2)

    tpath = os.path.join(OUT_DIR, "transcripts.txt")
    write_transcripts(convos, messages_by_id, tpath, args.redact)

    total_msgs = sum(len(v) for v in messages_by_id.values())
    sys.stderr.write(
        f"\nDone. {len(convos)} conversations, {total_msgs} messages.\n"
        f"Wrote {OUT_DIR}/conversations.json, messages.json, transcripts.txt\n"
        f"\nHand transcripts.txt over for analysis.\n"
    )


if __name__ == "__main__":
    main()
