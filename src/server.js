const express = require('express');
const path = require('path');
const {Client} = require('pg');
const {nanoid} = require('nanoid');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
const db = new Client({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}});

// Garantiza que todo plan tenga estructura completa antes de guardarse,
// para que el frontend nunca reciba campos undefined.
function normalizePlan(input) {
  let data = input;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch(e) { data = {}; } }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};

  data.patient = (data.patient && typeof data.patient === 'object') ? data.patient : {};
  ['name','age','weight','height','dx'].forEach(function(k){ if (data.patient[k] == null) data.patient[k] = ''; });

  data.meds = Array.isArray(data.meds)
    ? data.meds.filter(function(m){ return m && typeof m === 'object'; })
    : [];

  data.indications = typeof data.indications === 'string' ? data.indications : '';

  var n = (data.nutrition && typeof data.nutrition === 'object') ? data.nutrition : {};
  ['kcal','protein','carbs','fat','fiber','sodium','liquids','goals'].forEach(function(k){ if (n[k] == null) n[k] = ''; });
  var meals = (n.meals && typeof n.meals === 'object') ? n.meals : {};
  ['desayuno','colacion_m','comida','colacion_v','cena'].forEach(function(k){ if (!Array.isArray(meals[k])) meals[k] = []; });
  n.meals = meals;
  data.nutrition = n;

  var ex = (data.exercise && typeof data.exercise === 'object') ? data.exercise : {};
  ex.days = Array.isArray(ex.days)
    ? ex.days.filter(function(d){ return d && typeof d === 'object'; }).map(function(d){
        return {
          title: d.title || '',
          type: d.type || 'cardio',
          exercises: Array.isArray(d.exercises) ? d.exercises : []
        };
      })
    : [];
  if (ex.weeks == null) ex.weeks = '';
  data.exercise = ex;

  return data;
}

