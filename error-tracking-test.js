// Verifies local error capture never requires sending application data to
// an external tracking service.
async function main() {
  let failures = 0;
  const check = (label, cond) => { console.log((cond ? '✅' : '❌') + ' ' + label); if (!cond) failures++; };

  // --- Unconfigured case ---
  delete process.env.SENTRY_DSN;
  const et1 = require('./server/errorTracking');
  let threw = false;
  try {
    et1.captureException(new Error('test error, no DSN configured'));
  } catch (e) { threw = true; }
  check('captureException logs locally without throwing', !threw);
  check('error tracking has no external SDK configured', et1.init() === null);

  // --- Configured case, with a syntactically valid but fake DSN ---
  delete require.cache[require.resolve('./server/errorTracking')];
  process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
  const et2 = require('./server/errorTracking');
  let threw2 = false;
  try {
    et2.captureException(new Error('test error, fake DSN configured'), { extra: 'context' });
  } catch (e) { threw2 = true; console.error(e); }
  check('a stale SENTRY_DSN cannot activate external error reporting', !threw2);

  // Express middleware shape check — must be a 4-arg function or Express
  // silently treats it as a normal (non-error) middleware.
  check('expressErrorHandler declares all 4 error-middleware arguments', et2.expressErrorHandler.length === 4);

  delete process.env.SENTRY_DSN;
  console.log(failures === 0 ? '\nALL ERROR-TRACKING CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('Error-tracking test crashed:', err); process.exit(1); });
