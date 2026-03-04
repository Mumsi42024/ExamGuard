'use strict';

import express from 'express';
import mongoose from 'mongoose';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import Application from '../models/Application.js';
import User from '../models/User.js';
import { authenticateJWT } from '../middleware/auth.js';

const router = express.Router();

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const UPLOADS_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
const BACKUP_CMD = process.env.BACKUP_CMD || ''; // optional: command to run for backups
const ADMIN_OPEN = process.env.ADMIN_OPEN === 'true'; // set to true only for testing

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

// Auth guard for production: require JWT + admin role unless ADMIN_OPEN=true
function requireAdmin(req, res, next) {
  if (ADMIN_OPEN) return next(); // open for testing if explicitly enabled via env
  // authenticateJWT must be executed before this middleware; many routes include authenticateJWT explicitly
  const user = req.user;
  if (!user) return res.status(401).json({ ok: false, message: 'Unauthenticated' });
  const roles = user.roles || (user.role ? [user.role] : []);
  const isAdmin = user.isAdmin || roles.includes('admin') || roles.includes('administrator') || user.role === 'admin';
  if (!isAdmin) return res.status(403).json({ ok: false, message: 'Forbidden: admin only' });
  return next();
}

/* ---------------------------
   Students endpoints (production-ready)
   GET  /admin/students?q=&status=&program=&class=&limit=&offset=
   GET  /admin/students/:id
   PUT  /admin/students/:id/status  (body: { status })
   POST /admin/students/export  (CSV)
   --------------------------- */

