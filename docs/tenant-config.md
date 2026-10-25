# Tenant config

Each tenant has a JSON config document that controls what its app shows and how it behaves. It covers branding, locale and currency, which feature modules are on, tab order and labels, dropdown lists, business rules, and plan limits.

Super admins edit it in the admin dashboard, under **Tenants → (tenant) → Edit config**. They can:

- edit it through the form tabs or the **Raw JSON** tab;
- **upload a `.json` file** for the tenant (**Upload JSON**);
- download the current draft as `<slug>.config.json`.

The backend owns the schema and does all validation:

- **Schema and validation:** [`src/platform/config/schema.js`](../src/platform/config/schema.js) (`TenantConfigSchema`, `parseTenantConfig`)
- **Templates:** [`src/platform/config/templates/`](../src/platform/config/templates/) (`base.json`, `sri-lanka.json`)
- **Editor JSON Schema:** `getTenantConfigJsonSchema()`, served as `configJsonSchema` by `GET /api/platform/meta`. It drives autocomplete and structural checks in the Raw JSON tab.

## Lifecycle

1. **Draft or upload.** Edits stay in the browser until published.
   - The editor sends the draft to `POST /api/platform/tenants/:id/config/validate` about 400 ms after each change.
   - An uploaded file goes the same way, as raw text (`configText`), so JSON syntax errors come back as issues too.
   - The backend returns the issues (shown per tab), the diff against the active version, and any removed list keys.
   - **Review & publish** stays disabled until the latest draft has been checked.
2. **Publish.** You have to write a change note. The backend validates again on publish and creates a new **immutable version** and an audit entry.
3. **Concurrency.** A publish carries `baseVersion`. If someone else published in the meantime, it's rejected with a conflict, so nobody overwrites changes they never saw.
4. **Restore.** Republishes an old version as the newest one. History is never rewritten.

How each app uses it:

- **Backend:** loads the active version into `req.config` for every tenant request, which drives `requireModule`, permission filtering, list validation and limits.
- **Tenant app:** fetches it once at sign-in from `GET /api/v1/config` (with an ETag). It drives the tabs, CSS branding variables, `Intl` currency and date formatting, and dropdowns.

## Sections

| Section | Fields | Notes |
|---|---|---|
| `schemaVersion` | `1` | Bumped only with a migration (see below) |
| `branding` | `displayName`, `shortName`, `tagline`, `logoUrl` (https), `primaryColor` (`#RRGGBB`), `supportEmail`, `supportPhone`, `whatsappNumber` (E.164) | `whatsappNumber` is where guests send their booking voucher |
| `locale` | `country` (ISO 3166 alpha-2), `currency` and `secondaryCurrency` (ISO 4217), `timezone` (IANA), `dateLocale` (BCP 47), `distanceUnit` (`km`/`mi`) | The timezone also schedules the WhatsApp digest |
| `modules` | `{ enabled }` for each of `dashboard`, `vehicles`, `renters`, `rentals`, `calendar`, `payments`, `costs`, `fuelLogs`, `whatsappDigest`, `guestPortal`, plus per-module settings | See below |
| `navigation` | Ordered `{ module, label }` for tab modules | Tabs of disabled modules are hidden, not removed |
| `lists` | `documentTypes` (with `requiredFor: local/tourist`), `paymentMethods`, `costCategories`: each item is `{ key, label, active }` | See "List keys" |
| `rules` | `defaultDepositAmount`, `minRentalDays`, `touristPermitDocumentKeys`, `codePrefixes` (`rental`, `booking`, `receipt`, `advance`, `renter`) | Prefixes produce codes like `RNT-2026-0042` |
| `fields` | `vehicles`, `renters`, `rentals`, `payments`, `costs`: each `{ builtIn, custom }` | Every field of each record type. Optional; filled in with defaults. See "Fields" |
| `limits` | `maxVehicles`, `maxUsers`, `storageGb` | Enforced by the API; usage is shown next to each limit |

Module settings:

