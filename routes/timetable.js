const express = require('express');
const mongoose = require('mongoose');
const { authenticateJWT, requireRole } = require('../middleware/auth');

const router = express.Router();

const TimetableSchema = new mongoose.Schema({
  classId: String,
  entries: [
    {
      day: String,
      time: String,
      subject: String,
      teacher: String,
      room: String
    }
  ],
  updatedAt: { type: Date, default: Date.now }
});
const Timetable = mongoose.models.Timetable || mongoose.model('Timetable', TimetableSchema);

// get timetable by class
router.get('/', authenticateJWT, async (req,res) => {
  try {
    const classId = req.query.class || (req.user && req.user.class);
    if (!classId) return res.status(400).json({ ok:false, message:'class query required' });
    const tt = await Timetable.findOne({ classId }).lean();
    res.json({ ok:true, timetable: tt ? tt.entries : [] });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

// create/update timetable (teacher/admin)
router.post('/', authenticateJWT, requireRole('teacher','admin'), async (req,res) => {
  try {
    const { classId, entries } = req.body;
    if (!classId) return res.status(400).json({ ok:false, message:'classId required' });
    const updated = await Timetable.findOneAndUpdate({ classId }, { entries, updatedAt: new Date() }, { upsert:true, new:true });
    res.json({ ok:true, timetable: updated });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

module.exports = router;
