# Platform architecture

The project started as a single-tenant demo for Shenaly Rent a Car (`frontend/`, `backend/`). This document describes the target: a multi-tenant SaaS that any car rental company can run on, with Shenaly as tenant #1.

Related docs: [tenant-config.md](tenant-config.md) · [rbac.md](rbac.md) · [clerk-setup.md](clerk-setup.md) · [development-roadmap.md](development-roadmap.md). The original single-tenant design is in [architecture.md](architecture.md); the product scope is in `docs/scope-of-work.md` in the frontend repo.

## Roles

| Who | Where they work | What they do |
|---|---|---|
| **Super admin** (us) | `adminDashboard/` | Provision tenants, edit each tenant's config, suspend/archive tenants |
| **Tenant admin** (rental company owner) | `frontend/` | Run their company's operations, invite their team, define roles |
| **Tenant team** (staff, accountants…) | `frontend/` | Day-to-day operations within the permissions of their role |
| **Renters** (public) | `frontend/` at `/book/<slug>` | Self-register and request reservations; no account |

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Tenancy | One MongoDB **database per tenant** (`tenant_<tenantId>`) plus one `platform` database, on the same cluster | Hard data isolation per customer, cheap to provision (a DB is created on first write), per-tenant backup/restore and deletion |
| Identity | **Clerk**, one instance shared by both apps. **1 Clerk Organization = 1 tenant** | Sign-in, MFA, invitations and org membership come for free |
| Authorization | Roles and permissions live **in the tenant DB**, not in Clerk | Clerk's custom roles are instance-wide; tenant admins need their own roles |
| Tenant resolution | Single domain; tenant comes from the user's **active Clerk organization** (`orgId` in the session token). Public pages use the slug: `/book/<slug>` | No wildcard DNS needed now; subdomains or custom domains can be added later |
| Feature/UI control | A **versioned JSON config per tenant** in the platform DB, validated by a shared Zod schema | Super admins change features, branding and rules without a deploy |
| Languages | Next.js + TypeScript for `adminDashboard` and `frontend`; **JavaScript (CommonJS) for `backend`** | Team preference |
| Repos | **Three separate repositories**: `backend`, `frontend`, `adminDashboard`. No shared package | Each app is installed, versioned and deployed on its own; the backend's API is the contract between them |
| Shared rules | The **backend owns** the config schema, templates, permission catalog and tenant rules, and serves them over `/api/platform` | One source of truth without a shared package; the frontends validate by asking the backend |

## Components

```
                 ┌──────────────── Clerk (single instance) ─────────────────┐
                 │ Users · Organizations (1/tenant) · Invitations · Webhooks │
                 │ Session JWT: sub, org_id, org_role, metadata.platformRole │
                 └─────▲──────────────────────▲──────────────────┬──────────┘
                       │ sign-in              │ sign-in          │ webhooks (svix)
           ┌───────────┴──────────┐  ┌────────┴─────────────┐    │
           │ adminDashboard :3001 │  │ frontend :3000       │    │
           │ super admins only    │  │ tenant admin + teams │    │
           │                      │  │ + public /book/<slug>│    │
           └───────────┬──────────┘  └────────┬─────────────┘    │
            /api/platform/*        /api/v1/*, /api/public/:slug/*│
                       └──────────┬───────────┘                  │
                ┌─────────────────▼──────────────────────────────▼─────┐
                │ backend :5000 (Express, JavaScript)                  │
                │ clerkMiddleware → resolveTenant → loadMember →       │
                │ requireModule → requirePermission → handler          │
                └──────┬───────────────────────────┬──────────────┬───┘
         ┌─────────────▼──────────┐  ┌─────────────▼──────────┐ ┌─▼──────────────────┐
         │ platform DB            │  │ tenant_<id> DB (×N)    │ │ S3                 │
         │ tenants, tenant_configs│  │ members, roles,        │ │ tenants/<id>/...   │
         │ provisioning_jobs,     │  │ vehicles, renters,     │ │ presigned URLs only│
         │ tenant_secrets, audit  │  │ rentals, payments,     │ └────────────────────┘
         └────────────────────────┘  │ costs, fuel_logs,      │
                                     │ counters, audit_logs   │
                                     └────────────────────────┘
```

### The backend owns the rules

Everything that decides what's valid lives in the backend, in `src/platform/`:

