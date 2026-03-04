import mongoose from 'mongoose';

const { Schema } = mongoose;

const AssignmentSchema = new Schema({
  title: { type: String, required: true, index: true },
  description: { type: String },
  classId: { type: Schema.Types.ObjectId, ref: 'Class' },
  dueDate: { type: Date },
  maxScore: { type: Number, default: 100 },
  attachments: [{ filename: String, url: String, mimeType: String }],
  meta: { type: Schema.Types.Mixed }
}, { timestamps: true });

export default mongoose.models.Assignment || mongoose.model('Assignment', AssignmentSchema);
