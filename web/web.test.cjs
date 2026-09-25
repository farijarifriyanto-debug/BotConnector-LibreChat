const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { main, output } = require('./build.cjs');
const { publicRoutes } = require('./server.cjs');
const { createServer } = require('./server.cjs');
const http = require('node:http');

async function listenMock(handler) {
  const server = http.createServer((req, res) => { res.setHeader('connection', 'close'); handler(req, res); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function closeMock(server) {
  if (server.closeIdleConnections) server.closeIdleConnections();
  if (server.closeAllConnections) server.closeAllConnections();
  if (server.unref) server.unref();
  await Promise.race([
    new Promise(resolve => server.close(() => resolve())),
    new Promise(resolve => setTimeout(resolve, 100))
  ]);
}

function cookieValue(response, name) {
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : (response.headers.get('set-cookie') || '').split(/,(?=\s*[^;,]+=)/);
  const row = cookies.find(value => value.startsWith(`${name}=`));
  return row ? row.slice(name.length + 1).split(';', 1)[0] : '';
}

test.after(() => {
  for (const handle of process._getActiveHandles()) {
    if (handle && typeof handle.unref === 'function') handle.unref();
  }
});

test('web build contains a static PWA shell without desktop dependencies', async () => {
  await main();
  assert.ok(fs.existsSync(path.join(output, 'manifest.webmanifest')));
  assert.ok(fs.existsSync(path.join(output, 'sw.js')));
  const files = fs.readdirSync(output).join(' ');
  assert.doesNotMatch(files, /desktop|electron/i);
  const bundle = fs.readFileSync(path.join(output, 'app.js'), 'utf8');
  assert.doesNotMatch(bundle, /child_process|OPENAI_API_KEY|EXA_API_KEY|OLLAMA_API_KEY|BOTCONNECTOR_EXA_API_KEY/i);
});

test('web shell cache version advances so existing service workers refresh changed assets', async () => {
  await main();
  const serviceWorker = fs.readFileSync(path.join(output, 'sw.js'), 'utf8');
  assert.match(serviceWorker, /botconnector-web-shell-v6/);
});

test('normal web search UI uses provider-neutral wording', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'assets', 'botconnector', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'assets', 'botconnector', 'index.html'), 'utf8');
  assert.equal((`${app}\n${html}`.match(/exa/gi) || []).length, 0);
});

test('public web gateway route allowlist excludes local management', () => {
  const { authenticatedCloudRoutes } = require('./server.cjs');
  assert.equal(publicRoutes.has('/v1/chat/completions'), false);
  assert.equal(authenticatedCloudRoutes.has('/v1/chat/completions'), true);
  assert.equal(publicRoutes.has('/api/botconnector/local/installed'), false);
});

test('web server serves a shell and never exposes local management routes', async () => {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  try {
    const shell = await fetch(`http://127.0.0.1:${address.port}/app/`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-security-policy') || '', /default-src/);
    const local = await fetch(`http://127.0.0.1:${address.port}/api/botconnector/local/installed`);
    assert.equal(local.status, 404);
  } finally { await closeMock(server); }
});

test('Task 5 auth start and callback use host-only cookies and clean redirect', async () => {
  const calls = [];
  const account = await listenMock((req, res) => {
    const call = { path: req.url, method: req.method, headers: req.headers, body: null };
    calls.push(call);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      call.body = body;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/app-auth/exchange') res.end(JSON.stringify({ user_id: '11111111-1111-4111-8111-111111111111', session_token: 'opaque-session' }));
      else res.end(JSON.stringify({ authenticated: false }));
    });
  });
  const app = createServer({ accountApiBase: account.url, centralLoginUrl: 'https://central.example/app-login/start', appOrigin: 'http://127.0.0.1', appClientId: 'botconnector-web', accountInternalToken: 'dummy-account', gateway: 'http://127.0.0.1:9' });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const start = await fetch(`${base}/api/auth/start`, { redirect: 'manual' });
    assert.equal(start.status, 303);
    assert.match(start.headers.get('location'), /^https:\/\/central\.example\/app-login\/start\?client_id=botconnector-web&state=/);
    const stateCookie = start.headers.get('set-cookie');
    assert.match(stateCookie, /^__Host-bc-auth-state=[^;]+/);
    assert.match(stateCookie, /Secure/); assert.match(stateCookie, /HttpOnly/); assert.match(stateCookie, /SameSite=Lax/); assert.match(stateCookie, /Path=\//); assert.doesNotMatch(stateCookie, /Domain=/i);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await fetch(`${base}/api/auth/callback?code=one-time&state=${encodeURIComponent(state)}`, { headers: { cookie: `__Host-bc-auth-state=${cookieValue(start, '__Host-bc-auth-state')}` }, redirect: 'manual' });
    assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/');
    const appCookie = callback.headers.get('set-cookie');
    assert.match(appCookie, /__Host-bc-app=opaque-session/); assert.match(appCookie, /Secure/); assert.match(appCookie, /HttpOnly/); assert.match(appCookie, /SameSite=Lax/); assert.match(appCookie, /Path=\//); assert.doesNotMatch(appCookie, /Domain=/i);
    const exchange = calls.find(call => call.path === '/v1/app-auth/exchange');
    assert.ok(exchange);
    const exchangeBody = JSON.parse(exchange.body);
    assert.equal(exchangeBody.client_id, 'botconnector-web');
    assert.equal(Object.prototype.hasOwnProperty.call(exchangeBody, 'callback_url'), false);
  } finally { await closeMock(app); await closeMock(account.server); }
});

