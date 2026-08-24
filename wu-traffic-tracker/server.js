require('dotenv').config();
const express = require('express');
const cors = require('cors');
const basicAuth = require('express-basic-auth');
const path = require('path');
const {
  logEvent,
  getEvents,
  getVisitors,
  getEventsByIp,
  cachedGeo,
  cacheGeo,
  getAnalyticsOverview,
  getDailyTrend,
  getTrafficSources,
  getPageStats,
  getTopImages,
  getTopPricing,
  getPageFlow,
  runReadOnlyQuery,
} = require('./db');

const identity = require('./identity');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway sits behind a proxy -- needed so req.ip is the real visitor IP, not Railway's.
app.set('trust proxy', true);

app.use(express.json({ limit: '100kb' }));
// sendBeacon posts with a Blob, which some browsers label as text/plain -- accept that as JSON too.
app.use(express.json({ limit: '100kb', type: 'text/plain' }));

// --- CORS: only allow the tracking beacon to be POSTed from your own site(s) ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Allow no-origin requests (curl, server-to-server) and any allow-listed origin.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
};

// --- Device classification from the User-Agent string ---
// Returns one of: 'Bot', 'Mobile', 'Tablet', 'Desktop', or null if no UA.
function parseDevice(ua) {
  if (!ua) return null;
  const s = ua.toLowerCase();
  if (/bot|crawl|spider|slurp|facebookexternalhit|snap url|preview|embedly|whatsapp|telegram|discord|pinterest|bingpreview|headless|python-requests|curl|wget|axios|monitor|uptime/.test(s)) {
    return 'Bot';
  }
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(s)) return 'Tablet';
  if (/mobi|iphone|ipod|android|blackberry|iemobile|opera mini/.test(s)) return 'Mobile';
  return 'Desktop';
}

// --- Geolocation: look up approx city/state for an IP, cached per-IP in the DB ---
// Uses ipapi.co free tier. Skips private/local IPs. Never throws into the request path.
function isPublicIp(ip) {
  if (!ip) return false;
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return false;
  return true;
}

async function lookupGeo(ip) {
  // Return cached result if we've seen this IP before.
  const cached = cachedGeo(ip);
  if (cached) return cached;
  if (!isPublicIp(ip)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const r = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    if (d && (d.city || d.region || d.country_name)) {
      const geo = { city: d.city || null, region: d.region || null, country: d.country_name || d.country || null };
      cacheGeo(ip, geo);
      return geo;
    }
  } catch (e) {
    // Geo is best-effort; a failure must never block logging the event.
  }
  return null;
}

// --- Public: the tracking snippet itself, served with open CORS so any allowed page can fetch it ---
app.get('/tracker.js', cors(), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tracker.js'));
});

// --- Public: where the tracker posts events ---
app.options('/api/track', cors(corsOptions));
app.post('/api/track', cors(corsOptions), async (req, res) => {
  const { label, event_type, session_id, page_url, referrer, meta, duration_ms } = req.body || {};

  if (!label || typeof label !== 'string') {
    return res.status(400).json({ ok: false, error: 'label is required' });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;

  const userAgent = req.headers['user-agent'] || null;
  const deviceType = parseDevice(userAgent);

  // Best-effort geolocation; won't block or fail the event write.
  const geo = await lookupGeo(ip);

  logEvent({
    ip_address: ip,
    session_id,
    event_type: event_type || 'event',
    label,
    page_url,
    referrer,
    meta,
    geo_city: geo && geo.city,
    geo_region: geo && geo.region,
    geo_country: geo && geo.country,
    user_agent: userAgent,
    device_type: deviceType,
    duration_ms: typeof duration_ms === 'number' ? duration_ms : null,
  });

  res.json({ ok: true });
});

// --- Public: form submissions identify a visitor by name/email ---
// Sent as text/plain so it does not trigger a CORS preflight.
app.options('/api/identify', cors(corsOptions));
app.post('/api/identify', cors(corsOptions), (req, res) => {
  const { session_id, email, name, phone } = req.body || {};
  const ok = identity.upsertIdentity({ session_id, email, name, phone });
  if (!ok) return res.status(400).json({ ok: false, error: 'session_id and a valid email are required' });
  res.json({ ok: true });
});

// --- Everything below requires the admin login ---
const adminAuth = basicAuth({
  users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'change-me' },
  challenge: true,
  realm: 'WU Traffic',
});

