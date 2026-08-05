# Make-Up Sessions — Runbook

Calculating banked sessions and setting up the punch card in ZenPlanner.

**Policy in one line:** members don't lose sessions they paid for. As long as
the membership is active, unused sessions from the **last 3 months** go onto a
punch card that runs alongside the regular membership.

---

## 1. Eligibility

| Requirement | Rule |
|---|---|
| Active membership | **Required.** No active membership, no make-ups. |
| Lookback window | **3 months maximum.** Never further back. |
| Reason for missing | Irrelevant — travel, illness, injury, busy month, all fine. |
| Changed levels | Still eligible. Dropping 3x → 1x does not forfeit banked sessions. |

---

## 2. Monthly entitlement

| Membership level | Sessions per month |
|---|---|
| 1x per week | 4 |
| 2x per week | 8 |
| 3x per week | 12 |

---

## 3. Calculating banked sessions

**Banked = (entitlement − attended), summed month by month over the last 3 months.**

Use the membership level **in effect during each month**, not their current one.
Someone who was on 3x in May and 1x in July is owed against 12 in May and 4 in July.

### Attendance source

ZenPlanner → member → **Attendance** → *View All Attendances*.

**A row is not a visit.** Cancelled reservations appear with `ATT = No`. Count
only rows where **`ATT = Yes`**. The extraction snippet in the
`membership-status-check` skill produces a per-month attended count directly.

### Worked example

A 3x per week member (12/month), last three months:

| Month | Level | Entitled | Attended | Banked |
|---|---|---|---|---|
| May | 3x | 12 | 4 | 8 |
| June | 3x | 12 | 0 | 12 |
| July | 3x | 12 | 10 | 2 |
| | | | **Total** | **22** |

Punch card = **22 sessions**.

### ⚠️ Decision needed — over-attendance months

If someone attends **more** than their entitlement in a month, does the surplus
offset a deficit in another month?

- **Floor each month at zero (recommended).** A month where they trained 14 on a
  12 plan contributes 0, not −2. Simpler to explain, and consistent with the
  audit note that Rod is *"deliberately generous about the odd second session."*
- **Net across the window.** Surplus cancels deficit. Produces smaller punch
  cards and harder conversations.

The two give different numbers on the same account, so pick one and apply it
consistently. **This runbook assumes floor-at-zero until told otherwise.**

---

## 4. Setting up the punch card in ZenPlanner

The member ends up with **two memberships running in tandem**:

1. Their **regular** 1x / 2x / 3x membership — unchanged
2. A **custom membership** configured as a punch card holding the banked sessions

### Steps

1. Member profile → add a **Custom** membership
   (`newPerson/membership-custom.cfm?personId=<ID>`)
2. Configure as a **punch card** for the banked session count
3. **Program:** Sports Performance Training
4. **Classes:** the 7 Bloomington class IDs — **not** the 2 Linton ones
   (see `zenplanner-add-membership` skill for the ID list)
5. **Income Category:** **Sports Performance**
   (`801073CC-FE52-4277-9BE6-C106469B59CE`) — the default is wrong and misfiles
   the revenue
6. **Amount: $0.00** — these sessions are already paid for
7. **Auto-Renew: OFF**
8. Set an **expiration** on the punch card — see below

**CONFIRM:** the exact punch-card field names and where the session count goes.
Rod notes the custom membership builder is "very intuitive," but the precise
settings aren't written down here yet. Whoever builds the first one, capture it.

### ⚠️ Set an expiration

An open-ended punch card is the same defect as an open-ended in-season
membership — the Xavier Farmer pattern, where no end date meant it drifted for
five months unnoticed.

**CONFIRM:** how long a punch card should stay live. Suggested default: **3
months** from issue, matching the lookback window.

### Verify after saving

- [ ] Punch card shows the correct **session count**
- [ ] Amount is **$0.00** — no new charge created
- [ ] Auto-renew **OFF**, expiration set
- [ ] Regular membership **untouched** and still billing normally
- [ ] Income category is Sports Performance
- [ ] **Re-read the record.** ZenPlanner submits silently no-op.

---

## 5. Tell the member

```
All set — you've got [N] make-up sessions on a punch card, good through [DATE].
Just come to any regular session and they'll come off the card automatically.
Your normal membership keeps running as usual.
```

Always give the **number** and the **expiration**. A punch card nobody knows the
size or deadline of doesn't get used, which defeats the point.

---

## 6. Watch for

- **Punch card as a retention tool.** Someone asking about make-ups after a long
  gap is often weighing cancellation. Twenty-two banked sessions is a concrete
  reason to stay — lead with it.
- **Under-use is a refund request with a delay on it.** The audit skill is blunt
  about this: members paying while not attending generated a complaint. A punch
  card converts that grievance into value they still get.
- **Don't stack indefinitely.** Reissuing a punch card every quarter for someone
  who never attends is a membership problem, not a make-up problem. Escalate.
