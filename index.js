'use strict';

import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import http from 'http';
import url from 'url';
import { createRequire } from 'module';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import xss from 'xss-clean';
import hpp from 'hpp';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';

const require = createRequire(import.meta.url);

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- Config (with sane defaults) ---
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/examguide';
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';

// Use require() for existing CommonJS route files (minimal changes)
const examsRouter = require('./routes/exams');
const aiRouter = require('./routes/ai');
const submissionsRouter = require('./routes/submissions');
const invoicesRouter = require('./routes/invoices');
const resourcesRouter = require('./routes/resources');
const messagesRouter = require('./routes/messages');
const assignmentsRouter = require('./routes/assignments');
const timetableRouter = require('./routes/timetable');
const studentsRouter = require('./routes/students');
const resultsRouter = require('./routes/results');

// create directories if needed
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// optionally trust proxy (when behind load balancer)
if (TRUST_PROXY) app.set('trust proxy', 1);

// --- Logging ---
const accessLogStream = fs.createWriteStream(path.join(LOG_DIR, 'access.log'), { flags: 'a' });
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev', {
  stream: NODE_ENV === 'production' ? accessLogStream : process.stdout
}));

// --- Security middlewares ---
app.disable('x-powered-by');
app.use(helmet());
app.use(mongoSanitize());
app.use(xss());
app.use(hpp());
app.use(compression());
app.use(cookieParser());

// CORS configuration - prefer exact origin list in production
const corsOptions = {
  origin: function (origin, callback) {
    // allow non-browser clients with no origin (curl, mobile)
    if (!origin) return callback(null, true);
    if (CORS_ORIGINS.length === 0) return callback(null, true); // permissive if not configured
    if (CORS_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
    return callback(new Error('CORS policy: origin not allowed'));
  },
  credentials: process.env.CORS_ALLOW_CREDENTIALS === 'true' || false,
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: process.env.RATE_LIMIT_GLOBAL ? Number(process.env.RATE_LIMIT_GLOBAL) : 300, // requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Too many requests, try again later.' }
});
app.use(globalLimiter);

// stricter limiter for auth routes (applied on router)
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.RATE_LIMIT_AUTH ? Number(process.env.RATE_LIMIT_AUTH) : 30,
  message: { ok: false, message: 'Too many authentication attempts, try again later.' }
});

// --- Static file serving ---
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

// --- Health & readiness ---
app.get('/healthz', (req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));
app.get('/ready', (req, res) => {
  const ready = mongoose.connection.readyState === 1; // 1 = connected
  res.status(ready ? 200 : 503).json({ ok: ready });
});

// --- Mongoose connection ---
mongoose.set('strictQuery', false);
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000
}).then(() => {
  console.log('MongoDB connected');
}).catch(err => {
  console.error('MongoDB connection error', err);
  process.exit(1);
});

// --- Import routers (ensure these files exist) ---
// keep auth and application as CommonJS requires too
const authRouter = require('./routes/auth');
const applicationRouter = require('./routes/application');

// mount auth router with auth-specific rate limiter
app.use('/api/auth', authLimiter, authRouter);

// mount application route (multipart handling done in router)
app.use('/api/application', applicationRouter);

// --- Example simple admin endpoints (optional quick info) ---
app.get('/api/info', (req, res) => {
  res.json({
    ok: true,
    service: 'ExamGuard API',
    env: NODE_ENV,
    version: process.env.npm_package_version || null
  });
});

// --- 404 handler ---
app.use((req, res, next) => {
  res.status(404).json({ ok: false, message: 'Not found' });
});

// --- Error handler (JSON) ---
/* eslint-disable no-unused-vars */
app.use('/api/exams', examsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/submissions', submissionsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/resources', resourcesRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/assignments', assignmentsRouter);
app.use('/api/timetable', timetableRouter);
app.use('/api/students', studentsRouter);
app.use('/api/results', resultsRouter);
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  const status = err.status || 500;
  const message = (NODE_ENV === 'production' && status === 500) ? 'Internal server error' : (err.message || 'Server error');
  res.status(status).json({ ok: false, message });
});
/* eslint-enable no-unused-vars */

// --- Start server with graceful shutdown ---
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`ExamGuard API running on port ${PORT} (env=${NODE_ENV})`);
});

// Graceful shutdown
function shutdown(sig) {
  return async () => {
    console.log(`Received ${sig}. Shutting down gracefully...`);
    server.close(async (err) => {
      if (err) {
        console.error('Server close error', err);
        process.exit(1);
      }
      try {
        await mongoose.disconnect();
        console.log('MongoDB disconnected');
      } catch (e) {
        console.warn('Error disconnecting MongoDB', e);
      }
      process.exit(0);
    });

    // Force exit if not closed in time
    setTimeout(() => {
      console.warn('Forcing shutdown');
      process.exit(1);
    }, 30_000);
  };
}

process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));

// Export app for testing (ESM)
export default app;
