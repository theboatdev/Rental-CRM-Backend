# Backend

Express API (JavaScript) for the multi-tenant fleet rental platform. It owns the rules every app depends on:

- the tenant config schema and templates
- the permission catalog
- tenant lifecycle rules

It serves those rules to the admin dashboard and, later, to the tenant app.

## Run locally

```sh
npm install
cp .env.example .env      # add Clerk keys — see docs/clerk-setup.md
npm run dev               # http://localhost:5000
npm test                  # Node's built-in test runner
```

`GET /api/health` needs no keys. Without Clerk keys, `/api/platform` responds 503 and says why.

## Folder layout

| Path | Purpose |
|---|---|
| `src/server.js` | Loads `.env`, wires Clerk auth, starts the server |
| `src/app.js` | `createApp({ platformAuth, service })`: routes and error handling |
| `src/routes/platform.js` | Super admin API under `/api/platform` |
| `src/middleware/platformAuth.js` | Clerk session check plus `super_admin` role check |
| `src/platform/` | The rules: config schema, modules, templates, diff; RBAC; tenant rules; the platform service (in-memory store until Phase 2) and its demo seed |
| `src/models/` | Single-tenant Mongoose models, refactored per tenant in Phase 1 |
| `src/constants/` | Original document types, payment methods and vehicle statuses (superseded by config lists) |
| `test/` | Rule tests and HTTP tests for the platform API |
| `scripts/seed-demo-data.js` | Sample vehicle and renter data template |

## Docs

- [Platform architecture](docs/platform-architecture.md): tenancy, identity, the platform API, repos
- [Tenant config](docs/tenant-config.md): the per-tenant JSON config, upload, validation and versions
- [Roles and permissions](docs/rbac.md)
- [Clerk setup](docs/clerk-setup.md)
- [Development roadmap](docs/development-roadmap.md)
- Original single-tenant design: [architecture.md](docs/architecture.md), [database-schema.md](docs/database-schema.md)

The product scope and client research are in the frontend repo, under `docs/`.
