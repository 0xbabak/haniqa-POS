/**
 * Seed script — run once with: node seed-variants.js
 * Populates haniqa.db with sample products that have separate
 * wholesale (S/L) and single (36-50) channel inventory.
 */

const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');

const DB_PATH = path.join(__dirname, 'haniqa.db');

const PRODUCTS = [
  {
    name: 'Fluid Satin Blouse', ref: 'HNQ-TOP-001', category: 'tops',
    price: 195, wholesale_price: 125, trend: '+18%', status: 'hot', season: 'SS 2026',
    description: 'Lightweight satin with a relaxed silhouette.',
    wholesale: { BLACK: { S: 14, L: 10 }, WHITE: { S: 8, L: 6 }, BEIGE: { S: 9, L: 7 } },
    single:    { BLACK: { 36:2, 38:5, 40:8, 42:6, 44:4, 46:2, 48:1, 50:0 }, WHITE: { 36:1, 38:3, 40:5, 42:4, 44:3, 46:1, 48:0, 50:0 } },
  },
  {
    name: 'Wide-Leg Linen Pant', ref: 'HNQ-BOT-001', category: 'bottoms',
    price: 210, wholesale_price: 135, trend: '+11%', status: 'hot', season: 'SS 2026',
    description: 'Relaxed linen cut with a wide leg and side pockets.',
    wholesale: { SAND: { S: 12, L: 9 }, OLIVE: { S: 7, L: 5 }, BLACK: { S: 10, L: 8 } },
    single:    { SAND: { 36:1, 38:4, 40:7, 42:6, 44:3, 46:2, 48:1, 50:0 }, BLACK: { 36:1, 38:2, 40:5, 42:4, 44:3, 46:1, 48:0, 50:0 } },
  },
  {
    name: 'Oversized Cotton Blazer', ref: 'HNQ-OUT-001', category: 'outerwear',
    price: 380, wholesale_price: 245, trend: '+22%', status: 'hot', season: 'SS 2026',
    description: 'Structured blazer with a relaxed oversized cut.',
    wholesale: { IVORY: { S: 6, L: 4 }, CHARCOAL: { S: 8, L: 6 }, CAMEL: { S: 5, L: 3 } },
    single:    { IVORY: { 36:0, 38:2, 40:4, 42:3, 44:2, 46:1, 48:0, 50:0 }, CHARCOAL: { 36:1, 38:3, 40:5, 42:4, 44:2, 46:1, 48:0, 50:0 } },
  },
  {
    name: 'Merino Ribbed Turtleneck', ref: 'HNQ-TOP-002', category: 'tops',
    price: 175, wholesale_price: 110, trend: '+5%', status: 'good', season: 'FW 2025',
    description: 'Fine-knit merino in a classic ribbed turtleneck silhouette.',
    wholesale: { BLACK: { S: 20, L: 15 }, GREY: { S: 14, L: 10 }, CREAM: { S: 8, L: 6 } },
    single:    { BLACK: { 36:3, 38:6, 40:9, 42:7, 44:5, 46:3, 48:1, 50:0 }, GREY: { 36:2, 38:4, 40:6, 42:5, 44:3, 46:2, 48:0, 50:0 } },
  },
  {
    name: 'Pleated Midi Skirt', ref: 'HNQ-BOT-002', category: 'bottoms',
    price: 185, wholesale_price: 115, trend: '+8%', status: 'good', season: 'SS 2026',
    description: 'Flowing midi length with subtle knife pleats.',
    wholesale: { BLUSH: { S: 10, L: 7 }, BLACK: { S: 12, L: 9 }, SAGE: { S: 6, L: 4 } },
    single:    { BLUSH: { 36:1, 38:3, 40:5, 42:4, 44:2, 46:1, 48:0, 50:0 }, BLACK: { 36:2, 38:4, 40:6, 42:5, 44:3, 46:1, 48:0, 50:0 } },
  },
  {
    name: 'Trench Coat Classic', ref: 'HNQ-OUT-002', category: 'outerwear',
    price: 650, wholesale_price: 420, trend: '+3%', status: 'good', season: 'FW 2025',
    description: 'Timeless double-breasted trench in gabardine.',
    wholesale: { CAMEL: { S: 4, L: 3 }, BLACK: { S: 5, L: 4 } },
    single:    { CAMEL: { 36:0, 38:1, 40:2, 42:2, 44:1, 46:1, 48:0, 50:0 } },
  },
  {
    name: 'Cropped Tank Essential', ref: 'HNQ-TOP-003', category: 'tops',
    price: 75, wholesale_price: 48, trend: '+28%', status: 'hot', season: 'SS 2026',
    description: 'Everyday cropped tank in soft pima cotton.',
    wholesale: { WHITE: { S: 30, L: 25 }, BLACK: { S: 28, L: 22 }, GREY: { S: 20, L: 16 } },
    single:    { WHITE: { 36:4, 38:8, 40:12, 42:10, 44:7, 46:4, 48:2, 50:1 }, BLACK: { 36:3, 38:7, 40:10, 42:9, 44:6, 46:3, 48:1, 50:0 }, GREY: { 36:2, 38:5, 40:8, 42:6, 44:4, 46:2, 48:1, 50:0 } },
  },
  {
    name: 'Tailored Straight Chino', ref: 'HNQ-BOT-003', category: 'bottoms',
    price: 155, wholesale_price: 98, trend: '-2%', status: 'slow', season: 'FW 2025',
    description: 'Clean-cut straight leg chino in stretch twill.',
    wholesale: { KHAKI: { S: 8, L: 6 }, NAVY: { S: 7, L: 5 }, BLACK: { S: 9, L: 7 } },
    single:    { KHAKI: { 36:1, 38:3, 40:5, 42:4, 44:3, 46:1, 48:0, 50:0 }, NAVY: { 36:0, 38:2, 40:4, 42:3, 44:2, 46:1, 48:0, 50:0 } },
  },
  {
    name: 'Silk Slip Dress', ref: 'HNQ-TOP-004', category: 'tops',
    price: 280, wholesale_price: 180, trend: '+15%', status: 'hot', season: 'SS 2026',
    description: 'Bias-cut silk charmeuse slip dress with adjustable straps.',
    wholesale: { CHAMPAGNE: { S: 8, L: 5 }, BLACK: { S: 10, L: 7 }, DUSTY_ROSE: { S: 6, L: 4 } },
    single:    { CHAMPAGNE: { 36:1, 38:2, 40:4, 42:3, 44:2, 46:1, 48:0, 50:0 }, BLACK: { 36:1, 38:3, 40:5, 42:4, 44:3, 46:1, 48:0, 50:0 } },
  },
  {
    name: 'Canvas Tote Bag', ref: 'HNQ-ACC-001', category: 'accessories',
    price: 85, wholesale_price: 52, trend: '+6%', status: 'good', season: 'SS 2026',
    description: 'Heavy-duty waxed canvas tote with leather handles.',
    wholesale: { NATURAL: { S: 40, L: 0 }, BLACK: { S: 35, L: 0 } },
    single:    { NATURAL: { 36:0, 38:0, 40:0, 42:0, 44:0, 46:0, 48:0, 50:0 } },
  },
];

