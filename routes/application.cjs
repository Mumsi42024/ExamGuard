const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Application = require('../models/Application');

const UPLOAD_BASE = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads', 'applications');
fs.mkdirSync(UPLOAD_BASE, { recursive: true });

// Multer storage — store files in uploads/applications with safe filenames
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_BASE);
  },
  filename: (req, file, cb) => {
    // Use timestamp + sanitized original name
    const safe = file.originalname.replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${safe}`);
  }
});

// Accept only pdf/image and limit 8MB per file
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
  { name: 'idFile', maxCount: 1 },       // id-file input -> name="idFile"
  { name: 'transcripts', maxCount: 10 }  // transcripts input -> name="transcripts"
]);

// Helper to map multer file objects to small file descriptors
function mapFile(f) {
  return {
    filename: f.filename,
    originalName: f.originalname,
    mimeType: f.mimetype,
    size: f.size,
    path: path.relative(process.cwd(), f.path) // store a relative path
  };
}

// POST /api/application  — accepts multipart/form-data
router.post('/', cpUpload, async (req, res) => {
  try {
    // Basic validation
    const body = req.body || {};
    const required = ['username', 'password', 'firstName', 'lastName', 'email'];
    for (const k of required) {
      if (!body[k] || String(body[k]).trim() === '') {
        return res.status(400).json({ ok: false, message: `${k} is required` });
      }
    }

    // Prevent duplicate username
    const existing = await Application.findOne({ username: body.username }).lean();
    if (existing) return res.status(409).json({ ok: false, message: 'Username already in use' });

    // Hash password
    const saltRounds = Number(process.env.PW_SALT_ROUNDS) || 10;
    const passwordHash = await bcrypt.hash(body.password, saltRounds);

    // Collect file metadata
    const idFiles = (req.files && req.files['idFile']) ? req.files['idFile'].map(mapFile) : [];
    const transcripts = (req.files && req.files['transcripts']) ? req.files['transcripts'].map(mapFile) : [];

    // Construct application doc
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

    // (Optional) send confirmation email here if your app supports it
    // Example: sendEmail({ to: appDoc.email, subject: 'Application received', text: 'We received...' });

    res.status(201).json({ ok: true, application: { id: appDoc._id, username: appDoc.username, status: appDoc.status } });
  } catch (err) {
    console.error('application POST error', err);
    // multer file size / filter errors will surface here
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    res.status(500).json({ ok: false, message: err.message || 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const body = req.body || {};
    const usernameOrEmail = (body.username || body.email || '').trim();
    const password = body.password || '';

    if (!usernameOrEmail || !password) {
      return res.status(400).json({ ok: false, message: 'username/email and password required' });
    }

    // Find application by username or email
    const app = await Application.findOne({
      $or: [{ username: usernameOrEmail }, { email: usernameOrEmail }]
    });

    if (!app) {
      // Do not reveal whether username or password was incorrect
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, app.passwordHash);
    if (!match) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    // Build a safe application object to return (do not include passwordHash or server file paths)
    const safeApp = {
      id: app._id.toString(),
      username: app.username,
      firstName: app.firstName,
      lastName: app.lastName,
      dob: app.dob,
      email: app.email,
      phone: app.phone,
      nationality: app.nationality,
      address: app.address,
      intakeTerm: app.intakeTerm,
      program: app.program,
      currentSchool: app.currentSchool,
      currentGrade: app.currentGrade,
      prevAcademics: app.prevAcademics,
      idFiles: (app.idFiles || []).map(f => ({ filename: f.filename, originalName: f.originalName, mimeType: f.mimeType, size: f.size })),
      transcripts: (app.transcripts || []).map(f => ({ filename: f.filename, originalName: f.originalName, mimeType: f.mimeType, size: f.size })),
      languageProof: app.languageProof,
      emergencyName: app.emergencyName,
      emergencyPhone: app.emergencyPhone,
      agree: app.agree,
      status: app.status,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt
    };

    return res.json({ ok: true, application: safeApp });
  } catch (err) {
    console.error('application login error', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /api/application/:id  — simple retrieval (no auth). You can add auth middleware if required.
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const app = await Application.findById(id).select('-passwordHash').lean();
    if (!app) return res.status(404).json({ ok: false, message: 'Not found' });
    res.json({ ok: true, application: app });
  } catch (err) {
    console.error('application GET error', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

module.exports = router;
