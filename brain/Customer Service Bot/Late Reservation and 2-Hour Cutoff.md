---
type: playbook
area: customer-service-bot
status: draft
updated: 2026-11-18
tags: [cs-bot, scheduling, zenplanner, bobby, automation]
---

# Late Reservation and 2-Hour Cutoff

Part of [[Customer Service Bot]]. Plumbing: [[Systems and Integrations]].

## The rule
ZenPlanner **hard-blocks** self-service signup within 2 hours of a session. Parents hit it and text. **The answer is yes**, warmly:

> "Yeah, no problem at all, I'll get [Athlete] added to the 4:30. Thanks for the heads up!"

## Why the cutoff exists
High schoolers showed up unreserved and signed up from the parking lot, overpacking sessions with too few coaches. The cutoff protects coach ratio, equipment, and safety. The heads-up helps us: on slow nights we send coaches home.

## Limits
- Only real exception: a **full session**. The bot can't see capacity, so it never says "there's room".
- Only **Matty or Rod** can override the cutoff (they reserve through the app).

## The mechanics (nothing can write to ZenPlanner but a browser)
No ZenPlanner API access, and even previously the scope didn't allow it.

`Parent texts GHL -> bot replies + tags late-reservation -> GHL workflow webhook -> Telegram -> Bobby (OpenClaw agent) drives Chrome in ZenPlanner -> reserves athlete -> Bobby calls GHL API -> confirmation SMS to parent`

- Bot wording avoids "you're all set": "I'll get [Athlete] added and text you a confirmation in a few minutes."
- Bobby **verifies** the reservation before confirming (ZenPlanner submits silently no-op).
- Session full / athlete not found / ZenPlanner glitch: Bobby stops and alerts a human. Never improvises a "no" to the parent.
- **10-minute timeout** alerts every channel at once ([[Escalation Routing]]). The parent has already been told yes, so a miss means a kid shows up unreserved: the exact problem the cutoff prevents.

## Biggest risk
ZenPlanner allows one session per login; a second tab silently resets it. Late requests land 2-6 PM when staff are in ZenPlanner. **Give Bobby its own staff login** and test that both sessions coexist.

## Rollout
1. Notify-only (webhook pings, a human books). 2. Bobby books, human confirms. 3. Full loop. Don't skip to 3.

## Missing
Staff-side screenshots of reserving an athlete into a class: [[Open Questions]].
