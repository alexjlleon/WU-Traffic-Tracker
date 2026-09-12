// Lead alert emails.
//
// When a visitor identifies themselves through a form (wuIdentify -> /api/identify),
// this builds a full picture of what that person did on the site -- every page they
// viewed, how long they stayed, how far they scrolled, what they clicked, where they
// came from -- and emails it to whoever LEAD_ALERT_TO points at.
//
// Self-contained: opens its own connection to the same SQLite file (same pattern as
// identity.js), so db.js and the rest of the app are untouched.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/traffic.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Record of what we've already emailed about, so a double form submit or a
// re-link on a return visit can never send the same alert twice.
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_alerts (
    email TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT,
    detail TEXT
  );
`);

const alreadyAlerted = db.prepare(`SELECT 1 FROM lead_alerts WHERE email = ?`);
const claimAlert = db.prepare(
  `INSERT OR IGNORE INTO lead_alerts (email, status) VALUES (?, 'sending')`
);
const finishAlert = db.prepare(
  `UPDATE lead_alerts SET status = ?, detail = ?, sent_at = datetime('now') WHERE email = ?`
);
const clearAlert = db.prepare(`DELETE FROM lead_alerts WHERE email = ?`);

// Does this email already exist in the people table? Checked before the
// identify route upserts the row, which is how a brand-new lead is told apart
// from a repeat submit or a return-visit re-link. The people table belongs to
// identity.js; if it isn't there yet, treat everyone as new (lead_alerts still
// guarantees one email per person).
function personExists(email) {
  if (!email) return false;
  try {
    return Boolean(
      db
        .prepare(`SELECT 1 FROM people WHERE email = ?`)
        .get(String(email).trim().toLowerCase())
    );
  } catch (e) {
    return false;
  }
}

// --- config ---
const cfg = () => ({
  apiKey: process.env.RESEND_API_KEY || '',
  to: (process.env.LEAD_ALERT_TO || 'alex@weddingsunlimited.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  from: process.env.LEAD_ALERT_FROM || 'WU Traffic <onboarding@resend.dev>',
  dashboard:
    process.env.DASHBOARD_URL ||
    'https://claudecode-production-1038.up.railway.app',
  tz: process.env.LEAD_ALERT_TZ || 'America/Chicago',
});

function isConfigured() {
  return Boolean(cfg().apiKey);
}

// --- small helpers ---
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function utcToDate(s) {
  if (!s) return null;
  // SQLite stores 'YYYY-MM-DD HH:MM:SS' in UTC.
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

function fmtTime(s, tz) {
  const d = utcToDate(s);
  if (!d) return '';
  return d.toLocaleString('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function fmtClock(s, tz) {
  const d = utcToDate(s);
  if (!d) return '';
  return d.toLocaleString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function fmtDuration(ms) {
  if (!ms || ms < 1000) return '';
  const total = Math.round(ms / 1000);
  if (total < 60) return total + 's';
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function pathOf(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return (u.pathname || '/') + (u.search || '');
  } catch (e) {
    return String(url).startsWith('/') ? url : null;
  }
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

function sourceOf(referrer, keyword) {
  if (!referrer) return 'Direct / typed in';
  let host = referrer;
  try {
    host = new URL(referrer).hostname.replace(/^www\./, '');
  } catch (e) {
    /* leave as-is */
  }
  if (/weddingsunlimited/i.test(host)) return null; // internal, not a real source
  if (keyword) return `${host} — searched "${keyword}"`;
  return host;
}

// --- gather everything we know about this person ---
function buildJourney(email) {
  email = String(email).trim().toLowerCase();

  const rows = db
    .prepare(
      `SELECT e.* FROM events e
       JOIN identity_sessions s ON s.session_id = e.session_id
       WHERE s.email = ?
       ORDER BY e.id ASC
       LIMIT 1500`
    )
    .all(email);

  const person =
    db.prepare(`SELECT * FROM people WHERE email = ?`).get(email) || {};

  const visits = []; // one entry per pageview, in order
  const clicks = []; // notable clicks, in order
  const sessions = new Set();
  let firstSource = null;
  let geo = null;
  let device = null;
  let ip = null;

  const findVisit = (p) => {
    for (let i = visits.length - 1; i >= 0; i--) {
      if (visits[i].path === p) return visits[i];
    }
    return visits.length ? visits[visits.length - 1] : null;
  };

  for (const e of rows) {
    const meta = parseMeta(e.meta);
    if (e.session_id) sessions.add(e.session_id);
    if (e.device_type && e.device_type !== 'Bot') device = e.device_type;
    if (e.geo_city || e.geo_region) {
      geo = [e.geo_city, e.geo_region].filter(Boolean).join(', ');
    }
    if (e.ip_address) ip = e.ip_address;

    if (firstSource === null && e.referrer) {
      const s = sourceOf(e.referrer, meta.referrer_keyword);
      if (s) firstSource = s;
    }

    const evPath = meta.page_path || pathOf(e.page_url);

    if (e.event_type === 'pageview') {
      visits.push({
        path: evPath || '/',
        at: e.created_at,
        title: (e.label || '').replace(/^Viewed page:\s*/i, '').trim(),
        duration_ms: null,
        scroll: 0,
        clicks: [],
      });
      continue;
    }

    if (!visits.length) continue;
    const v = findVisit(evPath);
    if (!v) continue;

    if (e.event_type === 'timing' && e.duration_ms) {
      v.duration_ms = Math.max(v.duration_ms || 0, e.duration_ms);
    } else if (e.event_type === 'scroll' || /scroll/i.test(e.label || '')) {
      const pct = parseInt(meta.percent, 10);
      if (Number.isFinite(pct)) v.scroll = Math.max(v.scroll, pct);
    } else if (e.event_type === 'click' || e.event_type === 'milestone') {
      const text =
        meta.text || meta.alt || meta.href || meta.src || e.label || '';
      const c = {
        kind: meta.kind || e.event_type,
        text: String(text).slice(0, 120),
        at: e.created_at,
        path: v.path,
      };
      v.clicks.push(c);
      clicks.push(c);
    }
  }

  if (firstSource === null) firstSource = 'Direct / typed in';

  const totalTime = visits.reduce((a, v) => a + (v.duration_ms || 0), 0);
  const deepest = visits.reduce((a, v) => Math.max(a, v.scroll), 0);
  const uniquePages = new Set(visits.map((v) => v.path)).size;
  const firstSeen = rows.length ? rows[0].created_at : null;
  const lastSeen = rows.length ? rows[rows.length - 1].created_at : null;

  return {
    person,
    visits,
    clicks,
    stats: {
      pageviews: visits.length,
      uniquePages,
      totalTime,
      deepest,
      sessions: sessions.size,
      firstSource,
      geo,
      device,
      ip,
      firstSeen,
      lastSeen,
    },
  };
}

// --- the email itself ---
function renderEmail(lead, journey) {
  const { tz, dashboard } = cfg();
  const { visits, clicks, stats, person } = journey;

  const name = lead.name || person.name || 'Unknown name';
  const wrap = (inner) => `<tr><td style="padding:0">${inner}</td></tr>`;

  const row = (label, value) =>
    value
      ? `<tr>
           <td style="padding:6px 12px 6px 0;color:#8a8178;font:13px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;white-space:nowrap;vertical-align:top">${esc(
             label
           )}</td>
           <td style="padding:6px 0;color:#2b2621;font:14px -apple-system,Segoe UI,Helvetica,Arial,sans-serif">${value}</td>
         </tr>`
      : '';

  const stat = (value, label) => `
    <td style="padding:12px 8px;text-align:center;background:#faf7f3;border-radius:8px" width="25%">
      <div style="font:600 20px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#2b2621">${esc(
        value
      )}</div>
      <div style="font:11px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#8a8178;text-transform:uppercase;letter-spacing:.04em;padding-top:3px">${esc(
        label
      )}</div>
    </td>`;

  const visitRows = visits.length
    ? visits
        .map((v, i) => {
          const time = fmtDuration(v.duration_ms);
          const bits = [];
          if (time) bits.push(time + ' on page');
          if (v.scroll) bits.push(v.scroll + '% scrolled');
          if (v.clicks.length)
            bits.push(v.clicks.length + (v.clicks.length === 1 ? ' click' : ' clicks'));
          return `<tr style="background:${i % 2 ? '#ffffff' : '#faf7f3'}">
            <td style="padding:9px 10px;font:12px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#8a8178;white-space:nowrap;vertical-align:top">${esc(
              fmtClock(v.at, tz)
            )}</td>
            <td style="padding:9px 10px;font:14px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#2b2621;vertical-align:top">
              <div style="font-weight:600">${esc(v.path)}</div>
              ${
                bits.length
                  ? `<div style="color:#8a8178;font-size:12px;padding-top:2px">${esc(
                      bits.join(' · '
                    ))}</div>`
                  : ''
              }
            </td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="2" style="padding:14px 10px;font:14px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#8a8178">No page history recorded for this visitor yet.</td></tr>`;

  const clickList = clicks.slice(-12).reverse();
  const clicksHtml = clickList.length
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        ${clickList
          .map(
            (c) => `<tr>
              <td style="padding:5px 0;font:13px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#2b2621">
                <span style="display:inline-block;min-width:52px;color:#8a8178;font-size:11px;text-transform:uppercase;letter-spacing:.04em">${esc(
                  c.kind
                )}</span>
                ${esc(c.text)}
                <span style="color:#b3a99e"> · ${esc(c.path)}</span>
              </td>
            </tr>`
          )
          .join('')}
      </table>`
    : '';

  const totalTimeStr = fmtDuration(stats.totalTime) || '—';

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f2ede7">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2ede7;padding:24px 12px">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6ded4">

  <tr><td style="padding:20px 24px;background:#2b2621">
    <div style="font:600 11px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#c9b79c;text-transform:uppercase;letter-spacing:.12em">New lead</div>
    <div style="font:600 22px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;padding-top:4px">${esc(
      name
    )}</div>
    <div style="font:13px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#b3a99e;padding-top:3px">${esc(
      fmtTime(new Date().toISOString().slice(0, 19).replace('T', ' '), tz)
    )} · ${esc(stats.geo || 'Location unknown')}</div>
  </td></tr>

  <tr><td style="padding:18px 24px 4px">
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row(
        'Email',
        `<a href="mailto:${esc(lead.email)}" style="color:#8a6d3b;text-decoration:none">${esc(
          lead.email
        )}</a>`
      )}
      ${row(
        'Phone',
        lead.phone
          ? `<a href="tel:${esc(String(lead.phone).replace(/[^\d+]/g, ''))}" style="color:#8a6d3b;text-decoration:none">${esc(
              lead.phone
            )}</a>`
          : ''
      )}
      ${row('Submitted from', esc(pathOf(lead.page_url) || '—'))}
      ${row('First found you via', esc(stats.firstSource))}
      ${row('Device', esc(stats.device || ''))}
      ${row(
        'Been browsing since',
        stats.firstSeen ? esc(fmtTime(stats.firstSeen, tz)) : ''
      )}
    </table>
  </td></tr>

  <tr><td style="padding:14px 24px 4px">
    <table width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate">
      <tr>
        ${stat(String(stats.pageviews), 'Pages viewed')}
        ${stat(String(stats.uniquePages), 'Unique pages')}
        ${stat(totalTimeStr, 'Time on site')}
        ${stat(stats.deepest ? stats.deepest + '%' : '—', 'Deepest scroll')}
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:18px 24px 0">
    <div style="font:600 12px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#8a8178;text-transform:uppercase;letter-spacing:.08em;padding-bottom:8px">Pages they visited</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e6ded4;border-radius:8px;overflow:hidden">
      ${visitRows}
    </table>
  </td></tr>

  ${
    clicksHtml
      ? `<tr><td style="padding:18px 24px 0">
          <div style="font:600 12px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#8a8178;text-transform:uppercase;letter-spacing:.08em;padding-bottom:6px">What they clicked</div>
          ${clicksHtml}
        </td></tr>`
      : ''
  }

  <tr><td style="padding:22px 24px 26px">
    <a href="${esc(dashboard)}/admin/people.html" style="display:inline-block;background:#2b2621;color:#ffffff;font:600 14px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;text-decoration:none;padding:11px 20px;border-radius:8px">Open the full journey</a>
    <div style="font:11px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#b3a99e;padding-top:14px">Sent by WU Traffic Tracker. Reply to this email to answer ${esc(
      lead.email
    )} directly.</div>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  const subjectBits = [name];
  if (stats.pageviews) subjectBits.push(`${stats.pageviews} pages`);
  if (stats.geo) subjectBits.push(stats.geo);
  const subject = `New lead: ${subjectBits.join(' · ')}`;

  const text = [
    `NEW LEAD: ${name}`,
    `Email: ${lead.email}`,
    lead.phone ? `Phone: ${lead.phone}` : '',
    `Submitted from: ${pathOf(lead.page_url) || '—'}`,
    `Found you via: ${stats.firstSource}`,
    `Location: ${stats.geo || 'unknown'}${stats.device ? ' · ' + stats.device : ''}`,
    '',
    `${stats.pageviews} pageviews (${stats.uniquePages} unique) · ${totalTimeStr} on site · ${
      stats.deepest || 0
    }% deepest scroll`,
    '',
    'PAGES VISITED',
    ...visits.map((v) => {
      const bits = [fmtDuration(v.duration_ms), v.scroll ? v.scroll + '% scrolled' : '']
        .filter(Boolean)
        .join(', ');
      return `  ${fmtClock(v.at, tz)}  ${v.path}${bits ? '  (' + bits + ')' : ''}`;
    }),
    clickList.length ? '' : null,
    clickList.length ? 'CLICKED' : null,
    ...clickList.map((c) => `  [${c.kind}] ${c.text} — ${c.path}`),
    '',
    `${dashboard}/admin/people.html`,
  ]
    .filter((l) => l !== null)
    .join('\n');

  return { subject, html, text };
}

