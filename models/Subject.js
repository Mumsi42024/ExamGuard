import mongoose from 'mongoose';

const { Schema } = mongoose;

const SubjectSchema = new Schema({
  title: { type: String, required: true, index: true },
  name: { type: String },
  code: { type: String, index: true },
  desc: { type: String },
  credits: { type: Number, default: 0 },
  meta: { type: Schema.Types.Mixed }
}, { timestamps: true });

export default mongoose.models.Subject || mongoose.model('Subject', SubjectSchema);
