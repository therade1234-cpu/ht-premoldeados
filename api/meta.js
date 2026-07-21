// api/meta.js — Trae datos REALES de Meta Ads (Facebook/Instagram).
// Requiere dos variables de entorno en Vercel (NO se ponen en el código):
//   META_TOKEN        -> token de acceso con permiso ads_read
//   META_AD_ACCOUNT   -> id(s) de cuenta(s) publicitaria(s). Acepta varias
//                        separadas por coma; los datos se suman. Ej:
//                        "act_2017632759172545,act_2019576355609020" o "2017...,2019..."
// Opcional:
//   META_CONSULTA_ACTION -> tipo de acción que cuenta como "consulta"
//                           (por defecto: conversaciones de mensajería iniciadas)
//   META_LEAD_ACTION     -> tipo de acción que cuenta como "cliente potencial" (lead)
//                           (por defecto: leads agrupados de formularios de Meta)
// Si faltan las variables, responde { configured:false } y el tablero sigue en modo demo.

const TOKEN = process.env.META_TOKEN;
const ACCOUNT_RAW = process.env.META_AD_ACCOUNT || '';
const CONSULTA_MATCH = process.env.META_CONSULTA_ACTION || 'messaging_conversation_started';
const LEAD_MATCH = process.env.META_LEAD_ACTION || 'lead_grouped';
const V = 'v21.0';
const API = 'https://graph.facebook.com/' + V;

// Lista de cuentas (soporta varias separadas por coma), normalizadas a act_...
function accts() {
  return ACCOUNT_RAW.split(',').map(s => s.trim()).filter(Boolean)
    .map(a => a.indexOf('act_') === 0 ? a : ('act_' + a));
}

function sumaAccion(actions, match) {
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions) {
    if (a && a.action_type && a.action_type.indexOf(match) >= 0) n += Number(a.value) || 0;
  }
  return n;
}
// Cuenta como "consulta" cualquier acción cuyo tipo contenga CONSULTA_MATCH
function consultas(actions) { return sumaAccion(actions, CONSULTA_MATCH); }
// Cuenta como "cliente potencial" (lead de formulario) cualquier acción cuyo tipo contenga LEAD_MATCH
function leads(actions) { return sumaAccion(actions, LEAD_MATCH); }

