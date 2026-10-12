# Forms, guardian e-signatures, completed PDFs, document archive

Owner paths: `src/app/(app)/documents/**`, `src/app/api/files/**`, `src/lib/forms/**`, `src/lib/pdf/**`, `assets/fonts/**`, `scripts/fonts/**`,
`scripts/seed/documents.ts`, `tests/forms*.test.ts`.

> **Pilot notice.** The typed-name signing workflow is a *verifiable pilot*: it records who signed, when, from
> where, how their identity was checked, and exactly what they signed, sealed by SHA-256 hashes. It is not a
> complete production e-signature system and makes no claim about legal enforceability (identity checks reduce
> impersonation risk; they do not by themselves make a document enforceable). All seeded form text is **SAMPLE TEXT** and must be
> replaced with Teamwork-approved language (owner/admin "Mark approved" removes the label).

## Model
| Concept | Where | Notes |
|---|---|---|
| Template | `form_templates` | kind, renewal months (null = never), required for booking, active |
| Version | `form_template_versions` | draft → published. `content_hash` = SHA-256 of canonical JSON {title, body, fields, signers}. Published rows are immutable (DB triggers, below). **Earlier versions stay `published`**; the current version is the highest published number. |
| Step-up code | `signer_step_up_challenges` | One-time email codes for signer identity: HMAC of the code only, expiry, attempts, delivery result, consumed-by signature. |
| Request | `form_requests` | pending → partially_signed → completed → expired; or superseded / voided. `submitted_data` is frozen by the first data-bearing signature. |
| Signature | `signatures` | immutable (trigger). Stores consent text verbatim, typed name, role, relationship, IP, user agent, auth method, `template_content_hash`, `data_hash`, ms-precision `signed_at`. |
| Audit | `form_audit_events` + `audit()` | issued, signed, status_changed, completed, superseded, voided, reminder_queued, expired, renewal_issued |
| Archive | `archived_documents` + `stored_objects(kind imported_archive)` | original PDF + original system/date/notes. Never creates signatures. Labeled "Imported archive — original evidence only". |

## Signer rules (`src/lib/forms/signing.ts`, `fields.ts`)
- Roles: `guardian`, `second_guardian`, `adult_athlete`, `athlete_assent`, `staff_witness`.
- Guardian roles need an active guardianship with `can_sign_forms` (policy `forms.sign`). A person signs at most one role per request; the second guardian is a different person and signs independently.
- Subject 18+ (by DOB at signing time): guardian roles don't apply; `adult_athlete` is required if the version requires guardian or adult_athlete. Minors never sign for themselves except `athlete_assent` (after a guardian has submitted the data).
- A *required* `second_guardian` is enforced only when the athlete has ≥2 guardians with signing permission.
- Staff with `forms.manage` can record an in-person signature on their device after checking the signer's identity and ticking the attestation (required); `auth_method` = `staff_witnessed_in_person; witness=<name> [<user id>]; identity=staff_attested`. (Signatures made before this change carry the legacy `in_person_staff_witnessed; witness=…`, shown as "witnessed" without an identity attestation.)
- Field values are validated server-side against the version definition; unknown keys are dropped. Later signers sign over the frozen data (same `data_hash`). Corrections = "Void & reissue".

## Signer identity step-up (`src/lib/forms/step-up.ts`)
Org setting `organizations.settings.formsStepUp = { requireForKinds, allowSessionMfa }`; **default: required for `waiver` and `agreement`, MFA sessions accepted.** Owners/admins (`settings.manage`) change it on Documents → Templates → "Signer identity verification" (audited `forms.step_up_settings`).

For a self-signature on a required kind, `signRequest` resolves identity **before writing anything** and refuses with `StepUpRequiredError` (field `stepUpCode`) unless one of these holds — it never skips:

