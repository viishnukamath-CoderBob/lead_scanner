'use strict';
// Standalone data layer: everything is stored in this browser (localStorage). No server, no database, no accounts elsewhere.
// It implements the same api() routes the UI uses, so app.js is identical to the cloud versions.
class NetErr extends Error {}
const configured = true;
const DB_KEY = 'lcl_db', TOKEN_KEY = 'lc_token', TEMPS = ['Hot', 'Warm', 'Cold'];
const SEED_TOPICS = ['Cyber Resiliency', 'FlashSystem.ai', 'IRE', 'Storage Insights'];
const nowIso = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const httpErr = (status, message) => { const e = new Error(message); e.status = status; return e; };
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function load() {
  try { const d = JSON.parse(localStorage.getItem(DB_KEY)); if (d && d.users) return d; } catch (e) { /* fall through */ }
  return { ver: 1, users: [], leads: [], topics: SEED_TOPICS.map((n) => ({ id: uid(), name: n, active: 1, created_at: nowIso() })) };
}
let db = load();
const save = () => { db.ver++; localStorage.setItem(DB_KEY, JSON.stringify(db)); };
window.addEventListener('storage', (e) => { if (e.key === DB_KEY) { db = load(); if (poll) poll.tick(); } });   // another tab changed the data

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* storage blocked */ }
const setToken = (t) => { token = t; try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } };
const hasToken = () => !!token;
const firstRun = () => db.users.length === 0;

const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 150000 }, key, 256));
}
const pub = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role });
const me = () => {
  const u = db.users.find((x) => x.id === token);
  if (!u || !u.active) throw httpErr(401, 'Not signed in');
  return u;
};
const leadOut = (l) => ({ ...l });
const listLeads = (limit) => db.leads.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)).slice(0, limit).map(leadOut);
const listTopics = (all) => db.topics.filter((t) => all || t.active).map((t) => ({ id: t.id, name: t.name, active: t.active ? 1 : 0 })).sort((a, b) => a.name.localeCompare(b.name));
function fields(b) {
  const t = TEMPS.find((x) => x.toLowerCase() === String(b.temperature || '').toLowerCase());
  return { name: clip(b.name, 200), company: clip(b.company, 200), title: clip(b.title, 200), email: clip(b.email, 200), phone: clip(b.phone, 60), notes: clip(b.notes, 4000), temperature: t,
    source: ['ocr', 'manual'].includes(b.source) ? b.source : 'manual' };
}
const needContent = (f) => { if (!f.temperature) throw httpErr(400, 'Select Hot, Warm or Cold'); if (!f.name && !f.email && !f.company && !f.phone) throw httpErr(400, 'Enter at least a name, company, email or phone'); };

