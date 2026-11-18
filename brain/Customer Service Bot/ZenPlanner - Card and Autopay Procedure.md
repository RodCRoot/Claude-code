---
type: procedure
area: customer-service-bot
status: confirmed
updated: 2026-11-18
tags: [zenplanner, billing, autopay, staff-procedure]
source: Rod walkthrough with screenshots
---

# ZenPlanner: Card and Autopay Procedure

Staff procedure used by [[Failed Payment Recovery]]. Part of [[Customer Service Bot]].

## The trap
The Add a Payment Method form's **Primary Account** checkbox says: *"Use as default payment account. **Does not affect existing autopay.**"* Primary only sets the default for new charges. Each existing membership keeps drawing from whatever account it was set to.

## Part A: add the card, make it primary
1. Member profile, **Financial**.
2. **Add** (or Make a Payment) to open **Add a Payment Method**.
3. Fill in account name, name, card, expiration, address, state, zip.
4. Tick **Primary Account**, Save.
5. Verify in the **ACCOUNTS** table: new card shows PRIMARY = YES. Remove or demote the dead card.

## Part B: repoint each membership's autopay (do not skip)
For **every active membership**: Memberships, open it, **SELECT ACCOUNT FOR AUTOMATIC PAYMENT**, choose the new account, Save and Continue.
- Never leave it on **OFF**. OFF stops autopay silently: no decline, bills just pile into Past Due.
- Choose by **account label, not last-4**: a reissued card re-added under a new label can share the same last four digits as the dead one.

## Part C: verify
New card primary; dead card gone; every membership on the new account; upcoming bills not at status OFF; failed bill collected; **re-read after saving** (ZenPlanner silently no-ops).

## Related gotchas
One ZenPlanner session at a time; native selects freeze the tab (set via DOM); never submit login credentials; refund submit can hang the renderer, hand to Rod.

## Staff-side reference (member-facing path lives in [[Failed Payment Recovery]])
Unsigned documents block attendance and are a separate problem from billing.
