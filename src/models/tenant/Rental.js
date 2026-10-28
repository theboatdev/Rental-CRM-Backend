const { Schema } = require('mongoose');
const actorSchema = require('../actor');
const fileSchema = require('./file');
const { RENTAL_STATUSES, SOURCES } = require('./enums');

const inspectionSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: actorSchema },
    odometer: { type: Number },
    // The checked entries of modules.rentals.inspectionPoints, each with its photo when one was taken.
    photos: [new Schema({ point: { type: String, required: true }, file: { type: fileSchema } }, { _id: false })],
    notes: { type: String }
  },
  { _id: false }
);

const rentalSchema = new Schema(
  {
    code: { type: String, required: true }, // RNT-2026-0042, or BK-… while reserved; prefixes from rules.codePrefixes
    bookingCode: { type: String }, // the BK-… code a checked-in reservation had
    renter: { type: Schema.Types.ObjectId, ref: 'Renter', required: true },
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    status: { type: String, enum: RENTAL_STATUSES, default: 'RESERVED' },
    source: { type: String, enum: SOURCES, default: 'COUNTER' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    actualReturnDate: { type: Date },
    totalDays: { type: Number, required: true, min: 1 },
    dailyRate: { type: Number, required: true, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    depositAmount: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 }, // sum of non-voided payments, updated in the same transaction
    depositRefunded: { type: Boolean, default: false },
    startMileage: { type: Number },
    endMileage: { type: Number },
    pickupInspection: { type: inspectionSchema },
    dropInspection: { type: inspectionSchema },
    cancelledAt: { type: Date },
    createdBy: { type: actorSchema },
    notes: { type: String },
    customFields: { type: Schema.Types.Mixed } // values of the config's customFields, by field key
  },
  { collection: 'rentals', timestamps: true }
);

rentalSchema.index({ code: 1 }, { unique: true });
rentalSchema.index({ vehicle: 1, status: 1, startDate: 1 }); // availability checks
rentalSchema.index({ renter: 1, startDate: -1 });

module.exports = rentalSchema;