| Module | Settings |
|---|---|
| `vehicles` | `serviceIntervalKm`: drives service-due warnings |
| `rentals` | `inspectionPoints` (photo checklist), `requirePickupInspection`, `requireDropInspection` |
| `costs` | `requireBillUpload` |
| `whatsappDigest` | `cron` (5 fields, in the tenant's timezone), `recipients` (E.164) |
| `guestPortal` | `residentTypes` (who can self-register), `requireDocumentUpload` |

Every object is **strict**, so unknown keys such as a misspelled module are rejected rather than ignored.

## Cross-field rules

The schema rejects a config that is internally inconsistent:

- **Module dependencies.** An enabled module needs the modules it depends on, e.g. `calendar` and `payments` need `rentals`, which needs `vehicles` and `renters`. Dependencies live in `MODULES[key].requires` (`src/platform/config/modules.js`).
- **Navigation.** Every enabled tab module must appear in `navigation` exactly once. The form adds a tab automatically when you enable a module.
- **Tourist permit keys.** `rules.touristPermitDocumentKeys` must reference keys that exist in `lists.documentTypes`.
- **Unique keys.** Keys in each list must be unique.
- **Currencies.** `locale.secondaryCurrency` must differ from `locale.currency`.

## List keys

Tenant records store the list **key** (`BANK_TRANSFER`), never the label, so labels can change freely.

Removing or renaming a key that published records use leaves those records pointing at nothing. Set `active: false` instead. The editor marks published keys with a lock, and the publish dialog warns when keys are removed (`removedListKeys`).

## Fields

`fields` lists every field of vehicles, renters, rentals, payments and costs, so the config shows exactly what the tenant app's forms, detail views and lists show. Each record type has two parts:

- `builtIn`: settings for the fields the platform has, one entry per field.
- `custom`: the tenant's own fields, such as an insurance expiry date on vehicles or a flight number on rentals.

```json
"fields": {
  "vehicles": {
    "builtIn": {
      "year": { "label": "Year", "required": false },
      "thumbnail": { "label": "Photo URL (https)", "active": false }
    },
    "custom": [
      { "key": "insuranceExpiry", "label": "Insurance expiry", "type": "date", "required": true },
      { "key": "colour", "label": "Colour", "type": "select", "showInList": true,
        "options": [{ "key": "WHITE", "label": "White" }, { "key": "BLACK", "label": "Black" }] }
    ]
  }
}
```

### Built-in fields

The list of built-in fields, with their default labels and types, is `BUILT_IN_FIELDS` in `src/platform/config/fields.js`; `GET /api/platform/meta` serves it as `builtInFields`. Each entry in `builtIn` takes these settings, all optional:

| Setting | Default | Meaning |
|---|---|---|
| `label` | The field's default label | Shown in forms, views and list headers |
| `helpText` | `""` | Shown under the input |
| `active` | `true` | Off: the field disappears from forms, views and lists, and the API ignores values for it. Records keep what they have |
| `required` | Varies, e.g. `true` for a vehicle's year | Needed when a record is created, and can't be cleared afterwards |
| `showInList` | Matches the lists before fields were configurable | Shown in the record type's list |

A field left out of `builtIn` gets its defaults. So "removing" a built-in field means turning it off with `active: false`.

**Core fields** are ones the rules depend on, such as a vehicle's plate and daily rate, a renter's name, phone and documents, a rental's vehicle, renter and dates, and a payment's or cost's amount. They can be renamed and given help text, but `active`, `required` and `showInList` must stay `true`.

What happens when some fields are off:

- A vehicle without a year is fine; transmission and fuel default to automatic and petrol; the deposit defaults to `rules.defaultDepositAmount`.
- With the renter type off, every renter is a resident.
- With a booking's rate or deposit off, the booking takes the vehicle's. The rental still shows both, since they're part of what's owed.
- With a cost's date off, costs are dated the day they're logged.
- The second-currency rate is only used when `locale.secondaryCurrency` is set.

A booking's advance follows the payment fields: a required transaction reference is also required for the advance.

In the tenant app, built-in fields keep their place in each form. Custom fields follow them, in config order.

### Custom fields

Every custom field has these settings:

| Setting | Default | Meaning |
|---|---|---|
| `key` | | camelCase letters and digits, e.g. `insuranceExpiry`. Records store values in their `customFields` object under it. It can't be a built-in field's key, and the profit and margin names (`profit`, `revenue`, …) are reserved |
| `label` | | Shown in forms, views and list headers |
| `type` | | `text`, `longText`, `number`, `date`, `boolean` (yes/no) or `select` (a choice list) |
| `required` | `false` | Needed when a record is created, and can't be cleared afterwards. A required yes/no field must be ticked |
| `active` | `true` | Off: the field is hidden and the API ignores values for it; records keep what they have |
| `showInList` | `false` | Also a column in the section's list |
| `helpText` | `""` | Shown under the input |

Some types have settings of their own, and settings of another type are rejected:

| Type | Settings | Values stored |
|---|---|---|
| `text`, `longText` | `maxLength` (defaults: 200, 2,000) | Strings |
| `number` | `min`, `max` (default `null`, no limit) | Numbers |
| `date` | | `YYYY-MM-DD` strings |
| `boolean` | | `true` or `false` |
| `select` | `options`: list items (`{ key, label, active }`, at least one) | The option key |

The rules:

- **At most 20 custom fields per record type**, with unique keys.
- **The backend validates values** against the active config (`src/tenant/fields.js`). It rejects keys that aren't fields of the record type, values of the wrong type, and inactive options.
- **Edits merge.** An edit changes only the fields it sends; `null` or `""` clears a field. So a field that became required later doesn't block edits to older records.
- **Where they can be edited.** Vehicles and renters through their usual edits. Rentals through `PATCH /api/v1/rentals/:id`, which also edits the notes (permission `rentals:create`). Payments and costs only take values when they're recorded, like the rest of those entries. A booking's advance takes the payment fields under `advance.customFields`.

Records keep their values by key, so the same caution as list keys applies. Deactivate a field or an option instead of removing it, and add a new field rather than changing a field's type. The editor locks published keys, and the publish dialog warns about removed fields, type changes and removed options (`customFieldChanges`).

Configs published before fields were configurable have no `fields`. The backend adds the defaults when it reads them (`withConfigDefaults`), so readers can rely on the section being there.

## What does not belong in config

- **Secrets.** API tokens, such as for the WhatsApp Cloud API, go in `tenant_secrets` in the platform DB, encrypted. Config is visible to the tenant app and to every super admin.
- **Per-record data.** Vehicle rates and deposits live on the records; config only holds defaults such as `defaultDepositAmount`.
- **Permissions.** Roles live in the tenant DB and are managed by the tenant admin. See [rbac.md](rbac.md).

## Templates

New tenants start from a template plus overrides (name and limits from the create form):

| Template | Use for |
|---|---|
| `base` | Generic international setup: USD, UTC, generic ID and licence documents. WhatsApp digest and guest portal off |
| `sri-lanka` | LKR (USD secondary), Asia/Colombo, NIC / Sri Lanka DL / Passport / AA Ceylon IDP / DMT permit, tourist permit check on, all modules on |

To add a template:

1. Add a JSON file in `src/platform/config/templates/`.
2. Register it in `CONFIG_TEMPLATES` (`templates.js`).

The backend fails to start, and the tests fail, if a template doesn't validate. The admin dashboard picks new templates up from `GET /api/platform/meta` without a change.

## Changing the schema

- **Adding an optional field with a `.default()`** is backward compatible. Stored configs parse, and the default fills in.
- **Breaking changes** need three things:
  1. Bump `CONFIG_SCHEMA_VERSION`.
  2. Add a `migrateConfig(fromVersion)` step in `src/platform/config/`.
  3. Run the per-tenant migration (Phase 6), which publishes a migrated version for every tenant with the note "Schema migration vN".

After any schema change, run `npm test` in the backend, and update the matching types in the admin dashboard's `src/lib/contract.ts`.