app.get('/api/events', adminAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const sessionId = req.query.session_id || null;
  const result = getEvents({ page, pageSize: 50, sessionId });
  res.json(result);
});

// Grouped "By Visitor" view -- one row per IP.
app.get('/api/visitors', adminAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const result = getVisitors({ page, pageSize: 50 });
  res.json(result);
});

// All events for one IP (expanding a visitor row).
app.get('/api/visitor-events', adminAuth, (req, res) => {
  const ip = req.query.ip || '';
  if (!ip) return res.status(400).json({ ok: false, error: 'ip is required' });
  res.json({ rows: getEventsByIp(ip) });
});

function parseDays(req) {
  const d = parseInt(req.query.days, 10);
  return Number.isFinite(d) && d > 0 ? Math.min(d, 365) : 30;
}

app.get('/api/analytics/overview', adminAuth, (req, res) => {
  res.json(getAnalyticsOverview({ days: parseDays(req) }));
});

app.get('/api/analytics/trend', adminAuth, (req, res) => {
  res.json({ rows: getDailyTrend({ days: parseDays(req) }) });
});

app.get('/api/analytics/sources', adminAuth, (req, res) => {
  res.json({ rows: getTrafficSources({ days: parseDays(req) }) });
});

app.get('/api/analytics/pages', adminAuth, (req, res) => {
  res.json({ rows: getPageStats({ days: parseDays(req) }) });
});

app.get('/api/analytics/top-images', adminAuth, (req, res) => {
  res.json({ rows: getTopImages({ days: parseDays(req) }) });
});

app.get('/api/analytics/top-pricing', adminAuth, (req, res) => {
  res.json({ rows: getTopPricing({ days: parseDays(req) }) });
});

app.get('/api/analytics/flow', adminAuth, (req, res) => {
  res.json({ rows: getPageFlow({ days: parseDays(req) }) });
});

// --- AI query interface: ask a plain-English question about the traffic data ---
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-5';

const SCHEMA_DESCRIPTION = `
Table "events" (one row per tracked event):
  id INTEGER, created_at TEXT (UTC, 'YYYY-MM-DD HH:MM:SS'), ip_address TEXT,
  session_id TEXT, event_type TEXT (one of: pageview, click, milestone, success, error, timing, scroll, event),
  label TEXT (human-readable description of the event),
  page_url TEXT (full URL the event happened on), referrer TEXT,
  meta TEXT (JSON -- use json_extract(meta, '$.field')),
  geo_city TEXT, geo_region TEXT, geo_country TEXT, user_agent TEXT,
  device_type TEXT (Mobile, Desktop, Tablet, or Bot),
  duration_ms INTEGER (only set when event_type = 'timing' -- how long the visitor stayed on that page before leaving).

Notes on "meta" JSON contents by event_type:
  - pageview events: meta.referrer_keyword is the search query that brought them here, when the referrer was a search engine (Google/Bing/Yahoo/DuckDuckGo/Baidu); null for direct/social traffic.
  - click events: meta.kind is 'image', 'link', or 'button'; meta.src/alt for images; meta.href/text for links; meta.text for buttons; meta.page_path is the page it happened on.
  - milestone events with meta.kind = 'pricing': a pricing option was clicked; label/meta.text is the option's visible text; meta.src if the option had a thumbnail image.
  - timing events: meta.page_path is the page the duration applies to.
  - scroll events: meta.percent is the depth milestone reached (25/50/75/100), meta.time_to_reach_ms is how long it took, meta.page_path is the page.

Table "ip_geo": ip TEXT, city TEXT, region TEXT, country TEXT, looked_up_at TEXT. (Geo cache, rarely needed directly -- events already has geo_city/geo_region/geo_country.)
`.trim();

