(function () {
  // Figure out where to send events based on this script's own src, so no
  // hardcoded URL is needed in the embed snippet.
  var thisScript = document.currentScript;
  var endpoint = (thisScript && thisScript.getAttribute('data-endpoint')) ||
    (thisScript ? thisScript.src.replace(/\/tracker\.js.*$/, '/api/track') : null);

  if (!endpoint) return;

  // --- Session ID: persists across pages/visits in this browser ---
  var SESSION_KEY = 'wu_session_id';
  var sessionId;
  try {
    sessionId = localStorage.getItem(SESSION_KEY);
    if (!sessionId) {
      sessionId = 'wu_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(SESSION_KEY, sessionId);
    }
  } catch (e) {
    // localStorage blocked (private mode, etc.) -- fall back to a per-page id
    sessionId = 'wu_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function send(label, opts) {
    opts = opts || {};
    var payload = {
      label: label,
      event_type: opts.type || 'event',
      session_id: sessionId,
      page_url: location.href,
      referrer: document.referrer || null,
      meta: opts.meta || null,
    };
    try {
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true, // lets the request finish even if the page is navigating away
      }).catch(function () {});
    } catch (e) {
      /* fail silently -- tracking should never break the site */
    }
  }

  // Expose for manual funnel events, e.g.:
  //   wuTrack('Submitted inquiry form', { type: 'success', meta: { service: 'DJ' } });
  window.wuTrack = send;

  // --- Identity: call this when someone submits a form with their info.
  // Links this browser's session (past AND future events) to a real person.
  //   wuIdentify({ name: 'Jane Doe', email: 'jane@example.com', phone: '555-1234' });
  var IDENTITY_KEY = 'wu_identity';
  window.wuIdentify = function (fields) {
    fields = fields || {};
    if (!fields.email && !fields.name) return;
    try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(fields)); } catch (e) {}
    send('Identified: ' + (fields.name || fields.email), {
      type: 'identify',
      meta: {
        name: fields.name || null,
        email: fields.email || null,
        phone: fields.phone || null,
      },
    });
  };

  // If this browser identified itself on a past visit but the server link was
  // ever lost (e.g. DB reset), quietly re-identify once per page load.
  try {
    var saved = localStorage.getItem(IDENTITY_KEY);
    if (saved) {
      var f = JSON.parse(saved);
      if (f && f.email) {
        send('Returning visitor: ' + (f.name || f.email), {
          type: 'identify',
          meta: { name: f.name || null, email: f.email || null, phone: f.phone || null, returning: true },
        });
      }
    }
  } catch (e) {}

  // --- Automatic: page view on load ---
  send('Viewed page: ' + location.pathname, { type: 'pageview' });

  // --- Automatic: clicks on anything tagged data-wu-track="Label text" ---
  document.addEventListener(
    'click',
    function (e) {
      var el = e.target.closest && e.target.closest('[data-wu-track]');
      if (!el) return;
      var label = el.getAttribute('data-wu-track');
      var type = el.getAttribute('data-wu-type') || 'click';
      send(label, { type: type });
    },
    true
  );
})();
