import express from 'express';
import mongoose from 'mongoose';
import { authenticateJWT, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Simple stored AI quiz schema
const AiQuizSchema = new mongoose.Schema({
  topic: String,
  difficulty: String,
  count: Number,
  questions: Array,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
});
const AiQuiz = mongoose.models.AiQuiz || mongoose.model('AiQuiz', AiQuizSchema);

// POST /api/ai/generate
router.post('/generate', authenticateJWT, async (req, res) => {
  try {
    const { topic = 'General', difficulty = 'medium', count = 10 } = req.body || {};
    const questions = [];
    for (let i = 1; i <= Number(count); i++) {
      questions.push({
        id: `AI-${Date.now()}-${i}`,
        q: `${topic} — AI generated question ${i} (${difficulty})`,
        choices: ['A', 'B', 'C', 'D']
      });
    }
    const quiz = new AiQuiz({
      topic, difficulty, count: questions.length, questions, createdBy: req.user.id
    });
    await quiz.save();
    res.status(201).json({ ok: true, id: quiz._id.toString(), topic, difficulty, count: questions.length });
  } catch (err) {
    console.error(err); res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /api/ai/:id
router.get('/:id', authenticateJWT, async (req, res) => {
  try {
    const quiz = await AiQuiz.findById(req.params.id).lean();
    if (!quiz) return res.status(404).json({ ok: false, message: 'Not found' });
    res.json({ ok: true, quiz });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, message: 'Server error' }); }
});

export default router;
