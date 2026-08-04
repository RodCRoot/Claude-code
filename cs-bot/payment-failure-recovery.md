# Failed Payment Recovery — Runbook

Automated outreach when a member's card declines, plus the ZenPlanner cleanup
that actually makes the next bill go through.

**The whole point:** getting the member to add a new card is only half the job.
If the new card isn't made primary *and* attached to their active membership's
autopay, the next bill fails too and you're back here in 30 days.

---

## 1. The trigger

TWB has **no ZenPlanner API access**, so there's no webhook. The signal is email:

| Field | Value |
|---|---|
| From | `messages-noreply@zenplanner.com` |
| To | the member, **BCC'd to** `memberships@teamworkbloomington.com` |
| Content | payment failure / decline notice |

Common decline reasons: `Suspected Fraud – 59`, `Declined`, expired card. Per
the audit procedure, these usually mean a **replaced or blocked card**, not a
glitch — so they will not resolve on their own.

**Wiring it up (pick one):**

- **Zapier** — Gmail trigger on `from:messages-noreply@zenplanner.com` in the
  memberships@ inbox → match the member in GHL by name/email → add a tag like
  `payment-failed` → GHL workflow fires on the tag. Most maintainable.
- **GHL inbound email parse** — forward the notices into GHL and trigger there.
- **Manual for now** — staff tags the contact `payment-failed` and the same
  workflow runs. Worth starting here to test the messaging before automating.

⚠️ **Two notices sat unread for Xavier Farmer while his card declined.** Whatever
you build, it has to be something nobody has to remember to check.

---

## 2. The outreach sequence

Both channels on day 0 — text gets read, email carries the instructions.

**Tone: this is a friendly heads-up, not a collections notice.** Expired and
reissued cards are mundane. Never imply they did something wrong, and never
threaten cancellation.

### Day 0 — SMS

```
Hi [Parent First Name], it's Teamwork Bloomington. Heads up — the card on file
for [Athlete First Name]'s membership didn't go through this month. Nothing to
worry about, usually just an expired or reissued card.

You can update it yourself in the Zen Planner app: tap your profile picture in
the corner, then View Profile > Bills and Payments > Payment Methods.

Just reply here if you hit any trouble and we'll help you out.
```

### Day 0 — Email

> **Subject:** Quick heads up — payment method needs updating

> Hi [Parent First Name],
>
> The card on file for [Athlete First Name]'s membership didn't go through this
> month. This is usually just a card that expired or got reissued by the bank —
> easy fix.
>
> **To update it in the Zen Planner app (easiest, most people are on their phone):**
>
> 1. Open the **Zen Planner** app
> 2. Tap your **profile picture** in the corner — or the circle with your initials
> 3. Tap **View Profile**
> 4. Tap **Bills and Payments**
> 5. Tap **Payment Methods**
> 6. Add your new card
>
> **On a computer:**
>
> 1. Log in to Zen Planner
> 2. Go to **Profile**
> 3. Click **Bills and Payments**
> 4. Click **Payment Methods**
> 5. Add your new card
>
> Once it's in, reply and let us know — we'll make sure it's set up correctly on
> our end so your next payment goes through automatically.
>
> **Any trouble at all, just reply to this email or text us at [PHONE].** Happy
> to walk you through it.
>
> Thanks,
> Teamwork Bloomington

### Day 3 — SMS (if still unresolved)

```
Hi [Parent First Name] — just circling back on the payment method for
[Athlete First Name]'s membership. It can be updated in the Zen Planner app
under View Profile > Bills and Payments > Payment Methods.

Let us know if anything's giving you trouble — happy to help.
```

### Day 7 — SMS (final automated touch, then hand to a human)

```
Hi [Parent First Name], still seeing the card on file for [Athlete First Name]
hasn't updated. Want me to have someone give you a call to sort it out?
```

**Stop automated messages after day 7.** Past that it's a human conversation.

### Hard rules for every message

- **Never ask for a card number.** Not by text, not by email, not on a call.
  Staff never handle card numbers and neither does the bot.
- **Never include a payment link.** Direct them to the app they already have —
  a payment link in a "your card failed" message is indistinguishable from
  phishing and trains members badly.
- Never state a balance or amount owed — the bot can't see ZenPlanner.
- Stop the sequence the moment they reply. Hand to a human.

---

## 3. Staff follow-up in ZenPlanner — THE PART THAT ACTUALLY FIXES IT

**Do this every time a member says they've updated their card.** Adding a card
does not redirect billing.

Two separate things must be true, and they are not the same setting:

1. The new card is the **primary** payment method on the account.
2. The new card is the account **each active membership's autopay draws from**.

Your own audit notes the failure mode: *"A dead card can hold the primary flag
while billing lands elsewhere."* Memberships pick an autopay account **at
creation time** — so an existing membership can keep pointing at the old card
even after a new one is added and made primary.

### Checklist

Prefix: `https://studio.zenplanner.com/zenplanner/studio/index.html#/main/iframe/zenplanner/studio/`

- [ ] Find the member, grab `personId` from the profile URL
- [ ] Open payment methods: `payment/index.cfm?personId=<ID>`
- [ ] Confirm the **new card is present**
- [ ] Set the **new card as primary**
- [ ] **Remove or demote the dead card** so it can't reclaim the primary flag
- [ ] Open memberships: `membership/index.cfm?personId=<ID>`
- [ ] For **every active membership**, confirm autopay points at the **new card**
      — check each one, not just the newest
- [ ] Open bills: `bill/index.cfm?personId=<ID>&_c=firstName,description,status,dueDate,unpaidBalance,billAmount,autopayStatus&BillType=Bill`
- [ ] Confirm queued bills show `autopayStatus` against the new card
- [ ] Retry / collect the failed bill if it's still outstanding
- [ ] **Re-read the record after saving.** ZenPlanner submits silently no-op.

**CONFIRM:** the exact click path to set a card primary and to change a
membership's autopay account. I documented the URLs and the *what*, but not the
precise UI steps — those need to come from someone doing it once and writing
down what they clicked.

### Then close the loop with the member

```
All set [Parent First Name] — new card's on file and [Athlete First Name]'s
membership is good to go. Next payment will run automatically on the 1st.
Thanks for taking care of that!
```

Only send this **after** verifying the checklist above. Telling someone they're
all set when billing still points at a dead card is worse than saying nothing.

---

## 4. Known gotchas

- **Silent no-ops.** ZenPlanner will appear to save and not save. Always re-read.
- **Native `<select>` popups freeze the tab.** Set via DOM, never click-then-Enter.
- **One ZenPlanner session at a time.** A second tab silently resets the session.
- **Unsigned documents block attendance** — if they're billed but can't check in,
  that's a separate problem from the card.
- **Never submit login credentials**, even autofilled.

---

## 5. Worth measuring

- How many failures recover before the day-7 handoff
- How many recover on day 0 vs. needing chase
- How many **fail again next month** — that number is the real test of whether
  the primary-card step is being done properly. If it isn't near zero, the
  ZenPlanner checklist is being skipped.
