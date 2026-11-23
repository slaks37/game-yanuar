const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.DEBUG_DB) {
    console.log('Executed query', { text: text.slice(0, 60), duration, rows: res.rowCount });
  }
  return res;
}

module.exports = {
  pool,
  query,
};
