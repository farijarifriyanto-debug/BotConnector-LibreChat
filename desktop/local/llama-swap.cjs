const fs = require('node:fs/promises');
const path = require('node:path');

const BASE_URL = 'http://127.0.0.1:11435';
const CHAT_ALIAS = 'botconnector-chat';

function slug(value) {
  const result = String(value || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72);
  return result || 'model';
}

function quote(value) { return `"${String(value).replace(/"/g, '\\"')}"`; }

function parseResponse(text) {
  try { return JSON.parse(text); } catch { return { message: text }; }
}

class LlamaSwap {
  constructor({ baseDir, modelsDir, getLlamaServer, sidecars, emit = () => {} }) {
    this.baseDir = baseDir;
    this.modelsDir = modelsDir;
    this.getLlamaServer = getLlamaServer;
    this.sidecars = sidecars;
    this.emit = emit;
    this.configFile = path.join(baseDir, 'llama-swap.json');
    this.profiles = [];
    this.entries = [];
    this.lifecycle = { status: 'STOPPED', activeModel: null, endpoint: BASE_URL, health: false };
    this.lifecycleLock = Promise.resolve();
  }

  setLifecycle(state) {
    const next = { ...this.lifecycle, ...state, endpoint: BASE_URL };
    if (JSON.stringify(next) === JSON.stringify(this.lifecycle)) return this.lifecycle;
    this.lifecycle = next;
    this.emit('runtime:status', this.lifecycle);
    return this.lifecycle;
  }

  withLifecycleLock(operation) {
    const run = this.lifecycleLock.catch(() => {}).then(operation);
    this.lifecycleLock = run.catch(() => {});
    return run;
  }

  entryState(entry, status = 'STOPPED', extra = {}) {
    return {
      status,
      modelId: entry?.id || null,
      repoId: entry?.repoId || null,
      displayName: entry?.name || null,
      quantization: entry?.quant || null,
      ggufPath: entry?.path || null,
      projectorPath: entry?.projector || null,
      backend: 'llama.cpp',
      runtime: 'llama-swap',
      profileId: entry?.profileId || null,
      internalRuntimeId: entry?.id || null,
      endpoint: BASE_URL,
      pid: null,
      startedAt: extra.startedAt || null,
      health: false,
      capabilities: entry?.capabilities || {},
      ...extra,
    };
  }

