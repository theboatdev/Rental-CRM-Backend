const crypto = require('node:crypto');
const { parseTenantConfig } = require('./config/schema');
const { createConfigFromTemplate } = require('./config/templates');
const { diffConfigs, removedListKeys } = require('./config/diff');
const {
  TENANT_STATUSES,
  TENANT_STATUS_TRANSITIONS,
  canTransitionTenant,
  CreateTenantInputSchema,
  PROVISIONING_STEPS,
  tenantDbName
} = require('./tenants/rules');
const { formatPath } = require('./config/path');
const { conflict, invalid, notFound } = require('./errors');

/**
 * Platform (control plane) operations behind /api/platform.
 *
 * Storage is in memory for now: state resets when the server restarts.
 * Phase 2 moves `store` to the platform MongoDB (tenants, tenant_configs,
 * provisioning_jobs, platform_audit_logs) and makes the provisioning steps real
 * (Clerk organization, tenant database, invitation). The operations and their
 * responses stay the same, so the admin dashboard doesn't change.
 *
 * Test hook: an admin email on the fail.test domain (or a subdomain of it)
 * makes the "invite admin" step fail, so the retry flow can be exercised.
 */

const PROVISIONER = { id: 'system', name: 'Provisioning job' };
const FAIL_INVITE_EMAIL = /@(?:[a-z0-9-]+\.)*fail\.test$/i;

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const clerkOrgIdFor = (slug) => `org_mock_${slug.replace(/-/g, '_')}`;

function buildJob(tenantId, at, failAt) {
  let failed = false;
  const steps = PROVISIONING_STEPS.map(({ key, label }) => {
    if (failed) return { key, label, status: 'pending' };
    if (failAt?.step === key) {
      failed = true;
      return { key, label, status: 'failed', error: failAt.error, finishedAt: at };
    }
    return { key, label, status: 'done', finishedAt: at };
  });
  return { id: newId(), tenantId, status: failed ? 'failed' : 'succeeded', steps, startedAt: at, finishedAt: at };
}

const zodIssues = (error) => error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message }));

