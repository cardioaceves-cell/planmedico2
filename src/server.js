const express = require('express');
const path = require('path');
const { Client } = require('pg');
const { nanoid } = require('nanoid');

const app = express();
const PORT = process.env.PORT || 8080;

// PostgreSQL client
const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await db.connect();
  await db.query(`
    CREATE TABLE IF NOT EXISTS patients (
      id VARCHAR(20) PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('DB ready');
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Save patient
app.post('/api/patients', async (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'No data' });
    const id = nanoid(8);
    await db.query('INSERT INTO patients (id, data) VALUES ($1, $2)', [id, data]);
    res.json({ id, url: '/p/' + id });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Get patient
app.get('/api/patients/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json({ id: result.rows[0].id, data: result.rows[0].data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// List patients
app.get('/api/patients', async (req, res) => {
  try {
    const result = await db.query('SELECT id, data, created_at FROM patients ORDER BY created_at DESC');
    const patients = result.rows.map(r => ({
      id: r.id,
      name: r.data && r.data.patient ? r.data.patient.name : 'Sin nombre',
      dx: r.data && r.data.patient ? r.data.patient.dx : '',
      createdAt: r.created_at
    }));
    res.json(patients);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete patient
app.delete('/api/patients/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM patients WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/p/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'patient.html'));
});

app.get('/editor', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'editor.html'));
});

initDB().then(() => {
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}).catch(e => {
  console.error('DB connection failed:', e.message);
  process.exit(1);
});
