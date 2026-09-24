const LOCAL_RUNTIME_BASE = 'http://127.0.0.1:18764';
const LOCAL_API_BASE = `${LOCAL_RUNTIME_BASE}/api/botconnector/local`;
const PAIRING_STORAGE_KEY = 'botconnectorLocalPairingToken';

export type LocalInstalledModel = {
  path: string;
  name: string;
  size?: number;
  repoId?: string | null;
  quant?: string | null;
  capabilities?: Record<string, unknown>;
  installedAt?: string;
};

export type LocalRuntimeStatus = {
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

let activeRequestId: string | null = null;

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

export async function probeLocalRuntime(signal?: AbortSignal) {
  const response = await fetch(`${LOCAL_API_BASE}/health`, {
    method: 'GET',
    cache: 'no-store',
    mode: 'cors',
    signal,
  });
  const body = await parseJson(response);
  if (!response.ok || body?.available === false) {
    throw new Error(body?.error?.message || `BotConnector Local Runtime HTTP ${response.status}`);
  }
  return body;
}

export async function listLocalModels(signal?: AbortSignal): Promise<LocalInstalledModel[]> {
  return postLocal<LocalInstalledModel[]>('installed', {}, { signal });
}

export async function getLocalRuntimeStatus(signal?: AbortSignal): Promise<LocalRuntimeStatus> {
  return postLocal<LocalRuntimeStatus>('runtime-status', {}, { signal });
}

export async function pairLocalRuntime(): Promise<string> {
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
    await pairLocalRuntime();
    return postLocal<T>(action, payload, { pairing: true, signal });
  }
}

export async function ensureLocalModelReady(modelPath: string, signal?: AbortSignal) {
  if (!modelPath) throw new Error('Pilih model lokal terlebih dahulu.');
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
  return getLocalRuntimeStatus(signal);
}

export async function localChat(
  messages: LocalMessage[],
  modelPath: string,
  signal?: AbortSignal,
): Promise<LocalChatResult> {
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
  return LOCAL_RUNTIME_BASE;
}
