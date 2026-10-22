const { z } = require('zod');
const { MODULES, MODULE_KEYS, TAB_MODULE_KEYS } = require('./modules');
const { formatPath } = require('./path');

const CONFIG_SCHEMA_VERSION = 1;
const RESIDENT_TYPES = ['local', 'tourist'];

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

let currencyCodes;
function isSupportedCurrency(code) {
  if (currencyCodes === undefined) {
    try {
      currencyCodes = new Set(Intl.supportedValuesOf('currency'));
    } catch {
      currencyCodes = null; // Runtime without Intl.supportedValuesOf: accept any well-formed code.
    }
  }
  return currencyCodes ? currencyCodes.has(code) : true;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function isValidLocale(tag) {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

const CRON_FIELD = /^[\d*/,-]+$/;

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, { error: 'Use a 6-digit hex colour such as #FF4F00' });

const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, { error: 'Use an ISO 4217 currency code such as LKR or USD' })
  .refine(isSupportedCurrency, { error: 'Unknown currency code' });

const e164Phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, { error: 'Use international format without spaces, e.g. +94771234567' });

const cronExpression = z
  .string()
  .trim()
  .refine(
    (value) => {
      const fields = value.split(/\s+/);
      return fields.length === 5 && fields.every((field) => CRON_FIELD.test(field));
    },
    { error: 'Use a 5-field cron expression such as 0 8 * * 1 (Mondays 08:00)' }
  );

const LIST_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
const listKey = z.string().regex(LIST_KEY_PATTERN, { error: 'Keys are UPPER_SNAKE_CASE, e.g. BANK_TRANSFER' });

const codePrefix = z.string().regex(/^[A-Z]{2,6}$/, { error: 'Use 2–6 capital letters' });

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const BrandingSchema = z.strictObject({
  displayName: z.string().trim().min(2).max(80),
  shortName: z.string().trim().min(1).max(24),
  tagline: z.string().trim().max(140).default(''),
  logoUrl: z.url({ protocol: /^https$/, error: 'Logo must be an https URL' }).nullable().default(null),
  primaryColor: hexColor,
  supportEmail: z.email().nullable().default(null),
  supportPhone: z.string().trim().max(32).nullable().default(null),
  /** Number renters message to confirm bookings (guest portal voucher). */
  whatsappNumber: e164Phone.nullable().default(null)
});

const LocaleSchema = z.strictObject({
  country: z.string().regex(/^[A-Z]{2}$/, { error: 'Use an ISO 3166-1 alpha-2 country code such as LK' }),
  currency: currencyCode,
  secondaryCurrency: currencyCode.nullable().default(null),
  timezone: z.string().refine(isValidTimeZone, { error: 'Unknown IANA time zone, e.g. Asia/Colombo' }),
  dateLocale: z.string().refine(isValidLocale, { error: 'Use a BCP 47 locale such as en-GB' }),
  distanceUnit: z.enum(['km', 'mi']).default('km')
});

const enabled = { enabled: z.boolean() };

const ModulesSchema = z.strictObject({
  dashboard: z.strictObject({ ...enabled }),
  vehicles: z.strictObject({
    ...enabled,
    /** Distance between routine services; drives "service due" warnings. */
    serviceIntervalKm: z.number().int().positive().default(5000)
  }),
  renters: z.strictObject({ ...enabled }),
  rentals: z.strictObject({
    ...enabled,
    inspectionPoints: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
    requirePickupInspection: z.boolean().default(true),
    requireDropInspection: z.boolean().default(true)
  }),
  calendar: z.strictObject({ ...enabled }),
  payments: z.strictObject({ ...enabled }),
  costs: z.strictObject({ ...enabled, requireBillUpload: z.boolean().default(false) }),
  fuelLogs: z.strictObject({ ...enabled }),
  whatsappDigest: z.strictObject({
    ...enabled,
    /** Evaluated in the tenant's locale.timezone. */
    cron: cronExpression.default('0 8 * * 1'),
    recipients: z.array(e164Phone).max(10).default([])
  }),
  guestPortal: z.strictObject({
    ...enabled,
    residentTypes: z.array(z.enum(RESIDENT_TYPES)).min(1).default(['local', 'tourist']),
    requireDocumentUpload: z.boolean().default(true)
  })
});

const NavigationItemSchema = z.strictObject({
  module: z.enum(TAB_MODULE_KEYS),
  label: z.string().trim().min(1).max(40)
});

