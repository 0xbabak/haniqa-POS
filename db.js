const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

// On Fly.io DATA_DIR=/data (persistent volume). Locally falls back to project root.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'haniqa.db');

let _db;
let _inTx = false;

// ── FILE PERSISTENCE ──────────────────────────────────────────────────────────
function save() {
  if (_inTx) return;
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
}

// ── QUERY HELPERS ─────────────────────────────────────────────────────────────
const db = {
  get(sql, params = []) {
    const stmt = _db.prepare(sql);
    const bound = params.map(p => p === undefined ? null : p);
    if (bound.length) stmt.bind(bound);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  },

  all(sql, params = []) {
    const stmt = _db.prepare(sql);
    const bound = params.map(p => p === undefined ? null : p);
    if (bound.length) stmt.bind(bound);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },

  run(sql, params = []) {
    _db.run(sql, params.map(p => p === undefined ? null : p));
    save();
    const r = _db.exec('SELECT last_insert_rowid()');
    return { lastInsertRowid: r[0]?.values[0][0] ?? null };
  },

  transaction(fn) {
    return (...args) => {
      _inTx = true;
      _db.run('BEGIN');
      try {
        fn(...args);
        _db.run('COMMIT');
        _inTx = false;
        save();
      } catch (e) {
        _db.run('ROLLBACK');
        _inTx = false;
        throw e;
      }
    };
  },
};

// ── SCHEMA MIGRATION ─────────────────────────────────────────────────────────
function migrateIfNeeded() {
  // Detect old schema: products table still has a `sold` column or
  // product_variants table has no `channel` column → full reset.
  try {
    const cols = _db.exec("PRAGMA table_info(products)");
    if (!cols[0]) return; // no products table yet — nothing to migrate
    const names = cols[0].values.map(r => r[1]);
    const hasOldSold    = names.includes('sold');
    const hasOldStock   = names.includes('stock') && !names.includes('channel');

    let needsReset = false;
    if (hasOldSold) needsReset = true;

    // Also check if product_variants lacks channel column
    const vcols = _db.exec("PRAGMA table_info(product_variants)");
    if (vcols[0]) {
      const vnames = vcols[0].values.map(r => r[1]);
      if (!vnames.includes('channel')) needsReset = true;
    }

    if (needsReset) {
      console.log('⚠  Old schema detected — migrating to new schema (data will be cleared)…');
      _db.run('PRAGMA foreign_keys = OFF');
      _db.exec(`
        DROP TABLE IF EXISTS transaction_items;
        DROP TABLE IF EXISTS transactions;
        DROP TABLE IF EXISTS product_variants;
        DROP TABLE IF EXISTS products;
      `);
      _db.run('PRAGMA foreign_keys = ON');
      console.log('✓  Old tables dropped — fresh schema will be created.');
    }
  } catch (e) {
    // If anything fails during migration check, proceed normally
  }

  // Add location column to transactions if it doesn't exist yet
  try {
    const txCols = _db.exec("PRAGMA table_info(transactions)");
    if (txCols[0]) {
      const txColNames = txCols[0].values.map(r => r[1]);
      if (!txColNames.includes('location')) {
        _db.run("ALTER TABLE transactions ADD COLUMN location TEXT");
        console.log('✓  Added location column to transactions table.');
      }
    }
  } catch (e) {
    // Column may already exist
  }
}

// ── SCHEMA ────────────────────────────────────────────────────────────────────
function createTables() {
  _db.run('PRAGMA foreign_keys = ON');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT DEFAULT 'manager',
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      ref             TEXT UNIQUE NOT NULL,
      category        TEXT NOT NULL,
      price           REAL NOT NULL,
      wholesale_price REAL,
      trend           TEXT DEFAULT '+0%',
      status          TEXT DEFAULT 'good',
      season          TEXT,
      description     TEXT,
      image_url       TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      color      TEXT NOT NULL,
      size       TEXT NOT NULL,
      channel    TEXT NOT NULL CHECK(channel IN ('single', 'wholesale')),
      stock      INTEGER DEFAULT 0,
      UNIQUE(product_id, color, size, channel)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id             TEXT PRIMARY KEY,
      type           TEXT NOT NULL,
      status         TEXT DEFAULT 'completed',
      total          REAL NOT NULL,
      payment_method TEXT,
      description    TEXT,
      created_by     TEXT,
      location       TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transaction_items (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
      product_id     INTEGER REFERENCES products(id),
      color          TEXT,
      size           TEXT,
      channel        TEXT,
      quantity       INTEGER NOT NULL,
      unit_price     REAL NOT NULL
    );
  `);
}

// ── SEED ──────────────────────────────────────────────────────────────────────
async function seedData() {
  const userCount = db.get('SELECT COUNT(*) as c FROM users');
  if (userCount.c === 0) {
    const adminUser = process.env.ADMIN_USERNAME;
    const adminPass = process.env.ADMIN_PASSWORD;
    if (adminUser && adminPass) {
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync(adminPass, 10);
      db.run(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
        [adminUser, hash, 'admin']
      );
      console.log(`✓ Admin user "${adminUser}" created from environment variables.`);
    } else {
      console.log('⚠  No users found. Set ADMIN_USERNAME and ADMIN_PASSWORD env vars to auto-create admin.');
    }
  }
  console.log('ℹ  Run `node seed-variants.js` to populate sample products.');
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
  }

  migrateIfNeeded();
  createTables();
  // Migrate: add status column to transactions if missing
  try { _db.run("ALTER TABLE transactions ADD COLUMN status TEXT DEFAULT 'completed'"); } catch (_) {}
  save(); // flush new schema to disk immediately
  await seedData();
  console.log('✓ Database ready');
}

module.exports = { db, init };
