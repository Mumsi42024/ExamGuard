'use strict';

import mongoose from 'mongoose';

const AttachmentSchema = new mongoose.Schema({
  filename: String,
  originalName: String,
  mimeType: String,
  size: Number,
  path: String
}, { _id: false });

const MessageSchema = new mongoose.Schema({
  from: { type: String },
  to: { type: String },   
  text: String,
  threadId: { type: String, index: true, default: null },
  participantIds: [{ type: String }],
  attachments: { type: [AttachmentSchema], default: [] },
  read: { type: Boolean, default: false },
  meta: mongoose.Schema.Types.Mixed
}, { timestamps: true });

const Message = mongoose.models.Message || mongoose.model('Message', MessageSchema);
export default Message;
