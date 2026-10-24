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

Tenant admins (`roles:manage`) create roles in the tenant app's settings, through `POST /api/v1/roles`:

- Pick a key (`front_desk`), a name and permissions. The key can't change afterwards.
- The picker offers the catalog from `GET /api/v1/permissions`, where permissions of disabled modules are `available: false`. A role may still hold them; they take effect when the module is enabled.
- Input is validated with `CustomRoleInputSchema` (create) and `CustomRoleUpdateSchema` (edit), which reject unknown permissions and deduplicate.
- System roles can't be edited or deleted. A custom role can't be deleted while an active member or a pending invitation uses it.

## Team invites

1. Someone invites an email address and picks a role:
   - a super admin, from the tenant's **Users** page in the admin dashboard (`POST /api/platform/tenants/:id/invitations`). They act as an Owner, so they can invite Owners;
   - or a tenant admin with `team:manage`, from the tenant app's Team page (`POST /api/v1/invitations`).

   Both go through the same code (`src/tenant/team.js`), and changing roles or removing members works the same way.
2. The backend checks `limits.maxUsers` against active members plus pending invitations. It then calls Clerk `createOrganizationInvitation` with `publicMetadata.roleKey`. The Clerk role is `org:admin` for Owner and `org:member` otherwise.
3. Clerk emails the invitation. Its link opens the tenant app's `/sign-up`, where the person creates their account (with a password when Clerk's password sign-in is on). Accepting makes them a member of the organization, and the `organizationMembership.created` webhook creates the `members` document with that `roleKey`.
4. Role changes (`PATCH /api/v1/members/:id`) update `members.roleKey`. Moving someone into or out of Owner also updates their Clerk org role. If Clerk fails, the change is undone.
5. Removing a member (`DELETE /api/v1/members/:id`) marks them `removed` and deletes the Clerk membership; the webhook confirms it. Audit history keeps their name.

Team and role changes are recorded in the tenant's `audit_logs`, readable with `audit:read` (`GET /api/v1/audit`).

## Enforcement

- **API (source of truth).** `requirePermission('payments:void')` on every route, after `loadMember` computes effective permissions.
  - Disabled modules return 404 through `requireModule` before permissions are checked.
  - Only `/me` and `/config` are open to every member (`OPEN_ROUTES` in `src/routes/tenant.js`). `test/team.test.js` fails if any other route lacks a permission check.
- **Last Owner.** A tenant must always have at least one active Owner. Demoting or removing the last one returns 409.
  - These changes run in a transaction that bumps a lock document first, so two Owners demoting each other at once can't both succeed.
- **No escalation.** These rules only ever stop non-Owners, such as a custom "front desk" role given `team:manage` (`src/tenant/access.js`):
  - Only an Owner can make someone an Owner, or change or remove an Owner.
  - Nobody can invite with, assign, or define a role holding permissions they don't have.
  - Nobody can change or remove a member, or edit a role, whose permissions go beyond their own.
- **Tenant app (UX only).** `GET /api/v1/me` returns `{ user, tenant, role, permissions, configVersion }`; the config itself comes from `GET /api/v1/config`. The app's `useWorkspace().can(permission)` hides tabs, buttons and forms the role can't use. Hiding UI is never the protection.
- **Field-level rule.** Responses drop profit and margin fields unless the caller has `financials:view`, so a Staff user can't read them from the network tab.
  - `hideFinancialFields` strips them from every tenant response, at any depth. The field names are listed in `src/platform/rbac/financialFields.js`: `revenue`, `totalRevenue`, `operatingCosts`, `profit`, `grossProfit`, `netProfit`, `margin`, `profitMargin`, `roi`.
  - Handlers that return such figures must use those names. Raw amounts a role works with, like a rental total or a cost entry, aren't filtered.

## Super admins are separate

Platform access (`publicMetadata.platformRole = "super_admin"`) is unrelated to tenant roles. A super admin isn't a member of any tenant organization and has no tenant permissions. See [platform-architecture.md](platform-architecture.md#super-admins).
