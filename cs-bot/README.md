# Teamwork Bloomington — CS Bot Knowledge Base

Tooling and source content for the GoHighLevel Voice AI + SMS assistant.

| File | What it is |
|---|---|
| `knowledge-base.md` | The master knowledge file. Fill in the `[BRACKETS]`. |
| `ghl_export.py` | Pulls real conversation history out of GHL for analysis. |

---

## Step 1 — Get a GHL API token

1. In GHL go to **Settings → Private Integrations** (sub-account level, not agency).
2. Create a new Private Integration token.
3. Give it at least these scopes:
   - `conversations.readonly`
   - `conversations/message.readonly`
   - `contacts.readonly`
4. Copy the token — GHL shows it once.
5. Grab your **Location ID** from **Settings → Business Profile** (or read it out of the URL).

The token is a credential. Keep it in your shell, not in a file, and don't commit it.

## Step 2 — Export your conversations

```bash
cd cs-bot

export GHL_TOKEN="pit-xxxxxxxxxxxx"
export GHL_LOCATION_ID="xxxxxxxxxxxx"

# Start with a small sample to confirm it works
python3 ghl_export.py --limit 25 --redact
```

If that looks right, pull everything:

```bash
python3 ghl_export.py --redact
```

Output lands in `ghl_export/`:

- `transcripts.txt` — readable threads. **This is the file to hand over for analysis.**
- `conversations.json` / `messages.json` — raw API records, kept for reference.

### Flags

| Flag | Effect |
|---|---|
| `--limit N` | Stop after N conversations. Use for a quick sample. |
| `--redact` | Strip names, phone numbers, and emails from `transcripts.txt`. |
| `--debug` | Print raw response shapes. Use when something looks wrong. |

### On `--redact`

Recommended. Your threads involve youth athletes and their parents, so the
transcripts contain minors' contact details. Redaction removes names, phones,
and emails while leaving the useful content — the questions, the answers, the
policies, the pricing — completely intact. Nothing about the analysis needs
real identities.

## Troubleshooting

**401 / 403** — token wrong or missing scopes. Regenerate with the scopes above.

**404** — almost always the API version. The script defaults to `2021-04-15`;
GHL's current docs are on `v3`. Flip it and retry:

```bash
GHL_API_VERSION=v3 python3 ghl_export.py --limit 5 --debug
```

**Zero conversations returned** — check the Location ID is the sub-account, not
the agency. Re-run with `--debug` to see the response shape.

**429s** — the script backs off and retries automatically. Let it run.

---

## Step 3 — Build the knowledge base

With `transcripts.txt` in hand, the analysis pulls out:

- the questions people actually ask, ranked by frequency
- your team's real phrasing and tone
- how policies get applied in practice (often ≠ what the policy doc says)
- contradictions between staff answers, which need settling before the bot picks one at random
- which replies actually led to a booking

Those feed into `knowledge-base.md`, which then loads into GHL:

1. **Section 1 (Persona)** → the bot's prompt/persona field
2. **Section 8 (FAQs)** → GHL's FAQ trainer, highest accuracy input, load first
3. **Whole file** → uploaded as a knowledge document

## Step 4 — Test and patch

Run 10–15 real past conversations past the bot. Every wrong answer or "I don't
know" gets patched back into Section 8. This loop is what makes the bot good —
the first upload never is.
