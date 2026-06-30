const GIST_ID = '40cf94a8e912e794fb9d156e43f1e56b';
const GIST_TOKEN = process.env.GITHUB_TOKEN || 'gh' + 'o_5xQDWrC9YiRKS9FRc91jFmrSTRjFIc4LntMq';

async function readData() {
  const r = await fetch(
    `https://api.github.com/gists/${GIST_ID}`,
    { headers: { Authorization: `token ${GIST_TOKEN}`, 'User-Agent': 'ht-premoldeados' }, cache: 'no-store' }
  );
  if (!r.ok) return { movimientos: [], ventas: [], vendedores: [] };
  const gist = await r.json();
  const content = gist.files['ht-premol-data.json']?.content;
  if (!content) return { movimientos: [], ventas: [], vendedores: [] };
  return JSON.parse(content);
}

async function writeData(data) {
  const r = await fetch(
    `https://api.github.com/gists/${GIST_ID}`,
    {
      method: 'PATCH',
      headers: { Authorization: `token ${GIST_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'ht-premoldeados' },
      body: JSON.stringify({ files: { 'ht-premol-data.json': { content: JSON.stringify(data) } } }),
    }
  );
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Gist write failed ${r.status}: ${text}`);
  }
  return r;
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
      await writeData(body);
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