test('Task 5 gates cloud routes and injects trusted identity headers', async () => {
  let gatewayCalls = 0; let received;
  const account = await listenMock((req, res) => {
    if (req.url === '/v1/app-auth/session/resolve') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ user_id: '22222222-2222-4222-8222-222222222222', cloud: { limit_tokens_24h: 100000, used_tokens_24h: 0, remaining_tokens_24h: 100000 } }));
    }
    res.statusCode = 404; res.end();
  });
  const gateway = await listenMock((req, res) => { gatewayCalls += 1; received = req.headers; res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  const app = createServer({ accountApiBase: account.url, gateway: gateway.url, appOrigin: 'http://127.0.0.1', accountInternalToken: 'dummy-account', rustBffSecret: 'dummy-rust', webAuthRequired: true });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const anon = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(anon.status, 401); assert.equal(gatewayCalls, 0);
    const ok = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', cookie: '__Host-bc-app=opaque-session', origin: 'http://127.0.0.1', 'x-botconnector-web': '1', 'x-botconnector-user-id': 'forged', 'x-botconnector-internal-auth': 'forged', 'x-botconnector-request-id': 'forged' } });
    assert.equal(ok.status, 200); assert.equal(gatewayCalls, 1);
    assert.equal(received['x-botconnector-user-id'], '22222222-2222-4222-8222-222222222222'); assert.equal(received['x-botconnector-internal-auth'], 'dummy-rust'); assert.notEqual(received['x-botconnector-request-id'], 'forged');
  } finally { await closeMock(app); await closeMock(account.server); }
});

test('Task 5 auth me and logout use server-side session APIs', async () => {
  const calls = [];
  const account = await listenMock((req, res) => { calls.push(req.url); res.setHeader('content-type', 'application/json'); if (req.url.includes('resolve')) res.end(JSON.stringify({ user_id: '33333333-3333-4333-8333-333333333333', cloud: { limit_tokens_24h: 100000, used_tokens_24h: 10, remaining_tokens_24h: 99990 } })); else res.end('{}'); });
  const app = createServer({ accountApiBase: account.url, appOrigin: 'http://127.0.0.1', accountInternalToken: 'dummy-account' });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: '__Host-bc-app=opaque-session' } });
    const meBody = await me.json();
    assert.deepEqual(meBody, { authenticated: true, user: { id: '33333333-3333-4333-8333-333333333333' }, cloud: { limit_tokens_24h: 100000, used_tokens_24h: 10, remaining_tokens_24h: 99990 } });
    assert.doesNotMatch(JSON.stringify(meBody), /dummy|opaque-session/);
    const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: '__Host-bc-app=opaque-session', origin: 'http://127.0.0.1', 'x-botconnector-web': '1' } });
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /__Host-bc-app=;/); assert.ok(calls.some(url => url.includes('revoke'))); assert.equal(calls.some(url => url.includes('/logout')), false);
  } finally { await closeMock(app); await closeMock(account.server); }
});