async function sendViaResend({ subject, html, text, replyTo }) {
  const { apiKey, to, from } = cfg();
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
      text,
      reply_to: replyTo || undefined,
    }),
  });
  const body = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`Resend ${r.status}: ${body.slice(0, 300)}`);
  return body.slice(0, 200);
}

// Build + send the alert for one person. Returns a result object; never throws
// into the request path.
async function sendLeadAlert(lead, { force = false } = {}) {
  const email = String(lead.email || '').trim().toLowerCase();
  if (!email) return { sent: false, reason: 'no email' };
  if (!isConfigured()) return { sent: false, reason: 'RESEND_API_KEY not set' };

  if (force) clearAlert.run(email);
  // Claim the slot first -- if another request already claimed it, stop here.
  const claimed = claimAlert.run(email);
  if (claimed.changes === 0) return { sent: false, reason: 'already alerted' };

  try {
    const journey = buildJourney(email);
    const { subject, html, text } = renderEmail({ ...lead, email }, journey);
    const detail = await sendViaResend({ subject, html, text, replyTo: email });
    finishAlert.run('sent', detail, email);
    console.log(`[lead-alert] sent for ${email} (${journey.stats.pageviews} pageviews)`);
    return { sent: true, subject };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 400);
    finishAlert.run('error', msg, email);
    console.error(`[lead-alert] FAILED for ${email}: ${msg}`);
    return { sent: false, reason: msg };
  }
}