async function seed() {
  const SQL = await initSqlJs();
  const db  = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  db.run('PRAGMA foreign_keys = ON');

  let inserted = 0;
  let skipped  = 0;

  for (const p of PRODUCTS) {
    const existing = db.exec('SELECT id FROM products WHERE ref = ?', [p.ref]);
    if (existing[0]?.values?.length) { skipped++; continue; }

    db.run(
      `INSERT INTO products (name, ref, category, price, wholesale_price, trend, status, season, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.name, p.ref, p.category, p.price, p.wholesale_price, p.trend, p.status, p.season, p.description]
    );
    const idRes = db.exec('SELECT last_insert_rowid()');
    const id    = idRes[0].values[0][0];

    // Insert wholesale variants (S / L)
    for (const [color, sizes] of Object.entries(p.wholesale || {})) {
      for (const [size, stock] of Object.entries(sizes)) {
        if (stock <= 0) continue;
        db.run(
          'INSERT OR IGNORE INTO product_variants (product_id, color, size, channel, stock) VALUES (?, ?, ?, ?, ?)',
          [id, color, size, 'wholesale', stock]
        );
      }
    }

    // Insert single variants (EU 36-50)
    for (const [color, sizes] of Object.entries(p.single || {})) {
      for (const [size, stock] of Object.entries(sizes)) {
        if (stock <= 0) continue;
        db.run(
          'INSERT OR IGNORE INTO product_variants (product_id, color, size, channel, stock) VALUES (?, ?, ?, ?, ?)',
          [id, color, String(size), 'single', stock]
        );
      }
    }

    inserted++;
    console.log(`  ✓ ${p.ref}  ${p.name}`);
  }

  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  console.log(`\n  Done. Inserted: ${inserted}  Skipped (already exist): ${skipped}`);
}

seed().catch(err => { console.error(err); process.exit(1); });
