'use strict';
// Runs a sandboxed copy of the bridge (temp state dir, other port) and exercises GET /logout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = 18991;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-logout-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(path.join(tmp, 'oidc-client-secret'), 'test-secret');
fs.writeFileSync(path.join(tmp, 'oidc-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
fs.writeFileSync(path.join(tmp, 'oidc-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
fs.writeFileSync(path.join(tmp, 'tok'), 'x');

const ISSUER = 'https://botconnector.xyz/botconnector-oidc';
const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function idToken(exp, key = privateKey) {
  const h = b64u({ alg: 'RS256', typ: 'JWT', kid: 'bc-lc-1' });
  const p = b64u({ iss: ISSUER, sub: crypto.randomUUID().replace(/^(.{14})./, '$14'), aud: 'botconnector-librechat', exp });
  return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}

let child;
test.before(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.cjs'), 'utf8')
    .replace(/const STATE_DIR='[^']*'/, `const STATE_DIR='${tmp}'`)
    .replace(/const APP_TOKEN_FILE='[^']*'/, `const APP_TOKEN_FILE='${tmp}/tok'`)
    .replace(/const BFF_SECRET_FILE='[^']*'/, `const BFF_SECRET_FILE='${tmp}/tok'`)
    .replace('PORT=18442', `PORT=${PORT}`);
  const file = path.join(tmp, 'bridge.cjs');
  fs.writeFileSync(file, src);
  child = spawn(process.execPath, [file], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/.well-known/openid-configuration`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('bridge did not start');
});
test.after(() => { child?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const logout = (qs) => fetch(`http://127.0.0.1:${PORT}/logout?${qs}`, { redirect: 'manual' });
const now = () => Math.floor(Date.now() / 1000);

test('valid hint redirects to the allowed URI', async () => {
  const r = await logout(`id_token_hint=${idToken(now() + 600)}&post_logout_redirect_uri=${encodeURIComponent('https://app.botconnector.id/login')}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://app.botconnector.id/login');
});
test('expired hint is accepted', async () => {
  const r = await logout(`id_token_hint=${idToken(now() - 7200)}&post_logout_redirect_uri=${encodeURIComponent('https://botconnector.id/')}`);
  assert.equal(r.status, 303);
});
test('no hint but matching client_id still logs out (the reported failure)', async () => {
  const r = await logout(`post_logout_redirect_uri=${encodeURIComponent('https://botconnector.id/')}&client_id=botconnector-librechat`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://botconnector.id/');
});
test('no hint and wrong client_id is rejected', async () => {
  const r = await logout('client_id=someone-else');
  assert.equal(r.status, 400);
});
test('forged hint without client_id is rejected', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const r = await logout(`id_token_hint=${idToken(now() + 600, other)}`);
  assert.equal(r.status, 400);
});
test('redirect target outside the allow-list falls back to the default', async () => {
  const r = await logout(`client_id=botconnector-librechat&post_logout_redirect_uri=${encodeURIComponent('https://evil.example/')}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://botconnector.id/');
});
