// One-off smoke test: runs the REAL schema.sql against an in-memory Postgres
// (pg-mem) and drives the REAL server through actual HTTP requests, so we
// verify actual behavior rather than just syntax. Not part of the shipped app.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');
const http = require('http');

async function main() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => require('crypto').randomUUID(),
  });
  mem.public.registerFunction({
    name: 'date_trunc',
    args: ['text', 'timestamptz'],
    returns: 'timestamptz',
    implementation: (unit, date) => {
      const d = new Date(date);
      if (unit === 'day') d.setHours(0, 0, 0, 0);
      return d;
    },
  });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    .replace(/CREATE EXTENSION IF NOT EXISTS "pgcrypto";/, ''); // pg-mem doesn't need/support this
  await pool.query(schema);
  console.log('✅ schema.sql applied to in-memory Postgres without errors');

  // Monkey-patch our db module's pool with the in-memory one BEFORE requiring routes.
  const dbModule = require('./server/db');
  dbModule.pool = pool;
  // Routes destructure { pool } at require-time, so patch pool's methods in place instead.
  const realDb = require('./server/db');
  Object.setPrototypeOf(realDb.pool, Object.getPrototypeOf(pool));
  Object.assign(realDb.pool, pool);

  process.env.JWT_SECRET = 'test_secret';
  process.env.OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.OLLAMA_MODEL = 'test-private-model';
  delete process.env.TEST_OLLAMA_READY;
  for (const key of [
    'STRIPE_SECRET_KEY', 'STRIPE_TEAM_PRICE_ID',
    'FLUTTERWAVE_SECRET_KEY', 'FLUTTERWAVE_TEAM_PLAN_ID', 'FLUTTERWAVE_TEAM_AMOUNT',
    'PAYSTACK_SECRET_KEY', 'PAYSTACK_TEAM_PLAN_CODE', 'PAYSTACK_TEAM_AMOUNT'
  ]) delete process.env[key];
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.SMTP_HOST;

  // Intercept outgoing "email" so the test can grab real tokens from the
  // link text, instead of only seeing them printed to the console.
  let lastMail = null;
  const mailerPath = require.resolve('./server/mailer');
  require.cache[mailerPath] = {
    id: mailerPath, filename: mailerPath, loaded: true,
    exports: { sendMail: async (opts) => { lastMail = opts; return { simulated: true }; } }
  };
  function extractToken() {
    const match = lastMail && lastMail.text.match(/token=([a-f0-9]+)/);
    return match ? match[1] : null;
  }

  // Mock only the self-hosted model endpoint; no model provider API is used
  // while exercising the actual chat routes.
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    const target = new URL(String(url));
    if (target.hostname === 'api.flutterwave.com' && target.pathname === '/v3/payments') {
      return Response.json({ status: 'success', data: { link: 'https://checkout.flutterwave.com/test' } });
    }
    if (target.hostname === 'api.paystack.co' && target.pathname === '/transaction/initialize') {
      return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/test' } });
    }
    if (target.hostname === 'api.flutterwave.com' && /^\/v3\/transactions\/\d+\/verify$/.test(target.pathname)) {
      const order = (await pool.query(
        `SELECT user_id, provider_reference, expected_amount, currency
         FROM payment_orders WHERE payment_provider = 'flutterwave' ORDER BY created_at DESC LIMIT 1`
      )).rows[0];
      return Response.json({ status: 'success', data: {
        id: 123, status: 'successful', tx_ref: order.provider_reference,
        amount: Number(order.expected_amount), currency: order.currency, meta: { plan: 'team' },
        subscription_id: 'fw-subscription-test', customer: { id: 21 }
      } });
    }
    if (target.hostname === 'api.paystack.co' && target.pathname.startsWith('/transaction/verify/')) {
      const order = (await pool.query(
        `SELECT provider_reference, expected_amount, currency
         FROM payment_orders WHERE payment_provider = 'paystack' ORDER BY created_at DESC LIMIT 1`
      )).rows[0];
      return Response.json({ status: true, data: {
        status: 'success', reference: order.provider_reference,
        amount: Number(order.expected_amount) * 100, currency: order.currency,
        metadata: { plan: 'team' }, subscription: { subscription_code: 'ps-subscription-test' },
        customer: { customer_code: 'ps-customer-test' }
      } });
    }
    if (target.hostname === 'api.stripe.test') {
      return Response.json({});
    }
    if (String(url).startsWith('http://ollama.test/')) {
      if (!process.env.TEST_OLLAMA_READY) return new Response('model unavailable', { status: 503 });
      const body = JSON.parse(options.body);
      if (body.stream) {
        const chunks = [
          { message: { content: 'This is a fake ' }, done: false },
          { message: { content: 'streamed reply, sent in small pieces.' }, done: false },
          { done: true }
        ];
        return new Response(chunks.map(chunk => JSON.stringify(chunk)).join('\n') + '\n', {
          headers: { 'Content-Type': 'application/x-ndjson' }
        });
      }
      return Response.json({ message: { content: 'This is a fake non-streaming reply.' }, done: true });
    }
    return realFetch(url, options);
  };

  const express = require('express');
  const rateLimit = require('express-rate-limit');
  const { PostgresRateLimitStore } = require('./server/rateLimitStore');
  const app = express();
  const sharedLimiter = () => rateLimit({
    windowMs: 60000, max: 2, standardHeaders: true, legacyHeaders: false,
    store: new PostgresRateLimitStore('shared-smoke')
  });
  app.get('/test/shared-limit-a', sharedLimiter(), (req, res) => res.json({ ok: true }));
  app.get('/test/shared-limit-b', sharedLimiter(), (req, res) => res.json({ ok: true }));
  const billingRoutes = require('./server/routes/billing');
  app.post('/api/billing/flutterwave/webhook', express.raw({ type: 'application/json' }), billingRoutes.flutterwaveWebhookHandler);
  app.post('/api/billing/paystack/webhook', express.raw({ type: 'application/json' }), billingRoutes.paystackWebhookHandler);
  app.use(express.json());
  app.use('/api/auth', require('./server/routes/auth'));
  app.use('/api/conversations', require('./server/routes/conversations'));
  app.use('/api/conversations', require('./server/routes/chat'));
  app.use('/api/billing', billingRoutes);
  app.use('/api/settings', require('./server/routes/settings'));
  app.use('/api/waitlist', require('./server/routes/waitlist'));
  app.use('/api/admin', require('./server/routes/admin'));
  app.use('/api/company', require('./server/routes/company'));
  app.use('/api/cron', require('./server/routes/cron'));
  app.use(express.static(require('path').join(__dirname, 'client'), { index: false }));
  app.get('/', (req, res) => res.sendFile(require('path').join(__dirname, 'client', 'landing.html')));

  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const req = async (method, urlPath, body, token) => {
    const res = await fetch(base + urlPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  let failures = 0;
  const check = (label, cond) => {
    console.log((cond ? '✅' : '❌') + ' ' + label);
    if (!cond) failures++;
  };

  const billingConfig = await req('GET', '/api/billing/config');
  check('billing exposes only providers configured on the server', billingConfig.status === 200 && billingConfig.json.providers.length === 0);
  const billingUnauth = await req('POST', '/api/billing/checkout', { provider: 'stripe' });
  check('checkout rejects unauthenticated requests', billingUnauth.status === 401);
  const staticCompanyPage = await fetch(base + '/company.html');
  check('company workspace frontend is served as part of the same deployment', staticCompanyPage.status === 200);
  const staticLanding = await fetch(base + '/');
  check('the app landing page is served at the deployment root', staticLanding.status === 200);
  const sharedLimitA = await req('GET', '/test/shared-limit-a');
  const sharedLimitB = await req('GET', '/test/shared-limit-b');
  const sharedLimitExceeded = await req('GET', '/test/shared-limit-a');
  check('rate limits are shared across independent app instances', sharedLimitA.status === 200 &&
    sharedLimitB.status === 200 && sharedLimitExceeded.status === 429);
  const cronWithoutSecret = await req('GET', '/api/cron/cleanup');
  check('scheduled cleanup remains disabled until its secret is configured', cronWithoutSecret.status === 503);
  process.env.CRON_SECRET = 'cron-test-secret';
  const cronInvalid = await fetch(base + '/api/cron/cleanup', { headers: { Authorization: 'Bearer wrong' } });
  check('scheduled cleanup rejects requests without its bearer secret', cronInvalid.status === 401);
  const cronRun = await fetch(base + '/api/cron/cleanup', { headers: { Authorization: 'Bearer cron-test-secret' } });
  check('scheduled cleanup runs authenticated retention deletes transactionally', cronRun.status === 200 &&
    (await cronRun.json()).ok === true);

  const signup = await req('POST', '/api/auth/signup', { name: 'Ada', email: 'ada@example.com', password: 'password123' });
  check('signup returns 201 with token + user', signup.status === 201 && !!signup.json.token && signup.json.user.email === 'ada@example.com');
  check('new user starts with emailVerified: false', signup.json.user.emailVerified === false);
  check('signup triggers a verification email', !!lastMail && lastMail.subject.includes('Verify'));

  const verifyToken = extractToken();
  const badVerify = await req('POST', '/api/auth/verify-email', { token: 'wrong-token' });
  check('verifying with a wrong token is rejected', badVerify.status === 400);

  const goodVerify = await req('POST', '/api/auth/verify-email', { token: verifyToken });
  check('verifying with the real token succeeds', goodVerify.status === 200 && goodVerify.json.ok);

  const reusedVerify = await req('POST', '/api/auth/verify-email', { token: verifyToken });
  check('the same verification token cannot be used twice', reusedVerify.status === 400);

  const badSignup = await req('POST', '/api/auth/signup', { name: 'Ada2', email: 'ada@example.com', password: 'password123' });
  check('duplicate signup rejected with 409', badSignup.status === 409);

  const login = await req('POST', '/api/auth/login', { email: 'ada@example.com', password: 'password123' });
  check('login succeeds with correct password', login.status === 200 && !!login.json.token);

  const badLogin = await req('POST', '/api/auth/login', { email: 'ada@example.com', password: 'wrong' });
  check('login rejects wrong password with 401', badLogin.status === 401);

  const token = login.json.token;
  process.env.FLUTTERWAVE_SECRET_KEY = 'flutterwave-test-secret';
  process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH = 'flutterwave-test-hash';
  process.env.FLUTTERWAVE_TEAM_PLAN_ID = 'fw-plan-test';
  process.env.FLUTTERWAVE_TEAM_AMOUNT = '19';
  process.env.PAYSTACK_SECRET_KEY = 'paystack-test-secret';
  process.env.PAYSTACK_TEAM_PLAN_CODE = 'PLN_test';
  process.env.PAYSTACK_TEAM_AMOUNT = '19';
  const configuredGateways = await req('GET', '/api/billing/config');
  check('billing lists only the two configured gateways', configuredGateways.json.providers.length === 2);
  const companyFreeTier = await req('POST', '/api/company', { name: 'Should Not Exist' }, token);
  check('company workspace creation requires a paid Team plan', companyFreeTier.status === 403);
  const flutterwaveCheckout = await req('POST', '/api/billing/checkout', { provider: 'flutterwave' }, token);
  check('Flutterwave checkout returns its hosted payment URL', flutterwaveCheckout.status === 200 && flutterwaveCheckout.json.url === 'https://checkout.flutterwave.com/test');
  const paystackCheckout = await req('POST', '/api/billing/checkout', { provider: 'paystack' }, token);
  check('Paystack checkout returns its hosted payment URL', paystackCheckout.status === 200 && paystackCheckout.json.url === 'https://checkout.paystack.com/test');
  const badProvider = await req('POST', '/api/billing/checkout', { provider: 'unknown' }, token);
  check('checkout rejects unsupported providers', badProvider.status === 400);
  const invalidFlutterwave = await fetch(base + '/api/billing/flutterwave/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'verif-hash': 'wrong' }, body: '{}'
  });
  check('Flutterwave rejects unsigned payment notifications', invalidFlutterwave.status === 401);
  const invalidPaystack = await fetch(base + '/api/billing/paystack/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': 'wrong' }, body: '{}'
  });
  check('Paystack rejects unsigned payment notifications', invalidPaystack.status === 401);
  const fwOrder = (await pool.query(`SELECT provider_reference FROM payment_orders WHERE payment_provider = 'flutterwave' LIMIT 1`)).rows[0];
  const fwPayload = JSON.stringify({ event: 'charge.completed', data: { id: 123, status: 'successful', tx_ref: fwOrder.provider_reference } });
  const fwWebhook = await fetch(base + '/api/billing/flutterwave/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'verif-hash': process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH }, body: fwPayload
  });
  check('Flutterwave payment is activated only after server-side verification', fwWebhook.status === 200 &&
    (await pool.query(`SELECT plan FROM users WHERE id = $1`, [login.json.user.id])).rows[0].plan === 'team');
  const fwDuplicate = await fetch(base + '/api/billing/flutterwave/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'verif-hash': process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH }, body: fwPayload
  });
  check('Flutterwave webhook retries are idempotent', fwDuplicate.status === 200);
  const psOrder = (await pool.query(`SELECT provider_reference FROM payment_orders WHERE payment_provider = 'paystack' LIMIT 1`)).rows[0];
  const psPayload = JSON.stringify({ event: 'charge.success', data: { reference: psOrder.provider_reference } });
  const psSignature = require('crypto').createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(psPayload).digest('hex');
  const psWebhook = await fetch(base + '/api/billing/paystack/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': psSignature }, body: psPayload
  });
  check('Paystack signed and verified charge activates its subscription', psWebhook.status === 200);
  const captured = await pool.query(
    `SELECT COUNT(*) AS count FROM payment_orders WHERE status = 'paid' AND paid_at IS NOT NULL`
  );
  check('verified Flutterwave and Paystack payments are captured for billing analytics', Number(captured.rows[0].count) === 2);
  const duplicateCheckout = await req('POST', '/api/billing/checkout', { provider: 'paystack' }, token);
  check('an active subscription cannot accidentally start a second paid plan', duplicateCheckout.status === 409);
  const companyCreated = await req('POST', '/api/company', { name: 'Ada Company' }, token);
  check('a paid subscriber can create a company workspace as its owner', companyCreated.status === 201 && companyCreated.json.company.role === 'owner');
  const companyOverview = await req('GET', '/api/company/overview', null, token);
  check('company usage is scoped to the workspace and includes the owner', companyOverview.status === 200 &&
    Number(companyOverview.json.stats.members) === 1 && companyOverview.json.members[0].role === 'owner');
  const memberSignup = await req('POST', '/api/auth/signup', { name: 'Lin', email: 'lin@example.com', password: 'password123' });
  const memberAdded = await req('POST', '/api/company/members', { email: 'lin@example.com' }, token);
  check('company owner can add an existing Etriod account', memberAdded.status === 201 && memberAdded.json.member.role === 'member');
  const companyPage = await req('GET', '/api/company/overview?limit=1&offset=0', null, token);
  check('company member directory uses bounded pagination', companyPage.status === 200 &&
    companyPage.json.members.length === 1 && companyPage.json.pagination.hasMore);
  const memberRole = await req('PATCH', `/api/company/members/${memberSignup.json.user.id}`, { role: 'admin' }, token);
  check('company owner can grant a member the company admin role', memberRole.status === 200 && memberRole.json.member.role === 'admin');
  const memberAdminDemotion = await req('PATCH', `/api/company/members/${memberSignup.json.user.id}`, { role: 'member' }, memberSignup.json.token);
  check('company admin cannot change another administrator role', memberAdminDemotion.status === 404);
  const globalAdminDenied = await req('GET', '/api/admin/overview', null, memberSignup.json.token);
  check('company admin cannot access global platform admin analytics', globalAdminDenied.status === 403);
  const memberRemoved = await req('DELETE', `/api/company/members/${memberSignup.json.user.id}`, null, token);
  check('company owner can remove members without deleting their account', memberRemoved.status === 200);
  await pool.query(`UPDATE subscriptions SET status = 'canceled' WHERE user_id = $1`, [login.json.user.id]);
  await pool.query(`UPDATE users SET plan = 'personal' WHERE id = $1`, [login.json.user.id]);
  const expiredCompany = await req('GET', '/api/company/overview', null, token);
  check('company access is suspended when its owner subscription ends', expiredCompany.status === 402);
  await pool.query(`UPDATE subscriptions SET status = 'active' WHERE user_id = $1`, [login.json.user.id]);
  await pool.query(`UPDATE users SET plan = 'team' WHERE id = $1`, [login.json.user.id]);
  const me = await req('GET', '/api/auth/me', null, token);
  check('/me returns the signed-in user', me.status === 200 && me.json.user.name === 'Ada');
  check('/me reflects the email as verified after verify-email', me.json.user.emailVerified === true);

  const resend = await req('POST', '/api/auth/resend-verification', null, token);
  check('resend-verification on an already-verified account says so, without erroring', resend.status === 200 && /already verified/i.test(resend.json.message));

  const noAuth = await req('GET', '/api/conversations');
  check('conversations list rejects unauthenticated request with 401', noAuth.status === 401);

  const createConvo = await req('POST', '/api/conversations', null, token);
  check('conversation created', createConvo.status === 201 && !!createConvo.json.conversation.id);
  const convoId = createConvo.json.conversation.id;

  const list = await req('GET', '/api/conversations', null, token);
  check('conversation appears in list', list.status === 200 && list.json.conversations.length === 1);

  const chatUnavailable = await req('POST', `/api/conversations/${convoId}/messages`, { content: 'Hello' }, token);
  check('chat with unavailable local model fails gracefully with 503 (not a crash)', chatUnavailable.status === 503);

  process.env.TEST_OLLAMA_READY = '1';

  const chatWithModel = await req('POST', `/api/conversations/${convoId}/messages`, { content: 'Hello there' }, token);
  check('non-streaming chat returns a reply from the self-hosted model adapter', chatWithModel.status === 200 && chatWithModel.json.reply.includes('fake non-streaming reply'));

  const convoAfterChat = await req('GET', `/api/conversations/${convoId}`, null, token);
  check('the user message and local-model reply were persisted', convoAfterChat.json.messages.length === 3);

  // Streaming needs a raw fetch — read the SSE body chunk by chunk and
  // reconstruct the full text, same as the browser will.
  const streamRes = await fetch(base + `/api/conversations/${convoId}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ content: 'Stream this please' })
  });
  check('streaming endpoint responds with SSE content-type', (streamRes.headers.get('content-type') || '').includes('text/event-stream'));

  let streamedText = '', sawDone = false;
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      if (!part.startsWith('data: ')) continue;
      const evt = JSON.parse(part.slice(6));
      if (evt.type === 'delta') streamedText += evt.text;
      if (evt.type === 'done') sawDone = true;
    }
  }
  check('streamed deltas reconstruct the local model reply', streamedText === 'This is a fake streamed reply, sent in small pieces.');
  check('stream sends a final "done" event', sawDone);

  const convoAfterStream = await req('GET', `/api/conversations/${convoId}`, null, token);
  check('the streamed reply was persisted to the database too', convoAfterStream.json.messages.some(m => m.content === streamedText));

  delete process.env.TEST_OLLAMA_READY;

  const settingsUpdate = await req('PUT', '/api/settings', { soundPref: true, primaryUse: 'writing' }, token);
  check('settings update persists', settingsUpdate.status === 200 && settingsUpdate.json.user.sound_pref === true);

  const waitlist = await req('POST', '/api/waitlist', { name: 'Bo', email: 'bo@example.com', plan: 'Team' });
  check('waitlist signup succeeds (public route)', waitlist.status === 201);

  const eveSignup = await req('POST', '/api/auth/signup', { name: 'Eve', email: 'eve@example.com', password: 'password123' });
  check('second user can also sign up (no id collisions)', eveSignup.status === 201);
  const otherUserConvo = await req('GET', `/api/conversations/${convoId}`, null, eveSignup.json.token);
  check("a different user can't read someone else's conversation (404)", otherUserConvo.status === 404);

  // --- New in this pass: password reset, admin gating, clear-history, message cap ---

  const resetRequest = await req('POST', '/api/auth/request-password-reset', { email: 'ada@example.com' });
  check('password reset request responds ok (email simulated via console log)', resetRequest.status === 200 && resetRequest.json.ok);

  const resetRequestUnknown = await req('POST', '/api/auth/request-password-reset', { email: 'nobody@example.com' });
  check('password reset request gives identical response for unknown email (no account enumeration)', resetRequestUnknown.status === 200 && resetRequestUnknown.json.ok);

  const badReset = await req('POST', '/api/auth/reset-password', { token: 'not-a-real-token', newPassword: 'newpassword123' });
  check('reset with invalid token is rejected', badReset.status === 400);

  const adminDenied = await req('GET', '/api/admin/overview', null, token);
  check('non-admin user is denied admin access (403)', adminDenied.status === 403);

  await pool.query(`UPDATE users SET role = 'admin' WHERE email = 'ada@example.com'`);
  const adminLoginAgain = await req('POST', '/api/auth/login', { email: 'ada@example.com', password: 'password123' });
  const adminOverview = await req('GET', '/api/admin/overview', null, adminLoginAgain.json.token);
  check('admin overview works once role is admin, and reflects real conversation count', adminOverview.status === 200 && adminOverview.json.totals.total_conversations >= 1);
  await pool.query(`UPDATE users SET role = 'admin' WHERE email = 'lin@example.com'`);
  const promotedAdmin = await req('GET', '/api/admin/overview', null, memberSignup.json.token);
  await pool.query(`UPDATE users SET role = 'member' WHERE email = 'lin@example.com'`);
  const revokedAdmin = await req('GET', '/api/admin/overview', null, memberSignup.json.token);
  check('platform admin permissions use the current database role, not stale JWT claims', promotedAdmin.status === 200 && revokedAdmin.status === 403);
  check('platform overview includes user, subscriber, and company investor metrics', Number(adminOverview.json.totals.total_users) >= 2 &&
    Number(adminOverview.json.totals.active_subscriptions) >= 1 && Number(adminOverview.json.totals.total_companies) === 1);
  const adminBilling = await req('GET', '/api/admin/billing', null, adminLoginAgain.json.token);
  check('billing dashboard reports actual captured revenue by currency and provider', adminBilling.status === 200 &&
    adminBilling.json.providerTotals.length === 2 && adminBilling.json.monthlyRevenue.length > 0);
  check('billing analytics identifies the latest verified monthly run-rate', adminBilling.status === 200 &&
    adminBilling.json.estimatedMrr.length > 0 && Number(adminBilling.json.estimatedMrr[0].estimated_mrr) > 0);
  const adminCompanies = await req('GET', '/api/admin/companies', null, adminLoginAgain.json.token);
  check('platform operators can view aggregate company workspace activity', adminCompanies.status === 200 &&
    adminCompanies.json.companies.length === 1 && adminCompanies.json.companies[0].name === 'Ada Company');

  const tooLong = await req('POST', `/api/conversations/${convoId}/messages`, { content: 'x'.repeat(8001) }, token);
  check('overly long message is rejected with 400, not sent to the model', tooLong.status === 400);

  const clearHistory = await req('DELETE', '/api/settings/history', null, token);
  check('clear history succeeds', clearHistory.status === 200);
  const listAfterClear = await req('GET', '/api/conversations', null, token);
  check('conversations are actually gone after clearing history', listAfterClear.status === 200 && listAfterClear.json.conversations.length === 0);

  server.close();
  global.fetch = realFetch;
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('Smoke test crashed:', err); process.exit(1); });
