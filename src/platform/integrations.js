const { isObjectIdOrHexString } = require('mongoose');
const { z } = require('zod');
const { zodIssues } = require('./config/path');
const { invalid, notFound } = require('./errors');
const { secretsNotConfigured } = require('./secrets');

/**
 * A tenant's WhatsApp Cloud API connection, which sends its digest from the
 * tenant's own business number. Super admins set it from the admin dashboard
 * (/api/platform/tenants/:id/integrations/whatsapp). It's one TenantSecret,
 * encrypted with the secret box (secrets.js). The access token never leaves
 * the backend: responses show its last 4 characters.
 */

const SECRET_NAME = 'whatsapp.connection';

const ConnectionInputSchema = z.strictObject({
  phoneNumberId: z.string().trim().regex(/^\d{5,25}$/, { error: "The phone number ID from WhatsApp Manager: digits only, not the phone number" }),
  // Leave it out to keep the current token.
  accessToken: z.string().trim().min(20).max(2000).optional(),
  // An approved template for messages outside WhatsApp's 24-hour window; without one the digest goes as plain text.
  templateName: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, { error: 'Lowercase letters, digits and underscores, as in WhatsApp Manager' }).nullable().default(null),
  templateLanguage: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, { error: 'A language code such as en or en_US' }).default('en')
});

const actorOf = (actor) => ({ id: actor.id, name: actor.name });

function createIntegrations({ platformDb, secretBox }) {
  const { Tenant, TenantSecret, AuditLog } = platformDb.models;

  async function requireTenant(tenantId) {
    const tenant = isObjectIdOrHexString(tenantId) ? await Tenant.findById(tenantId).lean() : null;
    if (!tenant) throw notFound('Tenant not found');
    return tenant;
  }

  const binding = (tenantId) => ({ tenantId: String(tenantId), name: SECRET_NAME });

  /** The stored connection, decrypted, or null. A record that no longer decrypts (another key) counts as none. */
  async function read(tenantId) {
    const stored = await TenantSecret.findOne({ tenantId, name: SECRET_NAME }).lean();
    if (!stored || !secretBox.configured) return null;
    try {
      return { stored, connection: JSON.parse(secretBox.decrypt(stored, binding(tenantId))) };
    } catch (error) {
      console.error(`[integrations] The WhatsApp connection of tenant ${tenantId} doesn't decrypt: ${error.message}`);
      return null;
    }
  }

  function present(found) {
    const base = { available: secretBox.configured };
    if (!found) return { ...base, connected: false };
    const { stored, connection } = found;
    return {
      ...base,
      connected: true,
      phoneNumberId: connection.phoneNumberId,
      templateName: connection.templateName,
      templateLanguage: connection.templateLanguage,
      mode: connection.templateName ? 'template' : 'text',
      tokenEnding: connection.accessToken.slice(-4),
      updatedAt: stored.updatedAt ? new Date(stored.updatedAt).toISOString() : null,
      updatedBy: stored.updatedBy ? actorOf(stored.updatedBy) : null
    };
  }

  const record = (tenant, actor, action, summary) => AuditLog.create({ at: new Date(), actor: actorOf(actor), action, tenantId: tenant._id, tenantName: tenant.name, summary });

  return {
    async getWhatsApp(tenantId) {
      const tenant = await requireTenant(tenantId);
      return present(await read(tenant._id));
    },

    async setWhatsApp(tenantId, input, actor) {
      const tenant = await requireTenant(tenantId);
      if (!secretBox.configured) throw secretsNotConfigured();
      const parsed = ConnectionInputSchema.safeParse(input ?? {});
      if (!parsed.success) throw invalid('Check the highlighted fields', zodIssues(parsed.error));
      const current = await read(tenant._id);
      const accessToken = parsed.data.accessToken ?? current?.connection.accessToken;
      if (!accessToken) throw invalid('Enter the access token', [{ path: 'accessToken', message: 'Required' }]);

      const connection = { ...parsed.data, accessToken };
      const encrypted = secretBox.encrypt(JSON.stringify(connection), binding(tenant._id));
      await TenantSecret.updateOne(
        { tenantId: tenant._id, name: SECRET_NAME },
        { $set: { ...encrypted, updatedBy: actorOf(actor) } },
        { upsert: true }
      );
      const how = connection.templateName ? `template ${connection.templateName} (${connection.templateLanguage})` : 'plain text';
      await record(tenant, actor, 'integration.whatsapp_updated', `${current ? 'Updated' : 'Connected'} WhatsApp: phone number ID ${connection.phoneNumberId}, digests as ${how}`);
      return present(await read(tenant._id));
    },

    async removeWhatsApp(tenantId, actor) {
      const tenant = await requireTenant(tenantId);
      const { deletedCount } = await TenantSecret.deleteOne({ tenantId: tenant._id, name: SECRET_NAME });
      if (deletedCount) await record(tenant, actor, 'integration.whatsapp_removed', 'Disconnected WhatsApp');
      return present(null);
    },

    /** The decrypted connection, for sending, or null. */
    async connectionFor(tenantId) {
      return (await read(tenantId))?.connection ?? null;
    }
  };
}

module.exports = { createIntegrations };
