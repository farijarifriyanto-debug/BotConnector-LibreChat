const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const catalog = require('./local/catalog.cjs');
const { DownloadManager } = require('./local/downloads.cjs');
const { RuntimeManager } = require('./local/runtime-manager.cjs');
const { SidecarManager } = require('./local/sidecars.cjs');
const { LlamaSwap } = require('./local/llama-swap.cjs');
const { scanInstalled } = require('./local/installed.cjs');
const { detectHardware } = require('./local/hardware.cjs');
const { LocalSettings } = require('./local/settings.cjs');
const { createWebServer } = require('./local/web-server.cjs');
const { ToolRegistry } = require('./local/tools.cjs');

const HOST = '127.0.0.1';
const PORT = Number(process.env.BOTCONNECTOR_UI_PORT || 18763);
const WEB_PORT = Number(process.env.BOTCONNECTOR_WEB_PORT || 18764);
const localServiceMode = process.argv.includes('--local-service');
const developmentMode = !app.isPackaged;
const SWAP_PORT = 11435;
const LLMFIT_PORT = 18766;
const ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const endpoint = process.env.BOTCONNECTOR_CORE_URL || `http://${HOST}:${PORT}`;
const webEndpoint = `http://${HOST}:${WEB_PORT}`;
let backend = null;
let windowRef = null;
let localWeb = null;
let settings = null;
let downloads = null;
let runtimes = null;
let sidecars = null;
let swap = null;
let toolRegistry = null;
const chatControllers = new Map();
const abortedChatIds = new Set();
const localHandlers = new Map();
let quitRequested = false;

function emit(channel, payload) {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send(channel, payload);
  localWeb?.publish(channel, payload);
  if (channel === 'download:progress' && payload?.status === 'completed' && swap) swap.prepareConfig().catch(() => {});
}

function registerLocalApi(channel, handler) {
  localHandlers.set(channel, handler);
}

