const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const analytics = require('./analytics');
const dia        = require('./dia');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── DATA DIRECTORY (persistent volume on Fly.io, project root locally) ────────
const DATA_DIR   = process.env.DATA_DIR || __dirname;
const sessionsDir = path.join(DATA_DIR, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

// ── UPLOADS ───────────────────────────────────────────────────────────────────
const uploadsDir = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `product-${Date.now()}${ext}`);
    },
  }),
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  },
});

const { db, init } = require('./db');

const app    = express();
const isProd = process.env.NODE_ENV === 'production';

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
if (isProd) app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(session({
  store:            new FileStore({ path: sessionsDir, ttl: 86400, retries: 0 }),
  secret:           process.env.SESSION_SECRET || 'haniqa-dev-secret',
  resave:           false,
  saveUninitialized: false,
  cookie: {
    secure:   isProd,
    httpOnly: true,
    maxAge:   24 * 60 * 60 * 1000,
  },
}));

app.get('/', (req, res) => res.redirect('/login.html'));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
// Attach computed stock + sold to a list of products
function enrichProducts(prods) {
  const variants = db.all('SELECT * FROM product_variants ORDER BY product_id, channel, color, size');
  const soldRows = db.all(`
    SELECT ti.product_id,
           SUM(ti.quantity)                  AS units,
           SUM(ti.quantity * ti.unit_price)  AS revenue
    FROM transaction_items ti
    JOIN transactions t ON t.id = ti.transaction_id
    WHERE t.type = 'sale'
      AND (t.status = 'completed' OR t.status IS NULL)
    GROUP BY ti.product_id
  `);

  const byProduct  = {};
  variants.forEach(v => { (byProduct[v.product_id] ??= []).push(v); });

  const soldByProd = {};
  soldRows.forEach(s => { soldByProd[s.product_id] = s; });

  return prods.map(p => {
    const pvs            = byProduct[p.id] || [];
    const stockSingle    = pvs.filter(v => v.channel === 'single')   .reduce((s, v) => s + (parseInt(v.stock) || 0), 0);
    const stockWholesale = pvs.filter(v => v.channel === 'wholesale').reduce((s, v) => s + (parseInt(v.stock) || 0), 0);
    const s              = soldByProd[p.id] || {};
    return {
      ...p,
      variants:        pvs,
      stock:           stockSingle + stockWholesale,
      stock_single:    stockSingle,
      stock_wholesale: stockWholesale,
      sold:            parseInt(s.units)    || 0,
      revenue:         parseFloat(s.revenue) || 0,
    };
  });
}

// ── USER MANAGEMENT ───────────────────────────────────────────────────────────

