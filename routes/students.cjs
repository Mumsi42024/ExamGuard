const express = require('express');
const mongoose = require('mongoose');
const { authenticateJWT } = require('../middleware/auth');

const router = express.Router();

// This endpoint aggregates student-specific data for dashboard pages
// (profile, upcoming exams, assignments, invoices, AI quizzes)
router.get('/me', authenticateJWT, async (req, res) => {
  try {
    const user = req.user;
    // minimal aggregated data - attempt to fetch relevant collections if they exist
    const Exam = mongoose.models.Exam;
    const Assignment = mongoose.models.Assignment;
    const Invoice = mongoose.models.Invoice;
    const AiQuiz = mongoose.models.AiQuiz;

    const promises = [];
    if (Exam) promises.push(Exam.find({ classId: user.class }).sort({ date: 1 }).limit(10).lean());
    else promises.push(Promise.resolve([]));
    if (Assignment) promises.push(Assignment.find({ classId: user.class }).sort({ due:1 }).limit(10).lean());
    else promises.push(Promise.resolve([]));
    if (Invoice) promises.push(Invoice.find({ studentId: user.id }).sort({ due:1 }).limit(10).lean());
    else promises.push(Promise.resolve([]));
    if (AiQuiz) promises.push(AiQuiz.find({ createdBy: user.id }).sort({ createdAt:-1 }).limit(10).lean());
    else promises.push(Promise.resolve([]));

    const [exams, assignments, invoices, aiquizzes] = await Promise.all(promises);

    res.json({
      ok: true,
      profile: user,
      exams,
      assignments,
      invoices,
      aiquizzes
    });
  } catch (err) { console.error(err); res.status(500).json({ ok:false, message:'Server error' }); }
});

module.exports = router;
