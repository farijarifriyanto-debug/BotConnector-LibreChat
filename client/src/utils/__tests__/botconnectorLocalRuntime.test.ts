import {
  getLocalHardware,
  getLocalHardwareRecommendations,
  localChat,
  localRuntimeBaseUrl,
  probeLocalRuntime,
} from '../botconnectorLocalRuntime';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('BotConnector Local Runtime browser bridge', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    sessionStorage.clear();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  test('uses only the loopback Local Runtime for local chat', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const fetchSpy = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.endsWith('/health')) return jsonResponse(200, { available: true });
      if (url.endsWith('/pair/start')) return jsonResponse(200, { pairingCode: 'abc234xy' });
      if (url.endsWith('/pair/confirm')) {
        return jsonResponse(200, { paired: true, token: 'paired-token' });
      }
      if (url.endsWith('/runtime-status')) {
        const modelRunCalled = calls.some((call) => call.url.endsWith('/model-run'));
        return jsonResponse(
          200,
          modelRunCalled
            ? {
                process: {
                  status: 'READY',
                  activeModel: {
                    health: true,
                    ggufPath: 'C:/BotConnector/models/test.gguf',
                    displayName: 'test.gguf',
                  },
                },
              }
            : { process: { status: 'STOPPED', activeModel: null } },
        );
      }
      if (url.endsWith('/model-run')) return jsonResponse(200, { status: 'READY' });
      if (url.endsWith('/chat')) return jsonResponse(200, { content: 'jawaban lokal' });

      throw new Error(`Unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await localChat(
      [{ role: 'user', content: 'halo lokal' }],
      'C:/BotConnector/models/test.gguf',
    );

    expect(result.content).toBe('jawaban lokal');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalled();
    expect(calls.every((call) => call.url.startsWith(localRuntimeBaseUrl()))).toBe(true);

    const modelRun = calls.find((call) => call.url.endsWith('/model-run'));
    expect(JSON.parse(String(modelRun?.init?.body))).toEqual({
      modelPath: 'C:/BotConnector/models/test.gguf',
    });
    expect((modelRun?.init?.headers as Record<string, string>)['X-BotConnector-Pairing']).toBe(
      'paired-token',
    );

    const chat = calls.find((call) => call.url.endsWith('/chat'));
    expect(JSON.parse(String(chat?.init?.body)).messages).toEqual([
      { role: 'user', content: 'halo lokal' },
    ]);
    expect((chat?.init?.headers as Record<string, string>)['X-BotConnector-Pairing']).toBe(
      'paired-token',
    );
  });

  test('reads device hardware and llmfit recommendations directly from the loopback runtime', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/pair/start')) return jsonResponse(200, { pairingCode: 'fit-1234' });
      if (url.endsWith('/pair/confirm')) {
        return jsonResponse(200, { paired: true, token: 'fit-token' });
      }
      if (url.endsWith('/hardware')) {
        return jsonResponse(200, {
          cpu: 'Intel Test CPU',
          logicalCores: 16,
          ramGb: 32,
          freeRamGb: 20,
          nvidia: [{ name: 'RTX Test', memoryGb: 8 }],
        });
      }
      if (url.endsWith('/hardware-recommendations')) {
        return jsonResponse(200, {
          system: { cpu_name: 'Intel Test CPU', total_ram_gb: 32, gpu_name: 'RTX Test' },
          models: [{ name: 'Qwen Test 7B', fit_label: 'Cocok', best_quant: 'Q4_K_M' }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const hardware = await getLocalHardware();
    const recommendations = await getLocalHardwareRecommendations();

    expect(hardware.ramGb).toBe(32);
    expect(hardware.nvidia?.[0]?.memoryGb).toBe(8);
    expect(recommendations.models?.[0]?.best_quant).toBe('Q4_K_M');
    expect(calls.every((call) => call.url.startsWith(localRuntimeBaseUrl()))).toBe(true);
    const protectedCalls = calls.filter(
      (call) => call.url.endsWith('/hardware') || call.url.endsWith('/hardware-recommendations'),
    );
    expect(protectedCalls).toHaveLength(2);
    expect(
      protectedCalls.every(
        (call) =>
          (call.init?.headers as Record<string, string> | undefined)?.['X-BotConnector-Pairing'] ===
          'fit-token',
      ),
    ).toBe(true);
  });

  test('health probe fails closed when Local Runtime is unavailable', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(503, { error: { message: 'down' } }),
      ) as unknown as typeof fetch;

    await expect(probeLocalRuntime()).rejects.toThrow('down');
  });
});