| Path | Holds |
|---|---|
| `config/schema.js`, `config/modules.js` | Tenant config schema (Zod), module catalog and dependencies |
| `config/templates/` | Starting configs (`base.json`, `sri-lanka.json`) |
| `config/diff.js` | Config diffs and removed list keys, for review before publishing |
| `rbac/permissions.js` | Permission catalog, system roles, effective-permission rules |
| `tenants/rules.js` | Slugs, statuses and transitions, provisioning steps, create-tenant input |
| `platformRole.js` | The super-admin claim check |

The frontends don't import any of this. The admin dashboard:

- gets the rules from `GET /api/platform/meta`: the config JSON Schema, modules, templates, permissions and roles;
- validates every edit and uploaded file through `POST /api/platform/tenants/:id/config/validate`;
- keeps TypeScript types for the responses in `src/lib/contract.ts`.

The tenant app follows the same pattern for the tenant API: types in its `src/lib/contract.ts`, config from `GET /api/v1/config`, permissions from `GET /api/v1/me`.

## Data

### Platform DB (control plane)

| Collection | Contents |
|---|---|
| `tenants` | name, slug, status (`provisioning` · `active` · `suspended` · `archived`), clerkOrgId, dbName, activeConfigVersion, template, limits, createdBy |
| `tenant_configs` | `{ tenantId, version, config, note, createdBy, createdAt }`. Immutable; one document per published version |
| `provisioning_jobs` | Step-by-step state of each tenant's setup, so a failed job resumes where it stopped |
| `tenant_secrets` | Integration credentials (e.g. WhatsApp Cloud API token), AES-GCM encrypted. **Never** part of the config |
| `platform_audit_logs` | Every super admin action |

### Tenant DB (one per tenant)

The six existing domain models (`Vehicle`, `Renter`, `Rental`, `Payment`, `VehicleCost`, and `User` → replaced by `members`), refactored to **export schemas** and be registered per connection. New collections:

- `members`: `{ clerkUserId, email, name, roleKey, status }`. Clerk owns credentials, so there is no password hash.
- `roles`: system roles seeded at provisioning, plus custom roles.
- `fuel_logs`: fuel fill-ups per vehicle.
- `counters`: atomic `$inc` for human-readable codes (`RNT-2026-0042`, `SR-0146`, `RCPT-2026-0091`), using the prefixes from the config.
- `audit_logs` and `_migrations`.

Enums are aligned with the frontend (`AVAILABLE`, not `'Available'`). Values that differ per tenant, such as document types, payment methods and cost categories, are stored as **list keys** from the config, not hardcoded enums.

### Files

S3 objects are keyed `tenants/<tenantId>/…` and only reached through short-lived presigned URLs. The URLs are issued after the tenant check. Uploads go directly from the browser to S3 with presigned POSTs. The backend moves from aws-sdk v2 to v3.

## Request lifecycle (tenant API)

The chain is in `src/routes/tenant.js`, `src/middleware/tenantAuth.js` and `src/middleware/tenantContext.js`.

1. **`clerkMiddleware()`** (`@clerk/express`) verifies the bearer session token. `authorizedParties` is limited to the two app origins.
2. **`requireOrgSession`**: 401 without a session, 403 without an active organization. Sets `req.identity = { userId, orgId }`.
3. **Database check**: 503 while the platform connection is down.
4. **`resolveTenant`**: `orgId` → `service.findTenantByClerkOrgId(orgId)` (a `tenants` query), cached for about 60 s.
   - The tenant must be `active`, otherwise the API returns 403.
   - `getTenantDb(tenant.dbName)` returns `platformConnection.useDb(dbName, { useCache: true })` with the tenant models registered on it.
   - Attaches `req.tenant`, `req.config`, `req.configVersion` and `req.models`.
5. **`loadMember`**: Clerk `userId` → the active `members` document → its role → `effectivePermissions(role.permissions, config)`. Sets `req.member`, `req.role` and `req.permissions`.
   - A missing member record gets one chance to be created from the caller's Clerk membership (`syncFromClerk`, below). That covers people who arrive before Clerk's webhook.
   - A missing member or role returns 403.
6. **`requireModule('fuelLogs')`** returns 404 when the module is disabled. **`requirePermission('costs:delete')`** returns 403. Both throw at startup if the module or permission doesn't exist.
7. **Handler** uses only `req.models.*`.

**Isolation rule:** no tenant model is ever registered on a global connection. The only way to reach tenant data is through `req.models`, which is bound to the caller's tenant DB, so a cross-tenant query can't be written by accident. `test/tenancy.test.js` asserts that an org A token can never read org B data, by list or by id.

Because tenants are cached, a suspension or a config publish can take up to 60 s to reach the tenant API.

