// Signal-Dashboard Worker (RichtigAnlegen AG)
// Quellcode-Stand: siehe GitHub-Repo richtiganlegen/signal-dashboard, Ordner worker/
//
// Endpunkte
//   /api/data     Live-Werte aller Indikatoren (5 Min. Cache)
//   /api/history  Monatswerte ab 2026-04 aus KV (täglich per Cron fortgeschrieben)
//   /api/health   Zustand jeder Datenquelle und letzter Cron-Lauf
//   /api/backfill?month=YYYY-MM&key=ADMIN_KEY   einzelnen Monat neu berechnen
//
// Bindings: KV "HIST", Secrets FRED_KEY und ADMIN_KEY, Cron täglich 22:30 UTC

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Content-Type': 'application/json' };

// Plausible Wertebereiche: Werte ausserhalb gelten als Fehler, damit nie wieder
// eingefrorene oder falsch geparste Zahlen unbemerkt angezeigt werden.
const RANGE = {
  fearGreed: [0, 100], vix: [5, 120], sp500: [1000, 30000], hys: [1, 25],
  pcr: [0.3, 3], spi: [3000, 80000], spTr: [1000, 100000], usdchf: [0.4, 2],
};
const ok = (k, v) => v != null && Number.isFinite(v) && v >= RANGE[k][0] && v <= RANGE[k][1];
const r2 = v => Math.round(v * 100) / 100;
const ymd = d => d.toISOString().slice(0, 10);

async function get(url, type = 'json', extra = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*', ...extra }, cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return type === 'json' ? res.json() : res.text();
}

// ---------- Yahoo Finance ----------
async function yahoo(symbol, range = '5d', interval = '1d') {
  const path = '/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=' + range + '&interval=' + interval;
  let j;
  try { j = await get('https://query1.finance.yahoo.com' + path); }
  catch (e) { j = await get('https://query2.finance.yahoo.com' + path); }
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error('keine Daten');
  const ts = r.timestamp || [], cl = r.indicators?.quote?.[0]?.close || [];
  const series = ts.map((t, i) => ({ d: ymd(new Date(t * 1000)), c: cl[i] })).filter(x => x.c != null);
  return { price: r.meta?.regularMarketPrice ?? series.at(-1)?.c, time: r.meta?.regularMarketTime, series };
}

