'use strict';

import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

// Helper: reuse existing models if present, otherwise define simple ones
const InvoiceSchema = new mongoose.Schema({
  ref: { type: String, index: true },
  studentId: { type: String, index: true }, // string to be flexible (could be ObjectId or a business id)
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
  desc: String,
  amount: { type: Number, default: 0 },
  paid: { type: Number, default: 0 },
  items: { type: Array, default: [] },
  due: { type: Date, default: null },
  status: { type: String, enum: ['unpaid','partial','paid'], default: 'unpaid' },
  trace: String,
  currency: { type: String, default: 'NGN' },
}, { timestamps: true });

const StudentSchema = new mongoose.Schema({
  username: String,
  firstName: String,
  lastName: String,
  program: String,
  profilePic: String,
  session: String,
  email: String,
}, { timestamps: true });

const Invoice = mongoose.models.Invoice || mongoose.model('Invoice', InvoiceSchema);
const Student = mongoose.models.Student || mongoose.model('Student', StudentSchema);

// Small helper to normalize invoice shape similar to frontend expectations
function normalizeInvoice(doc) {
  if (!doc) return null;
  const inv = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    _id: inv._id && String(inv._id),
    id: inv._id && String(inv._id),
    ref: inv.ref || String(inv._id || ''),
    desc: inv.desc || '',
    amount: Number(inv.amount || 0),
    paid: Number(inv.paid || 0),
    items: inv.items || [],
    due: inv.due ? new Date(inv.due).toISOString() : null,
    status: inv.status || ( (inv.paid || 0) >= (inv.amount || 0) ? 'paid' : ((inv.paid || 0) > 0 ? 'partial' : 'unpaid') ),
    trace: inv.trace || '',
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt
  };
}

// Auth middleware (optional): if Authorization header exists, populate req.user
async function optionalAuth(req, res, next) {
  const auth = req.get('Authorization') || req.get('authorization');
  if (!auth) return next();
  const parts = String(auth).split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return next();
  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
  } catch (err) {
    // do not fail hard; treat as unauthenticated
    console.warn('JWT verify failed:', err && err.message);
  }
  return next();
}

// Require auth middleware for endpoints that need it
function requireAuth(req, res, next) {
  if (req.user && (req.user.id || req.user._id || req.user.sub)) return next();
  return res.status(401).json({ ok: false, message: 'Authentication required' });
}

// Utility to find invoice by id or ref
async function findInvoiceByIdOrRef(idOrRef) {
  if (!idOrRef) return null;
  // try direct _id
  if (mongoose.Types.ObjectId.isValid(idOrRef)) {
    const found = await Invoice.findById(idOrRef);
    if (found) return found;
  }
  // try ref field
  let found = await Invoice.findOne({ ref: idOrRef });
  if (found) return found;
  // try student-facing id fields
  found = await Invoice.findOne({ _id: idOrRef });
  return found;
}

// GET /api/invoices
// Supports queries: studentId=, student=, mine=true
router.get('/', optionalAuth, async (req, res) => {
  try {
    const q = {};
    // Query parameters
    const { studentId, student, mine, limit, offset } = req.query;

    if (studentId) q.studentId = studentId;
    if (student) q.studentId = student; // alias

    if (String(mine) === 'true' && req.user) {
      // Common JWT payload fields used as identifier: id, _id, sub, username
      const id = req.user.id || req.user._id || req.user.sub || req.user.username;
      if (id) q.studentId = String(id);
    }

    // Support text search on ref or desc via q.search (not required but helpful)
    if (req.query.search) {
      const re = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [{ ref: re }, { desc: re }];
    }

    const l = Math.min(100, parseInt(limit || '100', 10) || 100);
    const o = Math.max(0, parseInt(offset || '0', 10) || 0);

    const docs = await Invoice.find(q)
      .sort({ due: 1, createdAt: -1 })
      .skip(o)
      .limit(l)
      .lean()
      .exec();

    // Return a shape the frontend expects: try to include several possible keys
    return res.json({ ok: true, invoices: docs.map(normalizeInvoice) });
  } catch (err) {
    console.error('GET /invoices error', err);
    return res.status(500).json({ ok: false, message: 'Failed to list invoices' });
  }
});