async function handle(method, p, q, b) {
  const key = method + ' ' + p.replace(/^(\/leads|\/admin\/users|\/admin\/topics)\/([^/]+)$/, (_, base) => base + '/:id'), id = (p.match(/^\/(?:leads|admin\/users|admin\/topics)\/([^/]+)$/) || [])[1];
  if (key === 'POST /login') {
    const username = clip(b.username, 80).toLowerCase(), password = String(b.password == null ? '' : b.password);
    if (firstRun()) {                                   // first person to open the app on this device creates the admin account
      if (!/^[a-z0-9._@-]{3,80}$/.test(username)) throw httpErr(400, 'Username: 3-80 chars (a-z, 0-9, . _ @ -)');
      if (password.length < 8) throw httpErr(400, 'Password must be at least 8 characters');
      const salt = uid(), u = { id: uid(), username, name: username === 'admin' ? 'Administrator' : username, role: 'admin', active: 1, salt, hash: await hashPw(password, salt), created_at: nowIso() };
      db.users.push(u); save(); setToken(u.id); return pub(u);
    }
    const u = db.users.find((x) => x.username === username);
    const good = u && u.active && (await hashPw(password, u.salt)) === u.hash;
    if (!good) throw httpErr(401, 'Invalid username or password');
    setToken(u.id); return pub(u);
  }
  const user = me(), admin = () => { if (user.role !== 'admin') throw httpErr(403, 'Admin only'); };
  switch (key) {
    case 'GET /me': return pub(user);
    case 'POST /logout': setToken(null); return { ok: true };
    case 'POST /password': {
      const next = String(b.next || ''); if (next.length < 8) throw httpErr(400, 'New password must be at least 8 characters');
      if ((await hashPw(String(b.current || ''), user.salt)) !== user.hash) throw httpErr(400, 'Current password is incorrect');
      user.salt = uid(); user.hash = await hashPw(next, user.salt); save(); return { ok: true };
    }
    case 'GET /sync': return String(q.ver) === String(db.ver) ? { changed: false, ver: db.ver } : { changed: true, ver: db.ver, leads: listLeads(1000), topics: listTopics(user.role === 'admin') };
    case 'GET /topics': return listTopics(q.all === '1' && user.role === 'admin');
    case 'GET /leads': return listLeads(Math.min(Number(q.limit) || 1000, 10000));
    case 'POST /leads': {
      const f = fields(b); needContent(f); const cid = clip(b.client_id, 80);
      if (cid) { const dup = db.leads.find((l) => l.client_id === cid); if (dup) return leadOut(dup); }
      const t = db.topics.find((x) => x.id === String(b.topic_id || '') && x.active); if (!t) throw httpErr(400, 'Select a valid demo topic');
      const ts = nowIso(), l = { id: uid(), client_id: cid, created_at: ts, updated_at: ts, topic_id: t.id, topic: t.name, temperature: f.temperature, name: f.name, company: f.company, title: f.title, email: f.email, phone: f.phone, notes: f.notes, captured_by: user.name, user_id: user.id, source: f.source };
      db.leads.push(l); save(); return leadOut(l);
    }
    case 'PUT /leads/:id': {
      const l = db.leads.find((x) => x.id === id); if (!l) throw httpErr(404, 'Not found');
      if (l.user_id !== user.id && user.role !== 'admin') throw httpErr(403, 'Not your lead');
      const f = fields({ ...l, ...b, source: l.source }); needContent(f);
      if (b.topic_id && b.topic_id !== l.topic_id) { const t = db.topics.find((x) => x.id === b.topic_id); if (!t) throw httpErr(400, 'Invalid topic'); l.topic_id = t.id; l.topic = t.name; }
      Object.assign(l, { name: f.name, company: f.company, title: f.title, email: f.email, phone: f.phone, notes: f.notes, temperature: f.temperature, updated_at: nowIso() });
      save(); return leadOut(l);
    }
    case 'DELETE /leads/:id': {
      const l = db.leads.find((x) => x.id === id); if (!l) throw httpErr(404, 'Not found');
      if (l.user_id !== user.id && user.role !== 'admin') throw httpErr(403, 'Not your lead');
      db.leads = db.leads.filter((x) => x !== l); save(); return { ok: true };
    }
    case 'GET /admin/users': admin(); return db.users.map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active ? 1 : 0, created_at: u.created_at, lead_count: db.leads.filter((l) => l.user_id === u.id).length }));
    case 'POST /admin/users': {
      admin(); const username = clip(b.username, 80).toLowerCase(), password = String(b.password || '');
      if (!/^[a-z0-9._@-]{3,80}$/.test(username)) throw httpErr(400, 'Username: 3-80 chars (a-z, 0-9, . _ @ -)');
      if (password.length < 8) throw httpErr(400, 'Password must be at least 8 characters');
      if (db.users.some((u) => u.username === username)) throw httpErr(409, 'Username already exists');
      const salt = uid(); db.users.push({ id: uid(), username, name: clip(b.name, 120) || username, role: b.role === 'admin' ? 'admin' : 'user', active: 1, salt, hash: await hashPw(password, salt), created_at: nowIso() });
      save(); return { ok: true };
    }
    case 'PUT /admin/users/:id': {
      admin(); const u = db.users.find((x) => x.id === id); if (!u) throw httpErr(404, 'Not found');
      const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active, role = b.role ? (b.role === 'admin' ? 'admin' : 'user') : u.role;
      if (u.id === user.id && (!active || role !== 'admin')) throw httpErr(400, "You can't disable or demote yourself");
      if (b.password !== undefined && String(b.password).length < 8) throw httpErr(400, 'Password must be at least 8 characters');
      u.active = active; u.role = role; if (b.name !== undefined) u.name = clip(b.name, 120) || u.name;
      if (b.password) { u.salt = uid(); u.hash = await hashPw(String(b.password), u.salt); }
      save(); return { ok: true };
    }
    case 'POST /admin/topics': {
      admin(); const name = clip(b.name, 120); if (!name) throw httpErr(400, 'Name required');
      if (db.topics.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw httpErr(409, 'Topic already exists');
      db.topics.push({ id: uid(), name, active: 1, created_at: nowIso() }); save(); return { ok: true };
    }
    case 'PUT /admin/topics/:id': {
      admin(); const t = db.topics.find((x) => x.id === id); if (!t) throw httpErr(404, 'Not found');
      const name = b.name !== undefined ? clip(b.name, 120) : t.name; if (!name) throw httpErr(400, 'Name required');
      if (db.topics.some((x) => x !== t && x.name.toLowerCase() === name.toLowerCase())) throw httpErr(409, 'Topic already exists');
      if (name !== t.name) db.leads.forEach((l) => { if (l.topic_id === t.id) l.topic = name; });
      t.name = name; if (b.active !== undefined) t.active = b.active ? 1 : 0; save(); return { ok: true };
    }
    case 'GET /admin/stats': {
      admin(); const cnt = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
      const byT = cnt(db.leads, (l) => l.temperature), byTop = cnt(db.leads, (l) => l.topic_id), hot = cnt(db.leads.filter((l) => l.temperature === 'Hot'), (l) => l.topic_id), byU = cnt(db.leads, (l) => l.user_id);
      return { total: db.leads.length, byTemp: Object.keys(byT).map((k) => ({ k, n: byT[k] })),
        byTopic: db.topics.map((t) => ({ k: t.name, n: byTop[t.id] || 0, hot: hot[t.id] || 0 })).sort((a, b) => b.n - a.n), byUser: db.users.map((u) => ({ k: u.name, n: byU[u.id] || 0 })).sort((a, b) => b.n - a.n) };
    }
    default: throw httpErr(404, 'Not found');
  }
}
async function api(path, opts = {}) {
  const [p, qs] = path.split('?');
  const out = await handle(opts.method || 'GET', p, Object.fromEntries(new URLSearchParams(qs || '')), opts.body || {}).catch((e) => {
    if (e.status === 401 && p !== '/login') { setToken(null); if (typeof window.onSessionLost === 'function') window.onSessionLost(); }
    throw e;
  });
  return JSON.parse(JSON.stringify(out));
}

