---
type: reference
area: customer-service-bot
status: draft
updated: 2026-11-18
tags: [cs-bot, systems, ghl, zenplanner]
---

# Systems and Integrations

Part of [[Customer Service Bot]].

| System | Role | Notes |
|---|---|---|
| **GoHighLevel (GHL)** | Conversation layer: voice AI, SMS, lead follow-up, calendar | White-labeled at app.automaticmembers.com. API works. Contacts filed under athlete name, phone/email are the parent's. |
| **ZenPlanner** | System of record: memberships, billing, attendance, reservations | No API access (and past scope was too narrow anyway). Browser only. |
| **Bobby (OpenClaw agent)** | Drives Chrome to do ZenPlanner writes | Uses Rod's autofill login; Claude never handles the login. Report via Telegram. |
| **Telegram** | Alerts to Rod, and trigger channel to Bobby | GHL webhook posts directly to the Telegram Bot API. |
| **memberships@ inbox** | Cancellation notices, ZenPlanner decline emails, contact form | Also receives AI Call Recap emails. |
| **Angela (existing voice agent)** | Takes calls, emails a recap | **Recaps never reach GHL**, so cancellation requests are invisible. Decide: replace or coexist with the new bot ([[Open Questions]]). |

## What the bot can't see
Billing, balances, attendance, banked sessions, class capacity, queued terms. Anything depending on these is a handoff ([[Escalation Routing]]).

## Tooling in the repo
- `cs-bot/ghl_export.py`: stdlib exporter that pulls conversations and messages to `transcripts.txt`. Untested against the live API. Needs a Private Integration token with `conversations.readonly` and `conversations/message.readonly`, plus the Location ID. If it 404s, flip `GHL_API_VERSION` between `2021-04-15` and `v3`.
- Compliance to verify: A2P 10DLC registration and STOP opt-out handling before automating outbound.

## Hard rules for any agent
Never submit login credentials; one ZenPlanner session per login; verify after every write.