// GET /api/invoices/:id
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const inv = await findInvoiceByIdOrRef(id);
    if (!inv) return res.status(404).json({ ok: false, message: 'Invoice not found' });
    return res.json({ ok: true, invoice: normalizeInvoice(inv) });
  } catch (err) {
    console.error('GET /invoices/:id error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch invoice' });
  }
});

// POST /api/invoices/:id/pay
// Body: { amount: number }
// If authenticated and backend integrated, you would verify payment provider and receipt; here we update paid and add trace.
router.post('/:id/pay', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body || {};
    const numericAmount = Number(amount || 0);

    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ ok: false, message: 'Invalid amount' });
    }

    const inv = await findInvoiceByIdOrRef(id);
    if (!inv) return res.status(404).json({ ok: false, message: 'Invoice not found' });

    const remaining = Math.max(0, (inv.amount || 0) - (inv.paid || 0));
    const applied = Math.min(remaining, numericAmount);

    // update paid
    inv.paid = (inv.paid || 0) + applied;
    if ((inv.paid || 0) >= (inv.amount || 0)) {
      inv.status = 'paid';
      inv.paid = inv.amount;
    } else if ((inv.paid || 0) > 0) {
      inv.status = 'partial';
    } else {
      inv.status = 'unpaid';
    }

    // attach payment trace
    const traceId = 'TRC-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    inv.trace = traceId;

    await inv.save();

    // shape response as the frontend expects
    return res.json({ ok: true, invoice: normalizeInvoice(inv), trace: traceId });
  } catch (err) {
    console.error('POST /invoices/:id/pay error', err);
    return res.status(500).json({ ok: false, message: 'Payment processing failed' });
  }
});

// GET /api/students/me
// Returns aggregated profile and invoices (frontend will accept invoices[] returned as nested property)
router.get('/../students/me', (req, res) => {
  // This route path is intentionally not used - keep for clarity
  return res.status(404).json({ ok: false, message: 'Not found' });
});


router.get('/students/me', optionalAuth, requireAuth, async (req, res) => {
  try {
    // Identify student id from token
    const id = req.user.id || req.user._id || req.user.sub || req.user.username;
    if (!id) return res.status(401).json({ ok: false, message: 'Unauthenticated' });

    // Try to find student by multiple possible keys
    let student = await Student.findOne({ _id: id }).lean().exec();
    if (!student) student = await Student.findOne({ username: id }).lean().exec();
    if (!student) {
      // Not found in students collection — return minimal profile from token payload
      const profile = {
        id,
        username: req.user.username || null,
        firstName: req.user.firstName || req.user.given_name || null,
        lastName: req.user.lastName || req.user.family_name || null,
        email: req.user.email || null,
      };
      // Also fetch invoices if any by studentId equal to id
      const invoices = await Invoice.find({ studentId: String(id) }).sort({ due: 1 }).lean().exec();
      return res.json({ ok: true, profile, invoices: invoices.map(normalizeInvoice) });
    }

    // Fetch invoices for this student
    const invoices = await Invoice.find({ $or: [{ student: student._id }, { studentId: String(student._id) }, { studentId: student.username }] })
      .sort({ due: 1 })
      .lean()
      .exec();

    return res.json({ ok: true, profile: student, invoices: invoices.map(normalizeInvoice) });
  } catch (err) {
    console.error('GET /students/me error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch profile' });
  }
});

router.post('/_create', async (req, res) => {
  try {
    const { studentId, amount, desc, due } = req.body || {};
    if (!studentId || !amount) return res.status(400).json({ ok: false, message: 'studentId and amount required' });

    const ref = 'INV-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

    const invoice = new Invoice({
      ref,
      studentId: String(studentId),
      desc: desc || 'Invoice',
      amount: Number(amount),
      paid: 0,
      due: due ? new Date(due) : null,
      status: 'unpaid',
      items: []
    });

    await invoice.save();
    return res.json({ ok: true, invoice: normalizeInvoice(invoice) });
  } catch (err) {
    console.error('POST /invoices/_create error', err);
    return res.status(500).json({ ok: false, message: 'Failed to create invoice' });
  }
});

export default router;
