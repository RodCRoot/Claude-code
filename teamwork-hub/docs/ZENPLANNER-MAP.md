# Zen Planner staff-side map (research input, 2026-11-13)

Written by a separate research session that explored Rod's Zen Planner Studio account read-only, and added here unchanged
except for one balance figure removed. It contains configuration, field names and counts only: no member names.
It was written assuming the hub sits on top of Zen Planner; this project replaces Zen Planner, so read section 5 as
"what the hub must do at least as well", not as "do not build".

## What this changes in Teamwork Hub (lead's notes)
- **Import mappings can now be made exact.** Sections 2 and 3 give the real field names for Person (51), Membership (63),
  Bill (44) and Attendance (51) and the working export pattern `~/<object>/index.cfm?export=CSV&_c=<fields>`. The
  `zenplanner.*` import schemas were marked "unverified, configurable"; next step is presets for these exact columns,
  including Family ID and Parent fields (household key), Special Needs / Medications / Allergies (health data),
  the prospect block and UTM fields (leads), Att. Limit / Att. Limit Type / Class Card Att. Remaining (weekly limits and
  punch cards), Autopay?, Cancel Reason, Hold Reason. Attendance rows count as a visit only when `Att. = Yes`.
- **Mirror the controlled vocabularies** (prospect status, source, interest, priority, hold reason, drop reason, income and
  membership categories) as the default lists in the hub so imported records map one to one.
- **The real plan ladder is known** (section 4). Use it to pre-build the plan catalog for Rod to confirm, replacing
  the "Sample" plans. Prices here are Rod's configuration, not invented; still mark them "confirm before use".
- **Webhooks (People, Class Sessions, Attendance/RSVP) exist and are unused.** During the transition they are the right
  way to keep the hub current without scraping or holding Zen Planner's single login. Build a signed receiver.
- **The API may already be paid for.** Rod's daily scoreboard on 2026-11-11 lists a Zen Planner "API Usage Fee" payment.
  That answers open question 2 as "probably yes"; confirm, because API access would beat CSV for backfill.
- **Discounts: 32 ad-hoc codes, sibling discount applied by hand.** The hub already applies the family discount
  automatically; add an import report that lists every member on a non-standard discount for Rod to keep, convert or end.
- **"Change Card Info" is off for members in Zen Planner.** The hub's sign-up flow (saved card or bank account, managed by
  the parent) fixes this; mention it in the cutover notes.
- **47 tags carry sport, cohort and partner context.** Import them as tags, and map sport tags onto the athlete's sport.
- Open question 1 (where the hub lives): this repository, `teamwork-hub/`, branch `claude/teamwork-hub`.

---

# Zen Planner → Teamwork Hub: CRM build map

Staff-side exploration, 2026-11-13. Source of truth for what ZP already holds, what it can
push/pull, and where the hub actually has to add something.
Full raw crawl notes: see `zenplanner-crm-map-appendix.md`.

---

## 1. The headline

Zen Planner is not missing the CRM features. **It has them and they are switched off.**

