'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// dia.js — DIA ERP API client
// Handles session management, stock sync, and wholesale sales sync.
// All data is cached locally in dia_stock_cache and dia_sales_cache tables.
// ─────────────────────────────────────────────────────────────────────────────

// Derive base URL from DIA_URL env var (strip any module path suffix)
const _DIA_BASE = (process.env.DIA_URL || 'https://haniqa.ws.dia.com.tr').replace(/\/api\/.*$/, '');
const DIA_SIS_URL = `${_DIA_BASE}/api/v3/sis/json`; // login, sis_* services
const DIA_SCF_URL = `${_DIA_BASE}/api/v3/scf/json`; // scf_* stock & sales services
const DIA_USER = process.env.DIA_USERNAME  || 'ws.rts';
const DIA_PASS = process.env.DIA_PASSWORD  || '654321';
const DIA_KEY  = process.env.DIA_APIKEY   || '86f9f6b1-4573-486f-b3ca-ecfb0c810e0c';

// Explicit firma/donem overrides — set these to target the right company.
// HANIQA TEKSTİL = firma 1, current period = donem 5 (wholesale/FATİH DEPO).
const DIA_FIRMA_OVERRIDE = process.env.DIA_FIRMA_KODU ? parseInt(process.env.DIA_FIRMA_KODU) : null;
const DIA_DONEM_OVERRIDE = process.env.DIA_DONEM_KODU ? parseInt(process.env.DIA_DONEM_KODU) : null;

// ── IN-MEMORY SESSION ─────────────────────────────────────────────────────────
let _sessionId  = null;
let _firmaKodu  = null;
let _donemKodu  = 0;
let _sessionExp = 0;
let _syncBusy   = false;

// ── CORE HTTP ─────────────────────────────────────────────────────────────────
async function diaPost(body, url = DIA_SCF_URL) {
  const res = await fetch(url, {
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
  }, DIA_SIS_URL);
  if (res.code !== '200') throw new Error(`DIA login failed: ${res.msg}`);

  _sessionId  = res.msg;
  _sessionExp = Date.now() + 50 * 60 * 1000; // 50-min safety margin (DIA timeout = 1h)

  // Discover firma_kodu and donem_kodu
  const firmRes = await diaPost({ sis_yetkili_firma_donem_sube_depo: { session_id: _sessionId } }, DIA_SIS_URL);
  if (firmRes.result?.length > 0) {
    // If explicit overrides are set, use them; otherwise fall back to the first returned firma.
    let firma;
    if (DIA_FIRMA_OVERRIDE) {
      firma = firmRes.result.find(f => Number(f.firmakodu) === DIA_FIRMA_OVERRIDE) || firmRes.result[0];
    } else {
      firma = firmRes.result[0];
    }
    _firmaKodu = firma.firmakodu;
    if (DIA_DONEM_OVERRIDE) {
      const found = (firma.donemler || []).find(d => Number(d.donemkodu) === DIA_DONEM_OVERRIDE);
      _donemKodu = found ? found.donemkodu : DIA_DONEM_OVERRIDE;
    } else {
      const defDonem = (firma.donemler || []).find(d => d.ontanimli === 't');
      _donemKodu     = defDonem ? defDonem.donemkodu : (firma.donemler?.[0]?.donemkodu ?? 0);
    }
    console.log(`✓ DIA session ok — firma: ${_firmaKodu} (${firma.firmaadi}), dönem: ${_donemKodu}`);
  }
}

async function getSession() {
  if (!_sessionId || Date.now() > _sessionExp) await diaLogin();
  return { sessionId: _sessionId, firmaKodu: _firmaKodu, donemKodu: _donemKodu };
}

// ── GENERIC CALL ──────────────────────────────────────────────────────────────
// Services prefixed with 'sis_' go to the SIS module endpoint; all others to SCF.
async function diaCall(service, params = {}) {
  const { sessionId, firmaKodu, donemKodu } = await getSession();
  const url = service.startsWith('sis_') ? DIA_SIS_URL : DIA_SCF_URL;
  const res = await diaPost({
    [service]: { session_id: sessionId, firma_kodu: firmaKodu, donem_kodu: donemKodu, ...params },
  }, url);
  if (res.code === '401') {
    _sessionId = null; // force re-login on next call
    return diaCall(service, params);
  }
  return res;
}

