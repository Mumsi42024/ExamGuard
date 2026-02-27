import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

export function authenticateJWT(req, res, next) {
  try {
    const authHeader = req.get('authorization') || '';
    let token = null;

    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({ ok: false, message: 'Missing authorization token' });
    }

    const payload = jwt.verify(token, JWT_SECRET);

    // Normalize common claim names to req.user.id
    const id = payload.sub || payload.id || payload.userId;
    req.user = { ...payload, id };

    next();
  } catch (err) {
    return res.status(401).json({ ok: false, message: 'Invalid or expired token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, message: 'Unauthorized' });
    if (roles.length === 0) return next();
    const userRole = req.user.role;
    if (!userRole) return res.status(403).json({ ok: false, message: 'Forbidden' });
    if (roles.includes(userRole)) return next();
    return res.status(403).json({ ok: false, message: 'Forbidden' });
  };
}
