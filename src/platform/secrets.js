const crypto = require('node:crypto');
const { unavailable } = require('./errors');

/**
 * Encrypts integration credentials for `tenant_secrets` with AES-256-GCM.
 * The key is TENANT_SECRETS_KEY (32 random bytes, base64: `openssl rand
 * -base64 32`), never stored in the database. Each ciphertext is bound to its
 * tenant and secret name (the GCM additional data), so a secret copied to
 * another tenant's record doesn't decrypt.
 */

const KEY_VERSION = 1;

const secretsNotConfigured = () => unavailable('secrets_not_configured', 'Set TENANT_SECRETS_KEY on the backend to store integration credentials');

const additionalData = ({ tenantId, name }) => Buffer.from(`${tenantId}:${name}`);

function createSecretBox(key) {
  if (!key) {
    const notConfigured = () => {
      throw secretsNotConfigured();
    };
    return { configured: false, encrypt: notConfigured, decrypt: notConfigured };
  }
  const keyBytes = Buffer.from(key, 'base64');
  if (keyBytes.length !== 32) throw new Error('TENANT_SECRETS_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');

  return {
    configured: true,

    /** `{ ciphertext, iv, authTag, keyVersion }` for a TenantSecret document. */
    encrypt(plaintext, binding) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
      cipher.setAAD(additionalData(binding));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), keyVersion: KEY_VERSION };
    },

    /** Throws when the key, the binding or the stored bytes don't match. */
    decrypt({ ciphertext, iv, authTag }, binding) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, Buffer.from(iv, 'base64'));
      decipher.setAAD(additionalData(binding));
      decipher.setAuthTag(Buffer.from(authTag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
    }
  };
}

module.exports = { createSecretBox, secretsNotConfigured };
