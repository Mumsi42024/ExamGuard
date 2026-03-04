'use strict';

import express from 'express';
import mongoose from 'mongoose';
import Application from '../models/Application.js';
import User from '../models/User.js';

const router = express.Router();

// utility to build case-insensitive regex safely
function safeRegex(q) {
  if (!q) return null;
  const s = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(s, 'i');
}

// build student query
function buildStudentQuery({ q, status, program, className }) {
  const and = [];
  if (q) {
    const re = safeRegex(q);
    and.push({
      $or: [
        { username: re },
        { email: re },
        { firstName: re },
        { lastName: re },
        { 'profile.name': re }
      ]
    });
  }
  if (status) and.push({ status });
  if (program) and.push({ program });
  if (className) {
    const re = safeRegex(className);
    and.push({ $or: [{ className: re }, { cohort: re }] });
  }
  if (and.length === 0) return {};
  if (and.length === 1) return and[0];
  return { $and: and };
}

// build staff query
function buildStaffQuery({ q, role, dept, status }) {
  const and = [];
  if (q) {
    const re = safeRegex(q);
    and.push({
      $or: [
        { username: re },
        { email: re },
        { firstName: re },
        { lastName: re },
        { department: re }
      ]
    });
  }
  if (role) and.push({ role });
  if (dept) {
    const re = safeRegex(dept);
    and.push({ $or: [{ department: re }, { dept: re }] });
  }
  if (status) and.push({ status });
  if (and.length === 0) return {};
  if (and.length === 1) return and[0];
  return { $and: and };
}

