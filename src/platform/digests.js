const { ALL_PERMISSIONS, effectivePermissions } = require('./rbac/permissions');
const { withConfigDefaults } = require('./config/schema');
const { lastScheduledMinute } = require('./cron');
const { isConnected } = require('../db/platform');
const { createDashboard } = require('../tenant/dashboard');

/**
 * Sends tenants' WhatsApp digests: on each one's `modules.whatsappDigest.cron`
 * (in its `locale.timezone`), and by hand from the tenant app. Messages go
 * through the tenant's own WhatsApp connection (integrations.js) to the
 * config's recipients; every sending is a `digest_runs` record.
 *
 * With a template in the connection, the digest is sent as that template, so
 * it arrives outside WhatsApp's 24-hour window. Its body takes two variables:
 * {{1}} the company's display name and {{2}} the digest on one line.
 * Without one, it goes as plain text.
 */

/** A run missed while the backend was down is still sent this long after its time. */
const CATCH_UP_MINUTES = 60;
const TICK_MS = 60_000;
const TEMPLATE_PARAMETER_LIMIT = 900;

const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * The digest between its title and sign-off (the first and last lines of
 * dashboard.whatsappDigest's message) on one line, for a template variable:
 * WhatsApp refuses newlines, tabs and runs of spaces there.
 */
function oneLine(message) {
  const text = message
    .split('\n')
    .slice(1, -1)
    .map((line) => line.replace(/^•\s*/, '').trim())
    .filter(Boolean)
    .join(' · ')
    .replace(/\s+/g, ' ');
  return text.length > TEMPLATE_PARAMETER_LIMIT ? `${text.slice(0, TEMPLATE_PARAMETER_LIMIT - 1)}…` : text;
}

const presentRun = (run) => ({
  id: String(run._id),
  trigger: run.trigger,
  slot: iso(run.slot),
  status: run.status,
  mode: run.mode ?? null,
  includesFinancials: run.includesFinancials ?? false,
  results: (run.results ?? []).map(({ to, ok, error }) => ({ to, ok, error: error ?? null })),
  error: run.error ?? null,
  by: run.by ?? null,
  startedAt: iso(run.startedAt),
  finishedAt: iso(run.finishedAt)
});

function createDigests({ platformDb, getTenantDb, whatsapp, integrations, now = () => new Date() }) {
  const { Tenant, TenantConfig, DigestRun } = platformDb.models;
  const dashboard = createDashboard();

  /**
   * Builds the digest as `permissions` may see it (money lines need
   * financials:view) and sends it to each recipient, recording the run. For
   * a scheduled run, creating the record claims the slot: a second claim
   * fails on the unique index, before anything is sent.
   */
  async function send({ tenantId, models, config, trigger, slot, by, permissions }) {
    const run = await DigestRun.create({ tenantId, trigger, slot, by, startedAt: now() });
    const finish = async (update) =>
      presentRun(await DigestRun.findByIdAndUpdate(run._id, { $set: { ...update, finishedAt: now() } }, { returnDocument: 'after' }).lean());
    try {
      const digest = await dashboard.whatsappDigest({ models, config, timezone: config.locale.timezone, tenantId: String(tenantId), permissions });
      const includesFinancials = digest.includesFinancials;
      const connection = await integrations.connectionFor(tenantId);
      if (!connection) return finish({ status: 'failed', includesFinancials, error: "WhatsApp isn't connected for this workspace" });
      if (!digest.recipients.length) return finish({ status: 'failed', includesFinancials, error: 'No recipients are set' });

      const mode = connection.templateName ? 'template' : 'text';
      const message =
        mode === 'template'
          ? { template: { name: connection.templateName, language: connection.templateLanguage, parameters: [config.branding.displayName, oneLine(digest.message)] } }
          : { text: digest.message };
      const results = [];
      for (const to of digest.recipients) {
        try {
          const { messageId } = await whatsapp.send({ phoneNumberId: connection.phoneNumberId, accessToken: connection.accessToken, to, ...message });
          results.push({ to, ok: true, messageId });
        } catch (error) {
          results.push({ to, ok: false, error: error.message });
        }
      }
      const sent = results.filter((result) => result.ok).length;
      return finish({ status: sent === results.length ? 'sent' : sent ? 'partial' : 'failed', mode, includesFinancials, results });
    } catch (error) {
      console.error(`[digests] Tenant ${tenantId}: ${error.message}`);
      return finish({ status: 'failed', error: error.message });
    }
  }

  /**
   * One scheduler tick: sends every digest that's due, i.e. whose cron fired
   * in the last CATCH_UP_MINUTES without a run yet. Scheduled digests are for
   * management, so they include the money lines.
   */
  async function runDue() {
    if (!isConnected(platformDb)) return [];
    const at = now();
    const tenants = await Tenant.find({ status: 'active', activeConfigVersion: { $ne: null } }).lean();
    const runs = [];
    for (const tenant of tenants) {
      try {
        const active = await TenantConfig.findOne({ tenantId: tenant._id, version: tenant.activeConfigVersion }).lean();
        const config = active && withConfigDefaults(active.config);
        const settings = config?.modules.whatsappDigest;
        if (!settings?.enabled || settings.recipients.length === 0) continue;
        const slot = lastScheduledMinute(settings.cron, config.locale.timezone, at, CATCH_UP_MINUTES);
        if (!slot || (await DigestRun.exists({ tenantId: tenant._id, trigger: 'schedule', slot }))) continue;
        const permissions = new Set(effectivePermissions(ALL_PERMISSIONS, config));
        runs.push(await send({ tenantId: tenant._id, models: getTenantDb(tenant.dbName).models, config, trigger: 'schedule', slot, permissions }));
      } catch (error) {
        if (error?.code === 11000) continue; // another instance claimed the slot first
        console.error(`[digests] ${tenant.name}: ${error.message}`);
      }
    }
    return runs;
  }

  return {
    runDue,

    /** POST /whatsapp/digest/send: the digest now, as the caller sees it. */
    sendNow(ctx) {
      return send({ tenantId: ctx.tenantId, models: ctx.models, config: ctx.config, trigger: 'manual', by: ctx.actor, permissions: ctx.permissions });
    },

    /** Whether the tenant can send, and how, with its latest runs, newest first. */
    async deliveryOf(tenantId) {
      const [connection, runs] = await Promise.all([
        integrations.connectionFor(tenantId),
        DigestRun.find({ tenantId }).sort({ startedAt: -1 }).limit(5).lean()
      ]);
      return { connected: Boolean(connection), mode: connection ? (connection.templateName ? 'template' : 'text') : null, runs: runs.map(presentRun) };
    },

    /** Runs `runDue` every minute in the background. Returns a function that stops it. */
    start({ intervalMs = TICK_MS } = {}) {
      const tick = () => runDue().catch((error) => console.error(`[digests] ${error.message}`));
      const timer = setInterval(tick, intervalMs);
      const first = setTimeout(tick, 5_000);
      timer.unref();
      first.unref();
      return () => {
        clearInterval(timer);
        clearTimeout(first);
      };
    }
  };
}

module.exports = { createDigests, oneLine };
