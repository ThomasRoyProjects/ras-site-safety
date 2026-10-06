# RAS Site Safety

RAS Site Safety is a React safety-check workspace on Cloudflare Workers. Framers submit dated checklists and one to five site photos. Admins review records and manage staff accounts.

The production design uses static Vite assets, one Worker, and one SQLite Durable Object. It does not use Express, a local tunnel, R2, D1, KV, Supabase, or paid image storage.

## Delivery status

The public GitHub repository is <https://github.com/ThomasRoyProjects/ras-site-safety>.

The live Worker is <https://ras-site-safety.thomasroy149.workers.dev>.

## What runs where

```text
Browser
  │ same-origin HTTPS /api + HttpOnly cookie
  ▼
Cloudflare Worker (server/index.js)
  ├── /api and /api/* ──► SQLite Durable Object SafetyApp
  │                         ├── metadata, users, sessions, staging, photo chunks
  │                         └── photo thumbnails
  └── everything else ──► Workers Static Assets (dist/)
```

`wrangler.jsonc` names the Worker `ras-site-safety`. It serves `dist/` through `ASSETS`. It routes API paths before SPA fallback. It binds `SAFETY_APP` to `SafetyApp`. It also binds Cloudflare Images as `IMAGES`.

The Durable Object uses the stable name `ras-site-safety`. Its SQLite storage contains users, sessions, metadata, staging chunks, original photo chunks, and thumbnails. Cloudflare Images validates inputs and creates a small WebP transform. It is not photo persistence.

A one MiB chunk keeps each photo row bounded. Original photo bytes remain private SQL chunks. The application does not recompress originals.

## Local prerequisites and commands

Use Node `^22.16.0` or `>=24.0.0`.

```sh
npm ci
npm run build
cp .dev.vars.example .dev.vars
npm start
```

Edit `.dev.vars` and choose two passwords of 12–128 characters. `npm start` runs `wrangler dev --ip 127.0.0.1 --port 8787`. Open <http://127.0.0.1:8787>. For optional Vite development, run `npm run dev` in another terminal. Open <http://127.0.0.1:5173>.

The Vite server proxies `/api` to Wrangler on port 8787.

These initial passwords seed only a fresh local database. Existing local `.wrangler` state keeps its current passwords.

The Durable Object initializes its schema and fictional seed data on first access.

`npm run deploy` builds and invokes Wrangler deployment.

## Tests

```sh
npm test
npx playwright install chromium webkit
npm run test:e2e
```

`npm test` runs the backend suite in `tests/backend.test.js`. It uses Vitest on the local Workers runtime with real SQLite Durable Object storage. Its test-only passwords live in `vitest.config.js`.

`npm run test:e2e` runs the Playwright browser suite in `e2e/`. It builds the app and starts a fresh Wrangler server on port 8788 with its own `.wrangler/e2e` state. It never touches your normal local data or the live site.

The browser suite runs every test twice: desktop Chromium at 1440×900 and an iPhone profile on WebKit. It covers login, the Framer submission and history, validation focus, Admin filters and deletion, the staff temporary-password flow, role navigation, and phone layout. The one-time browser install is only needed once per machine.

## Cloudflare authorization and quotas

If Wrangler needs authorization, run `npx wrangler login`.

For a brand-new deployment and database, set both initial-password secrets before the first request:

```sh
npx wrangler secret put ADMIN_INITIAL_PASSWORD
npx wrangler secret put FRAMER_INITIAL_PASSWORD
```

The existing live database is already bootstrapped and does not need these secrets. On a fresh database, bootstrap fails closed with a clear error when either secret is missing or invalid. After the bootstrap marker exists, startup never reads these secrets.

The configuration needs no `.env` file, signing key, R2 bucket, or separate image storage. Never commit credentials.

The default stored-photo quota is 200 MiB per user and 800 MiB for the application. A Framer can create at most 20 submissions per rolling 24 hours.

The upload queue admits three pending or active uploads. Non-submission POST bodies are limited to 8 KiB. Multipart submissions are limited to 50 MiB plus 512 KiB.

The outer Worker checks declared length. A body-bearing POST without `Content-Length` returns `411`. A body over its route limit returns `413`.

