'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// dia.js — DIA ERP API client
// Handles session management, stock sync, and wholesale sales sync.
// All data is cached locally in dia_stock_cache and dia_sales_cache tables.
// ─────────────────────────────────────────────────────────────────────────────

const DIA_URL  = process.env.DIA_URL      || 'https://haniqa.ws.dia.com.tr/api/v3/scf/json';
const DIA_USER = process.env.DIA_USERNAME || 'ws.rts';
const DIA_PASS = process.env.DIA_PASSWORD || '654321';
const DIA_KEY  = process.env.DIA_APIKEY   || '86f9f6b1-4573-486f-b3ca-ecfb0c810e0c';

// ── IN-MEMORY SESSION ─────────────────────────────────────────────────────────
let _sessionId  = null;
let _firmaKodu  = null;
let _donemKodu  = 0;
let _sessionExp = 0;
let _syncBusy   = false;

// ── CORE HTTP ─────────────────────────────────────────────────────────────────
async function diaPost(body) {
  const res = await fetch(DIA_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DIA HTTP ${res.status}`);
  return res.json();
}

// ── LOGIN / SESSION ───────────────────────────────────────────────────────────
async function diaLogin() {
  const res = await diaPost({
    login: {
      username:             DIA_USER,
      password:             DIA_PASS,
      disconnect_same_user: 'True',
      params:               { apikey: DIA_KEY },
    },
  });
  if (res.code !== '200') throw new Error(`DIA login failed: ${res.msg}`);

  _sessionId  = res.msg;
  _sessionExp = Date.now() + 50 * 60 * 1000; // 50-min safety margin (DIA timeout = 1h)

  // Discover firma_kodu and donem_kodu
  const firmRes = await diaPost({ sis_yetkili_firma_donem_sube_depo: { session_id: _sessionId } });
  if (firmRes.result?.length > 0) {
    const firma    = firmRes.result[0];
    _firmaKodu     = firma.firmakodu;
    const defDonem = (firma.donemler || []).find(d => d.ontanimli === 't');
    _donemKodu     = defDonem ? defDonem.donemkodu : (firma.donemler?.[0]?.donemkodu ?? 0);
    console.log(`✓ DIA session ok — firma: ${_firmaKodu}, dönem: ${_donemKodu}`);
  }
}

async function getSession() {
  if (!_sessionId || Date.now() > _sessionExp) await diaLogin();
  return { sessionId: _sessionId, firmaKodu: _firmaKodu, donemKodu: _donemKodu };
}

// ── GENERIC CALL ──────────────────────────────────────────────────────────────
async function diaCall(service, params = {}) {
  const { sessionId, firmaKodu, donemKodu } = await getSession();
  const res = await diaPost({
    [service]: { session_id: sessionId, firma_kodu: firmaKodu, donem_kodu: donemKodu, ...params },
  });
  if (res.code === '401') {
    _sessionId = null; // force re-login on next call
    return diaCall(service, params);
  }
  return res;
}

// ── STOCK SYNC ────────────────────────────────────────────────────────────────
// Fetches all product variants with their current warehouse quantities from DIA.
async function syncStock(db) {
  const res  = await diaCall('scf_stokkart_varyant_listele', { params: { miktarhesapla: '1' } });
  const list = res.result || [];

  const doSync = db.transaction(() => {
    db.run('DELETE FROM dia_stock_cache');
    for (const row of list) {
      db.run(
        `INSERT INTO dia_stock_cache (dia_key, stokkodu, stokadi, renk, beden, miktar, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          String(row._key       ?? ''),
          String(row.stokkodu   ?? row.kodu  ?? ''),
          String(row.stokadi    ?? row.adi   ?? ''),
          String(row.renk       ?? row.renk1 ?? ''),
          String(row.beden      ?? row.beden1 ?? ''),
          parseFloat(row.miktar ?? row.toplam_miktar ?? 0),
        ]
      );
    }
  });
  doSync();

  db.run(
    `INSERT INTO dia_sync_log (sync_type, synced_at, record_count, status)
     VALUES ('stock', datetime('now'), ?, 'ok')`,
    [list.length]
  );
  return list.length;
}

