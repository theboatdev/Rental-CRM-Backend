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
  - `resolveTenant` finds the tenant through the platform service (`findTenantByClerkOrgId`), so `/api/platform` and `/api/v1` see the same tenants while they're in memory. Lookups are cached for 60 s.
- **Endpoints:** `GET /api/v1/me`, `GET /api/v1/config` (with an ETag).
- **Dependency cleanup.** Removed `bcryptjs` and `jsonwebtoken`.
- **Local development.**
  - `npm run seed` prepares a tenant DB and adds you as a member.
  - `SEED_CLERK_ORG_IDS` links the seeded tenants to real Clerk organizations. See [clerk-setup.md](clerk-setup.md#7-call-the-tenant-api-locally).
- **Tests.** `test/tenancy.test.js` runs on `mongodb-memory-server` (a replica set, so transactions work). It covers tenant isolation, module and permission enforcement, the DB layer and the app wiring. 73 tests in all.

Exit (met, see `test/tenancy.test.js`): a request with an org A token can't read org B data; a disabled module returns 404; a missing permission returns 403.

## Phase 2: Real provisioning and storage

- **Real provisioning.** The provisioning job runner executes the steps for real (idempotent, with retry): Clerk organization, tenant database with indexes and roles, config v1, Owner invitation.
- **Clerk.** Create the org and send the Owner invitation during provisioning. The `/webhooks/clerk` endpoint (`verifyWebhook`) syncs `members`.
- **Storage.** Replace the in-memory store in `src/platform/service.js` with the platform models from Phase 1. The routes and responses stay the same, so the admin dashboard doesn't change. `findTenantByClerkOrgId` becomes a `Tenant` query, so the tenant API follows without changes.

Exit: creating Shenaly from the dashboard produces a Clerk org, a `tenant_<id>` DB with roles, config v1 and an invitation email.

## Phase 3: Tenant RBAC

- Roles and members APIs: list, invite, change role, remove. Custom role CRUD, validated with `CustomRoleInputSchema`.
- `requirePermission` on every tenant route. `maxUsers` enforced when inviting. Last-Owner protection.
- Field-level filtering: no profit or margin fields without `financials:view`.

## Phase 4: Tenant app migration

- **Platform upgrade.** Upgrade `frontend/` to the same Next/React major version as the admin dashboard and convert it to TypeScript as each file is touched.
- **Clerk.** Add `@clerk/nextjs` with the organization-required flow, and remove the demo role switcher.
- **Config.** A `ConfigProvider` loads `GET /api/v1/config` and drives tab order and labels from `navigation`, branding CSS variables, `Intl` currency and date formatting, and the dropdown lists. Response types are mirrored in a `contract.ts`, as in the admin dashboard; permissions come from `GET /api/v1/me`.
- **Data.** Replace `context/StoreContext.jsx` (localStorage) with an API client (TanStack Query), one module at a time:
  1. vehicles
  2. renters
  3. rentals and bookings: move the `lib/bookings.mjs` rules server-side, inside Mongo transactions
  4. payments
  5. costs and fuel
  6. dashboard
  7. WhatsApp
- **Team settings.** Add Team & Roles pages for tenant admins.
- **Cleanup.** Remove the Vite leftovers (`src/`, `index.html`, `vite.config.js`).

## Phase 5: Files, guest portal, automation

- **Files.** aws-sdk v3 with presigned uploads and downloads under `tenants/<id>/`: renter documents, inspection photos, bills, logos.
- **Guest portal.** Public `/book/<slug>` backed by `/api/public/:slug/*`. It's rate-limited and only on when `guestPortal.enabled`.
- **WhatsApp digest.** A scheduler loops over active tenants, using each one's `cron` and `timezone`, with credentials from `tenant_secrets`.

## Phase 6: Hardening and deploy

- **Operations.**
  - Per-tenant migration runner (config `schemaVersion` and DB migrations).
  - Usage metering against `limits`.
  - Rate limits, structured logs, error tracking.
- **Data protection.** Backups and a restore drill; optionally a separate Atlas database user per tenant DB.
- **Tests.** Playwright end-to-end tests for both apps.
- **Deploy.**
  - Both Next.js apps on Vercel; the backend on Render, Fly or ECS.
  - MongoDB Atlas and S3.
  - Clerk production instance (see [clerk-setup.md](clerk-setup.md#later-phases)).
