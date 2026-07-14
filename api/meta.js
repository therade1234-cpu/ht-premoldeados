// api/meta.js — Trae datos REALES de Meta Ads (Facebook/Instagram).
// Requiere dos variables de entorno en Vercel (NO se ponen en el código):
//   META_TOKEN        -> token de acceso con permiso ads_read
//   META_AD_ACCOUNT   -> id de la cuenta publicitaria (act_123... o solo 123...)
// Opcional:
//   META_CONSULTA_ACTION -> tipo de acción que cuenta como "consulta"
//                           (por defecto: conversaciones de mensajería iniciadas)
// Si faltan las variables, responde { configured:false } y el tablero sigue en modo demo.

const TOKEN = process.env.META_TOKEN;
const ACCOUNT_RAW = process.env.META_AD_ACCOUNT || '';
const CONSULTA_MATCH = process.env.META_CONSULTA_ACTION || 'messaging_conversation_started';
const V = 'v21.0';
const API = 'https://graph.facebook.com/' + V;

function acct() { return ACCOUNT_RAW.indexOf('act_') === 0 ? ACCOUNT_RAW : ('act_' + ACCOUNT_RAW); }

// Cuenta como "consulta" cualquier acción cuyo tipo contenga CONSULTA_MATCH
function consultas(actions) {
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions) {
    if (a && a.action_type && a.action_type.indexOf(CONSULTA_MATCH) >= 0) n += Number(a.value) || 0;
  }
  return n;
}

function ymd(d) { return d.toISOString().slice(0, 10); }
function rangos(tipo) {
  const hoy = new Date();
  const y = hoy.getUTCFullYear(), m = hoy.getUTCMonth();
  if (tipo === 'semana') {
    const dow = (hoy.getUTCDay() + 6) % 7; // 0 = lunes
    const ini = new Date(Date.UTC(y, m, hoy.getUTCDate() - dow));
    const pIni = new Date(Date.UTC(y, m, hoy.getUTCDate() - dow - 7));
    const pFin = new Date(Date.UTC(y, m, hoy.getUTCDate() - dow - 1));
    return { since: ymd(ini), until: ymd(hoy), pSince: ymd(pIni), pUntil: ymd(pFin) };
  }
  if (tipo === 'hist') {
    return { since: '2020-01-01', until: ymd(hoy), pSince: null, pUntil: null };
  }
  const ini = new Date(Date.UTC(y, m, 1));       // mes actual
  const pIni = new Date(Date.UTC(y, m - 1, 1));   // mes anterior
  const pFin = new Date(Date.UTC(y, m, 0));
  return { since: ymd(ini), until: ymd(hoy), pSince: ymd(pIni), pUntil: ymd(pFin) };
}

function q(params) {
  return Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
}
async function gj(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'Error de Meta');
  return j;
}
async function insights(extra) {
  const url = API + '/' + acct() + '/insights?' + q(Object.assign({ access_token: TOKEN }, extra));
  return (await gj(url)).data || [];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (!TOKEN || !ACCOUNT_RAW) return res.status(200).json({ configured: false });

  try {
    let tipo = 'mes';
    try { tipo = new URL(req.url, 'http://x').searchParams.get('range') || 'mes'; } catch (e) {}
    const r = rangos(tipo);
    const tr = JSON.stringify({ since: r.since, until: r.until });

    // Totales del período
    const tot = (await insights({ level: 'account', fields: 'spend,actions', time_range: tr }))[0] || {};
    const gasto = Number(tot.spend) || 0;
    const cons = consultas(tot.actions);

    // Período anterior (para el % vs anterior)
    let gastoPrev = null, consPrev = null;
    if (r.pSince) {
      const prev = (await insights({ level: 'account', fields: 'spend,actions', time_range: JSON.stringify({ since: r.pSince, until: r.pUntil }) }))[0] || {};
      gastoPrev = Number(prev.spend) || 0; consPrev = consultas(prev.actions);
    }

    // Serie diaria (para el gráfico)
    const serie = (await insights({ level: 'account', fields: 'spend,actions', time_range: tr, time_increment: 1 }))
      .map(d => ({ fecha: d.date_start, consultas: consultas(d.actions), gasto: Number(d.spend) || 0 }));

    // Por campaña
    const campanias = (await insights({ level: 'campaign', fields: 'campaign_name,spend,actions', time_range: tr, limit: 200 }))
      .map(c => ({ nombre: c.campaign_name, consultas: consultas(c.actions), gasto: Number(c.spend) || 0 }))
      .sort((a, b) => b.consultas - a.consultas);

    // Estado de cada campaña (activa/pausada)
    try {
      const est = await gj(API + '/' + acct() + '/campaigns?fields=name,effective_status&limit=500&access_token=' + encodeURIComponent(TOKEN));
      const map = {};
      (est.data || []).forEach(c => { map[c.name] = c.effective_status === 'ACTIVE' ? 'act' : 'pau'; });
      campanias.forEach(c => { c.estado = map[c.nombre] || 'pau'; });
    } catch (e) { campanias.forEach(c => { c.estado = 'act'; }); }

    // Por anuncio = videos/creativos
    const videos = (await insights({ level: 'ad', fields: 'ad_name,spend,actions', time_range: tr, limit: 500 }))
      .map(a => ({ nombre: a.ad_name, consultas: consultas(a.actions), gasto: Number(a.spend) || 0 }))
      .filter(v => v.consultas > 0).sort((a, b) => b.consultas - a.consultas).slice(0, 10);

    // Por región (localidad)
    const localidades = (await insights({ level: 'account', fields: 'spend,actions', breakdowns: 'region', time_range: tr, limit: 100 }))
      .map(rg => ({ nombre: rg.region || 'Sin dato', consultas: consultas(rg.actions), gasto: Number(rg.spend) || 0 }))
      .sort((a, b) => b.consultas - a.consultas);

    return res.status(200).json({
      configured: true, range: tipo, since: r.since, until: r.until,
      totales: { consultas: cons, gasto, consultasPrev: consPrev, gastoPrev },
      serie, campanias, videos, localidades
    });
  } catch (e) {
    return res.status(200).json({ configured: true, error: e.message });
  }
};
