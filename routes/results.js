const express = require('express');
const mongoose = require('mongoose');
const { authenticateJWT, requireRole } = require('../middleware/auth');

const router = express.Router();
const Submission = mongoose.models.Submission; // defined in routes/submissions.js

// Admin list submissions with filters and paging
router.get('/', authenticateJWT, requireRole('admin','teacher'), async (req,res) => {
  try {
    const q = {};
    if (req.query.class) q.class = req.query.class;
    if (req.query.examId) q.examId = req.query.examId;
    if (req.query.status) q.status = req.query.status;
    const page = Math.max(1, Number(req.query.page||1));
    const pageSize = Math.min(200, Number(req.query.pageSize||20));
    const total = await Submission.countDocuments(q);
    const rows = await Submission.find(q).skip((page-1)*pageSize).limit(pageSize).sort({ createdAt:-1 }).lean();
    res.json({ ok:true, total, page, pageSize, rows });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

// Update status for a submission
router.put('/:id/status', authenticateJWT, requireRole('admin','teacher'), async (req,res) => {
  try {
    const { status } = req.body;
    const s = await Submission.findByIdAndUpdate(req.params.id, { status }, { new:true });
    res.json({ ok:true, submission: s });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

module.exports = router;
