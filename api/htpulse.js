// api/htpulse.js (v2) — Proxy seguro hacia la API externa (getMetaAdsSummary).
// La clave NUNCA se expone al navegador: vive solo en variables de entorno de Vercel.
//   HTPULSE_API_KEY  (o, si ya la tenías con ese nombre, EXTERNAL_API_KEY)
// Si la variable no está configurada, responde { configured:false } y el tablero
// sigue mostrando datos de ejemplo — no rompe nada.

const crypto = require('crypto');

const API_KEY = process.env.HTPULSE_API_KEY || process.env.EXTERNAL_API_KEY;
const ENDPOINT = 'https://ht-pulse-ads.base44.app/api/functions/getMetaAdsSummary';

function firmar(timestamp, body) {
  return crypto.createHmac('sha256', API_KEY).update(`${timestamp}.${body}`).digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (!API_KEY) return res.status(200).json({ configured: false });

  try {
    let periodo = 'month';
    try { periodo = new URL(req.url, 'http://x').searchParams.get('period') || 'month'; } catch (e) {}

    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ period: periodo });
    const signature = firmar(timestamp, body);

    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-timestamp': timestamp,
        'x-api-signature': signature,
      },
      body,
    });

    if (!r.ok) {
      const texto = await r.text();
      return res.status(200).json({ configured: true, error: `HT Pulse respondió ${r.status}: ${texto.slice(0, 300)}` });
    }

    const data = await r.json();
    return res.status(200).json({ configured: true, data });
  } catch (e) {
    return res.status(200).json({ configured: true, error: e.message });
  }
};
