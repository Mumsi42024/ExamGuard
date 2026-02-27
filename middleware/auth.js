const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// verify token, attach user to req.user
async function authenticateJWT(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return res.status(401).json({ ok: false, message: 'Missing authorization token' });
    }
    const token = m[1];
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ ok: false, message: 'Invalid or expired token' });
    }
    // payload expected to contain { sub: userId, role }
    if (!payload || !payload.sub) return res.status(401).json({ ok: false, message: 'Invalid token payload' });

    const user = await User.findById(payload.sub).select('-passwordHash').lean();
    if (!user) return res.status(401).json({ ok: false, message: 'User not found' });

    req.user = user;
    next();
  } catch (err) {
    console.error('authenticateJWT error', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
}

// require at least one of the provided roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, message: 'Not authenticated' });
    if (roles.length === 0) return next();
    if (roles.includes(req.user.role)) return next();
    return res.status(403).json({ ok: false, message: 'Insufficient permissions' });
  };
}

// create token
function signToken(user) {
  const payload = { sub: user._id.toString(), role: user.role };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

module.exports = {
  authenticateJWT,
  requireRole,
  signToken
};
