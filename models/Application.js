const mongoose = require('mongoose');

const FileSchema = new mongoose.Schema({
  filename: String,
  originalName: String,
  mimeType: String,
  size: Number,
  path: String,
}, { _id: false });

const ApplicationSchema = new mongoose.Schema({
  // Account / applicant basics
  applicantType: { type: String, enum: ['national', 'international'], default: 'national' },
  username: { type: String, required: true, index: true, unique: true },
  passwordHash: { type: String, required: true },

  // Personal details
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  dob: { type: Date },
  email: { type: String, required: true, index: true },
  phone: { type: String },
  nationality: { type: String },
  address: { type: String },

  // Program / academics
  intakeTerm: { type: String },
  program: { type: String },
  currentSchool: { type: String },
  currentGrade: { type: String },
  prevAcademics: { type: String },

  // Documents
  idFiles: [FileSchema],
  transcripts: [FileSchema],
  languageProof: { type: String },

  // Emergency
  emergencyName: { type: String },
  emergencyPhone: { type: String },

  // meta
  agree: { type: Boolean, default: false },
  status: { type: String, enum: ['draft', 'submitted', 'reviewing', 'accepted', 'rejected'], default: 'draft' },

  // optional server trace
  sourceIp: { type: String },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// update updatedAt
ApplicationSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Application', ApplicationSchema);
