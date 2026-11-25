const { Schema } = require('mongoose');

const SUPPLIER_STATUSES = ['ACTIVE', 'INACTIVE'];

/**
 * A third-party vehicle supplier: the company (or person) the tenant hires
 * cars from. Linked from vehicles when ownership is THIRD_PARTY and the
 * suppliers module is on.
 */
const supplierSchema = new Schema(
  {
    profileId: { type: String, required: true }, // e.g. SUP-0004, prefix from rules.codePrefixes.supplier
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    bankName: { type: String, trim: true },
    bankAccount: { type: String, trim: true },
    bankAccountHolder: { type: String, trim: true },
    status: { type: String, enum: SUPPLIER_STATUSES, default: 'ACTIVE' },
    notes: { type: String }
  },
  { collection: 'suppliers', timestamps: true }
);

supplierSchema.index({ profileId: 1 }, { unique: true });
supplierSchema.index({ status: 1 });

module.exports = supplierSchema;
module.exports.SUPPLIER_STATUSES = SUPPLIER_STATUSES;
