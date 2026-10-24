const { z } = require('zod');

/**
 * Every permission the tenant app and API check. Tenant admins build custom
 * roles from this catalog; it is not editable per tenant. `module` is the
 * config module that must be enabled for the permission to apply (null = core).
 */
const PERMISSIONS = {
  'dashboard:view': { group: 'Dashboard', label: 'View the operations dashboard', module: 'dashboard' },
  'financials:view': { group: 'Dashboard', label: 'View revenue, operating costs, profit and margins', module: null },

  'vehicles:read': { group: 'Fleet', label: 'View vehicles', module: 'vehicles' },
  'vehicles:create': { group: 'Fleet', label: 'Add vehicles', module: 'vehicles' },
  'vehicles:update': { group: 'Fleet', label: 'Edit vehicles, status and mileage', module: 'vehicles' },
  'vehicles:delete': { group: 'Fleet', label: 'Delete vehicles', module: 'vehicles' },

  'renters:read': { group: 'Renters', label: 'View renter profiles', module: 'renters' },
  'renters:create': { group: 'Renters', label: 'Register renters', module: 'renters' },
  'renters:update': { group: 'Renters', label: 'Edit renter profiles', module: 'renters' },
  'renters:documents:verify': { group: 'Renters', label: 'Verify identity documents', module: 'renters' },

  'rentals:read': { group: 'Rentals', label: 'View rentals and inspections', module: 'rentals' },
  'rentals:create': { group: 'Rentals', label: 'Create rentals and reservations', module: 'rentals' },
  'rentals:checkin': { group: 'Rentals', label: 'Hand over vehicles (pickup inspection)', module: 'rentals' },
  'rentals:return': { group: 'Rentals', label: 'Record returns (drop inspection)', module: 'rentals' },
  'rentals:cancel': { group: 'Rentals', label: 'Cancel reservations', module: 'rentals' },

  'calendar:view': { group: 'Calendar', label: 'View the booking calendar', module: 'calendar' },

  'payments:read': { group: 'Payments', label: 'View the payment ledger', module: 'payments' },
  'payments:record': { group: 'Payments', label: 'Record payments, advances and refunds', module: 'payments' },
  'payments:void': { group: 'Payments', label: 'Void ledger entries', module: 'payments' },

  'costs:read': { group: 'Costs', label: 'View operating costs and service bills', module: 'costs' },
  'costs:create': { group: 'Costs', label: 'Log costs and upload bills', module: 'costs' },
  'costs:delete': { group: 'Costs', label: 'Delete cost entries', module: 'costs' },

  'fuel:read': { group: 'Fuel', label: 'View fuel logs', module: 'fuelLogs' },
  'fuel:create': { group: 'Fuel', label: 'Log fuel fill-ups', module: 'fuelLogs' },

  'whatsapp:view': { group: 'WhatsApp', label: 'Preview the WhatsApp digest', module: 'whatsappDigest' },
  'whatsapp:manage': { group: 'WhatsApp', label: 'Change digest recipients and send digests', module: 'whatsappDigest' },

  'team:read': { group: 'Administration', label: 'View team members', module: null },
  'team:manage': { group: 'Administration', label: 'Invite, remove and assign roles to members', module: null },
  'roles:manage': { group: 'Administration', label: 'Create and edit roles', module: null },
  'audit:read': { group: 'Administration', label: 'View the audit log', module: null }
};

const ALL_PERMISSIONS = Object.keys(PERMISSIONS);
const isPermission = (value) => Object.prototype.hasOwnProperty.call(PERMISSIONS, value);

const OWNER_ROLE_KEY = 'owner';
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

const except = (...excluded) => ALL_PERMISSIONS.filter((p) => !excluded.includes(p));

/** Seeded into every tenant DB at provisioning; system roles can't be renamed or deleted. */
const SYSTEM_ROLES = [
  {
    key: OWNER_ROLE_KEY,
    name: 'Owner',
    description: 'Tenant admin. Full access, including team and role management.',
    permissions: [...ALL_PERMISSIONS],
    system: true
  },
  {
    key: 'manager',
    name: 'Manager',
    description: "Runs operations and sees financials; can't manage the team or roles.",
    permissions: except('team:manage', 'roles:manage'),
    system: true
  },
  {
    key: 'staff',
    name: 'Staff',
    description: 'Day-to-day operations. No profit figures, no deleting or voiding ledger entries.',
    permissions: [
      'dashboard:view',
      'vehicles:read',
      'vehicles:update',
      'renters:read',
      'renters:create',
      'renters:update',
      'renters:documents:verify',
      'rentals:read',
      'rentals:create',
      'rentals:checkin',
      'rentals:return',
      'rentals:cancel',
      'calendar:view',
      'payments:read',
      'payments:record',
      'costs:read',
      'costs:create',
      'fuel:read',
      'fuel:create'
    ],
    system: true
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Read-only operations with full access to payments, costs and financials.',
    permissions: [
      'dashboard:view',
      'financials:view',
      'vehicles:read',
      'renters:read',
      'rentals:read',
      'calendar:view',
      'payments:read',
      'payments:record',
      'payments:void',
      'costs:read',
      'costs:create',
      'costs:delete',
      'fuel:read',
      'whatsapp:view',
      'audit:read'
    ],
    system: true
  }
];

const roleFields = {
  name: z.string().trim().min(2).max(40),
  description: z.string().trim().max(200),
  permissions: z
    .array(z.string().refine(isPermission, { error: 'Unknown permission' }))
    .min(1)
    .transform((values) => [...new Set(values)])
};

/** Shape the API accepts when a tenant admin creates a custom role. */
const CustomRoleInputSchema = z.strictObject({
  key: z.string().regex(ROLE_KEY_PATTERN, { error: 'Use lowercase letters, digits and underscores, e.g. front_desk' }),
  ...roleFields,
  description: roleFields.description.default('')
});

/** Shape the API accepts when a tenant admin edits a custom role: any of the fields, never the key. */
const CustomRoleUpdateSchema = z.strictObject(roleFields).partial();

function isPermissionActive(permission, config) {
  const module = PERMISSIONS[permission].module;
  return module === null || config.modules[module].enabled;
}

/**
 * The permissions a member actually has: drops unknown strings (e.g. from a
 * permission removed in a later release) and anything tied to a disabled module.
 */
function effectivePermissions(granted, config) {
  return [...new Set(granted)].filter((value) => isPermission(value) && isPermissionActive(value, config));
}

/** Permissions a tenant admin can pick from when building a role. */
function availablePermissions(config) {
  return ALL_PERMISSIONS.filter((permission) => isPermissionActive(permission, config));
}

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  OWNER_ROLE_KEY,
  ROLE_KEY_PATTERN,
  SYSTEM_ROLES,
  CustomRoleInputSchema,
  CustomRoleUpdateSchema,
  isPermission,
  effectivePermissions,
  availablePermissions
};
