---
type: hub
area: customer-service-bot
status: draft
updated: 2026-11-18
tags: [teamwork-bloomington, cs-bot, hub]
---

# Customer Service Bot

Hub for everything the GoHighLevel voice + SMS assistant needs to know and do for Teamwork Bloomington. Start here.

**Job of the bot:** handle parents and new leads by phone and text. Primary goal is booking the [[Free Assessment]]. Secondary goals are accurate answers, capturing parent + athlete details, and keeping members from quitting (see [[Retention Ladder]]).

## Who it talks to
The GHL contact is filed under the **athlete's** name, but the person calling or texting is the **parent**. See [[Bot Persona and Rules]].

## Knowledge (what the bot looks facts up in)
- [[Programs and Class Schedule]]
- [[Rate Card]]
- [[Family Discount]]
- [[Free Assessment]]
- [[Cancellation and Commitments]]
- [[Make-Up Sessions]]
- [[FAQ Bank]]

## Situations (what the bot does)
- [[Retention Ladder]] — someone wants to pause, hold, or cancel
- [[Injury Handling]]
- [[Late Reservation and 2-Hour Cutoff]]
- [[Failed Payment Recovery]]
- [[Fitness Together and Linton]]

## Plumbing
- [[Escalation Routing]]
- [[Systems and Integrations]]
- [[ZenPlanner - Card and Autopay Procedure]]

## Still open
- [[Open Questions]]

## Source files in the repo
`cs-bot/knowledge-base.md`, `cs-bot/payment-failure-recovery.md`, `cs-bot/makeup-sessions.md`, `cs-bot/late-reservation-handoff.md`, `cs-bot/ghl_export.py`. The notes here are the distilled, linked version; the repo files keep the verbatim bot lines.
