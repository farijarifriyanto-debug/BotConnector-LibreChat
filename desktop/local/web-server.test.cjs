const assert = require('node:assert/strict');
const test = require('node:test');
const { createWebServer, OFFICIAL_WEB_ORIGINS, exactOrigin } = require('./web-server.cjs');

async function postWithOrigin(origin, options = {}) {
  const service = createWebServer({
    coreUrl: 'http://127.0.0.1:8000',
    handlers: new Map([['local:catalog-search', query => ({ received: query })]]),
    port: 0,
    ...options,
  });
  const address = await service.listen();
  try {
    return await fetch(`http://127.0.0.1:${address.port}/api/botconnector/local/catalog-search`, {
      method: 'POST',
      headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'origin-test' }),
    });
  } finally {
    await service.close();
  }
}

test('local model API accepts same-machine browser requests and rejects foreign origins', async () => {
  const handlers = new Map([
    ['local:catalog-search', query => ({ received: query })],
    ['local:download-pause', id => ({ id })],
  ]);
  let shutdownRequested = false;
  const service = createWebServer({
    coreUrl: 'http://127.0.0.1:8000', handlers, port: 0, allowedOrigins: ['https://botconnector.id'],
    onShutdown: () => { shutdownRequested = true; },
  });
  const address = await service.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${origin}/api/botconnector/local/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { available: true });

    const allowed = await fetch(`${origin}/api/botconnector/local/catalog-search`, {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:8000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'gguf' }),
    });
    assert.deepEqual(await allowed.json(), { received: { query: 'gguf' } });

    const mapped = await fetch(`${origin}/api/botconnector/local/download-pause`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'job-1' }),
    });
    assert.deepEqual(await mapped.json(), { id: 'job-1' });

    const missingOrigin = await fetch(`${origin}/api/botconnector/local/download-pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'job-2' }),
    });
    assert.equal(missingOrigin.status, 403);

    const unrelatedLoopback = await fetch(`${origin}/api/botconnector/local/download-pause`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:9999', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'job-4' }),
    });
    assert.equal(unrelatedLoopback.status, 403);

    const configured = await fetch(`${origin}/api/botconnector/local/catalog-search`, {
      method: 'POST', headers: { Origin: 'https://botconnector.id', 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'gguf' }),
    });
    assert.equal(configured.status, 200);

    const rejected = await fetch(`${origin}/api/botconnector/local/catalog-search`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'gguf' }),
    });
    assert.equal(rejected.status, 403);

    const shutdown = await fetch(`${origin}/api/botconnector/local/shutdown`, {
      method: 'POST',
      headers: { Origin: origin },
    });
    assert.deepEqual(await shutdown.json(), { ok: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shutdownRequested, true);

    const events = await fetch(`${origin}/api/botconnector/local/events`);
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    await reader.read();
    service.publish('download:progress', { id: 'job-3', status: 'downloading' });
    const progress = decoder.decode((await reader.read()).value);
    assert.match(progress, /event: download:progress/);
    assert.match(progress, /job-3/);
    await reader.cancel();
  } finally {
    await service.close();
  }
});

test('official Web origins are trusted by default while other BotConnector subdomains are denied', async () => {
  assert.deepEqual(OFFICIAL_WEB_ORIGINS, [
    'https://app-preview.botconnector.id',
    'https://app.botconnector.id',
  ]);
  for (const origin of OFFICIAL_WEB_ORIGINS) {
    const response = await postWithOrigin(origin);
    assert.equal(response.status, 200, `${origin} should be trusted without environment configuration`);
  }
  for (const origin of ['https://botconnector.id', 'https://other.botconnector.id', 'https://attacker.example']) {
    const response = await postWithOrigin(origin);
    assert.equal(response.status, 403, `${origin} should remain default-deny`);
  }
});

test('loopback web origins are allowed only in development mode', async () => {
  const production = await postWithOrigin('http://localhost:5173');
  assert.equal(production.status, 403);

  const development = await postWithOrigin('http://localhost:5173', { development: true });
  assert.equal(development.status, 200);
});

test('origin overrides are exact and never accept wildcard or paths', async () => {
  assert.equal(exactOrigin('*'), null);
  assert.equal(exactOrigin('https://custom.example/path'), null);
  const options = { allowedOrigins: ['https://custom.example', '*', 'https://bad.example/path'] };
  assert.equal((await postWithOrigin('https://custom.example', options)).status, 200);
  assert.equal((await postWithOrigin('https://sub.custom.example', options)).status, 403);
  assert.equal((await postWithOrigin('https://arbitrary.example', options)).status, 403);
});
