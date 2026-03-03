'use strict';

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import Application from '../models/Application.js';
import User from '../models/User.js';
import { authenticateJWT } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const UPLOAD_BASE = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads', 'applications');
fs.mkdirSync(UPLOAD_BASE, { recursive: true });

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

// Multer storage — store files in uploads/applications with safe filenames
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_BASE);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  }
});

// Accept only pdf/image and limit 8MB per file (reused for profile pic too)
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF and image files are allowed'));
  }
});

// Fields expected by the application form
const cpUpload = upload.fields([
  { name: 'idFile', maxCount: 1 },
  { name: 'transcripts', maxCount: 10 }
]);

// Helper to map multer file objects to small file descriptors
function mapFile(f) {
  return {
    filename: f.filename,
    originalName: f.originalname,
    mimeType: f.mimetype,
    size: f.size,
    path: path.relative(process.cwd(), f.path)
  };
}

function safeApplication(appDoc) {
  if (!appDoc) return null;
  const a = typeof appDoc.toObject === 'function' ? appDoc.toObject() : appDoc;
  return {
    id: a._id && String(a._id),
    _id: a._0 && String(a._id),
    username: a.username,
    firstName: a.firstName,
    lastName: a.lastName,
    dob: a.dob,
    email: a.email,
    phone: a.phone,
    nationality: a.nationality,
    address: a.address,
    intakeTerm: a.intakeTerm,
    program: a.program,
    currentSchool: a.currentSchool,
    currentGrade: a.currentGrade,
    prevAcademics: a.prevAcademics,
    idFiles: (a.idFiles || []).map(f => ({ filename: f.filename, originalName: f.originalName, mimeType: f.mimeType, size: f.size, path: f.path })),
    transcripts: (a.transcripts || []).map(f => ({ filename: f.filename, originalName: f.originalName, mimeType: f.mimeType, size: f.size, path: f.path })),
    profilePic: a.profilePic || a.profilePicPath || null,
    languageProof: a.languageProof,
    emergencyName: a.emergencyName,
    emergencyPhone: a.emergencyPhone,
    agree: a.agree,
    status: a.status,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    usernameAvailable: !!a.username
  };
}

// Helper to resolve a user (student) by id or username, prefer User model then fall back to Application
async function findStudentByIdOrUsername(idOrUsername) {
  if (!idOrUsername) return null;

  // Prefer User model (your existing model) when resolving
  try {
    if (mongoose.Types.ObjectId.isValid(idOrUsername)) {
      const u = await User.findById(idOrUsername).lean().exec().catch(() => null);
      if (u) return u;
      const appById = await Application.findById(idOrUsername).lean().exec().catch(() => null);
      if (appById) return appById;
    }

    // try username on User
    const uName = await User.findOne({ username: idOrUsername }).lean().exec().catch(() => null);
    if (uName) return uName;

    // fallback: Application username
    const appByUsername = await Application.findOne({ username: idOrUsername }).lean().exec().catch(() => null);
    if (appByUsername) return appByUsername;
  } catch (e) {
    // ignore and return null
    console.warn('findStudentByIdOrUsername error', e && e.message);
  }
  return null;
}

/* -----------------------
   Basic application endpoints
   ----------------------- */

