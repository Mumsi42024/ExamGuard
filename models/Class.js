import mongoose from 'mongoose';

const { Schema } = mongoose;

const ClassSchema = new Schema({
  name: { type: String, required: true, index: true },
  title: { type: String },
  description: { type: String },
  teacherId: { type: Schema.Types.ObjectId, ref: 'User' },
  students: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  term: { type: String },
  meta: { type: Schema.Types.Mixed }
}, { timestamps: true });

export default mongoose.models.Class || mongoose.model('Class', ClassSchema);
