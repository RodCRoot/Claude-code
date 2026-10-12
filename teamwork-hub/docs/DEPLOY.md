# Deploying Teamwork Hub (private staging on Render)

Nothing has been deployed. This is the exact procedure for Rod to stand up a **private staging**
copy on Render: a web service, a background worker, and a managed PostgreSQL 16 database, all
defined in [`render.yaml`](../render.yaml). Staging runs with `APP_MODE=staging`, payments in
sandbox/test mode, and `DELIVERY_ENABLED=false` (no real email/SMS).

Same pattern as Teamwork Scoreboard (Render builds the Dockerfile straight from GitHub), with three
differences: the database is managed Postgres (not a disk), uploads go to an S3-compatible bucket
(not a disk), and there is a separate worker service.

## What gets created

| Render resource | Name | Runs | Notes |
| --- | --- | --- | --- |
| PostgreSQL 16 | `teamwork-hub-staging-db` | — | `0.1c-256mb`, no external connections (`ipAllowList: []`) |
| Web service | `teamwork-hub-staging` | `next start` (Dockerfile `CMD`) | Health check `GET /api/health`; `pnpm db:migrate` runs before every deploy |
| Background worker | `teamwork-hub-staging-worker` | `pnpm jobs:work` | Job outbox: messaging, reminders, renewals, syncs |
| Env group | `teamwork-hub-staging-shared` | — | Non-secret staging flags shared by both services |

Both services use the same image (`teamwork-hub/Dockerfile`). Auto-deploy is **off**: every deploy
is a deliberate click.

## Before you start (one-time, outside Render)

1. **Object storage bucket** (private). Either:
   - **AWS S3**: create bucket e.g. `teamwork-hub-staging` in `us-east-2`; keep *Block all public
     access* ON; *Object Ownership: Bucket owner enforced* (ACLs disabled); default encryption SSE-S3;
     turn on *Versioning* (protects against accidental deletes). Create an IAM user with only this
     policy and generate an access key:
     ```json
     { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
       "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
       "Resource": "arn:aws:s3:::teamwork-hub-staging/staging/*" }] }
     ```
   - **Cloudflare R2 / Backblaze B2** (S3-compatible): create a private bucket and an API token
     scoped to it; you will also set `S3_ENDPOINT` (e.g. `https://<account>.r2.cloudflarestorage.com`,
     `S3_REGION=auto`). R2 encrypts at rest automatically; if uploads fail with an encryption-header
     error, set `S3_SSE=none` in the env group.
2. **Payment sandbox credentials** (optional for first boot — the app shows "not configured"
   without them): Stripe **test-mode** keys (`sk_test_…`, `pk_test_…`); a PayPal **sandbox** REST app.
   Live keys are refused by the code outside `APP_MODE=production`.
3. **Sentry** (optional): create a Node.js/Next.js project and copy its DSN.
4. Pick the staging gate credential: a username and a 16+ character password (password manager).

## Create the staging environment

1. Push the branch containing this file to GitHub (`RodCRoot/Claude-code`).
2. Render dashboard → **New → Blueprint** → connect the `Claude-code` repo → choose the branch →
   set **Blueprint file path** to `teamwork-hub/render.yaml`.
3. Render lists the 4 resources above and prompts for every `sync: false` variable. Enter:

   **Web service `teamwork-hub-staging`**

   | Variable | Value to enter |
   | --- | --- |
   | `APP_URL` | `https://teamwork-hub-staging.onrender.com` (the service URL Render shows; no trailing slash — if Render picks a different subdomain, update it after the first deploy) |
   | `STAGING_BASIC_AUTH_USER` | gate username |
   | `STAGING_BASIC_AUTH_PASSWORD` | gate password (16+ chars) |
   | `S3_BUCKET`, `S3_REGION` | bucket name and region (`auto` for R2) |
   | `S3_ENDPOINT` | empty for AWS; provider endpoint for R2/B2/MinIO |
   | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | the bucket-scoped key |
   | `SENTRY_DSN` | Sentry DSN, or empty |
   | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | test-mode values, or empty |
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` | sandbox values, or empty |
   | `HAWKIN_REFRESH_TOKEN` | empty unless testing the Hawkin sync |

   `DATABASE_URL` is wired from the database and `SESSION_SECRET` is generated automatically.

   **Worker `teamwork-hub-staging-worker`**: the same `APP_URL`, `S3_*`, `AWS_*`, `SENTRY_DSN`,
   `STRIPE_SECRET_KEY`, `PAYPAL_*`, `HAWKIN_REFRESH_TOKEN` values, and for `SESSION_SECRET` paste the
   web service's generated value (web service → Environment → reveal `SESSION_SECRET` → copy).
4. Click **Apply**. Render creates the database, builds the image (~5–10 min), runs
   `pnpm db:migrate` (creates `btree_gist` + applies all migrations), then starts the web service and
   worker.
5. Verify (from your laptop):
   ```bash
   curl -s https://teamwork-hub-staging.onrender.com/api/health          # {"status":"ok"}
   curl -s -o /dev/null -w '%{http_code}\n' https://teamwork-hub-staging.onrender.com/login   # 401 (gate)
   ```
   Open the URL in a browser → enter the gate credential → you should see the Teamwork Hub sign-in page.
6. **Create the organization and first owner.** Staging has no demo data (`db:seed` refuses
   outside `APP_MODE=demo`). Web service → **Shell**:
   ```bash
   pnpm bootstrap:owner --org "Teamwork Bloomington (staging)" --slug teamwork-staging \
     --email <your email> --name "Rod"
   ```
   It prints a one-time invite link (`$APP_URL/invite/<token>`, valid 72 h). Open it, set your
   password, then enrol MFA (Settings → Security). It refuses if any organization already exists.
   Invite everyone else from Settings → Users.
7. Worker check: worker service → **Logs** should show JSON lines `{"msg":"start",…}` and, hourly,
   `automation.evaluate` jobs. No `"level":"error"` lines.
8. Monitoring check (if `SENTRY_DSN` set): web service → **Shell** → `pnpm monitoring:check` → a
   synthetic "Monitoring check (synthetic)" issue appears in Sentry with `[email]`/`[REDACTED]` in
   place of the test values.
9. Webhooks (only once sandbox keys are set):
   - Stripe (test mode) → Developers → Webhooks → endpoint
     `https://<staging-host>/api/webhooks/stripe` → copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
   - PayPal sandbox app → Webhooks → `https://<staging-host>/api/webhooks/paypal` → copy the webhook
     id into `PAYPAL_WEBHOOK_ID`.
   Webhook paths bypass the staging gate (providers cannot send basic auth); every delivery is
   signature-verified and unverified deliveries are recorded and rejected.

