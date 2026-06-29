const EC_ID = process.env.EC_ID;
const EC_TOKEN = process.env.EC_TOKEN;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const TEAM_ID = process.env.TEAM_ID;

async function readData() {
  const r = await fetch(
    `https://edge-config.vercel.com/${EC_ID}/item/ht-premol?token=${EC_TOKEN}`,
    { cache: 'no-store' }
  );
  if (!r.ok) return { movimientos: [], ventas: [], vendedores: [] };
  return await r.json();
}

async function writeData(data) {
  await fetch(
    `https://api.vercel.com/v1/edge-config/${EC_ID}/items${TEAM_ID ? `?teamId=${TEAM_ID}` : ''}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ operation: 'upsert', key: 'ht-premol', value: data }] }),
    }
  );
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
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    await writeData(body);
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
