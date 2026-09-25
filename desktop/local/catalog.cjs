const hf = require('./hf.cjs');

const DEFAULT_CATALOG_URL = 'https://botconnector.id';
const USER_AGENT = 'BotConnector-AIChat/0.2';

function catalogRoot() {
  const value = process.env.BOTCONNECTOR_CATALOG_URL || DEFAULT_CATALOG_URL;
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('Katalog BotConnector harus menggunakan HTTPS.');
  }
  return url.origin;
}

async function searchCatalog({ query = '', cursor = '', limit = 100 } = {}) {
  const url = new URL('/api/hf/search', catalogRoot());
  const q = String(query).trim().slice(0, 180);
  if (q) url.searchParams.set('q', q);
  if (cursor) url.searchParams.set('cursor', String(cursor).slice(0, 2048));
  url.searchParams.set('limit', String(Math.min(100, Math.max(10, Number(limit) || 100))));
  url.searchParams.set('sort', q ? 'downloads' : 'trending_score');

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(25000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Katalog BotConnector mengembalikan HTTP ${response.status}.`);
  }
  return {
    models: Array.isArray(payload.models) ? payload.models : [],
    nextCursor: typeof payload.nextCursor === 'string' ? payload.nextCursor : '',
    source: catalogRoot(),
  };
}

async function modelDetails(repoId, hardware) {
  if (typeof repoId !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoId)) {
    throw new Error('ID model Hugging Face tidak valid.');
  }
  return hf.modelDetails({ id: repoId, hardware, token: process.env.HF_TOKEN || '' });
}

module.exports = { DEFAULT_CATALOG_URL, searchCatalog, modelDetails, catalogRoot };