function ymd(d) { return d.toISOString().slice(0, 10); }
function rangos(tipo) {
  // El servidor corre en UTC; Argentina es UTC-3 (sin horario de verano).
  // Sin este ajuste, entre las 21:00 y las 23:59 hora Argentina el servidor ya "ve" el
  // día siguiente y calcula mal el inicio de la semana/mes (se corre un día).
  const hoy = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const y = hoy.getUTCFullYear(), m = hoy.getUTCMonth();
  if (tipo === 'semana') {
    // Meta Ads Manager define "Esta semana" como domingo a hoy (no lunes a hoy).
    // getUTCDay() ya devuelve 0=domingo, coincide directo con esa convención.
    const dow = hoy.getUTCDay(); // 0 = domingo
    const ini = new Date(Date.UTC(y, m, hoy.getUTCDate() - dow));
    const pIni = new Date(Date.UTC(y, m, hoy.getUTCDate() - dow - 7));
    const pFin = new Date(Date.UTC(y, m, hoy.getUTCDate() - dow - 1));
    return { since: ymd(ini), until: ymd(hoy), pSince: ymd(pIni), pUntil: ymd(pFin) };
  }
  if (tipo === 'hist') {
    // Meta solo permite mirar hasta 37 meses atrás; usamos 36 para no pasarnos.
    const ini = new Date(Date.UTC(y, m - 36, 1));
    return { since: ymd(ini), until: ymd(hoy), pSince: null, pUntil: null };
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
// Consulta el mismo insight en todas las cuentas (en paralelo) y devuelve
// las filas de todas concatenadas.
async function insights(extra) {
  const parts = await Promise.all(accts().map(a => {
    const url = API + '/' + a + '/insights?' + q(Object.assign({ access_token: TOKEN }, extra));
    return gj(url).then(j => j.data || []);
  }));
  return [].concat.apply([], parts);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (!TOKEN || !ACCOUNT_RAW) return res.status(200).json({ configured: false });

  // Suma filas por una clave (fecha, región, nombre de anuncio) juntando consultas, leads y gasto.
  function agrupar(rows, keyOf, nombreOf) {
    const map = {};
    for (const row of rows) {
      const k = keyOf(row);
      if (!map[k]) map[k] = { nombre: nombreOf(row, k), consultas: 0, leads: 0, gasto: 0 };
      map[k].consultas += consultas(row.actions);
      map[k].leads += leads(row.actions);
      map[k].gasto += Number(row.spend) || 0;
    }
    return Object.values(map);
  }

  try {
    let tipo = 'mes';
    try { tipo = new URL(req.url, 'http://x').searchParams.get('range') || 'mes'; } catch (e) {}
    const r = rangos(tipo);
    const tr = JSON.stringify({ since: r.since, until: r.until });

    // Totales del período (suma de todas las cuentas)
    const totRows = await insights({ level: 'account', fields: 'spend,actions', time_range: tr });
    const gasto = totRows.reduce((s, x) => s + (Number(x.spend) || 0), 0);
    const cons = totRows.reduce((s, x) => s + consultas(x.actions), 0);
    const leadsTot = totRows.reduce((s, x) => s + leads(x.actions), 0);

    // Diagnóstico: TODOS los tipos de acción que devolvió Meta en este período, sumados.
    // Sirve para verificar si CONSULTA_MATCH está agarrando el tipo correcto (o si falta sumar otro,
    // p.ej. mensajes que empiezan por WhatsApp en vez de Messenger).
    const accionesMap = {};
    totRows.forEach(row => (row.actions || []).forEach(a => {
      if (!a || !a.action_type) return;
      accionesMap[a.action_type] = (accionesMap[a.action_type] || 0) + (Number(a.value) || 0);
    }));
    const todasLasAcciones = Object.keys(accionesMap)
      .map(k => ({ tipo: k, valor: accionesMap[k], cuenta: k.indexOf(CONSULTA_MATCH) >= 0 }))
      .sort((a, b) => b.valor - a.valor);

    // Período anterior (para el % vs anterior)
    let gastoPrev = null, consPrev = null, leadsPrev = null;
    if (r.pSince) {
      const prev = await insights({ level: 'account', fields: 'spend,actions', time_range: JSON.stringify({ since: r.pSince, until: r.pUntil }) });
      gastoPrev = prev.reduce((s, x) => s + (Number(x.spend) || 0), 0);
      consPrev = prev.reduce((s, x) => s + consultas(x.actions), 0);
      leadsPrev = prev.reduce((s, x) => s + leads(x.actions), 0);
    }

    // Serie diaria (para el gráfico) — se agrupa por fecha sumando las cuentas
    const serie = agrupar(
      await insights({ level: 'account', fields: 'spend,actions', time_range: tr, time_increment: 1 }),
      d => d.date_start, (d, k) => k
    ).map(d => ({ fecha: d.nombre, consultas: d.consultas, leads: d.leads, gasto: d.gasto }))
      .sort((a, b) => a.fecha < b.fecha ? -1 : 1);

    // Por campaña (cada cuenta tiene campañas distintas, se concatenan)
    const campanias = (await insights({ level: 'campaign', fields: 'campaign_name,spend,actions', time_range: tr, limit: 200 }))
      .map(c => ({ nombre: c.campaign_name, consultas: consultas(c.actions), leads: leads(c.actions), gasto: Number(c.spend) || 0 }))
      .sort((a, b) => b.consultas - a.consultas);

    // Estado de cada campaña (activa/pausada) — se junta el de todas las cuentas
    try {
      const listas = await Promise.all(accts().map(a =>
        gj(API + '/' + a + '/campaigns?fields=name,effective_status&limit=500&access_token=' + encodeURIComponent(TOKEN))
          .then(j => j.data || []).catch(() => [])
      ));
      const map = {};
      [].concat.apply([], listas).forEach(c => { map[c.name] = c.effective_status === 'ACTIVE' ? 'act' : 'pau'; });
      campanias.forEach(c => { c.estado = map[c.nombre] || 'pau'; });
    } catch (e) { campanias.forEach(c => { c.estado = 'act'; }); }

    // Por anuncio = videos/creativos (se agrupan por nombre sumando cuentas)
    const videos = agrupar(
      await insights({ level: 'ad', fields: 'ad_name,spend,actions', time_range: tr, limit: 500 }),
      a => a.ad_name || 'Sin nombre', (a, k) => k
    ).filter(v => v.consultas > 0).sort((a, b) => b.consultas - a.consultas).slice(0, 40);

    // Por región (localidad) — se agrupa por región sumando cuentas
    const localidades = agrupar(
      await insights({ level: 'account', fields: 'spend,actions', breakdowns: 'region', time_range: tr, limit: 100 }),
      rg => rg.region || 'Sin dato', (rg, k) => k
    ).sort((a, b) => b.consultas - a.consultas);

    // Historial diario por anuncio + campaña + ciudad (para la pestaña "Historial")
    let historial = [];
    try {
      historial = (await insights({
        level: 'ad', fields: 'campaign_name,ad_name,spend,actions', breakdowns: 'region',
        time_range: tr, time_increment: 1, limit: 1000,
      })).map(h => ({
        fecha: h.date_start, campana: h.campaign_name, anuncio: h.ad_name,
        ciudad: h.region || 'Sin dato', consultas: consultas(h.actions), leads: leads(h.actions), gasto: Number(h.spend) || 0,
      })).sort((a, b) => b.fecha.localeCompare(a.fecha));
    } catch (e) { historial = []; }

    // Diagnóstico: qué cuentas está sumando el sistema ahora mismo (nombre, no el token).
    // Sirve para comparar contra el selector de cuentas de Meta Ads Manager y detectar
    // si falta alguna cuenta cargada en la variable de entorno META_AD_ACCOUNT.
    let cuentas = [];
    try {
      cuentas = await Promise.all(accts().map(a =>
        gj(API + '/' + a + '?fields=name,account_status&access_token=' + encodeURIComponent(TOKEN))
          .then(j => ({ id: a, nombre: j.name || '(sin nombre)', activa: j.account_status === 1 }))
          .catch(() => ({ id: a, nombre: '(no se pudo consultar)', activa: null }))
      ));
    } catch (e) { cuentas = accts().map(a => ({ id: a, nombre: '(no se pudo consultar)', activa: null })); }

    return res.status(200).json({
      configured: true, range: tipo, since: r.since, until: r.until,
      totales: { consultas: cons, gasto, consultasPrev: consPrev, gastoPrev, leads: leadsTot, leadsPrev },
      serie, campanias, videos, localidades, historial, cuentas, todasLasAcciones
    });
  } catch (e) {
    return res.status(200).json({ configured: true, error: e.message });
  }
};
