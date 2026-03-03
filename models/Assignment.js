'use strict';

import mongoose from 'mongoose';

const FileMetaSchema = new mongoose.Schema({
  filename: String,
  originalName: String,
  mimeType: String,
  size: Number,
  path: String
}, { _id: false });

const AssignmentSchema = new mongoose.Schema({
  title: String,
  description: String,
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
  dueDate: Date,
  postedAt: { type: Date, default: Date.now },
  assignees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }], // or usernames/ids
  attachments: { type: [FileMetaSchema], default: [] },
  points: Number,
  meta: mongoose.Schema.Types.Mixed
}, { timestamps: true });

const Assignment = mongoose.models.Assignment || mongoose.model('Assignment', AssignmentSchema);
export default Assignment;
