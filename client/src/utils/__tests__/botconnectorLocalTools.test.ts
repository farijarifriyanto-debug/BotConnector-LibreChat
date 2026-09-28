import {
  listLocalDeviceTools,
  localChat,
  setDeviceAccessToken,
  setLocalDeviceToolEnabled,
} from '../botconnectorLocalRuntime';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('BotConnector Local Device tools', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.restoreAllMocks();
    setDeviceAccessToken('test-token');
  });

  afterEach(() => {
    setDeviceAccessToken('');
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  test('lists, enables, and routes local chat through chat.agent when a tool is enabled', async () => {
    const methods: string[] = [];
    let enabled = false;

    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/devices') {
        return jsonResponse(200, {
          devices: [
            {
              id: 'device-1',
              online: true,
              capabilities: ['tools.list', 'tools.set_enabled', 'chat.agent', 'chat.cancel'],
            },
          ],
        });
      }

      if (url.endsWith('/api/devices/device-1/request')) {
        const body = JSON.parse(String(init?.body || '{}'));
        methods.push(body.method);
        if (body.method === 'tools.list') {
          return jsonResponse(200, {
            result: [
              {
                id: 'web_search',
                name: 'web_search',
                source: 'builtin',
                permissionClass: 'READ',
                enabled,
                status: 'READY',
              },
            ],
          });
        }
        if (body.method === 'tools.set_enabled') {
          enabled = Boolean(body.params?.enabled);
          return jsonResponse(200, {
            result: {
              id: 'web_search',
              name: 'web_search',
              permissionClass: 'READ',
              enabled,
              status: 'READY',
            },
          });
        }
        if (body.method === 'chat.agent') {
          expect(body.params?.model).toBe('test-model');
          expect(body.params?.runtime).toBe('ollama');
          return jsonResponse(200, {
            result: {
              content: 'jawaban dengan tool',
              activities: [{ name: 'web_search', status: 'completed' }],
            },
          });
        }
        if (body.method === 'chat.cancel') {
          return jsonResponse(200, { result: { cancelled: true } });
        }
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const initial = await listLocalDeviceTools();
    expect(initial[0]?.enabled).toBe(false);

    const updated = await setLocalDeviceToolEnabled('web_search', true);
    expect(updated.enabled).toBe(true);

    const result = await localChat(
      [{ role: 'user', content: 'cari kabar terbaru' }],
      'device:ollama:test-model',
    );

    expect(result.content).toBe('jawaban dengan tool');
    expect(result.activities?.[0]?.name).toBe('web_search');
    expect(methods).toContain('tools.set_enabled');
    expect(methods).toContain('chat.agent');
    expect(methods).not.toContain('chat.completions');
  });
});
