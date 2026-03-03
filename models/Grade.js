'use strict';

import mongoose from 'mongoose';

const GradeSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course' },
  assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', default: null },
  score: Number,
  maxScore: Number,
  term: String,
  remarks: String,
  meta: mongoose.Schema.Types.Mixed
}, { timestamps: true });

const Grade = mongoose.models.Grade || mongoose.model('Grade', GradeSchema);
export default Grade;
