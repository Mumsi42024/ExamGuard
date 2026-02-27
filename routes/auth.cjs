const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { signToken, authenticateJWT, requireRole } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = Number(process.env.PW_SALT_ROUNDS) || 10;

// POST /api/auth/register
// - If ALLOW_SELF_REGISTER === 'true', anyone can register.
// - Otherwise only authenticated admin can create accounts (use admin token).
router.post('/register', authenticateIfNeeded, async (req, res) => {
  try {
    // authenticateIfNeeded will attach req.isAdminAllowed = true if admin token present,
    // or it will allow if process.env.ALLOW_SELF_REGISTER === 'true'
    const allowSelf = String(process.env.ALLOW_SELF_REGISTER) === 'true';
    if (!allowSelf && !req.isAdminAllowed) {
      return res.status(403).json({ ok: false, message: 'Registration restricted. Admin token required.' });
    }

    const body = req.body || {};
    const username = (body.username || '').trim();
    const password = body.password || '';
    if (!username || password.length < 6) {
      return res.status(400).json({ ok: false, message: 'username and password (min 6) required' });
    }
    const existing = await User.findOne({ $or: [{ username }, { email: body.email }] }).lean();
    if (existing) return res.status(409).json({ ok: false, message: 'Username or email already exists' });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const user = new User({
      username,
      email: body.email,
      passwordHash,
      role: body.role || 'student',
      firstName: body.firstName,
      lastName: body.lastName,
      phone: body.phone
    });

    await user.save();
    const token = signToken(user);
    res.status(201).json({ ok: true, token, user: user.toSafeObject() });
  } catch (err) {
    console.error('register error', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// helper middleware: if bearer token present and is admin, set req.isAdminAllowed = true.
// Otherwise do nothing. This allows admins to create accounts using admin token.
async function authenticateIfNeeded(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return next();
  const token = m[1];
  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload && payload.sub) {
      const user = await User.findById(payload.sub).lean();
      if (user && user.role === 'admin') {
        req.isAdminAllowed = true;
      }
    }
  } catch (err) {
    // ignore - not fatal for registration; registration may still be allowed by env flag
    console.warn('authenticateIfNeeded: token verify failed');
  }
  next();
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const body = req.body || {};
    const usernameOrEmail = (body.username || body.email || '').trim();
    const password = body.password || '';
    if (!usernameOrEmail || !password) return res.status(400).json({ ok: false, message: 'username/email and password required' });

    const user = await User.findOne({
      $or: [{ username: usernameOrEmail }, { email: usernameOrEmail }]
    });
    if (!user) return res.status(401).json({ ok: false, message: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ ok: false, message: 'Invalid credentials' });

    const token = signToken(user);
    res.json({ ok: true, token, user: user.toSafeObject() });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', authenticateJWT, async (req, res) => {
  // authenticateJWT already attached req.user
  res.json({ ok: true, user: req.user });
});

// Example protected route to demonstrate role middleware:
// GET /api/auth/admin-only
router.get('/admin-only', authenticateJWT, requireRole('admin'), (req, res) => {
  res.json({ ok: true, message: 'Hello admin', user: req.user });
});

module.exports = router;
