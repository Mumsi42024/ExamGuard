'use strict';

import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticateJWT } from '../middleware/auth.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

// Reuse existing models when available, otherwise define minimal fallback schemas
let Invoice = mongoose.models.Invoice;
let Student = mongoose.models.Student;

if (!Invoice) {
  const InvoiceSchema = new mongoose.Schema({
    ref: { type: String, index: true },
    studentId: { type: String, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    desc: String,
    amount: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    items: { type: Array, default: [] },
    due: { type: Date, default: null },
    status: { type: String, enum: ['unpaid', 'partial', 'paid'], default: 'unpaid' },
    trace: String,
    currency: { type: String, default: 'NGN' },
  }, { timestamps: true });
  Invoice = mongoose.model('Invoice', InvoiceSchema);
}

if (!Student) {
  const StudentSchema = new mongoose.Schema({
    username: String,
    firstName: String,
    lastName: String,
    program: String,
    profilePic: String,
    session: String,
    email: String,
  }, { timestamps: true });
  Student = mongoose.model('Student', StudentSchema);
}

// Normalize invoice document to the shape frontend expects
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
    status: inv.status || ((inv.paid || 0) >= (inv.amount || 0) ? 'paid' : ((inv.paid || 0) > 0 ? 'partial' : 'unpaid')),
    trace: inv.trace || '',
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt
  };
}

// Optional auth: try to parse JWT if present; do not fail when missing/invalid
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
    // ignore invalid token: treat as unauthenticated
    console.warn('optionalAuth: JWT verify failed:', err && err.message);
  }
  return next();
}

// Helper: find invoice by _id or ref
async function findInvoiceByIdOrRef(idOrRef) {
  if (!idOrRef) return null;
  if (mongoose.Types.ObjectId.isValid(idOrRef)) {
    const found = await Invoice.findById(idOrRef);
    if (found) return found;
  }
  let found = await Invoice.findOne({ ref: idOrRef });
  if (found) return found;
  found = await Invoice.findOne({ _id: idOrRef });
  return found;
}

// GET /api/invoices
// Query support: studentId=, student=, mine=true, search, limit, offset
router.get('/', optionalAuth, async (req, res) => {
  try {
    const q = {};
    const { studentId, student, mine, limit, offset, search } = req.query;

    if (studentId) q.studentId = studentId;
    if (student) q.studentId = student;

    if (String(mine) === 'true' && req.user) {
      const id = req.user.id || req.user._id || req.user.sub || req.user.username;
      if (id) q.studentId = String(id);
    }

    if (search) {
      const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [{ ref: re }, { desc: re }];
    }

    const l = Math.min(200, parseInt(limit || '100', 10) || 100);
    const o = Math.max(0, parseInt(offset || '0', 10) || 0);

    const docs = await Invoice.find(q).sort({ due: 1, createdAt: -1 }).skip(o).limit(l).lean().exec();
    return res.json({ ok: true, invoices: docs.map(normalizeInvoice) });
  } catch (err) {
    console.error('GET /invoices error', err);
    return res.status(500).json({ ok: false, message: 'Failed to list invoices' });
  }
});

// GET /api/invoices/:id
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const inv = await findInvoiceByIdOrRef(req.params.id);
    if (!inv) return res.status(404).json({ ok: false, message: 'Invoice not found' });
    return res.json({ ok: true, invoice: normalizeInvoice(inv) });
  } catch (err) {
    console.error('GET /invoices/:id error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch invoice' });
  }
});

// POST /api/invoices/:id/pay
// Body: { amount: number }
// If token present, it's used; otherwise this still allows backend payment record updates (can be disabled if you want stricter auth)
router.post('/:id/pay', optionalAuth, async (req, res) => {
  try {
    const { amount } = req.body || {};
    const numericAmount = Number(amount || 0);
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ ok: false, message: 'Invalid amount' });
    }

    const inv = await findInvoiceByIdOrRef(req.params.id);
    if (!inv) return res.status(404).json({ ok: false, message: 'Invoice not found' });

    const remaining = Math.max(0, (inv.amount || 0) - (inv.paid || 0));
    const applied = Math.min(remaining, numericAmount);

    inv.paid = (inv.paid || 0) + applied;
    if ((inv.paid || 0) >= (inv.amount || 0)) {
      inv.status = 'paid';
      inv.paid = inv.amount;
    } else if ((inv.paid || 0) > 0) {
      inv.status = 'partial';
    } else {
      inv.status = 'unpaid';
    }

    inv.trace = inv.trace || ('TRC-' + crypto.randomBytes(6).toString('hex').toUpperCase());

    await inv.save();

    return res.json({ ok: true, invoice: normalizeInvoice(inv), trace: inv.trace });
  } catch (err) {
    console.error('POST /invoices/:id/pay error', err);
    return res.status(500).json({ ok: false, message: 'Payment processing failed' });
  }
});

// POST /api/invoices/_create - dev helper to create an invoice
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

// GET /api/students/me
// The frontend expects /api/students/me to return aggregated profile + invoices.
// This router exposes that endpoint so mounting this router at /api provides /api/students/me.
router.get('/students/me', authenticateJWT, async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, message: 'Unauthenticated' });

    // Try to find student record
    let student = null;
    const id = user.id || user._id || user.sub || user.username;

    if (id) {
      if (mongoose.Types.ObjectId.isValid(id)) {
        student = await Student.findById(id).lean().exec();
      }
      if (!student) student = await Student.findOne({ username: id }).lean().exec();
    }

    const invoices = await Invoice.find({
      $or: [
        { student: student ? student._id : undefined },
        { studentId: String(id) },
        { studentId: student && student.username ? student.username : undefined }
      ].filter(Boolean)
    }).sort({ due: 1 }).lean().exec();

    const profile = student || {
      id,
      username: user.username || null,
      firstName: user.firstName || user.given_name || null,
      lastName: user.lastName || user.family_name || null,
      email: user.email || null,
      program: user.program || null,
      session: user.session || null
    };

    return res.json({ ok: true, profile, invoices: invoices.map(normalizeInvoice) });
  } catch (err) {
    console.error('GET /students/me error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch profile' });
  }
});

export default router;
