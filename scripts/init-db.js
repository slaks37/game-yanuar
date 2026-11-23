require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  try {
    console.log('Connecting to Neon PostgreSQL...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(32) NOT NULL,
        username VARCHAR(32) UNIQUE,
        password_hash VARCHAR(128),
        avatar VARCHAR(16) DEFAULT '🦊',
        frame VARCHAR(32) DEFAULT 'border-amber-400',
        skin VARCHAR(32) DEFAULT 'skin-royal',
        table_skin VARCHAR(32) DEFAULT 'table-emerald',
        coins INT DEFAULT 2500,
        highscore INT DEFAULT 2500,
        wins INT DEFAULT 0,
        matches INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_active_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE players ADD COLUMN IF NOT EXISTS username VARCHAR(32) UNIQUE;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS password_hash VARCHAR(128);
      ALTER TABLE players ADD COLUMN IF NOT EXISTS highscore INT DEFAULT 2500;

      CREATE TABLE IF NOT EXISTS rooms (
        id VARCHAR(64) PRIMARY KEY,
        code VARCHAR(16) UNIQUE NOT NULL,
        name VARCHAR(64) NOT NULL,
        host_id VARCHAR(64) NOT NULL,
        mode VARCHAR(32) NOT NULL,
        max_players INT NOT NULL DEFAULT 4,
        password VARCHAR(64) DEFAULT '',
        is_private BOOLEAN DEFAULT FALSE,
        status VARCHAR(24) DEFAULT 'waiting',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);
      CREATE INDEX IF NOT EXISTS idx_rooms_code ON rooms(code);

      CREATE TABLE IF NOT EXISTS room_players (
        room_id VARCHAR(64) REFERENCES rooms(id) ON DELETE CASCADE,
        player_id VARCHAR(64) NOT NULL,
        seat INT NOT NULL,
        is_ready BOOLEAN DEFAULT FALSE,
        is_host BOOLEAN DEFAULT FALSE,
        is_bot BOOLEAN DEFAULT FALSE,
        bot_profile JSONB DEFAULT NULL,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (room_id, seat)
      );

      CREATE INDEX IF NOT EXISTS idx_rp_player ON room_players(player_id);

      CREATE TABLE IF NOT EXISTS game_states (
        room_id VARCHAR(64) PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
        version INT NOT NULL DEFAULT 1,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS room_events (
        id BIGSERIAL PRIMARY KEY,
        room_id VARCHAR(64) NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_room_events ON room_events(room_id, id);
    `);

    console.log('Database schema created successfully on Neon!');
  } catch (err) {
    console.error('Error creating database schema:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

initDB();
