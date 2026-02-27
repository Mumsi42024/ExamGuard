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

// safe serializer (do NOT expose passwordHash or files paths you don't want leaked)
ApplicationSchema.methods.toSafeObject = function () {
  return {
    id: this._id.toString(),
    username: this.username,
    firstName: this.firstName,
    lastName: this.lastName,
    dob: this.dob,
    email: this.email,
    phone: this.phone,
    nationality: this.nationality,
    address: this.address,
    intakeTerm: this.intakeTerm,
    program: this.program,
    currentSchool: this.currentSchool,
    currentGrade: this.currentGrade,
    prevAcademics: this.prevAcademics,
    // don't include raw file paths by default - include only metadata or omit entirely
    idFiles: (this.idFiles || []).map(f => ({ filename: f.filename, originalName: f.originalName, mimeType: f.mimeType, size: f.size })),
    transcripts: (this.transcripts || []).map(f => ({ filename: f.filename, originalName: f.originalName, mimeType: f.mimeType, size: f.size })),
    languageProof: this.languageProof,
    emergencyName: this.emergencyName,
    emergencyPhone: this.emergencyPhone,
    agree: this.agree,
    status: this.status,
    sourceIp: this.sourceIp,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

module.exports = mongoose.model('Application', ApplicationSchema);
