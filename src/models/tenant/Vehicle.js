const { Schema } = require('mongoose');
const fileSchema = require('./file');
const { VEHICLE_STATUSES, TRANSMISSIONS, FUEL_TYPES } = require('./enums');

// Amounts are in the tenant's locale.currency, distances in locale.distanceUnit.
const vehicleSchema = new Schema(
  {
    plateNumber: { type: String, required: true, trim: true }, // e.g. WP CAH-4821
    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    year: { type: Number, min: 1950, max: 2100 }, // required unless the config turns it off (fields.vehicles)
    transmission: { type: String, enum: TRANSMISSIONS, default: 'AUTOMATIC' },
    fuelType: { type: String, enum: FUEL_TYPES, default: 'PETROL' },
    dailyRate: { type: Number, required: true, min: 0 },
    secondaryDailyRate: { type: Number, min: 0 }, // in locale.secondaryCurrency, e.g. the USD rate quoted to tourists
    depositAmount: { type: Number, required: true, min: 0 }, // defaults from rules.defaultDepositAmount when created
    mileage: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: VEHICLE_STATUSES, default: 'AVAILABLE' },
    thumbnail: { type: String }, // the photo's public URL; older vehicles may have one typed in, without a `photo`
    photo: { type: fileSchema }, // the uploaded photo, public in Cloudinary under tenants/<tenantId>/vehicles/
    notes: { type: String },
    customFields: { type: Schema.Types.Mixed } // values of the config's customFields, by field key
  },
  { collection: 'vehicles', timestamps: true }
);

vehicleSchema.index({ plateNumber: 1 }, { unique: true });
vehicleSchema.index({ status: 1 });

module.exports = vehicleSchema;
