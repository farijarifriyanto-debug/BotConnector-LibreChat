const LOCAL_RUNTIME_BASE = 'http://127.0.0.1:18764';
const LOCAL_API_BASE = `${LOCAL_RUNTIME_BASE}/api/botconnector/local`;
const LEMONADE_RUNTIME_BASE = 'http://127.0.0.1:13305';
const PAIRING_STORAGE_KEY = 'botconnectorLocalPairingToken';
const LEMONADE_MODEL_PREFIX = 'lemonade:';
const DEVICE_MODEL_PREFIX = 'device:';

type LocalRuntimeKind = 'botconnector' | 'lemonade' | 'ollama' | 'device';

export type LocalAdvisorUseCase =
  | 'general'
  | 'coding'
  | 'reasoning'
  | 'vision'
  | 'tools'
  | 'indonesian';
export type LocalAdvisorPreference = 'fast' | 'balanced' | 'quality';

export type LocalInstalledModel = {
  path: string;
  name: string;
  size?: number;
  repoId?: string | null;
  quant?: string | null;
  capabilities?: Record<string, unknown>;
  installedAt?: string;
  runtime?: LocalRuntimeKind;
  modelId?: string;
  recipe?: string;
};

type LocalGpu = {
  name?: string;
  memoryGb?: number;
  driver?: string;
  family?: string;
  integrated?: boolean;
};

export type LocalHardwareInfo = {
  platform?: string;
  release?: string;
  arch?: string;
  cpu?: string;
  logicalCores?: number;
  ramGb?: number;
  freeRamGb?: number;
  nvidia?: LocalGpu[];
  amd?: LocalGpu[];
  intel?: LocalGpu[];
  npu?: {
    name?: string;
    family?: string;
    available?: boolean;
  } | null;
  backends?: string[];
  runtime?: LocalRuntimeKind;
};

export type LocalHardwareRecommendation = {
  name?: string;
  fit_label?: string;
  fit_level?: string;
  run_mode_label?: string;
  run_mode?: string;
  best_quant?: string;
  memory_required_gb?: number;
  download_size_gb?: number;
  estimated_tps?: number;
  score?: number;
  runtime_label?: string;
  runtime?: string;
  confidence?: 'verified' | 'estimated' | 'unknown';
  model_id?: string;
  downloaded?: boolean;
  installed_path?: string;
  reasons?: string[];
};

export type LocalHardwareRecommendations = {
  source?: string;
  useCase?: LocalAdvisorUseCase;
  useCases?: LocalAdvisorUseCase[];
  preference?: LocalAdvisorPreference;
  system?: {
    cpu_name?: string;
    total_ram_gb?: number;
    gpu_name?: string;
    gpu_vram_gb?: number;
    available_ram_gb?: number;
    gpus?: Array<{ name?: string; memory_gb?: number; vram_gb?: number }>;
    backend?: string;
    npu_name?: string;
  } | null;
  node?: unknown;
  models?: LocalHardwareRecommendation[];
  compatible_models?: LocalHardwareRecommendation[];
  error?: string | { message?: string };
};

export type LocalModelVerification = {
  modelPath: string;
  runtime: LocalRuntimeKind;
  installed: boolean;
  loaded: boolean;
  verified: true;
  checkedAt: string;
};

export type LocalRuntimeStatus = {
  runtime?: LocalRuntimeKind;
  version?: string;
  originVerified?: boolean;
  process?: {
    status?: string;
    health?: boolean;
    activeModel?: {
      status?: string;
      health?: boolean;
      ggufPath?: string | null;
      displayName?: string | null;
      repoId?: string | null;
      quantization?: string | null;
    } | null;
  };
  managed?: { verified?: boolean };
};

type LocalMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
};

type LocalChatResult = {
  content?: string;
  tool_calls?: unknown[];
  usage?: unknown;
};

type LemonadeModel = {
  id?: string;
  checkpoint?: string;
  recipe?: string;
  size?: number;
  downloaded?: boolean;
  suggested?: boolean;
  labels?: string[];
  context_length?: number;
  max_context_window?: number;
  recipe_options?: Record<string, unknown>;
};

let activeRequestId: string | null = null;
let detectedRuntimeBase = LOCAL_RUNTIME_BASE;
let detectedRuntimeKind: LocalRuntimeKind | null = null;
let deviceAccessToken = '';

export function setDeviceAccessToken(token?: string) {
  deviceAccessToken = String(token || '');
}

type DeviceSummary = {
  id: string;
  online?: boolean;
  capabilities?: string[];
};

async function deviceApi<T = any>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  if (!deviceAccessToken) {
    const error = new Error('BotConnector Device authentication is unavailable.') as Error & {
      code?: string;
    };
    error.code = 'DEVICE_AUTH_UNAVAILABLE';
    throw error;
  }

  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body != null) headers.set('content-type', 'application/json');
  headers.set('authorization', `Bearer ${deviceAccessToken}`);

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || payload?.message || `BotConnector Device HTTP ${response.status}`,
    ) as Error & { code?: string; status?: number };
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