// GET /admin/students
router.get('/students', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { q, status, program, class: className } = req.query;
    let limit = Math.min(2000, Number(req.query.limit || 200));
    let offset = Math.max(0, Number(req.query.offset || 0));
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const query = buildStudentQuery({ q, status, program, className });

    // Try User model first
    let users = [];
    let total = 0;
    try {
      const userQuery = { ...query };
      // If there is no explicit role filter, prefer entries that look like students
      if (!userQuery.role) userQuery.role = { $in: ['student', 'Student', 'learner'] };
      [users, total] = await Promise.all([
        User.find(userQuery).skip(offset).limit(limit).lean().exec().catch(() => []),
        User.countDocuments(userQuery).catch(() => 0)
      ]);
    } catch (e) {
      users = [];
      total = 0;
    }

    // If no users found, fallback to Application collection
    if ((!users || users.length === 0) && Application) {
      const [apps, appsTotal] = await Promise.all([
        Application.find(query).skip(offset).limit(limit).lean().exec().catch(() => []),
        Application.countDocuments(query).catch(() => 0)
      ]);
      return res.json({ ok: true, data: apps, total: appsTotal, source: 'applications' });
    }

    return res.json({ ok: true, data: users, total, source: 'users' });
  } catch (err) {
    console.error('GET /admin/students error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /admin/students/:id
router.get('/students/:id', authenticateJWT, requireAdmin, async (req, res) => {
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

// PUT /admin/students/:id/status
router.put('/students/:id/status', authenticateJWT, requireAdmin, async (req, res) => {
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

    await audit('update-student-status', req.user?.username || 'system', { id, status });
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error('PUT /admin/students/:id/status error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// POST /admin/students/export
router.post('/students/export', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { q, status, program, class: className } = req.body || req.query || {};
    const query = buildStudentQuery({ q, status, program, className });

    let items = await User.find(query).lean().exec().catch(() => []);
    if (!items || items.length === 0) items = await Application.find(query).lean().exec().catch(() => []);

    const columns = ['_id','username','firstName','lastName','email','program','className','status'];
    const csv = toCSV(items, columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="students-export.csv"');
    await audit('export-students', req.user?.username || 'system', { count: items.length });
    return res.send(csv);
  } catch (err) {
    console.error('POST /admin/students/export error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

/* ---------------------------
   Staffs endpoints (production-ready)
   GET  /admin/staffs?q=&role=&dept=&status=&limit=&offset=
   GET  /admin/staffs/:id
   PUT  /admin/staffs/:id/role  (body: { role })
   PUT  /admin/staffs/:id/status (body: { status })
   POST /admin/staffs/export  (CSV)
   --------------------------- */

// GET /admin/staffs
router.get('/staffs', authenticateJWT, requireAdmin, async (req, res) => {
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
router.get('/staffs/:id', authenticateJWT, requireAdmin, async (req, res) => {
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
router.put('/staffs/:id/role', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { role } = req.body || {};
    if (!role) return res.status(400).json({ ok: false, message: 'role is required' });

    let updated = null;
    if (mongoose.Types.ObjectId.isValid(id)) updated = await User.findByIdAndUpdate(id, { role }, { new: true }).lean().exec().catch(() => null);
    if (!updated) updated = await User.findOneAndUpdate({ username: id }, { role }, { new: true }).lean().exec().catch(() => null);
    if (!updated) return res.status(404).json({ ok: false, message: 'Not found' });

    await audit('update-staff-role', req.user?.username || 'system', { id, role });
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error('PUT /admin/staffs/:id/role error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// PUT /admin/staffs/:id/status
router.put('/staffs/:id/status', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ ok: false, message: 'status is required' });

    let updated = null;
    if (mongoose.Types.ObjectId.isValid(id)) updated = await User.findByIdAndUpdate(id, { status }, { new: true }).lean().exec().catch(() => null);
    if (!updated) updated = await User.findOneAndUpdate({ username: id }, { status }, { new: true }).lean().exec().catch(() => null);
    if (!updated) return res.status(404).json({ ok: false, message: 'Not found' });

    await audit('update-staff-status', req.user?.username || 'system', { id, status });
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error('PUT /admin/staffs/:id/status error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// POST /admin/staffs/export
router.post('/staffs/export', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { q, role, dept, status } = req.body || req.query || {};
    const query = buildStaffQuery({ q, role, dept, status });
    const items = await User.find(query).lean().exec().catch(() => []);
    const columns = ['_id','username','firstName','lastName','email','role','department','status'];
    const csv = toCSV(items, columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="staffs-export.csv"');
    await audit('export-staffs', req.user?.username || 'system', { count: items.length });
    return res.send(csv);
  } catch (err) {
    console.error('POST /admin/staffs/export error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

/* ---------------------------
   Additional admin helpers required by admin.html (production-ready)
   - GET  /admin/health
   - GET  /admin/applications?q=&status=&limit=&offset=
   - GET  /admin/resources?q=&limit=&offset=
   - POST /admin/backup
   - GET  /admin/logs?lines=
   --------------------------- */

// Async directory size (walk)
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
router.get('/health', authenticateJWT, requireAdmin, async (req, res) => {
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
router.get('/applications', authenticateJWT, requireAdmin, async (req, res) => {
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
router.get('/resources', authenticateJWT, requireAdmin, async (req, res) => {
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
router.post('/backup', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    // If a BACKUP_CMD is configured, attempt to run it asynchronously
    if (BACKUP_CMD) {
      // spawn a shell to run the configured command
      const child = spawn(BACKUP_CMD, { shell: true, detached: true, stdio: 'ignore' });
      child.unref();
      await audit('trigger-backup-cmd', req.user?.username || 'system', { cmd: BACKUP_CMD });
      return res.status(202).json({ ok: true, message: 'Backup started' });
    }

    // Otherwise, perform a lightweight "backup" stub (log and return 202)
    setImmediate(() => {
      console.log('[admin] backup requested (no BACKUP_CMD configured)');
    });
    await audit('trigger-backup-stub', req.user?.username || 'system', {});
    return res.status(202).json({ ok: true, message: 'Backup requested (stub)' });
  } catch (err) {
    console.error('POST /admin/backup error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /admin/logs?lines=200
router.get('/logs', authenticateJWT, requireAdmin, async (req, res) => {
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
