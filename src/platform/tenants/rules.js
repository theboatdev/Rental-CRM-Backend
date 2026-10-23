const { z } = require('zod');
const { CONFIG_TEMPLATE_KEYS } = require('../config/templates');

const TENANT_STATUSES = ['provisioning', 'active', 'suspended', 'archived'];

/** Status changes a super admin can make. Provisioning only finishes via the provisioning job. */
const TENANT_STATUS_TRANSITIONS = {
  provisioning: [],
  active: ['suspended', 'archived'],
  suspended: ['active', 'archived'],
  archived: ['suspended']
};

const canTransitionTenant = (from, to) => TENANT_STATUS_TRANSITIONS[from].includes(to);

/** 3–32 chars: lowercase letters, digits and inner hyphens. Used in /book/<slug> and the Clerk org slug. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'assets', 'auth', 'book', 'clerk', 'dashboard', 'docs', 'help',
  'login', 'mail', 'platform', 'public', 'settings', 'sign-in', 'sign-up', 'static',
  'status', 'support', 'webhooks', 'www'
]);

const TenantSlugSchema = z
  .string()
  .regex(SLUG_PATTERN, { error: '3–32 characters: lowercase letters, digits and hyphens (not at the ends)' })
  .refine((slug) => !slug.includes('--'), { error: 'Avoid consecutive hyphens' })
  .refine((slug) => !RESERVED_SLUGS.has(slug), { error: 'This slug is reserved' });

/** Database name for a tenant. Uses the immutable tenant id, never the (renamable) slug. */
function tenantDbName(tenantId) {
  if (!/^[a-zA-Z0-9]{8,40}$/.test(tenantId)) throw new Error(`Invalid tenant id: ${tenantId}`);
  return `tenant_${tenantId}`;
}

/** True for names `tenantDbName` produces, so `platform`, `admin` and the like are never opened as a tenant DB. */
const isTenantDbName = (name) => /^tenant_[a-zA-Z0-9]{8,40}$/.test(name);

const PROVISIONING_STEPS = [
  { key: 'create_tenant_record', label: 'Create tenant record' },
  { key: 'create_clerk_org', label: 'Create Clerk organization' },
  { key: 'init_database', label: 'Create tenant database, indexes and default roles' },
  { key: 'write_config', label: 'Write config v1 from template' },
  { key: 'invite_admin', label: 'Invite tenant admin' },
  { key: 'activate', label: 'Activate tenant' }
];

/** What the super admin submits to create a tenant. */
const CreateTenantInputSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  slug: TenantSlugSchema,
  template: z.enum(CONFIG_TEMPLATE_KEYS),
  adminEmail: z.email({ error: "Enter the tenant admin's email" }),
  adminName: z.string().trim().max(80).optional(),
  limits: z.strictObject({
    maxVehicles: z.number().int().min(1).max(10_000),
    maxUsers: z.number().int().min(1).max(1_000),
    storageGb: z.number().positive().max(1_000)
  })
});

module.exports = {
  TENANT_STATUSES,
  TENANT_STATUS_TRANSITIONS,
  canTransitionTenant,
  SLUG_PATTERN,
  RESERVED_SLUGS,
  TenantSlugSchema,
  tenantDbName,
  isTenantDbName,
  PROVISIONING_STEPS,
  CreateTenantInputSchema
};