const ListItemSchema = z.strictObject({
  key: listKey,
  label: z.string().trim().min(1).max(80),
  active: z.boolean().default(true)
});

const DocumentTypeSchema = ListItemSchema.extend({
  /** Resident types that must provide this document before a rental. */
  requiredFor: z.array(z.enum(RESIDENT_TYPES)).default([])
});

function keyedList(item) {
  return z
    .array(item)
    .min(1)
    .superRefine((items, ctx) => {
      const seen = new Set();
      items.forEach((entry, index) => {
        if (seen.has(entry.key)) {
          ctx.addIssue({ code: 'custom', message: `Duplicate key "${entry.key}"`, path: [index, 'key'] });
        }
        seen.add(entry.key);
      });
    });
}

const ListsSchema = z.strictObject({
  documentTypes: keyedList(DocumentTypeSchema),
  paymentMethods: keyedList(ListItemSchema),
  costCategories: keyedList(ListItemSchema)
});

const RulesSchema = z.strictObject({
  defaultDepositAmount: z.number().nonnegative(),
  minRentalDays: z.number().int().min(1).default(1),
  /** A tourist must hold at least one of these document types (empty = no check). */
  touristPermitDocumentKeys: z.array(listKey).default([]),
  codePrefixes: z.strictObject({
    rental: codePrefix,
    booking: codePrefix,
    receipt: codePrefix,
    advance: codePrefix,
    renter: codePrefix
  })
});

const LimitsSchema = z.strictObject({
  maxVehicles: z.number().int().min(1).max(10_000),
  maxUsers: z.number().int().min(1).max(1_000),
  storageGb: z.number().positive().max(1_000)
});

// ---------------------------------------------------------------------------
// Tenant config
// ---------------------------------------------------------------------------

const TenantConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    branding: BrandingSchema,
    locale: LocaleSchema,
    modules: ModulesSchema,
    navigation: z.array(NavigationItemSchema).min(1),
    lists: ListsSchema,
    rules: RulesSchema,
    limits: LimitsSchema
  })
  .superRefine((config, ctx) => {
    for (const key of MODULE_KEYS) {
      if (!config.modules[key].enabled) continue;
      for (const required of MODULES[key].requires) {
        if (!config.modules[required].enabled) {
          ctx.addIssue({
            code: 'custom',
            message: `${MODULES[key].label} requires ${MODULES[required].label} to be enabled`,
            path: ['modules', key, 'enabled']
          });
        }
      }
    }

    const navModules = new Set();
    config.navigation.forEach((item, index) => {
      if (navModules.has(item.module)) {
        ctx.addIssue({ code: 'custom', message: `"${item.module}" appears more than once`, path: ['navigation', index, 'module'] });
      }
      navModules.add(item.module);
    });
    for (const key of TAB_MODULE_KEYS) {
      if (config.modules[key].enabled && !navModules.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `${MODULES[key].label} is enabled but missing from navigation`,
          path: ['navigation']
        });
      }
    }

    const documentKeys = new Set(config.lists.documentTypes.map((doc) => doc.key));
    config.rules.touristPermitDocumentKeys.forEach((key, index) => {
      if (!documentKeys.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `"${key}" is not a document type in lists.documentTypes`,
          path: ['rules', 'touristPermitDocumentKeys', index]
        });
      }
    });

    if (config.locale.secondaryCurrency === config.locale.currency) {
      ctx.addIssue({
        code: 'custom',
        message: 'Secondary currency must differ from the main currency',
        path: ['locale', 'secondaryCurrency']
      });
    }
  });

/**
 * Validates a config document and applies defaults.
 * Returns `{ success: true, data }` or `{ success: false, issues: [{ path, message }] }`,
 * where `path` is dotted, e.g. `modules.rentals.inspectionPoints[2]`.
 */
function parseTenantConfig(input) {
  const result = TenantConfigSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message }))
  };
}

/** JSON Schema of the config file, for editors (autocomplete and structural checks). */
function getTenantConfigJsonSchema() {
  return z.toJSONSchema(TenantConfigSchema, { io: 'input', target: 'draft-7' });
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  RESIDENT_TYPES,
  LIST_KEY_PATTERN,
  TenantConfigSchema,
  parseTenantConfig,
  getTenantConfigJsonSchema
};
