# Late Reservation Handoff — GHL → Telegram → Bobby → ZenPlanner

How a parent's "can we still come to the 4:30?" text becomes an actual
reservation, given that nothing can write to ZenPlanner except a browser.

---

## The chain

```
Parent texts GHL
      ↓
GHL bot replies + applies tag  late-reservation
      ↓
GHL workflow fires a Custom Webhook
      ↓
Telegram Bot API  →  Bobby
      ↓
Bobby drives Chrome → ZenPlanner → reserves the athlete
      ↓
Bobby calls the GHL API → confirmation SMS to parent
```

Every hop is something you already have. Nothing new to buy.

---

## ⚠️ Read this before building: the session collision

Your own ZenPlanner notes say it plainly:

> *"Only one ZenPlanner session at a time. If another tab/window/device has
> ZenPlanner open, you will get a 'Heads up! Due to activity in multiple tabs...'
> modal that silently resets your session."*

**Late reservations happen between 2:00 and 6:00 PM — exactly when you or Matty
are most likely to be in ZenPlanner.** Bobby logging in mid-afternoon will
collide with a human session, and the reset is silent. Bobby thinks it booked
the kid. Nobody booked the kid. The parent was already told yes.

**Fix: give Bobby its own ZenPlanner staff login.** A separate user account
(`bobby@teamworkbloomington.com` or similar) with permission to manage
reservations. The tab-collision behavior is per-user-session, so a distinct login
keeps Bobby out of your way and you out of Bobby's.

**Confirm this before relying on it** — log Bobby's account in on one machine and
yours on another, use both, and see whether either drops. If ZenPlanner turns out
to collide account-wide, fall back to queuing: Bobby batches requests and works
them at :00 and :30, and any conflict alerts a human instead of failing silently.

This is the single most likely reason this system quietly breaks. Everything else
is plumbing.

---

## Step 1 — GHL side

### 1a. Bot behavior

When a parent asks to get into a session inside the 2-hour window, the bot:

1. Confirms warmly, **without over-promising**
2. Collects **athlete name** and **which session**
3. Applies the tag `late-reservation`

**Wording matters here.** Don't say "you're all set" — Bobby hasn't done anything
yet. Say:

> "Yep, no problem — I'll get [Athlete] added to the 4:30 and shoot you a
> confirmation in just a few minutes."

That's still a yes, still warm, but it sets up the confirmation text as the real
answer and gives you a window to catch a failure.

### 1b. Workflow

**Trigger:** Contact Tag Added → `late-reservation`
**Action:** Custom Webhook

```
Method: POST
URL:    https://api.telegram.org/bot<BOT_TOKEN>/sendMessage
Headers: Content-Type: application/json
```

**Body:**

```json
{
  "chat_id": "<YOUR_CHAT_ID>",
  "text": "RESERVE REQUEST\nathlete: {{contact.first_name}} {{contact.last_name}}\nsession: {{contact.late_session}}\nparent: {{contact.phone}}\ncontact_id: {{contact.id}}\nrequested: {{right_now}}"
}
```

`late_session` is a custom field the bot fills with the session time. If the AI
can't populate a custom field reliably, put the last inbound message in the
payload instead and let Bobby read the intent — it's a language model, it'll
manage.

**GHL can POST to any URL**, so this needs no Zapier in between. One less thing
to break and no per-task cost.

**Getting the Telegram pieces:** message `@BotFather` to create the bot and get
`<BOT_TOKEN>`. For `<CHAT_ID>`, message your bot once and open
`https://api.telegram.org/bot<TOKEN>/getUpdates` — the chat id is in the JSON.

---

## Step 2 — Bobby's instructions

Give Bobby a skill along these lines. Adapt to however you write its instructions.

```markdown
# Late Session Reservation

Triggered by a Telegram message starting with "RESERVE REQUEST".

## Steps

1. Parse athlete name, session time, contact_id.
2. Open ZenPlanner (studio.zenplanner.com) in Chrome. Log in with the
   Bobby staff account.
3. Search the athlete by name in the top search bar.
   - Contacts are filed under the ATHLETE's name, not the parent's.
   - No match? Try the sibling's name — one record often covers several
     athletes. Then the parent's name.
4. Reserve them into the requested session.
   [EXACT CLICK PATH — TO BE FILLED IN, see "What's missing" below]
5. VERIFY: re-open the athlete's schedule and confirm the reservation
   actually exists. ZenPlanner submits silently no-op.
6. Report back (see below).

## Hard rules

- If the session is FULL, do not force it. Report back and stop.
- If ZenPlanner shows the multi-tab modal or bounces to login, STOP and
  alert a human. Do not retry blindly — a silent session reset is exactly
  how a reservation gets lost.
- Never confirm to the parent until step 5 passes.
- One athlete per request. Two kids = two verifications.
```

---

## Step 3 — Close the loop

Bobby reports outcomes back through the GHL API. You already have this working.

### Success → text the parent

```
POST https://services.leadconnectorhq.com/conversations/messages
Authorization: Bearer <GHL_TOKEN>
Version: <2021-04-15 or v3>
Content-Type: application/json

{
  "type": "SMS",
  "contactId": "<contact_id from the payload>",
  "message": "All set — [Athlete] is in for the 4:30. See you there!"
}
```

Same API version caveat as `ghl_export.py`: flip `Version` if you get 404s.

### Bobby reports EVERY attempt to Rod on Telegram

Not just failures. Success too:

```
✅ RESERVED — [Athlete] into [session time]. Parent texted.
⚠️ FULL — [Athlete] not added to [session]. Needs a human.
❌ FAILED — [reason]. Needs a human NOW, parent was already told yes.
```

A log of successes is what makes a gap visible. If Bobby goes quiet for a day,
that should look wrong.

### Failure → tell a human, not the parent

Session full, athlete not found, ZenPlanner misbehaving — Bobby reports and
stops. A person decides what the parent hears. **Never let Bobby improvise a
"sorry, you can't come" text.** That's a customer-relationship call.

### Timeout → assume failure, and shout

If no confirmation lands within **10 minutes**, alert on **every channel at
once** — Telegram to Rod, SMS to Rod and Matty, and email. Do not rely on one.

The parent has already been told yes. The cost of a missed reservation is a kid
turning up to a session with no coach allocated — the exact thing the 2-hour
cutoff exists to prevent.

Build the timeout **first**. A handoff without one fails silently, and silent
failure here is worse than no automation at all.

---

## What's missing before this can be built

**The staff-side reservation click path.** You said Matty reserves people
"through the app on their end," but I've never seen that screen and won't invent
it. Same as the payment-method flow — a few screenshots of reserving an athlete
into a class and I'll write step 4 properly.

Specifically: where you start from (member profile? calendar? front desk?), what
you click, and what confirms it worked.

---

## Suggested rollout

1. **Notify only.** Webhook fires, Bobby does nothing, you get a Telegram ping
   and book it by hand. Proves the trigger and payload work.
2. **Bobby books, human confirms.** Bobby reserves, reports back, a human sends
   the parent's text. Proves the ZenPlanner automation.
3. **Full loop.** Bobby books and texts the confirmation itself.

Don't skip to 3. Stage 1 alone already fixes the real problem — that a late
request currently depends on someone noticing a text.

---

## A note on the login

Bobby using your autofill password is fine — it's your machine, your browser,
your credential, and it never passes through a prompt or a log. Worth keeping it
that way deliberately: the design should never need a password *in* an
instruction file, only a browser that already has one. If you set up the separate
Bobby account above, store that credential the same way.
