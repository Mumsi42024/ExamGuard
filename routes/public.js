'use strict';

import express from 'express';
import mongoose from 'mongoose';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { authenticateJWT } from '../middleware/auth.js';

const router = express.Router();

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const PUBLIC_API_OPEN = process.env.PUBLIC_API_OPEN === 'true'; // set true to allow writes without auth

// Helpers
function safeRegex(q) {
  if (!q) return null;
  const s = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(s, 'i');
}

function parseLimitOffset(req, { defLimit = 100, maxLimit = 2000 } = {}) {
  let limit = Math.min(maxLimit, Number(req.query.limit || defLimit));
  let offset = Math.max(0, Number(req.query.offset || 0));
  if (!Number.isFinite(limit) || limit <= 0) limit = defLimit;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

async function audit(action, actor = 'anonymous', meta = {}) {
  try {
    const file = path.join(LOG_DIR, 'public-api-actions.log');
    const line = JSON.stringify({ time: new Date().toISOString(), actor, action, meta }) + '\n';
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(file, line, 'utf8');
  } catch (e) {
    // non-fatal
    // eslint-disable-next-line no-console
    console.warn('audit failed', e && e.message);
  }
}

// Require admin (unless PUBLIC_API_OPEN)
async function requireAdmin(req, res, next) {
  if (PUBLIC_API_OPEN) return next();
  // authenticateJWT should populate req.user
  if (typeof authenticateJWT === 'function') {
    // call authenticateJWT middleware first
    let called = false;
    await new Promise((resolve) => {
      authenticateJWT(req, res, () => { called = true; resolve(); });
      // if authenticateJWT sends response, resolve anyway
      setTimeout(resolve, 1);
    });
    if (!called && !req.user) {
      // if authenticateJWT didn't set user, respond
      return res.status(401).json({ ok: false, message: 'Unauthenticated' });
    }
  }
  const user = req.user || {};
  const roles = user.roles || (user.role ? [user.role] : []);
  const isAdmin = user.isAdmin || roles.includes('admin') || roles.includes('administrator') || user.role === 'admin';
  if (!isAdmin) return res.status(403).json({ ok: false, message: 'Forbidden: admin only' });
  next();
}

// Try to load a model file dynamically if mongoose.models[modelName] missing.
// This avoids hard-coupling model imports in index.js.
async function ensureModelLoaded(modelName) {
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  try {
    const filePath = path.join(process.cwd(), 'models', `${modelName}.js`);
    const fileUrl = pathToFileURL(filePath).href;
    await import(fileUrl);
    return mongoose.models[modelName] || null;
  } catch (e) {
    // ignore - caller will handle missing model
    // eslint-disable-next-line no-console
    console.warn(`ensureModelLoaded failed for ${modelName}`, e && e.message);
    return null;
  }
}

function mountCrudFor({ modelName, collectionName, allowedCreate = [], allowedUpdate = [], searchFields = [] }) {
  const pathBase = `/${collectionName}`;

  // List / Search
  router.get(pathBase, async (req, res) => {
    try {
      let Model = mongoose.models[modelName] || null;
      if (!Model) Model = await ensureModelLoaded(modelName);
      if (!Model) return res.json({ ok: true, data: [], total: 0 });

      const { q } = req.query;
      const { limit, offset } = parseLimitOffset(req, { defLimit: 200, maxLimit: 2000 });
      const qobj = {};
      if (q && searchFields && searchFields.length) {
        const re = safeRegex(q);
        qobj.$or = searchFields.map(f => ({ [f]: re }));
      }

      const [items, total] = await Promise.all([
        Model.find(qobj).skip(offset).limit(limit).lean().exec().catch(() => []),
        Model.countDocuments(qobj).catch(() => 0)
      ]);
      return res.json({ ok: true, data: items, total });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`GET ${pathBase} error`, err);
      return res.status(500).json({ ok: false, message: 'Server error' });
    }
  });

  // Create
  router.post(pathBase, async (req, res) => {
    try {
      let Model = mongoose.models[modelName] || null;
      if (!Model) Model = await ensureModelLoaded(modelName);
      if (!Model) return res.status(404).json({ ok: false, message: `${modelName} model not found` });
      const body = req.body || {};
      const docData = {};
      for (const k of allowedCreate) {
        if (Object.prototype.hasOwnProperty.call(body, k)) docData[k] = body[k];
      }
      const doc = new Model(docData);
      await doc.save();

      // Sync: if Class created with teacherId or students, update User references
      if (modelName === 'Class') {
        try {
          if (doc.teacherId) {
            await mongoose.models.User.findByIdAndUpdate(doc.teacherId, {
              $set: { classAssigned: doc._id },
              $addToSet: { classAssignedMany: doc._id }
            }).exec().catch(() => {});
          }
          if (Array.isArray(doc.students) && doc.students.length) {
            await mongoose.models.User.updateMany(
              { _id: { $in: doc.students } },
              { $addToSet: { classAssignedMany: doc._id } }
            ).exec().catch(() => {});
          }
        } catch (e) {
          console.warn('sync class->user (create) failed', e && e.message);
        }
      }

      // Sync: if created User (staff/teacher) with classAssigned, set Class.teacherId
      if (modelName === 'User') {
        try {
          // only sync for teacher role (safe-guard)
          if (doc.role === 'teacher') {
            if (doc.classAssigned) {
              await mongoose.models.Class.findByIdAndUpdate(
                doc.classAssigned,
                { $set: { teacherId: doc._id } }
              ).exec().catch(() => {});
              await mongoose.models.User.findByIdAndUpdate(
                doc._id,
                { $addToSet: { classAssignedMany: doc.classAssigned } }
              ).exec().catch(() => {});
            }
            if (Array.isArray(doc.classAssignedMany) && doc.classAssignedMany.length) {
              await mongoose.models.Class.updateMany(
                { _id: { $in: doc.classAssignedMany } },
                { $set: { teacherId: doc._id } }
              ).exec().catch(() => {});
            }
          }
        } catch (e) {
          console.warn('sync user->class (create) failed', e && e.message);
        }
      }

      await audit(`create:${collectionName}`, req.user?.username || 'system', { id: doc._id });
      return res.status(201).json({ ok: true, data: doc });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`POST ${pathBase} error`, err);
      return res.status(500).json({ ok: false, message: err.message || 'Server error' });
    }
  });

  // Read by id
  router.get(`${pathBase}/:id`, async (req, res) => {
    try {
      let Model = mongoose.models[modelName] || null;
      if (!Model) Model = await ensureModelLoaded(modelName);
      if (!Model) return res.status(404).json({ ok: false, message: `${modelName} model not found` });

      const id = req.params.id;
      // Special-case populate for Class and User to return consistent view to UI
      if (modelName === 'Class') {
        const docPop = await Model.findById(id)
          .populate('teacherId', 'username firstName lastName email')
          .populate('students', 'username firstName lastName email')
          .lean()
          .exec()
          .catch(() => null);
        if (!docPop) return res.status(404).json({ ok: false, message: 'Not found' });
        return res.json({ ok: true, data: docPop });
      }

      if (modelName === 'User') {
        const docPop = await Model.findById(id)
          .populate('classAssigned', 'name term')
          .populate('classAssignedMany', 'name term')
          .lean()
          .exec()
          .catch(() => null);
        if (!docPop) return res.status(404).json({ ok: false, message: 'Not found' });
        return res.json({ ok: true, data: docPop });
      }

      let doc = null;
      if (mongoose.Types.ObjectId.isValid(id)) {
        doc = await Model.findById(id).lean().exec().catch(() => null);
      }
      if (!doc) doc = await Model.findOne({ $or: [{ _id: id }, { id }, { slug: id }, { name: id }] }).lean().exec().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });
      return res.json({ ok: true, data: doc });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`GET ${pathBase}/:id error`, err);
      return res.status(500).json({ ok: false, message: 'Server error' });
    }
  });

  // Update
  router.put(`${pathBase}/:id`, async (req, res) => {
    try {
      let Model = mongoose.models[modelName] || null;
      if (!Model) Model = await ensureModelLoaded(modelName);
      if (!Model) return res.status(404).json({ ok: false, message: `${modelName} model not found` });

      const id = req.params.id;
      const body = req.body || {};
      const update = {};
      for (const k of allowedUpdate) {
        if (Object.prototype.hasOwnProperty.call(body, k)) update[k] = body[k];
      }
      if (Object.keys(update).length === 0) return res.status(400).json({ ok: false, message: 'No updatable fields provided' });

      // Load existing doc for change detection
      const existing = mongoose.Types.ObjectId.isValid(id)
        ? await Model.findById(id).lean().exec().catch(() => null)
        : await Model.findOne({ _id: id }).lean().exec().catch(() => null);

      let doc = null;
      if (mongoose.Types.ObjectId.isValid(id)) {
        doc = await Model.findByIdAndUpdate(id, update, { new: true }).lean().exec().catch(() => null);
      }
      if (!doc) doc = await Model.findOneAndUpdate({ _id: id }, update, { new: true }).lean().exec().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });

      // Sync changes when updating Class
      if (modelName === 'Class') {
        try {
          const prevTeacher = existing && existing.teacherId ? String(existing.teacherId) : null;
          const newTeacher = doc && doc.teacherId ? String(doc.teacherId) : null;
          if (prevTeacher !== newTeacher) {
            if (prevTeacher) {
              await mongoose.models.User.findByIdAndUpdate(prevTeacher, {
                $unset: { classAssigned: "" },
                $pull: { classAssignedMany: doc._id }
              }).exec().catch(() => {});
            }
            if (newTeacher) {
              await mongoose.models.User.findByIdAndUpdate(newTeacher, {
                $set: { classAssigned: doc._id },
                $addToSet: { classAssignedMany: doc._id }
              }).exec().catch(() => {});
            }
          }

          // Sync students membership differences
          const prevStudents = Array.isArray(existing && existing.students ? existing.students : []) ? (existing.students.map(String)) : [];
          const newStudents = Array.isArray(doc && doc.students ? doc.students : []) ? (doc.students.map(String)) : [];
          const toAdd = newStudents.filter(x => !prevStudents.includes(x));
          const toRemove = prevStudents.filter(x => !newStudents.includes(x));
          if (toAdd.length) {
            await mongoose.models.User.updateMany({ _id: { $in: toAdd } }, { $addToSet: { classAssignedMany: doc._id } }).exec().catch(() => {});
          }
          if (toRemove.length) {
            await mongoose.models.User.updateMany({ _id: { $in: toRemove } }, { $pull: { classAssignedMany: doc._id } }).exec().catch(() => {});
          }
        } catch (e) {
          console.warn('sync class->user (update) failed', e && e.message);
        }
      }

      // If the updated model is a User, keep Class.teacherId in sync with user.classAssigned
      if (modelName === 'User') {
        try {
          const prevClass = existing && existing.classAssigned ? String(existing.classAssigned) : null;
          const newClass = doc && doc.classAssigned ? String(doc.classAssigned) : null;
          if (prevClass !== newClass) {
            if (prevClass) {
              await mongoose.models.Class.findByIdAndUpdate(prevClass, { $unset: { teacherId: "" } }).exec().catch(() => {});
              await mongoose.models.User.findByIdAndUpdate(doc._id, { $pull: { classAssignedMany: prevClass } }).exec().catch(() => {});
            }
            if (newClass) {
              await mongoose.models.Class.findByIdAndUpdate(newClass, { $set: { teacherId: doc._id } }).exec().catch(() => {});
              await mongoose.models.User.findByIdAndUpdate(doc._id, { $addToSet: { classAssignedMany: newClass } }).exec().catch(() => {});
            }
          }
          // Note: we do not attempt full reconciliation of classAssignedMany here.
        } catch (e) {
          console.warn('sync user->class (update) failed', e && e.message);
        }
      }

      await audit(`update:${collectionName}`, req.user?.username || 'system', { id, update });
      return res.json({ ok: true, data: doc });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`PUT ${pathBase}/:id error`, err);
      return res.status(500).json({ ok: false, message: 'Server error' });
    }
  });

  // Delete
  router.delete(`${pathBase}/:id`, async (req, res) => {
    try {
      let Model = mongoose.models[modelName] || null;
      if (!Model) Model = await ensureModelLoaded(modelName);
      if (!Model) return res.status(404).json({ ok: false, message: `${modelName} model not found` });

      const id = req.params.id;
      let doc = null;
      if (mongoose.Types.ObjectId.isValid(id)) {
        doc = await Model.findByIdAndDelete(id).lean().exec().catch(() => null);
      }
      if (!doc) doc = await Model.findOneAndDelete({ _id: id }).lean().exec().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });

      // Sync: if Class deleted, remove references from Users
      if (modelName === 'Class' && doc && doc._id) {
        try {
          await mongoose.models.User.updateMany(
            { $or: [{ classAssigned: doc._id }, { classAssignedMany: doc._id }] },
            { $unset: { classAssigned: "" }, $pull: { classAssignedMany: doc._id } }
          ).exec().catch(() => {});
        } catch (e) {
          console.warn('sync class->user (delete) failed', e && e.message);
        }
      }

      await audit(`delete:${collectionName}`, req.user?.username || 'system', { id });
      return res.json({ ok: true, data: doc });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`DELETE ${pathBase}/:id error`, err);
      return res.status(500).json({ ok: false, message: 'Server error' });
    }
  });
}

