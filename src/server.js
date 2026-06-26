const express = require('express');
const path = require('path');
const {Client} = require('pg');
const {nanoid} = require('nanoid');

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
app.use(express.static(path.join(__dirname, '..', 'public')));

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

app.post('/api/patients', async (req, res) => {
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
    const rem = await db.query('SELECT reminder FROM reminders WHERE patient_id = $1 ORDER BY created_at ASC', [req.params.id]);
    const vers = await db.query('SELECT id, data, created_at FROM patient_versions WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 10', [req.params.id]);
    res.json({id: r.rows[0].id, data: r.rows[0].data, free: r.rows[0].free || false, reminders: rem.rows.map(r => r.reminder), planStart: r.rows[0].created_at, versions: vers.rows});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/patients', async (req, res) => {
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

app.put('/api/patients/:id', async (req, res) => {
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

app.get('/api/patients/:id/versions', async (req, res) => {
  try {
    const r = await db.query('SELECT id, data, created_at FROM patient_versions WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 10', [req.params.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.patch('/api/patients/:id/free', async (req, res) => {
  try {
    const {free} = req.body;
    await db.query('UPDATE patients SET free = $1 WHERE id = $2', [free, req.params.id]);
    res.json({ok: true, free});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.patch('/api/patients/:id/ecg', async (req, res) => {
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

app.delete('/api/patients/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM patients WHERE id = $1', [req.params.id]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/reminders/:id', async (req, res) => {
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
    res.json({ok: true, code});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/codes', async (req, res) => {
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
app.get('/editor', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'editor.html')); });
app.get('/sarita', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'sarita-medicamentos.html')); });

initDB().then(() => { app.listen(PORT, () => console.log('Server running on port ' + PORT)); })
  .catch(e => { console.error('DB error:', e.message); process.exit(1); });