test('Task 5 rejects missing or mismatched callback state and generates fresh state', async () => {
  const account = await listenMock((req, res) => { res.statusCode = 500; res.end(); });
  const app = createServer({ accountApiBase: account.url, centralLoginUrl: 'https://central.example/app-login/start', appOrigin: 'http://127.0.0.1', appClientId: 'botconnector-web', accountInternalToken: 'dummy-account' });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const first = await fetch(`${base}/api/auth/start`, { redirect: 'manual' });
    const second = await fetch(`${base}/api/auth/start`, { redirect: 'manual' });
    const firstState = new URL(first.headers.get('location')).searchParams.get('state');
    const secondState = new URL(second.headers.get('location')).searchParams.get('state');
    assert.notEqual(firstState, secondState);
    const missing = await fetch(`${base}/api/auth/callback?code=c`, { redirect: 'manual' });
    assert.equal(missing.status, 400);
    const missingCookie = await fetch(`${base}/api/auth/callback?code=c&state=${firstState}`, { redirect: 'manual' });
    assert.equal(missingCookie.status, 400);
    const mismatch = await fetch(`${base}/api/auth/callback?code=c&state=${firstState}`, { headers: { cookie: '__Host-bc-auth-state=wrong' }, redirect: 'manual' });
    assert.equal(mismatch.status, 400);
  } finally { await closeMock(app); await closeMock(account.server); }
});

test('Task 5 anonymous me is stable and protected resolution failures never call Rust', async () => {
  let gatewayCalls = 0;
  const account = await listenMock((req, res) => { res.statusCode = 500; res.end('{"error":"unavailable"}'); });
  const gateway = await listenMock((req, res) => { gatewayCalls += 1; res.end('{}'); });
  const app = createServer({ accountApiBase: account.url, gateway: gateway.url, appOrigin: 'http://127.0.0.1', accountInternalToken: 'dummy-account' });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const anonymous = await fetch(`${base}/api/auth/me`);
    assert.deepEqual(await anonymous.json(), { authenticated: false });
    const failed = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}', headers: { cookie: '__Host-bc-app=opaque-session', origin: 'http://127.0.0.1', 'x-botconnector-web': '1' } });
    assert.equal(failed.status, 503); assert.equal(gatewayCalls, 0);
  } finally { await closeMock(app); await closeMock(account.server); await closeMock(gateway.server); }
});

test('Task 5 authenticates every Cloud route while public proxy strips forged headers', async () => {
  const seen = []; let resolveCalls = 0;
  const account = await listenMock((req, res) => { resolveCalls += 1; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ user_id: '44444444-4444-4444-8444-444444444444', cloud: { limit_tokens_24h: 100000, used_tokens_24h: 0, remaining_tokens_24h: 100000 } })); });
  const gateway = await listenMock((req, res) => { seen.push({ path: req.url, headers: req.headers }); res.setHeader('content-type', 'application/json'); res.end('{}'); });
  const app = createServer({ accountApiBase: account.url, gateway: gateway.url, appOrigin: 'http://127.0.0.1', accountInternalToken: 'dummy-account', rustBffSecret: 'dummy-rust', webAuthRequired: true });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    for (const route of ['/v1/embeddings', '/v1/rerank', '/api/botconnector/web/search', '/api/botconnector/web/fetch']) {
      const response = await fetch(base + route, { method: 'POST', body: '{}', headers: { cookie: '__Host-bc-app=opaque-session', origin: 'http://127.0.0.1', 'x-botconnector-web': '1' } });
      assert.equal(response.status, 200);
    }
    const publicResponse = await fetch(`${base}/v1/models`, { headers: { 'x-botconnector-user-id': 'forged', 'x-botconnector-internal-auth': 'forged', 'x-botconnector-request-id': 'forged' } });
    assert.equal(publicResponse.status, 200);
    const publicCall = seen.find(call => call.path === '/v1/models');
    assert.ok(publicCall); assert.equal(publicCall.headers['x-botconnector-user-id'], undefined); assert.equal(publicCall.headers['x-botconnector-internal-auth'], undefined); assert.equal(publicCall.headers['x-botconnector-request-id'], undefined);
    assert.equal(resolveCalls, 4);
  } finally { await closeMock(app); await closeMock(account.server); await closeMock(gateway.server); }
});

