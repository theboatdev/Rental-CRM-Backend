const { PROVISIONING_STEPS } = require('./tenants/rules');
const { createConfigFromTemplate } = require('./config/templates');
const { clerkErrorMessage } = require('./clerk');
const { initTenantDb } = require('../db/tenantDb');

const PROVISIONER = { id: 'system', name: 'Provisioning job' };

/** A running job whose heartbeat is older than this was cut off (e.g. by a restart) and can be retried. */
const STALE_AFTER_MS = 2 * 60_000;

/** Config v1 for a new tenant: its template plus the name and limits from the create form. */
function initialConfig(tenant) {
  return createConfigFromTemplate(tenant.template, {
    branding: { displayName: tenant.name, shortName: (tenant.name.split(/\s+/)[0] || tenant.name).slice(0, 24) },
    limits: tenant.limits
  });
}

/** Steps of a new job: the tenant record is written together with the job, so that step starts done. */
const newJobSteps = (at) =>
  PROVISIONING_STEPS.map(({ key, label }) =>
    key === 'create_tenant_record' ? { key, label, status: 'done', attempts: 1, finishedAt: at } : { key, label, status: 'pending' }
  );

/**
 * Runs tenant provisioning jobs. Every step is idempotent, so a retry resumes
 * at the failed step and repeating a step that partly took effect is safe.
 */
function createProvisioner({ platformDb, getTenantDb, clerk, now = () => new Date() }) {
  const { Tenant, TenantConfig, ProvisioningJob } = platformDb.models;

  const STEPS = {
    create_tenant_record: async () => {},

    create_clerk_org: async (tenant) => {
      const clerkOrgId = await clerk.ensureOrganization({ tenantId: String(tenant._id), name: tenant.name, slug: tenant.slug });
      await Tenant.updateOne({ _id: tenant._id }, { $set: { clerkOrgId } });
    },

    init_database: (tenant) => initTenantDb(getTenantDb(tenant.dbName)),

    write_config: async (tenant) => {
      const config = initialConfig(tenant);
      await TenantConfig.updateOne(
        { tenantId: tenant._id, version: 1 },
        { $setOnInsert: { config, note: `Initial config from the ${tenant.template} template`, createdBy: PROVISIONER } },
        { upsert: true }
      );
      // Leaves the tenant alone if a super admin already published a config.
      await Tenant.updateOne(
        { _id: tenant._id, activeConfigVersion: null },
        { $set: { activeConfigVersion: 1, currency: config.locale.currency, limits: config.limits } }
      );
    },

    invite_admin: async (tenant) => {
      if (!tenant.clerkOrgId) throw new Error('The tenant has no Clerk organization yet');
      await clerk.ensureOwnerInvitation({ organizationId: tenant.clerkOrgId, emailAddress: tenant.adminEmail });
    },

    activate: (tenant) => Tenant.updateOne({ _id: tenant._id, status: 'provisioning' }, { $set: { status: 'active' } })
  };

  const stepFields = (index, fields) =>
    Object.fromEntries(Object.entries(fields).map(([field, value]) => [`steps.${index}.${field}`, value]));

  /** Runs every step that isn't done, in order, stopping at the first failure. Resolves to the finished job. */
  async function run(jobId) {
    const job = await ProvisioningJob.findById(jobId).lean();
    for (const [index, step] of job.steps.entries()) {
      if (step.status === 'done') continue;
      await ProvisioningJob.updateOne(
        { _id: jobId },
        {
          $set: { ...stepFields(index, { status: 'running' }), heartbeatAt: now() },
          $inc: stepFields(index, { attempts: 1 }),
          $unset: stepFields(index, { error: 1 })
        }
      );
      try {
        await STEPS[step.key](await Tenant.findById(job.tenantId).lean());
      } catch (error) {
        const message = clerkErrorMessage(error);
        console.error(`[provisioning] Tenant ${job.tenantId}: ${step.key} failed: ${message}`);
        const finishedAt = now();
        await ProvisioningJob.updateOne(
          { _id: jobId },
          { $set: { ...stepFields(index, { status: 'failed', error: message, finishedAt }), status: 'failed', finishedAt } }
        );
        return ProvisioningJob.findById(jobId).lean();
      }
      await ProvisioningJob.updateOne({ _id: jobId }, { $set: stepFields(index, { status: 'done', finishedAt: now() }) });
    }
    await ProvisioningJob.updateOne({ _id: jobId }, { $set: { status: 'succeeded', finishedAt: now() } });
    return ProvisioningJob.findById(jobId).lean();
  }

  /**
   * Claims a failed job, or a running one whose heartbeat stopped, for a retry.
   * Atomic, so two concurrent retries can't both run it. Null when the job can't be retried.
   */
  function claimForRetry(tenantId) {
    const at = now();
    return ProvisioningJob.findOneAndUpdate(
      { tenantId, $or: [{ status: 'failed' }, { status: 'running', heartbeatAt: { $lt: new Date(at - STALE_AFTER_MS) } }] },
      { $set: { status: 'running', heartbeatAt: at, finishedAt: null } },
      { returnDocument: 'after' }
    ).lean();
  }

  return { run, claimForRetry };
}

module.exports = { createProvisioner, newJobSteps, PROVISIONER, STALE_AFTER_MS };
