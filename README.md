# Backend

Express API (JavaScript) for the multi-tenant fleet rental platform. It owns the rules every app depends on:

- the tenant config schema and templates
- the permission catalog
- tenant lifecycle rules

It serves those rules to the admin dashboard and, later, to the tenant app. It also serves the tenant API (`/api/v1`), with one MongoDB database per tenant.

## Run locally

```sh
npm install
cp .env.example .env      # add Clerk keys (docs/clerk-setup.md) and MONGODB_URI
npm run dev               # http://localhost:5000
npm test                  # Node's built-in test runner; MongoDB runs in memory
```

`GET /api/health` needs no keys and reports whether the database is connected. The server starts even when keys are missing:

- Without Clerk keys, `/api/platform` and `/api/v1` respond 503 and say why.
- Without `MONGODB_URI`, or while the database is unreachable, `/api/v1` responds 503. `/api/platform` keeps working from its in-memory store until Phase 2.

`npm run seed` prepares a tenant database and adds you as a member, so you can call `/api/v1` with your Clerk session. See [clerk-setup.md](docs/clerk-setup.md#7-call-the-tenant-api-locally).

The first `npm test` downloads a MongoDB binary for `mongodb-memory-server` (cached in `~/.cache/mongodb-binaries`).

## Folder layout

| Path | Purpose |
|---|---|
| `src/server.js` | Loads `.env`, connects to the platform DB, wires Clerk auth, starts the server |
| `src/app.js` | `createApp({ platformAuth, tenantAuth, platformDb, service })`: routes and error handling |
| `src/db/` | `platform.js`: the platform connection. `tenantDb.js`: `getTenantDb(dbName)` and `initTenantDb` |
| `src/models/` | Mongoose schemas: `platform/` (control plane) and `tenant/` (one DB per tenant). Each file exports a schema |
| `src/routes/platform.js` | Super admin API under `/api/platform` |
| `src/routes/tenant.js` | Tenant API under `/api/v1`: `GET /me`, `GET /config` |
| `src/middleware/` | `platformAuth.js` (super admin check), `tenantAuth.js` (Clerk session with an organization), `tenantContext.js` (`resolveTenant`, `loadMember`, `requireModule`, `requirePermission`), `errorHandler.js` |
| `src/platform/` | The rules: config schema, modules, templates, diff; RBAC; tenant rules; the platform service (in-memory store until Phase 2) and its demo seed |
| `test/` | Rule tests, HTTP tests for the platform API, and tenancy tests (`tenancy.test.js`) on an in-memory MongoDB |
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
