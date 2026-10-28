const { Schema } = require('mongoose');

/**
 * A file stored in Cloudinary: its public ID (under tenants/<tenantId>/) and
 * what a download link needs. `bytes` counts towards the tenant's storage
 * usage. See src/tenant/files.js.
 */
const fileSchema = new Schema(
  {
    publicId: { type: String, required: true },
    resourceType: { type: String, enum: ['image', 'raw'], default: 'image' },
    format: { type: String, required: true }, // e.g. jpg, pdf
    bytes: { type: Number, required: true, min: 0 },
    uploadedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

module.exports = fileSchema;
