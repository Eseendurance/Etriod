// Override this before deploying the static client when the API has its own
// origin. Same-origin hosting works without any configuration.
window.ETRIOD_API = window.ETRIOD_API || (
  window.location.protocol === 'file:' ||
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : window.location.origin
);
