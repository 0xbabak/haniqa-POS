'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// analytics.js — Pure forecasting & analytics algorithms
// No DB access, no Express. Called from server.js.
// ─────────────────────────────────────────────────────────────────────────────


// ── WEIGHTED MOVING AVERAGE ───────────────────────────────────────────────────
// Linear weights: oldest week = weight 1, newest = weight n
function wma(values) {
  if (!values.length) return 0;
  let vSum = 0, wSum = 0;
  values.forEach((v, i) => { const w = i + 1; vSum += v * w; wSum += w; });
  return wSum ? vSum / wSum : 0;
}


// ── OLS LINEAR REGRESSION ─────────────────────────────────────────────────────
// Returns { slope, intercept } for the series (x = index, y = value)
function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] || 0 };
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  values.forEach((y, i) => {
    num += (i - meanX) * (y - meanY);
    den += (i - meanX) ** 2;
  });
  const slope = den ? num / den : 0;
  return { slope, intercept: meanY - slope * meanX };
}


// ── SAMPLE STANDARD DEVIATION ─────────────────────────────────────────────────
function stdDev(values) {
  if (values.length < 2) return 0;
  const mean     = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}


// ── FORECAST A SINGLE PRODUCT SERIES ─────────────────────────────────────────
// weeklySales   : number[], oldest → newest
// currentStock  : integer
// horizonWeeks  : how many future weeks to sum
// leadTimeDays  : production lead time (default 3 days for this business)
function forecastSeries(weeklySales, currentStock, horizonWeeks, leadTimeDays = 3) {
  if (!weeklySales.length) {
    return {
      wma_weekly:           0,
      slope:                0,
      projected_weekly:     Array(horizonWeeks).fill(0),
      forecast_total:       0,
      safety_stock:         0,
      suggested_production: 0,
      trend:                'no_data',
      confidence:           'low',
      days_of_stock:        null,
      cv:                   null,
    };
  }

  const base          = wma(weeklySales);
  const { slope: rawSlope } = linearRegression(weeklySales);
  const sd            = stdDev(weeklySales);
  const cv            = base > 0 ? sd / base : 1;
  const n             = weeklySales.length;
  const leadTimeWeeks = leadTimeDays / 7;

  // Dampen slope for sparse data to prevent wild extrapolation.
  // With fewer than 6 data points, cap slope to ±20% of the WMA per week.
  const maxSlope = base > 0 ? base * 0.20 : 1;
  const slope    = n >= 6 ? rawSlope : Math.max(-maxSlope, Math.min(maxSlope, rawSlope));

  // Project future weeks: WMA base extrapolated with dampened trend slope
  const projected_weekly = [];
  for (let h = 1; h <= horizonWeeks; h++) {
    const raw = base + slope * (n - 1 + h);
    projected_weekly.push(Math.max(0, Math.round(raw * 10) / 10));
  }
  const forecast_total = Math.round(projected_weekly.reduce((a, b) => a + b, 0) * 10) / 10;

  // Safety stock: 95% service level (Z=1.65) × σ × √(lead_time_in_weeks)
  // Accounts for demand variability during the 3-day production window
  const safety_stock        = Math.ceil(1.65 * sd * Math.sqrt(leadTimeWeeks));
  const suggested_production = Math.max(0, Math.ceil(forecast_total + safety_stock - currentStock));

  // Trend (relative slope to avoid scale sensitivity)
  const slopeRel = base > 0 ? slope / base : 0;
  const trend    = slopeRel >  0.06 ? 'rising'
                 : slopeRel < -0.06 ? 'declining'
                 :                    'stable';

  // Confidence (data quantity + coefficient of variation)
  const nonZero   = weeklySales.filter(v => v > 0).length;
  const confidence = (nonZero >= 8 && cv < 0.4) ? 'high'
                   : (nonZero >= 4 && cv < 0.7) ? 'medium'
                   :                              'low';

  // Days of stock at current run rate
  const dailyRate   = base / 7;
  const days_of_stock = dailyRate > 0 ? Math.round(currentStock / dailyRate) : null;

  return {
    wma_weekly:           Math.round(base * 10) / 10,
    slope:                Math.round(rawSlope * 100) / 100,
    projected_weekly,
    forecast_total,
    safety_stock,
    suggested_production,
    trend,
    confidence,
    days_of_stock,
    cv:                   Math.round(cv * 100) / 100,
  };
}