// POST /api/application  — accepts multipart/form-data
router.post('/', cpUpload, async (req, res) => {
  try {
    const body = req.body || {};
    const required = ['username', 'password', 'firstName', 'lastName', 'email'];
    for (const k of required) {
      if (!body[k] || String(body[k]).trim() === '') {
        return res.status(400).json({ ok: false, message: `${k} is required` });
      }
    }

    const existing = await Application.findOne({ username: body.username }).lean().exec();
    if (existing) return res.status(409).json({ ok: false, message: 'Username already in use' });

    const saltRounds = Number(process.env.PW_SALT_ROUNDS) || 10;
    const passwordHash = await bcrypt.hash(body.password, saltRounds);

    const idFiles = (req.files && req.files['idFile']) ? req.files['idFile'].map(mapFile) : [];
    const transcripts = (req.files && req.files['transcripts']) ? req.files['transcripts'].map(mapFile) : [];

    const appDoc = new Application({
      applicantType: body.applicantType || body['applicant-type'] || 'national',
      username: body.username,
      passwordHash,
      firstName: body.firstName,
      lastName: body.lastName,
      dob: body.dob ? new Date(body.dob) : undefined,
      email: body.email,
      phone: body.phone,
      nationality: body.nationality,
      address: body.address,
      intakeTerm: body.intakeTerm || body['intake-term'] || undefined,
      program: body.program,
      currentSchool: body.currentSchool || body['current-school'],
      currentGrade: body.currentGrade || body['current-grade'],
      prevAcademics: body.prevAcademics || body['prev-academics'],
      idFiles,
      transcripts,
      languageProof: body.languageProof || body['language-proof'],
      emergencyName: body.emergencyName || body['emergency-name'],
      emergencyPhone: body.emergencyPhone || body['emergency-phone'],
      agree: body.agree === '1' || body.agree === 'true' || body.agree === 'on',
      status: 'submitted',
      sourceIp: req.ip
    });

    await appDoc.save();
    res.status(201).json({ ok: true, application: safeApplication(appDoc) });
  } catch (err) {
    console.error('application POST error', err);
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    res.status(500).json({ ok: false, message: err.message || 'Server error' });
  }
});

// POST /api/application/login
router.post('/login', async (req, res) => {
  try {
    const body = req.body || {};
    const usernameOrEmail = (body.username || body.email || '').trim();
    const password = body.password || '';

    if (!usernameOrEmail || !password) {
      return res.status(400).json({ ok: false, message: 'username/email and password required' });
    }

    const app = await Application.findOne({
      $or: [{ username: usernameOrEmail }, { email: usernameOrEmail }]
    }).exec();

    if (!app) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, app.passwordHash);
    if (!match) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    const safeApp = safeApplication(app);
    const payload = { id: app._id.toString(), username: app.username, email: app.email };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    return res.json({ ok: true, application: safeApp, token });
  } catch (err) {
    console.error('application login error', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /api/application/me  — current authenticated application
router.get('/me', authenticateJWT, async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, message: 'Unauthenticated' });

    const id = user.id || user._id || user.sub || user.username;
    if (!id) return res.status(400).json({ ok: false, message: 'Invalid token payload' });

    let app = null;
    if (Application && Application.findById && (id.match && id.match(/^[0-9a-fA-F]{24}$/))) {
      app = await Application.findById(id).lean().exec();
    }
    if (!app) app = await Application.findOne({ username: id }).lean().exec();

    if (!app) return res.status(404).json({ ok: false, message: 'Not found' });

    return res.json({ ok: true, application: safeApplication(app) });
  } catch (err) {
    console.error('GET /application/me error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch profile' });
  }
});