  async api(pathname, options = {}) {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: options.signal || AbortSignal.timeout(30000),
    });
    const text = await response.text();
    const data = parseResponse(text);
    if (!response.ok) throw new Error(data.error || data.message || `llama-swap HTTP ${response.status}`);
    return data;
  }

  async prepareConfig() {
    const serverBinary = await this.getLlamaServer();
    if (!serverBinary) throw new Error('Runtime llama.cpp belum dipasang. Pasang runtime dari tab Runtime.');
    const scanned = await require('./installed.cjs').scanInstalled(this.modelsDir);
    const byDir = new Map();
    for (const item of scanned) {
      const group = byDir.get(item.dir) || [];
      group.push(item);
      byDir.set(item.dir, group);
    }
    const models = {};
    const profiles = {};
    const entries = [];
    for (const [dir, files] of byDir) {
      files.sort((a, b) => a.path.localeCompare(b.path));
      const main = files.find(item => !/(mmproj|projector)/i.test(item.name));
      if (!main) continue;
      const modelId = `bc-${slug(`${main.repoId || path.basename(dir)}-${main.quant || path.basename(dir)}`)}`;
      const profileId = `model-${slug(`${main.repoId || path.basename(dir)}-${main.quant || path.basename(dir)}`)}`;
      const displayName = `${main.repoId || main.name}${main.quant ? ` · ${main.quant}` : ''}`;
      const command = [quote(serverBinary), '--port', '${PORT}', '-m', quote(main.path), '-ngl', '999', '-c', '8192', '--jinja'].join(' ');
      models[modelId] = { name: displayName, description: `Model lokal BotConnector: ${displayName}`, cmd: command, ttl: 600 };
      profiles[profileId] = { description: `Gunakan ${displayName}`, pins: { [CHAT_ALIAS]: modelId } };
      entries.push({ id: modelId, profileId, name: displayName, path: main.path, repoId: main.repoId, quant: main.quant, dir, capabilities: main.capabilities || {} });
    }

    await fs.mkdir(this.baseDir, { recursive: true });
    const config = { models, profiles };
    await fs.writeFile(this.configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    this.entries = entries;
    this.profiles = Object.entries(profiles).map(([id, profile]) => ({ id, description: profile.description, modelId: profile.pins[CHAT_ALIAS] }));
    return { models: entries, profiles: this.profiles, configFile: this.configFile };
  }

  async start() {
    const prepared = await this.prepareConfig();
    const binary = await this.sidecars.binary('llama-swap');
    if (!binary) throw new Error('llama-swap belum dipasang. Buka Runtime lalu pasang komponen.');
    await this.sidecars.start('llama-swap', ['--config', this.configFile, '--listen', '127.0.0.1:11435'], 11435, this.baseDir);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const health = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(700) });
        if (health.ok) return { running: true, port: 11435, ...prepared };
      } catch { /* Wait for the proxy to bind its local port. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const logs = this.sidecars.logs('llama-swap').slice(-8).join('\n');
    this.sidecars.stop('llama-swap');
    throw new Error(`llama-swap tidak siap.${logs ? `\n${logs}` : ''}`);
  }

  async ensureRunning() {
    const status = await this.sidecars.status('llama-swap');
    if (!status.running) return this.start();
    const prepared = await this.prepareConfig();
    return { running: true, port: 11435, ...prepared };
  }

  async runningModels() {
    try {
      const value = await this.api('/running');
      if (Array.isArray(value)) return value;
      if (Array.isArray(value.running)) return value.running;
      if (Array.isArray(value.models)) return value.models;
      return [];
    } catch { return []; }
  }

  async getProfiles() {
    try {
      const value = await this.api('/api/profiles');
      const active = value.active ?? value.activeProfile ?? value.active_profile ?? null;
      return { ...value, active, profiles: Array.isArray(value.profiles) ? value.profiles : this.profiles };
    } catch { return { active: null, profiles: this.profiles }; }
  }

  async activateProfileInternal(name) {
    await this.ensureRunning();
    if (!this.profiles.some(profile => profile.id === name)) throw new Error('Profil model tidak ditemukan.');
    return this.api('/api/profiles/active', { method: 'PUT', body: JSON.stringify({ name }) });
  }

  async activateProfile(name) {
    return this.withLifecycleLock(() => this.activateProfileInternal(name));
  }

  async activateModel(modelPath) {
    return this.runModel(modelPath);
  }

  async probeReady(entry) {
    try {
      const running = await this.api('/running', { signal: AbortSignal.timeout(5000) });
      const rows = Array.isArray(running) ? running : running.running || running.models || [];
      const active = rows.find(item => String(item?.model || item?.id || item?.name || '') === entry.id);
      const listed = await this.api('/v1/models', { signal: AbortSignal.timeout(5000) });
      const model = (listed.data || []).find(item => item.id === entry.id);
      const state = String(active?.state || model?.status?.value || '').toLowerCase();
      return { ready: Boolean(active && (!state || ['ready', 'running', 'loaded'].includes(state)) && (!model || ['ready', 'running', 'loaded'].includes(String(model.status?.value || '').toLowerCase()))), active, model };
    } catch (error) {
      return { ready: false, error: String(error.message || error) };
    }
  }

  async warmModel() {
    await this.api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: CHAT_ALIAS, messages: [{ role: 'user', content: ' ' }], max_tokens: 1, stream: false, temperature: 0 }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  }

  async waitForReady(entry) {
    let last = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      last = await this.probeReady(entry);
      if (last.ready) return last;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Model tidak mencapai READY pada ${BASE_URL}. ${last?.error || 'API belum melaporkan model aktif.'}`);
  }

  async runModel(modelPath) {
    return this.withLifecycleLock(async () => {
      const prepared = await this.ensureRunning();
      const entry = prepared.models.find(model => path.resolve(model.path) === path.resolve(String(modelPath || '')));
      if (!entry) {
        const error = 'Model belum terpasang atau bukan berkas GGUF BotConnector.';
        // Resolve failures occur before a transition; never invalidate a
        // healthy active model because the requested path is stale/invalid.
        if (this.lifecycle.status !== 'READY' || !this.lifecycle.activeModel) {
          this.setLifecycle({ status: 'FAILED', activeModel: null, health: false, error });
        }
        throw new Error(error);
      }
      const current = this.lifecycle.activeModel;
      if (current?.ggufPath && path.resolve(current.ggufPath) === path.resolve(entry.path) && current.status === 'READY') {
        const health = await this.probeReady(entry);
        if (health.ready) return this.lifecycle;
      }
      const previousEntry = current?.ggufPath ? this.entries.find(item => path.resolve(item.path) === path.resolve(current.ggufPath)) : null;
      if (current?.status === 'READY' && current.modelId !== entry.id) {
        this.setLifecycle({ status: 'SWITCHING', activeModel: current, error: null });
        await this.unloadAllInternal();
      }
      const startedAt = new Date().toISOString();
      this.setLifecycle({ status: 'STARTING', activeModel: this.entryState(entry, 'STARTING', { startedAt }), error: null });
      try {
        await this.activateProfileInternal(entry.profileId);
        await this.warmModel();
        const health = await this.waitForReady(entry);
        return this.setLifecycle({ status: 'READY', activeModel: this.entryState(entry, 'READY', { startedAt, health: true, pid: health.active?.pid || health.active?.process_id || null }) });
      } catch (error) {
        const message = String(error.message || error);
        this.setLifecycle({ status: 'FAILED', activeModel: this.entryState(entry, 'FAILED', { startedAt, health: false, error: message }), error: message });
        if (previousEntry && previousEntry.id !== entry.id) {
          try {
            const restoreStartedAt = new Date().toISOString();
            this.setLifecycle({ status: 'STARTING', activeModel: this.entryState(previousEntry, 'STARTING', { startedAt: restoreStartedAt }), error: `Pemulihan ${previousEntry.name}` });
            await this.activateProfileInternal(previousEntry.profileId);
            await this.warmModel();
            const restored = await this.waitForReady(previousEntry);
            this.setLifecycle({ status: 'READY', activeModel: this.entryState(previousEntry, 'READY', { startedAt: restoreStartedAt, health: true, pid: restored.active?.pid || restored.active?.process_id || null }), error: null, recoveredFrom: entry.id });
          } catch (restoreError) {
            const restoreMessage = String(restoreError.message || restoreError);
            this.setLifecycle({ status: 'FAILED', activeModel: this.entryState(entry, 'FAILED', { startedAt, health: false, error: `${message}; pemulihan gagal: ${restoreMessage}` }), error: `${message}; pemulihan gagal: ${restoreMessage}` });
          }
        }
        throw error;
      }
    });
  }

  async unloadAllInternal() {
    try {
      const health = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1500) });
      if (health.ok) await this.api('/api/models/unload', { method: 'POST', body: '{}' });
    } catch { /* The sidecar may already be stopped. */ }
    const running = await this.runningModels();
    this.setLifecycle({ status: 'STOPPED', activeModel: null, health: false, error: null });
    return { ok: true, running };
  }

  async unloadAll() {
    return this.withLifecycleLock(() => this.unloadAllInternal());
  }

  async unload(modelId) {
    return this.withLifecycleLock(async () => {
      const result = await this.api(`/api/models/unload/${encodeURIComponent(modelId)}`, { method: 'POST', body: '{}' });
      const running = await this.runningModels();
      if (!running.length || this.lifecycle.activeModel?.modelId === modelId) this.setLifecycle({ status: 'STOPPED', activeModel: null, health: false, error: null });
      return { ...result, running };
    });
  }

  async status() {
    const sidecar = await this.sidecars.status('llama-swap');
    const [loaded, profileState] = await Promise.all([this.runningModels(), this.getProfiles()]);
    const active = profileState.active || profileState.activeProfile || null;
    const loadedReady = loaded.find(item => String(item?.state || '').toLowerCase() === 'ready') || loaded[0] || null;
    if (!sidecar.running && ['READY', 'STARTING', 'SWITCHING'].includes(this.lifecycle.status)) {
      const message = 'llama-swap berhenti; runtime lokal tidak tersedia.';
      const activeModel = this.lifecycle.activeModel ? { ...this.lifecycle.activeModel, status: 'FAILED', health: false, error: message } : null;
      this.setLifecycle({ status: 'FAILED', activeModel, health: false, error: message });
    } else if (loadedReady && !['STARTING', 'SWITCHING'].includes(this.lifecycle.status)) {
      const entry = this.entries.find(item => item.id === (loadedReady.model || loadedReady.id || loadedReady.name));
      if (entry && (!this.lifecycle.activeModel || this.lifecycle.activeModel.modelId !== entry.id)) this.setLifecycle({ status: 'READY', activeModel: this.entryState(entry, 'READY', { health: true }), error: null });
    } else if (!loaded.length && this.lifecycle.status === 'READY') {
      const message = 'Proses llama-server berhenti atau model tidak lagi aktif.';
      const activeModel = this.lifecycle.activeModel ? { ...this.lifecycle.activeModel, status: 'FAILED', health: false, error: message } : null;
      this.setLifecycle({ status: 'FAILED', activeModel, health: false, error: message });
    }
    return { running: Boolean(sidecar.running || loaded.length), port: 11435, loaded, active, profiles: this.profiles, status: this.lifecycle.status, health: this.lifecycle.health, lifecycle: this.lifecycle, activeModel: this.lifecycle.activeModel };
  }

  async chat(messages, { signal, tools = [] } = {}) {
    await this.ensureRunning();
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CHAT_ALIAS, messages, tools, stream: false, temperature: 0.7 }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]) : AbortSignal.timeout(10 * 60 * 1000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `llama-swap mengembalikan HTTP ${response.status}.`);
    return {
      content: data.choices?.[0]?.message?.content || '',
      tool_calls: data.choices?.[0]?.message?.tool_calls || [],
      usage: data.usage || null,
    };
  }
}

module.exports = { LlamaSwap, BASE_URL, CHAT_ALIAS };