test('Task 5 rejects mutation origin/CSRF failures before Rust and accepts same-origin mutation', async () => {
  let gatewayCalls = 0;
  const account = await listenMock((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ user_id: '55555555-5555-4555-8555-555555555555' })); });
  const gateway = await listenMock((req, res) => { gatewayCalls += 1; res.end('{}'); });
  const app = createServer({ accountApiBase: account.url, gateway: gateway.url, appOrigin: 'http://127.0.0.1', accountInternalToken: 'dummy-account', rustBffSecret: 'dummy-rust', webAuthRequired: true });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const common = { method: 'POST', body: '{}', headers: { cookie: '__Host-bc-app=opaque-session' } };
  try {
    assert.equal((await fetch(`${base}/v1/chat/completions`, { ...common, headers: { ...common.headers, origin: 'http://evil.example', 'x-botconnector-web': '1' } })).status, 403);
    assert.equal((await fetch(`${base}/v1/chat/completions`, { ...common, headers: { ...common.headers, origin: 'http://127.0.0.1' } })).status, 403);
    assert.equal((await fetch(`${base}/v1/chat/completions`, { ...common, headers: { ...common.headers, origin: 'http://127.0.0.1', 'x-botconnector-web': '1', 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal(gatewayCalls, 0);
    assert.equal((await fetch(`${base}/v1/chat/completions`, { ...common, headers: { ...common.headers, origin: 'http://127.0.0.1', 'x-botconnector-web': '1' } })).status, 200);
    assert.equal(gatewayCalls, 1);
  } finally { await closeMock(app); await closeMock(account.server); await closeMock(gateway.server); }
});

test('Task 5 protected operations fail closed when configured secrets are absent', async () => {
  let gatewayCalls = 0;
  const account = await listenMock((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ user_id: '66666666-6666-4666-8666-666666666666' })); });
  const gateway = await listenMock((req, res) => { gatewayCalls += 1; res.end('{}'); });
  const missing = path.join(require('node:os').tmpdir(), 'botconnector-task5-missing-secret');
  const app = createServer({ accountApiBase: account.url, gateway: gateway.url, appOrigin: 'http://127.0.0.1', accountInternalTokenFile: missing, webAuthRequired: true });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const logs = [];
  const originalConsole = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: '__Host-bc-app=opaque-session' } });
    assert.equal(me.status, 503); assert.doesNotMatch(await me.text(), /missing-secret|dummy/);
  } finally { console.error = originalConsole.error; console.warn = originalConsole.warn; console.log = originalConsole.log; await closeMock(app); }
  assert.doesNotMatch(logs.join('\n'), /dummy|missing-secret/);
  const app2 = createServer({ accountApiBase: account.url, gateway: gateway.url, appOrigin: 'http://127.0.0.1', accountInternalToken: 'dummy-account', webAuthRequired: true });
  await new Promise((resolve, reject) => { app2.once('error', reject); app2.listen(0, '127.0.0.1', resolve); });
  try {
    const response = await fetch(`http://127.0.0.1:${app2.address().port}/v1/chat/completions`, { method: 'POST', body: '{}', headers: { cookie: '__Host-bc-app=opaque-session', origin: 'http://127.0.0.1', 'x-botconnector-web': '1' } });
    assert.equal(response.status, 503); assert.equal(gatewayCalls, 0); assert.doesNotMatch(await response.text(), /dummy/);
  } finally { await closeMock(app2); await closeMock(account.server); await closeMock(gateway.server); }
});

