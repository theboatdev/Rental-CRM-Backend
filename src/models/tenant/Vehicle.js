const { Schema } = require('mongoose');
const { VEHICLE_STATUSES, TRANSMISSIONS, FUEL_TYPES } = require('./enums');

// Amounts are in the tenant's locale.currency, distances in locale.distanceUnit.
const vehicleSchema = new Schema(
  {
    plateNumber: { type: String, required: true, trim: true }, // e.g. WP CAH-4821
    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    year: { type: Number, required: true, min: 1950, max: 2100 },
    transmission: { type: String, enum: TRANSMISSIONS, default: 'AUTOMATIC' },
    fuelType: { type: String, enum: FUEL_TYPES, default: 'PETROL' },
    dailyRate: { type: Number, required: true, min: 0 },
    secondaryDailyRate: { type: Number, min: 0 }, // in locale.secondaryCurrency, e.g. the USD rate quoted to tourists
    depositAmount: { type: Number, required: true, min: 0 }, // defaults from rules.defaultDepositAmount when created
    mileage: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: VEHICLE_STATUSES, default: 'AVAILABLE' },
    thumbnail: { type: String },
    notes: { type: String }
  },
  { collection: 'vehicles', timestamps: true }
);

vehicleSchema.index({ plateNumber: 1 }, { unique: true });
vehicleSchema.index({ status: 1 });

module.exports = vehicleSchema;
