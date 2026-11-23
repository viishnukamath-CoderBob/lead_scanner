const express = require('express');
const crypto = require('crypto');
const path = require('path');
const ExcelJS = require('exceljs');
const { open } = require('./db');

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 3;
const TEMPS = ['Hot', 'Warm', 'Cold'];
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

// ---------- password + session helpers ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const exp = Buffer.from(hashHex, 'hex');
  return exp.length === h.length && crypto.timingSafeEqual(h, exp);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const str = (v, max) => String(v ?? '').trim().slice(0, max);

// ---------- login rate limiting (in-memory) ----------
const attempts = new Map();
function throttled(key) {
  const a = attempts.get(key);
  return a && a.count >= 8 && Date.now() - a.first < 10 * 60 * 1000;
}
function recordFail(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > 10 * 60 * 1000) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}

async function main() {
  const db = await open();
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // ---------- security headers ----------
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "media-src 'self' blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
  // Force HTTPS in production behind a proxy
  app.use((req, res, next) => {
    if (process.env.FORCE_HTTPS === '1' && !req.secure) return res.redirect(308, 'https://' + req.headers.host + req.originalUrl);
    next();
  });
  // CSRF defence: mutating requests must be same-origin
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked' }); }
      catch { return res.status(403).json({ error: 'Bad origin' }); }
    }
    next();
  });

  // ---------- bootstrap data ----------
  const [{ c: userCount }] = await db.query('SELECT COUNT(*) AS c FROM users');
  if (Number(userCount) === 0) {
    const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
    let pw = process.env.ADMIN_PASSWORD;
    const generated = !pw;
    if (generated) pw = crypto.randomBytes(9).toString('base64url');
    await db.query('INSERT INTO users (id,username,name,password_hash,role,active,created_at) VALUES (?,?,?,?,?,?,?)',
      [uid(), username, 'Administrator', hashPassword(pw), 'admin', 1, now()]);
    console.log(`\n[setup] Admin account created. username: ${username}${generated ? '  password: ' + pw : ''}\n`);
  }
  const [{ c: topicCount }] = await db.query('SELECT COUNT(*) AS c FROM topics');
  if (Number(topicCount) === 0) {
    for (const t of (process.env.SEED_TOPICS || 'AI & Automation,Hybrid Cloud,Data & Analytics,Security').split(','))
      if (t.trim()) await db.query('INSERT INTO topics (id,name,active,created_at) VALUES (?,?,?,?)', [uid(), t.trim(), 1, now()]);
  }

  // ---------- auth middleware ----------
  const cookieOf = (req, name) => {
    const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
  };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const auth = wrap(async (req, res, next) => {
    const token = cookieOf(req, 'sid');
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    const rows = await db.query(
      `SELECT u.id,u.username,u.name,u.role,u.active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`,
      [sha(token)]);
    const u = rows[0];
    if (!u || !Number(u.active) || u.expires_at < now()) return res.status(401).json({ error: 'Session expired' });
    req.user = { id: u.id, username: u.username, name: u.name, role: u.role };
    next();
  });
  const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' }));

  // ---------- realtime (SSE) ----------
  const clients = new Set();
  function broadcast(type, data) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  }
  app.get('/api/stream', auth, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  });

  // ---------- auth routes ----------
  app.post('/api/login', wrap(async (req, res) => {
    const username = str(req.body.username, 80).toLowerCase();
    const password = String(req.body.password ?? '');
    const key = req.ip + '|' + username;
    if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const [u] = await db.query('SELECT * FROM users WHERE username=?', [username]);
    if (!u || !Number(u.active) || !verifyPassword(password, u.password_hash)) {
      recordFail(key);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    attempts.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    await db.query('DELETE FROM sessions WHERE expires_at < ?', [now()]);
    await db.query('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)', [sha(token), u.id, exp]);
    res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5, path: '/' });
    res.json({ id: u.id, username: u.username, name: u.name, role: u.role });
  }));
  app.post('/api/logout', wrap(async (req, res) => {
    const t = cookieOf(req, 'sid');
    if (t) await db.query('DELETE FROM sessions WHERE token_hash=?', [sha(t)]);
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  }));
  app.get('/api/me', auth, (req, res) => res.json(req.user));
  app.post('/api/password', auth, wrap(async (req, res) => {
    const { current, next } = req.body;
    if (!next || String(next).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const [u] = await db.query('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
    if (!verifyPassword(String(current ?? ''), u.password_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
    await db.query('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(String(next)), req.user.id]);
    res.json({ ok: true });
  }));

  // ---------- topics ----------
  app.get('/api/topics', auth, wrap(async (req, res) => {
    const all = req.query.all === '1' && req.user.role === 'admin';
    res.json(await db.query(`SELECT id,name,active FROM topics ${all ? '' : 'WHERE active=1'} ORDER BY name`));
  }));

  // ---------- leads ----------
  const LEAD_SELECT = `SELECT l.id,l.client_id,l.topic_id,t.name AS topic,l.user_id,u.name AS captured_by,l.name,l.company,l.title,l.email,l.phone,
      l.temperature,l.notes,l.source,l.created_at,l.updated_at
    FROM leads l JOIN topics t ON t.id=l.topic_id JOIN users u ON u.id=l.user_id`;

  function leadFields(b) {
    const temperature = TEMPS.find((t) => t.toLowerCase() === String(b.temperature || '').toLowerCase());
    return {
      name: str(b.name, 200), company: str(b.company, 200), title: str(b.title, 200),
      email: str(b.email, 200), phone: str(b.phone, 60), notes: str(b.notes, 4000),
      temperature, source: ['qr', 'ocr', 'manual'].includes(b.source) ? b.source : 'manual',
      raw_text: str(b.raw_text, 4000),
    };
  }

  app.get('/api/leads', auth, wrap(async (req, res) => {
    const where = []; const p = [];
    if (req.query.topic) { where.push('l.topic_id=?'); p.push(String(req.query.topic)); }
    if (req.query.temperature && TEMPS.includes(req.query.temperature)) { where.push('l.temperature=?'); p.push(req.query.temperature); }
    if (req.query.mine === '1') { where.push('l.user_id=?'); p.push(req.user.id); }
    if (req.query.q) {
      const q = '%' + String(req.query.q).toLowerCase().slice(0, 100) + '%';
      where.push('(LOWER(l.name) LIKE ? OR LOWER(l.company) LIKE ? OR LOWER(l.email) LIKE ? OR LOWER(l.notes) LIKE ?)');
      p.push(q, q, q, q);
    }
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    res.json(await db.query(`${LEAD_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.created_at DESC LIMIT ${limit}`, p));
  }));

  app.post('/api/leads', auth, wrap(async (req, res) => {
    const f = leadFields(req.body);
    const topicId = String(req.body.topic_id || '');
    const clientId = str(req.body.client_id, 80) || null;
    if (!f.temperature) return res.status(400).json({ error: 'Select Hot, Warm or Cold' });
    if (!f.name && !f.email && !f.company && !f.phone) return res.status(400).json({ error: 'Enter at least a name, company, email or phone' });
    const [topic] = await db.query('SELECT id FROM topics WHERE id=? AND active=1', [topicId]);
    if (!topic) return res.status(400).json({ error: 'Select a valid demo topic' });
    if (clientId) { // idempotent retries (offline queue)
      const [dup] = await db.query(`${LEAD_SELECT} WHERE l.client_id=?`, [clientId]);
      if (dup) return res.json(dup);
    }
    const id = uid(), ts = now();
    await db.query(
      'INSERT INTO leads (id,client_id,topic_id,user_id,name,company,title,email,phone,temperature,notes,source,raw_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, clientId, topicId, req.user.id, f.name, f.company, f.title, f.email, f.phone, f.temperature, f.notes, f.source, f.raw_text, ts, ts]);
    const [lead] = await db.query(`${LEAD_SELECT} WHERE l.id=?`, [id]);
    broadcast('lead', { action: 'created', lead });
    res.status(201).json(lead);
  }));

  app.put('/api/leads/:id', auth, wrap(async (req, res) => {
    const [cur] = await db.query('SELECT * FROM leads WHERE id=?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (cur.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not your lead' });
    const f = leadFields({ ...cur, ...req.body });
    if (!f.temperature) return res.status(400).json({ error: 'Select Hot, Warm or Cold' });
    let topicId = cur.topic_id;
    if (req.body.topic_id && req.body.topic_id !== cur.topic_id) {
      const [t] = await db.query('SELECT id FROM topics WHERE id=?', [String(req.body.topic_id)]);
      if (!t) return res.status(400).json({ error: 'Invalid topic' });
      topicId = t.id;
    }
    await db.query('UPDATE leads SET topic_id=?,name=?,company=?,title=?,email=?,phone=?,temperature=?,notes=?,updated_at=? WHERE id=?',
      [topicId, f.name, f.company, f.title, f.email, f.phone, f.temperature, f.notes, now(), cur.id]);
    const [lead] = await db.query(`${LEAD_SELECT} WHERE l.id=?`, [cur.id]);
    broadcast('lead', { action: 'updated', lead });
    res.json(lead);
  }));

  app.delete('/api/leads/:id', auth, wrap(async (req, res) => {
    const [cur] = await db.query('SELECT * FROM leads WHERE id=?', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (cur.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not your lead' });
    await db.query('DELETE FROM leads WHERE id=?', [cur.id]);
    broadcast('lead', { action: 'deleted', id: cur.id });
    res.json({ ok: true });
  }));

  // ---------- admin ----------
  const admin = [auth, adminOnly];

  app.get('/api/admin/users', ...admin, wrap(async (req, res) => {
    res.json(await db.query(`SELECT u.id,u.username,u.name,u.role,u.active,u.created_at,
      (SELECT COUNT(*) FROM leads l WHERE l.user_id=u.id) AS lead_count FROM users u ORDER BY u.created_at`));
  }));
  app.post('/api/admin/users', ...admin, wrap(async (req, res) => {
    const username = str(req.body.username, 80).toLowerCase();
    const name = str(req.body.name, 120) || username;
    const password = String(req.body.password || '');
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    if (!/^[a-z0-9._@-]{3,80}$/.test(username)) return res.status(400).json({ error: 'Username: 3-80 chars (a-z, 0-9, . _ @ -)' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const [ex] = await db.query('SELECT id FROM users WHERE username=?', [username]);
    if (ex) return res.status(409).json({ error: 'Username already exists' });
    await db.query('INSERT INTO users (id,username,name,password_hash,role,active,created_at) VALUES (?,?,?,?,?,?,?)',
      [uid(), username, name, hashPassword(password), role, 1, now()]);
    res.status(201).json({ ok: true });
  }));
  app.put('/api/admin/users/:id', ...admin, wrap(async (req, res) => {
    const [u] = await db.query('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const name = req.body.name !== undefined ? str(req.body.name, 120) : u.name;
    const role = req.body.role ? (req.body.role === 'admin' ? 'admin' : 'user') : u.role;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : Number(u.active);
    if (u.id === req.user.id && (!active || role !== 'admin')) return res.status(400).json({ error: "You can't disable or demote yourself" });
    if (req.body.password && String(req.body.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    await db.query('UPDATE users SET name=?,role=?,active=? WHERE id=?', [name, role, active, u.id]);
    if (req.body.password) await db.query('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(String(req.body.password)), u.id]);
    if (!active || req.body.password) await db.query('DELETE FROM sessions WHERE user_id=?', [u.id]);
    res.json({ ok: true });
  }));

  app.post('/api/admin/topics', ...admin, wrap(async (req, res) => {
    const name = str(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Name required' });
    const [ex] = await db.query('SELECT id FROM topics WHERE LOWER(name)=?', [name.toLowerCase()]);
    if (ex) return res.status(409).json({ error: 'Topic already exists' });
    await db.query('INSERT INTO topics (id,name,active,created_at) VALUES (?,?,?,?)', [uid(), name, 1, now()]);
    broadcast('topics', {});
    res.status(201).json({ ok: true });
  }));
  app.put('/api/admin/topics/:id', ...admin, wrap(async (req, res) => {
    const [t] = await db.query('SELECT * FROM topics WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const name = req.body.name !== undefined ? str(req.body.name, 120) : t.name;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : Number(t.active);
    if (!name) return res.status(400).json({ error: 'Name required' });
    await db.query('UPDATE topics SET name=?,active=? WHERE id=?', [name, active, t.id]);
    broadcast('topics', {});
    res.json({ ok: true });
  }));

  app.get('/api/admin/stats', ...admin, wrap(async (req, res) => {
    const byTemp = await db.query('SELECT temperature AS k, COUNT(*) AS n FROM leads GROUP BY temperature');
    const byTopic = await db.query(`SELECT t.name AS k, COUNT(l.id) AS n,
      SUM(CASE WHEN l.temperature='Hot' THEN 1 ELSE 0 END) AS hot FROM topics t LEFT JOIN leads l ON l.topic_id=t.id GROUP BY t.id,t.name ORDER BY n DESC`);
    const byUser = await db.query(`SELECT u.name AS k, COUNT(l.id) AS n FROM users u LEFT JOIN leads l ON l.user_id=u.id GROUP BY u.id,u.name ORDER BY n DESC`);
    const [{ n: total }] = await db.query('SELECT COUNT(*) AS n FROM leads');
    const num = (r) => r.map((x) => ({ ...x, n: Number(x.n), ...(x.hot !== undefined ? { hot: Number(x.hot || 0) } : {}) }));
    res.json({ total: Number(total), byTemp: num(byTemp), byTopic: num(byTopic), byUser: num(byUser) });
  }));

  app.get('/api/admin/export.xlsx', ...admin, wrap(async (req, res) => {
    const leads = await db.query(`${LEAD_SELECT} ORDER BY l.created_at DESC`);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Lead Capture';
    const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Captured At (UTC)', key: 'created_at', width: 22 }, { header: 'Demo Topic', key: 'topic', width: 24 },
      { header: 'Temperature', key: 'temperature', width: 13 }, { header: 'Name', key: 'name', width: 24 },
      { header: 'Company', key: 'company', width: 26 }, { header: 'Title', key: 'title', width: 24 },
      { header: 'Email', key: 'email', width: 30 }, { header: 'Phone', key: 'phone', width: 18 },
      { header: 'Notes', key: 'notes', width: 50 }, { header: 'Captured By', key: 'captured_by', width: 20 },
      { header: 'Source', key: 'source', width: 10 },
    ];
    const fill = { Hot: 'FFF8B4B4', Warm: 'FFFFE0A3', Cold: 'FFBBD7F5' };
    // guard against spreadsheet formula injection
    const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);
    for (const l of leads) {
      const row = ws.addRow(Object.fromEntries(Object.entries(l).map(([k, v]) => [k, safe(v)])));
      row.getCell('temperature').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill[l.temperature] } };
      row.getCell('notes').alignment = { wrapText: true, vertical: 'top' };
    }
    const hd = ws.getRow(1);
    hd.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hd.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
    ws.autoFilter = { from: 'A1', to: 'K1' };

    const sum = wb.addWorksheet('Summary');
    sum.addRow(['Demo Topic', 'Total', 'Hot', 'Warm', 'Cold']).font = { bold: true };
    const topics = await db.query('SELECT name FROM topics ORDER BY name');
    for (const t of topics) {
      const ls = leads.filter((l) => l.topic === t.name);
      sum.addRow([t.name, ls.length, ...TEMPS.map((x) => ls.filter((l) => l.temperature === x).length)]);
    }
    sum.addRow(['All topics', leads.length, ...TEMPS.map((x) => leads.filter((l) => l.temperature === x).length)]).font = { bold: true };
    sum.columns.forEach((c, i) => (c.width = i ? 10 : 28));

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      'Cache-Control': 'no-store',
    });
    await wb.xlsx.write(res);
    res.end();
  }));

  // ---------- static ----------
  app.get('/healthz', (req, res) => res.json({ ok: true, db: db.kind }));
  const nm = (p) => path.join(__dirname, 'node_modules', p);
  app.use('/vendor/tesseract', express.static(nm('tesseract.js/dist'), { maxAge: '7d' }));
  app.use('/vendor/tesseract-core', express.static(nm('tesseract.js-core'), { maxAge: '7d' }));
  app.use('/vendor/tesseract-lang', express.static(nm('@tesseract.js-data/eng/4.0.0_best_int'), { maxAge: '7d' }));
  app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (r, p) => { if (p.endsWith('sw.js')) r.set('Cache-Control', 'no-cache'); } }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: 'Server error' });
  });

  app.listen(PORT, () => console.log(`Lead Capture running on port ${PORT} (db: ${db.kind})`));
}

main().catch((e) => { console.error(e); process.exit(1); });