// ---- live refresh: re-render when this device's data changes (also across tabs) ----
let poll = null;
function startSync(h) {
  stopSync();
  const st = (poll = { ver: '', dead: false });
  st.tick = async () => { if (st.dead) return; try { const r = await api('/sync?ver=' + encodeURIComponent(st.ver)); h.onStatus(true); if (r.changed) { st.ver = r.ver; h.onData(r); } } catch (e) { /* signed out */ } };
  st.tick();
}
function stopSync() { if (poll) { poll.dead = true; poll = null; } }
function syncNow() { if (poll) poll.tick(); }

// ---- Excel export, generated in the browser from the live data ----
async function exportXlsx() {
  if (!window.ExcelJS) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/exceljs.min.js'; s.onload = res; s.onerror = () => rej(new Error('Excel library failed to load')); document.head.appendChild(s); });
  const [leads, topics] = await Promise.all([api('/leads?limit=10000'), api('/topics?all=1')]);
  const TEMPS = ['Hot', 'Warm', 'Cold'];
  const wb = new ExcelJS.Workbook(); wb.creator = 'Lead Capture';
  const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Captured At (UTC)', key: 'created_at', width: 22 }, { header: 'Demo Topic', key: 'topic', width: 24 }, { header: 'Temperature', key: 'temperature', width: 13 },
    { header: 'Name', key: 'name', width: 24 }, { header: 'Company', key: 'company', width: 26 }, { header: 'Title', key: 'title', width: 24 },
    { header: 'Email', key: 'email', width: 30 }, { header: 'Phone', key: 'phone', width: 18 }, { header: 'Notes', key: 'notes', width: 50 },
    { header: 'Captured By', key: 'captured_by', width: 20 }, { header: 'Source', key: 'source', width: 10 },
  ];
  const fill = { Hot: 'FFF8B4B4', Warm: 'FFFFE0A3', Cold: 'FFBBD7F5' };
  const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v); // block spreadsheet formula injection
  for (const l of leads) {
    const row = ws.addRow({ ...Object.fromEntries(Object.entries(l).map(([k, v]) => [k, safe(v)])), created_at: String(l.created_at).replace('T', ' ').slice(0, 19) });
    row.getCell('temperature').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill[l.temperature] } };
    row.getCell('notes').alignment = { wrapText: true, vertical: 'top' };
  }
  const hd = ws.getRow(1); hd.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hd.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } }; ws.autoFilter = { from: 'A1', to: 'K1' };
  const sum = wb.addWorksheet('Summary'); sum.addRow(['Demo Topic', 'Total', 'Hot', 'Warm', 'Cold']).font = { bold: true };
  for (const t of topics) { const ls = leads.filter((l) => l.topic_id === t.id); sum.addRow([t.name, ls.length, ...TEMPS.map((x) => ls.filter((l) => l.temperature === x).length)]); }
  sum.addRow(['All topics', leads.length, ...TEMPS.map((x) => leads.filter((l) => l.temperature === x).length)]).font = { bold: true };
  sum.columns.forEach((c, i) => (c.width = i ? 10 : 28));
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = `leads-${new Date().toISOString().slice(0, 10)}.xlsx`; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return leads.length;
}