Login admission permits two active verifications. Failed attempts allow 20 per client IP and five per normalized email in a 15-minute window.

The application offers no public login or sign-up. Quotas and limits bound abuse from any compromised account. Admins should rotate any shared test password after the assessment.

The limiter tracks at most 1,024 keys. One user keeps at most five active sessions.

Cloudflare platform and Images quotas still apply. Check current Cloudflare limits before deployment.

During upload, binding, decoder, and transform failures return image-validation `400` without committing the submission.

References include [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [Durable Objects SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Images pricing](https://developers.cloudflare.com/images/pricing/), and the [Images binding](https://developers.cloudflare.com/images/optimization/binding/).

## Test accounts and data

Test accounts exist for assessment: Admin `admin@example.test` and Framer `framer@example.test`. Their passwords are provided privately with the assessment submission, not in this repository.

Admins enter and confirm each new staff temporary password. They must share it securely and never record it here.

The live database currently contains three fictional sample records plus anything reviewers create. The bootstrap sites are Harbour Site and Maple Site. `Submitted` is a derived display label. It does not represent an approval workflow.

A login creates a random opaque bearer token. SQLite stores its SHA-256 hash. The cookie is HttpOnly, SameSite Strict, and absolute 12 hours. The current database role is read on each protected request.

## Roles and workflow

The Admin navigation contains Overview, Submissions, Staff, and Account. The Framer navigation contains Overview, New submission, History, and Account. Both roles show four tabs on observed mobile widths without horizontal scrolling.

Each view has one h1. Navigation focuses the new view's h1. Save errors focus an in-viewport error summary and mark invalid fields. Retry buttons appear for recoverable loading errors.

Admin staff provisioning supports Framer and Admin roles. The Staff directory lists authorized users. Account creation is a native collapsed details section by default. Reset uses a native dialog. The directory and submission histories use ten-row client-side pages.

Submission details load only WebP thumbnails. The original remains available through its authorized photo URL.

Admins can delete a submission from its detail drawer. The drawer asks for confirmation, names the photo count, and warns that deletion cannot be undone. A successful delete removes the row and shows a status notice. The UI returns focus to the list heading when the deleted drawer closes.

Admins enter temporary passwords for new accounts and resets. A reset also revokes every target session. Temporary users can access only session, logout, and password change. Other protected resources return `403` with code `password_change_required`.

The first-login and reset flow uses the Account password form. A successful self-change returns `204`, clears the cookie, revokes every caller session, and returns to login. The form uses current, new, and confirmation fields. The Worker rejects a wrong current password or unchanged replacement with `400`. Passwords must contain 12–128 Unicode code points.

Admin creation and reset never return password hashes. Secret fields clear after success. While self-change waits for a response, the UI disables navigation, the brand link, and logout. Unmount cleanup aborts abandoned requests.

Recovery has no email delivery. Users must contact an administrator. The login screen says, `Need an account or password reset? Contact your administrator.`

The application does not claim email verification, MFA, deactivation, audit logging, server-side pagination, or deep links.

## API contract

All paths below include the `/api` prefix. Successful JSON uses `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Every POST and submission DELETE requires an exact same-origin `Origin`.

| Method/path | Auth/role | Result |
|---|---|---|
| `GET /api/health` | public | `{status:"ok"}` |
| `POST /api/login` | public | Login JSON and a 12-hour opaque session cookie |
| `POST /api/logout` | optional session | Revokes the current session and clears the cookie with `204` |
| `GET /api/session` | authenticated | `{user:{id,email,name,role,must_change_password}}` |
| `GET /api/sites` | authenticated | Site choices |
| `GET /api/admin/workers` | Admin | Current Framers and historical submitters |
| `GET /api/admin/users` | Admin | Users with id, email, name, role, temporary flag, and creation time |
| `POST /api/admin/users` | Admin | Creates a Framer or Admin with a temporary password. Returns `201` without secrets |
| `POST /api/admin/users/:id/password` | Admin | Resets another user and revokes target sessions |
| `POST /api/account/password` | authenticated | Changes the caller password, revokes all caller sessions, and returns `204` |
| `GET /api/submissions` | authenticated | Scoped records and all-site counts. Supports four filters |
| `GET /api/submissions/:id` | authenticated | Scoped checklist, notes, and photo metadata |
| `GET /api/photos/:id` | authenticated | Authorized original bytes streamed from SQL chunks |
| `GET /api/photos/:id/thumbnail` | authenticated | Authorized WebP thumbnail. The longest side is at most 480 pixels. Generation failure returns `500` |
| `POST /api/submissions` | Framer | Multipart checklist, notes, date, and one to five photos. Returns `201` |
| `DELETE /api/submissions/:id` | Admin | Atomically deletes the submission, photos, chunks, and thumbnails. Returns `204` |

Submission photo metadata includes `url` and `thumbnail_url`. Thumbnail requests use the original photo's authentication and ownership scope. Inaccessible photos return `404`.

Admin-only provisioning, reset, and deletion paths return `403` for Framers. Self-reset through the Admin endpoint returns `400`. Use the Account path instead.

Anonymous protected requests return `401`. Wrong roles return `403`. Temporary users receive the password-change gate. Missing or inaccessible records and photos return `404`. A missing submission returns `404` for deletion.

Duplicate worker, site, and date returns `409`. A concurrent password reset can return `409` with `Password was changed by another request. Try again.` Invalid input returns `400`. A submission DELETE with body bytes returns `400`.

Storage quota returns `413` with `Photo storage limit reached`. A full upload queue returns `503` with `Uploads are busy. Try again shortly.` The rolling daily limit returns `429` with `Daily submission limit reached. Try again tomorrow.` KDF and login limits also return `429`.

The outer Worker returns `411 Content-Length required` when a POST has a body without `Content-Length`. Oversized requests return `413` before the Durable Object reads beyond the limit. A submission DELETE with body bytes returns `400`. An empty browser DELETE body stream is accepted.

## Validation and bounded resources

The browser prechecks form values for fast feedback. The Worker repeats all security checks. Eight checklist answers are exact `0` or `1`.

Dates use strict Gregorian validation. Notes allow at most 5,000 Unicode code points.

Photos must be non-empty JPEG, PNG, or WebP files. Each file is at most 10 MiB. A submission accepts at most five files.

The multipart request ceiling is 50 MiB plus 512 KiB. Non-submission JSON bodies have an 8 KiB ceiling.

Account names are trimmed and limited to 100 Unicode code points. Account emails are normalized, ASCII-valid, and limited to 254 characters.

Password-setting paths require 12–128 Unicode code points without trimming. Login input allows 320 email code units and 4,096 password code units before verification.

The scrypt profile uses `N=32768`, `r=8`, `p=3`, a 16-byte salt, and a 64-byte derived key. Shared KDF admission allows two active operations.

Multipart files stream into one MiB SQL chunks. Structural image checks process at most one ten MiB file at a time.

Each accepted photo gets a quality-80 WebP thumbnail. Its longest side is at most 480 pixels, and its output is at most one MiB.

Early `401`, `403`, and `404` paths drain rejected request bodies incrementally. Cancellation is only a fallback after a drain read fails. This keeps forwarded streams settled.

## Storage and migration

The nine strict tables are `users`, `sites`, `submissions`, `photos`, `photo_chunks`, `photo_thumbnails`, `sessions`, `app_metadata`, and `upload_staging_chunks`.

Schema version 3 adds `photo_thumbnails`. Each thumbnail row uses `photo_id` as a primary key and cascading foreign key. The migration also creates `photos_submission_id_idx`, `sessions_user_id_idx`, and `sessions_expires_at_idx`.

The constructor inspects `PRAGMA table_info(users)`. It adds `must_change_password` only when absent. It records `schema_version=3` in `app_metadata`. The migration uses additive, idempotent operations.

This is a data-preserving upgrade. Existing users, records, sessions, and original photo chunks remain. New uploads store thumbnails during commit.
Existing photos receive one thumbnail lazily on the first thumbnail request.

`CREATE TABLE IF NOT EXISTS` does not alter an existing table. Never wipe state or remove the bootstrap marker to apply this migration.

Upload staging and permanent chunks can coexist briefly during commit. A transaction copies chunks, stores thumbnails, verifies totals, and deletes staging rows. A final cleanup removes abandoned staging rows.

## File map

- `server/index.js` — Worker routing, migration, bootstrap, authentication, limiters, staff APIs, password workflows, role guards, multipart staging, image validation, quotas, thumbnails, SQL, and photo streaming. It also handles submission mutation locking and deletion.
- `server/schema.sql` — Nine strict tables, thumbnail storage, session indexes, and the temporary-password flag.
- `server/passwords.js` — `scrypt-v1` hashing and verification.
- `server/demo-data.json` — Fictional bootstrap users, sites, and migration fixture data.
- `src/App.jsx` — Session restoration, role navigation, login, forced password mode, h1 focus, and notices.
- `src/api.js` — Same-origin JSON and FormData fetch helper.
- `src/components/FramerView.jsx` — Checklist, date, notes, photos, history, client pagination, detail drawer, and thumbnails.
- `NewSubmissionForm` and `SubmissionHistory` in `src/components/FramerView.jsx` — Submission entry, history loading, and detail selection.
- `src/components/AdminView.jsx` — Metrics, filters, scoped history, counts, detail requests, and Admin deletion state.
- `src/components/AdminOverview.jsx` — Admin metrics and site summary cards.
- `src/components/SubmissionFilters.jsx` — Admin site, worker, and date filters with retry handling.
- `src/components/SubmissionList.jsx` — Submission rows, pagination, and detail drawer.
- `src/components/StaffView.jsx` — Admin directory, ten-row pagination, collapsed creation form, and reset dialog.
- `src/components/AccountView.jsx` — Self-change and forced first-login password flow.
- `src/components/PasswordField.jsx` — Shared show and hide password control.
- `src/components/Pagination.jsx` — Shared previous and next page controls.
- `src/components/SubmissionDrawer.jsx` — Native accessible detail drawer with Escape, busy state, and focus return.
- `src/components/SubmissionDetail.jsx` — Shared read-only checklist, notes, status, photo rendering, and Admin deletion confirmation.
- `src/passwordPolicy.js` — Shared password length and confirmation validation.
- `src/isAbortError.js` — Shared aborted-request detection.
- `src/styles.css`, `src/components/*.css`, and `src/components/StaffView.css` — Responsive layout, role navigation, dialogs, drawers, and focus styling.
- `tests/backend.test.js` — Native local Worker and Durable Object behavior suite.
- `e2e/*.spec.js`, `e2e/helpers.js`, and `playwright.config.js` — Playwright browser suite for desktop Chromium and iPhone WebKit.
- `wrangler.jsonc` — Worker, static assets, stable Durable Object binding, and Images binding.
- [ERD PDF](docs/erd.pdf), [PNG](docs/erd.png), and [SVG source](docs/erd.svg) — Current nine-table schema diagram. The schema source remains authoritative.

## Assumptions

- `Submitted` is a derived display label. It does not describe an approval state.
- Admins manage accounts. The application has no public sign-up.
- The quotas target the planned Cloudflare Free deployment. They do not prove available capacity.
- Animated image originals stay stored as-is. Validation and thumbnail generation use the default image frame.

## Suggested walkthrough

1. Start Wrangler on port 8787.
2. Sign in with a test account. Its password is provided privately with the assessment submission.
3. Open Overview and confirm real counts, latest dates, and site counts.
4. As Admin, open Staff and expand the creation details only when needed.
5. Create a fictional staff account with a temporary password. Do not record that password.
6. Sign in as the new user and complete the forced password change.
7. As Framer, open New submission. Choose a site and unused date.
8. Answer all eight checks. Add a fictional photo and optional note. Save it.
9. Open History. It starts closed. Open a row in the native drawer.
10. Confirm that the drawer loads thumbnails without requesting originals. Open a photo link to request the original.
11. As Admin, open a submission detail drawer. Choose Delete submission, review the photo count warning, and cancel once.
12. Confirm the deletion. Check the success notice, list refresh, and missing detail and photo URLs.
13. As Admin, combine site, worker, and date filters. Check zero-count sites.
14. Use pagination when a list exceeds ten rows.
15. Reset another account. Confirm its old session receives `401` and its new login requires a change.
