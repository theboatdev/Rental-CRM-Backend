# Roles and permissions (RBAC)

Two layers, with a clear split:

| Layer | Owned by | Holds |
|---|---|---|
| **Clerk** | Identity platform | Who the user is (sign-in, MFA), which tenant organizations they belong to, and a coarse org role: `org:admin` for the tenant Owner, `org:member` for everyone else |
| **Tenant DB** (`roles`, `members`) | Tenant admin | Which permissions each member has. Roles are built from a fixed permission catalog |

Clerk's custom roles are defined once for the whole Clerk instance, so they can't differ per tenant. Keeping roles in each tenant's database lets every rental company define its own roles (e.g. *Front desk*, *Workshop lead*) without touching Clerk.

Code: [`src/platform/rbac/permissions.js`](../src/platform/rbac/permissions.js). The catalog and system roles are also served by `GET /api/platform/meta` (`permissions`, `systemRoles`), so the apps never keep their own copy.

## Permission catalog

Permissions are `resource:action` strings. Most are tied to a module. When the tenant config disables that module, the permission is dropped from every role automatically (`effectivePermissions`). Core permissions (`—`) always apply.

The catalog and the four system roles:

| Permission | Group | Requires module | Owner | Manager | Staff | Accountant |
|---|---|---|:-:|:-:|:-:|:-:|
| `dashboard:view` | Dashboard | `dashboard` | ✓ | ✓ | ✓ | ✓ |
| `financials:view` | Dashboard | — | ✓ | ✓ |  | ✓ |
| `vehicles:read` | Fleet | `vehicles` | ✓ | ✓ | ✓ | ✓ |
| `vehicles:create` | Fleet | `vehicles` | ✓ | ✓ |  |  |
| `vehicles:update` | Fleet | `vehicles` | ✓ | ✓ | ✓ |  |
| `vehicles:delete` | Fleet | `vehicles` | ✓ | ✓ |  |  |
| `renters:read` | Renters | `renters` | ✓ | ✓ | ✓ | ✓ |
| `renters:create` | Renters | `renters` | ✓ | ✓ | ✓ |  |
| `renters:update` | Renters | `renters` | ✓ | ✓ | ✓ |  |
| `renters:documents:verify` | Renters | `renters` | ✓ | ✓ | ✓ |  |
| `rentals:read` | Rentals | `rentals` | ✓ | ✓ | ✓ | ✓ |
| `rentals:create` | Rentals | `rentals` | ✓ | ✓ | ✓ |  |
| `rentals:checkin` | Rentals | `rentals` | ✓ | ✓ | ✓ |  |
| `rentals:return` | Rentals | `rentals` | ✓ | ✓ | ✓ |  |
| `rentals:cancel` | Rentals | `rentals` | ✓ | ✓ | ✓ |  |
| `calendar:view` | Calendar | `calendar` | ✓ | ✓ | ✓ | ✓ |
| `payments:read` | Payments | `payments` | ✓ | ✓ | ✓ | ✓ |
| `payments:record` | Payments | `payments` | ✓ | ✓ | ✓ | ✓ |
| `payments:void` | Payments | `payments` | ✓ | ✓ |  | ✓ |
| `costs:read` | Costs | `costs` | ✓ | ✓ | ✓ | ✓ |
| `costs:create` | Costs | `costs` | ✓ | ✓ | ✓ | ✓ |
| `costs:delete` | Costs | `costs` | ✓ | ✓ |  | ✓ |
| `fuel:read` | Fuel | `fuelLogs` | ✓ | ✓ | ✓ | ✓ |
| `fuel:create` | Fuel | `fuelLogs` | ✓ | ✓ | ✓ |  |
| `whatsapp:view` | WhatsApp | `whatsappDigest` | ✓ | ✓ |  | ✓ |
| `whatsapp:manage` | WhatsApp | `whatsappDigest` | ✓ | ✓ |  |  |
| `team:read` | Administration | — | ✓ | ✓ |  |  |
| `team:manage` | Administration | — | ✓ |  |  |  |
| `roles:manage` | Administration | — | ✓ |  |  |  |
| `audit:read` | Administration | — | ✓ | ✓ |  | ✓ |

The table is generated from `PERMISSIONS` and `SYSTEM_ROLES`. Regenerate it when either changes.

## System roles

Seeded into every tenant DB at provisioning. They can't be renamed or deleted.

| Role | Intent |
|---|---|
| **Owner** | The tenant admin invited at provisioning; maps to Clerk `org:admin`. Everything, including team and role management |
| **Manager** | Runs operations and sees financials; can't manage the team or roles |
| **Staff** | Today's demo STAFF role, per the SOW: intake, rentals, handovers, payments, costs. No profit figures, no deleting or voiding ledger entries |
| **Accountant** | Read-only operations, full access to payments, costs and financials |

A tenant must always have at least one active Owner. The API refuses to remove or demote the last one.

## Custom roles

Tenant admins (`roles:manage`) create roles in the tenant app's settings:

- Pick a key (`front_desk`), a name and permissions.
- The picker only offers permissions whose module is enabled (`availablePermissions(config)`).
- Input is validated with `CustomRoleInputSchema`, which rejects unknown permissions and deduplicates.

## Team invites

1. A tenant admin (`team:manage`) invites an email address and picks a role.
2. The backend checks `limits.maxUsers`, then calls Clerk `createOrganizationInvitation` with `publicMetadata.roleKey`. The Clerk role is `org:admin` for Owner and `org:member` otherwise.
3. When the invite is accepted, the `organizationMembership.created` webhook creates the `members` document with that `roleKey`.
4. Role changes update `members.roleKey`. Promoting someone to Owner also updates their Clerk org role.
5. Removing a member deletes the Clerk membership; the webhook marks the member `removed`. Audit history keeps their name.

## Enforcement

- **API (source of truth).** `requirePermission('payments:void')` on every route, after `loadMember` computes effective permissions. Disabled modules return 404 through `requireModule` before permissions are checked.
- **Tenant app (UX only).** `GET /api/v1/me` returns `{ user, tenant, role, permissions, configVersion }`; the config itself comes from `GET /api/v1/config`. `<Can permission="financials:view">` and `useCan()` hide what the user can't use. Hiding UI is never the protection.
- **Field-level rule.** Responses drop profit and margin fields unless the caller has `financials:view`, so a Staff user can't read them from the network tab.

## Super admins are separate

Platform access (`publicMetadata.platformRole = "super_admin"`) is unrelated to tenant roles. A super admin isn't a member of any tenant organization and has no tenant permissions. See [platform-architecture.md](platform-architecture.md#super-admins).