| | Finding |
|---|---|
| Automations | 120 defined, **28 active**. The entire 4-stage prospect pipeline, every win-back touch, and almost all onboarding email is OFF. |
| Webhooks | 3 outbound feeds available (People, Class Sessions, Attendance/RSVP). **All 3 empty.** |
| Lead capture | ZP generates embeddable per-program "Request Info" forms that create prospects with full source attribution. **Not in use** — the website form still emails a human. |
| Attribution | `Tracking Source / Name / Medium / Keywords` are native Person fields. **Unused.** |
| Custom fields | 0 defined on all 6 entity classes. All athlete context lives in 47 free-text tags. |
| Engage (ZP's own marketing add-on) | Not connected, nothing synced. GHL fills this role. |

So the hub's first job is **not** to rebuild a CRM. It is to (a) turn the existing engine on,
(b) get the data out on a reliable feed, and (c) add the three things ZP genuinely cannot do.

---

## 2. Data model — what the hub can rely on

Every object below is exposed as a report grid at `~/<object>/index.cfm`, supports column
selection (`_c=`), filter criteria, per-person scoping (`?personId=<GUID>`), and CSV export.

**Person — 51 fields.** Identity, `Family ID`, `Parent First/Last/Email`, `Family`,
`Gender Identity`, `Birth Date`, `Address`, `Email`, `Phone`, `Bar Code`, `Status`,
**`Special Needs` / `Medications` / `Allergies`**, the full prospect block
(`Prospect Status (+sub)`, `Source (+sub)`, `Interest (+sub)`, `Referred By`,
`Prospect Priority`, `Sales Rep`), `Primary Instructor`, `Primary Location`,
`Inquiry Date`, `Trial End Date`, `Signup Date`, `Days as Prospect`, attendance rollups
(`Days Since Att.`, `First/Last Att. Date`, `Att. Last 30 Days`, `Att. Total`),
`Has Password?`, `Signed Documents`, and **UTM**: `Tracking Source/Name/Medium/Keywords`.

> Two corrections to assumptions we've been carrying:
> 1. **The parent/athlete relationship is native.** `Family ID`, `Parent First/Last/Email` and
>    `Family` are real ZP fields. Filing a GHL contact under the athlete's name with the parent's
>    phone is a *GHL-side* workaround, not a ZP limitation. The hub should key on ZP `Family ID`.
> 2. **Medical intake already has a home** — `Special Needs`, `Medications`, `Allergies`.

**Membership — 63 fields.** Plan identity, term (`Mbr. Begin/End Date`, `Months`), `Auto Renew`,
`Renewal Type`, `Has Been Renewed`, `Trial Member?`, cancellation block (`Cancel Date/By/Reason
(+sub)/Comments`), billing (`Installment Plan`, `# of Installments`, `Signup Fee`,
`Payment Amount`, `First Bill Due`, `Income Category`), **`Att. Limit`**, **`Att. Limit Type`**,
**`Class Card Att. Remaining`**, `Shared?`, `People (count)`, `Autopay?`, `Acct Name`.

> Also corrects the README: **"unlimited sessions abuse" is measurable today** (`Att. Limit` +
> the stock *Members Over Attendance Limit* report), and **punch-card / banked-session tracking
> is native** (`Class Card Att. Remaining`). Neither needs building — they need using.

**Bill — 44 fields.** Full money trail incl. `Due Date`, `Paid On Time`, `Amount Due/Paid/Unpaid`,
`Discount Total`, `Autopay Account/Approved By/Approved Date`.

**Attendance — 51 fields.** `Rsvp`, `Att.`, and `Canceled` are **separate** booleans —
a row is not a visit; only `Att. = Yes` counts. Plus `Session Type`, `Program`, `Location`,
`Staff Member`, and per-person rollups.

**Task — 10 fields.** `Due`, `Category`, `Title`, `Regarding`, `Assigned To/By`, `Status`,
`On Calendar?`. This is the staff-work object the pipeline automations write into.

**Entity classes** (from the custom-field admin): `Person`, `Membership`, `Program`,
`PersonProgram`, `EventRegistration`, `PromotionalTestRegistration`.

### Controlled vocabularies (mirror these as enums, don't invent your own)
- **Prospect Status**: New Prospect → Call 1 → Call 2 → Ready to Sign → Not Interested
- **Source**: Flyer, Newspaper Advertisement, Facebook, Referral, Walk-in, Drive By, Website, Other
- **Interest**: General Fitness, Performance Training, Weight Loss, Police/Fire/Military, Endurance, Other
- **Priority**: Low / Medium / High
- **Hold Reason**: Vacation, Illness, Injury, Financial, maternity, busy, sports
- **Drop Reason**: 12 values incl. Price is too expensive, Doesn't fit my schedule, Membership Upgrade, Administrative Drop
- **Income Category**: 12 incl. Sports Performance, Youth, Adult Performance Training, Six Week Challenges
- **Membership Category**: 14 incl. Sport Performance and Youth Memberships, In-Season, Add-On

---

## 3. Getting data in and out (no API access)

Ranked by how much I'd trust them.

**1. Webhooks — `~/plugins/webhook.cfm`. The right answer, currently unused.**
Three outbound feeds, each taking a URL + Account ID + Shared Secret:
`People`, `Class Sessions`, `Attendance / RSVP`. This gives the hub near-real-time pushes
with no polling and no session contention. `webhook-server.js` + `webhook-data/` in this repo
are a prior start on exactly this.

**2. CSV export — verified working.**
`GET /zenplanner/studio/person/index.cfm?export=CSV` → `200 text/csv`, 1699 rows, 116 KB.
Pattern generalizes: `~/<object>/index.cfm?export=CSV&_c=<fields>&<criteria>`.
Good for nightly backfill and reconciliation against the webhook stream.

**3. Import wizard — `~/import/index.cfm`.** Bulk *in*: People, Enrollment & Membership,
Attendance, Rank History. One-directional, wizard-driven, not automatable.

**4. Screen-scraping the SPA. Avoid for anything scheduled.**
ZP allows **one session per account, org-wide** — a scheduled scraper logs Rod out mid-task.
That constraint alone is the argument for webhooks + CSV.

Mechanics if we do touch pages: same-origin `fetch()` carries the session; forms require a
hidden `__xsToken` CSRF token; many config values live in `<input value=…>` not text nodes;
the "It looks like you've left us…" idle banner is in *every* page's HTML and does **not**
indicate an expired session.

Also present but idle: `~/ssoTarget/index.cfm` (Remote Login/SSO), `~/plugins/mail-chimp.cfm`.
A local `zenplanner-api-spec.json` (422 KB) and `zenplanner-api-order-form.pdf` exist in this
repo — worth confirming whether API access was ever actually purchased, since that would
change this whole section.

---

## 4. What's configured today

**Pricing ladder** (33 membership options, frequency × commitment, all `Online? = No`):

| | 12-month | 6-month | Month-to-month |
|---|---|---|---|
| 1x/wk | — | — | $129.00 |
| 2x/wk | $178.99 | $197.99 | $232.99 |
| 3x/wk | $221.99 | $261.99 | $348.00 |
| 4x/wk | $295.99 | $375.99 | $465.00 |
| Unlimited | $309.99 | $419.99 | $569.00 |

Plus In Season $99, College Plan $50, Fitness Together ($10 drop-in → $60 unlimited),
Bootcamp $75, 6-week challenges $229–299, Summer 8-week $249, Vertical Jump $349.99
(+$149.99/$229.99 add-ons), All-Girl Speed & Strength $229/$279.99, Linton $60/$75.

**Programs (8)**: Sports Performance Training, Adult Performance Training, Strategy Session
(New Members), Fitness Together Group Classes, Optavia, Goal Setting, Mommy and Me Yoga,
FALL 2025 Boy's Vertical Jump.

**Classes**: 6 Fitness Together slots; Bloomington SP at 6:00AM / 3:30 / 4:30 / 5:30 / 6:30PM
weekdays + Sat 9:00AM; Linton SP Mon-Thu-Fri 6:00AM + Tue/Thu 5:30PM.
All are `Online=Yes, Rsvp=Yes`, **`Free Trial=No` everywhere.**

**Groups (47 tags)**, carrying all athlete context: sports (Baseball 35, Basketball 33,
Football 27, Soccer 28, Volleyball 14 …), cohorts, locations, partner orgs (BRC, BWB,
Warriors 2026, Sunshine Kids), and status (`Inactive` 184).
Hygiene is poor: `In-Season Athletes` = **0** despite in-season being a live billing concept,
`Linton` = **0**, `Male` = 3 (dead gender tag), and 2025/2026 cohorts duplicate.

**Discounts: 32, all active, no rules engine.** Two structured (`Family Rate: Two Members`,
`Family Rate 3-Members`) plus a long tail of ad-hoc codes — `$177.99 Off`, `19.899 off`,
`139`, `13 off`, `86 0ff 2017 three times a week`. The sibling discount is applied **by hand**,
which is precisely why it gets missed when a second sibling enrolls.

**Member portal privileges** — ON: add/update family profiles, view attendance, upload photo,
guardian identification, view bills, pay bills, mobile check-in.
**OFF: `Change Card Info`** ("members change their payment information online").
⚠️ Needs verifying from the member side — if that's genuinely off it collides directly with
the current past-due balance and the recurring declined-card cases, and the card-update instructions in the
`membership-status-check` skill point members at a path they may not have.

---

## 5. Where the hub actually adds value

Ordered by money, not by interest.

**A. Turn the pipeline on (hub does nothing; this is config).**
127 prospects, a 5-stage status vocabulary, and a complete Stage 1–4 automation set that is
entirely inactive. Before building any lead tooling, this gets switched on and watched.

**B. Wire the webhooks → hub ingestion.**
People / Class Sessions / Attendance feeds into the existing `webhook-server.js`. This is the
foundation everything else sits on, and it's the one integration ZP supports natively that
nobody has used.

**C. Close the website-lead loop with ZP's own Request Info widget.**
Per-program embeddable form → prospect created in ZP with Source/Interest/UTM populated →
Stage 1 automation fires. Replaces "form emails a human" and finally makes
*Prospect Source Report* and *Prospect Conversion Rate (90 Days)* mean something.

**D. Structured athlete profile — genuinely missing.**
Sport, grade, school, position, goals and assessment data live in tags or in
`assessment-data.md`, not in ZP. ZP supports custom fields on `Person` and `PersonProgram`
and has **zero** defined. Either define them there or own the athlete profile in the hub and
key it to ZP `Family ID` / `PersonId`. This is the clearest case for hub-owned data.

**E. A discount/rate rules engine — genuinely missing.**
Sibling %, in-season switching, hold proration and the 6-month→month-to-month rollover are all
manual and all have produced real billing errors. ZP has no rules layer. The hub can watch the
membership feed and flag or propose corrections.

**F. Cross-system identity (ZP ↔ GHL).**
Two systems, two naming conventions, no shared key. The hub should hold the mapping —
ZP `PersonId`/`Family ID` ↔ GHL contact — and make "who is this person" answerable once.
This is the root cause behind the missed-email incidents in the status-check skill.

**Explicitly do NOT build**: attendance-limit tracking, punch-card balances, family
relationships, or medical intake. All four already exist in ZP and just need to be used.

---

## 6. Open questions

1. Where does the hub codebase live? Nothing named "hub" exists under `~`. Candidates:
   `~/Vantage App` (Next.js + Prisma + Postgres, coach/athlete programming platform),
   or greenfield.
2. Was ZP API access ever purchased? `zenplanner-api-spec.json` + the order form are both here.
   A yes collapses most of section 3.
3. Is `Change Card Info` really off for members? (Checking on the client login.)
4. Does the hub own the athlete profile, or do we define custom fields in ZP and mirror?

---

## 7. URL reference

Base: `https://studio.zenplanner.com/zenplanner/studio/index.html#/main/iframe/zenplanner/studio/`

| Surface | Path |
|---|---|
| Person detail | `person/edit.cfm?PersonId=<GUID>` |
| People grid / report builder | `person/index.cfm` (`?export=CSV`) |
| People list | `person/welcome.cfm` (200/page) |
| Memberships / Bills / Payments | `membership|bill|payment/index.cfm?personId=<GUID>` |
| Documents | `document/index.cfm?personId=<GUID>` |
| Automations | `automation/index.cfm` |
| Membership options | `membershipTemplate/index.cfm` |
| Custom fields | `customField/index.cfm?class=<Class>` |
| Lookup codes | `lookupCode/index.cfm?Type=<TypeId>` |
| Groups (tags) | `tag/index.cfm` |
| Discounts | `discount/index.cfm` |
| Webhooks | `plugins/webhook.cfm` |
| Member privileges | `portal/member.cfm` |
| Registration + Request Info forms | `portal/registration.cfm` |
| Reports | `welcome/index-reports.cfm?Category=<Cat>` |
| Lead capture widgets | `#/main/setup/myWidgets`, `/freeTrialWidget`, `/calendarWidget` |
| Form builder | `#/main/setup/form-builder` |
