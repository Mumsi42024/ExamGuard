const express = require('express');
const mongoose = require('mongoose');
const { authenticateJWT, requireRole } = require('../middleware/auth');

const router = express.Router();

// Submission/result schema
const SubmissionSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  examId: String,
  answers: Object,
  score: Number,
  max: Number,
  status: { type: String, enum: ['draft','submitted','published','flagged','declined'], default: 'submitted' },
  createdAt: { type: Date, default: Date.now }
});
const Submission = mongoose.models.Submission || mongoose.model('Submission', SubmissionSchema);

// Student submits answers
router.post('/:examId/submit', authenticateJWT, requireRole('student'), async (req, res) => {
  try {
    const s = new Submission({
      studentId: req.user.id,
      examId: req.params.examId,
      answers: req.body.answers || {},
      score: req.body.score || 0,
      max: req.body.max || 100,
      status: 'submitted'
    });
    await s.save();
    res.status(201).json({ ok:true, submission: s });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

// Admin/teacher: list submissions with filters
router.get('/', authenticateJWT, requireRole('teacher','admin'), async (req,res) => {
  try {
    const q = {};
    if (req.query.examId) q.examId = req.query.examId;
    if (req.query.studentId) q.studentId = req.query.studentId;
    const subs = await Submission.find(q).sort({ createdAt:-1 }).limit(500).lean();
    res.json({ ok:true, submissions: subs });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

// Update submission (grade / change status)
router.put('/:id', authenticateJWT, requireRole('teacher','admin'), async (req,res) => {
  try {
    const upd = {};
    if (req.body.score !== undefined) upd.score = req.body.score;
    if (req.body.max !== undefined) upd.max = req.body.max;
    if (req.body.status) upd.status = req.body.status;
    const s = await Submission.findByIdAndUpdate(req.params.id, upd, { new:true });
    res.json({ ok:true, submission: s });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

module.exports = router;
