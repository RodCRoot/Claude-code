# Forms, guardian e-signatures, completed PDFs, document archive

Owner paths: `src/app/(app)/documents/**`, `src/app/api/files/**`, `src/lib/forms/**`, `src/lib/pdf/**`,
`scripts/seed/documents.ts`, `tests/forms*.test.ts`.

> **Pilot notice.** The typed-name signing workflow is a *verifiable pilot*: it records who signed, when, from
> where, and exactly what they signed, sealed by SHA-256 hashes. It is not a complete production e-signature
> system and makes no claim about legal enforceability. All seeded form text is **SAMPLE TEXT** and must be
> replaced with Teamwork-approved language (owner/admin "Mark approved" removes the label).

## Model
| Concept | Where | Notes |
|---|---|---|
| Template | `form_templates` | kind, renewal months (null = never), required for booking, active |
| Version | `form_template_versions` | draft → published. `content_hash` = SHA-256 of canonical JSON {title, body, fields, signers}. Published rows are immutable (DB trigger). **Earlier versions stay `published`** (the trigger only guards that status); the current version is the highest published number. |
| Request | `form_requests` | pending → partially_signed → completed → expired; or superseded / voided. `submitted_data` is frozen by the first data-bearing signature. |
| Signature | `signatures` | immutable (trigger). Stores consent text verbatim, typed name, role, relationship, IP, user agent, auth method, `template_content_hash`, `data_hash`, ms-precision `signed_at`. |
| Audit | `form_audit_events` + `audit()` | issued, signed, status_changed, completed, superseded, voided, reminder_queued, expired, renewal_issued |
| Archive | `archived_documents` + `stored_objects(kind imported_archive)` | original PDF + original system/date/notes. Never creates signatures. Labeled "Imported archive — original evidence only". |

## Signer rules (`src/lib/forms/signing.ts`, `fields.ts`)
- Roles: `guardian`, `second_guardian`, `adult_athlete`, `athlete_assent`, `staff_witness`.
- Guardian roles need an active guardianship with `can_sign_forms` (policy `forms.sign`). A person signs at most one role per request; the second guardian is a different person and signs independently.
- Subject 18+ (by DOB at signing time): guardian roles don't apply; `adult_athlete` is required if the version requires guardian or adult_athlete. Minors never sign for themselves except `athlete_assent` (after a guardian has submitted the data).
- A *required* `second_guardian` is enforced only when the athlete has ≥2 guardians with signing permission.
- Staff with `forms.manage` can record an in-person signature on their device; `auth_method` = `in_person_staff_witnessed; witness=<name> [<user id>]`.
- Field values are validated server-side against the version definition; unknown keys are dropped. Later signers sign over the frozen data (same `data_hash`). Corrections = "Void & reissue".

## Completion & integrity
When every required role has signed: `integrity_hash` = SHA-256(canonical {requestId, subject, template content hash, data hash, all signature evidence sorted by role}); a pdf-lib PDF (org, title/version/content hash, full body, values, evidence table with facility-timezone and UTC times, integrity footer on every page) is stored via `saveObject` (`completed_form_pdf`, `subject_and_guardians`); `expires_at` = completed + renewal months. `/documents/requests/[id]?verify=1` recomputes the version hash, each signature's content/data hash, the integrity hash, and the PDF bytes' SHA-256, and shows match/mismatch.

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
- Have counsel replace SAMPLE consent text (`consent.ts`) and form text; decide on identity assurance (MFA for signers, email OTP) before relying on typed-name signatures; or connect a provider.
- DB trigger hardening: also block `published → draft` status changes and edits to non-draft rows (today app code never does this, but raw SQL could).
- Seeds import libraries that use `server-only`; `scripts/seed/documents.ts` stubs that module for `tsx`. A shared fix (e.g. `tsx --conditions=react-server`) would be cleaner.
- PDFs use standard Helvetica (WinAnsi); non-Latin characters are replaced with `?` in the PDF (the DB keeps the original). Embed a Unicode font for production.
- Orphaned storage files are possible if a transaction rolls back after `saveObject` writes (same as every module).
