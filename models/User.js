import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true, unique: true },
  email: { type: String, index: true, unique: true, sparse: true },
  passwordHash: { type: String, required: true },

  role: {
    type: String,
    enum: ['student', 'teacher', 'admin', 'staff', 'parent'],
    default: 'student'
  },

  firstName: String,
  lastName: String,
  phone: String,
  profilePic: String,

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

UserSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

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
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

const User = mongoose.model('User', UserSchema);

export default User;