// CSV helper
function toCSV(items, columns) {
  const rows = [columns.join(',')];
  for (const it of items) {
    const row = columns.map(c => {
      const v = it[c] === undefined || it[c] === null ? '' : String(it[c]).replace(/"/g, '""');
      return `"${v}"`;
    }).join(',');
    rows.push(row);
  }
  return rows.join('\n');
}

/* ---------------------------
   Students endpoints (OPEN access for now)
   GET  /admin/students?q=&status=&program=&class=
   GET  /admin/students/:id
   PUT  /admin/students/:id/status  (body: { status })
   POST /admin/students/export  (optional)
   --------------------------- */

// GET /admin/students
router.get('/students', async (req, res) => {
  try {
    const { q, status, program, class: className, limit = 200, offset = 0 } = req.query;
    const l = Math.min(2000, Number(limit) || 200);
    const o = Math.max(0, Number(offset) || 0);

    const query = buildStudentQuery({ q, status, program, className });

    // Prefer User model (registered students) then fallback to Application
    let users = [];
    try {
      const userQuery = { ...query };
      // If role isn't present, attempt to limit to student role entries where possible
      if (!userQuery.role) userQuery.role = { $in: ['student', 'student'] };
      users = await User.find(userQuery).skip(o).limit(l).lean().exec().catch(() => []);
    } catch (e) {
      users = [];
    }

    if (!users || users.length === 0) {
      const apps = await Application.find(query).skip(o).limit(l).lean().exec().catch(() => []);
      return res.json({ ok: true, data: apps });
    }

    return res.json({ ok: true, data: users });
  } catch (err) {
    console.error('GET /admin/students error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /admin/students/:id
router.get('/students/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let doc = null;
    if (mongoose.Types.ObjectId.isValid(id)) doc = await User.findById(id).lean().exec().catch(() => null);
    if (!doc) doc = await User.findOne({ username: id }).lean().exec().catch(() => null);
    if (!doc) doc = await Application.findById(id).lean().exec().catch(() => null);
    if (!doc) doc = await Application.findOne({ username: id }).lean().exec().catch(() => null);
    if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });
    return res.json({ ok: true, data: doc });
  } catch (err) {
    console.error('GET /admin/students/:id error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// PUT /admin/students/:id/status
router.put('/students/:id/status', async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ ok: false, message: 'status is required' });

    let updated = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      updated = await User.findByIdAndUpdate(id, { status }, { new: true }).lean().exec().catch(() => null);
      if (!updated) updated = await Application.findByIdAndUpdate(id, { status }, { new: true }).lean().exec().catch(() => null);
    }
    if (!updated) {
      updated = await User.findOneAndUpdate({ username: id }, { status }, { new: true }).lean().exec().catch(() => null);
      if (!updated) updated = await Application.findOneAndUpdate({ username: id }, { status }, { new: true }).lean().exec().catch(() => null);
    }
    if (!updated) return res.status(404).json({ ok: false, message: 'Not found' });
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error('PUT /admin/students/:id/status error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// POST /admin/students/export
router.post('/students/export', async (req, res) => {
  try {
    const { q, status, program, class: className } = req.body || req.query || {};
    const query = buildStudentQuery({ q, status, program, className });

    let items = await User.find(query).lean().exec().catch(() => []);
    if (!items || items.length === 0) items = await Application.find(query).lean().exec().catch(() => []);

    const columns = ['_id','username','firstName','lastName','email','program','className','status'];
    const csv = toCSV(items, columns);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="students-export.csv"');
    return res.send(csv);
  } catch (err) {
    console.error('POST /admin/students/export error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

/* ---------------------------
   Staffs endpoints (OPEN access for now)
   GET  /admin/staffs?q=&role=&dept=&status=
   GET  /admin/staffs/:id
   PUT  /admin/staffs/:id/role (body: { role })
   PUT  /admin/staffs/:id/status (body: { status })
   POST /admin/staffs/export (optional)
   --------------------------- */

// GET /admin/staffs
router.get('/staffs', async (req, res) => {
  try {
    const { q, role, dept, status, limit = 200, offset = 0 } = req.query;
    const l = Math.min(2000, Number(limit) || 200);
    const o = Math.max(0, Number(offset) || 0);
    const query = buildStaffQuery({ q, role, dept, status });

    let users = await User.find(query).skip(o).limit(l).lean().exec().catch(() => []);
    if (!users) users = [];
    return res.json({ ok: true, data: users });
  } catch (err) {
    console.error('GET /admin/staffs error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /admin/staffs/:id
router.get('/staffs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let doc = null;
    if (mongoose.Types.ObjectId.isValid(id)) doc = await User.findById(id).lean().exec().catch(() => null);
    if (!doc) doc = await User.findOne({ username: id }).lean().exec().catch(() => null);
    if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });
    return res.json({ ok: true, data: doc });
  } catch (err) {
    console.error('GET /admin/staffs/:id error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// PUT /admin/staffs/:id/role
router.put('/staffs/:id/role', async (req, res) => {
  try {
    const id = req.params.id;
    const { role } = req.body || {};
    if (!role) return res.status(400).json({ ok: false, message: 'role is required' });

    let updated = null;
    if (mongoose.Types.ObjectId.isValid(id)) updated = await User.findByIdAndUpdate(id, { role }, { new: true }).lean().exec().catch(() => null);
    if (!updated) updated = await User.findOneAndUpdate({ username: id }, { role }, { new: true }).lean().exec().catch(() => null);
    if (!updated) return res.status(404).json({ ok: false, message: 'Not found' });
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error('PUT /admin/staffs/:id/role error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// PUT /admin/staffs/:id/status
router.put('/staffs/:id/status', async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ ok: false, message: 'status is required' });

    let updated = null;
    if (mongoose.Types.ObjectId.isValid(id)) updated = await User.findByIdAndUpdate(id, { status }, { new: true }).lean().exec().catch(() => null);
    if (!updated) updated = await User.findOneAndUpdate({ username: id }, { status }, { new: true }).lean().exec().catch(() => null);
    if (!updated) return res.status(404).json({ ok: false, message: 'Not found' });
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error('PUT /admin/staffs/:id/status error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// POST /admin/staffs/export
router.post('/staffs/export', async (req, res) => {
  try {
    const { q, role, dept, status } = req.body || req.query || {};
    const query = buildStaffQuery({ q, role, dept, status });
    const items = await User.find(query).lean().exec().catch(() => []);
    const columns = ['_id','username','firstName','lastName','email','role','department','status'];
    const csv = toCSV(items, columns);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="staffs-export.csv"');
    return res.send(csv);
  } catch (err) {
    console.error('POST /admin/staffs/export error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

export default router;
