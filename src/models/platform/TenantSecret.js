const { Schema } = require('mongoose');
const actorSchema = require('../actor');

/**
 * An integration credential, e.g. the tenant's WhatsApp Cloud API token,
 * encrypted with AES-256-GCM. The key lives in the backend's environment,
 * never in the database, and secrets are never part of the config or any API response.
 */
const tenantSecretSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true }, // e.g. "whatsapp.accessToken"
    ciphertext: { type: String, required: true }, // base64
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    keyVersion: { type: Number, default: 1 }, // which encryption key, so keys can be rotated
    updatedBy: { type: actorSchema }
  },
  { collection: 'tenant_secrets', timestamps: true }
);

tenantSecretSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = tenantSecretSchema;
