import mongoose from 'mongoose';

const { Schema } = mongoose;

/*
  File sub-document schema (reused for idFiles/transcripts/attachments)
*/
const FileSchema = new Schema({
  filename: String,
  originalName: String,
  mimeType: String,
  size: Number,
  path: String,
}, { _id: false });

/*
  User schema - unified model for Students, Teachers, Admins, Staff, Parents
  - Includes application-style fields (for students) and staff/teacher specific fields
  - Uses timestamps: true to provide createdAt / updatedAt
*/
const UserSchema = new Schema({
  // Core auth/identity
  username: { type: String, required: true, index: true, unique: true },
  email: { type: String, index: true, unique: true, sparse: true },
  passwordHash: { type: String, required: true },

  // Role
  role: {
    type: String,
    enum: ['student', 'teacher', 'admin', 'staff', 'parent'],
    default: 'student'
  },

  // Common profile
  firstName: { type: String, index: true },
  lastName: { type: String, index: true },
  phone: { type: String },
  profilePic: { type: String },

  // Student / Application fields (bring over from Application model)
  dob: { type: Date },
  nationality: { type: String },
  address: { type: String },

  intakeTerm: { type: String },
  program: { type: String },       // program applied / enrolled in
  currentSchool: { type: String },
  currentGrade: { type: String },
  prevAcademics: { type: String },

  idFiles: { type: [FileSchema], default: [] },
  transcripts: { type: [FileSchema], default: [] },
  languageProof: { type: String },

  emergencyName: { type: String },
  emergencyPhone: { type: String },

  agree: { type: Boolean, default: false },

  // User status (student/application lifecycle + account state)
  status: { type: String, enum: ['draft','submitted','reviewing','accepted','rejected','active','pending','disabled'], default: 'active' },

  // Staff/teacher specific fields
  department: { type: String },
  dept: { type: String }, // alias
  title: { type: String },
  bio: { type: String },
  qualifications: { type: String },
  subjects: { type: [String], default: [] },

  // class assignment(s) - reference to Class model(s)
  classAssigned: { type: Schema.Types.ObjectId, ref: 'Class' },
  classAssignedMany: [{ type: Schema.Types.ObjectId, ref: 'Class' }],

  // Flexible profile/meta
  profile: { type: Schema.Types.Mixed, default: {} },
  meta: { type: Schema.Types.Mixed, default: {} }

}, { timestamps: true });

// Keep updatedAt in sync when saving (timestamps generally handle this,
// but keep a pre-save hook to ensure consistent behaviour if needed)
UserSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

// Return a safe object for API responses (no passwordHash)
UserSchema.methods.toSafeObject = function () {
  return {
    id: this._id.toString(),
    username: this.username,
    email: this.email,
    role: this.role,
    firstName: this.firstName,
    lastName: this.lastName,
    phone: this.phone,
    profilePic: this.profilePic,

    // Student/application fields
    dob: this.dob,
    nationality: this.nationality,
    address: this.address,
    intakeTerm: this.intakeTerm,
    program: this.program,
    currentSchool: this.currentSchool,
    currentGrade: this.currentGrade,
    prevAcademics: this.prevAcademics,
    idFiles: (this.idFiles || []).map(f => ({
      filename: f.filename,
      originalName: f.originalName,
      mimeType: f.mimeType,
      size: f.size
    })),
    transcripts: (this.transcripts || []).map(f => ({
      filename: f.filename,
      originalName: f.originalName,
      mimeType: f.mimeType,
      size: f.size
    })),
    languageProof: this.languageProof,
    emergencyName: this.emergencyName,
    emergencyPhone: this.emergencyPhone,
    agree: this.agree,
    status: this.status,

    // Staff/teacher fields
    department: this.department || this.dept,
    title: this.title,
    bio: this.bio,
    qualifications: this.qualifications,
    subjects: this.subjects || [],
    classAssigned: this.classAssigned ? (typeof this.classAssigned === 'object' ? this.classAssigned.toString() : this.classAssigned) : null,
    classAssignedMany: Array.isArray(this.classAssignedMany) ? this.classAssignedMany.map(c => String(c)) : [],

    // Flexible fields
    profile: this.profile || {},
    meta: this.meta || {},

    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

const User = mongoose.models.User || mongoose.model('User', UserSchema);

export default User;
