const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema({
  docType: {
    type: String,
    enum: [
      'National Identity Card (NIC)',
      'Sri Lanka Driving License',
      'Passport (Foreign Tourist)',
      'International Driving Permit (AA Ceylon recognized)',
      'DMT Airport Temporary Driving Permit',
      'Utility Bill / Proof of Address',
      'Other Document'
    ],
    required: true
  },
  docNumber: { type: String },
  fileUrl: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  verified: { type: Boolean, default: false }
});

const renterSchema = new mongoose.Schema({
  profileId: { type: String, required: true, unique: true }, // e.g. SR-0146
  fullName: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String },
  isTourist: { type: Boolean, default: false },
  country: { type: String, default: 'Sri Lanka' },
  address: { type: String },
  emergencyContact: {
    name: { type: String },
    phone: { type: String },
    relation: { type: String }
  },
  documents: [documentSchema],
  source: {
    type: String,
    enum: ['Counter Registration', 'Self-Registered (Online)'],
    default: 'Counter Registration'
  },
  notes: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Renter', renterSchema);
