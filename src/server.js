const express = require('express');
const path = require('path');
const {Client} = require('pg');
const {nanoid} = require('nanoid');

const app = express();
const PORT = process.env.PORT || 8080;
const db = new Client({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}});

async function initDB() {
  await db.connect();
  await db.query(`CREATE TABLE IF NOT EXISTS patients (
    id VARCHAR(20) PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMP DEFAULT NOW()
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
  console.log('DB ready');
}

app.use(express.json({limit: '5mb'}));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/patients', async (req, res) => {
  try {
    const {data} = req.body;
    if (!data) return res.status(400).json({error: 'No data'});
    const id = nanoid(8);
    await db.query('INSERT INTO patients (id, data) VALUES ($1, $2)', [id, data]);
    res.json({id, url: '/p/' + id});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/patients/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({error: 'No encontrado'});
    const rem = await db.query('SELECT reminder FROM reminders WHERE patient_id = $1 ORDER BY created_at ASC', [req.params.id]);
    res.json({id: r.rows[0].id, data: r.rows[0].data, reminders: rem.rows.map(r => r.reminder), planStart: r.rows[0].created_at});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/patients', async (req, res) => {
  try {
    const r = await db.query('SELECT id, data, created_at FROM patients ORDER BY created_at DESC');
    res.json(r.rows.map(row => ({
      id: row.id,
      name: row.data && row.data.patient ? row.data.patient.name : 'Sin nombre',
      dx: row.data && row.data.patient ? row.data.patient.dx : '',
      createdAt: row.created_at
    })));
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
      name: row.data && row.data.patient ? row.data.patient.name : 'Sin nombre',
      createdAt: row.created_at
    })));
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/verify-code', async (req, res) => {
  try {
    const {patientId, email, code} = req.body;
    const r = await db.query(
      'SELECT * FROM access_codes WHERE patient_id = $1 AND email = $2 AND code = $3 AND used = FALSE ORDER BY created_at DESC LIMIT 1',
      [patientId, email.toLowerCase(), code]
    );
    if (!r.rows.length) return res.status(401).json({error: 'Codigo incorrecto'});
    await db.query('UPDATE access_codes SET used = TRUE WHERE id = $1', [r.rows[0].id]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/p/:id', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'patient.html')); });
app.get('/editor', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'editor.html')); });

initDB().then(() => { app.listen(PORT, () => console.log('Server running on port ' + PORT)); })
  .catch(e => { console.error('DB error:', e.message); process.exit(1); });
