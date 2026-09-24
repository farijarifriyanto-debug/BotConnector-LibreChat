import {
  getLocalHardware,
  getLocalHardwareRecommendations,
  installRecommendedLocalModel,
  listLocalModels,
  localChat,
  localRuntimeBaseUrl,
  probeLocalRuntime,
  unloadLocalModel,
  uninstallLocalModel,
  verifyLocalModelState,
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
      if (url.endsWith('/installed')) {
        return jsonResponse(200, [
          {
            path: 'C:/BotConnector/models/test.gguf',
            name: 'test.gguf',
            size: 1024,
            runtime: 'botconnector',
          },
        ]);
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

  test('keeps Lemonade model verification bound to Lemonade when Local Core is also reachable', async () => {
    const calls: string[] = [];
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('http://127.0.0.1:18764')) {
        return jsonResponse(200, { available: true });
      }
      if (url.endsWith('/v1/models')) {
        return jsonResponse(200, {
          data: [
            {
              id: 'Qwen-Test-GGUF',
              checkpoint: 'example/Qwen-Test-GGUF:Q4_K_M',
              recipe: 'llamacpp',
              downloaded: true,
            },
          ],
        });
      }
      if (url.endsWith('/v1/health')) {
        return jsonResponse(200, {
          status: 'ok',
          model_loaded: 'Qwen-Test-GGUF',
          all_models_loaded: [
            {
              model_name: 'Qwen-Test-GGUF',
              checkpoint: 'example/Qwen-Test-GGUF:Q4_K_M',
              recipe: 'llamacpp',
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const state = await verifyLocalModelState('lemonade:Qwen-Test-GGUF');
    expect(state.runtime).toBe('lemonade');
    expect(state.installed).toBe(true);
    expect(state.loaded).toBe(true);
    expect(calls.every((url) => url.startsWith('http://127.0.0.1:13305'))).toBe(true);
  });

  test('reads device hardware and llmfit recommendations directly from the loopback runtime', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/health')) return jsonResponse(200, { available: true });
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
    const hardwareCalls = calls.filter(
      (call) => call.url.endsWith('/hardware') || call.url.endsWith('/hardware-recommendations'),
    );
    expect(hardwareCalls).toHaveLength(2);
    expect(
      hardwareCalls.every(
        (call) =>
          !(call.init?.headers as Record<string, string> | undefined)?.['X-BotConnector-Pairing'],
      ),
    ).toBe(true);
  });

  test('falls back to Lemonade for hardware, models, recommendations, and local chat', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let loaded = false;
    let downloaded = true;
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.startsWith('http://127.0.0.1:18764')) {
        throw new TypeError('Failed to fetch');
      }
      if (url.endsWith('/v1/system-info')) {
        return jsonResponse(200, {
          'OS Version': 'Windows 11 Test',
          'Physical Memory': '32.00 GB',
          Processor: 'AMD Ryzen AI Test',
          devices: {
            cpu: {
              available: true,
              name: 'AMD Ryzen AI Test',
              family: 'x86_64',
              cores: 8,
              threads: 16,
            },
            amd_gpu: [
              {
                available: true,
                name: 'AMD Radeon Test',
                family: 'gfx1152',
                integrated: true,
              },
            ],
            amd_npu: {
              available: true,
              name: 'AMD Ryzen AI NPU',
              family: 'XDNA2',
            },
            nvidia_gpu: [{ available: false, name: '' }],
          },
          recipes: {
            llamacpp: {
              backends: {
                vulkan: { state: 'installed' },
                rocm: { state: 'installable' },
              },
            },
          },
        });
      }
      if (url.endsWith('/v1/system-stats')) {
        return jsonResponse(200, { memory_gb: 8 });
      }
      if (url.endsWith('/v1/models?show_all=true')) {
        return jsonResponse(200, {
          data: [
            {
              id: 'Qwen3-0.6B-GGUF',
              checkpoint: 'example/Qwen3-0.6B-GGUF:Q4_K_M',
              recipe: 'llamacpp',
              size: 0.7,
              downloaded: true,
              suggested: true,
              recipe_options: { llamacpp_backend: 'vulkan' },
            },
            {
              id: 'Qwen3-4B-GGUF',
              checkpoint: 'example/Qwen3-4B-GGUF:Q4_K_M',
              recipe: 'llamacpp',
              size: 3.2,
              downloaded: false,
              suggested: false,
              labels: ['coding', 'indonesian'],
              recipe_options: { llamacpp_backend: 'vulkan' },
            },
          ],
        });
      }
      if (url.endsWith('/v1/models')) {
        return jsonResponse(200, {
          data: downloaded
            ? [
                {
                  id: 'Qwen-Test-GGUF',
                  checkpoint: 'example/Qwen-Test-GGUF:Q4_K_M',
                  recipe: 'llamacpp',
                  size: 4,
                  downloaded: true,
                  labels: ['reasoning'],
                },
              ]
            : [],
        });
      }
      if (url.endsWith('/v1/health')) {
        return jsonResponse(200, {
          status: 'ok',
          model_loaded: loaded ? 'Qwen-Test-GGUF' : null,
          all_models_loaded: loaded
            ? [
                {
                  model_name: 'Qwen-Test-GGUF',
                  checkpoint: 'example/Qwen-Test-GGUF:Q4_K_M',
                  recipe: 'llamacpp',
                },
              ]
            : [],
        });
      }
      if (url.endsWith('/v1/pull')) {
        downloaded = true;
        return jsonResponse(200, { status: 'success', message: 'Installed model' });
      }
      if (url.endsWith('/v1/load')) {
        loaded = true;
        return jsonResponse(200, { status: 'success' });
      }
      if (url.endsWith('/v1/unload')) {
        loaded = false;
        return jsonResponse(200, { status: 'success' });
      }
      if (url.endsWith('/v1/delete')) {
        loaded = false;
        downloaded = false;
        return jsonResponse(200, { status: 'success' });
      }
      if (url.endsWith('/v1/chat/completions')) {
        return jsonResponse(200, {
          choices: [{ message: { content: 'jawaban dari Lemonade' } }],
          usage: { completion_tokens: 4 },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const hardware = await getLocalHardware();
    expect(hardware.runtime).toBe('lemonade');
    expect(hardware.ramGb).toBe(32);
    expect(hardware.freeRamGb).toBe(24);
    expect(hardware.amd?.[0]?.family).toBe('gfx1152');
    expect(hardware.npu?.family).toBe('XDNA2');
    expect(hardware.backends).toContain('llamacpp:vulkan');

    const recommendations = await getLocalHardwareRecommendations(undefined, {
      useCase: 'general',
      preference: 'balanced',
    });
    expect(recommendations.source).toBe('BotConnector advisor · Lemonade runtime');
    expect(recommendations.useCase).toBe('general');
    expect(recommendations.preference).toBe('balanced');
    expect(recommendations.models?.[0]?.name).toBe('Qwen3-4B-GGUF');
    expect(recommendations.compatible_models?.[0]?.name).toBe('Qwen3-0.6B-GGUF');
    expect(recommendations.compatible_models?.[0]?.download_size_gb).toBe(0.7);
    expect(recommendations.compatible_models?.some((model) => model.name === 'Qwen3-4B-GGUF')).toBe(
      true,
    );

    const multiUseCase = await getLocalHardwareRecommendations(undefined, {
      useCases: ['indonesian', 'coding'],
      preference: 'balanced',
    });
    expect(multiUseCase.useCases).toEqual(['indonesian', 'coding']);
    expect(multiUseCase.models?.[0]?.name).toBe('Qwen3-4B-GGUF');
    expect(
      multiUseCase.models?.[0]?.reasons?.some((reason) =>
        reason.includes('indonesian capability evidence'),
      ),
    ).toBe(true);
    expect(
      multiUseCase.models?.[0]?.reasons?.some((reason) =>
        reason.includes('coding capability evidence'),
      ),
    ).toBe(true);

    await installRecommendedLocalModel('Qwen-Test-GGUF');
    const pullCall = calls.find((call) => call.url.endsWith('/v1/pull'));
    expect(JSON.parse(String(pullCall?.init?.body))).toEqual({
      model_name: 'Qwen-Test-GGUF',
      stream: false,
    });

    const models = await listLocalModels();
    expect(models[0]?.path).toBe('lemonade:Qwen-Test-GGUF');
    expect(models[0]?.quant).toBe('Q4_K_M');

    const result = await localChat(
      [{ role: 'user', content: 'halo lokal' }],
      'lemonade:Qwen-Test-GGUF',
    );
    expect(result.content).toBe('jawaban dari Lemonade');
    expect(localRuntimeBaseUrl()).toBe('http://127.0.0.1:13305');

    const chatCall = calls.find((call) => call.url.endsWith('/v1/chat/completions'));
    expect(JSON.parse(String(chatCall?.init?.body))).toMatchObject({
      model: 'Qwen-Test-GGUF',
      stream: false,
    });

    await unloadLocalModel('lemonade:Qwen-Test-GGUF');
    const unloadCall = calls.find((call) => call.url.endsWith('/v1/unload'));
    expect(JSON.parse(String(unloadCall?.init?.body))).toEqual({
      model_name: 'Qwen-Test-GGUF',
    });

    // Re-load, then verify uninstall unloads the active model before deleting it.
    await localChat([{ role: 'user', content: 'muat lagi' }], 'lemonade:Qwen-Test-GGUF');
    const beforeUninstall = calls.length;
    await uninstallLocalModel('lemonade:Qwen-Test-GGUF');
    const lifecycleCalls = calls.slice(beforeUninstall).map((call) => call.url);
    const unloadIndex = lifecycleCalls.findIndex((url) => url.endsWith('/v1/unload'));
    const deleteIndex = lifecycleCalls.findIndex((url) => url.endsWith('/v1/delete'));
    expect(unloadIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(unloadIndex);
    const deleteCall = calls.findLast((call) => call.url.endsWith('/v1/delete'));
    expect(JSON.parse(String(deleteCall?.init?.body))).toEqual({
      model_name: 'Qwen-Test-GGUF',
    });
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
