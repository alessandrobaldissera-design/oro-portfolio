const GOLD_API_BASE = 'https://api.gold-api.com';

const PERIODS = Object.freeze({
  '24h': { groupBy: 'minute', spanSeconds: 24 * 60 * 60, sampleMinutes: 5, cacheSeconds: 300 },
  '7d':  { groupBy: 'hour',   spanSeconds: 7 * 24 * 60 * 60, cacheSeconds: 900 },
  '30d': { groupBy: 'hour',   spanSeconds: 30 * 24 * 60 * 60, cacheSeconds: 1800 },
  '90d': { groupBy: 'day',    spanSeconds: 90 * 24 * 60 * 60, cacheSeconds: 21600 },
  '1y':  { groupBy: 'day',    spanSeconds: 365 * 24 * 60 * 60, cacheSeconds: 21600 },
  'all': { groupBy: 'month',  years: 50, cacheSeconds: 86400 }
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function startFor(config, nowMs) {
  if (config.years) {
    const d = new Date(nowMs);
    d.setUTCFullYear(d.getUTCFullYear() - config.years);
    return Math.floor(d.getTime() / 1000);
  }
  return Math.floor(nowMs / 1000) - config.spanSeconds;
}

function bucketTimestamp(row, groupBy) {
  const raw = groupBy === 'minute' ? row.date_minute
    : groupBy === 'hour' ? row.date_hour
    : groupBy === 'day' ? row.day
    : row.year_month;
  if (!raw) return null;
  let iso;
  if (groupBy === 'minute') iso = raw.replace(' ', 'T') + ':00Z';
  else if (groupBy === 'hour') iso = raw.replace(' ', 'T') + ':00:00Z';
  else if (groupBy === 'day') iso = raw.slice(0, 10) + 'T00:00:00Z';
  else iso = raw.slice(0, 7) + '-01T00:00:00Z';
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

  return payload.map(row => ({
    ts: bucketTimestamp(row, config.groupBy),
    price: Number(row.avg_price)
  })).filter(point => Number.isFinite(point.ts) && Number.isFinite(point.price) && point.price > 0);
}

function combineSeries(gold, silver) {
  const rows = new Map();
  for (const point of gold) rows.set(point.ts, { ts: point.ts, goldUsd: point.price, silverUsd: null });
  for (const point of silver) {
    const row = rows.get(point.ts) || { ts: point.ts, goldUsd: null, silverUsd: null };
    row.silverUsd = point.price;
    rows.set(point.ts, row);
  }
  return [...rows.values()].sort((a, b) => a.ts - b.ts);
}

function sampleFiveMinutes(points) {
  if (points.length <= 2) return points;
  const sampled = points.filter((point, index) => index === 0 || index === points.length - 1 || Math.floor(point.ts / 60000) % 5 === 0);
  return sampled.filter((point, index) => index === 0 || point.ts !== sampled[index - 1].ts);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Metodo non consentito' });

  const period = String(req.query.period || '7d').toLowerCase();
  const config = PERIODS[period];
  if (!config) return res.status(400).json({ error: 'Periodo non valido' });

  const apiKey = process.env.GOLD_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Servizio dati non configurato' });

  const nowMs = Date.now();
  const endTimestamp = Math.floor(nowMs / 1000);
  const startTimestamp = startFor(config, nowMs);

  try {
    const [gold, silver] = await Promise.all([
      fetchSeries('XAU', config, startTimestamp, endTimestamp, apiKey),
      fetchSeries('XAG', config, startTimestamp, endTimestamp, apiKey)
    ]);
    let points = combineSeries(gold, silver);
    if (config.sampleMinutes === 5) points = sampleFiveMinutes(points);
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
