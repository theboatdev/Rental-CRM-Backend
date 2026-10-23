const { Schema } = require('mongoose');
const actorSchema = require('../actor');

const fuelLogSchema = new Schema(
  {
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    filledAt: { type: Date, default: Date.now },
    liters: { type: Number, required: true, min: 0 },
    pricePerLiter: { type: Number, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
    station: { type: String },
    odometer: { type: Number },
    createdBy: { type: actorSchema },
    notes: { type: String }
  },
  { collection: 'fuel_logs', timestamps: true }
);

fuelLogSchema.index({ vehicle: 1, filledAt: -1 });

module.exports = fuelLogSchema;
