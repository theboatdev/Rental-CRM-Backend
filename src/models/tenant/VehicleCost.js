const { Schema } = require('mongoose');
const actorSchema = require('../actor');

const vehicleCostSchema = new Schema(
  {
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    category: { type: String, required: true }, // lists.costCategories key, e.g. ROUTINE_MAINTENANCE
    title: { type: String, required: true, trim: true }, // e.g. "50,000 KM engine oil & filter change"
    amount: { type: Number, required: true, min: 0 },
    incurredAt: { type: Date, default: Date.now },
    serviceCenter: { type: String },
    invoiceNumber: { type: String },
    billFileKey: { type: String }, // S3 object key; required when modules.costs.requireBillUpload
    odometer: { type: Number },
    createdBy: { type: actorSchema },
    notes: { type: String }
  },
  { collection: 'costs', timestamps: true }
);

vehicleCostSchema.index({ vehicle: 1, incurredAt: -1 });
vehicleCostSchema.index({ incurredAt: -1 });

module.exports = vehicleCostSchema;
