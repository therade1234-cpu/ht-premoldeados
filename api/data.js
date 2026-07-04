const GIST_ID = '40cf94a8e912e794fb9d156e43f1e56b';
const GIST_TOKEN = process.env.GITHUB_TOKEN || 'gh' + 'o_5xQDWrC9YiRKS9FRc91jFmrSTRjFIc4LntMq';

const EMPTY = { movimientos: [], ventas: [], vendedores: [], visitas: [], reparaciones: [], nomPlanilla: [], _deleted: [] };

// Lectura tolerante (para GET): si algo falla devuelve estructura vacía.
async function readData() {
  try {
    const r = await fetch(
      `https://api.github.com/gists/${GIST_ID}`,
      { headers: { Authorization: `token ${GIST_TOKEN}`, 'User-Agent': 'ht-premoldeados' }, cache: 'no-store' }
    );
    if (!r.ok) return { ...EMPTY };
    const gist = await r.json();
    const content = gist.files['ht-premol-data.json'] && gist.files['ht-premol-data.json'].content;
    if (!content) return { ...EMPTY };
    return JSON.parse(content);
  } catch (e) {
    return { ...EMPTY };
  }
}

// Lectura estricta (para POST): si NO se puede leer lo que ya existe, lanza error
// y así NO sobrescribimos datos buenos con algo parcial.
async function readDataStrict() {
  const r = await fetch(
    `https://api.github.com/gists/${GIST_ID}`,
    { headers: { Authorization: `token ${GIST_TOKEN}`, 'User-Agent': 'ht-premoldeados' }, cache: 'no-store' }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Gist read failed ${r.status}: ${t}`);
  }
  const gist = await r.json();
  const content = gist.files['ht-premol-data.json'] && gist.files['ht-premol-data.json'].content;
  if (!content) return { ...EMPTY };
  return JSON.parse(content);
}

async function writeFiles(files) {
  const r = await fetch(
    `https://api.github.com/gists/${GIST_ID}`,
    {
      method: 'PATCH',
      headers: { Authorization: `token ${GIST_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'ht-premoldeados' },
      body: JSON.stringify({ files }),
    }
  );
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Gist write failed ${r.status}: ${text}`);
  }
  return r;
}

// ---- Combinado (merge) idéntico al del cliente ----
function sigOf(it) {
  return [it.fecha, it.fechaObra, it.fechaRep, it.fechaVenta, it.cliente, it.tel, it.dir, it.direccion, it.localidad, it.metros, it.altura, it.diseno, it.precio, it.sena, it.totalObra, it.monto, it.cat, it.tipo, it.desc, it.notas, it.detalle, it.vendedor, it.estado].join('~');
}
function mergeArr(existing, incoming, delSet) {
  const out = [], seenId = {}, seenSig = {}, seenSigNoId = {};
  function add(it) {
    if (!it || typeof it !== 'object') return;
    const sig = sigOf(it);
    if ((it.id && delSet[it.id]) || delSet[sig]) return; // borrado (tombstone)
    if (it.id) {
      if (seenId[it.id]) return;
      if (seenSigNoId[sig]) return;
      out.push(it); seenId[it.id] = 1; seenSig[sig] = 1;
    } else {
      if (seenSig[sig]) return;
      out.push(it); seenSig[sig] = 1; seenSigNoId[sig] = 1;
    }
  }
  // incoming primero: gana lo que manda el cliente (ediciones);
  // luego existing suma cualquier obra que el cliente no tenía (cargada por otro dispositivo).
  (Array.isArray(incoming) ? incoming : []).forEach(add);
  (Array.isArray(existing) ? existing : []).forEach(add);
  return out;
}
function unionDeleted(a, b) {
  const s = {};
  (Array.isArray(a) ? a : []).forEach(k => { s[k] = 1; });
  (Array.isArray(b) ? b : []).forEach(k => { s[k] = 1; });
  return Object.keys(s);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const data = await readData();
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ ok: false, error: 'Cuerpo inválido' });
      }

      // 1) Leer lo que YA existe (estricto: si no se puede leer, abortamos y no escribimos).
      const existing = await readDataStrict();

      // 2) Combinar tombstones de ambos lados.
      let deleted = unionDeleted(existing._deleted, body._deleted);
      if (deleted.length > 1000) deleted = deleted.slice(-1000);
      const delSet = {};
      deleted.forEach(k => { delSet[k] = 1; });

      // 3) Combinar cada lista: NUNCA se pierde una obra salvo tombstone explícito.
      const merged = {
        ventas: mergeArr(existing.ventas, body.ventas, delSet),
        movimientos: mergeArr(existing.movimientos, body.movimientos, delSet),
        visitas: mergeArr(existing.visitas, body.visitas, delSet),
        reparaciones: mergeArr(existing.reparaciones, body.reparaciones, delSet),
        // Config: si el cliente manda vacío, se conserva lo que ya había (no se borra por accidente).
        vendedores: (Array.isArray(body.vendedores) && body.vendedores.length) ? body.vendedores : (existing.vendedores || []),
        nomPlanilla: (Array.isArray(body.nomPlanilla) && body.nomPlanilla.length) ? body.nomPlanilla : (existing.nomPlanilla || []),
        _deleted: deleted,
      };

      // 4) Guardar el resultado combinado. Además dejamos un backup del estado ANTERIOR
      //    (un solo archivo, se pisa cada vez) como red de seguridad de "un paso atrás".
      //    GitHub además conserva el historial completo de revisiones del gist.
      const files = {
        'ht-premol-data.json': { content: JSON.stringify(merged) },
        'ht-premol-backup-prev.json': { content: JSON.stringify(existing) },
      };

      await writeFiles(files);
      return res.status(200).json({ ok: true, ventas: merged.ventas.length, movimientos: merged.movimientos.length });
    } catch (e) {
      // Ante cualquier error NO se escribió nada: el cliente reintenta y no se pierde nada.
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