Platform routes (`/api/platform/*`) skip tenant resolution. They use `requirePlatformAdmin`, which runs `isSuperAdmin(sessionClaims)` from `src/platform/platformRole.js`. The admin dashboard has a small copy of this check for its redirects; the backend's check is the one that counts.

Public routes (`/api/public/:slug/*`) resolve the tenant by slug. They are rate-limited and only answer when `modules.guestPortal.enabled`.

## Super admins

A super admin is a Clerk user with `publicMetadata.platformRole = "super_admin"`. A session-token customization exposes it to apps as `sessionClaims.metadata.platformRole` (see [clerk-setup.md](clerk-setup.md)). Public metadata can only be written from the Clerk dashboard or the backend API, so users can't promote themselves.

The admin dashboard checks the claim in two places:

1. In its **proxy**, as an optimistic redirect.
2. In its **data access layer**, as the real check: every read and every Server Action calls `requireSuperAdmin()`.

Super admins are not members of tenant organizations. Support access ("view as tenant") is future work using Clerk actor tokens.

## Provisioning a tenant

`POST /api/platform/tenants` runs the job (`src/platform/provisioning.js`) before it responds. Each step is idempotent and recorded in `provisioning_jobs`, so **Retry** resumes from the failed step:

1. **Create tenant record**: status `provisioning`, `dbName = tenant_<tenantId>`. The DB name uses the immutable id, not the renamable slug. It's written in one transaction with the job and the audit entry.
2. **Create Clerk organization**: same name, `publicMetadata.tenantId`. No slug, since the tenant's slug lives in the platform DB and Clerk instances can have organization slugs turned off. No `createdBy`, so the super admin doesn't become a member. A retry finds an organization an earlier attempt created by its `publicMetadata.tenantId`.
3. **Initialise tenant DB**: `initTenantDb` (`src/db/tenantDb.js`) syncs the indexes of all tenant models and seeds the system roles. Counters are created on first use.
4. **Write config v1**: `createConfigFromTemplate(template, { branding, limits })`, upserted as version 1.
5. **Invite tenant admin**: Clerk organization invitation with role `org:admin` and `publicMetadata.roleKey = "owner"`. It's skipped when the admin already has a pending invitation or membership. `CLERK_INVITATION_REDIRECT_URL`, if set, is where the invitation link lands.
6. **Activate**: status `active`.

A failed step leaves the tenant `provisioning`, with the error on the step.

- **Retry** claims the job atomically, so two retries can't run it at once; the second gets 409.
- A job still `running` with a heartbeat older than 2 minutes was cut off, e.g. by a restart, and can be retried too.

All Clerk calls go through `src/platform/clerk.js`; tests swap in a fake.

### Clerk webhooks

`POST /webhooks/clerk` keeps each tenant's `members` in step with Clerk (`src/platform/members.js`). It's verified with `verifyWebhook` on the raw body, using `CLERK_WEBHOOK_SIGNING_SECRET`.

| Event | Effect |
|---|---|
| `organizationMembership.created` | Adds (or re-activates) the member. The role is the membership's `publicMetadata.roleKey`, which Clerk copies from the invitation. Without a valid one: Owner for `org:admin`, Staff otherwise |
| `organizationMembership.updated` | Updates name and email. An active member's role never changes here: roles belong to the tenant |
| `organizationMembership.deleted` | Marks the member `removed` |
| `user.updated` | Copies name and primary email to the member in every tenant the user belongs to |
| `organization.deleted` | Suspends the tenant and records it in the audit log |
| Others, incl. `organizationInvitation.accepted` | Acknowledged and ignored (the membership event does the work) |

Membership events also refresh the tenant's `usage.members`.

The webhook isn't the only way in. When someone reaches the tenant API without a member record, `loadMember` asks Clerk for their membership (`syncFromClerk`) and applies it with the same rules. That covers someone who opens the app right after accepting an invitation, before the webhook arrives, and local setups without a webhook tunnel. A miss is remembered for 30 seconds, so non-members don't send every request to Clerk.

Clerk can deliver an event twice or out of order. Each member keeps the time of the last applied event (`membershipSyncedAt`, `profileSyncedAt`), and an older event is skipped. A deletion also records a member we never saw, so a late "created" can't bring them back.

Responses: 200 when handled; 400 for a bad signature (no retry); 503 when the secret or the database is missing (Clerk retries with backoff).

**Lifecycle actions:**

