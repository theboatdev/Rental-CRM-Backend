/**
 * Stands in for the Cloudinary gateway (src/platform/storage.js), so tests
 * never call Cloudinary. Signatures are real hashes with a test secret:
 *
 * - `upload(fields)` plays Cloudinary's part in a signed upload. It checks the
 *   signature, stores the file and returns the response, in the shape the
 *   apps send back with a record (`publicId`, `version`, `signature`, …).
 * - `verifyUpload` accepts only signatures `upload` made.
 * - `assets`, `deleted` and `deletedPrefixes` show what's stored and what was removed.
 */
const crypto = require('node:crypto');

const SECRET = 'fake-cloudinary-secret';
const sign = (params) =>
  crypto
    .createHash('sha1')
    .update(`${Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&')}${SECRET}`)
    .digest('hex');

function createFakeStorage() {
  const assets = new Map(); // publicId → { type, format, bytes }
  const deleted = [];
  const deletedPrefixes = [];
  let nextVersion = 1_760_000_000;

  return {
    configured: true,
    assets,
    deleted,
    deletedPrefixes,

    signUpload({ publicId, type, allowedFormats, format, transformation }) {
      const params = {
        public_id: publicId,
        type,
        allowed_formats: allowedFormats.join(','),
        timestamp: Math.floor(Date.now() / 1000),
        ...(format ? { format } : {}),
        ...(transformation ? { transformation } : {})
      };
      return { uploadUrl: 'https://api.cloudinary.test/v1_1/fake/image/upload', fields: { ...params, api_key: 'fake-key', signature: sign(params) } };
    },

    upload(fields, { format = 'jpg', bytes = 2_000_000 } = {}) {
      const { api_key: apiKey, signature, ...params } = fields;
      if (sign(params) !== signature) throw new Error('Invalid signature (fake Cloudinary)');
      const version = nextVersion++;
      const stored = { type: params.type, format: params.format ?? format, bytes };
      assets.set(params.public_id, stored);
      return { publicId: params.public_id, version, signature: sign({ public_id: params.public_id, version }), format: stored.format, bytes, resourceType: 'image' };
    },

    verifyUpload({ publicId, version, signature }) {
      return signature === sign({ public_id: publicId, version });
    },

    downloadUrl({ publicId, format }) {
      return `https://api.cloudinary.test/v1_1/fake/image/download?public_id=${encodeURIComponent(publicId)}&format=${format}&expires_at=${Math.floor(Date.now() / 1000) + 600}`;
    },

    publicUrl({ publicId, format }) {
      return `https://res.cloudinary.test/fake/image/upload/${publicId}.${format}`;
    },

    async deleteAsset({ publicId }) {
      assets.delete(publicId);
      deleted.push(publicId);
    },

    async deletePrefix(prefix) {
      for (const publicId of [...assets.keys()]) if (publicId.startsWith(prefix)) assets.delete(publicId);
      deletedPrefixes.push(prefix);
    }
  };
}

module.exports = { createFakeStorage };
