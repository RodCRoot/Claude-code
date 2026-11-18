---
type: policy
area: customer-service-bot
status: draft
updated: 2026-11-18
tags: [cs-bot, makeups, punch-card, zenplanner]
---

# Make-Up Sessions

Part of [[Customer Service Bot]]. Members don't lose sessions they paid for.

## Policy
- Requires an **active membership**. No active membership, no make-ups.
- Banked = sessions **paid for minus attended**, per month, over the **last 3 months only**.
- Any reason counts (travel, sick, injured, busy).
- **Dropping to a lower level doesn't forfeit** banked sessions. Someone going 3x to 1x keeps them and works through them alongside the new membership.
- Banked sessions go on a **punch card** that runs in tandem with the regular membership.

## Calculating
Entitlement per month: 4 / 8 / 12 for 1x / 2x / 3x ([[Programs and Class Schedule]]). Use the level in effect **that month**. Count only attendance rows with `ATT = Yes` (cancelled reservations show `ATT = No`).

Example, 3x member: May 12 entitled, 4 attended = 8; June 12 and 0 = 12; July 12 and 10 = 2. Punch card = **22**.

**Assumption (unconfirmed):** floor each month at zero, so a 14-session month on a 12 plan contributes 0, not -2.

## Building the punch card (ZenPlanner)
Custom membership, Sports Performance Training, the 7 Bloomington classes (not Linton), income category **Sports Performance**, amount **$0.00**, auto-renew **OFF**, and an **expiration** (suggested 3 months) so it can't drift open-ended. Re-read the record after saving. Exact punch-card field names still to capture: [[Open Questions]].

Tell the member the **number and the expiration**.

## Bot rule
Explain the policy, but **never state a number**: the bot can't see attendance. Hand off for the count ([[Escalation Routing]]).

> "You don't lose sessions you've paid for. As long as your membership is active we can put missed sessions on a punch card, going back up to three months. Let me have someone pull your exact count."

## Retention angle
A big banked balance is a concrete reason to stay: lead with it when a long-absent member asks ([[Retention Ladder]]).
