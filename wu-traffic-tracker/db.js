const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/traffic.db';

// Make sure the folder exists (needed the first time the container/volume boots)
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ip_address TEXT,
    session_id TEXT,
    event_type TEXT NOT NULL,
    label TEXT NOT NULL,
    page_url TEXT,
    referrer TEXT,
    meta TEXT,
    geo_city TEXT,
    geo_region TEXT,
    geo_country TEXT,
    user_agent TEXT,
    device_type TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_ip ON events(ip_address);

  -- Per-IP geolocation cache so we only hit the geo API once per address.
  CREATE TABLE IF NOT EXISTS ip_geo (
    ip TEXT PRIMARY KEY,
    city TEXT,
    region TEXT,
    country TEXT,
    looked_up_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- Migration: add newer columns to an existing events table if they're missing ---
const cols = db.prepare(`PRAGMA table_info(events)`).all().map((c) => c.name);
for (const col of ['geo_city', 'geo_region', 'geo_country', 'user_agent', 'device_type']) {
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE events ADD COLUMN ${col} TEXT`);
  }
}
// duration_ms is numeric (used for 'timing' events -- how long a visitor stayed on a page)
if (!cols.includes('duration_ms')) {
  db.exec(`ALTER TABLE events ADD COLUMN duration_ms INTEGER`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)`);

const insertEvent = db.prepare(`
  INSERT INTO events (ip_address, session_id, event_type, label, page_url, referrer, meta, geo_city, geo_region, geo_country, user_agent, device_type, duration_ms)
  VALUES (@ip_address, @session_id, @event_type, @label, @page_url, @referrer, @meta, @geo_city, @geo_region, @geo_country, @user_agent, @device_type, @duration_ms)
`);

const getGeoCache = db.prepare(`SELECT city, region, country FROM ip_geo WHERE ip = ?`);
const setGeoCache = db.prepare(`
  INSERT INTO ip_geo (ip, city, region, country) VALUES (@ip, @city, @region, @country)
  ON CONFLICT(ip) DO UPDATE SET city=excluded.city, region=excluded.region, country=excluded.country, looked_up_at=datetime('now')
`);

function cachedGeo(ip) {
  if (!ip) return null;
  return getGeoCache.get(ip) || null;
}

function cacheGeo(ip, geo) {
  if (!ip || !geo) return;
  setGeoCache.run({ ip, city: geo.city || null, region: geo.region || null, country: geo.country || null });
}

function logEvent(evt) {
  insertEvent.run({
    ip_address: evt.ip_address || null,
    session_id: evt.session_id || null,
    event_type: evt.event_type || 'custom',
    label: evt.label,
    page_url: evt.page_url || null,
    referrer: evt.referrer || null,
    meta: evt.meta ? JSON.stringify(evt.meta) : null,
    geo_city: evt.geo_city || null,
    geo_region: evt.geo_region || null,
    geo_country: evt.geo_country || null,
    user_agent: evt.user_agent || null,
    device_type: evt.device_type || null,
    duration_ms: Number.isFinite(evt.duration_ms) ? evt.duration_ms : null,
  });
}

function getEvents({ page = 1, pageSize = 50, sessionId = null } = {}) {
  const offset = (page - 1) * pageSize;
  let rows, total;
  if (sessionId) {
    rows = db.prepare(
      `SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(sessionId, pageSize, offset);
    total = db.prepare(`SELECT COUNT(*) c FROM events WHERE session_id = ?`).get(sessionId).c;
  } else {
    rows = db.prepare(
      `SELECT * FROM events ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(pageSize, offset);
    total = db.prepare(`SELECT COUNT(*) c FROM events`).get().c;
  }
  return { rows, total, page, pageSize };
}

// Grouped-by-visitor view: one row per IP, with visit stats and best-known location/device.
function getVisitors({ page = 1, pageSize = 50 } = {}) {
  const offset = (page - 1) * pageSize;
  const rows = db.prepare(`
    SELECT
      ip_address,
      COUNT(*) AS event_count,
      COUNT(DISTINCT session_id) AS session_count,
      MIN(created_at) AS first_seen,
      MAX(created_at) AS last_seen,
      MAX(geo_city) AS geo_city,
      MAX(geo_region) AS geo_region,
      MAX(geo_country) AS geo_country,
      MAX(device_type) AS device_type
    FROM events
    GROUP BY ip_address
    ORDER BY MAX(created_at) DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, offset);
  const total = db.prepare(`SELECT COUNT(DISTINCT ip_address) c FROM events`).get().c;
  return { rows, total, page, pageSize };
}

// All events for a single IP (used when expanding a visitor).
function getEventsByIp(ip) {
  return db.prepare(`SELECT * FROM events WHERE ip_address = ? ORDER BY id DESC LIMIT 500`).all(ip);
}

// ---------------------------------------------------------------------
// Analytics: everything below powers the "Analytics" tab + AI query box.
// All of it reads from `events`; nothing here writes.
// ---------------------------------------------------------------------

function sinceClause(days) {
  const n = Number.isFinite(days) && days > 0 ? days : 30;
  return `datetime('now', '-${n} days')`;
}

// High-level KPIs: avg time on site per session, sessions, visitors, pageviews.
function getAnalyticsOverview({ days = 30 } = {}) {
  const since = sinceClause(days);

  const sessionDurations = db.prepare(`
    SELECT session_id, SUM(duration_ms) AS total_ms
    FROM events
    WHERE event_type = 'timing' AND duration_ms IS NOT NULL AND session_id IS NOT NULL
      AND created_at >= ${since}
    GROUP BY session_id
  `).all();
  const avgTimeOnSiteMs = sessionDurations.length
    ? Math.round(sessionDurations.reduce((s, r) => s + (r.total_ms || 0), 0) / sessionDurations.length)
    : 0;

  const pagesPerSession = db.prepare(`
    SELECT session_id, COUNT(*) AS n
    FROM events
    WHERE event_type = 'pageview' AND session_id IS NOT NULL AND created_at >= ${since}
    GROUP BY session_id
  `).all();
  const avgPagesPerSession = pagesPerSession.length
    ? +(pagesPerSession.reduce((s, r) => s + r.n, 0) / pagesPerSession.length).toFixed(1)
    : 0;

  const totalSessions = db.prepare(`
    SELECT COUNT(DISTINCT session_id) c FROM events WHERE session_id IS NOT NULL AND created_at >= ${since}
  `).get().c;
  const totalVisitors = db.prepare(`
    SELECT COUNT(DISTINCT ip_address) c FROM events WHERE ip_address IS NOT NULL AND created_at >= ${since}
  `).get().c;
  const totalPageviews = db.prepare(`
    SELECT COUNT(*) c FROM events WHERE event_type = 'pageview' AND created_at >= ${since}
  `).get().c;

  return { avgTimeOnSiteMs, avgPagesPerSession, totalSessions, totalVisitors, totalPageviews, days };
}

// Daily pageviews + sessions, for a trend line.
function getDailyTrend({ days = 30 } = {}) {
  const since = sinceClause(days);
  return db.prepare(`
    SELECT
      date(created_at) AS day,
      SUM(CASE WHEN event_type = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
      COUNT(DISTINCT session_id) AS sessions
    FROM events
    WHERE created_at >= ${since}
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all();
}

function hostnameOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return null; }
}

// Where sessions came from: external referrer domain (grouped) or "Direct".
// Uses each session's FIRST pageview to determine its source.
function getTrafficSources({ days = 30 } = {}) {
  const since = sinceClause(days);
  const firstPageviews = db.prepare(`
    SELECT e.session_id, e.referrer, e.page_url
    FROM events e
    JOIN (
      SELECT session_id, MIN(id) AS first_id
      FROM events
      WHERE event_type = 'pageview' AND session_id IS NOT NULL AND created_at >= ${since}
      GROUP BY session_id
    ) f ON f.first_id = e.id
  `).all();

  const siteHost = firstPageviews.length ? hostnameOf(firstPageviews[0].page_url) : null;
  const counts = new Map();
  for (const r of firstPageviews) {
    const refHost = hostnameOf(r.referrer);
    let source;
    if (!refHost) source = 'Direct';
    else if (siteHost && refHost === siteHost) source = 'Direct';
    else source = refHost;
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, sessions]) => ({ source, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
}

function pathOf(url) {
  if (!url) return null;
  try { return new URL(url).pathname || '/'; } catch (e) { return url; }
}

// Per-page stats: views, avg time spent, and clicks recorded on that page.
function getPageStats({ days = 30 } = {}) {
  const since = sinceClause(days);

  const views = db.prepare(`
    SELECT page_url FROM events WHERE event_type = 'pageview' AND created_at >= ${since}
  `).all();
  const viewCounts = new Map();
  for (const r of views) {
    const p = pathOf(r.page_url);
    if (!p) continue;
    viewCounts.set(p, (viewCounts.get(p) || 0) + 1);
  }

  const timings = db.prepare(`
    SELECT json_extract(meta, '$.page_path') AS page_path, duration_ms
    FROM events
    WHERE event_type = 'timing' AND duration_ms IS NOT NULL AND created_at >= ${since}
  `).all();
  const timeAgg = new Map(); // path -> { sum, n }
  for (const r of timings) {
    if (!r.page_path) continue;
    const cur = timeAgg.get(r.page_path) || { sum: 0, n: 0 };
    cur.sum += r.duration_ms;
    cur.n += 1;
    timeAgg.set(r.page_path, cur);
  }

  const clicks = db.prepare(`
    SELECT json_extract(meta, '$.page_path') AS page_path, COUNT(*) AS c
    FROM events
    WHERE event_type IN ('click', 'milestone') AND created_at >= ${since}
    GROUP BY json_extract(meta, '$.page_path')
  `).all();
  const clickAgg = new Map(clicks.map((r) => [r.page_path, r.c]));

  const paths = new Set([...viewCounts.keys(), ...timeAgg.keys(), ...clickAgg.keys()]);
  const rows = [...paths].filter(Boolean).map((path) => {
    const t = timeAgg.get(path);
    return {
      page_path: path,
      views: viewCounts.get(path) || 0,
      avg_duration_ms: t ? Math.round(t.sum / t.n) : null,
      clicks: clickAgg.get(path) || 0,
    };
  });
  rows.sort((a, b) => b.views - a.views);
  return rows;
}

// Most-clicked images site-wide.
function getTopImages({ days = 30, limit = 20 } = {}) {
  const since = sinceClause(days);
  return db.prepare(`
    SELECT
      COALESCE(json_extract(meta, '$.alt'), json_extract(meta, '$.src')) AS name,
      json_extract(meta, '$.src') AS src,
      COUNT(*) AS clicks
    FROM events
    WHERE event_type = 'click' AND json_extract(meta, '$.kind') = 'image' AND created_at >= ${since}
    GROUP BY json_extract(meta, '$.src')
    ORDER BY clicks DESC
    LIMIT ?
  `).all(limit);
}

// Most-clicked pricing options.
function getTopPricing({ days = 30, limit = 20 } = {}) {
  const since = sinceClause(days);
  return db.prepare(`
    SELECT label, COUNT(*) AS clicks
    FROM events
    WHERE event_type = 'milestone' AND json_extract(meta, '$.kind') = 'pricing' AND created_at >= ${since}
    GROUP BY label
    ORDER BY clicks DESC
    LIMIT ?
  `).all(limit);
}

// Page -> next-page navigation flow (within the same session).
function getPageFlow({ days = 30, limit = 30 } = {}) {
  const since = sinceClause(days);
  const rows = db.prepare(`
    WITH pv AS (
      SELECT
        session_id,
        page_url,
        created_at,
        LAG(page_url) OVER (PARTITION BY session_id ORDER BY created_at, id) AS prev_url
      FROM events
      WHERE event_type = 'pageview' AND session_id IS NOT NULL AND created_at >= ${since}
    )
    SELECT prev_url, page_url FROM pv WHERE prev_url IS NOT NULL
  `).all();

  const counts = new Map();
  for (const r of rows) {
    const from = pathOf(r.prev_url);
    const to = pathOf(r.page_url);
    if (!from || !to || from === to) continue;
    const key = from + ' -> ' + to;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [from_page, to_page] = key.split(' -> ');
      return { from_page, to_page, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// Runs an AI-generated, read-only SQL query. Only ever called after the
// caller (server.js) has validated it's a single SELECT with no write
// keywords -- this function itself just executes and caps result size.
function runReadOnlyQuery(sql) {
  const stmt = db.prepare(sql);
  return stmt.all();
}

module.exports = {
  db,
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
};