test('Task 5 invalid app session is rejected before Rust', async () => {
  let gatewayCalls = 0;
  const account = await listenMock((req, res) => { res.statusCode = 401; res.end('{}'); });
  const gateway = await listenMock((req, res) => { gatewayCalls += 1; res.end('{}'); });
  const app = createServer({ accountApiBase: account.url, gateway: gateway.url, appOrigin: 'http://127.0.0.1', accountInternalToken: 'dummy-account' });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/chat/completions`, { method: 'POST', body: '{}', headers: { cookie: '__Host-bc-app=expired', origin: 'http://127.0.0.1', 'x-botconnector-web': '1' } });
    assert.equal(response.status, 401); assert.equal(gatewayCalls, 0);
  } finally { await closeMock(app); await closeMock(account.server); await closeMock(gateway.server); }
});

test('Task 8 search and fetch require auth, strip forged headers, and never call quota', async () => {
  const accountCalls = [];
  const account = await listenMock((req, res) => {
    accountCalls.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/app-auth/session/resolve') {
      res.end(JSON.stringify({ user_id: '88888888-8888-4888-8888-888888888888' }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  const gatewayCalls = [];
  const gateway = await listenMock((req, res) => {
    gatewayCalls.push({ path: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  const app = createServer({ accountApiBase: account.url, gateway: gateway.url, appOrigin: 'http://127.0.0.1', accountInternalToken: 'dummy-account', rustBffSecret: 'dummy-rust', webAuthRequired: true });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    for (const route of ['/api/botconnector/web/search', '/api/botconnector/web/fetch']) {
      const wrongOrigin = await fetch(base + route, {
        method: 'POST', body: '{}', headers: { cookie: '__Host-bc-app=opaque-session', origin: 'http://evil.example', 'x-botconnector-web': '1' }
      });
      assert.equal(wrongOrigin.status, 403);
      const missingWebHeader = await fetch(base + route, {
        method: 'POST', body: '{}', headers: { cookie: '__Host-bc-app=opaque-session', origin: 'http://127.0.0.1' }
      });
      assert.equal(missingWebHeader.status, 403);
      const response = await fetch(base + route, {
        method: 'POST', body: '{}', headers: {
          cookie: '__Host-bc-app=opaque-session', origin: 'http://127.0.0.1', 'x-botconnector-web': '1',
          'x-botconnector-internal-auth': 'forged', 'x-botconnector-user-id': 'forged', 'x-botconnector-request-id': 'forged'
        }
      });
      assert.equal(response.status, 200);
    }
    assert.equal(gatewayCalls.length, 2);
    for (const call of gatewayCalls) {
      assert.equal(call.headers['x-botconnector-user-id'], '88888888-8888-4888-8888-888888888888');
      assert.equal(call.headers['x-botconnector-internal-auth'], 'dummy-rust');
      assert.match(call.headers['x-botconnector-request-id'], /^[0-9a-f-]{36}$/i);
      assert.notEqual(call.headers['x-botconnector-request-id'], 'forged');
    }
    assert.equal(accountCalls.filter(path => path.includes('/v1/cloud-quota/')).length, 0);
  } finally { await closeMock(app); await closeMock(account.server); await closeMock(gateway.server); }
});

test('Task 8 anonymous and invalid-session search/fetch stop before provider operation', async () => {
  let resolveCalls = 0;
  let gatewayCalls = 0;
  const account = await listenMock((req, res) => {
    if (req.url === '/v1/app-auth/session/resolve') resolveCalls += 1;
    res.statusCode = 401;
    res.end('{}');
  });
  const gateway = await listenMock((req, res) => { gatewayCalls += 1; res.end('{}'); });
  const app = createServer({ accountApiBase: account.url, gateway: gateway.url, appOrigin: 'http://127.0.0.1', accountInternalToken: 'dummy-account', rustBffSecret: 'dummy-rust', webAuthRequired: true });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    for (const route of ['/api/botconnector/web/search', '/api/botconnector/web/fetch']) {
      const anonymous = await fetch(base + route, { method: 'POST', body: '{}', headers: { origin: 'http://127.0.0.1', 'x-botconnector-web': '1' } });
      assert.equal(anonymous.status, 401);
      const invalid = await fetch(base + route, { method: 'POST', body: '{}', headers: { cookie: '__Host-bc-app=expired', origin: 'http://127.0.0.1', 'x-botconnector-web': '1' } });
      assert.equal(invalid.status, 401);
    }
    assert.equal(resolveCalls, 2);
    assert.equal(gatewayCalls, 0);
  } finally { await closeMock(app); await closeMock(account.server); await closeMock(gateway.server); }
});

test('Task 5 callback state survives BFF process replacement without a server-side map', async () => {
  const account = await listenMock((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ user_id: '77777777-7777-4777-8777-777777777777', session_token: 'opaque-session' })); });
  const first = createServer({ accountApiBase: account.url, centralLoginUrl: 'https://central.example/app-login/start', appOrigin: 'http://127.0.0.1', appClientId: 'botconnector-web', accountInternalToken: 'dummy-account' });
  await new Promise((resolve, reject) => { first.once('error', reject); first.listen(0, '127.0.0.1', resolve); });
  const firstResponse = await fetch(`http://127.0.0.1:${first.address().port}/api/auth/start`, { redirect: 'manual' });
  const state = new URL(firstResponse.headers.get('location')).searchParams.get('state');
  const stateValue = cookieValue(firstResponse, '__Host-bc-auth-state');
  await closeMock(first);
  const second = createServer({ accountApiBase: account.url, centralLoginUrl: 'https://central.example/app-login/start', appOrigin: 'http://127.0.0.1', appClientId: 'botconnector-web', accountInternalToken: 'dummy-account' });
  await new Promise((resolve, reject) => { second.once('error', reject); second.listen(0, '127.0.0.1', resolve); });
  try {
    const callback = await fetch(`http://127.0.0.1:${second.address().port}/api/auth/callback?code=one-time&state=${state}`, { headers: { cookie: `__Host-bc-auth-state=${stateValue}` }, redirect: 'manual' });
    assert.equal(callback.status, 303);
  } finally { await closeMock(second); await closeMock(account.server); }
});

