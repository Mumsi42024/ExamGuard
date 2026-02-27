const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticateJWT, requireRole } = require('../middleware/auth');

const router = express.Router();

const UPLOAD_BASE = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads', 'assignments');
fs.mkdirSync(UPLOAD_BASE, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_BASE),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g,'_')}`)
});
const upload = multer({ storage, limits: { fileSize: 20*1024*1024 } });

const AssignmentSchema = new mongoose.Schema({
  title: String,
  classId: String,
  description: String,
  due: Date,
  attachments: Array,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
});
const Assignment = mongoose.models.Assignment || mongoose.model('Assignment', AssignmentSchema);

const SubmissionSchema = new mongoose.Schema({
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  files: Array,
  text: String,
  createdAt: { type: Date, default: Date.now },
  graded: Boolean,
  grade: Number
});
const AssignmentSubmission = mongoose.models.AssignmentSubmission || mongoose.model('AssignmentSubmission', SubmissionSchema);

// create assignment (teacher)
router.post('/', authenticateJWT, requireRole('teacher','admin'), upload.array('attachments', 6), async (req,res) => {
  try {
    const files = (req.files || []).map(f => ({ path:`/uploads/assignments/${path.basename(f.path)}`, originalName: f.originalname }));
    const a = new Assignment({
      title: req.body.title,
      classId: req.body.classId,
      description: req.body.description,
      due: req.body.due ? new Date(req.body.due) : undefined,
      attachments: files,
      createdBy: req.user.id
    });
    await a.save();
    res.status(201).json({ ok:true, assignment: a });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

// list assignments (students see class assignments)
router.get('/', authenticateJWT, async (req,res) => {
  try {
    const q = {};
    if (req.query.classId) q.classId = req.query.classId;
    const list = await Assignment.find(q).sort({ due: 1 }).lean();
    res.json({ ok:true, assignments: list });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

// submit assignment (student)
router.post('/:id/submit', authenticateJWT, requireRole('student'), upload.array('files', 6), async (req,res) => {
  try {
    const files = (req.files || []).map(f => ({ path:`/uploads/assignments/${path.basename(f.path)}`, originalName: f.originalname }));
    const sub = new AssignmentSubmission({
      assignmentId: req.params.id,
      studentId: req.user.id,
      files,
      text: req.body.text
    });
    await sub.save();
    res.status(201).json({ ok:true, submission: sub });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

module.exports = router;