app.post('/admin/create-user', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, hash, role || 'manager']);
    res.json({ ok: true, username, role: role || 'manager' });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/admin/change-password', requireAuth, async (req, res) => {
  const { username, newPassword } = req.body;
  if (!username || !newPassword) return res.status(400).json({ error: 'Username and newPassword required' });
  if (req.session.role !== 'admin' && req.session.username !== username)
    return res.status(403).json({ error: 'Not allowed' });
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    db.run('UPDATE users SET password_hash = ? WHERE username = ?', [hash, username]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── AUTH ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const user = db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.role     = user.role;
    res.json({ username: user.username, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/auth/me', requireAuth, (req, res) =>
  res.json({ username: req.session.username, role: req.session.role }));

// ── PRODUCTS ──────────────────────────────────────────────────────────────────

app.get('/api/products', requireAuth, (req, res) => {
  try {
    res.json(enrichProducts(db.all('SELECT * FROM products ORDER BY id ASC')));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/products', requireAuth, (req, res) => {
  const { name, ref, category, price, wholesale_price, season, description } = req.body;
  if (!name || !ref || !category || !price)
    return res.status(400).json({ error: 'Name, ref, category, and price are required' });
  try {
    db.run(
      `INSERT INTO products (name, ref, category, price, wholesale_price, status, season, description)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`,
      [name, ref, category, price, wholesale_price || null, season || null, description || null]
    );
    const newProduct = db.get('SELECT * FROM products WHERE ref = ?', [ref]);
    res.status(201).json(enrichProducts([newProduct])[0]);
  } catch (err) {
    if (err.message?.includes('UNIQUE'))
      return res.status(409).json({ error: 'A product with this reference code already exists' });
    console.error('POST /api/products error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

app.patch('/api/products/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const { status, trend, name, ref, category, price, wholesale_price, season, description } = req.body;
  try {
    db.run(
      `UPDATE products SET
         status          = COALESCE(?, status),
         trend           = COALESCE(?, trend),
         name            = COALESCE(?, name),
         ref             = COALESCE(?, ref),
         category        = COALESCE(?, category),
         price           = COALESCE(?, price),
         wholesale_price = COALESCE(?, wholesale_price),
         season          = COALESCE(?, season),
         description     = COALESCE(?, description),
         updated_at      = datetime('now')
       WHERE id = ?`,
      [status, trend, name, ref, category, price, wholesale_price, season, description, id]
    );
    const product = db.get('SELECT * FROM products WHERE id = ?', [id]);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(enrichProducts([product])[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/products/:id/variants', requireAuth, (req, res) => {
  const { id } = req.params;
  const { variants } = req.body;
  if (!Array.isArray(variants)) return res.status(400).json({ error: 'variants must be an array' });
  try {
    const doUpdate = db.transaction(() => {
      db.run('DELETE FROM product_variants WHERE product_id = ?', [id]);
      for (const v of variants) {
        if (!v.color || !v.size || !v.channel) continue;
        db.run(
          'INSERT INTO product_variants (product_id, color, size, channel, stock) VALUES (?, ?, ?, ?, ?)',
          [id, v.color, v.size, v.channel, v.stock || 0]
        );
      }
    });
    doUpdate();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/products/:id/image', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const imageUrl = '/uploads/' + req.file.filename;
  const existing = db.get('SELECT image_url FROM products WHERE id = ?', [req.params.id]);
  if (existing?.image_url) {
    const oldPath = path.join(uploadsDir, path.basename(existing.image_url));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  db.run("UPDATE products SET image_url = ?, updated_at = datetime('now') WHERE id = ?", [imageUrl, req.params.id]);
  res.json({ imageUrl });
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  try {
    const product = db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.image_url) {
      const imgPath = path.join(uploadsDir, path.basename(product.image_url));
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
    db.run('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── INVENTORY (read-only — stock is managed by DIA sync) ─────────────────────

// ── TRANSACTIONS ──────────────────────────────────────────────────────────────

app.get('/api/transactions', requireAuth, (req, res) => {
  try {
    const transactions = db.all('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 200');
    const allItems     = db.all('SELECT * FROM transaction_items');
    const byTxn = {};
    allItems.forEach(item => { (byTxn[item.transaction_id] ??= []).push(item); });
    res.json(transactions.map(t => ({ ...t, items: byTxn[t.id] || [] })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/transactions', requireAuth, (req, res) => {
  const { type, total, paymentMethod, description, items, status, location } = req.body;
  if (!type || total === undefined) return res.status(400).json({ error: 'Type and total are required' });

  const txStatus = status === 'reserved' ? 'reserved' : 'completed';
  const txId     = (type === 'sale' ? 'TXN' : 'MAN') + '-' + Date.now();
  const username = req.session.username;

  const doInsert = db.transaction(() => {
    db.run(
      'INSERT INTO transactions (id, type, status, total, payment_method, description, created_by, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [txId, type, txStatus, total, paymentMethod || null, description || null, username, location || null]
    );
    if (type === 'sale' && Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        const channel = item.channel || 'single';
        db.run(
          'INSERT INTO transaction_items (transaction_id, product_id, color, size, channel, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [txId, item.productId, item.color || null, item.size || null, channel, item.quantity, item.unitPrice]
        );
      }
    }
  });

  try {
    doInsert();
    res.status(201).json(db.get('SELECT * FROM transactions WHERE id = ?', [txId]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/transactions/:id', requireAuth, (req, res) => {
  try {
    const txn = db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    const doDelete = db.transaction(() => {
      db.run('DELETE FROM transactions WHERE id = ?', [txn.id]);
    });
    doDelete();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Edit items/price/payment on an already-completed sale (stock restores for removed/reduced items)
app.patch('/api/transactions/:id/edit', requireAuth, (req, res) => {
  const { paymentMethod, items } = req.body;
  try {
    const txn = db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.type !== 'sale' || txn.status === 'reserved')
      return res.status(400).json({ error: 'This endpoint is for completed sales only' });

    const origItems = db.all('SELECT * FROM transaction_items WHERE transaction_id = ?', [txn.id]);

    const doEdit = db.transaction(() => {
      if (Array.isArray(items)) {
        for (const orig of origItems) {
          const updated = items.find(i => i.itemId === orig.id);

          if (!updated) {
            db.run('DELETE FROM transaction_items WHERE id = ?', [orig.id]);
          } else {
            const newQty   = Math.max(1, parseInt(updated.quantity)  || 1);
            const newPrice = Math.max(0, parseFloat(updated.unitPrice) || 0);
            db.run(
              'UPDATE transaction_items SET quantity = ?, unit_price = ? WHERE id = ?',
              [newQty, newPrice, orig.id]
            );
          }
        }
      }

      // Recalculate total from remaining items
      const totalRow = db.get(
        'SELECT COALESCE(SUM(quantity * unit_price), 0) AS t FROM transaction_items WHERE transaction_id = ?',
        [txn.id]
      );
      const newTotal = parseFloat(totalRow.t) || 0;
      db.run(
        'UPDATE transactions SET payment_method = ?, total = ? WHERE id = ?',
        [paymentMethod || txn.payment_method, newTotal, txn.id]
      );
    });

    doEdit();
    res.json(db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/transactions/:id/finalize', requireAuth, (req, res) => {
  const { paymentMethod, items } = req.body;
  // items: [{ itemId, quantity, unitPrice }] — the final edited state from the UI
  try {
    const txn = db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.status !== 'reserved') return res.status(400).json({ error: 'Transaction is not reserved' });

    const origItems = db.all('SELECT * FROM transaction_items WHERE transaction_id = ?', [txn.id]);

    const doFinalize = db.transaction(() => {
      if (Array.isArray(items)) {
        for (const orig of origItems) {
          const updated = items.find(i => i.itemId === orig.id);

          if (!updated) {
            db.run('DELETE FROM transaction_items WHERE id = ?', [orig.id]);
          } else {
            const newQty   = Math.max(1, parseInt(updated.quantity)  || 1);
            const newPrice = Math.max(0, parseFloat(updated.unitPrice) || 0);
            db.run(
              'UPDATE transaction_items SET quantity = ?, unit_price = ? WHERE id = ?',
              [newQty, newPrice, orig.id]
            );
          }
        }
      }

      // Recalculate total from remaining items
      const totalRow = db.get(
        'SELECT COALESCE(SUM(quantity * unit_price), 0) AS t FROM transaction_items WHERE transaction_id = ?',
        [txn.id]
      );
      const newTotal = parseFloat(totalRow.t) || 0;

      db.run(
        "UPDATE transactions SET status = 'completed', payment_method = ?, total = ? WHERE id = ?",
        [paymentMethod || null, newTotal, txn.id]
      );
    });

    doFinalize();
    res.json(db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/transactions/:id', requireAuth, (req, res) => {
  const txn = db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });

  // Completed sales: allow editing description + payment_method only (no inventory impact)
  if (txn.type === 'sale') {
    if (txn.status === 'reserved') return res.status(400).json({ error: 'Use the finalize endpoint for reserved sales' });
    const { description, paymentMethod } = req.body;
    try {
      db.run(`UPDATE transactions SET
        description    = COALESCE(?, description),
        payment_method = COALESCE(?, payment_method)
      WHERE id = ?`, [description ?? null, paymentMethod ?? null, req.params.id]);
      return res.json(db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]));
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  const { description, total, paymentMethod } = req.body;
  try {
    db.run(`UPDATE transactions SET
      description    = COALESCE(?, description),
      total          = COALESCE(?, total),
      payment_method = COALESCE(?, payment_method)
    WHERE id = ?`, [description ?? null, total ?? null, paymentMethod ?? null, req.params.id]);
    res.json(db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DIA SYNC ──────────────────────────────────────────────────────────────────

// Returns raw sample rows straight from DIA (no caching) so we can inspect field names
app.get('/api/dia/debug-sample', requireAuth, async (req, res) => {
  try {
    const stockRaw = await dia.diaCall('scf_stokkart_varyant_listele', {
      params: { miktarhesapla: '1' },
      limit: 3,
    });
    const salesRaw = await dia.diaCall('scf_irsaliye_listele_ayrintili', { limit: 3 });
    const cached   = {
      stock_sample: db.all('SELECT * FROM dia_stock_cache LIMIT 3'),
      sales_sample: db.all('SELECT * FROM dia_sales_cache LIMIT 3'),
    };
    res.json({ stockRaw, salesRaw, cached });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.get('/api/dia/status', requireAuth, (req, res) => {
  try {
    res.json(dia.getStatus(db));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dia/sync', requireAuth, async (req, res) => {
  try {
    const { stockCount, salesCount } = await dia.fullSync(db);
    res.json({ ok: true, stockCount, salesCount });
  } catch (err) {
    console.error('Manual DIA sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Returns DIA stock cache as product objects (for inventory page).
// Each row in dia_stock_cache is one product (from scf_stokkart_listele).
// renk field = category code, beden field = category name (reused columns).
app.get('/api/dia/inventory', requireAuth, (req, res) => {
  try {
    const rows = db.all(`
      SELECT
        st.stokkodu, st.stokadi,
        st.renk AS kategori_kodu, st.beden AS kategori,
        st.miktar, st.synced_at,
        COALESCE(MAX(sl.birimfiyat), 0) AS price
      FROM dia_stock_cache st
      LEFT JOIN dia_sales_cache sl ON sl.stokkodu = st.stokkodu
      GROUP BY st.stokkodu
      ORDER BY st.stokadi
    `);

    const products = rows.map(r => ({
      id:       r.stokkodu,
      ref:      r.stokkodu,
      name:     r.stokadi,
      category: r.kategori || r.kategori_kodu || '',
      price:    parseFloat(r.price) || 0,
      stock:    parseFloat(r.miktar) || 0,
      variants: [{
        color:   '__dia__',
        size:    '',
        stock:   parseFloat(r.miktar) || 0,
        channel: 'wholesale',
      }],
    }));

    res.json({
      products,
      syncedAt: rows[0]?.synced_at || null,
      total:    products.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

app.get('/api/dashboard/stats', requireAuth, (req, res) => {
  const channel = req.query.channel || 'both';
  const source  = req.query.source  || 'pos';

  if (source === 'dia') {
    try {
      const totals = db.get(`
        SELECT
          COALESCE(SUM(miktar * birimfiyat), 0) AS total_revenue,
          COALESCE(SUM(miktar), 0)              AS total_units
        FROM dia_sales_cache
      `);
      const today = db.get(`
        SELECT
          COALESCE(SUM(miktar * birimfiyat), 0) AS today_sales,
          COUNT(DISTINCT belge_no)              AS today_count
        FROM dia_sales_cache
        WHERE date(tarih) = date('now')
      `);
      const counts = db.get(`
        SELECT
          (SELECT COUNT(DISTINCT stokkodu) FROM dia_stock_cache) AS active_skus,
          (SELECT COUNT(*) FROM (
            SELECT stokkodu FROM dia_stock_cache
            GROUP BY stokkodu HAVING SUM(miktar) < 20
          )) AS low_stock_count
      `);
      return res.json({
        todaysSales:      today?.today_sales      ?? 0,
        todaysSalesCount: today?.today_count      ?? 0,
        todaysCashChange: today?.today_sales      ?? 0,
        totalRevenue:     totals?.total_revenue   ?? 0,
        totalUnits:       totals?.total_units     ?? 0,
        activeSKUs:       counts?.active_skus     ?? 0,
        lowStockCount:    counts?.low_stock_count ?? 0,
        source: 'dia',
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
  try {
    const totals = db.get(`
      SELECT
        COALESCE(SUM(ti.quantity * ti.unit_price), 0) AS total_revenue,
        COALESCE(SUM(ti.quantity), 0)                 AS total_units
      FROM transaction_items ti
      JOIN transactions t ON t.id = ti.transaction_id
      WHERE t.type = 'sale' AND (t.status = 'completed' OR t.status IS NULL)
        AND (? = 'both' OR ti.channel = ?)
    `, [channel, channel]);

    const today = db.get(`
      SELECT
        COALESCE(SUM(ti.quantity * ti.unit_price), 0) AS today_sales,
        COUNT(DISTINCT t.id)                          AS today_count
      FROM transaction_items ti
      JOIN transactions t ON t.id = ti.transaction_id
      WHERE t.type = 'sale' AND (t.status = 'completed' OR t.status IS NULL)
        AND date(t.created_at) = date('now')
        AND (? = 'both' OR ti.channel = ?)
    `, [channel, channel]);

    const cashRow = db.get(`
      SELECT COALESCE(SUM(
        CASE WHEN type IN ('sale','in') AND (status='completed' OR status IS NULL) THEN total
             WHEN type = 'out' THEN -total ELSE 0 END
      ), 0) AS cash_change
      FROM transactions WHERE date(created_at) = date('now')
    `);

    const counts = db.get(`
      SELECT
        COUNT(*) AS active_skus,
        COALESCE((
          SELECT COUNT(*) FROM (
            SELECT product_id FROM product_variants
            WHERE (? = 'both' OR channel = ?)
            GROUP BY product_id HAVING SUM(stock) < 20
          )
        ), 0) AS low_stock_count
      FROM products
    `, [channel, channel]);

    res.json({
      todaysSales:      today.today_sales,
      todaysSalesCount: today.today_count,
      todaysCashChange: cashRow.cash_change,
      totalRevenue:     totals.total_revenue,
      totalUnits:       totals.total_units,
      activeSKUs:       counts.active_skus,
      lowStockCount:    counts.low_stock_count,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/dashboard/monthly', requireAuth, (req, res) => {
  const channel = req.query.channel || 'both';
  const source  = req.query.source  || 'pos';
  const from    = req.query.from   || null;
  const to      = req.query.to     || null;

  if (source === 'dia') {
    try {
      const rows = db.all(`
        SELECT
          strftime('%Y-%m', tarih)                                          AS ym,
          strftime('%b', tarih)                                             AS month,
          ROUND(COALESCE(SUM(miktar * birimfiyat), 0) / 1000.0, 1)        AS revenue,
          COALESCE(SUM(miktar), 0)                                          AS units
        FROM dia_sales_cache
        ${from && to ? `WHERE tarih >= '${from}' AND tarih <= '${to}'` : "WHERE tarih >= date('now', '-12 months')"}
        GROUP BY ym ORDER BY ym ASC
      `);
      return res.json({
        months:  rows.map(r => r.month),
        revenue: rows.map(r => r.revenue),
        units:   rows.map(r => r.units),
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  try {
    const params = [channel, channel];
    let dateCond = `t.created_at >= datetime('now', '-12 months')`;
    if (from && to) {
      dateCond = `t.created_at >= ? AND t.created_at < datetime(?, '+1 day')`;
      params.push(from, to);
    } else if (from) {
      dateCond = `t.created_at >= ?`;
      params.push(from);
    } else if (to) {
      dateCond = `t.created_at < datetime(?, '+1 day')`;
      params.push(to);
    }
    const rows = db.all(`
      SELECT
        strftime('%Y-%m', t.created_at)                                   AS ym,
        strftime('%b',    t.created_at)                                   AS month,
        ROUND(COALESCE(SUM(ti.quantity * ti.unit_price), 0) / 1000.0, 1) AS revenue,
        COALESCE(SUM(ti.quantity), 0)                                     AS units
      FROM transactions t
      JOIN transaction_items ti ON ti.transaction_id = t.id
      WHERE t.type = 'sale'
        AND (t.status = 'completed' OR t.status IS NULL)
        AND (? = 'both' OR ti.channel = ?)
        AND ${dateCond}
      GROUP BY ym
      ORDER BY ym ASC
    `, params);
    res.json({
      months:  rows.map(r => r.month),
      revenue: rows.map(r => r.revenue),
      units:   rows.map(r => r.units),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/dashboard/top-sellers', requireAuth, (req, res) => {
  const channel = req.query.channel || 'both';
  const source  = req.query.source  || 'pos';

  if (source === 'dia') {
    try {
      return res.json(db.all(`
        SELECT
          ds.stokkodu                           AS ref,
          COALESCE(p.name, ds.stokadi)          AS name,
          COALESCE(p.category, '')              AS category,
          COALESCE(p.price, MAX(ds.birimfiyat)) AS price,
          COALESCE(p.id, 0)                     AS id,
          SUM(ds.miktar)                        AS sold,
          SUM(ds.miktar * ds.birimfiyat)        AS revenue_total,
          COALESCE(st.total_stock, 0)           AS stock
        FROM dia_sales_cache ds
        LEFT JOIN products p ON p.ref = ds.stokkodu
        LEFT JOIN (
          SELECT stokkodu, SUM(miktar) AS total_stock
          FROM dia_stock_cache GROUP BY stokkodu
        ) st ON st.stokkodu = ds.stokkodu
        WHERE ds.stokkodu != ''
        GROUP BY ds.stokkodu
        ORDER BY sold DESC
        LIMIT 8
      `));
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  try {
    res.json(db.all(`
      SELECT p.*,
        COALESCE(cs.sold,          0) AS sold,
        COALESCE(cs.revenue_total, 0) AS revenue_total,
        COALESCE(ck.stock,         0) AS stock
      FROM products p
      LEFT JOIN (
        SELECT ti.product_id,
               SUM(ti.quantity)                 AS sold,
               SUM(ti.quantity * ti.unit_price) AS revenue_total
        FROM transaction_items ti
        JOIN transactions t ON t.id = ti.transaction_id
        WHERE t.type = 'sale' AND (t.status = 'completed' OR t.status IS NULL)
          AND (? = 'both' OR ti.channel = ?)
        GROUP BY ti.product_id
      ) cs ON cs.product_id = p.id
      LEFT JOIN (
        SELECT product_id, SUM(stock) AS stock
        FROM product_variants
        WHERE (? = 'both' OR channel = ?)
        GROUP BY product_id
      ) ck ON ck.product_id = p.id
      ORDER BY sold DESC
      LIMIT 8
    `, [channel, channel, channel, channel]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── ANALYTICS ─────────────────────────────────────────────────────────────────

app.get('/api/analytics/category-revenue', requireAuth, (req, res) => {
  const source = req.query.source || 'pos';
  try {
    if (source === 'dia') {
      const rows = db.all(`
        SELECT
          COALESCE(p.category, 'Other')                                       AS category,
          ROUND(COALESCE(SUM(ds.miktar * ds.birimfiyat), 0) / 1000.0, 1)     AS revenue
        FROM dia_sales_cache ds
        LEFT JOIN products p ON p.ref = ds.stokkodu
        GROUP BY p.category
        ORDER BY revenue DESC
      `);
      return res.json({
        categories: rows.map(r => r.category.charAt(0).toUpperCase() + r.category.slice(1)),
        values:     rows.map(r => r.revenue),
      });
    }
    const rows = db.all(`
      SELECT p.category,
        ROUND(COALESCE(SUM(ti.quantity * ti.unit_price), 0) / 1000.0, 1) AS revenue
      FROM products p
      LEFT JOIN transaction_items ti ON ti.product_id = p.id
      LEFT JOIN transactions t ON t.id = ti.transaction_id AND t.type = 'sale' AND (t.status = 'completed' OR t.status IS NULL)
      GROUP BY p.category
      ORDER BY revenue DESC
    `);
    res.json({
      categories: rows.map(r => r.category.charAt(0).toUpperCase() + r.category.slice(1)),
      values:     rows.map(r => r.revenue),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/analytics/rankings', requireAuth, (req, res) => {
  const source = req.query.source || 'pos';
  try {
    if (source === 'dia') {
      return res.json(db.all(`
        SELECT
          ds.stokkodu                           AS ref,
          COALESCE(p.name, ds.stokadi)          AS name,
          COALESCE(p.category, '')              AS category,
          COALESCE(p.price, MAX(ds.birimfiyat)) AS price,
          COALESCE(p.id, 0)                     AS id,
          SUM(ds.miktar)                        AS sold,
          COALESCE(st.stock, 0)                 AS stock
        FROM dia_sales_cache ds
        LEFT JOIN products p ON p.ref = ds.stokkodu
        LEFT JOIN (
          SELECT stokkodu, SUM(miktar) AS stock FROM dia_stock_cache GROUP BY stokkodu
        ) st ON st.stokkodu = ds.stokkodu
        WHERE ds.stokkodu != ''
        GROUP BY ds.stokkodu
        ORDER BY sold DESC
      `));
    }
    res.json(db.all(`
      SELECT p.*,
        COALESCE(SUM(ti.quantity), 0) AS sold,
        COALESCE((SELECT SUM(pv.stock) FROM product_variants pv WHERE pv.product_id = p.id), 0) AS stock
      FROM products p
      LEFT JOIN transaction_items ti ON ti.product_id = p.id
      LEFT JOIN transactions t ON t.id = ti.transaction_id AND t.type = 'sale' AND (t.status = 'completed' OR t.status IS NULL)
      GROUP BY p.id
      ORDER BY sold DESC
    `));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Shared helper: fetch weekly history from POS transactions
function getWeeklyHistory(weeks = 16) {
  const days = weeks * 7;
  const rows = db.all(`
    SELECT ti.product_id,
           strftime('%Y-%W', t.created_at) AS wk,
           SUM(ti.quantity)                AS units
    FROM transaction_items ti
    JOIN transactions t ON t.id = ti.transaction_id
    WHERE t.type = 'sale' AND (t.status = 'completed' OR t.status IS NULL)
      AND t.created_at >= datetime('now', '-${days} days')
    GROUP BY ti.product_id, wk
    ORDER BY ti.product_id, wk
  `);
  const history = {};
  rows.forEach(r => { (history[r.product_id] ??= []).push({ wk: r.wk, units: r.units }); });
  return history;
}

// Shared helper: fetch weekly history from DIA wholesale sales cache
function getWeeklyHistoryDIA(weeks = 16) {
  const days = weeks * 7;
  const rows = db.all(`
    SELECT
      stokkodu AS product_id,
      strftime('%Y-%W', tarih) AS wk,
      SUM(miktar)              AS units
    FROM dia_sales_cache
    WHERE tarih >= date('now', '-${days} days') AND stokkodu != ''
    GROUP BY stokkodu, wk
    ORDER BY stokkodu, wk
  `);
  const history = {};
  rows.forEach(r => { (history[r.product_id] ??= []).push({ wk: r.wk, units: parseFloat(r.units) || 0 }); });
  return history;
}

// Shared helper: fetch all products with current stock (POS)
function getProductsWithStock() {
  return db.all(`
    SELECT p.id, p.name, p.category, p.price,
           COALESCE(SUM(pv.stock), 0) AS stock
    FROM products p
    LEFT JOIN product_variants pv ON pv.product_id = p.id
    GROUP BY p.id
  `);
}

// Shared helper: fetch products with stock from DIA cache.
// Builds the product list from dia_sales_cache (guaranteed to have stokkodu
// after the field-name fix) and LEFT JOINs stock from dia_stock_cache.
function getProductsWithStockDIA() {
  return db.all(`
    SELECT
      ds.stokkodu                          AS id,
      ds.stokkodu                          AS ref,
      COALESCE(p.name, MAX(ds.stokadi))    AS name,
      COALESCE(p.category, '')             AS category,
      COALESCE(p.price, MAX(ds.birimfiyat)) AS price,
      COALESCE(st.stock, 0)                AS stock
    FROM dia_sales_cache ds
    LEFT JOIN products p  ON p.ref = ds.stokkodu
    LEFT JOIN (
      SELECT stokkodu, SUM(miktar) AS stock
      FROM dia_stock_cache
      WHERE stokkodu != ''
      GROUP BY stokkodu
    ) st ON st.stokkodu = ds.stokkodu
    WHERE ds.stokkodu != ''
    GROUP BY ds.stokkodu
  `);
}

app.get('/api/analytics/production-forecast', requireAuth, (req, res) => {
  const horizonMap   = { '1w': 1, '2w': 2, '1m': 4, '2m': 8 };
  const horizonWeeks = horizonMap[req.query.horizon] || 2;
  const source       = req.query.source || 'pos';
  const historyWeeks = Math.min(Math.max(parseInt(req.query.historyWeeks) || 4, 2), 52);
  try {
    const products      = source === 'dia' ? getProductsWithStockDIA() : getProductsWithStock();
    const weeklyHistory = source === 'dia' ? getWeeklyHistoryDIA(historyWeeks) : getWeeklyHistory(historyWeeks);
    res.json(analytics.computeProductionForecast(products, weeklyHistory, horizonWeeks));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/analytics/forecast', requireAuth, (req, res) => {
  const source       = req.query.source || 'pos';
  const historyWeeks = Math.min(Math.max(parseInt(req.query.historyWeeks) || 4, 2), 52);
  try {
    const products      = source === 'dia' ? getProductsWithStockDIA() : getProductsWithStock();
    const weeklyHistory = source === 'dia' ? getWeeklyHistoryDIA(historyWeeks) : getWeeklyHistory(historyWeeks);
    res.json(analytics.computeDemandForecast(products, weeklyHistory));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/analytics/color-breakdown', requireAuth, (req, res) => {
  const source = req.query.source || 'pos';
  try {
    if (source === 'dia') {
      const sales = db.all(`
        SELECT stokkodu AS product_id, renk AS color, 'wholesale' AS channel,
               SUM(miktar)              AS sold,
               SUM(miktar * birimfiyat) AS revenue
        FROM dia_sales_cache
        WHERE renk IS NOT NULL AND renk != ''
        GROUP BY stokkodu, renk
      `);
      const stock = db.all(`
        SELECT stokkodu AS product_id, renk AS color, SUM(miktar) AS stock
        FROM dia_stock_cache
        WHERE renk IS NOT NULL AND renk != ''
        GROUP BY stokkodu, renk
      `);
      const sm = {};
      stock.forEach(r => { sm[`${r.product_id}|${r.color}`] = r.stock; });
      return res.json(sales.map(r => ({ ...r, stock: sm[`${r.product_id}|${r.color}`] || 0 })));
    }
    const sales = db.all(`
      SELECT ti.product_id, ti.color, ti.channel,
             SUM(ti.quantity)                 AS sold,
             SUM(ti.quantity * ti.unit_price) AS revenue
      FROM transaction_items ti
      JOIN transactions t ON t.id = ti.transaction_id
      WHERE t.type = 'sale' AND (t.status = 'completed' OR t.status IS NULL)
        AND ti.color IS NOT NULL AND ti.color != ''
      GROUP BY ti.product_id, ti.color, ti.channel
    `);
    const stock = db.all(`
      SELECT product_id, color, channel, SUM(stock) AS stock
      FROM product_variants
      WHERE color IS NOT NULL AND color != ''
      GROUP BY product_id, color, channel
    `);
    const sm = {};
    stock.forEach(r => { sm[`${r.product_id}|${r.color}|${r.channel}`] = r.stock; });
    res.json(sales.map(r => ({ ...r, stock: sm[`${r.product_id}|${r.color}|${r.channel}`] || 0 })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── CHAT AGENT ────────────────────────────────────────────────────────────────

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const CHAT_SYSTEM_PROMPT = `You are a sharp, experienced data analyst for haniqa — a fashion retail business.
You have live tools to query the database. Today's date is ${new Date().toDateString()}.

## How to think and respond

**Always pull data before answering** — but never stop at one tool. A good analyst triangulates.
Call multiple tools in a single turn whenever a fuller picture helps. Gemini supports parallel tool calls.

**When a tool returns empty or zero results, do NOT say "no data available" and stop.**
Instead: pivot, try related tools, and reason from whatever you can find. Examples:
- Production forecast empty? → check get_low_stock_products + get_product_rankings + get_recent_transactions and synthesize your own recommendation.
- No sales today? → check last_7_days, mention it's a slow day, give context from recent trends.
- No color data? → fall back to product-level rankings and say so.

**Reason like an analyst, not a database.**
Combine signals: if a product has low stock AND high sell-through AND rising demand, say "prioritize this".
If a product has high stock AND declining sales, say "hold off on production".
You are allowed — encouraged — to form opinions and recommendations from the data.

**Answering "what should I produce next?" or production questions:**
1. Call get_production_forecast first.
2. Also call get_low_stock_products and get_product_rankings in the same turn.
3. Combine all three: prioritize products that are low stock, high sell-through, and/or high demand.
4. Give a clear ranked recommendation even if the forecast model has insufficient history.

**Format rules:**
- Lead with the key insight or recommendation, then back it with numbers.
- Use bullet lists for ranked items. Bold the most important figures.
- Use percentages and currency where relevant.
- Be concise — one clear answer, not a list of caveats.
- If something is genuinely unknown (no products exist yet, no transactions ever), say so plainly in one sentence.`;

const CHAT_TOOLS = [
  {
    name: 'get_business_overview',
    description: 'Returns overall KPIs: total revenue, total units sold, today\'s sales, active SKU count, and low-stock item count.',
    parameters: {
      type: 'OBJECT',
      properties: {
        channel: {
          type: 'STRING',
          description: 'Sales channel filter: "both", "wholesale", or "single". Defaults to "both".',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_top_sellers',
    description: 'Returns the top 8 products ranked by units sold, with revenue and stock levels.',
    parameters: {
      type: 'OBJECT',
      properties: {
        channel: {
          type: 'STRING',
          description: 'Sales channel filter: "both", "wholesale", or "single". Defaults to "both".',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_monthly_sales',
    description: 'Returns monthly revenue (in thousands) and units sold for the last 12 months.',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_product_rankings',
    description: 'Returns all products ranked by total units sold, with sell-through rate and current stock.',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_production_forecast',
    description: 'Returns production recommendations for each product: suggested quantity to produce, trend direction, priority level, and days of stock remaining. Based on weighted moving average of recent sales.',
    parameters: {
      type: 'OBJECT',
      properties: {
        horizon: {
          type: 'STRING',
          description: 'Planning horizon: "1w" (1 week), "2w" (2 weeks), "1m" (1 month), "2m" (2 months). Defaults to "2w".',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_demand_forecast',
    description: 'Returns a 4-week demand forecast for all products using weighted moving average and linear trend projection.',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_color_breakdown',
    description: 'Returns units sold and sell-through rate broken down by product, color, and channel.',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_sales_by_period',
    description: 'Returns total revenue, units sold, and transaction count for a specific time period, plus a per-product breakdown of what was sold. Use this for questions like "today\'s sales", "this week\'s sales", "latest sales", "what did we sell yesterday".',
    parameters: {
      type: 'OBJECT',
      properties: {
        period: {
          type: 'STRING',
          description: 'Time period: "today", "yesterday", "last_7_days", "this_month", "last_30_days", "last_month". Defaults to "today".',
        },
        channel: {
          type: 'STRING',
          description: 'Sales channel filter: "both", "wholesale", or "single". Defaults to "both".',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_recent_transactions',
    description: 'Returns the most recent individual sales transactions with a full itemized breakdown: which products were sold, quantity, unit price, and total. Use for "show me recent orders", "last sales", "what was sold today in detail".',
    parameters: {
      type: 'OBJECT',
      properties: {
        period: {
          type: 'STRING',
          description: 'Optional filter: "today", "yesterday", "last_7_days". Leave empty for most recent regardless of date.',
        },
        limit: {
          type: 'NUMBER',
          description: 'Number of transactions to return. Defaults to 15, max 50.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_low_stock_products',
    description: 'Returns all products with stock below a threshold, sorted by most critical first. Includes exact stock count, units sold, and sell-through rate. Use for "low stock", "what needs restocking", "inventory alerts".',
    parameters: {
      type: 'OBJECT',
      properties: {
        threshold: {
          type: 'NUMBER',
          description: 'Stock level below which a product is considered low. Defaults to 20.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_product_detail',
    description: 'Returns a full detail view of a specific product by name: current stock broken down by color, size, and channel; total units sold; total revenue; sell-through rate. Use when the manager asks about a specific product.',
    parameters: {
      type: 'OBJECT',
      properties: {
        product_name: {
          type: 'STRING',
          description: 'Product name or partial name to search for (case-insensitive).',
        },
      },
      required: ['product_name'],
    },
  },
  {
    name: 'get_category_performance',
    description: 'Returns revenue, units sold, product count, and average sell-through rate broken down by product category (tops, bottoms, outerwear, accessories). Use for "how are my categories doing", "which category sells best".',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: [],
    },
  },
];

function executeChatTool(name, args, source = 'pos') {
  const channel = (args && args.channel) || 'both';
  const useDIA  = source === 'dia';

  switch (name) {
    case 'get_business_overview': {
      if (useDIA) {
        const totals = db.get(`SELECT COALESCE(SUM(miktar*birimfiyat),0) AS total_revenue, COALESCE(SUM(miktar),0) AS total_units FROM dia_sales_cache`);
        const today  = db.get(`SELECT COALESCE(SUM(miktar*birimfiyat),0) AS today_sales, COUNT(DISTINCT belge_no) AS today_txns FROM dia_sales_cache WHERE date(tarih)=date('now')`);
        const counts = db.get(`SELECT (SELECT COUNT(DISTINCT stokkodu) FROM dia_stock_cache) AS active_skus, (SELECT COUNT(*) FROM (SELECT stokkodu FROM dia_stock_cache GROUP BY stokkodu HAVING SUM(miktar)<20)) AS low_stock_count`);
        return { source: 'dia', ...totals, ...today, ...counts };
      }
      const totals = db.get(`
        SELECT COALESCE(SUM(ti.quantity * ti.unit_price),0) AS total_revenue,
               COALESCE(SUM(ti.quantity),0)                AS total_units
        FROM transaction_items ti
        JOIN transactions t ON t.id = ti.transaction_id
        WHERE t.type='sale' AND (t.status='completed' OR t.status IS NULL)
          AND (? = 'both' OR ti.channel = ?)
      `, [channel, channel]);
      const today = db.get(`
        SELECT COALESCE(SUM(ti.quantity * ti.unit_price),0) AS today_sales,
               COUNT(DISTINCT t.id)                         AS today_txns
        FROM transaction_items ti
        JOIN transactions t ON t.id = ti.transaction_id
        WHERE t.type='sale' AND (t.status='completed' OR t.status IS NULL)
          AND date(t.created_at)=date('now')
          AND (? = 'both' OR ti.channel = ?)
      `, [channel, channel]);
      const counts = db.get(`
        SELECT COUNT(*) AS active_skus,
          COALESCE((SELECT COUNT(*) FROM (
            SELECT product_id FROM product_variants
            WHERE (? = 'both' OR channel = ?)
            GROUP BY product_id HAVING SUM(stock) < 20
          )),0) AS low_stock_count
        FROM products
      `, [channel, channel]);
      return { channel, ...totals, ...today, ...counts };
    }

    case 'get_top_sellers': {
      if (useDIA) {
        return db.all(`
          SELECT ds.stokkodu AS ref, COALESCE(p.name, ds.stokadi) AS name,
                 COALESCE(p.category,'') AS category, COALESCE(p.price, MAX(ds.birimfiyat)) AS price,
                 SUM(ds.miktar) AS sold, SUM(ds.miktar*ds.birimfiyat) AS revenue_total,
                 COALESCE(st.stock,0) AS stock
          FROM dia_sales_cache ds
          LEFT JOIN products p ON p.ref=ds.stokkodu
          LEFT JOIN (SELECT stokkodu, SUM(miktar) AS stock FROM dia_stock_cache GROUP BY stokkodu) st ON st.stokkodu=ds.stokkodu
          WHERE ds.stokkodu!='' GROUP BY ds.stokkodu ORDER BY sold DESC LIMIT 8
        `);
      }
      return db.all(`
        SELECT p.name, p.ref, p.category, p.price,
          COALESCE(cs.sold,0)          AS sold,
          COALESCE(cs.revenue_total,0) AS revenue_total,
          COALESCE(ck.stock,0)         AS stock
        FROM products p
        LEFT JOIN (
          SELECT ti.product_id, SUM(ti.quantity) AS sold,
                 SUM(ti.quantity * ti.unit_price) AS revenue_total
          FROM transaction_items ti
          JOIN transactions t ON t.id = ti.transaction_id
          WHERE t.type='sale' AND (t.status='completed' OR t.status IS NULL)
            AND (? = 'both' OR ti.channel = ?)
          GROUP BY ti.product_id
        ) cs ON cs.product_id = p.id
        LEFT JOIN (
          SELECT product_id, SUM(stock) AS stock
          FROM product_variants
          WHERE (? = 'both' OR channel = ?)
          GROUP BY product_id
        ) ck ON ck.product_id = p.id
        ORDER BY sold DESC LIMIT 8
      `, [channel, channel, channel, channel]);
    }

    case 'get_monthly_sales': {
      if (useDIA) {
        return db.all(`
          SELECT strftime('%Y-%m', tarih) AS ym, strftime('%b', tarih) AS month,
                 ROUND(COALESCE(SUM(miktar*birimfiyat),0)/1000.0,1) AS revenue_k,
                 COALESCE(SUM(miktar),0) AS units
          FROM dia_sales_cache WHERE tarih >= date('now','-12 months')
          GROUP BY ym ORDER BY ym ASC
        `);
      }
      const rows = db.all(`
        SELECT strftime('%Y-%m', t.created_at) AS ym,
               strftime('%b',   t.created_at)  AS month,
               ROUND(COALESCE(SUM(ti.quantity * ti.unit_price),0)/1000.0,1) AS revenue_k,
               COALESCE(SUM(ti.quantity),0)                                 AS units
        FROM transactions t
        JOIN transaction_items ti ON ti.transaction_id = t.id
        WHERE t.type='sale' AND (t.status='completed' OR t.status IS NULL)
          AND t.created_at >= datetime('now','-12 months')
        GROUP BY ym ORDER BY ym ASC
      `);
      return rows;
    }

    case 'get_product_rankings': {
      const rows = db.all(`
        SELECT p.name, p.category, p.price,
          COALESCE(SUM(ti.quantity),0) AS sold,
          COALESCE((SELECT SUM(pv.stock) FROM product_variants pv WHERE pv.product_id=p.id),0) AS stock
        FROM products p
        LEFT JOIN transaction_items ti ON ti.product_id=p.id
        LEFT JOIN transactions t ON t.id=ti.transaction_id AND t.type='sale' AND (t.status='completed' OR t.status IS NULL)
        GROUP BY p.id ORDER BY sold DESC
      `);
      return rows.map(r => ({
        ...r,
        sell_through_pct: r.sold + r.stock > 0
          ? Math.round(r.sold / (r.sold + r.stock) * 100) : 0,
      }));
    }

    case 'get_production_forecast': {
      const horizonMap   = { '1w': 1, '2w': 2, '1m': 4, '2m': 8 };
      const horizonWeeks = horizonMap[args && args.horizon] || 2;
      const products     = useDIA ? getProductsWithStockDIA() : getProductsWithStock();
      const history      = useDIA ? getWeeklyHistoryDIA(16)   : getWeeklyHistory(16);
      return analytics.computeProductionForecast(products, history, horizonWeeks);
    }

    case 'get_demand_forecast': {
      const products = useDIA ? getProductsWithStockDIA() : getProductsWithStock();
      const history  = useDIA ? getWeeklyHistoryDIA(12)   : getWeeklyHistory(12);
      return analytics.computeDemandForecast(products, history);
    }

    case 'get_color_breakdown': {
      const sales = db.all(`
        SELECT p.name AS product_name, ti.color, ti.channel,
               SUM(ti.quantity)                 AS sold,
               SUM(ti.quantity * ti.unit_price) AS revenue
        FROM transaction_items ti
        JOIN transactions t ON t.id=ti.transaction_id
        JOIN products p ON p.id=ti.product_id
        WHERE t.type='sale' AND (t.status='completed' OR t.status IS NULL)
          AND ti.color IS NOT NULL AND ti.color != ''
        GROUP BY ti.product_id, ti.color, ti.channel
      `);
      const stock = db.all(`
        SELECT p.name AS product_name, pv.color, pv.channel, SUM(pv.stock) AS stock
        FROM product_variants pv
        JOIN products p ON p.id=pv.product_id
        WHERE pv.color IS NOT NULL AND pv.color != ''
        GROUP BY pv.product_id, pv.color, pv.channel
      `);
      const sm = {};
      stock.forEach(r => { sm[`${r.product_name}|${r.color}|${r.channel}`] = r.stock; });
      return sales.map(r => ({
        ...r,
        stock: sm[`${r.product_name}|${r.color}|${r.channel}`] || 0,
        sell_through_pct: r.sold + (sm[`${r.product_name}|${r.color}|${r.channel}`] || 0) > 0
          ? Math.round(r.sold / (r.sold + (sm[`${r.product_name}|${r.color}|${r.channel}`] || 0)) * 100) : 0,
      }));
    }

    case 'get_sales_by_period': {
      const period  = (args && args.period) || 'today';
      const ch      = (args && args.channel) || 'both';
      const diaPeriodConds = {
        today:        `date(tarih) = date('now')`,
        yesterday:    `date(tarih) = date('now', '-1 day')`,
        last_7_days:  `tarih >= date('now', '-7 days')`,
        this_month:   `strftime('%Y-%m', tarih) = strftime('%Y-%m', 'now')`,
        last_30_days: `tarih >= date('now', '-30 days')`,
        last_month:   `strftime('%Y-%m', tarih) = strftime('%Y-%m', date('now', '-1 month'))`,
      };
      if (useDIA) {
        const dateCond = diaPeriodConds[period] || diaPeriodConds.today;
        const summary = db.get(`
          SELECT COALESCE(SUM(miktar*birimfiyat),0) AS total_revenue,
                 COALESCE(SUM(miktar),0) AS total_units,
                 COUNT(DISTINCT belge_no) AS transaction_count
          FROM dia_sales_cache WHERE ${dateCond}
        `);
        const products = db.all(`
          SELECT COALESCE(p.name, ds.stokadi) AS name, COALESCE(p.category,'') AS category,
                 'wholesale' AS channel, SUM(ds.miktar) AS units_sold, SUM(ds.miktar*ds.birimfiyat) AS revenue
          FROM dia_sales_cache ds LEFT JOIN products p ON p.ref=ds.stokkodu
          WHERE ${dateCond} GROUP BY ds.stokkodu ORDER BY units_sold DESC
        `);
        return { period, source: 'dia', ...summary, products };
      }
      const periodConditions = {
        today:        `date(t.created_at) = date('now')`,
        yesterday:    `date(t.created_at) = date('now', '-1 day')`,
        last_7_days:  `t.created_at >= datetime('now', '-7 days')`,
        this_month:   `strftime('%Y-%m', t.created_at) = strftime('%Y-%m', 'now')`,
        last_30_days: `t.created_at >= datetime('now', '-30 days')`,
        last_month:   `strftime('%Y-%m', t.created_at) = strftime('%Y-%m', date('now', '-1 month'))`,
      };
      const dateCond = periodConditions[period] || periodConditions.today;

      const summary = db.get(`
        SELECT COALESCE(SUM(ti.quantity * ti.unit_price), 0) AS total_revenue,
               COALESCE(SUM(ti.quantity), 0)                 AS total_units,
               COUNT(DISTINCT t.id)                          AS transaction_count
        FROM transaction_items ti
        JOIN transactions t ON t.id = ti.transaction_id
        WHERE t.type='sale' AND (t.status='completed' OR t.status IS NULL)
          AND ${dateCond}
          AND (? = 'both' OR ti.channel = ?)
      `, [ch, ch]);

      const products = db.all(`
        SELECT p.name, p.category, ti.channel,
               SUM(ti.quantity)                 AS units_sold,
               SUM(ti.quantity * ti.unit_price) AS revenue
        FROM transaction_items ti
        JOIN transactions t ON t.id = ti.transaction_id
        JOIN products p ON p.id = ti.product_id
        WHERE t.type='sale' AND (t.status='completed' OR t.status IS NULL)
          AND ${dateCond}
          AND (? = 'both' OR ti.channel = ?)
        GROUP BY ti.product_id, ti.channel
        ORDER BY units_sold DESC
      `, [ch, ch]);

      return { period, channel: ch, ...summary, products };
    }

    case 'get_recent_transactions': {
      const period = args && args.period;
      const limit  = Math.min(parseInt((args && args.limit) || 15), 50);
      const periodConditions = {
        today:       `AND date(t.created_at) = date('now')`,
        yesterday:   `AND date(t.created_at) = date('now', '-1 day')`,
        last_7_days: `AND t.created_at >= datetime('now', '-7 days')`,
      };
      const dateCond = periodConditions[period] || '';

      const txns = db.all(`
        SELECT t.id, t.created_at, t.total, t.payment_method, t.description
        FROM transactions t
        WHERE t.type='sale' AND (t.status='completed' OR t.status IS NULL)
          ${dateCond}
        ORDER BY t.created_at DESC
        LIMIT ?
      `, [limit]);

      const txnIds = txns.map(t => t.id);
      if (!txnIds.length) return { transactions: [] };

      const items = db.all(`
        SELECT ti.transaction_id, p.name AS product_name, p.category,
               ti.color, ti.size, ti.channel, ti.quantity, ti.unit_price,
               ti.quantity * ti.unit_price AS line_total
        FROM transaction_items ti
        JOIN products p ON p.id = ti.product_id
        WHERE ti.transaction_id IN (${txnIds.map(() => '?').join(',')})
        ORDER BY ti.transaction_id, p.name
      `, txnIds);

      const itemsByTxn = {};
      items.forEach(i => {
        (itemsByTxn[i.transaction_id] ??= []).push(i);
      });

      return {
        transactions: txns.map(t => ({
          ...t,
          items: itemsByTxn[t.id] || [],
        })),
      };
    }

    case 'get_low_stock_products': {
      const threshold = parseInt((args && args.threshold) || 20);
      if (useDIA) {
        const rows = db.all(`
          SELECT COALESCE(p.name, d.stokadi) AS name, COALESCE(p.category,'') AS category,
                 SUM(d.miktar) AS total_stock,
                 COALESCE(s.sold,0) AS total_sold
          FROM dia_stock_cache d
          LEFT JOIN products p ON p.ref=d.stokkodu
          LEFT JOIN (SELECT stokkodu, SUM(miktar) AS sold FROM dia_sales_cache GROUP BY stokkodu) s ON s.stokkodu=d.stokkodu
          GROUP BY d.stokkodu HAVING total_stock < ?
          ORDER BY total_stock ASC
        `, [threshold]);
        return rows.map(r => ({
          ...r,
          sell_through_pct: r.total_sold + r.total_stock > 0
            ? Math.round(r.total_sold / (r.total_sold + r.total_stock) * 100) : 0,
        }));
      }
      const rows = db.all(`
        SELECT p.name, p.category, p.price,
               COALESCE(SUM(pv.stock), 0) AS total_stock,
               COALESCE(s.sold, 0)         AS total_sold
        FROM products p
        LEFT JOIN product_variants pv ON pv.product_id = p.id
        LEFT JOIN (
          SELECT ti.product_id, SUM(ti.quantity) AS sold
          FROM transaction_items ti
          JOIN transactions t ON t.id = ti.transaction_id
          WHERE t.type='sale' AND (t.status='completed' OR t.status IS NULL)
          GROUP BY ti.product_id
        ) s ON s.product_id = p.id
        GROUP BY p.id
        HAVING total_stock < ?
        ORDER BY total_stock ASC
      `, [threshold]);

      return rows.map(r => ({
        ...r,
        sell_through_pct: r.total_sold + r.total_stock > 0
          ? Math.round(r.total_sold / (r.total_sold + r.total_stock) * 100) : 0,
      }));
    }

    case 'get_product_detail': {
      const search = (args && args.product_name) || '';
      const products = db.all(`
        SELECT p.id, p.name, p.ref, p.category, p.price, p.wholesale_price, p.status, p.season
        FROM products p
        WHERE p.name LIKE ?
        LIMIT 3
      `, [`%${search}%`]);

      if (!products.length) return { error: `No product found matching "${search}"` };

      return products.map(p => {
        const variants = db.all(`
          SELECT color, size, channel, stock
          FROM product_variants
          WHERE product_id = ?
          ORDER BY channel, color, size
        `, [p.id]);

        const sales = db.get(`
          SELECT COALESCE(SUM(ti.quantity), 0)                 AS total_sold,
                 COALESCE(SUM(ti.quantity * ti.unit_price), 0) AS total_revenue
          FROM transaction_items ti
          JOIN transactions t ON t.id = ti.transaction_id
          WHERE ti.product_id = ? AND t.type='sale'
            AND (t.status='completed' OR t.status IS NULL)
        `, [p.id]);

        const totalStock = variants.reduce((s, v) => s + v.stock, 0);
        const sellThrough = sales.total_sold + totalStock > 0
          ? Math.round(sales.total_sold / (sales.total_sold + totalStock) * 100) : 0;

        const colorSummary = {};
        variants.forEach(v => {
          const key = `${v.color} (${v.channel})`;
          colorSummary[key] = (colorSummary[key] || 0) + v.stock;
        });

        return {
          ...p,
          total_stock: totalStock,
          ...sales,
          sell_through_pct: sellThrough,
          stock_by_color_channel: colorSummary,
          variants,
        };
      });
    }

    case 'get_category_performance': {
      const rows = db.all(`
        SELECT p.category,
               COUNT(DISTINCT p.id)                               AS product_count,
               COALESCE(SUM(ti.quantity), 0)                      AS total_units,
               COALESCE(SUM(ti.quantity * ti.unit_price), 0)      AS total_revenue,
               COALESCE(SUM(pv.stock), 0)                         AS total_stock
        FROM products p
        LEFT JOIN transaction_items ti ON ti.product_id = p.id
        LEFT JOIN transactions t ON t.id = ti.transaction_id
          AND t.type='sale' AND (t.status='completed' OR t.status IS NULL)
        LEFT JOIN product_variants pv ON pv.product_id = p.id
        GROUP BY p.category
        ORDER BY total_revenue DESC
      `);
      return rows.map(r => ({
        ...r,
        sell_through_pct: r.total_units + r.total_stock > 0
          ? Math.round(r.total_units / (r.total_units + r.total_stock) * 100) : 0,
      }));
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

app.post('/api/chat', requireAuth, async (req, res) => {
  if (!genAI) {
    return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  }

  const { messages, source } = req.body;
  const dataSource = source === 'dia' ? 'dia' : 'pos';
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const sourceNote = dataSource === 'dia'
    ? 'Data source: DIA ERP (wholesale sales & stock cache). All numbers come from DIA, not the POS register.'
    : 'Data source: POS register (local transaction database).';

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: CHAT_SYSTEM_PROMPT + `\n\n${sourceNote}`,
      tools: [{ functionDeclarations: CHAT_TOOLS }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });

    // Split history (all but last) from the current user message
    const history    = messages.slice(0, -1);
    const lastMsg    = messages[messages.length - 1];
    const userText   = lastMsg.parts?.[0]?.text || '';

    const chat     = model.startChat({ history });
    let response   = await chat.sendMessage(userText);

    // Agentic loop — Gemini may request multiple tool calls before replying
    let iterations = 0;
    while (iterations < 8) {
      const calls = response.response.functionCalls();
      if (!calls || !calls.length) break;
      iterations++;

      const toolResults = calls.map(call => {
        let result;
        try {
          result = executeChatTool(call.name, call.args, dataSource);
        } catch (err) {
          result = { error: err.message };
        }
        return {
          functionResponse: {
            name: call.name,
            response: { result },
          },
        };
      });

      response = await chat.sendMessage(toolResults);
    }

    const replyText = response.response.text();
    res.json({ reply: replyText });

  } catch (err) {
    console.error('Chat agent error:', err);
    res.status(500).json({ error: err.message || 'Chat agent failed' });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────

init().then(() => {
  dia.scheduleNightlySync(db);
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`\n  haniqa running at http://localhost:${PORT}\n`));
}).catch(err => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