## Deploying an update

1. Merge/push to the branch the Blueprint tracks.
2. Render → each service → **Manual Deploy → Deploy latest commit** (web first; its pre-deploy step
   migrates the database; then the worker).
3. Check `GET /api/health` and the worker logs.

Rollback: Render → service → **Events** → previous deploy → **Rollback**. Migrations are
forward-only; if a release added a migration, restore from backup instead of rolling back past it
(see `docs/BACKUP-RESTORE.md`).

## Running the image elsewhere (any Docker host)

```bash
cd teamwork-hub
docker build -t teamwork-hub .
docker run --rm --env-file .env.staging teamwork-hub pnpm db:migrate          # once per release
docker run -d --name hub-web    --env-file .env.staging -p 3000:3000 teamwork-hub
docker run -d --name hub-worker --env-file .env.staging teamwork-hub pnpm jobs:work
```
With `STORAGE_BACKEND=local`, mount a persistent volume at `STORAGE_DIR` (e.g. `-v /srv/teamwork/storage:/app/.storage`).
Put HTTPS in front (Render/Fly do it automatically; on a VPS use Caddy or Cloudflare Tunnel).

## Environment variables (names only — values live in Render, never in git)

| Variable | Web | Worker | Staging value / note |
| --- | :-: | :-: | --- |
| `DATABASE_URL` | ✓ | ✓ | from the Render database |
| `SESSION_SECRET` | ✓ | ✓ | generated (web); same value on worker |
| `APP_URL` | ✓ | ✓ | public https URL, no trailing slash |
| `APP_MODE` | ✓ | ✓ | `staging` (env group) |
| `NODE_ENV` | ✓ | ✓ | `production` (env group) |
| `STAGING_BASIC_AUTH_USER`, `STAGING_BASIC_AUTH_PASSWORD` | ✓ | | site-wide gate; unset = no gate |
| `STORAGE_BACKEND` | ✓ | ✓ | `s3` (env group); `local` needs a disk at `STORAGE_DIR` |
| `STORAGE_DIR` | (✓) | (✓) | only with `STORAGE_BACKEND=local` |
| `S3_BUCKET`, `S3_REGION` | ✓ | ✓ | required for `s3` |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | ✓ | ✓ | only for R2/B2/MinIO |
| `S3_PREFIX` | ✓ | ✓ | `staging` (env group) |
| `S3_SSE`, `S3_KMS_KEY_ID` | ✓ | ✓ | `AES256` (env group); `aws:kms` + key id optional |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | ✓ | ✓ | standard AWS credential chain (or a role) |
| `SENTRY_DSN` | ✓ | ✓ | optional; Sentry stays off without it |
| `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | ✓ | ✓ | `staging`, `0` (env group) |
| `LOG_LEVEL` | ✓ | ✓ | `info` |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | ✓ | (secret key) | test mode only in staging |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` | ✓ | (id/secret) | sandbox |
| `PAYPAL_ENV` | ✓ | ✓ | `sandbox` (env group) |
| `DELIVERY_ENABLED` | ✓ | ✓ | `false` (env group) |
| `DELIVERY_TEST_RECIPIENTS` | | | optional allowlist when testing delivery later |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` | | | `none` in staging |
| `SMS_PROVIDER`, `SMS_ACCOUNT_SID`, `SMS_AUTH_TOKEN`, `SMS_FROM` | | | `none` in staging |
| `HAWKIN_REFRESH_TOKEN`, `HAWKIN_API_BASE`, `HAWKIN_ORG_SCOPE` | ✓ | ✓ | optional |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | ✓ | ✓ | optional (calendar sync) |

## Health check

`GET /api/health` (also `HEAD`): runs `select 1` against the database with a 3 s timeout.
- `200 {"status":"ok"}` — server up and database reachable.
- `503 {"status":"unavailable"}` — database unreachable/slow. The reason is only in the server log
  (`"msg":"health_check_failed"`, redacted); the response never includes hostnames, versions, or
  errors. It needs no login and bypasses the staging gate. The Docker image's `HEALTHCHECK` uses it too.

## Security headers in production

Set by `src/proxy.ts` on every page: nonce-based `Content-Security-Policy` (`script-src 'self'
'nonce-…' 'strict-dynamic'`, no third-party scripts; hosted-checkout hosts are allowed only as
`form-action` targets on the invoice payment page), `Strict-Transport-Security`,
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
`Cache-Control: private, no-store` on private pages, and `X-Robots-Tag: noindex` outside production.

## Monitoring & logs

- Every server/worker log line is one JSON object (`t`, `level`, `msg`, …). Secrets, tokens, emails,
  contact fields, and health/wellness fields are redacted before they are written (`src/lib/observability.ts`).
- With `SENTRY_DSN` set, unexpected errors from server actions (`safeAction`), route handlers,
  server rendering (`instrumentation.ts` → `onRequestError`), and dead jobs in the worker are sent to
  Sentry — server-side only (no browser SDK), with cookies, headers, bodies, query strings, DB query
  data and stack locals disabled, and the same redaction applied in `beforeSend`.
- Error monitoring only: `withSentryConfig` (source-map upload, build-time auto-instrumentation)
  is deliberately not used, so stack traces show compiled server paths and Sentry logs a one-line
  "diagnostics-channel injection hooks" notice at boot; neither affects error capture. Add it later
  with a `SENTRY_AUTH_TOKEN` in CI if readable stack traces / performance tracing are wanted.
- Suggested alerts: Sentry "new issue" → email Rod; Render health-check failure notifications on.

## Backups

Render's paid Postgres plans include daily backups / point-in-time recovery — confirm the plan's
retention in the database's **Recovery** tab. In addition, take logical backups from a machine with
the PostgreSQL 16 client (needs a temporary IP allow-list entry, or run from the web service shell
after installing a matching `pg_dump`): `DATABASE_URL=<external url> pnpm backup`, then prove it with
`pnpm restore:check` (see `docs/BACKUP-RESTORE.md`). Enable S3 bucket versioning for files.

## Pre-launch checklist (staging → production)

Do not flip `APP_MODE=production` until every box is checked.

**Access & secrets**
- [ ] Owner account bootstrapped; demo/test accounts absent (`select email from users where email like '%.test'` returns nothing).
- [ ] MFA enrolled for every staff account (Settings → Security).
- [ ] `SESSION_SECRET` generated fresh for production (never reuse staging's); rotating it signs everyone out.
- [ ] Production secrets only in Render env vars; `.env` files never committed (`git log -p -- '*.env'` clean).
- [ ] Bucket-scoped IAM key (or role), Block Public Access on, versioning on.

**Data protection**
- [ ] `pnpm backup` + `pnpm restore:check` PASS against the production database, result recorded.
- [ ] Render Postgres backups/PITR enabled and retention known; restore drill scheduled quarterly.
- [ ] Bucket objects private: an object URL opened directly returns `AccessDenied`.
- [ ] Health data review: a guardian without health access (like demo "jordan") sees no wellness/body-map data — re-run `pnpm test` (authz suite) on the release commit.

**Payments & messaging**
- [ ] Stripe/PayPal **live** keys entered only in production; webhooks re-created against the production URL with new signing secret/webhook id.
- [ ] One real low-value payment + refund end-to-end; invoice shows settled only after the verified webhook.
- [ ] `DELIVERY_ENABLED=true` only after: provider domain authentication (SPF/DKIM), `EMAIL_FROM` verified, SMS sender registered (10DLC), opt-out handling tested with `DELIVERY_TEST_RECIPIENTS`.

**Operations**
- [ ] `SENTRY_DSN` set; `pnpm monitoring:check` issue received and shows redacted fields; alert routing to Rod.
- [ ] `/api/health` monitored (Render notifications or an uptime pinger).
- [ ] Worker running; no `dead` jobs (`select count(*) from jobs where status='dead'`).
- [ ] CSP sweep clean on the release build: `BASE_URL=… PW_CHROMIUM=… pnpm test:e2e e2e/csp.spec.ts --project=desktop`.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` green on the release commit.

**Go-live**
- [ ] Production Blueprint/services created separately from staging (own database, bucket prefix/bucket, secrets).
- [ ] `APP_MODE=production`, `STAGING_BASIC_AUTH_*` removed, custom domain added in Render, DNS switched, HTTPS verified.
- [ ] `APP_URL` = the production domain (payment return URLs and links depend on it).
- [ ] Rollback plan written down: previous Render deploy + last verified backup.
