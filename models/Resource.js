'use strict';

import mongoose from 'mongoose';

const FileMetaSchema = new mongoose.Schema({
  filename: String,
  originalName: String,
  mimeType: String,
  size: Number,
  path: String
}, { _id: false });

const ResourceSchema = new mongoose.Schema({
  title: String,
  desc: String,
  url: String, // optional external link
  file: FileMetaSchema, // optional stored file
  tags: [String],
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }], // audience
  public: { type: Boolean, default: true },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
  meta: mongoose.Schema.Types.Mixed
}, { timestamps: true });

const Resource = mongoose.models.Resource || mongoose.model('Resource', ResourceSchema);
export default Resource;
