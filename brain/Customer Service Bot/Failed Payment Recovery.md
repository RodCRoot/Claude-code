---
type: playbook
area: customer-service-bot
status: draft
updated: 2026-11-18
tags: [cs-bot, billing, outreach, zenplanner]
---

# Failed Payment Recovery

Part of [[Customer Service Bot]]. Staff-side fix: [[ZenPlanner - Card and Autopay Procedure]].

## Trigger
No ZenPlanner API, so the signal is the decline email from `messages-noreply@zenplanner.com` (BCC'd to memberships@). Options: Zapier Gmail trigger, GHL inbound email parse, or manual tag `payment-failed`. Start manual. Two such notices once sat unread, so it must not rely on someone remembering to check.

## Outreach sequence (stop on reply, hand to a human)
- **Day 0, SMS + email:** friendly heads-up (usually an expired or reissued card), step-by-step directions, "let us know if you have any issues".
- **Day 3, SMS:** circle back with the app path.
- **Day 7, SMS:** offer a call, then **stop automated messages**.

## Directions to give the parent
**App:** Zen Planner app, tap profile picture (or initials circle), View Profile, Bills and Payments, Payment Methods, add the card.
**Desktop:** log in, Profile, Bills and Payments, Payment Methods, add the card.

## Hard rules
- Never ask for or repeat a **card number**.
- **No payment links** in these messages (indistinguishable from phishing).
- Never state a balance or amount owed (bot can't see it).
- Tone is a heads-up, never a threat.

## Closing the loop
When the parent says they updated it, a **human** completes the ZenPlanner steps, *then* texts "you're all set". The bot never confirms the fix itself.

## Measure
How many fail **again** the next month. If not near zero, the autopay step is being skipped.
