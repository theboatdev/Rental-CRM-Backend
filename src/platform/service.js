const { isObjectIdOrHexString } = require('mongoose');
const { parseTenantConfig } = require('./config/schema');
const { CONFIG_TEMPLATES } = require('./config/templates');
const { diffConfigs, removedListKeys } = require('./config/diff');
const {
  TENANT_STATUSES,
  TENANT_STATUS_TRANSITIONS,
  canTransitionTenant,
  CreateTenantInputSchema,
  PROVISIONING_STEPS
} = require('./tenants/rules');
const { zodIssues } = require('./config/path');
const { conflict, invalid, notFound } = require('./errors');
const { createProvisioner, newJobSteps } = require('./provisioning');

/**
 * Platform (control plane) operations behind /api/platform, stored in the
 * platform database. Responses are plain JSON with string ids and ISO dates,
 * in the shapes the admin dashboard's `src/lib/platform-api/types.ts` describes.
 *
 * `clerk` is the gateway from `createClerkGateway` (a fake in tests).
 */

const iso = (date) => (date ? new Date(date).toISOString() : null);
const actorOf = (actor) => ({ id: actor.id, name: actor.name });

/** Tenant as returned by the API, with the status changes currently allowed. */
function presentTenant(t) {
  return {
    id: String(t._id),
    name: t.name,
    slug: t.slug,
    status: t.status,
    allowedTransitions: [...TENANT_STATUS_TRANSITIONS[t.status]],
    template: t.template,
    adminEmail: t.adminEmail,
    adminName: t.adminName ?? null,
    clerkOrgId: t.clerkOrgId ?? null,
    dbName: t.dbName,
    activeConfigVersion: t.activeConfigVersion ?? null,
    limits: { maxVehicles: t.limits.maxVehicles, maxUsers: t.limits.maxUsers, storageGb: t.limits.storageGb },
    usage: { vehicles: t.usage?.vehicles ?? 0, members: t.usage?.members ?? 0, storageGb: t.usage?.storageGb ?? 0 },
    currency: t.currency ?? null,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt)
  };
}

function presentJob(job) {
  return {
    id: String(job._id),
    tenantId: String(job.tenantId),
    status: job.status,
    steps: job.steps.map(({ key, label, status, error, finishedAt }) => ({
      key,
      label,
      status,
      ...(error ? { error } : {}),
      ...(finishedAt ? { finishedAt: iso(finishedAt) } : {})
    })),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt)
  };
}

const presentConfigVersion = (v) => ({
  tenantId: String(v.tenantId),
  version: v.version,
  config: v.config,
  note: v.note,
  createdBy: actorOf(v.createdBy),
  createdAt: iso(v.createdAt)
});

const presentAudit = (entry) => ({
  id: String(entry._id),
  at: iso(entry.at),
  actor: actorOf(entry.actor),
  action: entry.action,
  tenantId: entry.tenantId ? String(entry.tenantId) : null,
  tenantName: entry.tenantName ?? null,
  summary: entry.summary
});

const isDuplicateKey = (error) => error?.code === 11000;

/** Thrown inside a transaction to abort it when a compare-and-set update matched nothing. */
class StaleWrite extends Error {}