async function onlineDeviceFor(capability: string, signal?: AbortSignal): Promise<DeviceSummary> {
  const payload = await deviceApi<{ devices?: DeviceSummary[] }>('/api/devices', {}, signal);
  const devices = Array.isArray(payload?.devices) ? payload.devices : [];
  const device = devices.find(
    (item) =>
      item?.online === true &&
      Array.isArray(item?.capabilities) &&
      item.capabilities.includes(capability),
  );
  if (!device) {
    const error = new Error(`No online BotConnector Device exposes ${capability}.`) as Error & {
      code?: string;
    };
    error.code = 'DEVICE_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  return device;
}

async function deviceRequest<T = any>(
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const device = await onlineDeviceFor(method, signal);
  const payload = await deviceApi<{ result?: T }>(
    `/api/devices/${encodeURIComponent(device.id)}/request`,
    {
      method: 'POST',
      body: JSON.stringify({ method, params }),
    },
    signal,
  );
  return payload.result as T;
}

function parseDeviceModelPath(modelPath: string) {
  const raw = String(modelPath || '');
  if (!raw.startsWith(DEVICE_MODEL_PREFIX)) return null;
  const rest = raw.slice(DEVICE_MODEL_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return {
    runtime: rest.slice(0, separator),
    model: rest.slice(separator + 1),
  };
}

function makeDeviceModelPath(runtime: string, model: string) {
  return `${DEVICE_MODEL_PREFIX}${runtime}:${model}`;
}

async function deviceRuntimeStatus(signal?: AbortSignal) {
  return deviceRequest<{
    available?: boolean;
    runtime?: string | null;
    activeModel?: string | null;
    loadedModels?: string[];
    models?: number;
    message?: string;
  }>('runtime.status', {}, signal);
}

function deviceStatusToLocalRuntimeStatus(status: {
  available?: boolean;
  runtime?: string | null;
  activeModel?: string | null;
  loadedModels?: string[];
}): LocalRuntimeStatus {
  const runtime = (status?.runtime || 'device') as LocalRuntimeKind;
  const active = String(status?.activeModel || '');
  return {
    runtime,
    originVerified: true,
    managed: { verified: true },
    process: {
      status: active ? 'READY' : status?.available === false ? 'STOPPED' : 'IDLE',
      health: status?.available !== false,
      activeModel: active
        ? {
            status: 'READY',
            health: true,
            ggufPath: makeDeviceModelPath(runtime, active),
            displayName: active,
          }
        : null,
    },
  };
}

function deviceFallbackAllowed(error: unknown) {
  const code = String((error as { code?: unknown })?.code || '');
  return code === 'DEVICE_AUTH_UNAVAILABLE' || code === 'DEVICE_CAPABILITY_UNAVAILABLE';
}

function pairingToken() {
  try {
    return sessionStorage.getItem(PAIRING_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function savePairingToken(token: string) {
  try {
    if (token) sessionStorage.setItem(PAIRING_STORAGE_KEY, token);
    else sessionStorage.removeItem(PAIRING_STORAGE_KEY);
  } catch {
    // Session storage is an optimization only; pairing can be repeated.
  }
}

async function parseJson(response: Response) {
  return response.json().catch(() => ({}));
}

async function fetchJson<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', mode: 'cors', ...init });
  const body = await parseJson(response);
  if (!response.ok) {
    const message =
      body?.error?.message || body?.message || `Local runtime HTTP ${response.status}`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return body as T;
}

async function postLocal<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {},
  options: { pairing?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.pairing) {
    const token = pairingToken();
    if (token) headers['X-BotConnector-Pairing'] = token;
  }
  const actionPath = action
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const response = await fetch(`${LOCAL_API_BASE}/${actionPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  const result = await parseJson(response);
  if (!response.ok) {
    const error = new Error(
      result?.error?.message || `BotConnector Local Runtime HTTP ${response.status}`,
    ) as Error & { code?: string; status?: number };
    error.code = result?.error?.code;
    error.status = response.status;
    if (response.status === 401 && error.code === 'PAIRING_REQUIRED') {
      savePairingToken('');
    }
    throw error;
  }
  return result as T;
}

async function detectLocalRuntime(signal?: AbortSignal): Promise<LocalRuntimeKind> {
  try {
    const response = await fetch(`${LOCAL_API_BASE}/health`, {
      method: 'GET',
      cache: 'no-store',
      mode: 'cors',
      signal,
    });
    const body = await parseJson(response);
    if (response.ok && body?.available !== false) {
      detectedRuntimeKind = 'botconnector';
      detectedRuntimeBase = LOCAL_RUNTIME_BASE;
      return 'botconnector';
    }
  } catch {
    // Fall through to Lemonade.
  }

  const lemonade = await fetchJson<{ status?: string }>(`${LEMONADE_RUNTIME_BASE}/v1/health`, {
    method: 'GET',
    signal,
  });
  if (lemonade?.status && lemonade.status !== 'ok') {
    throw new Error('Lemonade Local Runtime tidak siap.');
  }
  detectedRuntimeKind = 'lemonade';
  detectedRuntimeBase = LEMONADE_RUNTIME_BASE;
  return 'lemonade';
}

function isLemonadeModelPath(modelPath: string) {
  return String(modelPath || '').startsWith(LEMONADE_MODEL_PREFIX);
}

function lemonadeModelId(modelPath: string) {
  return isLemonadeModelPath(modelPath)
    ? String(modelPath).slice(LEMONADE_MODEL_PREFIX.length)
    : String(modelPath || '');
}

function quantFromCheckpoint(checkpoint?: string) {
  const suffix =
    String(checkpoint || '')
      .split(':')
      .pop() || '';
  const match = suffix.match(/Q\d(?:_[A-Za-z0-9]+)*/i);
  return match?.[0] || null;
}

function numericGb(value: unknown) {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function installedBackends(systemInfo: any) {
  const rows: string[] = [];
  const recipes = systemInfo?.recipes;
  if (!recipes || typeof recipes !== 'object') return rows;
  for (const [recipeName, recipe] of Object.entries<any>(recipes)) {
    const backends = recipe?.backends;
    if (!backends || typeof backends !== 'object') continue;
    for (const [backendName, backend] of Object.entries<any>(backends)) {
      if (backend?.state === 'installed') rows.push(`${recipeName}:${backendName}`);
    }
  }
  return rows;
}

async function getLemonadeHardware(signal?: AbortSignal): Promise<LocalHardwareInfo> {
  const [info, stats] = await Promise.all([
    fetchJson<any>(`${LEMONADE_RUNTIME_BASE}/v1/system-info`, { signal }),
    fetchJson<any>(`${LEMONADE_RUNTIME_BASE}/v1/system-stats`, { signal }).catch(() => ({})),
  ]);
  const cpu = info?.devices?.cpu || {};
  const ramGb = numericGb(info?.['Physical Memory']);
  const usedRamGb = numericGb(stats?.memory_gb);
  const freeRamGb =
    typeof ramGb === 'number' && typeof usedRamGb === 'number'
      ? Math.max(0, ramGb - usedRamGb)
      : undefined;

  const mapGpu = (gpu: any): LocalGpu => ({
    name: gpu?.name,
    memoryGb: numericGb(gpu?.vram_gb),
    driver: gpu?.driver,
    family: gpu?.family,
    integrated: Boolean(gpu?.integrated),
  });

  return {
    platform: String(info?.['OS Version'] || '').split(' ')[0] || undefined,
    release: info?.['OS Version'] || undefined,
    arch: cpu?.family || undefined,
    cpu: cpu?.name || info?.Processor || undefined,
    logicalCores: Number(cpu?.threads || 0) || undefined,
    ramGb,
    freeRamGb,
    nvidia: Array.isArray(info?.devices?.nvidia_gpu)
      ? info.devices.nvidia_gpu.filter((gpu: any) => gpu?.available !== false).map(mapGpu)
      : [],
    amd: Array.isArray(info?.devices?.amd_gpu)
      ? info.devices.amd_gpu.filter((gpu: any) => gpu?.available !== false).map(mapGpu)
      : [],
    npu:
      info?.devices?.amd_npu?.available === true
        ? {
            name: info.devices.amd_npu.name,
            family: info.devices.amd_npu.family,
            available: true,
          }
        : null,
    backends: installedBackends(info),
    runtime: 'lemonade',
  };
}

async function listLemonadeModels(signal?: AbortSignal): Promise<LocalInstalledModel[]> {
  const payload = await fetchJson<{ data?: LemonadeModel[] }>(
    `${LEMONADE_RUNTIME_BASE}/v1/models`,
    {
      signal,
    },
  );
  return (Array.isArray(payload?.data) ? payload.data : [])
    .filter(
      (model) => Boolean(model?.id) && model?.downloaded !== false && model?.recipe !== 'cloud',
    )
    .map((model) => ({
      path: `${LEMONADE_MODEL_PREFIX}${model.id}`,
      name: String(model.id),
      size:
        typeof model.size === 'number' && Number.isFinite(model.size)
          ? Math.round(model.size * 1024 * 1024 * 1024)
          : undefined,
      repoId: model.checkpoint?.split(':')[0] || null,
      quant: quantFromCheckpoint(model.checkpoint),
      capabilities: Object.fromEntries((model.labels || []).map((label) => [label, true])),
      runtime: 'lemonade' as const,
      modelId: model.id,
      recipe: model.recipe,
    }));
}

function normalizeLemonadeStatus(health: any): LocalRuntimeStatus {
  const loaded = Array.isArray(health?.all_models_loaded) ? health.all_models_loaded : [];
  const modelId = health?.model_loaded || loaded[0]?.model_name || '';
  const active =
    loaded.find((row: any) => row?.model_name === modelId) ||
    loaded[0] ||
    (modelId ? { model_name: modelId } : null);
  return {
    runtime: 'lemonade',
    version: typeof health?.version === 'string' ? health.version : undefined,
    originVerified: true,
    managed: { verified: true },
    process: {
      status: active ? 'READY' : 'STOPPED',
      health: health?.status === 'ok',
      activeModel: active
        ? {
            status: active?.is_busy ? 'BUSY' : 'READY',
            health: true,
            ggufPath: `${LEMONADE_MODEL_PREFIX}${active.model_name}`,
            displayName: active.model_name,
            repoId: active.checkpoint || null,
            quantization: quantFromCheckpoint(active.checkpoint),
          }
        : null,
    },
  };
}

async function getLemonadeRuntimeStatus(signal?: AbortSignal): Promise<LocalRuntimeStatus> {
  const health = await fetchJson<any>(`${LEMONADE_RUNTIME_BASE}/v1/health`, { signal });
  const compatible =
    health?.status === 'ok' &&
    (Object.prototype.hasOwnProperty.call(health, 'model_loaded') ||
      Array.isArray(health?.all_models_loaded));
  if (!compatible) {
    throw new Error('Lemonade Runtime API response is not compatible with BotConnector.');
  }
  return normalizeLemonadeStatus(health);
}

function lemonadeModelCompatibility(model: LemonadeModel, hardware: LocalHardwareInfo) {
  const recipe = String(model.recipe || '');
  if (recipe === 'cloud') return false;
  if (recipe === 'ryzenai-llm' || recipe === 'flm') return hardware.npu?.available === true;
  if (recipe === 'llamacpp') return true;
  return false;
}

function fitFromMemory(requiredGb: number | undefined, availableGb: number | undefined) {
  if (!requiredGb || !availableGb || availableGb <= 0) {
    return { level: 'unknown', label: 'Fit unknown', score: 100 };
  }
  const ratio = requiredGb / availableGb;
  if (ratio <= 0.6) return { level: 'excellent', label: 'Excellent fit', score: 500 };
  if (ratio <= 0.8) return { level: 'good', label: 'Good fit', score: 400 };
  if (ratio <= 1.0) return { level: 'limited', label: 'Runs with limits', score: 250 };
  return { level: 'unsupported', label: 'Not recommended', score: 0 };
}

function parameterBillions(model: LemonadeModel) {
  const text = [model.id, model.checkpoint].filter(Boolean).join(' ');
  const match = text.match(/(?:^|[-_\s])(\d+(?:\.\d+)?)B(?:[-_\s]|$)/i);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

const BOTCONNECTOR_USE_CASE_KEYWORDS: Record<
  Exclude<LocalAdvisorUseCase, 'general' | 'indonesian'>,
  string[]
> = {
  vision: ['vision-language', 'vlm', 'image-text-to-text', 'multimodal', 'vision', 'mmproj'],
  tools: [
    'tool-use',
    'tool_use',
    'tool-calling',
    'tool_calling',
    'function-calling',
    'function_calling',
    'tool',
  ],
  coding: ['coder', 'coding', 'codegen', 'code', 'programming', 'fim', 'fill-in-the-middle'],
  reasoning: [
    'reasoning',
    'reasoner',
    'thinking',
    'qwq',
    'gpt-oss',
    'deepseek-r1',
    'r1-distill',
    'spark-reasoning',
  ],
};

const BOTCONNECTOR_INDONESIAN_KEYWORDS = [
  'indonesian',
  'bahasa-indonesia',
  'bahasa indonesia',
  'id-id',
  'bahasaindonesia',
];

function botConnectorCapabilityEvidence(model: LemonadeModel, useCase: LocalAdvisorUseCase) {
  if (useCase === 'general') return null;
  const haystack = [model.id, model.checkpoint, ...(model.labels || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const keywords =
    useCase === 'indonesian'
      ? BOTCONNECTOR_INDONESIAN_KEYWORDS
      : BOTCONNECTOR_USE_CASE_KEYWORDS[useCase];
  return keywords.some((keyword) => haystack.includes(keyword));
}

function botConnectorQualityCapacityScore(
  model: LemonadeModel,
  preference: LocalAdvisorPreference,
) {
  const params = parameterBillions(model);
  if (params == null) return 0;

  if (preference === 'fast') {
    if (params < 1) return 120;
    if (params < 2) return 100;
    if (params < 4) return 70;
    if (params < 7) return 35;
    return 0;
  }

  if (preference === 'quality') {
    if (params < 1) return -180;
    if (params < 2) return -40;
    if (params < 4) return 80;
    if (params < 7) return 160;
    if (params < 12) return 220;
    if (params < 20) return 200;
    return 150;
  }

  // Balanced: avoid selecting a sub-1B trial model as the default when a
  // materially stronger model still fits comfortably.
  if (params < 1) return -120;
  if (params < 2) return 10;
  if (params < 4) return 70;
  if (params < 7) return 130;
  if (params < 12) return 165;
  if (params < 20) return 150;
  return 100;
}

function botConnectorUseCaseScore(
  model: LemonadeModel,
  useCase: LocalAdvisorUseCase,
  preference: LocalAdvisorPreference,
) {
  if (useCase === 'general') return { score: 0, reason: 'General chat profile.' };
  const evidence = botConnectorCapabilityEvidence(model, useCase);
  const weight = preference === 'quality' ? 320 : preference === 'fast' ? 220 : 270;
  return evidence
    ? { score: weight, reason: `BotConnector found ${useCase} capability evidence.` }
    : { score: -weight * 2, reason: `No ${useCase} capability evidence in the runtime metadata.` };
}

async function getLemonadeRecommendations(
  signal?: AbortSignal,
  options: {
    useCase?: LocalAdvisorUseCase;
    useCases?: LocalAdvisorUseCase[];
    preference?: LocalAdvisorPreference;
  } = {},
): Promise<LocalHardwareRecommendations> {
  const requestedUseCases =
    Array.isArray(options.useCases) && options.useCases.length
      ? options.useCases
      : [options.useCase || 'general'];
  const uniqueUseCases = Array.from(new Set(requestedUseCases));
  const useCases =
    uniqueUseCases.length > 1
      ? uniqueUseCases.filter((item) => item !== 'general')
      : uniqueUseCases;
  const preference = options.preference || 'balanced';
  const [hardware, payload] = await Promise.all([
    getLemonadeHardware(signal),
    fetchJson<{ data?: LemonadeModel[] }>(`${LEMONADE_RUNTIME_BASE}/v1/models?show_all=true`, {
      signal,
    }),
  ]);
  const availableGb =
    typeof hardware.freeRamGb === 'number' && hardware.freeRamGb > 0
      ? hardware.freeRamGb
      : typeof hardware.ramGb === 'number'
        ? hardware.ramGb * 0.75
        : undefined;

  const compatibleModels = (Array.isArray(payload?.data) ? payload.data : [])
    // Lemonade is only the executor-capability inventory here. It does not
    // choose or rank models; BotConnector owns recommendations. The full
    // compatible list is still exposed so the user can deliberately choose
    // a smaller/lighter model to save storage or memory.
    .filter((model) => Boolean(model?.id) && lemonadeModelCompatibility(model, hardware))
    .map((model) => {
      const sizeGb =
        typeof model.size === 'number' && Number.isFinite(model.size) && model.size > 0
          ? model.size
          : undefined;
      const requiredGb = sizeGb ? sizeGb * 1.2 + 0.75 : undefined;
      const fit = fitFromMemory(requiredGb, availableGb);
      const backend =
        String(model.recipe_options?.llamacpp_backend || '') ||
        (model.recipe === 'ryzenai-llm' || model.recipe === 'flm'
          ? 'npu'
          : model.recipe || 'local');
      const useCaseResults = useCases.map((useCase) =>
        botConnectorUseCaseScore(model, useCase, preference),
      );
      const useCaseScore = useCaseResults.reduce((sum, result) => sum + result.score, 0);
      const reasons = [
        `Hardware fit: ${fit.label}.`,
        ...useCaseResults.map((result) => result.reason),
        `Preference: ${preference}.`,
      ];

      return {
        name: model.id,
        model_id: model.id,
        fit_label: fit.label,
        fit_level: fit.level,
        run_mode_label: backend.toUpperCase(),
        run_mode: backend,
        best_quant: quantFromCheckpoint(model.checkpoint) || undefined,
        memory_required_gb: requiredGb,
        download_size_gb: sizeGb,
        score:
          fit.score +
          botConnectorQualityCapacityScore(model, preference) +
          useCaseScore +
          (backend === 'npu' && preference !== 'quality' ? 20 : 0),
        runtime_label: `Runtime: Lemonade · ${model.recipe || 'local'}`,
        runtime: model.recipe || 'lemonade',
        confidence: requiredGb ? ('estimated' as const) : ('unknown' as const),
        downloaded: Boolean(model.downloaded),
        installed_path: model.id ? LEMONADE_MODEL_PREFIX + model.id : undefined,
        reasons,
      };
    })
    .filter((model) => model.fit_level !== 'unsupported');

  const candidates = compatibleModels
    .slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 15);

  const browseModels = compatibleModels.slice().sort((a, b) => {
    const aSize =
      typeof a.download_size_gb === 'number' ? a.download_size_gb : Number.POSITIVE_INFINITY;
    const bSize =
      typeof b.download_size_gb === 'number' ? b.download_size_gb : Number.POSITIVE_INFINITY;
    if (aSize !== bSize) return aSize - bSize;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const gpus = [...(hardware.nvidia || []), ...(hardware.amd || [])];
  const firstGpu = gpus[0];
  return {
    source: 'BotConnector advisor · Lemonade runtime',
    useCase: useCases[0] || 'general',
    useCases,
    preference,
    system: {
      cpu_name: hardware.cpu,
      total_ram_gb: hardware.ramGb,
      available_ram_gb: hardware.freeRamGb,
      gpu_name:
        gpus
          .map((gpu) => gpu.name)
          .filter(Boolean)
          .join(', ') || undefined,
      gpu_vram_gb: firstGpu?.memoryGb,
      gpus: gpus.map((gpu) => ({
        name: gpu.name,
        memory_gb: gpu.memoryGb,
        vram_gb: gpu.memoryGb,
      })),
      backend: hardware.backends?.join(', ') || 'Lemonade automatic',
      npu_name: hardware.npu?.name,
    },
    models: candidates,
    compatible_models: browseModels,
  };
}

export async function startDeviceRuntime(
  runtime = 'ollama',
  signal?: AbortSignal,
): Promise<unknown> {
  return deviceRequest('runtime.start', { runtime }, signal);
}

export async function installDeviceRuntime(
  backend = 'auto',
  signal?: AbortSignal,
): Promise<unknown> {
  const started = await deviceRequest<{ id?: string }>(
    'runtime.install.start',
    { backend },
    signal,
  );
  const jobId = String(started?.id || '');
  if (!jobId) throw new Error('Device CLI did not return a runtime install job id.');

  for (let attempt = 0; attempt < 3600; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const job = await deviceRequest<{
      status?: string;
      error?: string | null;
      result?: unknown;
    }>('runtime.install.status', { id: jobId }, signal);
    if (job?.status === 'completed') return job.result || job;
    if (job?.status === 'failed' || job?.status === 'cancelled') {
      throw new Error(job?.error || `Runtime install ${job.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Runtime installation timed out.');
}

export async function stopDeviceRuntime(
  runtime = 'ollama',
  signal?: AbortSignal,
): Promise<unknown> {
  return deviceRequest('runtime.stop', { runtime }, signal);
}

export async function probeLocalRuntime(signal?: AbortSignal) {
  if (deviceAccessToken) {
    try {
      const status = await deviceRuntimeStatus(signal);
      detectedRuntimeKind = (status?.runtime || 'device') as LocalRuntimeKind;
      detectedRuntimeBase = 'device://botconnector';
      return {
        available: status?.available !== false,
        runtime: detectedRuntimeKind,
        baseUrl: detectedRuntimeBase,
        message: status?.message,
      };
    } catch (error) {
      if (!deviceFallbackAllowed(error)) throw error;
    }
  }

  const runtime = await detectLocalRuntime(signal);
  return {
    available: true,
    runtime,
    baseUrl: runtime === 'lemonade' ? LEMONADE_RUNTIME_BASE : LOCAL_RUNTIME_BASE,
  };
}

export async function listLocalModels(signal?: AbortSignal): Promise<LocalInstalledModel[]> {
  if (deviceAccessToken) {
    try {
      const models = await deviceRequest<
        Array<{
          id?: string;
          name?: string;
          size?: number;
          runtime?: string;
          path?: string;
          recipe?: string;
        }>
      >('models.list', {}, signal);
      return (Array.isArray(models) ? models : [])
        .filter((model) => Boolean(model?.id || model?.name))
        .map((model) => {
          const runtime = String(model.runtime || 'device');
          const id = String(model.id || model.name || '');
          return {
            path: String(model.path || makeDeviceModelPath(runtime, id)),
            name: String(model.name || id),
            size: typeof model.size === 'number' ? model.size : undefined,
            runtime: runtime as LocalRuntimeKind,
            modelId: id,
            recipe: model.recipe || runtime,
          };
        });
    } catch (error) {
      if (!deviceFallbackAllowed(error)) throw error;
    }
  }

  const runtime = await detectLocalRuntime(signal);
  if (runtime === 'lemonade') return listLemonadeModels(signal);
  return postLocal<LocalInstalledModel[]>('installed', {}, { signal });
}

export async function getLocalRuntimeStatus(signal?: AbortSignal): Promise<LocalRuntimeStatus> {
  if (deviceAccessToken) {
    try {
      const status = await deviceRuntimeStatus(signal);
      return deviceStatusToLocalRuntimeStatus(status);
    } catch (error) {
      if (!deviceFallbackAllowed(error)) throw error;
    }
  }

  const runtime = await detectLocalRuntime(signal);
  if (runtime === 'lemonade') return getLemonadeRuntimeStatus(signal);
  return postLocal<LocalRuntimeStatus>('runtime-status', {}, { signal });
}

export async function getLocalHardware(signal?: AbortSignal): Promise<LocalHardwareInfo> {
  const runtime = await detectLocalRuntime(signal);
  if (runtime === 'lemonade') return getLemonadeHardware(signal);
  return postLocal<LocalHardwareInfo>('hardware', {}, { signal });
}

export async function getLocalHardwareRecommendations(
  signal?: AbortSignal,
  options: {
    useCase?: LocalAdvisorUseCase;
    useCases?: LocalAdvisorUseCase[];
    preference?: LocalAdvisorPreference;
  } = {},
): Promise<LocalHardwareRecommendations> {
  const runtime = await detectLocalRuntime(signal);
  const requestedUseCases =
    Array.isArray(options.useCases) && options.useCases.length
      ? options.useCases
      : [options.useCase || 'general'];
  const useCases = Array.from(new Set(requestedUseCases));
  const preference = options.preference || 'balanced';
  if (runtime === 'lemonade') {
    return getLemonadeRecommendations(signal, { useCases, preference });
  }
  return postLocal<LocalHardwareRecommendations>(
    'hardware-recommendations',
    { useCase: useCases[0] || 'general', useCases, preference },
    { signal },
  );
}

export async function verifyLocalModelState(
  modelPath: string,
  signal?: AbortSignal,
): Promise<LocalModelVerification> {
  if (!modelPath) throw new Error('Model lokal belum dipilih.');

  const deviceModel = parseDeviceModelPath(modelPath);
  if (deviceModel) {
    const [models, status] = await Promise.all([
      deviceRequest<Array<{ id?: string; name?: string; runtime?: string }>>(
        'models.list',
        {},
        signal,
      ),
      deviceRuntimeStatus(signal),
    ]);
    const installed = (Array.isArray(models) ? models : []).some(
      (model) =>
        String(model?.id || model?.name || '') === deviceModel.model &&
        (!model?.runtime || String(model.runtime) === deviceModel.runtime),
    );
    const loaded = Array.isArray(status?.loadedModels)
      ? status.loadedModels.includes(deviceModel.model)
      : String(status?.activeModel || '') === deviceModel.model;

    return {
      modelPath,
      runtime: deviceModel.runtime as LocalRuntimeKind,
      installed,
      loaded,
      verified: true,
      checkedAt: new Date().toISOString(),
    };
  }

  const lemonade = isLemonadeModelPath(modelPath);
  const runtime: LocalRuntimeKind = lemonade ? 'lemonade' : 'botconnector';
  const [installed, status] = lemonade
    ? await Promise.all([listLemonadeModels(signal), getLemonadeRuntimeStatus(signal)])
    : await Promise.all([
        postLocal<LocalInstalledModel[]>('installed', {}, { signal }),
        postLocal<LocalRuntimeStatus>('runtime-status', {}, { signal }),
      ]);
  const installedOnDevice = installed.some((model) => model.path === modelPath);
  const active = status?.process?.activeModel;
  const loaded =
    status?.process?.status === 'READY' &&
    active?.health === true &&
    active?.ggufPath === modelPath;

  return {
    modelPath,
    runtime,
    installed: installedOnDevice,
    loaded,
    verified: true,
    checkedAt: new Date().toISOString(),
  };
}

async function waitForLocalModelState(
  modelPath: string,
  predicate: (state: LocalModelVerification) => boolean,
  signal?: AbortSignal,
): Promise<LocalModelVerification> {
  let lastState: LocalModelVerification | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    lastState = await verifyLocalModelState(modelPath, signal);
    if (predicate(lastState)) return lastState;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Local runtime state verification timed out for ${modelPath}. Last state: installed=${String(
      lastState?.installed,
    )}, loaded=${String(lastState?.loaded)}.`,
  );
}

export async function installRecommendedLocalModel(
  modelId: string,
  signal?: AbortSignal,
): Promise<LocalModelVerification> {
  if (!modelId) throw new Error('Model lokal belum dipilih.');

  if (deviceAccessToken) {
    try {
      const started = await deviceRequest<{ id?: string; runtime?: string; model?: string }>(
        'models.pull.start',
        { model: modelId },
        signal,
      );
      const jobId = String(started?.id || '');
      if (!jobId) throw new Error('Device CLI did not return a model download job id.');

      for (let attempt = 0; attempt < 7200; attempt += 1) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const job = await deviceRequest<{
          status?: string;
          runtime?: string;
          model?: string;
          error?: string | null;
        }>('models.pull.status', { id: jobId }, signal);
        if (job?.status === 'completed') {
          const runtime = String(job.runtime || (await deviceRuntimeStatus(signal))?.runtime || 'device');
          const path = makeDeviceModelPath(runtime, String(job.model || modelId));
          return verifyLocalModelState(path, signal);
        }
        if (job?.status === 'failed' || job?.status === 'cancelled') {
          throw new Error(job?.error || `Model download ${job.status}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error('Model download timed out.');
    } catch (error) {
      if (!deviceFallbackAllowed(error)) throw error;
    }
  }

  await fetchJson(`${LEMONADE_RUNTIME_BASE}/v1/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_name: modelId, stream: false }),
    signal,
  });
  return waitForLocalModelState(
    `${LEMONADE_MODEL_PREFIX}${modelId}`,
    (state) => state.installed,
    signal,
  );
}

export async function unloadLocalModel(
  modelPath: string,
  signal?: AbortSignal,
): Promise<LocalModelVerification> {
  if (!modelPath) throw new Error('Model lokal belum dipilih.');

  const deviceModel = parseDeviceModelPath(modelPath);
  if (deviceModel) {
    await deviceRequest(
      'model.unload',
      { model: deviceModel.model, runtime: deviceModel.runtime },
      signal,
    );
    return waitForLocalModelState(modelPath, (state) => !state.loaded, signal);
  }

  if (isLemonadeModelPath(modelPath)) {
    const modelId = lemonadeModelId(modelPath);
    await fetchJson(`${LEMONADE_RUNTIME_BASE}/v1/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_name: modelId }),
      signal,
    });
    return waitForLocalModelState(modelPath, (state) => !state.loaded, signal);
  }

  const status = await getLocalRuntimeStatus(signal);
  const active = status?.process?.activeModel;
  const modelId = active?.displayName || active?.repoId || modelPath;
  await postPaired('model-unload', { modelId }, signal);
  return waitForLocalModelState(modelPath, (state) => !state.loaded, signal);
}

