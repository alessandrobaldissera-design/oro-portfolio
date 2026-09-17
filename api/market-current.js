const GOLD_API_BASE = 'https://api.gold-api.com';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
}

async function fetchMetal(symbol, apiKey) {
  const response = await fetch(`${GOLD_API_BASE}/price/${symbol}`, {
    headers: { 'x-api-key': apiKey },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`Gold API ${symbol}: HTTP ${response.status}`);
  const payload = await response.json();
  const price = Number(payload && payload.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Gold API ${symbol}: prezzo non valido`);
  return price;
}

async function fetchExchangeRates() {
  const response = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=CHF,EUR', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Cambio: HTTP ${response.status}`);
  const payload = await response.json();
  const chf = Number(payload && payload.rates && payload.rates.CHF);
  const eur = Number(payload && payload.rates && payload.rates.EUR);
  if (!Number.isFinite(chf) || chf <= 0 || !Number.isFinite(eur) || eur <= 0) throw new Error('Cambio: risposta non valida');
  return { CHF: 1, USD: chf, EUR: chf / eur, sourceDate: payload.date || null };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Metodo non consentito' });

  const apiKey = process.env.GOLD_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Servizio dati non configurato' });

  try {
    const [goldUsd, silverUsd, platinumUsd, exchangeRates] = await Promise.all([
      fetchMetal('XAU', apiKey),
      fetchMetal('XAG', apiKey),
      fetchMetal('XPT', apiKey),
      fetchExchangeRates()
    ]);
    return res.status(200).json({
      version: 1,
      source: 'Gold API',
      timestamp: Date.now(),
      pricesUsdPerOunce: { gold: goldUsd, silver: silverUsd, platinum: platinumUsd },
      exchangeRatesChfPerUnit: exchangeRates,
      sources: { metals: 'Gold API', foreignExchange: 'Frankfurter' }
    });
  } catch (error) {
    console.error(error);
    return res.status(502).json({ error: 'Quotazioni live temporaneamente non disponibili' });
  }
}
