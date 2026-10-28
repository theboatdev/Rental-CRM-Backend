# Development roadmap

Phases build on each other. Each one ends with something that runs and is tested. See [platform-architecture.md](platform-architecture.md) for the design these phases implement.

## Phase 0: Foundations ✅

- **Three separate repos:** `backend`, `frontend`, `adminDashboard`, each with its own install and lockfile. No shared package.
- **Backend owns the rules** (`src/platform/`):
  - tenant config schema (Zod 4), templates and diff
  - RBAC permission catalog and system roles
  - tenant slug and status rules, provisioning steps
  - super-admin claim check
- **Backend platform API** (`/api/platform`, see [platform-architecture.md](platform-architecture.md#platform-api)):
  - the config contract (`/meta`) and validation, including uploaded config files
  - tenant CRUD, lifecycle and simulated provisioning
  - config publish with conflict detection, history and restore
  - the audit log
  - Clerk super-admin auth (`@clerk/express`)
  - tenants kept in an in-memory store
  - 51 tests with Node's built-in runner (`npm test`)
- **`adminDashboard/`:** Next.js 16 + TypeScript + Tailwind 4 + shadcn/ui, and a client of the platform API.
  - Clerk sign-in, with super-admin gating in both the proxy and the data access layer.
  - Pages: overview, tenants list, create-tenant wizard, tenant detail with lifecycle actions, config editor (form tabs + Monaco raw JSON with schema autocomplete, upload/download, backend validation, diff, publish), config history with restore, and the audit log.
- **Docs:** this folder.

## Phase 1: Backend multi-tenancy core ✅

- **Connections** (`src/db/`).
  - `platform.js`: `connectPlatformDb()` opens the platform DB with `mongoose.createConnection`, so nothing is ever registered on the global connection. The server starts without a database; `/api/v1` then responds 503.
  - `tenantDb.js`:
    - `createTenantDbGetter(platformDb)` returns `getTenantDb(dbName)`, which uses `useDb(…, { useCache: true })`, registers the tenant models on that connection and refuses any name that isn't `tenant_<id>`.
    - `initTenantDb(db)` builds the indexes and upserts the system roles. It's idempotent; Phase 2 provisioning calls it.
  - Indexes are never built implicitly (`autoIndex: false`).
- **Models.**
  - `src/models/platform/`: Tenant, TenantConfig, ProvisioningJob, TenantSecret, AuditLog.
  - `src/models/tenant/`: Member, Role, Vehicle, Renter, Rental, Payment, VehicleCost, FuelLog, Counter, AuditLog. `User` is replaced by `Member`.
  - Every model file exports a schema. Enums are uppercase keys aligned with the frontend (`enums.js`). Document types, payment methods and cost categories store config list keys. `src/constants/` is gone.
  - See [database-schema.md](database-schema.md).
- **Auth.** The tenant chain is `clerkMiddleware → requireOrgSession → database check → resolveTenant → loadMember → requireModule → requirePermission`.
  - `resolveTenant` finds the tenant through the platform service (`findTenantByClerkOrgId`), so `/api/platform` and `/api/v1` always see the same tenants. Lookups are cached for 60 s.
- **Endpoints:** `GET /api/v1/me`, `GET /api/v1/config` (with an ETag).
- **Dependency cleanup.** Removed `bcryptjs` and `jsonwebtoken`.
- **Local development.** `npm run seed` prepares a tenant DB and adds you as a member.
- **Tests.** `test/tenancy.test.js` runs on `mongodb-memory-server` (a replica set, so transactions work). It covers tenant isolation, module and permission enforcement, the DB layer and the app wiring.

Exit (met, see `test/tenancy.test.js`): a request with an org A token can't read org B data; a disabled module returns 404; a missing permission returns 403.

## Phase 2: Real provisioning and storage ✅

- **Storage.** `src/platform/service.js` stores everything in the platform DB. The routes and responses didn't change, so the admin dashboard didn't either.
  - Config publishes run in a transaction. The unique `{ tenantId, version }` index settles two publishes from the same base: one wins, the other gets 409.
  - Status changes are compare-and-set.
  - Nothing is seeded any more; the demo tenants are test fixtures (`test/helpers/demoTenants.js`).
  - `/api/platform/meta` and `/config/validate` still work without a database.
- **Real provisioning** (`src/platform/provisioning.js`). `POST /tenants` runs the job before it responds, so the dashboard shows the outcome at once.
  - Every step is idempotent:
    - The Clerk org is found again by slug and `publicMetadata.tenantId`.
    - `initTenantDb` can run again safely.
    - Config v1 is an upsert.
    - The invitation is skipped if one is pending or the admin is already a member.
  - **Retry** runs from the failed step. A job claim makes two concurrent retries run it once.
  - A running job whose heartbeat is over 2 minutes old (cut off by a restart) can be retried.
- **Clerk** (`src/platform/clerk.js`): the only module that calls Clerk. It creates the org (no `createdBy`) and sends the Owner invitation (`org:admin`, `publicMetadata.roleKey = "owner"`, optional `CLERK_INVITATION_REDIRECT_URL`).
- **Webhooks** (`POST /webhooks/clerk`, `src/platform/members.js`). Verified with `verifyWebhook` on the raw body.
  - Membership created, updated and deleted events sync `members` and `usage.members`.
  - `user.updated` copies name and email.
  - `organization.deleted` suspends the tenant.
  - Stale or repeated events are ignored by comparing event timestamps.
  - A new member's role comes from the invitation's `roleKey`; later Clerk events never change an active member's role.
- **Tests.**
  - `test/provisioning.test.js`: the exit criteria, failure and retry, concurrent retries, cut-off jobs, slug races and publish races.
  - `test/webhooks.test.js`: signatures, role assignment, out-of-order delivery, profile sync, org deletion.
  - They use a fake Clerk gateway (`test/helpers/fakeClerk.js`). 94 tests in all.

Exit (met in tests with the fake Clerk; run it against your Clerk instance with [clerk-setup.md](clerk-setup.md#7-create-a-tenant-and-call-its-api)): creating Shenaly from the dashboard produces a Clerk org, a `tenant_<id>` DB with roles, config v1 and an invitation email.

## Phase 3: Tenant RBAC ✅

- **Team API** (`src/tenant/team.js`):
  - Members: list, change role, remove.
  - Invitations: list, invite, revoke. They live in Clerk; the API reads and writes them through the gateway.
  - Changes write the tenant DB first and undo that write if Clerk fails (502 `clerk_unavailable`), so the two don't drift apart.
- **Roles API** (`src/tenant/roles.js`):
  - Custom role CRUD, validated with `CustomRoleInputSchema` and `CustomRoleUpdateSchema`. System roles are read-only.
  - A role can't be deleted while a member or a pending invitation uses it.
  - `GET /permissions` serves the catalog with `available` per module.
- **Rules** (see [rbac.md](rbac.md#enforcement)):
  - `requirePermission` on every tenant route except `/me` and `/config`; `test/team.test.js` fails if a route lacks one.
  - `maxUsers` counts active members plus pending invitations.
  - Last-Owner protection runs under a per-tenant lock, so concurrent demotions can't remove every Owner.
  - Nobody can hand out the Owner role, or permissions they don't hold, which stops escalation through custom roles.
- **Field-level filtering.** `hideFinancialFields` drops the fields in `src/platform/rbac/financialFields.js` (profit, margin, revenue, ROI) from every tenant response unless the caller has `financials:view`.
- **Tenant audit log.** Team and role changes are recorded; `GET /api/v1/audit` lists them (`audit:read`).
- **Tests.** `test/team.test.js`: the route guard, injection payloads, invitations and `maxUsers`, role changes and the Owner race, Clerk failures, escalation, role CRUD, field filtering and the audit log. 115 tests in all.

## Phase 4: Tenant app migration ✅

- **Backend operations API** (`src/tenant/`, routes in `src/routes/operations.js`). Every route has `requireModule` and `requirePermission`.
  - `vehicles.js`: fleet CRUD with per-vehicle totals and a dossier (rentals, costs, fuel). Enforces `limits.maxVehicles`.
  - `renters.js`: profiles with codes from `rules.codePrefixes.renter`, documents keyed by `lists.documentTypes`, verification, and compliance gaps.
  - `rentals.js`: the `lib/bookings.mjs` rules, server-side in transactions.
    - Reserve, optionally with an advance and an immediate hand-over.
    - Check in (inspection from `modules.rentals.inspectionPoints`).
    - Return, cancel, availability and the month calendar.
    - A per-vehicle lock means two bookings can't take the same days.
    - An overdue rental keeps its vehicle until it's returned.
  - `payments.js`: receipts and advances numbered from the config's prefixes; refunds; voids with a reason. `rental.paidAmount` stays in step.
  - `costs.js`: service costs (`lists.costCategories`) and fuel logs.
  - `dashboard.js`: the dashboard (fleet, open rentals, per-vehicle figures, alerts) and the WhatsApp digest text. Money figures only go to `financials:view`.
- **Tenant app** (`frontend/`, see its README).
  - Rebuilt on Next 16, React 19, TypeScript, Tailwind 4 and TanStack Query, with the same look.
  - Clerk with organization-required sign-in, plus `/sign-up` for accepting invitations. The demo role switcher is gone.
  - Config-driven: tabs from `navigation`, the brand colour, locale formatting and list dropdowns. `contract.ts` mirrors the API; permissions come from `GET /api/v1/me`.
  - Pages: dashboard, vehicles, renters, rentals, calendar, payments, costs and fuel, WhatsApp digest, team and roles.
- **Tenant users from the admin dashboard.** A **Users** page per tenant, on `/api/platform/tenants/:id/{members,invitations,roles}` (`src/platform/tenantUsers.js`). Super admins invite users with any role, change roles and remove people, with the same rules as the tenant app's Team page.
- **Tenant deletion from the admin dashboard.** Permanent, for archived or failed-provisioning tenants, after typing the slug. It deletes the Clerk organization, the tenant database, configs, the job and secrets, and keeps the audit history. Removing a user stays "remove from tenant": their Clerk account is kept.
- **Members without waiting for the webhook.** `loadMember` creates a missing member from their Clerk membership (`members.syncFromClerk`), with the webhook's rules. New members can sign in straight after accepting, even without a webhook tunnel.
- **Configurable fields.** The config's `fields` section lists every field of vehicles, renters, rentals, payments and costs. See [tenant-config.md](tenant-config.md#fields).
  - Built-in fields can be renamed, given help text, made required, shown in lists or turned off. Core fields, the ones the rules depend on, stay on.
  - Tenants add their own fields: text, long text, number, date, yes/no or a choice list.
  - Backend: the built-in field catalog (`src/platform/config/fields.js`), the schema, the rules applied to every create and edit (`src/tenant/fields.js`), merge-style edits of custom values, `PATCH /rentals/:id`, and publish warnings for removed custom fields, type changes and removed options.
  - Admin dashboard: a **Fields** tab in the config editor.
  - Tenant app: forms, detail views and lists follow the settings.
- **Cleanup.** Removed the Vite leftovers, `context/StoreContext.jsx` and `lib/bookings.mjs` (its tests moved to the backend).
- **Tests.** `test/operations.test.js` covers vehicles, renters, the booking rules (overlaps, back-to-back, concurrent bookings, check-in, return, cancel, overdue), payments, costs and fuel, the dashboard and digest with field filtering, and isolation. `test/tenant-users.test.js` and `test/tenant-deletion.test.js` cover the super admin's user management and tenant deletion. Fields are covered in `test/config.test.js` and `test/operations.test.js`. The tenant app is checked with `typecheck`, `lint` and `build`. 174 backend tests in all.

Moved to Phase 5, because they need file storage or a scheduler:
- photos for each inspection point;
- document and bill uploads (and `modules.costs.requireBillUpload`);
- the guest registration page;
- sending the digest on its schedule.

## Phase 5: Files, guest portal, automation ✅

- **Files on Cloudinary**, replacing the planned S3 storage (see [platform-architecture.md](platform-architecture.md#files)).
  - **Gateway** (`src/platform/storage.js`): the only module that calls Cloudinary. It signs uploads, checks upload responses, makes download links that expire after 10 minutes, and deletes assets or a tenant's whole prefix. Tests use `test/helpers/fakeStorage.js`, which signs like Cloudinary.
  - **Uploads** (`src/tenant/files.js`): `POST /api/v1/uploads { kind }` for `document`, `inspection` and `bill`, each checking its module and permissions. Files are private (`authenticated`); photos are stored as JPEGs at most 2000 px.
  - **Records.** Renter documents carry their scan, inspections a photo per point (a photo checks its point), costs their bill, enforcing `modules.costs.requireBillUpload`. `PUT /renters/:id/documents/:documentId/file` and `PUT /costs/:id/bill` attach a file later. Replacing a file or deleting a cost deletes the old file.
  - **Models.** `fileKey` / `billFileKey` became `file` / `billFile` (`src/models/tenant/file.js`). Responses carry `file.url` only for callers with the record's read permission.
  - **Usage.** `usage.storageGb` adds up the tenant's file sizes, and signing refuses uploads once it reaches `limits.storageGb`.
  - **Tenant deletion** deletes `tenants/<id>/` in Cloudinary before the database.
  - **Logo.** `POST /api/platform/tenants/:id/uploads/logo` signs a public upload; the admin dashboard's branding section uploads it into `branding.logoUrl`.
  - **Dependencies.** Added `cloudinary`; removed `aws-sdk`, `multer` and `multer-s3`, which nothing used. `npm audit fix` moved `body-parser` to 1.20.9, so the backend audit is clean.
- **Guest portal** (see [platform-architecture.md](platform-architecture.md#guest-portal)).
  - `/api/public/:slug` (`src/routes/public.js`, `src/tenant/portal.js`): the profile, free vehicles for dates, document scan uploads, and bookings. Only for active tenants with `guestPortal.enabled`.
  - Rate-limited per client IP (`src/middleware/rateLimit.js`); `TRUST_PROXY` makes that work behind a load balancer.
  - A booking registers the renter (`source: 'ONLINE'`) and reserves the vehicle in one transaction, through the counter's booking code. `bookWithin` and `insertRenter` were split out of `rentals.js` and `renters.js` for that.
  - The tenant's built-in field settings, `residentTypes` and `requireDocumentUpload` apply. Conflicts never name other bookings or plates.
  - Tenant app: the public page `/book/<slug>` with dates, vehicles, the renter's details and document scans, and a voucher to send on WhatsApp.
- **WhatsApp digest** (see [platform-architecture.md](platform-architecture.md#whatsapp-digest)).
  - **Per-tenant connection:** phone number ID, access token and an optional template, encrypted in `tenant_secrets` with `TENANT_SECRETS_KEY` (`secrets.js`, `integrations.js`). Super admins set it on the tenant page; the API never returns the token.
  - **Scheduler** (`digests.js`, `cron.js`): every minute, sends the digests whose cron fired in the last hour in the tenant's timezone. A `digest_runs` record per scheduled minute, with a unique index, means one send per slot across backend instances.
  - **Delivery:** as the tenant's approved template when set (it arrives outside WhatsApp's 24-hour window), otherwise as plain text. Each recipient's result is recorded.
  - **Tenant app:** the WhatsApp page shows whether it's connected and the latest runs, and `POST /api/v1/whatsapp/digest/send` (`whatsapp:manage`) sends it now.
- **Tests.**
  - `test/files.test.js`: the gateway's signatures against Cloudinary's documented algorithm, upload permissions, forged and cross-tenant files, scans, photos and bills, storage limits, deletion.
  - `test/portal.test.js`: the public routes, availability, document rules, conflicts, rate limits.
  - `test/digests.test.js`: cron in time zones, encryption, the connection API, scheduling once per slot, templates, manual sends.
  - 222 backend tests in all. Both apps pass `typecheck`, `lint` and `build`.

Not done, for later:
- The tenant app's file inputs need a browser check against a real Cloudinary account; the tests cover the backend with a fake.
- A CAPTCHA for the guest portal, if bookings are abused.
- Tenant admins can't edit digest recipients themselves: they're in the config, which only super admins edit.

## Phase 6: Hardening and deploy

- **Operations.**
  - Per-tenant migration runner (config `schemaVersion` and DB migrations).
  - Usage metering against `limits`.
  - Rate limits, structured logs, error tracking.
- **Data protection.** Backups and a restore drill; optionally a separate Atlas database user per tenant DB.
- **Tests.** Playwright end-to-end tests for both apps.
- **Deploy.**
  - Both Next.js apps on Vercel; the backend on Render, Fly or ECS.
  - MongoDB Atlas and Cloudinary.
  - Clerk production instance (see [clerk-setup.md](clerk-setup.md#later-phases)).