async function initDB() {
  await db.connect();
  await db.query(`CREATE TABLE IF NOT EXISTS patients (
    id VARCHAR(20) PRIMARY KEY, data JSONB NOT NULL, free BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
  )`);
  // Add free column if it doesn't exist (for existing databases)
  await db.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS free BOOLEAN DEFAULT FALSE`);
  await db.query(`CREATE TABLE IF NOT EXISTS patient_tokens (
    id SERIAL PRIMARY KEY,
    patient_id VARCHAR(20) REFERENCES patients(id) ON DELETE CASCADE,
    token VARCHAR(64) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS access_codes (
    id SERIAL PRIMARY KEY, patient_id VARCHAR(20) NOT NULL,
    email VARCHAR(255) NOT NULL, code VARCHAR(6) NOT NULL,
    used BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS reminders (
    id SERIAL PRIMARY KEY, patient_id VARCHAR(20) NOT NULL,
    reminder JSONB NOT NULL, created_at TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS patient_versions (
    id SERIAL PRIMARY KEY,
    patient_id VARCHAR(20) NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  console.log('DB ready');
}

app.use(express.json({limit: '5mb'}));
app.use((req, res, next) => {
  if (req.path === '/editor.html') return res.redirect('/editor');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

function getAdminKey() {
  return String(process.env.ADMIN_KEY || process.env.ADMIN_PASSWORD || '').trim();
}

function bearerToken(req) {
  const auth = req.get('Authorization') || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

function isAdmin(req) {
  const key = getAdminKey();
  if (!key) return false;
  return req.get('X-Admin-Key') === key || req.query.admin_key === key || bearerToken(req) === key;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({error: 'No autorizado'});
  next();
}

function cookieValue(req, name) {
  const raw = req.get('Cookie') || '';
  const found = raw.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}

function adminSessionToken() {
  const key = getAdminKey();
  return key ? crypto.createHash('sha256').update('planmedico2:' + key).digest('hex') : '';
}

function hasAdminSession(req) {
  const token = adminSessionToken();
  return !!token && cookieValue(req, 'pm_admin') === token;
}

function patientTokenFromReq(req) {
  return String(req.get('X-Patient-Token') || req.query.token || bearerToken(req) || '').trim();
}

async function hasPatientAccess(patientId, token) {
  if (!token) return false;
  const r = await db.query('SELECT 1 FROM patient_tokens WHERE patient_id = $1 AND token = $2 LIMIT 1', [patientId, token]);
  return r.rows.length > 0;
}

// Nombre/dx tolerante a esquema inglés (patient) o español (paciente).
function planName(d) {
  if (!d) return 'Sin nombre';
  if (d.patient && d.patient.name) return d.patient.name;
  if (d.paciente && d.paciente.nombre) return d.paciente.nombre;
  return 'Sin nombre';
}
function planDx(d) {
  if (!d) return '';
  if (d.patient && d.patient.dx) return d.patient.dx;
  if (d.paciente && d.paciente.diagnosticos && d.paciente.diagnosticos.length) return d.paciente.diagnosticos.join(' · ');
  return '';
}

app.post('/api/patients', requireAdmin, async (req, res) => {
  try {
    if (!req.body || !req.body.data) return res.status(400).json({error: 'No data'});
    const {free} = req.body;
    const data = normalizePlan(req.body.data);
    const id = nanoid(8);
    await db.query('INSERT INTO patients (id, data, free) VALUES ($1, $2, $3)', [id, data, free || false]);
    await db.query('INSERT INTO patient_versions (patient_id, data) VALUES ($1, $2)', [id, data]);
    res.json({id, url: '/p/' + id, free: free || false});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/patients/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({error: 'No encontrado'});
    const row = r.rows[0];
    const free = row.free || false;
    const allowed = free || isAdmin(req) || await hasPatientAccess(req.params.id, patientTokenFromReq(req));
    if (!allowed) {
      return res.json({id: row.id, free: false, requiresCode: true});
    }
    const rem = await db.query('SELECT reminder FROM reminders WHERE patient_id = $1 ORDER BY created_at ASC', [req.params.id]);
    const vers = await db.query('SELECT id, data, created_at FROM patient_versions WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 10', [req.params.id]);
    res.json({id: row.id, data: row.data, free, reminders: rem.rows.map(r => r.reminder), planStart: row.created_at, versions: vers.rows});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/patients', requireAdmin, async (req, res) => {
  try {
    const r = await db.query('SELECT id, data, free, created_at FROM patients ORDER BY created_at DESC');
    res.json(r.rows.map(row => ({
      id: row.id,
      name: planName(row.data),
      dx: planDx(row.data),
      free: row.free || false,
      createdAt: row.created_at
    })));
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/patients/:id', requireAdmin, async (req, res) => {
  try {
    const {free} = req.body;
    const data = normalizePlan(req.body && req.body.data);
    // Save current version before updating
    const cur = await db.query('SELECT data FROM patients WHERE id = $1', [req.params.id]);
    if (cur.rows.length) {
      await db.query('INSERT INTO patient_versions (patient_id, data) VALUES ($1, $2)', [req.params.id, cur.rows[0].data]);
    }
    await db.query('UPDATE patients SET data = $1, free = $2 WHERE id = $3', [data, free || false, req.params.id]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/patients/:id/versions', requireAdmin, async (req, res) => {
  try {
    const r = await db.query('SELECT id, data, created_at FROM patient_versions WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 10', [req.params.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.patch('/api/patients/:id/free', requireAdmin, async (req, res) => {
  try {
    const {free} = req.body;
    await db.query('UPDATE patients SET free = $1 WHERE id = $2', [free, req.params.id]);
    res.json({ok: true, free});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.patch('/api/patients/:id/ecg', requireAdmin, async (req, res) => {
  try {
    const {ecg_link} = req.body;
    // Save ECG link into the latest version's data
    const r = await db.query('SELECT data FROM patients WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({error: 'No encontrado'});
    const data = normalizePlan(r.rows[0].data);
    data.ecg_link = ecg_link;
    await db.query('UPDATE patients SET data = $1 WHERE id = $2', [data, req.params.id]);
    // Also update latest version
    await db.query('UPDATE patient_versions SET data = $1 WHERE id = (SELECT id FROM patient_versions WHERE patient_id = $2 ORDER BY created_at DESC LIMIT 1)', [data, req.params.id]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/patients/:id', requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM patients WHERE id = $1', [req.params.id]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/reminders/:id', requireAdmin, async (req, res) => {
  try {
    await db.query('INSERT INTO reminders (patient_id, reminder) VALUES ($1, $2)', [req.params.id, req.body]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/send-code', async (req, res) => {
  try {
    const {patientId, email} = req.body;
    if (!patientId || !email) return res.status(400).json({error: 'Faltan datos'});
    const p = await db.query('SELECT id FROM patients WHERE id = $1', [patientId]);
    if (!p.rows.length) return res.status(404).json({error: 'Plan no encontrado'});
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await db.query('INSERT INTO access_codes (patient_id, email, code) VALUES ($1, $2, $3)', [patientId, email.toLowerCase(), code]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/codes', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(`SELECT ac.code, ac.email, ac.patient_id, ac.created_at, p.data
      FROM access_codes ac JOIN patients p ON p.id = ac.patient_id
      WHERE ac.used = FALSE ORDER BY ac.created_at DESC LIMIT 20`);
    res.json(r.rows.map(row => ({
      code: row.code, email: row.email, patientId: row.patient_id,
      name: planName(row.data),
      createdAt: row.created_at
    })));
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/verify-code', async (req, res) => {
  try {
    const {patientId, email, code} = req.body;
    const r = await db.query(
      'SELECT * FROM access_codes WHERE patient_id = $1 AND code = $2 AND used = FALSE ORDER BY created_at DESC LIMIT 1',
      [patientId, code]
    );
    if (!r.rows.length) return res.status(401).json({error: 'Codigo incorrecto'});
    await db.query('UPDATE access_codes SET used = TRUE WHERE id = $1', [r.rows[0].id]);
    const {nanoid} = await import('nanoid');
    const token = nanoid(48);
    await db.query('INSERT INTO patient_tokens (patient_id, token) VALUES ($1, $2)', [patientId, token]);
    res.json({ok: true, token});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/verify-token', async (req, res) => {
  try {
    const {patientId, token} = req.body;
    if (!token) return res.status(401).json({error: 'Sin token'});
    const r = await db.query('SELECT * FROM patient_tokens WHERE patient_id = $1 AND token = $2', [patientId, token]);
    if (!r.rows.length) return res.status(401).json({error: 'Token invalido'});
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/p/:id', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'patient.html')); });
app.get('/editor', (req, res) => {
  if (!getAdminKey()) {
    return res.status(503).send('<!doctype html><meta charset="utf-8"><title>Editor</title><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:32px;color:#1A2D5A"><h2>Editor no configurado</h2><p>Configura ADMIN_KEY en Railway para habilitar el panel médico.</p></body>');
  }
  if (isAdmin(req)) {
    res.setHeader('Set-Cookie', 'pm_admin=' + encodeURIComponent(adminSessionToken()) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400');
    return res.sendFile(path.join(__dirname, '..', 'public', 'editor.html'));
  }
  if (hasAdminSession(req)) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'editor.html'));
  }
  res.status(401).send('<!doctype html><meta charset="utf-8"><title>Editor</title><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#F5F5F5;color:#1A2D5A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><form method="GET" action="/editor" style="background:white;border-left:4px solid #8B0000;border-radius:14px;padding:24px;box-shadow:0 6px 24px rgba(26,45,90,.12);width:min(360px,92vw)"><h2 style="margin:0 0 8px;color:#8B0000">Panel médico</h2><p style="font-size:13px;color:#666;line-height:1.5">Ingresa la clave administrativa para abrir el editor.</p><input name="admin_key" type="password" autocomplete="current-password" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:10px;margin:14px 0;font-size:15px"><button style="width:100%;padding:12px;border:0;border-radius:10px;background:#8B0000;color:white;font-weight:700">Entrar</button></form></body>');
});
app.get('/sarita', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'sarita-medicamentos.html')); });

initDB().then(() => { app.listen(PORT, () => console.log('Server running on port ' + PORT)); })
  .catch(e => { console.error('DB error:', e.message); process.exit(1); });
