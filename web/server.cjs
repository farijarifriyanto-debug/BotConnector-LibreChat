const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const root = path.resolve(__dirname, '..');
const defaultWebRoot = path.join(root, 'dist', 'web');
const DEFAULT_CLIENTS = new Set(['botconnector-web', 'botconnector-web-preview']);
const publicRoutes = new Set(['/v1/models', '/api/botconnector/health']);
const authenticatedCloudRoutes = new Set([
  '/v1/chat/completions', '/v1/embeddings', '/v1/rerank',
  '/api/botconnector/web/search', '/api/botconnector/web/fetch'
]);
const tokenMeteredRoutes = new Set(['/v1/chat/completions', '/v1/embeddings', '/v1/rerank']);
const TRUSTED_HEADERS = new Set(['x-botconnector-internal-auth', 'x-botconnector-user-id', 'x-botconnector-request-id']);
const AUTH_STATE_COOKIE = '__Host-bc-auth-state';
const APP_COOKIE = '__Host-bc-app';
const AUTH_STATE_TTL_SECONDS = 600;

const headers = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:18764 http://localhost:18764; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};

function json(res, status, value, extra = {}) {
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(value));
}

function sendError(res, status, code, message, extra = {}) {
  json(res, status, { error: { code: code, message: message } }, extra);
}

function parseCookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function cookie(name, value, attributes = []) {
  return name + '=' + value + '; ' + attributes.join('; ');
}

function expireCookie(name) {
  return cookie(name, '', ['Max-Age=0', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax']);
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readSecret(filePath, optionValue) {
  if (optionValue !== undefined) {
    if (!optionValue) throw new Error('secret unavailable');
    return String(optionValue).trim();
  }
  if (!filePath) throw new Error('secret unavailable');
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    if (!value) throw new Error('secret unavailable');
    return value;
  } catch {
    throw new Error('secret unavailable');
  }
}

function configFrom(options = {}) {
  const host = options.host || process.env.BOTCONNECTOR_WEB_HOST || '127.0.0.1';
  const port = Number(options.port || process.env.BOTCONNECTOR_WEB_PORT || 8080);
  const gateway = new URL(options.gateway || process.env.BOTCONNECTOR_WEB_GATEWAY || 'http://127.0.0.1:8000');
  const appClientId = options.appClientId || process.env.BOTCONNECTOR_APP_CLIENT_ID || 'botconnector-web';
  const appOrigin = options.appOrigin || process.env.BOTCONNECTOR_APP_ORIGIN || 'https://app.botconnector.id';
  const centralLoginUrl = options.centralLoginUrl || process.env.BOTCONNECTOR_CENTRAL_LOGIN_URL || 'https://botconnector.id/app-login/start';
  return {
    host: host, port: port, gateway: gateway, webRoot: options.webRoot || defaultWebRoot,
    accountApiBase: new URL(options.accountApiBase || process.env.BOTCONNECTOR_ACCOUNT_API_BASE || 'http://127.0.0.1:8050'),
    centralLoginUrl: new URL(centralLoginUrl), appOrigin: appOrigin, appClientId: appClientId,
    accountInternalTokenFile: options.accountInternalTokenFile || process.env.BOTCONNECTOR_ACCOUNT_INTERNAL_TOKEN_FILE,
    accountInternalToken: options.accountInternalToken,
    rustBffSecretFile: options.rustBffSecretFile || process.env.BOTCONNECTOR_WEB_BFF_SECRET_FILE,
    rustBffSecret: options.rustBffSecret,
    webAuthRequired: options.webAuthRequired !== undefined ? Boolean(options.webAuthRequired) : process.env.BOTCONNECTOR_WEB_AUTH_REQUIRED === '1'
  };
}

async function centralRequest(config, endpoint, body) {
  const token = readSecret(config.accountInternalTokenFile, config.accountInternalToken);
  const target = new URL(endpoint, config.accountApiBase);
  let response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-botconnector-app-internal-token': token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw Object.assign(new Error('central unavailable'), { serviceUnavailable: true });
  }
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) throw Object.assign(new Error('central request rejected'), { status: response.status, payload: payload });
  return payload || {};
}

function stripProxyHeaders(req) {
  const result = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (TRUSTED_HEADERS.has(lower) || lower === 'cookie' || lower === 'host' || lower === 'content-length' || lower === 'connection') continue;
    result[key] = value;
  }
  return result;
}

