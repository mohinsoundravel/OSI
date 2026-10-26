/**
 * Dashboard entry point. The libraries (three.js, satellite.js, topojson-client) load first as
 * classic scripts from src/vendor; the app modules start only if three.js is present.
 */
if (typeof THREE === 'undefined') {
  document.getElementById('toasts').innerHTML = '<div class="toast">three.js failed to load. Reload the page; if it persists, clear this site\'s data.</div>';
} else {
  import('./app/index.js').catch((err) => {
    document.getElementById('toasts').innerHTML = '<div class="toast">The dashboard failed to start. Reload the page.</div>';
    throw err;
  });
}
