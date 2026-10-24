# Backend

Express API (JavaScript) for the multi-tenant fleet rental platform. It owns the rules every app depends on:

- the tenant config schema and templates
- the permission catalog
- tenant lifecycle rules

It serves those rules to the admin dashboard and the tenant app, and runs the tenant API (`/api/v1`) the tenant app works on, with one MongoDB database per tenant.

## Run locally

```sh
npm install
cp .env.example .env      # add Clerk keys (docs/clerk-setup.md) and MONGODB_URI
npm run dev               # http://localhost:5000
npm test                  # Node's built-in test runner; MongoDB runs in memory
```

`GET /api/health` needs no keys and reports whether the database is connected. The server starts even when keys are missing:

- Without Clerk keys, `/api/platform` and `/api/v1` respond 503 and say why.
- Without `MONGODB_URI`, or while the database is unreachable, `/api/v1` and most of `/api/platform` respond 503. `/api/platform/meta` and `/config/validate` don't need it.
- Without `CLERK_WEBHOOK_SIGNING_SECRET`, `/webhooks/clerk` responds 503 and members aren't synced from Clerk.

Creating a tenant from the admin dashboard provisions it for real: it creates a Clerk organization, a `tenant_<id>` database and config v1, and emails the admin an invitation. To walk through it, and to call `/api/v1` as that tenant's admin, see [clerk-setup.md](docs/clerk-setup.md#7-create-a-tenant-and-call-its-api). `npm run seed` adds you as a member when webhooks can't reach your machine.

The first `npm test` downloads a MongoDB binary for `mongodb-memory-server` (cached in `~/.cache/mongodb-binaries`).

## Folder layout

| Path | Purpose |
|---|---|
| `src/server.js` | Loads `.env`, connects to the platform DB, wires Clerk, starts the server |
| `src/app.js` | `createApp({ platformAuth, tenantAuth, platformDb, clerk, webhookSigningSecret })`: routes and error handling |
| `src/db/` | `platform.js`: the platform connection. `tenantDb.js`: `getTenantDb(dbName)` and `initTenantDb` |
| `src/models/` | Mongoose schemas: `platform/` (control plane) and `tenant/` (one DB per tenant). Each file exports a schema |
| `src/routes/platform.js` | Super admin API under `/api/platform` |
| `src/routes/tenant.js` | Tenant API under `/api/v1`: `/me`, `/config`, members, invitations, roles, audit |
| `src/routes/operations.js` | Tenant API operations: dashboard, vehicles, renters, rentals and bookings, calendar, payments, costs, fuel, WhatsApp digest |
| `src/routes/webhooks.js` | `POST /webhooks/clerk`: verified Clerk events |
| `src/middleware/` | `platformAuth.js` (super admin check), `tenantAuth.js` (Clerk session with an organization), `tenantContext.js` (`resolveTenant`, `loadMember`, `requireModule`, `requirePermission`, `hideFinancialFields`), `database.js` (503 without a database), `errorHandler.js` |
| `src/tenant/` | Tenant API logic: `vehicles.js`, `renters.js`, `rentals.js` (the booking rules), `payments.js`, `costs.js`, `dashboard.js`; `team.js`, `roles.js`, `access.js` (Owner and escalation rules); `presenters.js` (response shapes), `metrics.js`, `common.js`, `audit.js` |
| `src/platform/` | The rules (config schema, modules, templates, diff; RBAC; tenant rules) and the platform: `service.js` (tenants, configs, audit), `provisioning.js` (the job runner), `clerk.js` (every Clerk API call), `members.js` (member sync from webhooks) |
| `test/` | Rule tests, HTTP tests for the platform API, provisioning, webhooks, tenancy, team management and operations, on an in-memory MongoDB. `test/helpers/` has the DB setup, a fake Clerk gateway and the demo tenants |
| `scripts/seed-tenant.js` | `npm run seed`: tenant DB indexes and roles, you as a member, optional demo data |

## Docs

- [Platform architecture](docs/platform-architecture.md): tenancy, identity, the platform and tenant APIs, repos
- [Database schema](docs/database-schema.md): platform and tenant collections
- [Tenant config](docs/tenant-config.md): the per-tenant JSON config, upload, validation and versions
- [Roles and permissions](docs/rbac.md)
- [Clerk setup](docs/clerk-setup.md)
- [Development roadmap](docs/development-roadmap.md)
- Original single-tenant design: [architecture.md](docs/architecture.md)

The product scope and client research are in the frontend repo, under `docs/`.