async function callClaude({ system, messages, max_tokens = 1024 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens, system, messages }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Anthropic API error ${r.status}: ${text.slice(0, 300)}`);
  }
  const data = await r.json();
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Guardrail: only ever allow a single, read-only SELECT statement through.
const WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|attach|detach|pragma|vacuum|replace|truncate|create|reindex|analyze)\b/i;

function sanitizeSelect(rawSql) {
  let sql = (rawSql || '').trim();
  // Strip markdown fences in case the model adds them despite instructions.
  sql = sql.replace(/^```sql\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  // Only one statement: drop everything after a semicolon.
  sql = sql.split(';')[0].trim();
  if (!/^select\s/i.test(sql)) throw new Error('Generated query was not a SELECT statement');
  if (WRITE_KEYWORDS.test(sql)) throw new Error('Generated query contained a disallowed keyword');
  if (!/\blimit\s+\d+/i.test(sql)) sql += ' LIMIT 500';
  return sql;
}

app.post('/api/ask', adminAuth, express.json(), async (req, res) => {
  const question = (req.body && req.body.question || '').trim();
  if (!question) return res.status(400).json({ ok: false, error: 'question is required' });

  try {
    const nowIso = new Date().toISOString();
    const sqlText = await callClaude({
      max_tokens: 400,
      system:
        `You translate questions about website analytics into a single SQLite SELECT query.\n\n` +
        `Today's date/time (UTC) is ${nowIso}.\n\n${SCHEMA_DESCRIPTION}\n\n` +
        `Rules:\n- Output ONLY the SQL query. No explanation, no markdown fences, no trailing semicolon.\n` +
        `- SELECT only. Never write, alter, or delete anything.\n` +
        `- Prefer COUNT/GROUP BY/ORDER BY to answer "most", "top", "which" style questions.\n` +
        `- If the question implies a time window (e.g. "this week"), filter created_at accordingly relative to today's date above.`,
      messages: [{ role: 'user', content: question }],
    });

    const sql = sanitizeSelect(sqlText);
    let rows;
    try {
      rows = runReadOnlyQuery(sql);
    } catch (e) {
      return res.status(422).json({ ok: false, error: 'Query failed to run', sql, detail: String(e.message || e) });
    }

    const answer = await callClaude({
      max_tokens: 500,
      system:
        `You are a concise analytics assistant for a wedding-vendor company's website traffic dashboard. ` +
        `Answer the user's question using ONLY the query results provided. Cite specific numbers. ` +
        `If the results are empty, say so plainly rather than guessing. Keep it to 2-4 sentences.`,
      messages: [
        {
          role: 'user',
          content: `Question: ${question}\n\nQuery results (JSON):\n${JSON.stringify(rows).slice(0, 8000)}`,
        },
      ],
    });

    res.json({ ok: true, answer, sql, rows: rows.slice(0, 50) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// --- People: identified visitors and their funnel stage ---
app.get('/api/people', adminAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  res.json(identity.getPeople({ page, pageSize: 50 }));
});

app.get('/api/person-events', adminAuth, (req, res) => {
  const email = req.query.email || '';
  if (!email) return res.status(400).json({ ok: false, error: 'email is required' });
  res.json({ rows: identity.getPersonEvents(email) });
});

app.post('/api/people/stage', adminAuth, express.json(), (req, res) => {
  const { email, stage } = req.body || {};
  if (!email || !stage) return res.status(400).json({ ok: false, error: 'email and stage are required' });
  if (!identity.setPersonStage(email, stage)) {
    return res.status(400).json({ ok: false, error: 'unknown person or invalid stage' });
  }
  res.json({ ok: true });
});

// Behavior comparison: converted vs inquired-not-booked vs anonymous.
app.get('/api/insights', adminAuth, (req, res) => res.json(identity.getInsights()));

// Delete a person (unlinks their sessions; raw events are kept).
app.post('/api/people/delete', adminAuth, express.json(), (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'email is required' });
  res.json({ ok: true, result: identity.deletePerson(email) });
});

app.use('/admin', adminAuth, express.static(path.join(__dirname, 'views')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`WU traffic tracker running on port ${PORT}`);
});
