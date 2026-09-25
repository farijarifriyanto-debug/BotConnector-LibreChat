const fs = require('node:fs');
const express = require('express');
const { requireJwtAuth, requireSameOrigin } = require('~/server/middleware');

const router = express.Router();

const RELAY_BASE = process.env.BOTCONNECTOR_DEVICE_RELAY_URL || 'http://127.0.0.1:18443';
const RELAY_TOKEN_FILE = process.env.BOTCONNECTOR_DEVICE_RELAY_TOKEN_FILE || '';
const ALLOWED_METHODS = new Set([
  'hardware.get',
  'launcher.list',
  'launcher.start',
  'launcher.stop',
  'tools.list',
  'runtime.status',
  'runtime.start',
  'runtime.stop',
  'runtime.install.start',
  'runtime.install.status',
  'runtime.install.list',
  'models.list',
  'models.pull.start',
  'models.pull.status',
  'models.pull.list',
  'models.pull.cancel',
  'models.delete',
  'model.load',
  'model.unload',
  'chat.completions',
]);

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ''),
  );
}

function getBotConnectorUserId(req) {
  const userId = String(req.user?.openidId || '');
  return req.user?.provider === 'openid' && validUuid(userId) ? userId : null;
}

function getRelayToken() {
  const envToken = String(process.env.BOTCONNECTOR_DEVICE_RELAY_TOKEN || '').trim();
  if (envToken) {
    return envToken;
  }
  if (!RELAY_TOKEN_FILE) {
    return '';
  }
  try {
    return fs.readFileSync(RELAY_TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

async function relayRequest(pathname, { method = 'GET', body, timeoutMs = 12_000 } = {}) {
  const token = getRelayToken();
  if (!token) {
    const error = new Error('Device relay authentication is unavailable.');
    error.status = 503;
    throw error;
  }

  const target = new URL(pathname, RELAY_BASE);
  const response = await fetch(target, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-botconnector-device-internal': token,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || payload?.message || 'Device relay request failed.',
    );
    error.status = response.status;
    error.code = payload?.error?.code || 'DEVICE_RELAY_FAILED';
    throw error;
  }
  return payload;
}

function relayError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 502;
  return res.status(status).json({
    error: {
      code: error?.code || (status === 503 ? 'DEVICE_RELAY_UNAVAILABLE' : 'DEVICE_RELAY_FAILED'),
      message: error?.message || 'Device relay request failed.',
    },
  });
}

function requireBotConnectorUser(req, res) {
  const userId = getBotConnectorUserId(req);
  if (!userId) {
    res.status(403).json({
      error: {
        code: 'BOTCONNECTOR_ACCOUNT_REQUIRED',
        message: 'A BotConnector OpenID account is required for device pairing.',
      },
    });
    return null;
  }
  return userId;
}

router.use(requireJwtAuth);

router.get('/', async (req, res) => {
  const userId = requireBotConnectorUser(req, res);
  if (!userId) return;
  try {
    const payload = await relayRequest('/internal/devices?user_id=' + encodeURIComponent(userId));
    return res.json(payload);
  } catch (error) {
    return relayError(res, error);
  }
});

router.post('/pair', requireSameOrigin, async (req, res) => {
  const userId = requireBotConnectorUser(req, res);
  if (!userId) return;
  try {
    return res.json(await relayRequest('/internal/pair', { method: 'POST', body: { user_id: userId } }));
  } catch (error) {
    return relayError(res, error);
  }
});

router.post('/:deviceId/request', requireSameOrigin, async (req, res) => {
  const userId = requireBotConnectorUser(req, res);
  if (!userId) return;

  const method = String(req.body?.method || '');
  if (!ALLOWED_METHODS.has(method)) {
    return res.status(403).json({
      error: { code: 'DEVICE_METHOD_NOT_ALLOWED', message: 'Device method is not allowed.' },
    });
  }

  try {
    return res.json(
      await relayRequest(
        '/internal/devices/' + encodeURIComponent(req.params.deviceId) + '/request',
        {
          method: 'POST',
          body: { user_id: userId, method, params: req.body?.params || {} },
          timeoutMs:
            method === 'chat.completions' || method === 'model.load' || method === 'model.unload'
              ? 15 * 60 * 1000
              : 12_000,
        },
      ),
    );
  } catch (error) {
    return relayError(res, error);
  }
});

router.post('/:deviceId/revoke', requireSameOrigin, async (req, res) => {
  const userId = requireBotConnectorUser(req, res);
  if (!userId) return;
  try {
    return res.json(
      await relayRequest(
        '/internal/devices/' + encodeURIComponent(req.params.deviceId) + '/revoke',
        { method: 'POST', body: { user_id: userId } },
      ),
    );
  } catch (error) {
    return relayError(res, error);
  }
});

module.exports = router;
