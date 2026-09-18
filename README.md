# Portafoglio Assets — servizio dati storico

Funzione serverless per proteggere la chiave Gold API e fornire all'app soltanto gli intervalli autorizzati.

Variabile riservata richiesta su Vercel: `GOLD_API_KEY`.

Endpoint pubblico dei grafici: `/api/market-history?period=24h|7d|30d|90d|1y|all`.

Consultazione puntuale: `/api/market-history?date=YYYY-MM-DD&metal=gold|silver|platinum`. Restituisce la quotazione media reale del giorno scelto per il metallo, con conversione automatica USD/EUR/CHF anche per le date antecedenti al 1999.

La chiave non deve essere inserita nell'HTML, nel repository pubblico o nel bundle Android.

## Quotazioni correnti coerenti

Endpoint pubblico: `/api/market-current`.

Restituisce, in una sola risposta senza cache, i prezzi correnti XAU, XAG e XPT in USD/oncia e i cambi CHF per USD ed EUR. Il browser e l'app Android non combinano più fonti o valori memorizzati localmente: applicano il pacchetto solo se completo.

Anche questo endpoint usa esclusivamente la variabile riservata `GOLD_API_KEY` sul server.