// ---------- Fear & Greed (CNN, Fallback feargreedmeter.com) ----------
async function fearGreedNow() {
  try {
    const j = await get('https://production.dataviz.cnn.io/index/fearandgreed/graphdata/' + ymd(new Date()),
      'json', { 'Referer': 'https://edition.cnn.com/', 'Origin': 'https://edition.cnn.com' });
    const s = j?.fear_and_greed?.score;
    if (s != null) return { value: Math.round(s), label: j.fear_and_greed.rating, source: 'CNN' };
  } catch (e) { /* Fallback */ }
  const html = await get('https://feargreedmeter.com', 'text');
  const m = html.match(/"fgi":\{"latest":\{"now":(\d{1,3})/);
  if (m) return { value: parseInt(m[1]), label: null, source: 'feargreedmeter.com' };
  throw new Error('kein Wert');
}
async function fearGreedHistory(startDate) {
  const j = await get('https://production.dataviz.cnn.io/index/fearandgreed/graphdata/' + startDate,
    'json', { 'Referer': 'https://edition.cnn.com/', 'Origin': 'https://edition.cnn.com' });
  return (j?.fear_and_greed_historical?.data || []).map(p => ({ d: ymd(new Date(p.x)), c: p.y }));
}

// ---------- High-Yield Spread (FRED) ----------
async function hysSeries(env, start) {
  const j = await get('https://api.stlouisfed.org/fred/series/observations?series_id=BAMLH0A0HYM2&api_key=' + env.FRED_KEY +
    '&file_type=json&observation_start=' + start);
  return (j.observations || []).filter(o => o.value !== '.').map(o => ({ d: o.date, c: parseFloat(o.value) }));
}

// ---------- Put/Call Ratio (CBOE Tagesstatistik, Total P/C) ----------
// Die alten CSV-Dateien (totalpc.csv/equitypc.csv) werden seit Oktober 2019 nicht mehr
// nachgeführt und dürfen nicht mehr verwendet werden.
async function pcrDay(env, date) {
  const key = 'pcr:' + date;
  const cached = env.HIST ? await env.HIST.get(key) : null;
  if (cached) return cached === 'x' ? null : parseFloat(cached);
  let v = null;
  try {
    const j = await get('https://cdn.cboe.com/data/us/options/market_statistics/daily/' + date + '_daily_options');
    const row = (j.ratios || []).find(x => x.name === 'TOTAL PUT/CALL RATIO');
    v = row ? parseFloat(row.value) : null;
  } catch (e) { v = null; }
  if (env.HIST) {
    const isOld = (Date.now() - new Date(date + 'T23:59:00Z')) > 4 * 864e5;
    if (v != null) await env.HIST.put(key, String(v));
    else if (isOld) await env.HIST.put(key, 'x'); // Feiertag: nicht erneut abfragen
  }
  return v;
}
async function pcrUpTo(env, endDate, n = 10, maxLookback = 20) {
  const vals = [];
  let d = new Date(endDate + 'T12:00:00Z');
  for (let i = 0; i < maxLookback && vals.length < n; i++, d = new Date(d - 864e5)) {
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const v = await pcrDay(env, ymd(d));
    if (v != null) vals.push({ d: ymd(d), v });
  }
  if (!vals.length) throw new Error('keine CBOE-Daten');
  return { last: vals[0].v, lastDate: vals[0].d, avg: r2(vals.reduce((a, b) => a + b.v, 0) / vals.length), n: vals.length };
}

// ---------- SPI (SIX, Fallback Yahoo ^SSHI) ----------
async function spiNow() {
  try {
    const j = await get('https://www.six-group.com/fqs/snap.json?select=ClosingPrice,MarketDate&where=ValorId=CH0009987501CHF9');
    const row = j?.rowData?.[0];
    if (row && row[0]) return { value: row[0], date: String(row[1]), source: 'SIX' };
  } catch (e) { /* Fallback */ }
  const y = await yahoo('^SSHI');
  return { value: y.price, date: null, source: 'Yahoo ^SSHI' };
}

// ---------- Live-Daten ----------
async function liveData(env) {
  const tasks = {
    fg: fearGreedNow(),
    vix: yahoo('^VIX').catch(async () => {
      const j = await get('https://api2.mmeter.app/data/public/vix');
      return { price: j?.quote?.[0]?.price };
    }),
    sp: yahoo('^GSPC'),
    spTr: yahoo('^SP500TR'),
    fx: yahoo('USDCHF=X'),
    spi: spiNow(),
    hys: hysSeries(env, ymd(new Date(Date.now() - 20 * 864e5))),
    pcr: pcrUpTo(env, ymd(new Date())),
  };
  const keys = Object.keys(tasks);
  const res = await Promise.allSettled(Object.values(tasks));
  const R = {}, errors = [];
  res.forEach((r, i) => { if (r.status === 'fulfilled') R[keys[i]] = r.value; else errors.push(keys[i] + ': ' + r.reason?.message); });

  const out = { fetchedAt: new Date().toISOString(), sources: {}, errors };
  const set = (k, v, src) => { if (ok(k, v)) { out[k] = r2(v); out.sources[k] = src; } else { out[k] = null; if (v != null) errors.push(k + ': unplausibler Wert ' + v); } };

  set('fearGreed', R.fg?.value, R.fg?.source); out.fearGreedLabel = R.fg?.label ?? null;
  set('vix', R.vix?.price, 'Yahoo ^VIX');
  set('sp500', R.sp?.price, 'Yahoo ^GSPC');
  set('spTr', R.spTr?.price, 'Yahoo ^SP500TR');
  set('usdchf', R.fx?.price, 'Yahoo USDCHF=X');
  set('spi', R.spi?.value, R.spi?.source);
  set('hys', R.hys?.at(-1)?.c, 'FRED BAMLH0A0HYM2'); out.hysDate = R.hys?.at(-1)?.d ?? null;
  if (R.pcr) { set('pcr', R.pcr.last, 'CBOE Total P/C'); out.pcr10d = ok('pcr', R.pcr.avg) ? R.pcr.avg : null; out.pcrDate = R.pcr.lastDate; }
  else { out.pcr = null; out.pcr10d = null; }

  // Allzeithoch auf Schlusskursbasis: täglich per Cron in KV nachgeführt
  const stored = env.HIST ? JSON.parse((await env.HIST.get('ath')) || '{}') : {};
  const spMax = Math.max(stored.sp || 0, ...(R.sp?.series || []).map(x => x.c), out.sp500 || 0);
  const spiMax = Math.max(stored.spi || 0, out.spi || 0);
  if (!stored.sp || !stored.spi) errors.push('ath: noch nicht initialisiert');
  out.sp500Ath = spMax ? r2(spMax) : null;
  out.sp500High = out.sp500Ath; // Kompatibilität
  out.drawdown = out.sp500 && spMax ? r2((out.sp500 / spMax - 1) * 100) : null;
  out.spiAth = spiMax ? r2(spiMax) : null;
  out.spiYearHigh = out.spiAth; // Kompatibilität: Dashboard rechnet SPI-Drawdown gegen diesen Wert
  out.spiDrawdown = out.spi && spiMax ? r2((out.spi / spiMax - 1) * 100) : null;
  out.spTrChf = out.spTr && out.usdchf ? Math.round(out.spTr * out.usdchf) : null;
  out.status = errors.length ? 'teilweise' : 'ok';
  return out;
}

// ---------- Monatswerte ----------
function lastInMonth(series, month) {
  const s = series.filter(x => x.d.startsWith(month));
  return s.length ? s.at(-1) : null;
}
async function computeMonth(env, month) {
  // month = 'YYYY-MM'; berechnet Monatsendwerte bzw. aktuellen Stand im laufenden Monat
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)), end = new Date(Date.UTC(y, m, 0));
  const fgStart = ymd(new Date(start - 5 * 864e5));
  const [fgH, vixH, spH, trH, fxH, spiH, hysH] = await Promise.all([
    fearGreedHistory(fgStart).catch(() => []),
    yahoo('^VIX', '1y').then(x => x.series).catch(() => []),
    yahoo('^GSPC', '1y').then(x => x.series).catch(() => []),
    yahoo('^SP500TR', '2y').then(x => x.series).catch(() => []),
    yahoo('USDCHF=X', '2y').then(x => x.series).catch(() => []),
    yahoo('^SSHI', '2y').then(x => x.series).catch(() => []),
    hysSeries(env, ymd(new Date(start - 10 * 864e5))).catch(() => []),
  ]);
  const sp = lastInMonth(spH, month);
  if (!sp) throw new Error('keine S&P-Daten für ' + month);
  const lastDay = sp.d;
  const pcr = await pcrUpTo(env, lastDay).catch(() => null);

  // S&P TR in CHF und SPI: tiefster Drawdown im Monat gegenüber laufendem Hoch
  // Startwert = Hoch vor Beginn der Tagesreihe (aus der Historie, einmalig gesetzt)
  const athStore = env.HIST ? JSON.parse((await env.HIST.get('athBase')) || '{}') : {};
  const fxMap = Object.fromEntries(fxH.map(x => [x.d, x.c]));
  let lastFx = null, trChfAth = athStore.spTrChf || 0, spiAth = athStore.spi || 0, spDd = 0, spiDd = 0;
  for (const p of trH) {
    if (fxMap[p.d] != null) lastFx = fxMap[p.d];
    if (!lastFx || p.d > ymd(end)) continue;
    const v = p.c * lastFx;
    if (v > trChfAth) trChfAth = v;
    if (p.d >= ymd(start)) spDd = Math.min(spDd, (v / trChfAth - 1) * 100);
  }
  for (const p of spiH) {
    if (p.d > ymd(end)) continue;
    if (p.c > spiAth) spiAth = p.c;
    if (p.d >= ymd(start)) spiDd = Math.min(spiDd, (p.c / spiAth - 1) * 100);
  }
  const tr = lastInMonth(trH, month), fx = lastInMonth(fxH, month);
  const row = {
    d: month,
    fg: Math.round(lastInMonth(fgH, month)?.c ?? NaN),
    vix: r2(lastInMonth(vixH, month)?.c ?? NaN),
    sp: Math.round(sp.c),
    hys: r2(lastInMonth(hysH, month)?.c ?? NaN),
    pcr: pcr ? pcr.avg : null,
    spi: Math.round(lastInMonth(spiH, month)?.c ?? NaN),
    spTr: Math.round(tr?.c ?? NaN),
    spTrChf: tr && fx ? Math.round(tr.c * fx.c) : null,
    spDdMax: Math.round(spDd * 10) / 10,
    spiDdMax: Math.round(spiDd * 10) / 10,
    asOf: lastDay,
  };
  for (const k of Object.keys(row)) if (typeof row[k] === 'number' && !Number.isFinite(row[k])) row[k] = null;
  if (env.HIST) await env.HIST.put('m:' + month, JSON.stringify(row));
  return row;
}

