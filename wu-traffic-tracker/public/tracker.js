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
      duration_ms: opts.duration_ms || null,
    };
    var body = JSON.stringify(payload);

    // Use sendBeacon when we can (fires reliably even as the page is unloading).
    // Fall back to fetch with keepalive otherwise.
    try {
      if (opts.beacon && navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon(endpoint, blob);
        return;
      }
    } catch (e) {}

    try {
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true, // lets the request finish even if the page is navigating away
      }).catch(function () {});
    } catch (e) {
      /* fail silently -- tracking should never break the site */
    }
  }

  // Expose for manual funnel events, e.g.:
  //   wuTrack('Submitted inquiry form', { type: 'success', meta: { service: 'DJ' } });
  window.wuTrack = send;

  // --- Automatic: page view on load ---
  send('Viewed page: ' + location.pathname, { type: 'pageview' });

  // --- Automatic: time spent on this page ---
  // Fires once, whenever the visitor actually leaves (tab switch, close, or
  // navigating to another page) -- not on every visibility flicker.
  var pageStart = Date.now();
  var sentTiming = false;
  function sendTiming() {
    if (sentTiming) return;
    sentTiming = true;
    var duration = Date.now() - pageStart;
    if (duration < 250) return; // ignore accidental instant bounces / bot hits
    send('Time on page: ' + location.pathname, {
      type: 'timing',
      duration_ms: duration,
      beacon: true,
      meta: { page_path: location.pathname },
    });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendTiming();
  });
  window.addEventListener('pagehide', sendTiming);

  // --- Automatic: clicks on anything tagged data-wu-track="Label text" ---
  // (explicit tags always win -- auto-capture below skips anything already
  // handled here so nothing gets logged twice)
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

  // --- Automatic: site-wide click capture for links, buttons, images, and pricing options ---
  // Runs on the same click, but only for elements NOT already handled by data-wu-track above.
  var PRICING_SELECTOR = '[class*="pric" i], [id*="pric" i], [class*="plan" i], [class*="package" i], [data-price], [data-plan]';

  function textOf(el) {
    var t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');
    return t.slice(0, 120);
  }

  function imageLabel(img) {
    var alt = (img.getAttribute('alt') || '').trim();
    if (alt) return alt.slice(0, 120);
    var src = img.currentSrc || img.getAttribute('src') || '';
    var file = src.split('/').pop().split('?')[0];
    return file || 'image';
  }

  document.addEventListener(
    'click',
    function (e) {
      var target = e.target;
      if (!(target && target.closest)) return;

      // Don't double-log something already sent via the explicit data-wu-track handler.
      if (target.closest('[data-wu-track]')) return;

      // Pricing options: check this first since a pricing card is often also a link/button.
      var pricingEl = target.closest(PRICING_SELECTOR);
      if (pricingEl && pricingEl.closest) {
        var clickable = target.closest('a, button, [role="button"]') || pricingEl;
        send('Clicked pricing option: ' + textOf(clickable || pricingEl), {
          type: 'milestone',
          meta: {
            kind: 'pricing',
            text: textOf(clickable || pricingEl),
            href: clickable && clickable.getAttribute ? clickable.getAttribute('href') : null,
            page_path: location.pathname,
          },
        });
        return;
      }

      var img = target.closest('img');
      if (img) {
        send('Clicked image: ' + imageLabel(img), {
          type: 'click',
          meta: {
            kind: 'image',
            src: img.currentSrc || img.getAttribute('src') || null,
            alt: img.getAttribute('alt') || null,
            page_path: location.pathname,
          },
        });
        return;
      }

      var link = target.closest('a');
      if (link) {
        send('Clicked link: ' + (textOf(link) || link.getAttribute('href') || ''), {
          type: 'click',
          meta: {
            kind: 'link',
            href: link.getAttribute('href') || null,
            text: textOf(link),
            page_path: location.pathname,
          },
        });
        return;
      }

      var btn = target.closest('button, [role="button"], input[type="submit"], input[type="button"]');
      if (btn) {
        var label = textOf(btn) || btn.value || 'button';
        send('Clicked button: ' + label, {
          type: 'click',
          meta: { kind: 'button', text: label, page_path: location.pathname },
        });
      }
    },
    true
  );
})();