- **Suspend**: the API returns 403 and data is kept.
- **Reactivate.**
- **Archive**: read-only and hidden.
- **Delete**: permanent, from the tenant page's **Delete tenant** button (`DELETE /api/platform/tenants/:id`, `service.deleteTenant`).
  - Only for an archived tenant, or one whose provisioning failed. The super admin must type the tenant's slug to confirm.
  - Deletes the Clerk organization (with its memberships and pending invitations), drops the tenant database, and removes its configs, provisioning job and secrets. The slug becomes free again.
  - The platform audit log keeps the tenant's history plus a `tenant.deleted` entry.
  - Members' Clerk accounts are kept; they lose only this workspace.
  - Each step can run again, so a deletion that failed half-way (e.g. Clerk down) can be retried.

The allowed transitions are in `TENANT_STATUS_TRANSITIONS` (`src/platform/tenants/rules.js`); tenant responses include the ones currently allowed as `allowedTransitions`.

## Platform API

The super admin API, under `/api/platform`. Every route requires a Clerk session with the `super_admin` platform role. Tenants, configs, jobs and the audit log are stored in the platform database (`src/platform/service.js`). `/meta` and `/config/validate` don't need the database; the other routes respond 503 while it's unavailable.

| Method and path | Purpose |
|---|---|
| `GET /meta` | Config JSON Schema, modules, templates, tenant statuses, provisioning steps, permissions, system roles |
| `POST /config/validate` | Validate any config (`{ config }` or `{ configText }`), optionally against a `baseline` |
| `GET /stats` | Tenant counts by status, total members and vehicles, failed provisioning jobs |
| `GET /tenants` · `POST /tenants` | List tenants · create and provision one |
| `GET /tenants/:id` · `PATCH /tenants/:id/status` | Tenant detail · suspend, reactivate or archive |
| `DELETE /tenants/:id` | Delete for good (`{ confirmSlug }`): archived or failed-provisioning tenants only |
| `GET /tenants/:id/provisioning` · `POST …/provisioning/retry` | Provisioning job · retry its failed steps |
| `GET /tenants/:id/config` | Active config version |
| `GET /tenants/:id/config/versions` | History, newest first, each with its changes from the previous version |
| `POST /tenants/:id/config/validate` | Validate a draft or **uploaded file** and diff it against the active version |
| `POST /tenants/:id/config` | Publish (`{ config or configText, note, baseVersion }`); 409 if `baseVersion` is stale |
| `POST /tenants/:id/config/versions/:version/restore` | Republish an old version as the newest |
| `GET /audit?tenantId&limit` | Audit log, newest first |
| `GET /tenants/:id/members` · `GET /tenants/:id/roles` | The tenant's users and its roles |
| `GET /tenants/:id/invitations` · `POST /tenants/:id/invitations` · `DELETE …/invitations/:invitationId` | Pending invitations · invite `{ email, roleKey }` · revoke |
| `PATCH /tenants/:id/members/:memberId` · `DELETE /tenants/:id/members/:memberId` | Change a user's role · remove them |

The user routes (`src/platform/tenantUsers.js`) run the tenant's team rules (`src/tenant/team.js`): `maxUsers` counting pending invitations, at least one Owner, Clerk kept in step. The super admin acts as an Owner, so they can make or remove Owners. Changes need an active tenant and are recorded in both the platform's and the tenant's audit log.

Errors use one shape: `{ "error": { "code", "message", "issues"? } }`. Codes are `unauthenticated` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `invalid` (422, with field `issues`) and `auth_not_configured` (503). Without a database, routes respond `database_not_configured` or `database_unavailable` (503). The webhook adds `invalid_signature` (400) and `webhooks_not_configured` (503).

## Tenant API

