const mongoose = require('mongoose');

const vehicleCostSchema = new mongoose.Schema({
  vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true },
  category: {
    type: String,
    enum: [
      'Routine Maintenance / Service',
      'Mechanical Repair',
      'Tire Replacement',
      'Comprehensive Insurance Premium',
      'Revenue License & Fitness Test',
      'Fuel & Lubricants',
      'Accident Repair / Bodywork',
      'Other'
    ],
    required: true
  },
  title: { type: String, required: true },           // e.g. "50,000 KM Engine Oil & Filter Change"
  amount: { type: Number, required: true },          // Amount in LKR
  serviceCenter: { type: String },                   // e.g. "Toyota Lanka Wattala" / "Auto Care Moratuwa"
  invoiceNumber: { type: String },                   // e.g. "INV-92841"
  billFileUrl: { type: String },                     // S3 PDF / Image bill upload
  expenseDate: { type: Date, default: Date.now },
  odometerReading: { type: Number },
  notes: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('VehicleCost', vehicleCostSchema);
