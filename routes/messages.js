import express from 'express';
import mongoose from 'mongoose';
import { authenticateJWT, requireRole } from '../middleware/auth.js';

const router = express.Router();

const MessageSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  to: { type: String }, // could be classId or userId
  subject: String,
  body: String,
  createdAt: { type: Date, default: Date.now },
  readBy: [String]
});
const Message = mongoose.models.Message || mongoose.model('Message', MessageSchema);

// send message (teacher/admin)
router.post('/', authenticateJWT, requireRole('teacher','admin','staff'), async (req, res) => {
  try {
    const m = new Message({
      from: req.user.id,
      to: req.body.to,
      subject: req.body.subject,
      body: req.body.body
    });
    await m.save();
    res.status(201).json({ ok: true, message: m });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// list messages for user (inbox)
router.get('/', authenticateJWT, async (req, res) => {
  try {
    // basic rule: messages where to equals user's id or to matches 'class:<classId>'
    const q = { $or: [ { to: req.user.id }, { to: { $regex: `^class:` } } ] };
    const msgs = await Message.find(q).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ ok: true, messages: msgs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

export default router;