async function updateAth(env) {
  const [sp, spi, tr, fx] = await Promise.all([yahoo('^GSPC', '1y'), yahoo('^SSHI', '1y'), yahoo('^SP500TR', '1y'), yahoo('USDCHF=X', '1y')]);
  const a = JSON.parse((await env.HIST.get('ath')) || '{}');
  a.sp = Math.max(a.sp || 0, ...sp.series.map(x => x.c));
  a.spi = Math.max(a.spi || 0, ...spi.series.map(x => x.c));
  const fxMap = Object.fromEntries(fx.series.map(x => [x.d, x.c]));
  for (const p of tr.series) if (fxMap[p.d]) a.spTrChf = Math.max(a.spTrChf || 0, p.c * fxMap[p.d]);
  await env.HIST.put('ath', JSON.stringify(a));
}

async function cronRun(env) {
  const log = { at: new Date().toISOString(), steps: [] };
  try { await updateAth(env); log.steps.push('ath ok'); } catch (e) { log.steps.push('ath: ' + e.message); }
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  // Vormonat in den ersten Tagen nochmals abschliessen (späte Datenlieferungen)
  const months = now.getUTCDate() <= 5 ? [prevMonth, thisMonth] : [thisMonth];
  for (const m of months) {
    try { await computeMonth(env, m); log.steps.push(m + ' ok'); } catch (e) { log.steps.push(m + ': ' + e.message); }
  }
  try { const l = await liveData(env); log.live = l.status; log.errors = l.errors; } catch (e) { log.live = 'fehler: ' + e.message; }
  await env.HIST.put('lastCron', JSON.stringify(log));
  return log;
}

