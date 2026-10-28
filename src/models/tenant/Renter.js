const { Schema } = require('mongoose');
const actorSchema = require('../actor');
const fileSchema = require('./file');
const { SOURCES } = require('./enums');
const { RESIDENT_TYPES } = require('../../platform/config/schema');

const renterDocumentSchema = new Schema({
  type: { type: String, required: true }, // lists.documentTypes key, e.g. NIC
  number: { type: String, trim: true },
  file: { type: fileSchema }, // the scan, in Cloudinary under tenants/<tenantId>/documents/
  verified: { type: Boolean, default: false },
  verifiedBy: { type: actorSchema },
  verifiedAt: { type: Date },
  uploadedAt: { type: Date, default: Date.now }
});

const renterSchema = new Schema(
  {
    profileId: { type: String, required: true }, // e.g. SR-0146, prefix from rules.codePrefixes.renter
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    residentType: { type: String, enum: RESIDENT_TYPES, default: 'local' },
    country: { type: String },
    address: { type: String },
    emergencyContact: {
      name: { type: String },
      phone: { type: String },
      relation: { type: String }
    },
    documents: [renterDocumentSchema],
    source: { type: String, enum: SOURCES, default: 'COUNTER' },
    notes: { type: String },
    customFields: { type: Schema.Types.Mixed } // values of the config's customFields, by field key
  },
  { collection: 'renters', timestamps: true }
);

renterSchema.index({ profileId: 1 }, { unique: true });
renterSchema.index({ phone: 1 });

module.exports = renterSchema;
