# Database schema

One `platform` database plus one `tenant_<tenantId>` database per tenant, on the same MongoDB cluster. Why, and how requests reach them, is in [platform-architecture.md](platform-architecture.md#data).

The schemas are in `src/models/`. Every model file exports a schema, never a model:

- `connectPlatformDb` (`src/db/platform.js`) registers the platform models on the platform connection.
- `getTenantDb` (`src/db/tenantDb.js`) registers the tenant models on each tenant's connection.

Nothing is registered on mongoose's global connection.

Conventions:

- **Actors.** `{ id, name }`: the Clerk user id and their name at the time. It's stored on the record, so history keeps the name after a member is removed.
- **Money** is in the tenant's `locale.currency`; distances are in `locale.distanceUnit`.
- **Fixed vocabularies** are uppercase keys (`AVAILABLE`), listed in `src/models/tenant/enums.js`. The tenant app shows them with its own labels.
- **Per-tenant vocabularies** (document types, payment methods, cost categories) store the config **list key** (`BANK_TRANSFER`), never the label. See [tenant-config.md](tenant-config.md#list-keys).
- **Indexes** are never built implicitly. Tenant DBs get theirs from `initTenantDb` at provisioning (or `npm run seed` locally), the platform DB at server startup.

## Platform database

| Collection (model) | Fields | Indexes |
|---|---|---|
| `tenants` (`Tenant`) | `name`, `slug`, `status` (`provisioning` · `active` · `suspended` · `archived`), `template`, `adminEmail`, `adminName`, `clerkOrgId`, `dbName` (set from the id), `activeConfigVersion`, `currency`, `limits { maxVehicles, maxUsers, storageGb }`, `usage { vehicles, members, storageGb }`, `createdBy` | `slug` unique; `clerkOrgId` unique when set |
| `tenant_configs` (`TenantConfig`) | `tenantId`, `version`, `config` (validated before insert), `note`, `createdBy`, `createdAt`. Immutable | `{ tenantId, version }` unique |
| `provisioning_jobs` (`ProvisioningJob`) | `tenantId`, `status` (`running` · `succeeded` · `failed`), `steps [{ key, label, status, error, attempts, finishedAt }]`, `startedAt`, `finishedAt`, `heartbeatAt` (refreshed at every step; a stale one means the run was cut off) | `tenantId` unique; `status` |
| `tenant_secrets` (`TenantSecret`) | `tenantId`, `name` (e.g. `whatsapp.accessToken`), `ciphertext`, `iv`, `authTag` (AES-256-GCM), `keyVersion`, `updatedBy` | `{ tenantId, name }` unique |
| `platform_audit_logs` (`AuditLog`) | `at`, `actor`, `action`, `tenantId`, `tenantName`, `summary` | `at`; `{ tenantId, at }` |

## Tenant database

| Collection (model) | Fields | Indexes |
|---|---|---|
| `members` (`Member`) | `clerkUserId`, `email`, `name`, `roleKey`, `status` (`active` · `removed`), `removedAt`, `membershipSyncedAt` and `profileSyncedAt` (time of the last Clerk webhook event applied). No password: Clerk owns sign-in | `clerkUserId` unique; `{ roleKey, status }` |
| `roles` (`Role`) | `key`, `name`, `description`, `permissions [string]`, `system` | `key` unique |
| `vehicles` (`Vehicle`) | `plateNumber`, `make`, `model`, `year` (absent when the config turns it off), `transmission` (`AUTOMATIC` · `MANUAL`), `fuelType` (`PETROL` · `DIESEL` · `HYBRID` · `ELECTRIC`), `dailyRate`, `secondaryDailyRate`, `depositAmount`, `mileage`, `status` (`AVAILABLE` · `RENTED` · `MAINTENANCE`), `thumbnail`, `notes`, `customFields` | `plateNumber` unique; `status` |
| `renters` (`Renter`) | `profileId` (e.g. `SR-0146`), `fullName`, `phone`, `email`, `residentType` (`local` · `tourist`), `country`, `address`, `emergencyContact { name, phone, relation }`, `documents [{ type (list key), number, fileKey, verified, verifiedBy, verifiedAt, uploadedAt }]`, `source` (`COUNTER` · `ONLINE`), `notes`, `customFields` | `profileId` unique; `phone` |
| `rentals` (`Rental`) | `code` (`RNT-…`, or `BK-…` while reserved), `bookingCode` (the `BK-…` code after check-in), `renter`, `vehicle`, `status` (`RESERVED` · `ACTIVE` · `COMPLETED` · `CANCELLED`), `source`, `startDate`, `endDate`, `actualReturnDate`, `totalDays`, `dailyRate`, `totalAmount`, `depositAmount`, `paidAmount`, `depositRefunded`, `startMileage`, `endMileage`, `pickupInspection` and `dropInspection` (`{ at, by, odometer, photos [{ point, fileKey }], notes }`), `cancelledAt`, `createdBy`, `notes`, `customFields` | `code` unique; `{ vehicle, status, startDate }`; `{ renter, startDate }` |
| `payments` (`Payment`) | `receiptNumber` (`RCPT-…` or `ADV-…`), `rental`, `renter`, `type` (`ADVANCE` · `RENTAL` · `DEPOSIT` · `DAMAGE` · `LATE_FEE` · `REFUND`), `method` (list key), `amount`, `transactionReference`, `paidAt`, `receivedBy`, `voidedAt`, `voidedBy`, `voidReason`, `notes`, `customFields` | `receiptNumber` unique; `rental`; `paidAt` |
| `costs` (`VehicleCost`) | `vehicle`, `category` (list key), `title`, `amount`, `incurredAt`, `serviceCenter`, `invoiceNumber`, `billFileKey`, `odometer`, `createdBy`, `notes`, `customFields` | `{ vehicle, incurredAt }`; `incurredAt` |
| `fuel_logs` (`FuelLog`) | `vehicle`, `filledAt`, `liters`, `pricePerLiter`, `totalCost`, `station`, `odometer`, `createdBy`, `notes` | `{ vehicle, filledAt }` |
| `counters` (`Counter`) | `_id` (sequence key, e.g. `rental:2026`), `seq`. `Counter.next(key, { session })` takes the next number atomically | — |
| `audit_logs` (`AuditLog`) | `at`, `actor`, `action`, `entityType`, `entityId`, `summary` | `at`; `{ entityType, entityId, at }` |

Notes:

- **Derived values aren't stored.** Overdue is an `ACTIVE` rental past its `endDate`. Payment status compares `paidAmount` with `totalAmount + depositAmount`. A vehicle's current renter is its `ACTIVE` rental.
- **`paidAmount`** is kept in step with `payments` inside the transaction that records or voids a payment.
- **Ledger entries are voided, never deleted** (`payments:void`).
- **`fileKey` fields** are S3 object keys under `tenants/<tenantId>/`, served through presigned URLs (Phase 5).

## Changes from the single-tenant design

The original demo backend had one database with a `User` model and title-case enums. Phase 1 changed that:

- `User` (with `passwordHash` and `ADMIN`/`STAFF`) → `Member` plus `Role`. Clerk owns credentials; permissions come from roles ([rbac.md](rbac.md)).
- Enums → uppercase keys: `'Available'` → `AVAILABLE`, `'In Service / Maintenance'` → `MAINTENANCE`. Vehicles no longer have a `Reserved` status, since reservations are rentals. Rentals no longer store `Overdue` or `paymentStatus`.
- Hardcoded document types, payment methods and cost categories (`src/constants/`) → config list keys.
- `isTourist` → `residentType`. `fileUrl` / `billFileUrl` → S3 `fileKey` / `billFileKey`. `receivedBy` is an actor rather than a `User` reference.
- New: `FuelLog`, `Counter`, `AuditLog`.
