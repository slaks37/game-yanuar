const { Pool } = require('pg');
const { attachDatabasePool } = require('@vercel/functions');

const connectionString = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

if (process.env.VERCEL) attachDatabasePool(pool);

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

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client.query.bind(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  transaction,
};