// ── STOCK SYNC ────────────────────────────────────────────────────────────────
// Uses scf_stokkart_listele which includes stokkartkodu, aciklama, gercek_stok.
async function syncStock(db) {
  const res  = await diaCall('scf_stokkart_listele', { params: { miktarhesapla: '1' } });
  const list = res.result || [];

  if (list.length > 0) {
    console.log(`[DIA stock] ${list.length} products. Sample fields: stokkartkodu=${list[0].stokkartkodu}, aciklama=${list[0].aciklama}, gercek_stok=${list[0].gercek_stok}`);
  }

  const doSync = db.transaction(() => {
    db.run('DELETE FROM dia_stock_cache');
    for (const row of list) {
      db.run(
        `INSERT INTO dia_stock_cache (dia_key, stokkodu, stokadi, renk, beden, miktar, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          String(row._key            ?? ''),
          String(row.stokkartkodu    ?? ''),
          String(row.aciklama        ?? row.stokadi ?? ''),
          String(row.ozelkod1kodu    ?? ''),   // category code in renk field (reused)
          String(row.ozelkod1        ?? ''),   // category name in beden field (reused)
          parseFloat(row.gercek_stok ?? row.fiili_stok ?? 0),
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
// Fetches the last 12 months of wholesale (Toptan Satış, turu=3) waybill line-items from DIA.
// Uses HANIQA TEKSTİL (firma=1) / FATİH DEPO data, not the e-commerce company.
async function syncSales(db) {
  const from = new Date();
  from.setMonth(from.getMonth() - 12);
  const fromStr = from.toISOString().slice(0, 10);

  // Filter for wholesale only (turu=3 = Toptan Satış). Excludes perakende (retail) and mal alım.
  let list = [];
  try {
    const res = await diaCall('scf_irsaliye_listele_ayrintili', {
      filters: [
        { field: 'tarih', operator: '>=', value: fromStr },
        { field: 'turu',  operator: '=',  value: '3' },   // 3 = Toptan Satış
      ],
    });
    list = res.result || [];
    if (list.length) console.log(`✓ DIA wholesale irsaliye sync: ${list.length} line-items`);
  } catch (err) {
    console.warn('DIA irsaliye sync error:', err.message);
  }

  // Fallback: no-filter fetch, then JS-filter by turu
  if (!list.length) {
    try {
      const res = await diaCall('scf_irsaliye_listele_ayrintili', {});
      list = (res.result || []).filter(r => {
        const d = r.tarih || r.evrak_tarihi || '';
        return String(r.turu) === '3' && (!d || d >= fromStr);
      });
      if (list.length) console.log(`✓ DIA irsaliye (no-filter fallback): ${list.length} wholesale line-items`);
    } catch (err) {
      console.warn('DIA irsaliye no-filter sync error:', err.message);
    }
  }

  if (list.length > 0) {
    console.log(`[DIA sales] ${list.length} records. Sample: stokkartkodu=${list[0].stokkartkodu}, tarih=${list[0].tarih}, miktar=${list[0].miktar}, turuack=${list[0].turuack}, depo=${list[0].depo}`);
  }

  // Exclude return records (turu=8 = Toptan Satış İade); belt-and-suspenders guard.
  const sales = list.filter(r => String(r.turu) !== '8' && !String(r.turuack ?? '').includes('İade'));
  console.log(`[DIA sales] After filtering returns: ${sales.length} sales records`);

  const doSync = db.transaction(() => {
    db.run('DELETE FROM dia_sales_cache');
    for (const row of sales) {
      db.run(
        `INSERT INTO dia_sales_cache
           (dia_key, belge_no, tarih, stokkodu, stokadi, renk, beden, miktar, birimfiyat, toplam, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          String(row._key             ?? ''),
          String(row.fisno            ?? row.belgeno ?? ''),
          String(row.tarih            ?? ''),
          String(row.stokkartkodu     ?? ''),
          String(row.stokaciklama     ?? row.stokadi ?? ''),
          String(row.renk             ?? ''),
          String(row.beden            ?? ''),
          parseFloat(row.miktar       ?? 0),
          parseFloat(row.birimfiyati  ?? row.birimfiyat ?? 0),
          parseFloat(row.toplamtutar  ?? row.toplam ?? 0),
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
