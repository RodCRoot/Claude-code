---
type: policy
area: customer-service-bot
status: confirmed
updated: 2026-11-18
tags: [cs-bot, cancellation, billing, high-risk]
---

# Cancellation and Commitments

Part of [[Customer Service Bot]]. The highest-risk area: a missed request past the 1st means a wrongful bill and a refund.

## 28-day risk-free
Sign up for a real membership; if it isn't a great fit in the first **28 days**, we cancel the agreement, no questions asked. **Not a trial. We do not do trials.**

Bot line: "We don't do trials, but we do have a 28-day risk-free policy. If it's not a great fit in the first 28 days, we cancel the agreement, no questions asked."

## Cancelling after 28 days
- **30 days' written notice by email to memberships@teamworkbloomington.com.** Texts, calls, and in-person don't formally process it.
- A request that arrives on the wrong channel is **still a real request** and is honored; staff mention the right channel gently.
- Notice given before the 1st that still billed is **our error**.
- For a 12-month agreement, notice to stop at term end comes in **month 11** (30 days before the billing date).

### Bot behavior
Never say it is cancelled. Acknowledge, give the email address, escalate same-day ([[Escalation Routing]]). Before accepting a cancel, run the [[Retention Ladder]] once.

> "Got it, I'll make sure the team sees this today. To start the official 30-day notice, send a quick email to memberships@teamworkbloomington.com and they'll confirm from there."

## End of a commitment
No commitment rolls into a second term. At the end of a 6- or 12-month agreement it **continues month-to-month at the committed rate** until cancelled in writing.

**System vs policy mismatch:** ZenPlanner is set to auto-renew and queues a full new term (and real autopay bills). We do not hold anyone to it. The bot answers from policy; staff should clean up queued bills. Members who see another term on their account are not locked in.

## Pauses
- Hold: max 2 months per membership year, firm restart date, never cancel-to-pause. Owner-approved (Rod and Erin). Bot cannot create one.
- In-season: see [[Retention Ladder]].
- Pauses **never** happen automatically after an injury ([[Injury Handling]]).

## Cannot-see rule
The bot cannot see ZenPlanner, so it never states balances, payment status, attendance, or term position.
