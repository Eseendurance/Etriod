// Override this before deploying the static client when the API has its own
// origin. Same-origin hosting works without any configuration.
window.ETRIOD_API = window.ETRIOD_API || (
  window.location.protocol === 'file:' ||
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : window.location.origin
);

const landingPrompt = new URLSearchParams(window.location.search).get('q');
if (landingPrompt && localStorage.getItem('etriod_token') && window.location.pathname.endsWith('/app.html')) {
  const composer = document.getElementById('input');
  if (composer) {
    composer.value = landingPrompt;
    composer.focus();
    window.history.replaceState(null, '', window.location.pathname);
  }
}
