const mongoose = require('mongoose');

const inspectionPhotosSchema = new mongoose.Schema({
  front: { type: String },
  rear: { type: String },
  leftSide: { type: String },
  rightSide: { type: String },
  interior: { type: String },
  odometer: { type: String },
  timestamp: { type: Date, default: Date.now },
  notes: { type: String }
});

const rentalSchema = new mongoose.Schema({
  rentalCode: { type: String, required: true, unique: true }, // e.g. RNT-2026-0042
  renter: { type: mongoose.Schema.Types.ObjectId, ref: 'Renter', required: true },
  vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  actualReturnDate: { type: Date },
  dailyRate: { type: Number, required: true }, // LKR
  totalDays: { type: Number, required: true },
  totalRentalAmount: { type: Number, required: true }, // LKR
  depositAmount: { type: Number, required: true }, // LKR
  depositRefunded: { type: Boolean, default: false },
  startMileage: { type: Number, required: true },
  endMileage: { type: Number },
  pickupInspection: inspectionPhotosSchema,
  dropInspection: inspectionPhotosSchema,
  status: {
    type: String,
    enum: ['Reserved', 'Active', 'Completed', 'Cancelled', 'Overdue'],
    default: 'Active'
  },
  bookingSource: {
    type: String,
    enum: ['Manual Counter', 'Online Self-Registration'],
    default: 'Manual Counter'
  },
  paymentStatus: {
    type: String,
    enum: ['Unpaid', 'Partially Paid', 'Fully Paid'],
    default: 'Unpaid'
  },
  notes: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Rental', rentalSchema);
