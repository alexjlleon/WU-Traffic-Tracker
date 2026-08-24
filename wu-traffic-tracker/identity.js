// Identity layer: links browser sessions to real people who filled out a form.
// Self-contained -- opens its own connection to the same SQLite file, so adding
// this required no changes to db.js.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/traffic.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  -- People who identified themselves (inquiry form, booking, etc.)
  -- funnel_stage: lead -> booked -> customer, or lost.
  CREATE TABLE IF NOT EXISTS people (
    email TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    funnel_stage TEXT NOT NULL DEFAULT 'lead',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Which browser sessions belong to which person. One person can have many
  -- (phone + laptop, cleared storage, etc.).
  CREATE TABLE IF NOT EXISTS identity_sessions (
    session_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    linked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_identity_email ON identity_sessions(email);
`);

const upsertPerson = db.prepare(`
  INSERT INTO people (email, name, phone) VALUES (@email, @name, @phone)
  ON CONFLICT(email) DO UPDATE SET
    name = COALESCE(excluded.name, people.name),
    phone = COALESCE(excluded.phone, people.phone),
    updated_at = datetime('now')
`);

const linkSession = db.prepare(`
  INSERT INTO identity_sessions (session_id, email) VALUES (@session_id, @email)
  ON CONFLICT(session_id) DO UPDATE SET email = excluded.email, linked_at = datetime('now')
`);

// Called when a visitor submits a form. Email is the stable key for a person.
function upsertIdentity({ session_id, email, name, phone }) {
  if (!session_id || !email) return false;
  email = String(email).trim().toLowerCase().slice(0, 200);
  if (!email.includes('@')) return false;
  upsertPerson.run({
    email,
    name: name ? String(name).trim().slice(0, 200) : null,
    phone: phone ? String(phone).trim().slice(0, 50) : null,
  });
  linkSession.run({ session_id: String(session_id).slice(0, 120), email });
  return true;
}

function setPersonStage(email, stage) {
  if (!['lead', 'booked', 'customer', 'lost'].includes(stage)) return false;
  const r = db
    .prepare(`UPDATE people SET funnel_stage = ?, updated_at = datetime('now') WHERE email = ?`)
    .run(stage, String(email).trim().toLowerCase());
  return r.changes > 0;
}

function getPeople({ page = 1, pageSize = 50 } = {}) {
  const offset = (page - 1) * pageSize;
  const rows = db.prepare(`
    SELECT
      p.email, p.name, p.phone, p.funnel_stage,
      COUNT(DISTINCT s.session_id) AS session_count,
      COUNT(e.id) AS event_count,
      MIN(e.created_at) AS first_seen,
      MAX(e.created_at) AS last_seen
    FROM people p
    LEFT JOIN identity_sessions s ON s.email = p.email
    LEFT JOIN events e ON e.session_id = s.session_id
    GROUP BY p.email
    ORDER BY COALESCE(MAX(e.created_at), p.created_at) DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM people`).get().c;
  return { rows, total, page, pageSize };
}

// Full cross-session timeline for one person.
function getPersonEvents(email) {
  return db.prepare(`
    SELECT e.* FROM events e
    JOIN identity_sessions s ON s.session_id = e.session_id
    WHERE s.email = ?
    ORDER BY e.id DESC LIMIT 500
  `).all(String(email).trim().toLowerCase());
}

// Behavior comparison: converted vs inquired-not-booked vs anonymous.
function getInsights() {
  const links = db.prepare(`
    SELECT s.session_id, p.funnel_stage FROM identity_sessions s
    JOIN people p ON p.email = s.email
  `).all();
  const stageBySession = new Map(links.map((r) => [r.session_id, r.funnel_stage]));

  const events = db.prepare(`
    SELECT session_id, event_type, label, page_url, referrer, device_type
    FROM events WHERE session_id IS NOT NULL
    ORDER BY id DESC LIMIT 25000
  `).all();

  const mk = () => ({
    sessions: new Set(), events: 0, pageviews: 0,
    pages: new Map(), refs: new Map(), deep: new Set(), mobile: new Set(),
  });
  const groups = { converted: mk(), not_converted: mk(), anonymous: mk() };

  for (const e of events) {
    const stage = stageBySession.get(e.session_id);
    let key = 'anonymous';
    if (stage === 'booked' || stage === 'customer') key = 'converted';
    else if (stage === 'lead' || stage === 'lost') key = 'not_converted';
    const g = groups[key];

    g.sessions.add(e.session_id);
    g.events++;
    if (e.device_type === 'Mobile') g.mobile.add(e.session_id);

    if (e.event_type === 'pageview') {
      g.pageviews++;
      let page = null;
      try { page = new URL(e.page_url).pathname; } catch (err) { /* no usable url */ }
      if (!page) page = String(e.label || '').replace(/^Viewed page:\s*/, '') || '/';
      g.pages.set(page, (g.pages.get(page) || 0) + 1);
    }

    if (/scroll/i.test(e.label || '') && /(75|100)/.test(e.label || '')) g.deep.add(e.session_id);

    if (e.referrer) {
      try {
        const h = new URL(e.referrer).hostname.replace(/^www\./, '');
        if (!h.includes('weddingsunlimited')) g.refs.set(h, (g.refs.get(h) || 0) + 1);
      } catch (err) { /* unparseable referrer */ }
    }
  }

  const out = {};
  for (const [key, g] of Object.entries(groups)) {
    const n = g.sessions.size || 1;
    out[key] = {
      sessions: g.sessions.size,
      total_events: g.events,
      avg_events_per_session: +(g.events / n).toFixed(1),
      avg_pageviews_per_session: +(g.pageviews / n).toFixed(1),
      deep_scroll_pct: Math.round((100 * g.deep.size) / n),
      mobile_pct: Math.round((100 * g.mobile.size) / n),
      top_pages: [...g.pages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([page, count]) => ({ page, count })),
      top_referrers: [...g.refs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([ref, count]) => ({ ref, count })),
    };
  }
  return out;
}

module.exports = { upsertIdentity, setPersonStage, getPeople, getPersonEvents, getInsights };
