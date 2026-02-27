import express from 'express';
import mongoose from 'mongoose';
import { authenticateJWT, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Invoice schema
const InvoiceSchema = new mongoose.Schema({
  ref: { type: String, index: true, unique: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  desc: String,
  due: Date,
  amount: Number,
  paid: { type: Number, default: 0 },
  currency: { type: String, default: 'NGN' },
  status: { type: String, enum: ['unpaid','partial','paid'], default: 'unpaid' },
  trace: String,
  createdAt: { type: Date, default: Date.now }
});
const Invoice = mongoose.models.Invoice || mongoose.model('Invoice', InvoiceSchema);

// Create invoice (admin/staff)
router.post('/', authenticateJWT, requireRole('admin','staff'), async (req, res) => {
  try {
    const body = req.body || {};
    const ref = body.ref || `INV-${Date.now()}`;
    const inv = new Invoice({
      ref,
      studentId: body.studentId,
      desc: body.desc,
      due: body.due ? new Date(body.due) : undefined,
      amount: Number(body.amount),
      currency: body.currency || 'NGN'
    });
    await inv.save();
    res.status(201).json({ ok: true, invoice: inv });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// List invoices - student sees own, admin sees all
router.get('/', authenticateJWT, async (req, res) => {
  try {
    const q = {};
    if (req.user.role === 'student') q.studentId = req.user.id;
    if (req.query.status) q.status = req.query.status;
    const invoices = await Invoice.find(q).sort({ due: 1 }).lean();
    res.json({ ok: true, invoices });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// Simulate payment (would integrate with gateway)
router.post('/:id/pay', authenticateJWT, async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return res.status(404).json({ ok: false, message: 'Not found' });
    const amount = Number(req.body.amount || 0);
    inv.paid = Math.min(inv.amount, inv.paid + amount);
    inv.status = inv.paid >= inv.amount ? 'paid' : (inv.paid > 0 ? 'partial' : 'unpaid');
    inv.trace = inv.trace || `TRC-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
    await inv.save();
    res.json({ ok: true, invoice: inv });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

export default router;