// ── PRODUCTION FORECAST ───────────────────────────────────────────────────────
// products      : [{ id, name, category, price, stock }]
// weeklyHistory : { [productId]: { wk: 'YYYY-WW', units: number }[] }
// horizonWeeks  : the user-selected forecast window (1w / 2w / 1m / 2m)
//
// Logic: "target coverage" model — flag products whose current stock covers
// fewer than TARGET_COVER_WEEKS at the current sales velocity.
// Suggested production = units needed to bring stock back up to TARGET_COVER_WEEKS.
// This is far more actionable than a pure "will I run out in N days?" model,
// and naturally shows all meaningful products regardless of horizon selection.
//
// Priority is based on weeks-of-cover, not absolute days:
//   URGENT  < 1 week  cover
//   HIGH    < 2 weeks cover
//   MEDIUM  < 3 weeks cover
//   LOW     < TARGET  weeks cover
//
// Ranking uses a hidden composite score = priority_base + wma_weekly × 10
// so high-volume products always rank above low-volume ones within each bucket.
function computeProductionForecast(products, weeklyHistory, horizonWeeks) {
  const TARGET_COVER_WEEKS = 4;   // aim to always have 4 weeks of stock on hand
  const MIN_VELOCITY       = 0.2; // exclude products selling < 0.2 units/week

  const PRIORITY_BASE = { urgent: 4000, high: 3000, medium: 2000, low: 1000 };

  const rows = [];

  for (const p of products) {
    const history = (weeklyHistory[p.id] || [])
      .sort((a, b) => a.wk.localeCompare(b.wk))
      .map(w => w.units);

    if (!history.length) continue;

    const stock    = parseFloat(p.stock) || 0;
    const forecast = forecastSeries(history, stock, horizonWeeks);
    const wma      = forecast.wma_weekly;

    if (wma < MIN_VELOCITY) continue;

    const weeksOfCover = wma > 0 ? stock / wma : 999;

    // Only show products below target coverage
    if (weeksOfCover >= TARGET_COVER_WEEKS) continue;

    // Priority by weeks-of-cover
    const priority = weeksOfCover <= 0   ? 'urgent'
                   : weeksOfCover <  1   ? 'urgent'
                   : weeksOfCover <  2   ? 'high'
                   : weeksOfCover <  3   ? 'medium'
                   :                      'low';

    // Suggested production: bring stock up to TARGET_COVER_WEEKS
    const target_stock          = Math.ceil(wma * TARGET_COVER_WEEKS);
    const suggested_production  = Math.max(0, target_stock - stock);

    // Hidden composite score: priority bucket + velocity tiebreaker
    const _score = (PRIORITY_BASE[priority] || 0) + wma * 10;

    rows.push({
      id:                  p.id,
      name:                p.name,
      category:            p.category || '',
      price:               parseFloat(p.price) || 0,
      current_stock:       stock,
      weeks_of_cover:      Math.round(weeksOfCover * 10) / 10,
      target_stock,
      suggested_production,
      weeks_of_data:       history.length,
      priority,
      _score,
      // Pass through forecast fields for display
      wma_weekly:          forecast.wma_weekly,
      slope:               forecast.slope,
      trend:               forecast.trend,
      confidence:          forecast.confidence,
      days_of_stock:       forecast.days_of_stock,
      forecast_total:      forecast.forecast_total,
      safety_stock:        forecast.safety_stock,
      cv:                  forecast.cv,
    });
  }

  return rows.sort((a, b) => b._score - a._score);
}


// ── DEMAND FORECAST (4-week rolling, for the forecast table section) ──────────
function computeDemandForecast(products, weeklyHistory) {
  const MIN_VELOCITY = 0.2;

  return products
    .map(p => {
      const history = (weeklyHistory[p.id] || [])
        .sort((a, b) => a.wk.localeCompare(b.wk))
        .map(w => w.units);

      if (!history.length) return null;

      const f = forecastSeries(history, parseInt(p.stock) || 0, 4);
      if (f.wma_weekly < MIN_VELOCITY) return null; // skip barely-selling products
      return {
        product_id:      p.id,
        name:            p.name,
        category:        p.category || '',
        price:           parseFloat(p.price) || 0,
        base_weekly:     f.wma_weekly,
        slope:           f.slope,
        projected_4w:    f.projected_weekly,
        total_projected: f.forecast_total,
        trend:           f.trend,
        confidence:      f.confidence,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.base_weekly - a.base_weekly); // rank by actual velocity, not projected total
}


module.exports = { computeProductionForecast, computeDemandForecast };
