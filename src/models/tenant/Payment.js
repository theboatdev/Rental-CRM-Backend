const { Schema } = require('mongoose');
const actorSchema = require('../actor');
const { PAYMENT_TYPES } = require('./enums');

const paymentSchema = new Schema(
  {
    receiptNumber: { type: String, required: true }, // RCPT-2026-0091, or ADV-… for advances
    rental: { type: Schema.Types.ObjectId, ref: 'Rental', required: true },
    renter: { type: Schema.Types.ObjectId, ref: 'Renter', required: true },
    type: { type: String, enum: PAYMENT_TYPES, required: true },
    method: { type: String, required: true }, // lists.paymentMethods key, e.g. BANK_TRANSFER
    amount: { type: Number, required: true, min: 0 },
    transactionReference: { type: String },
    paidAt: { type: Date, default: Date.now },
    receivedBy: { type: actorSchema },
    // Ledger entries are voided, never deleted.
    voidedAt: { type: Date },
    voidedBy: { type: actorSchema },
    voidReason: { type: String },
    notes: { type: String }
  },
  { collection: 'payments', timestamps: true }
);

paymentSchema.index({ receiptNumber: 1 }, { unique: true });
paymentSchema.index({ rental: 1 });
paymentSchema.index({ paidAt: -1 });

module.exports = paymentSchema;
