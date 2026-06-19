const express = require('express');
const path = require('path');
const {Client} = require('pg');
const {nanoid} = require('nanoid');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 8080;

const db = new Client({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}});

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'cardioaceves@gmail.com',
    pass: process.env.GMAIL_PASS || 'hysmqmcldgcyrkyhh'
  }
});

async function initDB() {
  await db.connect();
  await db.query(`CREATE TABLE IF NOT EXISTS patients (
    id VARCHAR(20) PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS access_codes (
    id SERIAL PRIMARY KEY,
    patient_id VARCHAR(20) NOT NULL,
    email VARCHAR(255) NOT NULL,
    code VARCHAR(6) NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  console.log('DB ready');
}

app.use(express.json({limit: '5mb'}));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Save patient
app.post('/api/patients', async (req, res) => {
  try {
    const {data} = req.body;
    if (!data) return res.status(400).json({error: 'No data'});
    const id = nanoid(8);
    await db.query('INSERT INTO patients (id, data) VALUES ($1, $2)', [id, data]);
    res.json({id, url: '/p/' + id});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// Get patient
app.get('/api/patients/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({error: 'No encontrado'});
    res.json({id: r.rows[0].id, data: r.rows[0].data});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// List patients
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

// Delete patient
app.delete('/api/patients/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM patients WHERE id = $1', [req.params.id]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// Send access code
app.post('/api/send-code', async (req, res) => {
  try {
    const {patientId, email} = req.body;
    if (!patientId || !email) return res.status(400).json({error: 'Faltan datos'});

    // Check patient exists
    const p = await db.query('SELECT id FROM patients WHERE id = $1', [patientId]);
    if (!p.rows.length) return res.status(404).json({error: 'Plan no encontrado'});

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // Save code
    await db.query(
      'INSERT INTO access_codes (patient_id, email, code) VALUES ($1, $2, $3)',
      [patientId, email.toLowerCase(), code]
    );

    // Send email
    await mailer.sendMail({
      from: '"Dr. Moisés Aceves" <cardioaceves@gmail.com>',
      to: email,
      subject: 'Tu código de acceso — Plan Cardioprotector',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:32px">
          <h2 style="color:#1a4f8a">Dr. Moisés Aceves</h2>
          <p style="color:#555">Cardiología clínica y rehabilitación cardiaca</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <p style="font-size:15px;color:#333">Tu código de acceso al Plan Cardioprotector es:</p>
          <div style="background:#EBF4FF;border-radius:12px;padding:24px;text-align:center;margin:20px 0">
            <span style="font-size:40px;font-weight:700;letter-spacing:8px;color:#1a4f8a">${code}</span>
          </div>
          <p style="font-size:13px;color:#888">Ingresa este código en la app para acceder a tu plan médico personalizado.</p>
          <p style="font-size:12px;color:#bbb;margin-top:32px">Dr. Moisés Aceves · cardioaceves@gmail.com · WhatsApp 55 6117 1631 7</p>
        </div>
      `
    });

    res.json({ok: true});
  } catch(e) {
    console.error('Email error:', e.message);
    res.status(500).json({error: e.message});
  }
});

// Verify access code
app.post('/api/verify-code', async (req, res) => {
  try {
    const {patientId, email, code} = req.body;
    const r = await db.query(
      'SELECT * FROM access_codes WHERE patient_id = $1 AND email = $2 AND code = $3 AND used = FALSE ORDER BY created_at DESC LIMIT 1',
      [patientId, email.toLowerCase(), code]
    );
    if (!r.rows.length) return res.status(401).json({error: 'Código incorrecto o expirado'});

    // Mark as used
    await db.query('UPDATE access_codes SET used = TRUE WHERE id = $1', [r.rows[0].id]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/p/:id', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'patient.html')); });
app.get('/editor', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'editor.html')); });

initDB().then(() => {
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}).catch(e => { console.error('DB error:', e.message); process.exit(1); });
