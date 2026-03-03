'use strict';

import mongoose from 'mongoose';

const CourseSchema = new mongoose.Schema({
  title: String,
  code: String,
  desc: String,
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
  credits: Number,
  meta: mongoose.Schema.Types.Mixed
}, { timestamps: true });

const Course = mongoose.models.Course || mongoose.model('Course', CourseSchema);
export default Course;
