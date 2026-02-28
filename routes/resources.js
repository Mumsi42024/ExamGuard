import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticateJWT, requireRole } from '../middleware/auth.js';

const router = express.Router();

const UPLOAD_BASE = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads', 'resources');
fs.mkdirSync(UPLOAD_BASE, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_BASE),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

const ResourceSchema = new mongoose.Schema({
  title: String,
  type: String,
  url: String,
  owner: { type: mongoose.Schema.Types.ObjectId, ref:'User' },
  meta: Object,
  createdAt: { type: Date, default: Date.now }
});
const Resource = mongoose.models.Resource || mongoose.model('Resource', ResourceSchema);

// list resources (public)
router.get('/', async (req, res) => {
  try {
    const q = {};
    if (req.query.type) q.type = req.query.type;
    const items = await Resource.find(q).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ ok: true, resources: items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// upload resource (teacher/admin)
router.post('/', authenticateJWT, requireRole('teacher','admin'), upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, message: 'File required' });
    const r = new Resource({
      title: req.body.title || file.originalname,
      type: req.body.type || file.mimetype,
      url: `/uploads/resources/${path.basename(file.path)}`,
      owner: req.user.id,
      meta: { originalName: file.originalname, size: file.size, mime: file.mimetype }
    });
    await r.save();
    res.status(201).json({ ok: true, resource: r });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// get resource
router.get('/:id', async (req, res) => {
  try {
    const r = await Resource.findById(req.params.id).lean();
    if (!r) return res.status(404).json({ ok: false, message: 'Not found' });
    res.json({ ok: true, resource: r });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

export default router;