// PUT /api/application/:id  — update profile (supports profilePic upload)
router.put('/:id', upload.single('profilePic'), authenticateJWT, async (req, res) => {
  try {
    const idOrUsername = req.params.id;
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, message: 'Unauthenticated' });

    const tokenOwnerId = user.id || user._id || user.sub || user.username;
    if (!tokenOwnerId) return res.status(401).json({ ok: false, message: 'Invalid token' });

    // Find application record
    let app = null;
    if (mongoose.Types.ObjectId.isValid(idOrUsername)) {
      app = await Application.findById(idOrUsername);
    }
    if (!app) app = await Application.findOne({ username: idOrUsername });
    if (!app) return res.status(404).json({ ok: false, message: 'Not found' });

    if (String(app._id) !== String(tokenOwnerId) && app.username !== tokenOwnerId) {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }

    const allowed = ['firstName','lastName','email','phone','program','address','bio','intakeTerm','currentSchool','currentGrade'];
    const body = req.body || {};
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, k) && typeof body[k] !== 'undefined') {
        app[k] = body[k];
      }
    }

    if (req.file) {
      const desc = {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        path: path.relative(process.cwd(), req.file.path)
      };
      app.profilePic = desc.path;
      app.profilePicMeta = desc;
    }

    await app.save();
    return res.json({ ok: true, application: safeApplication(app) });
  } catch (err) {
    console.error('application PUT error', err);
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// PUT /api/application/:id/password  — change password
router.put('/:id/password', authenticateJWT, async (req, res) => {
  try {
    const idOrUsername = req.params.id;
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, message: 'Unauthenticated' });

    const tokenOwnerId = user.id || user._id || user.sub || user.username;
    if (!tokenOwnerId) return res.status(401).json({ ok: false, message: 'Invalid token' });

    let app = null;
    if (mongoose.Types.ObjectId.isValid(idOrUsername)) app = await Application.findById(idOrUsername);
    if (!app) app = await Application.findOne({ username: idOrUsername });
    if (!app) return res.status(404).json({ ok: false, message: 'Not found' });

    if (String(app._id) !== String(tokenOwnerId) && app.username !== tokenOwnerId) {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }

    const body = req.body || {};
    const currentPassword = body.currentPassword || body.current || body.current_password;
    const newPassword = body.newPassword || body.new_password || body.new;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ ok: false, message: 'currentPassword and newPassword are required' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ ok: false, message: 'New password must be at least 6 characters' });
    }

    const match = await bcrypt.compare(currentPassword, app.passwordHash);
    if (!match) return res.status(401).json({ ok: false, message: 'Invalid credentials' });

    const saltRounds = Number(process.env.PW_SALT_ROUNDS) || 10;
    const hash = await bcrypt.hash(newPassword, saltRounds);
    app.passwordHash = hash;
    await app.save();

    return res.json({ ok: true, message: 'Password updated' });
  } catch (err) {
    console.error('application password change error', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /api/application/:id  — get profile (no auth required)
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let app = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      app = await Application.findById(id).select('-passwordHash').lean().exec();
    }
    if (!app) app = await Application.findOne({ username: id }).select('-passwordHash').lean().exec();
    if (!app) return res.status(404).json({ ok: false, message: 'Not found' });
    res.json({ ok: true, application: safeApplication(app) });
  } catch (err) {
    console.error('application GET error', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

/* -----------------------
   Student-facing endpoints used by the frontend
   ----------------------- */

// Try to reuse models if present; otherwise handlers return empty arrays
const UserModel = mongoose.models.User || User;
const CourseModel = mongoose.models.Course || null;
const AssignmentModel = mongoose.models.Assignment || null;
const GradeModel = mongoose.models.Grade || null;
const TimetableModel = mongoose.models.Timetable || null;
const ResourceModel = mongoose.models.Resource || null;
const MessageModel = mongoose.models.Message || null;

// GET /api/application/student/overview?studentId=...
router.get('/student/overview', async (req, res) => {
  try {
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ ok: false, message: 'studentId is required' });

    const student = await findStudentByIdOrUsername(studentId);

    const [coursesCount, assignmentsCount, unreadMessages] = await Promise.all([
      CourseModel ? CourseModel.countDocuments({ $or: [{ studentId }, { students: student ? student._id : undefined }] }).catch(() => 0) : 0,
      AssignmentModel ? AssignmentModel.countDocuments({ $or: [{ studentId }, { assignees: student ? student._id : undefined }] }).catch(() => 0) : 0,
      MessageModel ? MessageModel.countDocuments({ $or: [{ to: studentId }, { participantIds: student ? student._id : undefined }], read: false }).catch(() => 0) : 0
    ]);

    const overview = {
      student: student ? safeApplication(student) : { id: studentId },
      coursesCount: Number(coursesCount || 0),
      assignmentsCount: Number(assignmentsCount || 0),
      unreadMessages: Number(unreadMessages || 0),
      upcoming: []
    };

    return res.json({ ok: true, overview });
  } catch (err) {
    console.error('GET /student/overview error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch overview' });
  }
});

// GET /api/application/student/timetable?studentId=...
router.get('/student/timetable', async (req, res) => {
  try {
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ ok: false, message: 'studentId is required' });

    const items = TimetableModel ? await TimetableModel.find({ $or: [{ studentId }, { students: studentId }] }).sort({ day: 1, start: 1 }).lean().exec().catch(() => []) : [];

    return res.json({ ok: true, timetable: items || [] });
  } catch (err) {
    console.error('GET /student/timetable error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch timetable' });
  }
});

