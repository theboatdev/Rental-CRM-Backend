const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema({
  plateNumber: { type: String, required: true, unique: true }, // e.g. WP CAH-4821
  make: { type: String, required: true },                      // e.g. Suzuki, Toyota
  model: { type: String, required: true },                     // e.g. Alto K10, Axio
  year: { type: Number, required: true },
  transmission: { type: String, enum: ['Automatic', 'Manual'], default: 'Automatic' },
  fuelType: { type: String, enum: ['Petrol', 'Diesel', 'Hybrid', 'Electric'], default: 'Petrol' },
  dailyRate: { type: Number, required: true },                 // LKR per day
  depositAmount: { type: Number, default: 25000 },             // Standard security deposit in LKR
  mileage: { type: Number, default: 0 },                       // Odometer reading in KM
  status: {
    type: String,
    enum: ['Available', 'Rented', 'In Service / Maintenance', 'Reserved'],
    default: 'Available'
  },
  thumbnail: { type: String },                                 // S3 image URL
  notes: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Vehicle', vehicleSchema);
