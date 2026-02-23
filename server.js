const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

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
    const r = db.run(
      `INSERT INTO products (name, ref, category, price, wholesale_price, status, season, description)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`,
      [name, ref, category, price, wholesale_price || null, season || null, description || null]
    );
    res.status(201).json(enrichProducts([db.get('SELECT * FROM products WHERE id = ?', [r.lastInsertRowid])])[0]);
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
        if (item.color && item.size) {
          db.run(
            'UPDATE product_variants SET stock = MAX(0, stock - ?) WHERE product_id = ? AND color = ? AND size = ? AND channel = ?',
            [item.quantity, item.productId, item.color, item.size, channel]
          );
        }
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
      if (txn.type === 'sale') {
        const items = db.all('SELECT * FROM transaction_items WHERE transaction_id = ?', [txn.id]);
        for (const item of items) {
          if (item.color && item.size && item.channel) {
            db.run(
              'UPDATE product_variants SET stock = stock + ? WHERE product_id = ? AND color = ? AND size = ? AND channel = ?',
              [item.quantity, item.product_id, item.color, item.size, item.channel]
            );
          }
        }
      }
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
            // Item removed — restore full original stock
            if (orig.color && orig.size && orig.channel) {
              db.run(
                'UPDATE product_variants SET stock = stock + ? WHERE product_id = ? AND color = ? AND size = ? AND channel = ?',
                [orig.quantity, orig.product_id, orig.color, orig.size, orig.channel]
              );
            }
            db.run('DELETE FROM transaction_items WHERE id = ?', [orig.id]);
          } else {
            const newQty   = Math.max(1, parseInt(updated.quantity)  || 1);
            const newPrice = Math.max(0, parseFloat(updated.unitPrice) || 0);

            if (newQty < orig.quantity) {
              // Quantity reduced — restore difference to stock
              const diff = orig.quantity - newQty;
              if (orig.color && orig.size && orig.channel) {
                db.run(
                  'UPDATE product_variants SET stock = stock + ? WHERE product_id = ? AND color = ? AND size = ? AND channel = ?',
                  [diff, orig.product_id, orig.color, orig.size, orig.channel]
                );
              }
            }
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
            // Item removed — restore full original stock
            if (orig.color && orig.size && orig.channel) {
              db.run(
                'UPDATE product_variants SET stock = stock + ? WHERE product_id = ? AND color = ? AND size = ? AND channel = ?',
                [orig.quantity, orig.product_id, orig.color, orig.size, orig.channel]
              );
            }
            db.run('DELETE FROM transaction_items WHERE id = ?', [orig.id]);
          } else {
            const newQty   = Math.max(1, parseInt(updated.quantity)  || 1);
            const newPrice = Math.max(0, parseFloat(updated.unitPrice) || 0);

            if (newQty < orig.quantity) {
              // Quantity reduced — restore the difference to stock
              const diff = orig.quantity - newQty;
              if (orig.color && orig.size && orig.channel) {
                db.run(
                  'UPDATE product_variants SET stock = stock + ? WHERE product_id = ? AND color = ? AND size = ? AND channel = ?',
                  [diff, orig.product_id, orig.color, orig.size, orig.channel]
                );
              }
            }
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

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

app.get('/api/dashboard/stats', requireAuth, (req, res) => {
  const channel = req.query.channel || 'both';
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
  const from    = req.query.from   || null;
  const to      = req.query.to     || null;
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
  try {
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
  try {
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

app.get('/api/analytics/forecast', requireAuth, (req, res) => {
  try {
    const products = db.all('SELECT id, name, category, price FROM products ORDER BY id');
    const weekly   = db.all(`
      SELECT ti.product_id,
             strftime('%Y-%W', t.created_at) AS wk,
             SUM(ti.quantity)                AS units
      FROM transaction_items ti
      JOIN transactions t ON t.id = ti.transaction_id
      WHERE t.type = 'sale' AND (t.status = 'completed' OR t.status IS NULL)
        AND t.created_at >= datetime('now', '-8 weeks')
      GROUP BY ti.product_id, wk
      ORDER BY ti.product_id, wk
    `);

    const allWeeks  = [...new Set(weekly.map(r => r.wk))].sort();
    const byProduct = {};
    weekly.forEach(r => { (byProduct[r.product_id] ??= {})[r.wk] = r.units; });

    function wma(series) {
      if (!series.length) return 0;
      let wSum = 0, vSum = 0;
      series.forEach((v, i) => { const w = i + 1; vSum += v * w; wSum += w; });
      return wSum ? vSum / wSum : 0;
    }
    function linSlope(series) {
      const n = series.length;
      if (n < 2) return 0;
      const xM = (n - 1) / 2;
      const yM = series.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0;
      series.forEach((y, i) => { num += (i - xM) * (y - yM); den += (i - xM) ** 2; });
      return den ? num / den : 0;
    }

    const results = products.map(p => {
      const wkData    = byProduct[p.id] || {};
      const series    = allWeeks.map(wk => wkData[wk] || 0);
      const base      = wma(series);
      const sl        = linSlope(series);
      const projected = [1, 2, 3, 4].map(w => Math.max(0, Math.round(base + sl * w)));
      const nonZero   = series.filter(v => v > 0).length;
      return {
        product_id:      p.id,
        name:            p.name,
        category:        p.category,
        price:           parseFloat(p.price),
        base_weekly:     Math.round(base * 10) / 10,
        slope:           Math.round(sl * 100) / 100,
        projected_4w:    projected,
        total_projected: projected.reduce((a, b) => a + b, 0),
        trend:           sl > 0.3 ? 'rising' : sl < -0.3 ? 'declining' : 'stable',
        confidence:      nonZero >= 4 ? 'high' : nonZero >= 2 ? 'medium' : 'low',
      };
    });
    res.json(results.sort((a, b) => b.total_projected - a.total_projected));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/analytics/color-breakdown', requireAuth, (req, res) => {
  try {
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

// ── START ─────────────────────────────────────────────────────────────────────

init().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`\n  haniqa running at http://localhost:${PORT}\n`));
}).catch(err => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