function originAllowed(req, config) {
  if (req.headers.origin !== config.appOrigin) return false;
  if (req.headers['x-botconnector-web'] !== '1') return false;
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  return true;
}

function serveStatic(req, res, pathname, webRoot) {
  const relative = pathname === '/' || pathname === '/app/' ? 'index.html' : pathname.replace(/^\/(?:app\/)?/, '');
  const file = path.resolve(webRoot, relative || 'index.html');
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendError(res, 404, 'NOT_FOUND', 'Web asset tidak ditemukan.');
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.webmanifest') ? 'application/manifest+json' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
  res.writeHead(200, { ...headers, 'content-type': type, 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}

function proxy(req, res, config, identity = null) {
  let rustSecret;
  if (identity && config.webAuthRequired) {
    try { rustSecret = readSecret(config.rustBffSecretFile, config.rustBffSecret); } catch { return sendError(res, 503, 'AUTH_UNAVAILABLE', 'Layanan autentikasi tidak tersedia.'); }
  }
  const outbound = stripProxyHeaders(req);
  if (identity && config.webAuthRequired) {
    outbound['x-botconnector-internal-auth'] = rustSecret;
    outbound['x-botconnector-user-id'] = identity.userId;
    outbound['x-botconnector-request-id'] = crypto.randomUUID();
  }
  const transport = config.gateway.protocol === 'https:' ? https : http;
  const request = transport.request({ hostname: config.gateway.hostname, port: Number(config.gateway.port || (config.gateway.protocol === 'https:' ? 443 : 80)), path: config.gateway.pathname.replace(/\/$/, '') + req.url, method: req.method, headers: { ...outbound, host: config.gateway.host } }, upstream => {
    res.writeHead(upstream.statusCode || 502, { ...headers, ...upstream.headers });
    upstream.pipe(res);
  });
  request.on('error', () => sendError(res, 502, 'GATEWAY_UNAVAILABLE', 'Web gateway tidak tersedia.'));
  req.pipe(request);
}

function createServer(options = {}) {
  const config = configFrom(options);
  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://' + (req.headers.host || (config.host + ':' + config.port))); } catch { return sendError(res, 400, 'INVALID_URL', 'URL tidak valid.'); }
    const pathname = url.pathname;
    if (pathname.startsWith('/api/botconnector/local/')) return sendError(res, 404, 'LOCAL_ONLY', 'Local management hanya tersedia melalui Local Core.');

    if (pathname === '/api/auth/start' && req.method === 'GET') {
      const clientId = url.searchParams.get('client_id') || config.appClientId;
      if (!DEFAULT_CLIENTS.has(clientId) || clientId !== config.appClientId) return sendError(res, 400, 'INVALID_CLIENT', 'Client login tidak valid.');
      const state = crypto.randomBytes(32).toString('base64url');
      const login = new URL(config.centralLoginUrl);
      login.searchParams.set('client_id', clientId); login.searchParams.set('state', state);
      return res.writeHead(303, { ...headers, location: login.toString(), 'cache-control': 'no-store', 'set-cookie': cookie(AUTH_STATE_COOKIE, state, ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=' + AUTH_STATE_TTL_SECONDS]) }).end();
    }

    if (pathname === '/api/auth/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state'); const code = url.searchParams.get('code');
      const stateCookie = parseCookies(req.headers.cookie)[AUTH_STATE_COOKIE];
      if (!state || !code || !stateCookie || !constantTimeEqual(state, stateCookie)) return sendError(res, 400, 'AUTH_STATE_INVALID', 'Sesi login tidak valid.', { 'set-cookie': expireCookie(AUTH_STATE_COOKIE) });
      let exchanged;
      try { exchanged = await centralRequest(config, '/v1/app-auth/exchange', { code: code, state: state, client_id: config.appClientId }); }
      catch (error) { const status = error.serviceUnavailable ? 503 : (error.status === 401 || error.status === 403 ? 401 : 502); return sendError(res, status, 'AUTH_EXCHANGE_FAILED', 'Login BotConnector tidak dapat diselesaikan.', { 'set-cookie': expireCookie(AUTH_STATE_COOKIE) }); }
      const sessionToken = exchanged.session_token || exchanged.app_session_token || exchanged.app_session;
      if (!sessionToken || typeof sessionToken !== 'string' || !exchanged.user_id || !validUuid(exchanged.user_id)) return sendError(res, 502, 'AUTH_EXCHANGE_FAILED', 'Login BotConnector tidak dapat diselesaikan.', { 'set-cookie': expireCookie(AUTH_STATE_COOKIE) });
      return res.writeHead(303, { ...headers, location: '/', 'cache-control': 'no-store', 'set-cookie': [cookie(APP_COOKIE, sessionToken, ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']), expireCookie(AUTH_STATE_COOKIE)] }).end();
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const sessionToken = parseCookies(req.headers.cookie)[APP_COOKIE];
      if (!sessionToken) return json(res, 200, { authenticated: false });
      let resolved;
      try { resolved = await centralRequest(config, '/v1/app-auth/session/resolve', { session_token: sessionToken }); }
      catch (error) {
        if (error.status === 401 || error.status === 403 || error.status === 404) return json(res, 200, { authenticated: false }, { 'set-cookie': expireCookie(APP_COOKIE) });
        return sendError(res, 503, 'AUTH_UNAVAILABLE', 'Layanan autentikasi tidak tersedia.');
      }
      if (!resolved.user_id || !validUuid(resolved.user_id)) return json(res, 200, { authenticated: false }, { 'set-cookie': expireCookie(APP_COOKIE) });
      const cloud = resolved.cloud && typeof resolved.cloud === 'object' ? {
        limit_tokens_24h: Number(resolved.cloud.limit_tokens_24h || 0), used_tokens_24h: Number(resolved.cloud.used_tokens_24h || 0), remaining_tokens_24h: Number(resolved.cloud.remaining_tokens_24h || 0)
      } : undefined;
      return json(res, 200, { authenticated: true, user: { id: resolved.user_id }, ...(cloud ? { cloud: cloud } : {}) });
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      if (!originAllowed(req, config)) return sendError(res, 403, 'ORIGIN_REJECTED', 'Permintaan tidak diizinkan.');
      const sessionToken = parseCookies(req.headers.cookie)[APP_COOKIE];
      if (!sessionToken) return sendError(res, 401, 'AUTH_REQUIRED', 'Sesi tidak ditemukan.');
      try { await centralRequest(config, '/v1/app-auth/session/revoke', { session_token: sessionToken }); }
      catch { return sendError(res, 503, 'AUTH_UNAVAILABLE', 'Layanan autentikasi tidak tersedia.'); }
      return json(res, 200, { ok: true }, { 'set-cookie': expireCookie(APP_COOKIE) });
    }

    if (authenticatedCloudRoutes.has(pathname)) {
      const sessionToken = parseCookies(req.headers.cookie)[APP_COOKIE];
      if (!sessionToken) return sendError(res, 401, 'AUTH_REQUIRED', 'Masuk dengan akun BotConnector untuk menggunakan Cloud AI.');
      let resolved;
      try { resolved = await centralRequest(config, '/v1/app-auth/session/resolve', { session_token: sessionToken }); }
      catch (error) {
        if (error.status === 401 || error.status === 403 || error.status === 404) return sendError(res, 401, 'AUTH_REQUIRED', 'Masuk dengan akun BotConnector untuk menggunakan Cloud AI.');
        return sendError(res, 503, 'AUTH_UNAVAILABLE', 'Layanan autentikasi tidak tersedia.');
      }
      if (!resolved.user_id || !validUuid(resolved.user_id)) return sendError(res, 401, 'AUTH_REQUIRED', 'Masuk dengan akun BotConnector untuk menggunakan Cloud AI.');
      if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req, config)) return sendError(res, 403, 'ORIGIN_REJECTED', 'Permintaan tidak diizinkan.');
      return proxy(req, res, config, { userId: resolved.user_id });
    }

    if (publicRoutes.has(pathname)) return proxy(req, res, config, null);
    return serveStatic(req, res, pathname, config.webRoot);
  });
  server.keepAliveTimeout = 1;
  server.headersTimeout = 1000;
  return server;
}

if (require.main === module) {
  const config = configFrom();
  if (!fs.existsSync(path.join(config.webRoot, 'index.html'))) { console.error('dist/web belum ada. Jalankan npm run web:build.'); process.exit(1); }
  const server = createServer();
  server.listen(config.port, config.host, () => console.log('BotConnector Web: http://' + config.host + ':' + config.port + '/ (gateway ' + config.gateway.origin + ')'));
}

module.exports = { createServer, publicRoutes, authenticatedCloudRoutes, tokenMeteredRoutes, parseCookies, constantTimeEqual };