| Method | How | `auth_method` recorded |
|---|---|---|
| Email one-time code | Signer clicks "Email me a code"; 6 digits (`crypto.randomInt`) sent to their email on file (person record, else login). Stored as `HMAC-SHA256(SESSION_SECRET, "teamwork.signer-step-up.v1:<challengeId>:<code>")`. 10-minute expiry, 5 attempts then `locked`, resend cooldown 60 s, max 5 codes per signer per request per hour; a new code supersedes the old. A verified code is bound to (request, signer person, user), consumed by exactly one signature (`signature_id`). | `<session method>; step_up=email_otp; challenge=<id>` |
| MFA this session | `allowSessionMfa` and the user has MFA enabled **and** completed it this session (DB `users.mfa_enabled` + session `mfa_verified`). | `session_password_mfa; step_up=session_mfa` |
| Staff in person | In-person card (`forms.manage`), identity attestation checkbox. Always available; the path to use when email can't be delivered. | `staff_witnessed_in_person; …; identity=staff_attested` |

Delivery uses the messaging module's email adapter (`sendEmail`), so `DELIVERY_ENABLED`, provider config and `DELIVERY_TEST_RECIPIENTS` (redirect) apply; the result is stored on the challenge (`sent` / `test_redirected` / `not_configured` / `failed`) and as form audit events (`step_up_code_issued`, `step_up_code_delivery`, `step_up_verified`, `step_up_failed`). Anything but sent/redirected marks the code `undeliverable` (never usable). The thread/outbox path is deliberately not used: it would persist the code in a message body and could defer it past quiet hours. When email isn't configured or no address is on file, the signing page says so and directs the signer to staff; Templates shows a `NotConfigured` notice.

Flow in the app: the sign action first checks the code in its own committed transaction (`verifyStepUpCode`, so failed attempts count even though the signature then fails), then `signRequest` consumes the verified code. The method is part of the signature evidence, therefore of the integrity hash, and printed on the PDF ("Identity verification" + the raw `auth_method`).

## Completion & integrity
When every required role has signed: `integrity_hash` = SHA-256(canonical {requestId, subject, template content hash, data hash, all signature evidence sorted by role}); a pdf-lib PDF (org, title/version/content hash, full body, values, evidence table with facility-timezone and UTC times and identity verification, integrity footer on every page) is stored via `saveObject` (`completed_form_pdf`, `subject_and_guardians`); `expires_at` = completed + renewal months. `/documents/requests/[id]?verify=1` recomputes the version hash, each signature's content/data hash, the integrity hash, and the PDF bytes' SHA-256, and shows match/mismatch.

### PDF fonts (`src/lib/pdf/fonts.ts`, `assets/fonts/`)
Text is set in embedded, subset Unicode fonts: Noto Sans Regular/Bold/Italic/BoldItalic (Latin incl. diacritics and Vietnamese, Greek, Cyrillic), with fallbacks Noto Sans SC (Han, kana) and a Hangul subset of Noto Sans KR, embedded only when the text needs them. Courier is kept for ASCII hashes. Licenses: `assets/fonts/OFL-NotoSans.txt`, `assets/fonts/OFL-NotoSansCJK.txt` (SIL OFL 1.1). The files are rebuilt from upstream with `scripts/fonts/build-pdf-fonts.py`, which converts the CJK CFF fonts to TrueType and pads glyph records — `@pdf-lib/fontkit`'s subsetter otherwise produces glyphs that render blank. Characters no bundled font covers (e.g. emoji, Arabic, Devanagari) still print as `?` (the DB keeps the original). `next.config.ts` traces `assets/fonts` into `/documents/**`.

### DB triggers on `form_template_versions`
- `form_version_no_edit` (0001): content columns frozen while `published`.
- `form_version_status_guard` (0005): `published` is terminal (no `published → draft/retired`), nothing returns to `draft`, non-draft rows keep content/template/version, and only drafts can be deleted.

## Access decisions (`src/lib/forms/access.ts`)
- `forms.manage` staff (owner/admin/operations): everything in the org.
- **Coaches: status only** for assigned athletes (missing/pending/completed). No submitted values, no PDFs — forms can hold health/emergency data.
- Subject (athlete themself): own forms and PDFs.
- Guardians: `forms.sign` → full view (they may be asked to sign it); `profile.read` only → view, but intake/medical values/PDFs additionally need `health.read`.
- Payer status alone grants nothing.

