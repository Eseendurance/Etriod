require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { PostgresRateLimitStore } = require('./rateLimitStore');

const { healthCheck, shutdown } = require('./db');
const { captureException, expressErrorHandler } = require('./errorTracking');
const authRoutes = require('./routes/auth');
const conversationRoutes = require('./routes/conversations');
const chatRoutes = require('./routes/chat');
const settingsRoutes = require('./routes/settings');
const billingRoutes = require('./routes/billing');
const waitlistRoutes = require('./routes/waitlist');
const adminRoutes = require('./routes/admin');
const companyRoutes = require('./routes/company');
const cronRoutes = require('./routes/cron');

const app = express();
app.set('trust proxy', 1); // needed for correct client IPs behind a load balancer (Railway/Render/etc), which rate limiting relies on

app.use(helmet());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  credentials: true
}));

// Payment webhooks use provider signatures over the original request body.
// Parse those endpoints before express.json() so the bytes remain verifiable.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billingRoutes.stripeWebhookHandler);
app.post('/api/billing/flutterwave/webhook', express.raw({ type: 'application/json' }), billingRoutes.flutterwaveWebhookHandler);
app.post('/api/billing/paystack/webhook', express.raw({ type: 'application/json' }), billingRoutes.paystackWebhookHandler);

app.use(express.json({ limit: '100kb' }));
app.use('/api/cron', cronRoutes);

// Rate limits: generous defaults, tightened specifically on the endpoints
// that either cost real money (chat) or are classic brute-force targets (auth).
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  store: new PostgresRateLimitStore('general')
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
  store: new PostgresRateLimitStore('auth')
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: "You're sending messages faster than we can keep up — please slow down a little." },
  store: new PostgresRateLimitStore('chat')
});

app.use('/api/', generalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/request-password-reset', authLimiter);
app.use('/api/auth/resend-verification', authLimiter);
app.use('/api/conversations/:id/messages', chatLimiter);
app.use('/api/conversations/:id/stream', chatLimiter);

app.get('/health', async (req, res) => {
  try {
    await healthCheck();
    res.json({ ok: true, db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'unreachable', error: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/conversations', chatRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/company', companyRoutes);

app.use(express.static(path.join(__dirname, '..', 'client'), {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    }
  }
}));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'landing.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(expressErrorHandler);
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

let server;
function start() {
  const port = process.env.PORT || 3000;
  server = app.listen(port, () => {
    console.log(`ETriod API listening on port ${port}`);
    if (!process.env.DATABASE_URL) console.warn('⚠️  DATABASE_URL not set — see .env.example');
    console.log(`Private AI endpoint: ${process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'} (${process.env.OLLAMA_MODEL || 'llama3.2:3b'})`);
    if (!process.env.STRIPE_SECRET_KEY) console.warn('⚠️  STRIPE_SECRET_KEY not set — billing will not work until it is');
    if (!process.env.SMTP_HOST) console.warn('ℹ️  SMTP_HOST not set — password reset emails will log to the console instead of sending');
  });
  return server;
}

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish, then close the database pool cleanly. Matters for zero-downtime
// deploys on any platform that sends SIGTERM before killing the process.
function gracefulShutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  generalLimiter.store.shutdown();
  authLimiter.store.shutdown();
  chatLimiter.store.shutdown();
  if (!server) return shutdown().then(() => process.exit(0));
  server.close(async () => {
    await shutdown();
    console.log('Shutdown complete.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}
if (require.main === module) {
  process.on('uncaughtException', (err) => captureException(err, { source: 'uncaughtException' }));
  process.on('unhandledRejection', (reason) => captureException(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' }));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  start();
}

module.exports = { app, start };