export async function uninstallLocalModel(
  modelPath: string,
  signal?: AbortSignal,
): Promise<LocalModelVerification> {
  if (!modelPath) throw new Error('Model lokal belum dipilih.');

  const deviceModel = parseDeviceModelPath(modelPath);
  if (deviceModel) {
    const before = await verifyLocalModelState(modelPath, signal);
    if (before.loaded) {
      await deviceRequest(
        'model.unload',
        { model: deviceModel.model, runtime: deviceModel.runtime },
        signal,
      );
    }
    await deviceRequest(
      'models.delete',
      { model: deviceModel.model, runtime: deviceModel.runtime },
      signal,
    );
    return waitForLocalModelState(
      modelPath,
      (state) => !state.loaded && !state.installed,
      signal,
    );
  }

  if (isLemonadeModelPath(modelPath)) {
    const modelId = lemonadeModelId(modelPath);
    const status = await getLemonadeRuntimeStatus(signal);
    if (status?.process?.activeModel?.ggufPath === modelPath) {
      await unloadLocalModel(modelPath, signal);
    }
    await fetchJson(`${LEMONADE_RUNTIME_BASE}/v1/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_name: modelId }),
      signal,
    });
    return waitForLocalModelState(modelPath, (state) => !state.loaded && !state.installed, signal);
  }

  const status = await getLocalRuntimeStatus(signal);
  if (status?.process?.activeModel?.ggufPath === modelPath) {
    await unloadLocalModel(modelPath, signal);
  }
  const directory = String(modelPath).replace(/[\/][^\/]+$/, '');
  if (!directory || directory === modelPath) {
    throw new Error('Direktori model lokal tidak dapat ditentukan.');
  }
  await postPaired('model-delete', { directory }, signal);
  return waitForLocalModelState(modelPath, (state) => !state.loaded && !state.installed, signal);
}

export async function installLocalRuntimeComponents(
  backend = 'auto',
  signal?: AbortSignal,
): Promise<unknown> {
  const runtime = await detectLocalRuntime(signal);
  if (runtime === 'lemonade') {
    return { runtime: 'lemonade', alreadyInstalled: true };
  }
  return postPaired('runtime-install', { backend }, signal);
}

export async function pairLocalRuntime(): Promise<string> {
  const runtime = await detectLocalRuntime();
  if (runtime === 'lemonade') return 'lemonade-origin-authorized';

  const current = pairingToken();
  if (current) return current;

  const started = await postLocal<{ pairingCode?: string }>('pair/start');
  const code = String(started?.pairingCode || '').trim();
  if (!code) throw new Error('Local Runtime tidak mengirim kode pairing.');

  const approved = window.confirm(
    `Hubungkan app.botconnector.id ke BotConnector Local Runtime di perangkat ini?\n\nKode pairing: ${code}\n\nPilih OK untuk mengizinkan chat dan pengelolaan model lokal.`,
  );
  if (!approved) {
    throw new Error('Pairing Local Runtime dibatalkan.');
  }

  const confirmed = await postLocal<{ paired?: boolean; token?: string }>('pair/confirm', {
    pairingCode: code,
  });
  const token = String(confirmed?.token || '');
  if (!confirmed?.paired || !token) {
    throw new Error('Pairing Local Runtime gagal.');
  }
  savePairingToken(token);
  return token;
}

async function postPaired<T = unknown>(
  action: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  await pairLocalRuntime();
  try {
    return await postLocal<T>(action, payload, { pairing: true, signal });
  } catch (error) {
    const status = (error as Error & { status?: number })?.status;
    if (status !== 401) throw error;
    savePairingToken('');
    await pairLocalRuntime();
    return postLocal<T>(action, payload, { pairing: true, signal });
  }
}

export async function ensureLocalModelReady(modelPath: string, signal?: AbortSignal) {
  if (!modelPath) throw new Error('Pilih model lokal terlebih dahulu.');

  const deviceModel = parseDeviceModelPath(modelPath);
  if (deviceModel) {
    const verification = await verifyLocalModelState(modelPath, signal);
    if (!verification.installed) {
      throw new Error('The selected local model is not installed on this device.');
    }
    if (!verification.loaded) {
      await deviceRequest(
        'model.load',
        { model: deviceModel.model, runtime: deviceModel.runtime },
        signal,
      );
      await waitForLocalModelState(
        modelPath,
        (state) => state.installed && state.loaded,
        signal,
      );
    }
    return getLocalRuntimeStatus(signal);
  }

  if (isLemonadeModelPath(modelPath)) {
    const modelId = lemonadeModelId(modelPath);
    const status = await getLemonadeRuntimeStatus(signal);
    if (
      status?.process?.status === 'READY' &&
      status?.process?.activeModel?.health === true &&
      status?.process?.activeModel?.ggufPath === modelPath
    ) {
      return status;
    }
    await fetchJson(`${LEMONADE_RUNTIME_BASE}/v1/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_name: modelId }),
      signal,
    });
    await waitForLocalModelState(modelPath, (state) => state.installed && state.loaded, signal);
    return getLemonadeRuntimeStatus(signal);
  }

  await pairLocalRuntime();
  const status = await getLocalRuntimeStatus(signal);
  const active = status?.process?.activeModel;
  if (
    status?.process?.status === 'READY' &&
    active?.health === true &&
    active?.ggufPath === modelPath
  ) {
    return status;
  }

  await postPaired('model-run', { modelPath }, signal);
  await waitForLocalModelState(modelPath, (state) => state.installed && state.loaded, signal);
  return getLocalRuntimeStatus(signal);
}