const json = (o, extra = {}) => new Response(JSON.stringify(o, null, 2), { headers: { ...CORS, ...extra } });

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/api/data') {
      const cache = caches.default, ck = new Request(url.origin + '/api/data-v5');
      const hit = await cache.match(ck);
      if (hit) return new Response(await hit.text(), { headers: { ...CORS, 'X-Cache': 'HIT' } });
      const d = await liveData(env);
      const res = json(d, { 'Cache-Control': 'public, max-age=300' });
      ctx.waitUntil(cache.put(ck, res.clone()));
      return res;
    }

    if (url.pathname === '/api/history') {
      const list = await env.HIST.list({ prefix: 'm:' });
      const rows = await Promise.all(list.keys.map(k => env.HIST.get(k.name).then(JSON.parse)));
      rows.sort((a, b) => a.d.localeCompare(b.d));
      return json(rows, { 'Cache-Control': 'public, max-age=900' });
    }

    if (url.pathname === '/api/health') {
      const live = await liveData(env);
      const lastCron = JSON.parse((await env.HIST.get('lastCron')) || 'null');
      const cronAgeH = lastCron ? (Date.now() - new Date(lastCron.at)) / 36e5 : null;
      const healthy = live.errors.length === 0 && cronAgeH != null && cronAgeH < 30;
      return json({ healthy, live, lastCron, cronAgeHours: cronAgeH && r2(cronAgeH) });
    }

    if (url.pathname === '/api/backfill' || url.pathname === '/api/cron' || url.pathname === '/api/seed') {
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'nicht berechtigt' }, { status: 403 });
      if (url.pathname === '/api/cron') return json(await cronRun(env));
      if (url.pathname === '/api/seed') {
        const a = JSON.parse((await env.HIST.get('ath')) || '{}');
        for (const k of ['sp', 'spi', 'spTrChf']) { const v = parseFloat(url.searchParams.get(k)); if (v) a[k] = Math.max(a[k] || 0, v); }
        await env.HIST.put('ath', JSON.stringify(a));
        const b = {};
        for (const k of ['spiBase', 'spTrChfBase']) { const v = parseFloat(url.searchParams.get(k)); if (v) b[k.replace('Base', '')] = v; }
        if (Object.keys(b).length) await env.HIST.put('athBase', JSON.stringify(b));
        return json({ ath: a, athBase: b });
      }
      const month = url.searchParams.get('month');
      if (!/^\d{4}-\d{2}$/.test(month || '')) return json({ error: 'month=YYYY-MM fehlt' }, { status: 400 });
      return json(await computeMonth(env, month));
    }

    return json({ endpoints: ['/api/data', '/api/history', '/api/health'] }, { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronRun(env));
  },
};
