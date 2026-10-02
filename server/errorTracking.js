// Keep diagnostic capture on this server; application data is never sent to
// an external error-tracking service.
function init() { return null; }

function captureException(err, context) {
  console.error('[error]', context || {}, err);
}

// Express error-handling middleware must take 4 args or Express won't treat
// it as an error handler — captures, then hands off to the next handler
// (the one in index.js that actually sends the response).
function expressErrorHandler(err, req, res, next) {
  captureException(err, { path: req.originalUrl, method: req.method });
  next(err);
}

module.exports = { init, captureException, expressErrorHandler };
