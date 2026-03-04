'use strict';

import express from 'express';
import mongoose from 'mongoose';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import bcrypt from 'bcryptjs';
import Application from '../models/Application.js';
import User from '../models/User.js';

const router = express.Router();

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const UPLOADS_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
const BACKUP_CMD = process.env.BACKUP_CMD || ''; // optional: command to run for backups

// Utility: safe regex for search
function safeRegex(q) {
  if (!q) return null;
  const s = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(s, 'i');
}

// Utility: build student query
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

// Utility: build staff query
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

// Utility: CSV serializer
function toCSV(items, columns) {
  const rows = [columns.join(',')];
  for (const it of items) {
    const row = columns.map(c => {
      const v = (it[c] === undefined || it[c] === null) ? '' : String(it[c]).replace(/"/g, '""');
      return `"${v}"`;
    }).join(',');
    rows.push(row);
  }
  return rows.join('\n');
}

// Audit helper (append simple JSON line to admin-actions.log if LOG_DIR writable)
async function audit(action, actor = 'system', meta = {}) {
  try {
    const file = path.join(LOG_DIR, 'admin-actions.log');
    const line = JSON.stringify({ time: new Date().toISOString(), actor, action, meta }) + '\n';
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(file, line, 'utf8');
  } catch (e) {
    // non-fatal - just log to stdout
    console.warn('audit log failed', e && e.message);
  }
}

router.get('/students', async (req, res) => {
  try {
    const { q, status, program, class: className } = req.query;
    let limit = Math.min(2000, Number(req.query.limit || 200));
    let offset = Math.max(0, Number(req.query.offset || 0));
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const query = buildStudentQuery({ q, status, program, className });

    // Build a user-specific query (we try to detect 'student' role entries where appropriate)
    const userQuery = { ...query };
    if (!userQuery.role) {
      userQuery.role = { $in: ['student', 'Student', 'learner'] };
    }

    // Query both collections in parallel (with the same limit/offset per collection).
    // We'll merge and dedupe them below.
    const [users, usersTotal, apps, appsTotal] = await Promise.all([
      User.find(userQuery).skip(offset).limit(limit).lean().exec().catch(() => []),
      User.countDocuments(userQuery).catch(() => 0),
      Application.find(query).skip(offset).limit(limit).lean().exec().catch(() => []),
      Application.countDocuments(query).catch(() => 0)
    ]);

    // Merge & dedupe: prefer User entries when duplicates exist
    const map = new Map();
    const add = (list, source) => {
      for (const it of list || []) {
        // Dedup key: prefer _id, fallback to username or email
        const key = it._id ? String(it._id) : (it.username ? `u:${String(it.username)}` : (it.email ? `e:${String(it.email)}` : JSON.stringify(it)));
        if (!map.has(key)) {
          // annotate source for debugging
          map.set(key, { ...it, _source: source });
        }
      }
    };
    add(users, 'users');
    add(apps, 'applications');

    const combined = Array.from(map.values()).slice(0, limit);
    const total = (Number(usersTotal) || 0) + (Number(appsTotal) || 0);

    return res.json({
      ok: true,
      data: combined,
      total,
      counts: { users: Number(usersTotal) || 0, applications: Number(appsTotal) || 0 }
    });
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

    if (mongoose.Types.ObjectId.isValid(id)) {
      doc = await User.findById(id).lean().exec().catch(() => null);
      if (!doc) doc = await Application.findById(id).lean().exec().catch(() => null);
    }

    if (!doc) {
      doc = await User.findOne({ username: id }).lean().exec().catch(() => null);
      if (!doc) doc = await Application.findOne({ username: id }).lean().exec().catch(() => null);
    }

    if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });
    return res.json({ ok: true, data: doc });
  } catch (err) {
    console.error('GET /admin/students/:id error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// POST /admin/students  — create a new User (student)
router.post('/students', async (req, res) => {
  try {
    const body = req.body || {};
    const required = ['username', 'password', 'firstName', 'lastName', 'email'];
    for (const k of required) {
      if (!body[k] || String(body[k]).trim() === '') {
        return res.status(400).json({ ok: false, message: `${k} is required` });
      }
    }

    const existing = await User.findOne({ $or: [{ username: body.username }, { email: body.email }] }).lean().exec();
    if (existing) return res.status(409).json({ ok: false, message: 'username or email already in use' });

    const saltRounds = Number(process.env.PW_SALT_ROUNDS) || 10;
    const passwordHash = await bcrypt.hash(String(body.password), saltRounds);

    const doc = new User({
      username: body.username,
      email: body.email,
      passwordHash,
      firstName: body.firstName,
      lastName: body.lastName,
      program: body.program || body.course || null,
      className: body.className || body.cohort || null,
      status: body.status || 'active',
      role: 'student',
      profile: body.profile || {}
    });

    await doc.save();
    const out = { ...doc.toObject() };
    delete out.passwordHash;
    await audit('create-student', body.username || 'unknown', { id: out._id });
    return res.status(201).json({ ok: true, data: out });
  } catch (err) {
    console.error('POST /admin/students error', err);
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

    await audit('update-student-status', 'anonymous', { id, status });
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
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="students-export.csv"');
    await audit('export-students', 'anonymous', { count: items.length });
    return res.send(csv);
  } catch (err) {
    console.error('POST /admin/students/export error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

router.get('/staffs', async (req, res) => {
  try {
    const { q, role, dept, status } = req.query;
    let limit = Math.min(2000, Number(req.query.limit || 200));
    let offset = Math.max(0, Number(req.query.offset || 0));
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const query = buildStaffQuery({ q, role, dept, status });

    const [users, total] = await Promise.all([
      User.find(query).skip(offset).limit(limit).lean().exec().catch(() => []),
      User.countDocuments(query).catch(() => 0)
    ]);

    return res.json({ ok: true, data: users, total });
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
    if (mongoose.Types.ObjectId.isValid(id)) {
      doc = await User.findById(id).populate('classAssigned', 'name term').populate('classAssignedMany', 'name term').lean().exec().catch(() => null);
    }
    if (!doc) doc = await User.findOne({ username: id }).populate('classAssigned', 'name term').populate('classAssignedMany', 'name term').lean().exec().catch(() => null);
    if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });
    return res.json({ ok: true, data: doc });
  } catch (err) {
    console.error('GET /admin/staffs/:id error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// POST /admin/staffs  — create a new User (staff)
router.post('/staffs', async (req, res) => {
  try {
    const body = req.body || {};
    const required = ['username', 'password', 'firstName', 'lastName', 'email', 'role'];
    for (const k of required) {
      if (!body[k] || String(body[k]).trim() === '') {
        return res.status(400).json({ ok: false, message: `${k} is required` });
      }
    }

    const existing = await User.findOne({ $or: [{ username: body.username }, { email: body.email }] }).lean().exec();
    if (existing) return res.status(409).json({ ok: false, message: 'username or email already in use' });

    const saltRounds = Number(process.env.PW_SALT_ROUNDS) || 10;
    const passwordHash = await bcrypt.hash(String(body.password), saltRounds);

    const doc = new User({
      username: body.username,
      email: body.email,
      passwordHash,
      firstName: body.firstName,
      lastName: body.lastName,
      department: body.department || body.dept || null,
      status: body.status || 'active',
      role: body.role,
      profile: body.profile || {}
    });

    // handle optional classAssigned on creation
    if (body.classAssigned) doc.classAssigned = body.classAssigned;
    if (body.classAssignedMany && Array.isArray(body.classAssignedMany)) doc.classAssignedMany = body.classAssignedMany;

    await doc.save();

    // Sync: if created with classAssigned, set Class.teacherId
    try {
      if (doc.classAssigned) {
        await mongoose.models.Class.findByIdAndUpdate(doc.classAssigned, { teacherId: doc._id }).exec().catch(() => {});
        await mongoose.models.User.findByIdAndUpdate(doc._id, { $addToSet: { classAssignedMany: doc.classAssigned } }).exec().catch(() => {});
      }
      if (Array.isArray(doc.classAssignedMany) && doc.classAssignedMany.length) {
        await mongoose.models.Class.updateMany({ _id: { $in: doc.classAssignedMany } }, { $set: { teacherId: doc._id } }).exec().catch(() => {});
      }
    } catch (e) {
      console.warn('sync user->class (create) failed', e && e.message);
    }

    const out = { ...doc.toObject() };
    delete out.passwordHash;
    await audit('create-staff', body.username || 'unknown', { id: out._id, role: body.role });
    return res.status(201).json({ ok: true, data: out });
  } catch (err) {
    console.error('POST /admin/staffs error', err);
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

    await audit('update-staff-role', 'anonymous', { id, role });
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error('PUT /admin/staffs/:id/role error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// Generic staff update with class sync
router.put('/staffs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const allowed = ['firstName','lastName','email','department','dept','status','role','classAssigned','classAssignedMany','subjects','profile','username','title','bio'];
    const update = {};
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, k)) update[k] = body[k];
    }

    // handle password change
    if (body.password) {
      const saltRounds = Number(process.env.PW_SALT_ROUNDS) || 10;
      update.passwordHash = await bcrypt.hash(String(body.password), saltRounds);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ ok: false, message: 'No updatable fields provided' });
    }

    // find existing user (by id or username)
    let existing = null;
    if (mongoose.Types.ObjectId.isValid(id)) existing = await User.findById(id).lean().exec().catch(()=>null);
    if (!existing) existing = await User.findOne({ username: id }).lean().exec().catch(()=>null);
    if (!existing) return res.status(404).json({ ok:false, message:'Not found' });

    // apply update
    let updated = null;
    if (mongoose.Types.ObjectId.isValid(existing._id)) {
      updated = await User.findByIdAndUpdate(existing._id, update, { new: true }).lean().exec().catch(()=>null);
    } else {
      updated = await User.findOneAndUpdate({ username: id }, update, { new: true }).lean().exec().catch(()=>null);
    }
    if (!updated) return res.status(500).json({ ok:false, message:'Update failed' });

    // If classAssigned changed, reflect on Class.teacherId and user.classAssignedMany
    try {
      const prevClass = existing.classAssigned ? String(existing.classAssigned) : null;
      const newClass = updated.classAssigned ? String(updated.classAssigned) : null;
      if (prevClass !== newClass) {
        if (prevClass) {
          await mongoose.models.Class.findByIdAndUpdate(prevClass, { $unset: { teacherId: "" } }).exec().catch(()=>{});
          await mongoose.models.User.findByIdAndUpdate(updated._id, { $pull: { classAssignedMany: prevClass } }).exec().catch(()=>{});
        }
        if (newClass) {
          await mongoose.models.Class.findByIdAndUpdate(newClass, { teacherId: updated._id }).exec().catch(()=>{});
          await mongoose.models.User.findByIdAndUpdate(updated._id, { $addToSet: { classAssignedMany: newClass } }).exec().catch(()=>{});
        }
      }

      // If classAssignedMany changed, we won't attempt full reconciliation here, caller should manage.
    } catch (e) {
      console.warn('sync user->class (staff update) failed', e && e.message);
    }

    await audit('update-staff', req.user?.username || 'anonymous', { id: updated._id, update });
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error('PUT /admin/staffs/:id error', err);
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

    await audit('update-staff-status', 'anonymous', { id, status });
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
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="staffs-export.csv"');
    await audit('export-staffs', 'anonymous', { count: items.length });
    return res.send(csv);
  } catch (err) {
    console.error('POST /admin/staffs/export error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});


async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile()) {
        try {
          const st = await fs.stat(p);
          total += st.size;
        } catch {}
      } else if (e.isDirectory()) {
        total += await dirSize(p);
      }
    }
  } catch (e) {
    // ignore
  }
  return total;
}

// GET /admin/health
router.get('/health', async (req, res) => {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const activeUsers = await User.countDocuments({ status: { $ne: 'disabled' } }).catch(() => 0);
    const pendingApplications = await Application.countDocuments({ status: 'submitted' }).catch(() => 0);
    let storage = null;
    try {
      storage = await dirSize(UPLOADS_DIR);
    } catch (e) {
      storage = null;
    }

    return res.json({
      ok: true,
      uptime: process.uptime(),
      dbConnected,
      activeUsers,
      pendingApplications,
      storage
    });
  } catch (err) {
    console.error('GET /admin/health error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /admin/applications
router.get('/applications', async (req, res) => {
  try {
    const { q, status } = req.query;
    let limit = Math.min(2000, Number(req.query.limit || 200));
    let offset = Math.max(0, Number(req.query.offset || 0));
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const and = [];
    if (q) {
      const re = safeRegex(q);
      and.push({ $or: [{ username: re }, { email: re }, { firstName: re }, { lastName: re }] });
    }
    if (status) and.push({ status });

    const query = and.length === 0 ? {} : (and.length === 1 ? and[0] : { $and: and });

    const [apps, total] = await Promise.all([
      Application.find(query).skip(offset).limit(limit).lean().exec().catch(() => []),
      Application.countDocuments(query).catch(() => 0)
    ]);

    return res.json({ ok: true, data: apps, total });
  } catch (err) {
    console.error('GET /admin/applications error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /admin/resources
router.get('/resources', async (req, res) => {
  try {
    const { q } = req.query;
    let limit = Math.min(2000, Number(req.query.limit || 200));
    let offset = Math.max(0, Number(req.query.offset || 0));
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const ResourceModel = mongoose.models.Resource || mongoose.models.Resources || null;
    if (!ResourceModel) return res.json({ ok: true, data: [], total: 0 });

    const qobj = {};
    if (q) {
      const re = safeRegex(q);
      qobj.$or = [{ title: re }, { desc: re }, { tags: re }];
    }

    const [items, total] = await Promise.all([
      ResourceModel.find(qobj).skip(offset).limit(limit).lean().exec().catch(() => []),
      ResourceModel.countDocuments(qobj).catch(() => 0)
    ]);

    return res.json({ ok: true, data: items, total });
  } catch (err) {
    console.error('GET /admin/resources error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// POST /admin/backup
router.post('/backup', async (req, res) => {
  try {
    if (BACKUP_CMD) {
      const child = spawn(BACKUP_CMD, { shell: true, detached: true, stdio: 'ignore' });
      child.unref();
      await audit('trigger-backup-cmd', 'anonymous', { cmd: BACKUP_CMD });
      return res.status(202).json({ ok: true, message: 'Backup started' });
    }

    setImmediate(() => {
      console.log('[admin] backup requested (no BACKUP_CMD configured)');
    });
    await audit('trigger-backup-stub', 'anonymous', {});
    return res.status(202).json({ ok: true, message: 'Backup requested (stub)' });
  } catch (err) {
    console.error('POST /admin/backup error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /admin/logs?lines=200
router.get('/logs', async (req, res) => {
  try {
    const lines = Math.min(5000, Math.max(10, Number(req.query.lines || 200)));
    const logfile = path.join(LOG_DIR, 'access.log');
    if (!fsSync.existsSync(logfile)) return res.status(404).json({ ok: false, message: 'Log file not found' });

    const content = await fs.readFile(logfile, 'utf8').catch(() => '');
    const arr = content.split('\n').filter(Boolean);
    const out = arr.slice(-lines).join('\n');
    return res.json({ ok: true, data: out });
  } catch (err) {
    console.error('GET /admin/logs error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

export default router;