// Fire-and-forget wrapper.
function notifyNewLead(lead, opts) {
  sendLeadAlert(lead, opts).catch((e) =>
    console.error('[lead-alert] unexpected:', e)
  );
}

function alertStatus(limit = 20) {
  return db
    .prepare(`SELECT * FROM lead_alerts ORDER BY sent_at DESC LIMIT ?`)
    .all(limit);
}

// Same credentials as the dashboard's basic auth, checked here so the two
// admin routes below can live inside this module.
function isAdmin(req) {
  const header = req.headers.authorization || '';
  if (!/^basic /i.test(header)) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64')
    .toString('utf8')
    .split(':');
  return (
    user === (process.env.ADMIN_USER || 'admin') &&
    rest.join(':') === (process.env.ADMIN_PASS || 'change-me')
  );
}

// One Express middleware that carries the whole feature, so server.js only ever
// needs two lines: require this file, and app.use(notify.middleware()).
// Mount it after the JSON body parsers and before the /api/identify route.
//
//   POST /api/identify        -> watched; a first-time lead triggers the alert
//   GET  /api/lead-alerts     -> admin: is it configured, and what has it sent
//   POST /api/lead-alerts/send-> admin: re-send an alert for one person (test)
function middleware() {
  return function leadAlerts(req, res, next) {
    const p = (req.path || '').replace(/\/+$/, '');

    if (p === '/api/lead-alerts' && req.method === 'GET') {
      if (!isAdmin(req)) return res.status(401).json({ ok: false, error: 'admin only' });
      return res.json({ configured: isConfigured(), to: cfg().to, from: cfg().from, rows: alertStatus(25) });
    }

    if (p === '/api/lead-alerts/send' && req.method === 'POST') {
      if (!isAdmin(req)) return res.status(401).json({ ok: false, error: 'admin only' });
      const { email, name, phone, page_url, force } = req.body || {};
      if (!email) return res.status(400).json({ ok: false, error: 'email is required' });
      return sendLeadAlert({ email, name, phone, page_url }, { force: force !== false })
        .then((result) => res.json({ ok: result.sent, result }))
        .catch((e) => res.status(500).json({ ok: false, error: String((e && e.message) || e) }));
    }

    if (p === '/api/identify' && req.method === 'POST') {
      const body = req.body || {};
      const email = String(body.email || '').trim().toLowerCase();
      // Checked now, before the route handler creates the person row.
      const isNew = Boolean(email) && !personExists(email);
      if (isNew && !body.returning) {
        // Wait until the identify has actually succeeded, so a rejected
        // submission never sends an alert. The visitor is never held up.
        res.on('finish', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            notifyNewLead({
              email,
              name: body.name,
              phone: body.phone,
              page_url: body.page_url,
              session_id: body.session_id,
            });
          }
        });
      }
    }

    return next();
  };
}

module.exports = {
  middleware,
  isConfigured,
  sendLeadAlert,
  notifyNewLead,
  buildJourney,
  renderEmail,
  alertStatus,
  personExists,
  wasAlerted: (email) =>
    Boolean(alreadyAlerted.get(String(email || '').trim().toLowerCase())),
};
