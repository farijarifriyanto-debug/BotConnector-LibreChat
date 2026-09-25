const http = require('node:http');
const { URL } = require('node:url');

const OFFICIAL_WEB_ORIGINS = Object.freeze([
  'https://app-preview.botconnector.id',
  'https://app.botconnector.id',
]);

function exactOrigin(value) {
  const candidate = String(value || '').trim();
  if (!candidate || candidate === '*') return null;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== candidate || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

function createWebServer({ coreUrl, handlers, host = '127.0.0.1', port = 18764, onShutdown = () => {}, allowedOrigins = [], development = false }) {
  const core = new URL(coreUrl);
  const clients = new Set();
  let expectedHost = `${host}:${port}`;
  let expectedOrigin = `http://${expectedHost}`;
  const additionalOrigins = Array.isArray(allowedOrigins) ? allowedOrigins : String(allowedOrigins || '').split(',');
  const configuredOrigins = new Set(OFFICIAL_WEB_ORIGINS);
  for (const candidate of additionalOrigins) {
    const origin = exactOrigin(candidate);
    if (origin) configuredOrigins.add(origin);
  }

  function isLoopbackOrigin(origin) {
    if (!origin) return false;
    try {
      const url = new URL(origin);
      return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    } catch { return false; }
  }

  function trustedOrigin(origin) {
    return origin === expectedOrigin
      || configuredOrigins.has(origin)
      || (development && isLoopbackOrigin(origin))
      || (isLoopbackOrigin(core.origin) && origin === core.origin);
  }

  function trustedRequest(req, { requireOrigin = false } = {}) {
    const remote = req.socket.remoteAddress || '';
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
    const origin = req.headers.origin;
    return loopback && req.headers.host === expectedHost
      && (!origin || trustedOrigin(origin))
      && (!requireOrigin || trustedOrigin(origin));
  }

  function json(res, statusCode, value) {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error('Ukuran permintaan melebihi batas 8 MB.');
      chunks.push(chunk);
    }
    if (!size) return {};
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Isi permintaan harus berupa objek JSON.');
    return value;
  }

  function proxy(req, res) {
    const upstream = http.request({
      hostname: core.hostname,
      port: Number(core.port || 80),
      path: `${req.url}`,
      method: req.method,
      headers: { ...req.headers, host: core.host },
    }, response => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', error => {
      if (!res.headersSent) json(res, 502, { error: { message: `Core BotConnector tidak tersedia: ${error.message}` } });
      else res.destroy(error);
    });
    req.pipe(upstream);
  }

  const server = http.createServer(async (req, res) => {
    const requestOrigin = req.headers.origin;
    if (trustedOrigin(requestOrigin)) {
      res.setHeader('access-control-allow-origin', requestOrigin);
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    let pathname;
    try { pathname = new URL(req.url, expectedOrigin).pathname; }
    catch { return json(res, 400, { error: { message: 'URL permintaan tidak valid.' } }); }

    if (pathname === '/api/botconnector/local/health' && req.method === 'GET') {
      if (!trustedRequest(req)) return json(res, 403, { error: { message: 'Origin lokal tidak diizinkan.' } });
      return json(res, 200, { available: true });
    }

    if (pathname === '/api/botconnector/local/events' && req.method === 'GET') {
      if (!trustedRequest(req)) return json(res, 403, { error: { message: 'Origin lokal tidak diizinkan.' } });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      clients.add(res);
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 20000);
      res.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
      return;
    }

    const apiPrefix = '/api/botconnector/local/';
    if (pathname === `${apiPrefix}shutdown` && req.method === 'POST') {
      if (!trustedRequest(req, { requireOrigin: true })) return json(res, 403, { error: { message: 'Permintaan API lokal tidak diizinkan.' } });
      json(res, 200, { ok: true });
      setImmediate(onShutdown);
      return;
    }
    if (pathname.startsWith(apiPrefix)) {
      if (req.method !== 'POST' || !trustedRequest(req, { requireOrigin: true })) {
        return json(res, 403, { error: { message: 'Permintaan API lokal tidak diizinkan.' } });
      }
      let action;
      try { action = decodeURIComponent(pathname.slice(apiPrefix.length)); }
      catch { return json(res, 400, { error: { message: 'Nama API lokal tidak valid.' } }); }
      const handler = handlers.get(`local:${action}`);
      if (!handler) return json(res, 404, { error: { message: 'API lokal tidak ditemukan.' } });
      try {
        const body = await readJson(req);
        const args = {
          'model-details': [body.repoId],
          'runtime-install': [body.backend],
          'download-pause': [body.id],
          'download-resume': [body.id],
          'download-cancel': [body.id],
          'model-delete': [body.directory],
          'model-run': [body.modelPath],
          'model-unload': [body.modelId],
          'profile-activate': [body.name],
          'chat-abort': [body.requestId],
      }[action] || (action === 'model-download' || action === 'chat' || action === 'catalog-search' || action === 'tool-set-enabled' || action === 'tool-execute' || action === 'mcp-register' || action === 'mcp-tool-enable' ? [body] : []);
        json(res, 200, await handler(...args));
      } catch (error) {
        json(res, 400, { error: { message: String(error?.message || error) } });
      }
      return;
    }

    if (!trustedRequest(req, { requireOrigin: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) })) {
      return json(res, 403, { error: { message: 'Origin lokal tidak diizinkan.' } });
    }
    proxy(req, res);
  });

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        expectedHost = `${host}:${server.address().port}`;
        expectedOrigin = `http://${expectedHost}`;
        resolve(server.address());
      });
    }),
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
    publish(channel, payload) {
      const frame = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const client of clients) if (!client.destroyed) client.write(frame);
    },
  };
}

module.exports = { createWebServer, OFFICIAL_WEB_ORIGINS, exactOrigin };