Under `/api/v1`, behind the [request lifecycle](#request-lifecycle-tenant-api) chain. Every route except `/me` and `/config` requires a permission; operations routes also require their module (404 when it's off).

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /me` | — | `{ user, tenant, role, permissions, configVersion }`: who the caller is in this tenant and their effective permissions |
| `GET /config` | — | `{ version, config }`: the active config. It has an ETag and `Cache-Control: private, no-cache`, so revalidation returns 304 |
| `GET /members?status=active\|removed\|all` | `team:read` | The team, oldest first |
| `PATCH /members/:id` | `team:manage` | Change a member's role (`{ roleKey }`) |
| `DELETE /members/:id` | `team:manage` | Remove a member from the tenant and its Clerk organization |
| `GET /invitations` | `team:read` | Pending invitations (from Clerk) |
| `POST /invitations` | `team:manage` | Invite `{ email, roleKey }`; 409 when the email is taken or `maxUsers` is reached |
| `DELETE /invitations/:id` | `team:manage` | Revoke a pending invitation |
| `GET /roles` | `team:read` or `roles:manage` | System and custom roles, with active member counts |
| `GET /permissions` | `team:read` or `roles:manage` | The permission catalog, with `available: false` for disabled modules |
| `POST /roles` · `PATCH /roles/:key` · `DELETE /roles/:key` | `roles:manage` | Custom roles. System roles are read-only |
| `GET /audit?limit&entityType` | `audit:read` | The tenant's audit log, newest first |
| `GET /dashboard?range=7d\|30d\|90d\|all` | `dashboard:view` | Fleet status, open rentals, per-vehicle figures, alerts |
| `GET /vehicles` · `GET /vehicles/:id` | `vehicles:read` | The fleet with totals · a vehicle's dossier (rentals, costs, fuel the caller may read) |
| `POST /vehicles` · `PATCH /vehicles/:id` · `DELETE /vehicles/:id` | `vehicles:create` · `vehicles:update` · `vehicles:delete` | Add (up to `limits.maxVehicles`), edit or send to maintenance, delete (only without history) |
| `GET /vehicles/availability?startDate&endDate` | `rentals:create` | Each vehicle's availability for the dates, and why not |
| `GET /renters` · `GET /renters/:id` | `renters:read` | Profiles with compliance gaps · a profile with its rentals |
| `POST /renters` · `PATCH /renters/:id` · `POST /renters/:id/documents` | `renters:create` · `renters:update` | Register, edit, add a document |
| `POST /renters/:id/documents/:documentId/verify` | `renters:documents:verify` | Mark a document checked |
| `GET /rentals?status&vehicleId&renterId` · `GET /rentals/:id` | `rentals:read` | Rentals, newest first · one with its payments |
| `POST /rentals` | `rentals:create` | Book (`advance` needs `payments:record`; `pickup` hands over at once and needs `rentals:checkin`) |
| `PATCH /rentals/:id` | `rentals:create` | Edit a rental's notes and custom fields |
| `POST /rentals/:id/check-in` · `/return` · `/cancel` | `rentals:checkin` · `rentals:return` · `rentals:cancel` | Hand over, record the return, cancel a booking |
| `GET /calendar?month=YYYY-MM` | `calendar:view` | A month of the fleet schedule |
| `GET /payments` · `POST /payments` · `POST /payments/:id/void` | `payments:read` · `payments:record` · `payments:void` | The ledger · record · void with a reason |
| `GET /costs` · `POST /costs` · `DELETE /costs/:id` | `costs:read` · `costs:create` · `costs:delete` | Running costs |
| `GET /fuel-logs` · `POST /fuel-logs` | `fuel:read` · `fuel:create` | Fuel fill-ups |
| `GET /whatsapp/digest` | `whatsapp:view` | The weekly digest text, recipients and schedule |

Clerk failures during these calls return 422 with Clerk's message when Clerk rejected the input, and 502 `clerk_unavailable` otherwise.

## Repositories

| Repo | What it is | Dev port | Run |
|---|---|---|---|
| `backend` | Express API (JavaScript). Owns the rules; this documentation lives here | 5000 | `npm run dev` |
| `adminDashboard` | Super admin app (Next.js 16, TypeScript) | 3001 | `npm run dev` |
| `frontend` | Tenant app (Next.js 16, TypeScript) | 3000 | `npm run dev` |

Each repo has its own `package-lock.json` and is installed with `npm install` inside it. Locally the three folders sit side by side; the apps reach each other only over HTTP. The admin dashboard needs `PLATFORM_API_URL`, the backend needs `CLERK_AUTHORIZED_PARTIES`.

## Open items

- **Product name.** The platform is called "Fleet Platform" in `adminDashboard/src/config/site.ts`, as a placeholder.
- **Type drift.** The admin dashboard's `src/lib/contract.ts` mirrors the backend's response shapes by hand. The backend still rejects anything invalid, so drift shows up as a UI bug, not bad data. If it becomes a problem, generate the types from `GET /api/platform/meta` (`configJsonSchema`).
- **Tenant-editable config.** Today only super admins edit config. Letting tenant admins edit a safe subset (branding, list labels) is a candidate for later.
- **Dependency audit** (`npm audit`, October 2026):
  - **Moderate:** aws-sdk v2 in `backend/`. The Phase 5 move to v3 fixes it.
  - **High:** a transitive glob/watcher chain (`fast-glob` → `micromatch` → `braces`) pulled in by dev tooling: `eslint-config-next`, the `shadcn` CLI, `nodemon`, Tailwind 3.
  - **Low:** `dompurify` via Monaco.
  - Review these before the first production deploy (Phase 6).
