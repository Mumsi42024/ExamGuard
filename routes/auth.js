import express from 'express';
import mongoose from 'mongoose';
import { authenticateJWT, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Minimal Exam schema (register only once)
const ExamSchema = new mongoose.Schema({
  title: String,
  subject: String,
  classId: String,
  date: Date,
  start: String,
  durationMinutes: Number,
  totalMarks: Number,
  venue: String,
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['scheduled','published','archived'], default: 'scheduled' },
  createdAt: { type: Date, default: Date.now }
});
const Exam = mongoose.models.Exam || mongoose.model('Exam', ExamSchema);

// List exams (public-ish)
router.get('/', async (req, res) => {
  try {
    const q = {};
    if (req.query.class) q.classId = req.query.class;
    if (req.query.subject) q.subject = req.query.subject;
    if (req.query.from) q.date = { $gte: new Date(req.query.from) };
    const exams = await Exam.find(q).sort({ date: 1 }).limit(200).lean();
    res.json({ ok: true, exams });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, message:'Server error' });
  }
});

// Get exam by id
router.get('/:id', async (req,res) => {
  try {
    const exam = await Exam.findById(req.params.id).lean();
    if (!exam) return res.status(404).json({ ok:false, message:'Not found' });
    res.json({ ok:true, exam });
  } catch (err) {
    console.error(err); res.status(500).json({ ok:false, message:'Server error' });
  }
});

// Create exam - teachers & admins only
router.post('/', authenticateJWT, requireRole('teacher','admin'), async (req,res) => {
  try {
    const payload = req.body || {};
    const exam = new Exam({
      title: payload.title,
      subject: payload.subject,
      classId: payload.classId,
      date: payload.date ? new Date(payload.date) : undefined,
      start: payload.start,
      durationMinutes: payload.durationMinutes || 60,
      totalMarks: payload.totalMarks || 100,
      venue: payload.venue,
      creator: req.user.id,
      status: payload.status || 'scheduled'
    });
    await exam.save();
    res.status(201).json({ ok:true, exam });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

// Update exam (teacher/admin)
router.put('/:id', authenticateJWT, requireRole('teacher','admin'), async (req,res) => {
  try {
    const exam = await Exam.findByIdAndUpdate(req.params.id, req.body, { new:true });
    if (!exam) return res.status(404).json({ ok:false, message:'Not found' });
    res.json({ ok:true, exam });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

// Delete (soft)
router.delete('/:id', authenticateJWT, requireRole('admin'), async (req,res) => {
  try {
    const exam = await Exam.findByIdAndUpdate(req.params.id, { status:'archived' }, { new:true });
    res.json({ ok:true, exam });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

export default router;
