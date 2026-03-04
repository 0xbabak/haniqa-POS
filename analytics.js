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
  const { slope }     = linearRegression(weeklySales);
  const sd            = stdDev(weeklySales);
  const cv            = base > 0 ? sd / base : 1;
  const n             = weeklySales.length;
  const leadTimeWeeks = leadTimeDays / 7;

  // Project future weeks: WMA base extrapolated with trend slope
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
    slope:                Math.round(slope * 100) / 100,
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


// ── PRODUCTION PRIORITY ───────────────────────────────────────────────────────
function getPriority(daysOfStock, trend, suggestedProduction) {
  if (suggestedProduction === 0) return 'ok';
  if (daysOfStock === null || daysOfStock <= 0) return 'urgent';
  if (daysOfStock < 3)                          return 'urgent';
  if (daysOfStock < 7 || (daysOfStock < 14 && trend === 'rising')) return 'high';
  if (daysOfStock < 21)                         return 'medium';
  return 'low';
}


// ── PRODUCTION FORECAST ───────────────────────────────────────────────────────
// products      : [{ id, name, category, price, stock }]
// weeklyHistory : { [productId]: { wk: 'YYYY-WW', units: number }[] }
// horizonWeeks  : integer (1, 2, 4, or 8)
function computeProductionForecast(products, weeklyHistory, horizonWeeks) {
  const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3, ok: 4 };

  const rows = products.map(p => {
    const history = (weeklyHistory[p.id] || [])
      .sort((a, b) => a.wk.localeCompare(b.wk))
      .map(w => w.units);

    const stock    = parseInt(p.stock) || 0;
    const forecast = forecastSeries(history, stock, horizonWeeks);
    const priority = getPriority(forecast.days_of_stock, forecast.trend, forecast.suggested_production);

    return {
      id:                   p.id,
      name:                 p.name,
      category:             p.category || '',
      price:                parseFloat(p.price) || 0,
      current_stock:        stock,
      weeks_of_data:        history.length,
      priority,
      priority_order:       PRIORITY_ORDER[priority],
      ...forecast,
    };
  });

  return rows
    .filter(r => r.priority !== 'ok')
    .sort((a, b) =>
      a.priority_order - b.priority_order ||
      b.suggested_production - a.suggested_production
    );
}


// ── DEMAND FORECAST (4-week rolling, for the forecast table section) ──────────
function computeDemandForecast(products, weeklyHistory) {
  return products
    .map(p => {
      const history = (weeklyHistory[p.id] || [])
        .sort((a, b) => a.wk.localeCompare(b.wk))
        .map(w => w.units);

      if (!history.length) return null;

      const f = forecastSeries(history, parseInt(p.stock) || 0, 4);
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
    .sort((a, b) => b.total_projected - a.total_projected);
}


module.exports = { computeProductionForecast, computeDemandForecast };
