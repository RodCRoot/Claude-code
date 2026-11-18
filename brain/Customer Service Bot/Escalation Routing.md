---
type: policy
area: customer-service-bot
status: draft
updated: 2026-11-18
tags: [cs-bot, escalation, telegram]
---

# Escalation Routing

Part of [[Customer Service Bot]].

## Same-day triggers
Cancellation, hold, in-season change, refund, injury, billing dispute, complaint, make-up count request, late reservation ([[Late Reservation and 2-Hour Cutoff]]). A request unseen past the 1st means a wrongful bill and a refund.

## Channels: all of them, every time
Redundancy is the point.
| Channel | Who |
|---|---|
| Email | staff / memberships@ |
| SMS | staff |
| Telegram | Rod, on every escalation **and** every Bobby action |
| Anything else available | use it |

Bobby reports **every** reservation attempt to Rod on Telegram, successes too, so silence reads as a fault.

## Every escalation carries
- Athlete name **and** who actually made contact (usually the parent)
- What they asked, in their own words
- Channel and a link to the conversation
- Anything time-sensitive, especially proximity to the 1st
- **What the bot already told them**, so nobody contradicts it

## Who decides what
- Pause / hold approval: owners, **Rod and Erin**.
- Cutoff override / reservation: **Matty or Rod**.
- Injury: coaches notified by text; gym injuries get an incident report.

## Open
Which specific staff emails and phone numbers receive each channel: [[Open Questions]].