// ── SALES SYNC ────────────────────────────────────────────────────────────────
// Fetches the last 12 months of wholesale outgoing waybill line-items from DIA.
async function syncSales(db) {
  const from = new Date();
  from.setMonth(from.getMonth() - 12);
  const fromStr = from.toISOString().slice(0, 10);

  // Try irsaliye (waybill) detailed list first; fall back to fatura if no results
  let list = [];
  try {
    const res = await diaCall('scf_irsaliye_listele_ayrintili', {
      filters: [
        { field: 'hareket_turu', op: 'eq',  value: 'S'       }, // S = Satış
        { field: 'tarih',        op: 'gte', value: fromStr  },
      ],
    });
    list = res.result || [];
  } catch (_) {}

  // If irsaliye returned nothing, try fatura detailed list
  if (!list.length) {
    try {
      const res = await diaCall('scf_fatura_listele_ayrintili', {
        filters: [
          { field: 'hareket_turu', op: 'eq',  value: 'S'       },
          { field: 'tarih',        op: 'gte', value: fromStr  },
        ],
      });
      list = res.result || [];
    } catch (_) {}
  }

  const doSync = db.transaction(() => {
    db.run('DELETE FROM dia_sales_cache');
    for (const row of list) {
      db.run(
        `INSERT INTO dia_sales_cache
           (dia_key, belge_no, tarih, stokkodu, stokadi, renk, beden, miktar, birimfiyat, toplam, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          String(row._key         ?? ''),
          String(row.belge_no     ?? row.evrak_no ?? row.fatura_no ?? ''),
          String(row.tarih        ?? ''),
          String(row.stokkodu     ?? row.kodu     ?? ''),
          String(row.stokadi      ?? row.adi      ?? ''),
          String(row.renk         ?? ''),
          String(row.beden        ?? ''),
          parseFloat(row.miktar   ?? 0),
          parseFloat(row.birimfiyat ?? row.fiyat ?? 0),
          parseFloat(row.toplam   ?? row.tutar ?? 0),
        ]
      );
    }
  });
  doSync();

  db.run(
    `INSERT INTO dia_sync_log (sync_type, synced_at, record_count, status)
     VALUES ('sales', datetime('now'), ?, 'ok')`,
    [list.length]
  );
  return list.length;
}

// ── FULL SYNC ─────────────────────────────────────────────────────────────────
async function fullSync(db) {
  if (_syncBusy) throw new Error('Sync already in progress');
  _syncBusy = true;
  try {
    const stockCount = await syncStock(db);
    const salesCount = await syncSales(db);
    return { stockCount, salesCount };
  } finally {
    _syncBusy = false;
  }
}

// ── SYNC STATUS ───────────────────────────────────────────────────────────────
function getStatus(db) {
  const stock = db.get(
    `SELECT synced_at, record_count, status, error_msg
     FROM dia_sync_log WHERE sync_type='stock' ORDER BY id DESC LIMIT 1`
  );
  const sales = db.get(
    `SELECT synced_at, record_count, status, error_msg
     FROM dia_sync_log WHERE sync_type='sales' ORDER BY id DESC LIMIT 1`
  );
  const stockRows = db.get('SELECT COUNT(*) AS c FROM dia_stock_cache') || { c: 0 };
  const salesRows = db.get('SELECT COUNT(*) AS c FROM dia_sales_cache') || { c: 0 };
  return {
    busy:  _syncBusy,
    stock: { lastSync: stock?.synced_at || null, records: stockRows.c, status: stock?.status || 'never' },
    sales: { lastSync: sales?.synced_at || null, records: salesRows.c, status: sales?.status || 'never' },
  };
}

// ── NIGHTLY SCHEDULER ─────────────────────────────────────────────────────────
// Triggers a full sync every night at 2:00 AM.
function scheduleNightlySync(db) {
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() !== 2 || now.getMinutes() >= 5) return;

    // Already synced in this 2:00–2:05 window today?
    const last = db.get(
      `SELECT synced_at FROM dia_sync_log WHERE sync_type='stock' ORDER BY id DESC LIMIT 1`
    );
    const today = new Date().toISOString().slice(0, 10);
    if (last?.synced_at?.startsWith(today)) return;

    console.log('⏰ Nightly DIA sync starting…');
    try {
      const { stockCount, salesCount } = await fullSync(db);
      console.log(`✓ Nightly DIA sync done — ${stockCount} stock variants, ${salesCount} sales`);
    } catch (err) {
      console.error('✗ Nightly DIA sync failed:', err.message);
      db.run(
        `INSERT INTO dia_sync_log (sync_type, synced_at, record_count, status, error_msg)
         VALUES ('stock', datetime('now'), 0, 'error', ?)`,
        [err.message]
      );
    }
  }, 5 * 60 * 1000); // check every 5 minutes
}

module.exports = { diaCall, fullSync, syncStock, syncSales, getStatus, scheduleNightlySync };
