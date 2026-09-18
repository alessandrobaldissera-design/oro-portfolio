const GOLD_API_BASE = 'https://api.gold-api.com';
const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v1';
const OZ_TO_G = 31.1035;

const PERIODS = Object.freeze({
  '24h': { groupBy: 'minute', spanSeconds: 24 * 60 * 60, sampleMinutes: 5, cacheSeconds: 300 },
  '7d': { groupBy: 'hour', spanSeconds: 7 * 24 * 60 * 60, cacheSeconds: 900 },
  '30d': { groupBy: 'hour', spanSeconds: 30 * 24 * 60 * 60, cacheSeconds: 1800 },
  '90d': { groupBy: 'day', spanSeconds: 90 * 24 * 60 * 60, cacheSeconds: 21600 },
  '1y': { groupBy: 'day', spanSeconds: 365 * 24 * 60 * 60, cacheSeconds: 21600 },
  // Limite tecnico della fonte, non promessa di anni di copertura.
  'all': { groupBy: 'month', startYear: 1980, cacheSeconds: 86400 }
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function startFor(config, nowMs) {
  return config.startYear
    ? Math.floor(Date.UTC(config.startYear, 0, 1) / 1000)
    : Math.floor(nowMs / 1000) - config.spanSeconds;
}

function bucketTimestamp(row, groupBy) {
  const raw = groupBy === 'minute'
    ? row.date_minute
    : groupBy === 'hour'
      ? row.date_hour
      : groupBy === 'day'
        ? row.day
        : row.year_month;
  if (!raw) return null;
  const iso = groupBy === 'minute'
    ? raw.replace(' ', 'T') + ':00Z'
    : groupBy === 'hour'
      ? raw.replace(' ', 'T') + ':00:00Z'
      : groupBy === 'day'
        ? raw.slice(0, 10) + 'T00:00:00Z'
        : raw.slice(0, 7) + '-01T00:00:00Z';
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : null;
}

async function fetchSeries(symbol, config, startTimestamp, endTimestamp, apiKey) {
  const url = new URL('/history', GOLD_API_BASE);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('startTimestamp', String(startTimestamp));
  url.searchParams.set('endTimestamp', String(endTimestamp));
  url.searchParams.set('groupBy', config.groupBy);
  url.searchParams.set('aggregation', 'avg');
  url.searchParams.set('orderBy', 'asc');
  const response = await fetch(url, { headers: { 'x-api-key': apiKey } });
  if (!response.ok) throw new Error(`Gold API ${symbol}: HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error(`Gold API ${symbol}: risposta non valida`);
  return payload
    .map(row => ({ ts: bucketTimestamp(row, config.groupBy), price: Number(row.avg_price) }))
    .filter(point => Number.isFinite(point.ts) && Number.isFinite(point.price) && point.price > 0);
}

function combineSeries(gold, silver, platinum) {
  const rows = new Map();
  const add = (series, field) => series.forEach(point => {
    const row = rows.get(point.ts) || { ts: point.ts, goldUsd: null, silverUsd: null, platinumUsd: null };
    row[field] = point.price;
    rows.set(point.ts, row);
  });
  add(gold, 'goldUsd');
  add(silver, 'silverUsd');
  add(platinum, 'platinumUsd');
  return [...rows.values()].sort((a, b) => a.ts - b.ts);
}

function sampleFiveMinutes(points, startTimestamp, endTimestamp) {
  const stepMs = 300000;
  const startMs = startTimestamp * 1000;
  const endMs = endTimestamp * 1000;
  return points
    .filter(point => point.ts >= startMs && point.ts <= endMs && point.ts % stepMs === 0)
    .filter((point, index, rows) => index === 0 || point.ts !== rows[index - 1].ts);
}

function hasCompleteFiveMinuteGrid(points, startTimestamp, endTimestamp) {
  const stepMs = 300000;
  const startMs = startTimestamp * 1000;
  const expected = Math.floor((endTimestamp * 1000 - startMs) / stepMs) + 1;
  return points.length === expected && points.every((point, index) =>
    point.ts === startMs + index * stepMs &&
    point.goldUsd > 0 && point.silverUsd > 0 && point.platinumUsd > 0
  );
}

function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { key: `${match[1]}-${match[2]}-${match[3]}`, timestamp };
}

function utcDateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

const FRED_GRAPH_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';
const EUR_PER_DEM = 1 / 1.95583;
let preEuroRatesPromise = null;

function csvRows(csv) {
  return String(csv || '').trim().split(/\r?\n/).slice(1).map(line => {
    const comma = line.indexOf(',');
    return comma > 0 ? { date: line.slice(0, comma), value: Number(line.slice(comma + 1)) } : null;
  }).filter(row => row && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.value) && row.value > 0);
}

async function preEuroRates() {
  if (!preEuroRatesPromise) {
    preEuroRatesPromise = Promise.all([
      fetch(FRED_GRAPH_BASE + 'DEXSZUS', { cache: 'force-cache' }).then(r => r.ok ? r.text() : Promise.reject(new Error('Cambio CHF non disponibile'))),
      fetch(FRED_GRAPH_BASE + 'EXGEUS', { cache: 'force-cache' }).then(r => r.ok ? r.text() : Promise.reject(new Error('Cambio EUR storico non disponibile')))
    ]).then(([chfCsv, demCsv]) => ({ chf: csvRows(chfCsv), dem: csvRows(demCsv) }));
  }
  return preEuroRatesPromise;
}

function lastRateOnOrBefore(rows, dateKey) {
  let result = null;
  for (const row of rows) {
    if (row.date > dateKey) break;
    result = row;
  }
  return result;
}

async function fetchExchangeRatesForDate(dateKey) {
  if (dateKey >= '1999-01-04') {
    const response = await fetch(FRANKFURTER_BASE + '/' + dateKey + '?base=USD&symbols=CHF,EUR', { cache: 'no-store' });
    if (!response.ok) throw new Error('Cambio storico: HTTP ' + response.status);
    const payload = await response.json();
    const chf = Number(payload?.rates?.CHF);
    const eur = Number(payload?.rates?.EUR);
    if (!Number.isFinite(chf) || chf <= 0 || !Number.isFinite(eur) || eur <= 0) throw new Error('Cambio storico: risposta non valida');
    return { date: String(payload.date || dateKey), USD: 1, CHF: chf, EUR: eur };
  }

  // Prima dell'euro: CHF giornaliero Fed; EUR equivalente calcolato dal marco tedesco storico
  // con il tasso irrevocabile DEM/EUR. Il risultato è sempre restituito nella valuta attiva.
  const rates = await preEuroRates();
  const chf = lastRateOnOrBefore(rates.chf, dateKey);
  const dem = lastRateOnOrBefore(rates.dem, dateKey.slice(0, 7) + '-31') || lastRateOnOrBefore(rates.dem, dateKey);
  if (!chf || !dem) throw new Error('Cambio storico non disponibile per la data richiesta');
  return { date: dateKey, USD: 1, CHF: chf.value, EUR: dem.value * EUR_PER_DEM };
}

const HISTORICAL_METALS = Object.freeze({
  gold: { symbol: 'XAU' },
  silver: { symbol: 'XAG' },
  platinum: { symbol: 'XPT' }
});

function historicalPricePerGram(usdPerOunce, rates) {
  const usd = Number(usdPerOunce) / OZ_TO_G;
  return {
    USD: usd,
    EUR: rates ? usd * rates.EUR : null,
    CHF: rates ? usd * rates.CHF : null
  };
}

async function historicalDatePackage(dateValue, metalValue, apiKey) {
  const parsed = parseDateKey(dateValue);
  const metal = String(metalValue || '').toLowerCase();
  const metalConfig = HISTORICAL_METALS[metal];
  if (!parsed || parsed.key > utcDateKey(Date.now()) || !metalConfig) {
    const error = new Error('Data o metallo non validi');
    error.statusCode = 400;
    throw error;
  }

  // Richiesta puntuale: la data scelta non viene sostituita con un giorno precedente.
  const startTimestamp = Math.floor((parsed.timestamp - 2 * 24 * 60 * 60 * 1000) / 1000);
  const requestedEnd = parsed.timestamp + 24 * 60 * 60 * 1000 - 1;
  const endTimestamp = Math.floor(Math.min(requestedEnd, Date.now()) / 1000);
  const series = await fetchSeries(metalConfig.symbol, { groupBy: 'day' }, startTimestamp, endTimestamp, apiKey);
  const point = series.find(item => item.ts === parsed.timestamp && item.price > 0);
  if (!point) {
    const error = new Error('Nessuna quotazione disponibile per il giorno selezionato');
    error.statusCode = 404;
    throw error;
  }

  const actualMetalDate = utcDateKey(point.ts);
  let rates = null;
  try {
    rates = await fetchExchangeRatesForDate(actualMetalDate);
  } catch (error) {
    // La quotazione USD resta reale e utilizzabile anche quando manca il cambio storico EUR/CHF.
    console.error(error);
  }

  return {
    version: 2,
    source: 'Gold API',
    measure: 'daily-average',
    metal,
    requestedDate: parsed.key,
    actualMetalDate,
    exchangeRateDate: rates?.date || null,
    pricesUsdPerOunce: { [metal]: point.price },
    exchangeRatesPerUsd: rates ? { USD: 1, EUR: rates.EUR, CHF: rates.CHF } : { USD: 1, EUR: null, CHF: null },
    pricesPerGram: { [metal]: historicalPricePerGram(point.price, rates) }
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Metodo non consentito' });

  const apiKey = process.env.GOLD_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Servizio dati non configurato' });

  if (req.query.date != null) {
    try {
      const payload = await historicalDatePackage(String(req.query.date), String(req.query.metal || ''), apiKey);
      const requestedIsToday = payload.requestedDate === utcDateKey(Date.now());
      res.setHeader('Cache-Control', requestedIsToday
        ? 'public, s-maxage=300, stale-while-revalidate=60'
        : 'public, s-maxage=86400, stale-while-revalidate=3600');
      return res.status(200).json(payload);
    } catch (error) {
      console.error(error);
      res.setHeader('Cache-Control', 'no-store');
      const status = Number(error?.statusCode) || 502;
      const message = status === 400
        ? 'Data o metallo non validi'
        : status === 404
          ? 'Nessuna quotazione disponibile per il giorno selezionato'
          : 'Quotazione storica temporaneamente non disponibile';
      return res.status(status).json({ error: message });
    }
  }

  const period = String(req.query.period || '7d').toLowerCase();
  const config = PERIODS[period];
  if (!config) return res.status(400).json({ error: 'Periodo non valido' });

  const nowMs = Date.now();
  let endTimestamp = Math.floor(nowMs / 1000);
  let startTimestamp = startFor(config, nowMs);
  let fetchStartTimestamp = startTimestamp;
  if (config.sampleMinutes) {
    const step = config.sampleMinutes * 60;
    endTimestamp = Math.floor(endTimestamp / step) * step - step;
    startTimestamp = endTimestamp - config.spanSeconds;
    fetchStartTimestamp = startTimestamp - 1800;
  }

  try {
    const [gold, silver, platinum] = await Promise.all([
      fetchSeries('XAU', config, fetchStartTimestamp, endTimestamp, apiKey),
      fetchSeries('XAG', config, fetchStartTimestamp, endTimestamp, apiKey),
      fetchSeries('XPT', config, fetchStartTimestamp, endTimestamp, apiKey)
    ]);
    if (!gold.length || !silver.length || !platinum.length) {
      throw new Error('Una o più serie storiche non sono disponibili');
    }

    let points = combineSeries(gold, silver, platinum);
    if (config.sampleMinutes === 5) {
      const stepMs = 300000;
      const latest = points
        .filter(point => point.ts <= endTimestamp * 1000 && point.ts % stepMs === 0 && point.goldUsd > 0 && point.silverUsd > 0 && point.platinumUsd > 0)
        .pop();
      if (!latest || endTimestamp * 1000 - latest.ts > 1800000) {
        throw new Error('Dati intraday troppo distanti dall’ora corrente');
      }
      endTimestamp = Math.floor(latest.ts / 1000);
      startTimestamp = endTimestamp - config.spanSeconds;
      points = sampleFiveMinutes(points, startTimestamp, endTimestamp);
      if (!hasCompleteFiveMinuteGrid(points, startTimestamp, endTimestamp)) {
        throw new Error('Griglia a 5 minuti incompleta');
      }
    }
    if (!points.length) throw new Error('Nessun punto storico disponibile');

    res.setHeader('Cache-Control', `public, s-maxage=${config.cacheSeconds}, stale-while-revalidate=${Math.max(60, Math.floor(config.cacheSeconds / 2))}`);
    return res.status(200).json({
      version: 1,
      source: 'Gold API',
      period,
      resolution: config.sampleMinutes ? `${config.sampleMinutes}m` : config.groupBy,
      requestedStart: startTimestamp * 1000,
      requestedEnd: endTimestamp * 1000,
      actualStart: points[0].ts,
      actualEnd: points[points.length - 1].ts,
      points
    });
  } catch (error) {
    console.error(error);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Dati storici temporaneamente non disponibili' });
  }
}