### `/api/files/[id]` contract (all modules)
`GET` → 401 signed out; **404** for unknown id, other org, or not allowed (no existence leak); 410 if bytes missing; 500 if bytes fail the stored SHA-256. Rules by `access_level`:
- `staff`: roles with `forms.manage` or `people.manage`.
- `owner_only`: the owning person (`owner_person_id`) or the uploader.
- `subject_and_guardians`: the owning person, guardians of that person's athlete record with `forms.sign` or `profile.read`, and `forms.manage`/`people.manage` staff. `completed_form_pdf` objects follow the request rules above.
Headers: `Cache-Control: private, no-store`, `nosniff`, sandbox CSP, `X-Checksum-SHA256`. `?inline=1` to view in browser. Each download is audited (`file.download`).
`POST /api/files/archive` (multipart, `forms.manage`, same-origin, ≤15 MB PDF) imports an archive.

## Exports for other modules
```ts
// src/lib/forms/status.ts — callers authorize the viewer first
formsEligibility(tx, athleteId, requiredTemplateIds: string[], at = new Date())
  → { eligible: boolean, missing: { templateId, templateName, state: "missing"|"pending"|"partially_signed"|"expired", requestId|null }[] }
missingForms(tx, orgId, { at?, athleteIds? }) → { athleteId, personId, name, items: FormStatusItem[] }[]
// src/lib/forms/requests.ts
processRenewals(tx, orgId, { now?, actorUserId? }) → { expired, renewed }   // idempotent sweep; also a staff button
```
Expiry is time-based in both helpers, so results are right even before the sweep runs.

### Job: `forms.reminder` (delivered by messaging)
Enqueued on issue (`new_request`), staff reminder (`reminder`), re-sign (`resign_required`), renewal (`renewal`).
Payload `{ orgId, formRequestId, athleteId, subjectPersonId, templateName, versionTitle, dueDate, reason, recipientPersonIds, link }`; `dedupeKey = forms.reminder:<requestId>:<reason>:<YYYY-MM-DD>`. Recipients = guardians with signing permission + the subject person (messaging should apply its own consent/age rules).

## E-sign provider
`src/lib/forms/esign-provider.ts` defines the adapter (create envelope from the exact version + hash, role mapping, verified webhooks, store provider PDF). Only `UnconfiguredEsignProvider` exists; staff see an honest "not configured" notice.

## Versioning semantics
Publishing with **Require re-signing**: open requests on older versions → `superseded` (linked via `superseded_by_id`) and new requests are issued on the new version. Completed requests always remain the record of exactly what was signed and stay valid until their renewal date (eligibility counts any unexpired completion). To force everyone onto a new version, issue it to "everyone missing" after expiry, or shorten renewal.

## Production review items
- Have counsel replace SAMPLE consent text (`consent.ts`), the identity notice (`IDENTITY_NOTICE`) and form text; or connect a provider.
- Identity step-up proves control of the email on file, not legal identity: decide whether that (or MFA / staff ID checks) is sufficient per form kind, and how email addresses on file are verified and changed (a compromised or wrong address defeats it).
- Configure an email provider (`EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `DELIVERY_ENABLED=true`) before families must self-sign waivers/agreements; until then only staff in-person signing works for those kinds.
- Code-request rate limits are per signer + request; add per-IP / per-account limits and alerting for abuse. SMS codes are not implemented.
- Codes are HMAC'd with `SESSION_SECRET`; rotating that secret invalidates outstanding codes (acceptable: 10-minute lifetime).
- The demo seed switches step-up off while generating its synthetic history (those signatures record plain `session_password`), then removes the override.
- Seeds import libraries that use `server-only`; `scripts/seed/documents.ts` stubs that module for `tsx`. A shared fix (e.g. `tsx --conditions=react-server`) would be cleaner.
- PDF fonts add ~13 MB to the repo/deploy (CJK fallbacks); first CJK render in a process parses the 9.7 MB SC font. Scripts beyond Latin/Greek/Cyrillic/CJK/Hangul still print `?`; add Noto fonts per script if needed.
- Orphaned storage files are possible if a transaction rolls back after `saveObject` writes (same as every module).