function createPlatformService({ seed } = {}) {
  const store = { tenants: new Map(), jobs: new Map(), configs: new Map(), audit: [] };

  const record = (entry) => store.audit.push({ ...entry, id: newId(), at: entry.at ?? now() });

  const requireTenant = (tenantId) => {
    const tenant = store.tenants.get(tenantId);
    if (!tenant) throw notFound('Tenant not found');
    return tenant;
  };

  /** Tenant as returned by the API, with the status changes currently allowed. */
  const present = (tenant) => ({ ...clone(tenant), allowedTransitions: [...TENANT_STATUS_TRANSITIONS[tenant.status]] });

  /** Inserts a tenant with its config history directly (used by the seed). */
  function insertTenant(tenant, versions, { failAt, createdBy }) {
    const configVersions = versions.map((v, index) => ({
      tenantId: tenant.id,
      version: index + 1,
      config: v.config,
      note: v.note,
      createdBy: v.by,
      createdAt: v.at
    }));
    const latest = configVersions.at(-1);
    store.tenants.set(tenant.id, {
      ...tenant,
      dbName: tenantDbName(tenant.id),
      clerkOrgId: clerkOrgIdFor(tenant.slug),
      activeConfigVersion: latest?.version ?? null,
      currency: latest?.config.locale.currency ?? null,
      limits: latest?.config.limits ?? tenant.limits,
      updatedAt: latest?.createdAt ?? tenant.createdAt
    });
    store.configs.set(tenant.id, configVersions);
    store.jobs.set(tenant.id, buildJob(tenant.id, tenant.createdAt, failAt));
    record({
      at: tenant.createdAt,
      actor: createdBy,
      action: 'tenant.created',
      tenantId: tenant.id,
      tenantName: tenant.name,
      summary: `Created from the ${tenant.template} template; admin invite to ${tenant.adminEmail}`
    });
    for (const v of configVersions.slice(1)) {
      record({
        at: v.createdAt,
        actor: v.createdBy,
        action: 'config.published',
        tenantId: tenant.id,
        tenantName: tenant.name,
        summary: `Published v${v.version}: ${v.note}`
      });
    }
  }

  const service = {
    getStats() {
      const tenants = [...store.tenants.values()];
      const tenantsByStatus = Object.fromEntries(TENANT_STATUSES.map((s) => [s, 0]));
      for (const t of tenants) tenantsByStatus[t.status] += 1;
      return {
        tenantsByStatus,
        totalMembers: tenants.reduce((sum, t) => sum + t.usage.members, 0),
        totalVehicles: tenants.reduce((sum, t) => sum + t.usage.vehicles, 0),
        failedProvisioning: [...store.jobs.values()].filter((job) => job.status === 'failed').length
      };
    },

    listTenants() {
      return [...store.tenants.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(present);
    },

    getTenant(tenantId) {
      return present(requireTenant(tenantId));
    },

    getProvisioningJob(tenantId) {
      requireTenant(tenantId);
      const job = store.jobs.get(tenantId);
      return job ? clone(job) : null;
    },

    createTenant(input, actor) {
      const parsed = CreateTenantInputSchema.safeParse(input);
      if (!parsed.success) throw invalid('Check the highlighted fields', zodIssues(parsed.error));
      const data = parsed.data;
      if ([...store.tenants.values()].some((t) => t.slug === data.slug)) {
        throw conflict(`The slug "${data.slug}" is already in use`);
      }

      const at = now();
      const id = newId();
      const config = createConfigFromTemplate(data.template, {
        branding: { displayName: data.name, shortName: (data.name.split(/\s+/)[0] || data.name).slice(0, 24) },
        limits: data.limits
      });
      const job = buildJob(
        id,
        at,
        FAIL_INVITE_EMAIL.test(data.adminEmail)
          ? { step: 'invite_admin', error: 'Clerk rejected the invitation (simulated by the fail.test address)' }
          : undefined
      );
      const tenant = {
        id,
        name: data.name,
        slug: data.slug,
        status: job.status === 'succeeded' ? 'active' : 'provisioning',
        template: data.template,
        adminEmail: data.adminEmail,
        adminName: data.adminName || null,
        clerkOrgId: clerkOrgIdFor(data.slug),
        dbName: tenantDbName(id),
        activeConfigVersion: 1,
        limits: config.limits,
        usage: { vehicles: 0, members: 0, storageGb: 0 },
        currency: config.locale.currency,
        createdAt: at,
        updatedAt: at
      };

      store.tenants.set(id, tenant);
      store.jobs.set(id, job);
      store.configs.set(id, [
        { tenantId: id, version: 1, config, note: `Initial config from the ${data.template} template`, createdBy: PROVISIONER, createdAt: at }
      ]);
      record({
        actor,
        action: 'tenant.created',
        tenantId: id,
        tenantName: tenant.name,
        summary: `Created from the ${data.template} template; admin invite to ${data.adminEmail}`
      });
      return { tenant: present(tenant), job: clone(job) };
    },

    retryProvisioning(tenantId, actor) {
      const tenant = requireTenant(tenantId);
      const job = store.jobs.get(tenantId);
      if (!job || job.status !== 'failed') throw invalid("Provisioning hasn't failed for this tenant");

      const at = now();
      job.steps = job.steps.map((step) =>
        step.status === 'done' ? step : { key: step.key, label: step.label, status: 'done', finishedAt: at }
      );
      job.status = 'succeeded';
      job.finishedAt = at;
      tenant.status = 'active';
      tenant.updatedAt = at;
      record({ actor, action: 'tenant.provisioning_retried', tenantId, tenantName: tenant.name, summary: 'Retried failed steps; tenant activated' });
      return clone(job);
    },

    setTenantStatus(tenantId, status, actor) {
      const tenant = requireTenant(tenantId);
      if (!TENANT_STATUSES.includes(status)) throw invalid(`Unknown status "${status}"`);
      if (!canTransitionTenant(tenant.status, status)) throw invalid(`Can't change a ${tenant.status} tenant to ${status}`);
      const previous = tenant.status;
      tenant.status = status;
      tenant.updatedAt = now();
      record({ actor, action: 'tenant.status_changed', tenantId, tenantName: tenant.name, summary: `Status changed from ${previous} to ${status}` });
      return present(tenant);
    },

    /** Newest first, each with its changes from the previous version. */
    listConfigVersions(tenantId) {
      requireTenant(tenantId);
      const versions = store.configs.get(tenantId) ?? [];
      return versions
        .map((v, index) => ({ ...clone(v), changes: index > 0 ? diffConfigs(versions[index - 1].config, v.config) : [] }))
        .reverse();
    },

    getActiveConfig(tenantId) {
      const tenant = requireTenant(tenantId);
      const version = store.configs.get(tenantId)?.find((v) => v.version === tenant.activeConfigVersion);
      return version ? clone(version) : null;
    },

    /** Validates a draft (e.g. an uploaded file) against the schema and diffs it with the active version. */
    validateTenantConfig(tenantId, config) {
      const active = service.getActiveConfig(tenantId);
      return validateConfig(config, active?.config);
    },

    publishConfig(tenantId, { config, note, baseVersion, restoredFrom }, actor) {
      const tenant = requireTenant(tenantId);
      const trimmedNote = typeof note === 'string' ? note.trim() : '';
      if (trimmedNote.length < 3) throw invalid('Describe the change in a short note');
      if (tenant.activeConfigVersion !== (baseVersion ?? null)) {
        throw conflict(
          `The config changed since you started editing (now v${tenant.activeConfigVersion}). Reload to get the latest version.`
        );
      }
      const parsed = parseTenantConfig(config);
      if (!parsed.success) throw invalid('The config has validation issues', parsed.issues);

      const versions = store.configs.get(tenantId) ?? [];
      const entry = {
        tenantId,
        version: (versions.at(-1)?.version ?? 0) + 1,
        config: parsed.data,
        note: trimmedNote,
        createdBy: actor,
        createdAt: now()
      };
      versions.push(entry);
      store.configs.set(tenantId, versions);
      Object.assign(tenant, {
        activeConfigVersion: entry.version,
        currency: entry.config.locale.currency,
        limits: entry.config.limits,
        updatedAt: entry.createdAt
      });
      record({
        actor,
        action: restoredFrom ? 'config.restored' : 'config.published',
        tenantId,
        tenantName: tenant.name,
        summary: restoredFrom ? `Restored v${restoredFrom} as v${entry.version}` : `Published v${entry.version}: ${trimmedNote}`
      });
      return clone(entry);
    },

    restoreConfigVersion(tenantId, version, baseVersion, actor) {
      requireTenant(tenantId);
      const source = store.configs.get(tenantId)?.find((v) => v.version === version);
      if (!source) throw notFound(`Version ${version} not found`);
      return service.publishConfig(
        tenantId,
        { config: source.config, note: `Restored v${version}`, baseVersion, restoredFrom: version },
        actor
      );
    },

    listAudit({ tenantId, limit } = {}) {
      // Reverse first so entries sharing a timestamp keep newest-first order (sort is stable).
      const entries = [...store.audit]
        .reverse()
        .filter((entry) => !tenantId || entry.tenantId === tenantId)
        .sort((a, b) => b.at.localeCompare(a.at));
      return clone(limit ? entries.slice(0, limit) : entries);
    }
  };

  if (seed) seed({ insertTenant, record, createConfigFromTemplate, PROVISIONER });
  return service;
}

/** Stateless validation: schema issues, plus changes and removed list keys against an optional baseline. */
function validateConfig(config, baseline) {
  const result = parseTenantConfig(config);
  if (!result.success) {
    return { valid: false, issues: result.issues, changes: baseline ? diffConfigs(baseline, config) : [], removedListKeys: [] };
  }
  return {
    valid: true,
    issues: [],
    config: result.data,
    changes: baseline ? diffConfigs(baseline, result.data) : [],
    removedListKeys: baseline ? removedListKeys(baseline, result.data) : []
  };
}

module.exports = { createPlatformService, validateConfig };
