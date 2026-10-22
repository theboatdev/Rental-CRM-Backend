const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  rental: { type: mongoose.Schema.Types.ObjectId, ref: 'Rental', required: true },
  renter: { type: mongoose.Schema.Types.ObjectId, ref: 'Renter', required: true },
  amount: { type: Number, required: true },          // Amount in LKR
  paymentType: {
    type: String,
    enum: ['Rental Payment', 'Security Deposit', 'Damage Charge', 'Late Fee', 'Deposit Refund'],
    default: 'Rental Payment'
  },
  paymentMethod: {
    type: String,
    enum: ['Cash (LKR)', 'Bank Transfer (Commercial / Sampath / HNB)', 'Credit/Debit Card Slip', 'Online Payment Gateway'],
    required: true
  },
  transactionReference: { type: String },            // Bank slip reference or receipt number
  receiptNumber: { type: String, required: true, unique: true }, // e.g. RCPT-2026-0091
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  paymentDate: { type: Date, default: Date.now },
  notes: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