/* ----------------------------
   Mount CRUD for resources
   - modelName should match mongoose.model(...) name used in your codebase
   - adjust allowedCreate/allowedUpdate fields to your schemas
   ---------------------------- */

// Classes
mountCrudFor({
  modelName: 'Class',
  collectionName: 'classes',
  allowedCreate: ['name', 'description', 'teacherId', 'students', 'term', 'meta'],
  allowedUpdate: ['name', 'description', 'teacherId', 'students', 'term', 'meta'],
  searchFields: ['name', 'title', 'description']
});

// Courses
mountCrudFor({
  modelName: 'Course',
  collectionName: 'courses',
  allowedCreate: ['title', 'code', 'desc', 'credits', 'subjects', 'meta'],
  allowedUpdate: ['title', 'code', 'desc', 'credits', 'subjects', 'meta'],
  searchFields: ['title', 'name', 'code', 'desc']
});

// Subjects
mountCrudFor({
  modelName: 'Subject',
  collectionName: 'subjects',
  allowedCreate: ['title', 'code', 'desc', 'credits', 'meta'],
  allowedUpdate: ['title', 'code', 'desc', 'credits', 'meta'],
  searchFields: ['title', 'name', 'code']
});

// Assignments
mountCrudFor({
  modelName: 'Assignment',
  collectionName: 'assignments',
  allowedCreate: ['title', 'description', 'classId', 'dueDate', 'maxScore', 'attachments', 'meta'],
  allowedUpdate: ['title', 'description', 'classId', 'dueDate', 'maxScore', 'attachments', 'meta'],
  searchFields: ['title', 'description']
});

// Messages
mountCrudFor({
  modelName: 'Message',
  collectionName: 'messages',
  allowedCreate: ['from', 'to', 'threadId', 'subject', 'text', 'participantIds', 'meta'],
  allowedUpdate: ['subject', 'text', 'meta', 'read'],
  searchFields: ['subject', 'text']
});

/* Fallback: small info endpoint for public router */
router.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'Public API router (read/write endpoints). Protect in production or set PUBLIC_API_OPEN=true for testing.',
    models: Object.keys(mongoose.models)
  });
});

export default router;