export async function localChat(
  messages: LocalMessage[],
  modelPath: string,
  signal?: AbortSignal,
): Promise<LocalChatResult> {
  const deviceModel = parseDeviceModelPath(modelPath);
  if (deviceModel) {
    return deviceRequest<LocalChatResult>(
      'chat.completions',
      {
        model: deviceModel.model,
        runtime: deviceModel.runtime,
        messages,
      },
      signal,
    );
  }

  if (isLemonadeModelPath(modelPath)) {
    const modelId = lemonadeModelId(modelPath);
    await ensureLocalModelReady(modelPath, signal);
    const result = await fetchJson<any>(`${LEMONADE_RUNTIME_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages,
        stream: false,
      }),
      signal,
    });
    return {
      content: result?.choices?.[0]?.message?.content || '',
      tool_calls: result?.choices?.[0]?.message?.tool_calls,
      usage: result?.usage,
    };
  }

  await probeLocalRuntime(signal);
  await ensureLocalModelReady(modelPath, signal);

  const requestId = crypto.randomUUID();
  activeRequestId = requestId;

  const abortListener = () => {
    void postLocal('chat-abort', { requestId }, { pairing: true }).catch(() => {});
  };
  signal?.addEventListener('abort', abortListener, { once: true });

  try {
    return await postPaired<LocalChatResult>('chat', { requestId, messages, tools: [] }, signal);
  } finally {
    signal?.removeEventListener('abort', abortListener);
    if (activeRequestId === requestId) activeRequestId = null;
  }
}

export async function abortActiveLocalChat() {
  const requestId = activeRequestId;
  if (!requestId) return false;
  await postPaired('chat-abort', { requestId }).catch(() => {});
  activeRequestId = null;
  return true;
}

export function localRuntimeBaseUrl() {
  return detectedRuntimeBase;
}

export function localRuntimeKind() {
  return detectedRuntimeKind;
}