async function llmfitApi(pathname) {
  const response = await fetch(`http://${HOST}:${LLMFIT_PORT}${pathname}`, { signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `llmfit mengembalikan HTTP ${response.status}.`);
  return data;
}

async function ensureLlmfit() {
  const status = await sidecars.status('llmfit');
  if (!status.installed) throw new Error('llmfit belum dipasang. Buka tab Runtime lalu pilih “Pasang semua komponen”.');
  if (!status.running) {
    const binary = status.binary;
    await sidecars.start('llmfit', ['serve', '--host', HOST, '--port', String(LLMFIT_PORT)], LLMFIT_PORT, path.dirname(binary));
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await llmfitApi('/api/v1/system'); } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  const logs = sidecars.logs('llmfit').slice(-8).join('\n');
  throw new Error(`Layanan rekomendasi llmfit tidak siap.${logs ? `\n${logs}` : ''}`);
}

function registerLocalModelsApi() {
  registerLocalApi('local:catalog-search', query => catalog.searchCatalog(query || {}));
  registerLocalApi('local:model-details', async repoId => catalog.modelDetails(repoId, await detectHardware()));
  registerLocalApi('local:hardware', () => detectHardware());
  registerLocalApi('local:installed', () => scanInstalled(settings.get('modelsDir')));
  registerLocalApi('local:downloads', () => downloads.list());
  registerLocalApi('local:storage', () => ({ modelsDir: settings.get('modelsDir') }));
  registerLocalApi('local:runtime-status', async () => ({
    process: await swap.status(),
    managed: await runtimes.verifyInstalled(),
    components: await sidecars.allStatus(),
    backend: settings.get('runtimeBackend'),
  }));
  registerLocalApi('local:runtime-install', async (backendName = 'auto') => {
    const selectedBackend = ['auto', 'cpu', 'vulkan', 'cuda12', 'cuda13'].includes(String(backendName)) ? String(backendName) : 'auto';
    await settings.set('runtimeBackend', selectedBackend);
    let managed = await runtimes.verifyInstalled();
    if (!managed.verified) {
      await swap.unloadAll().catch(() => {});
      sidecars.stop('llama-swap');
      managed = await runtimes.install({ backend: selectedBackend });
    }
    const installed = {};
    for (const name of ['llama-swap', 'llmfit']) {
      const status = await sidecars.status(name);
      installed[name] = status.installed ? { binary: status.binary, existing: true } : await sidecars.install(name);
    }
    const config = await swap.prepareConfig();
    return { managed, installed, models: config.models.length };
  });
  registerLocalApi('local:hardware-recommendations', async () => {
    const system = await ensureLlmfit();
    const recommendations = await llmfitApi('/api/v1/models/top?limit=15&min_fit=marginal&sort=score&runtime=llamacpp');
    return { ...recommendations, system: system.system || recommendations.system || null, node: system.node || recommendations.node || null };
  });
  registerLocalApi('local:model-download', payload => downloads.start(payload || {}));
  registerLocalApi('local:download-pause', id => ({ ok: downloads.pause(String(id || '')) }));
  registerLocalApi('local:download-resume', id => ({ ok: downloads.resume(String(id || '')) }));
  registerLocalApi('local:download-cancel', id => ({ ok: downloads.cancel(String(id || '')) }));
  registerLocalApi('local:model-delete', async directory => {
    const root = path.resolve(settings.get('modelsDir'));
    const target = path.resolve(String(directory || ''));
    if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error('Folder model di luar lokasi penyimpanan BotConnector.');
    await swap.unloadAll();
    await fsp.rm(target, { recursive: true, force: true });
    await swap.prepareConfig();
    return scanInstalled(root);
  });
  registerLocalApi('local:model-run', modelPath => swap.activateModel(String(modelPath || '')));
  registerLocalApi('local:model-unload', modelId => swap.unload(String(modelId || '')));
  registerLocalApi('local:profile-activate', name => swap.activateProfile(String(name || '')));
  registerLocalApi('local:runtime-stop', () => swap.unloadAll());
  registerLocalApi('local:tools-list', () => toolRegistry.list());
  registerLocalApi('local:tools-schemas', () => toolRegistry.schemas());
  registerLocalApi('local:tool-set-enabled', ({ id, enabled } = {}) => toolRegistry.setEnabled(id, enabled));
  registerLocalApi('local:tool-execute', ({ name, arguments: args, approved } = {}) => toolRegistry.invoke(name, args || {}, { approved: Boolean(approved) }));
  registerLocalApi('local:mcp-register', definition => toolRegistry.registerMcp(definition || {}));
  registerLocalApi('local:mcp-servers', () => toolRegistry.mcpStatus());
  registerLocalApi('local:mcp-tool-enable', ({ id, enabled } = {}) => toolRegistry.setEnabled(id, enabled));
  registerLocalApi('local:chat-abort', requestId => {
    const id = String(requestId || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { aborted: false };
    const controller = chatControllers.get(id);
    if (!controller) { abortedChatIds.add(id); return { aborted: true }; }
    controller.abort();
    return { aborted: true };
  });
  registerLocalApi('local:chat', async ({ messages, requestId, tools }) => {
    const id = String(requestId || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('ID permintaan chat lokal tidak valid.');
    const runtime = await swap.status();
    if (runtime.status !== 'READY' || !runtime.activeModel?.health) throw new Error('Model lokal belum READY. Buka Models · Installed lalu pilih Run pada model yang ingin digunakan.');
    const controller = new AbortController();
    chatControllers.set(id, controller);
    if (abortedChatIds.delete(id)) controller.abort();
    try { return await swap.chat(Array.isArray(messages) ? messages : [], { signal: controller.signal, tools: Array.isArray(tools) ? tools : [] }); }
    finally { chatControllers.delete(id); }
  });
}

function executablePath() {
  const name = process.platform === 'win32' ? 'botconnector.exe' : 'botconnector';
  if (app.isPackaged) return path.join(process.resourcesPath, name);
  return path.join(ROOT, 'target', 'debug', name);
}

async function serverReady() {
  try {
    const response = await fetch(`${endpoint}/api/botconnector/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const health = await response.json();
    return health.product === 'BotConnector';
  } catch { return false; }
}

async function startCore() {
  if (await serverReady()) return;
  const executable = executablePath();
  if (!fs.existsSync(executable)) throw new Error(`Core BotConnector belum ditemukan di ${executable}. Jalankan cargo build terlebih dahulu.`);
  backend = spawn(executable, ['--serve', `${HOST}:${PORT}`, '--no-open'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, BOTCONNECTOR_UI_PORT: String(PORT) },
  });
  backend.once('error', error => {
    if (windowRef && !windowRef.isDestroyed()) dialog.showErrorBox('BotConnector tidak dapat dijalankan', error.message);
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await serverReady()) return;
    if (backend.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  backend.kill();
  backend = null;
  throw new Error('Core BotConnector tidak siap. Periksa build Rust dan coba lagi.');
}

function localAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === HOST && Number(url.port) === WEB_PORT;
  } catch { return false; }
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#f2f4ef',
    title: 'BotConnector',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).protocol === 'https:') shell.openExternal(url).catch(() => {}); } catch { /* Reject malformed destinations. */ }
    return { action: 'deny' };
  });
  windowRef.webContents.on('will-navigate', (event, url) => { if (!localAppUrl(url)) event.preventDefault(); });
  windowRef.loadURL(webEndpoint);
  windowRef.on('closed', () => { windowRef = null; });
}

app.whenReady().then(async () => {
  app.setAppUserModelId('id.botconnector.workspace');
  try {
    const userData = app.getPath('userData');
    settings = new LocalSettings(userData);
    await fsp.mkdir(settings.get('modelsDir'), { recursive: true });
    downloads = new DownloadManager({ getModelsDir: () => settings.get('modelsDir'), getToken: () => process.env.HF_TOKEN || '', emit });
    runtimes = new RuntimeManager({ baseDir: path.join(userData, 'runtimes', 'llama.cpp'), emit });
    sidecars = new SidecarManager({ baseDir: path.join(userData, 'runtimes', 'components'), emit });
    swap = new LlamaSwap({
      baseDir: path.join(userData, 'runtimes', 'llama-swap'),
      modelsDir: settings.get('modelsDir'),
      getLlamaServer: async () => (await runtimes.verifyInstalled()).binary,
      sidecars,
      emit,
    });
    toolRegistry = new ToolRegistry({ modelsDir: settings.get('modelsDir'), emit });
    registerLocalModelsApi();
    localWeb = createWebServer({
      coreUrl: endpoint,
      handlers: localHandlers,
      host: HOST,
      port: WEB_PORT,
      allowedOrigins: developmentMode ? String(process.env.BOTCONNECTOR_ALLOWED_WEB_ORIGINS || '').split(',') : [],
      development: developmentMode,
      onShutdown: () => app.quit(),
    });
    await localWeb.listen();
    if (!localServiceMode) {
      await startCore();
      if (process.argv.includes('--browser')) shell.openExternal(webEndpoint).catch(() => {});
      else createWindow();
    }
    // Start only previously installed managers; never download binaries silently.
    if ((await sidecars.status('llama-swap')).installed && (await runtimes.verifyInstalled()).verified) {
      swap.start().catch(error => emit('runtime:status', { error: error.message }));
    }
    if ((await sidecars.status('llmfit')).installed) ensureLlmfit().catch(() => {});
  } catch (error) {
    dialog.showErrorBox('BotConnector gagal dibuka', error.message || String(error));
    app.quit();
  }
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && backend) createWindow(); });
app.on('before-quit', event => {
  if (quitRequested) return;
  event.preventDefault();
  quitRequested = true;
  (async () => {
    await swap?.unloadAll().catch(() => {});
    await toolRegistry?.close().catch(() => {});
    sidecars?.stopAll();
    await localWeb?.close().catch(() => {});
    if (backend && backend.exitCode === null) backend.kill();
    app.quit();
  })();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