test('Task 7 Web UI bootstraps auth, gates Cloud, and keeps Local anonymous', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'assets', 'botconnector', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'assets', 'botconnector', 'index.html'), 'utf8');
  assert.match(app, /fetch\('\/api\/auth\/me'/);
  assert.match(app, /saveCloudRecovery\(text, modelSelect\.value\)/);
  assert.match(app, /AUTH_REQUIRED_COPY/);
  assert.match(app, /X-BotConnector-Web/);
  assert.match(app, /const localSelection = isLocalModel/);
  assert.doesNotMatch(app, /X-BotConnector-Internal-Auth/);
  assert.doesNotMatch(app, /X-BotConnector-User-ID/);
  assert.doesNotMatch(app, /X-BotConnector-Request-ID/);
  assert.match(html, /100K token Cloud AI gratis/);
  assert.match(html, /Local AI tetap dapat digunakan tanpa login/);
});

test('Task 7 login restoration is a no-auto-send behavior', () => {
  const storage = new Map([
    ['botconnector.cloudDraft', 'draft setelah login'],
    ['botconnector.cloudModel', 'cloud:verified'],
  ]);
  const calls = [];
  const modelSelect = { value: '' };
  const promptInput = { value: '' };
  const models = [{ id: 'cloud:verified', source: 'cloud' }];
  const isCloud = model => model?.source === 'cloud';
  const restore = () => {
    const draft = storage.get('botconnector.cloudDraft') || '';
    const savedModel = storage.get('botconnector.cloudModel') || '';
    if (draft) promptInput.value = draft;
    if (savedModel && models.some(model => model.id === savedModel && isCloud(model))) modelSelect.value = savedModel;
    storage.delete('botconnector.cloudDraft');
    storage.delete('botconnector.cloudModel');
  };
  restore();
  assert.equal(promptInput.value, 'draft setelah login');
  assert.equal(modelSelect.value, 'cloud:verified');
  assert.deepEqual(calls, []);
});

test('Task 7 storage and provider boundaries remain safe', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'assets', 'botconnector', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /sessionStorage\.setItem\([^)]*(?:bc_session|__Host-bc-app|session_token|userId|quota|Internal-Auth|provider.*key)/i);
  assert.doesNotMatch(app, /OPENAI_API_KEY|BOTCONNECTOR_EXA_API_KEY|OLLAMA_API_KEY|X-BotConnector-Internal-Auth/i);
  assert.match(app, /credentials: 'same-origin'/);
});