// GET /api/application/student/courses?studentId=...
router.get('/student/courses', async (req, res) => {
  try {
    const { studentId, limit = 100, offset = 0 } = req.query;
    if (!studentId) return res.status(400).json({ ok: false, message: 'studentId is required' });

    const l = Math.min(500, Number(limit) || 100);
    const o = Math.max(0, Number(offset) || 0);

    const courses = CourseModel ? await CourseModel.find({ $or: [{ studentId }, { students: studentId }] }).skip(o).limit(l).lean().exec().catch(() => []) : [];

    return res.json({ ok: true, courses: courses || [] });
  } catch (err) {
    console.error('GET /student/courses error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch courses' });
  }
});

// GET /api/application/student/grades?studentId=...
router.get('/student/grades', async (req, res) => {
  try {
    const { studentId, limit = 200, offset = 0 } = req.query;
    if (!studentId) return res.status(400).json({ ok: false, message: 'studentId is required' });

    const l = Math.min(1000, Number(limit) || 200);
    const o = Math.max(0, Number(offset) || 0);

    const grades = GradeModel ? await GradeModel.find({ studentId }).skip(o).limit(l).lean().exec().catch(() => []) : [];

    return res.json({ ok: true, grades: grades || [] });
  } catch (err) {
    console.error('GET /student/grades error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch grades' });
  }
});

// GET /api/application/student/assignments?studentId=...
router.get('/student/assignments', async (req, res) => {
  try {
    const { studentId, limit = 100, offset = 0 } = req.query;
    if (!studentId) return res.status(400).json({ ok: false, message: 'studentId is required' });

    const l = Math.min(500, Number(limit) || 100);
    const o = Math.max(0, Number(offset) || 0);

    const assignments = AssignmentModel ? await AssignmentModel.find({ $or: [{ studentId }, { assignees: studentId }] }).sort({ dueDate: 1 }).skip(o).limit(l).lean().exec().catch(() => []) : [];

    return res.json({ ok: true, assignments: assignments || [] });
  } catch (err) {
    console.error('GET /student/assignments error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch assignments' });
  }
});

// GET /api/application/resources?studentId=...
router.get('/resources', async (req, res) => {
  try {
    const { studentId, q, limit = 100, offset = 0 } = req.query;
    const l = Math.min(500, Number(limit) || 100);
    const o = Math.max(0, Number(offset) || 0);

    let docs = [];
    if (ResourceModel) {
      const qobj = {};
      if (q) {
        const re = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        qobj.$or = [{ title: re }, { desc: re }, { tags: re }];
      }
      if (studentId) {
        qobj.$or = qobj.$or ? qobj.$or.concat([{ studentId }, { students: studentId }]) : [{ studentId }, { students: studentId }];
      }
      docs = await ResourceModel.find(qobj).skip(o).limit(l).lean().exec().catch(() => []);
    }

    return res.json({ ok: true, resources: docs || [] });
  } catch (err) {
    console.error('GET /resources error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch resources' });
  }
});

// GET /api/application/messages/conversations?user=...
router.get('/messages/conversations', async (req, res) => {
  try {
    const { user } = req.query;
    if (!user) return res.status(400).json({ ok: false, message: 'user is required' });

    let convos = [];
    if (MessageModel) {
      convos = await MessageModel.aggregate([
        { $match: { $or: [{ to: user }, { from: user }, { participantIds: user }] } },
        {
          $group: {
            _id: '$threadId',
            lastMessage: { $last: '$createdAt' },
            snippet: { $last: '$text' },
            participants: { $first: '$participantIds' }
          }
        },
        { $sort: { lastMessage: -1 } },
        { $limit: 200 }
      ]).catch(async () => {
        const msgs = await MessageModel.find({ $or: [{ to: user }, { from: user }, { participantIds: user }] }).sort({ createdAt: -1 }).lean().exec().catch(() => []);
        const map = new Map();
        msgs.forEach(m => {
          const key = m.threadId || (m.conversationId || m._id);
          if (!map.has(key)) map.set(key, { threadId: key, lastMessage: m.createdAt, snippet: m.text, participants: m.participantIds || [m.from, m.to] });
        });
        return Array.from(map.values()).sort((a, b) => new Date(b.lastMessage) - new Date(a.lastMessage));
      });
    }

    return res.json({ ok: true, conversations: convos || [] });
  } catch (err) {
    console.error('GET /messages/conversations error', err);
    return res.status(500).json({ ok: false, message: 'Failed to fetch conversations' });
  }
});

export default router;