function createPlatformService({ platformDb, getTenantDb, clerk }) {
  const { Tenant, TenantConfig, ProvisioningJob, AuditLog } = platformDb.models;
  const provisioner = createProvisioner({ platformDb, getTenantDb, clerk });

  const record = (entry, session) => AuditLog.create([{ ...entry, at: new Date() }], { session });

  async function requireTenant(tenantId) {
    const tenant = isObjectIdOrHexString(tenantId) ? await Tenant.findById(tenantId).lean() : null;
    if (!tenant) throw notFound('Tenant not found');
    return tenant;
  }

  async function activeConfigOf(tenant) {
    if (tenant.activeConfigVersion === null || tenant.activeConfigVersion === undefined) return null;
    return TenantConfig.findOne({ tenantId: tenant._id, version: tenant.activeConfigVersion }).lean();
  }

  const service = {
    async getStats() {
      const [byStatus, [usage], failedProvisioning] = await Promise.all([
        Tenant.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        Tenant.aggregate([{ $group: { _id: null, members: { $sum: '$usage.members' }, vehicles: { $sum: '$usage.vehicles' } } }]),
        ProvisioningJob.countDocuments({ status: 'failed' })
      ]);
      const tenantsByStatus = Object.fromEntries(TENANT_STATUSES.map((s) => [s, 0]));
      for (const { _id, count } of byStatus) tenantsByStatus[_id] = count;
      return {
        tenantsByStatus,
        totalMembers: usage?.members ?? 0,
        totalVehicles: usage?.vehicles ?? 0,
        failedProvisioning
      };
    },

    async listTenants() {
      const tenants = await Tenant.find().sort({ createdAt: -1 }).lean();
      return tenants.map(presentTenant);
    },

    async getTenant(tenantId) {
      return presentTenant(await requireTenant(tenantId));
    },

    /** For the tenant API: the tenant linked to a Clerk organization, with its active config, or null. */
    async findTenantByClerkOrgId(clerkOrgId) {
      const tenant = await Tenant.findOne({ clerkOrgId }).lean();
      if (!tenant) return null;
      const active = await activeConfigOf(tenant);
      return { tenant: presentTenant(tenant), activeConfig: active && presentConfigVersion(active) };
    },

    async getProvisioningJob(tenantId) {
      const tenant = await requireTenant(tenantId);
      const job = await ProvisioningJob.findOne({ tenantId: tenant._id }).lean();
      return job ? presentJob(job) : null;
    },

    /**
     * Creates the tenant record and runs its provisioning job before
     * responding. A failed step leaves the tenant `provisioning`, with the job
     * stopped at that step for a retry.
     */
    async createTenant(input, actor) {
      const parsed = CreateTenantInputSchema.safeParse(input);
      if (!parsed.success) throw invalid('Check the highlighted fields', zodIssues(parsed.error));
      const data = parsed.data;
      const slugTaken = () => conflict(`The slug "${data.slug}" is already in use`);
      if (await Tenant.exists({ slug: data.slug })) throw slugTaken();

      const at = new Date();
      const tenant = new Tenant({
        name: data.name,
        slug: data.slug,
        status: 'provisioning',
        template: data.template,
        adminEmail: data.adminEmail,
        adminName: data.adminName || null,
        limits: data.limits,
        currency: CONFIG_TEMPLATES[data.template].config.locale.currency,
        createdBy: actorOf(actor)
      });
      const job = new ProvisioningJob({ tenantId: tenant._id, status: 'running', steps: newJobSteps(at), startedAt: at, heartbeatAt: at });
      try {
        await platformDb.transaction(async (session) => {
          await tenant.save({ session });
          await job.save({ session });
          await record(
            {
              actor: actorOf(actor),
              action: 'tenant.created',
              tenantId: tenant._id,
              tenantName: tenant.name,
              summary: `Created from the ${data.template} template; admin invite to ${tenant.adminEmail}`
            },
            session
          );
        });
      } catch (error) {
        if (isDuplicateKey(error)) throw slugTaken();
        throw error;
      }

      const finished = await provisioner.run(job._id);
      return { tenant: presentTenant(await Tenant.findById(tenant._id).lean()), job: presentJob(finished) };
    },

    async retryProvisioning(tenantId, actor) {
      const tenant = await requireTenant(tenantId);
      const claimed = await provisioner.claimForRetry(tenant._id);
      if (!claimed) {
        const job = await ProvisioningJob.findOne({ tenantId: tenant._id }).lean();
        if (job?.status === 'running') throw conflict('Provisioning is already running for this tenant');
        throw invalid("Provisioning hasn't failed for this tenant");
      }

      const finished = await provisioner.run(claimed._id);
      const failedStep = finished.steps.find((step) => step.status === 'failed');
      const label = failedStep && PROVISIONING_STEPS.find((step) => step.key === failedStep.key).label;
      await record({
        actor: actorOf(actor),
        action: 'tenant.provisioning_retried',
        tenantId: tenant._id,
        tenantName: tenant.name,
        summary: failedStep ? `Retried; stopped again at "${label}": ${failedStep.error}` : 'Retried failed steps; tenant activated'
      });
      return presentJob(finished);
    },

    async setTenantStatus(tenantId, status, actor) {
      const tenant = await requireTenant(tenantId);
      if (!TENANT_STATUSES.includes(status)) throw invalid(`Unknown status "${status}"`);
      if (!canTransitionTenant(tenant.status, status)) throw invalid(`Can't change a ${tenant.status} tenant to ${status}`);
      try {
        await platformDb.transaction(async (session) => {
          // Compare-and-set on the status read above, so two concurrent changes can't both apply.
          const { modifiedCount } = await Tenant.updateOne({ _id: tenant._id, status: tenant.status }, { $set: { status } }, { session });
          if (!modifiedCount) throw new StaleWrite();
          await record(
            {
              actor: actorOf(actor),
              action: 'tenant.status_changed',
              tenantId: tenant._id,
              tenantName: tenant.name,
              summary: `Status changed from ${tenant.status} to ${status}`
            },
            session
          );
        });
      } catch (error) {
        if (error instanceof StaleWrite) throw conflict('The tenant changed while you were looking at it. Reload and try again.');
        throw error;
      }
      return presentTenant(await Tenant.findById(tenant._id).lean());
    },

    /** Newest first, each with its changes from the previous version. */
    async listConfigVersions(tenantId) {
      const tenant = await requireTenant(tenantId);
      const versions = await TenantConfig.find({ tenantId: tenant._id }).sort({ version: 1 }).lean();
      return versions
        .map((v, index) => ({ ...presentConfigVersion(v), changes: index > 0 ? diffConfigs(versions[index - 1].config, v.config) : [] }))
        .reverse();
    },

    async getActiveConfig(tenantId) {
      const active = await activeConfigOf(await requireTenant(tenantId));
      return active ? presentConfigVersion(active) : null;
    },

    /** Validates a draft (e.g. an uploaded file) against the schema and diffs it with the active version. */
    async validateTenantConfig(tenantId, config) {
      const active = await service.getActiveConfig(tenantId);
      return validateConfig(config, active?.config);
    },

    /**
     * Publishes a new version. It's rejected with a conflict unless `baseVersion`
     * is the active version; the unique (tenantId, version) index settles a race
     * between two publishes from the same base.
     */
    async publishConfig(tenantId, { config, note, baseVersion, restoredFrom }, actor) {
      const tenant = await requireTenant(tenantId);
      const trimmedNote = typeof note === 'string' ? note.trim() : '';
      if (trimmedNote.length < 3) throw invalid('Describe the change in a short note');
      const current = tenant.activeConfigVersion ?? null;
      const stale = () =>
        conflict(`The config changed since you started editing (now v${current ?? '—'}). Reload to get the latest version.`);
      if (current !== (baseVersion ?? null)) throw stale();
      const parsed = parseTenantConfig(config);
      if (!parsed.success) throw invalid('The config has validation issues', parsed.issues);

      const entry = {
        tenantId: tenant._id,
        version: (current ?? 0) + 1,
        config: parsed.data,
        note: trimmedNote,
        createdBy: actorOf(actor)
      };
      let created;
      try {
        await platformDb.transaction(async (session) => {
          [created] = await TenantConfig.create([entry], { session });
          const { modifiedCount } = await Tenant.updateOne(
            { _id: tenant._id, activeConfigVersion: current },
            { $set: { activeConfigVersion: entry.version, currency: parsed.data.locale.currency, limits: parsed.data.limits } },
            { session }
          );
          if (!modifiedCount) throw new StaleWrite();
          await record(
            {
              actor: actorOf(actor),
              action: restoredFrom ? 'config.restored' : 'config.published',
              tenantId: tenant._id,
              tenantName: tenant.name,
              summary: restoredFrom ? `Restored v${restoredFrom} as v${entry.version}` : `Published v${entry.version}: ${trimmedNote}`
            },
            session
          );
        });
      } catch (error) {
        if (error instanceof StaleWrite || isDuplicateKey(error)) throw stale();
        throw error;
      }
      return presentConfigVersion(created.toObject());
    },

    async restoreConfigVersion(tenantId, version, baseVersion, actor) {
      const tenant = await requireTenant(tenantId);
      const source = Number.isInteger(version) ? await TenantConfig.findOne({ tenantId: tenant._id, version }).lean() : null;
      if (!source) throw notFound(`Version ${version} not found`);
      return service.publishConfig(
        tenantId,
        { config: source.config, note: `Restored v${version}`, baseVersion, restoredFrom: version },
        actor
      );
    },

    /** Newest first; at most `limit` entries (500 by default). */
    async listAudit({ tenantId, limit = 500 } = {}) {
      if (tenantId !== undefined && !isObjectIdOrHexString(tenantId)) return [];
      const entries = await AuditLog.find(tenantId ? { tenantId } : {})
        .sort({ at: -1, _id: -1 })
        .limit(limit)
        .lean();
      return entries.map(presentAudit);
    }
  };

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
