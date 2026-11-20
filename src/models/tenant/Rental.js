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
    // Optional until assign for vehicleClass holds; required before check-in.
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle' },
    // Make/model hold when no plate is assigned yet (modules.rentals.reservationMode).
    requestedMake: { type: String, trim: true },
    requestedModel: { type: String, trim: true },
    status: { type: String, enum: RENTAL_STATUSES, default: 'RESERVED' },
    source: { type: String, enum: SOURCES, default: 'COUNTER' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    actualReturnDate: { type: Date },
    totalDays: { type: Number, required: true, min: 1 },
    dailyRate: { type: Number, required: true, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    depositAmount: { type: Number, required: true, min: 0 },
    // Amount payable to a third-party vehicle supplier. Set only when modules.vehicles.thirdPartyVehicles is on and the vehicle is THIRD_PARTY.
    supplierRentalCost: { type: Number, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 }, // sum of non-voided payments, updated in the same transaction
    depositRefunded: { type: Boolean, default: false },
    // Staff confirmed the renter had paid everything, usually at pickup. Cleared if the ledger later shows money owed.
    fullPayment: { type: new Schema({ at: { type: Date, required: true }, by: { type: actorSchema } }, { _id: false }) },
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
rentalSchema.index({ requestedMake: 1, requestedModel: 1, status: 1, startDate: 1 }); // class-hold capacity
rentalSchema.index({ renter: 1, startDate: -1 });

module.exports = rentalSchema;
