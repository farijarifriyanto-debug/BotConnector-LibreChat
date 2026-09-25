const assert = require('node:assert/strict');
const test = require('node:test');
const { LlamaSwap } = require('./llama-swap.cjs');

function makeSwap(entry) {
  const swap = new LlamaSwap({
    baseDir: 'C:\\temp\\botconnector-test',
    modelsDir: 'C:\\temp\\models',
    getLlamaServer: async () => 'llama-server.exe',
    sidecars: {},
  });
  swap.entries = [entry];
  swap.profiles = [{ id: entry.profileId, description: entry.name }];
  swap.ensureRunning = async () => ({ models: [entry] });
  return swap;
}

test('canonical active model state contains runtime identity and endpoint', () => {
  const entry = { id: 'bc-spark', profileId: 'model-spark', name: 'Spark X2.5 · Q4_K_M', repoId: 'XHToken/Spark-X2.5-4B-GGUF', quant: 'Q4_K_M', path: 'C:\\models\\spark.gguf', projector: null, capabilities: { chat: true } };
  const state = makeSwap(entry).entryState(entry, 'STARTING', { startedAt: '2026-09-16T00:00:00.000Z' });
  assert.deepEqual({ status: state.status, modelId: state.modelId, repoId: state.repoId, quantization: state.quantization, ggufPath: state.ggufPath, profileId: state.profileId, endpoint: state.endpoint, health: state.health }, {
    status: 'STARTING', modelId: 'bc-spark', repoId: 'XHToken/Spark-X2.5-4B-GGUF', quantization: 'Q4_K_M', ggufPath: 'C:\\models\\spark.gguf', profileId: 'model-spark', endpoint: 'http://127.0.0.1:11435', health: false,
  });
});

test('run same model is idempotent when health is already ready', async () => {
  const entry = { id: 'bc-spark', profileId: 'model-spark', name: 'Spark', path: 'C:\\models\\spark.gguf', capabilities: {} };
  const swap = makeSwap(entry);
  swap.lifecycle = { status: 'READY', activeModel: swap.entryState(entry, 'READY', { health: true }), health: true };
  let warmups = 0;
  swap.warmModel = async () => { warmups += 1; };
  swap.probeReady = async () => ({ ready: true });
  const result = await swap.runModel(entry.path);
  assert.equal(result.status, 'READY');
  assert.equal(warmups, 0);
});

test('run transitions STARTING to READY only after readiness probe', async () => {
  const entry = { id: 'bc-spark', profileId: 'model-spark', name: 'Spark', path: 'C:\\models\\spark.gguf', capabilities: {} };
  const swap = makeSwap(entry);
  let activated = false;
  let warmed = false;
  swap.activateProfileInternal = async () => { activated = true; };
  swap.warmModel = async () => { warmed = true; };
  swap.probeReady = async () => ({ ready: activated && warmed, active: { pid: 42 } });
  const result = await swap.runModel(entry.path);
  assert.equal(result.status, 'READY');
  assert.equal(result.activeModel.health, true);
  assert.equal(result.activeModel.pid, 42);
});

test('invalid model request is reported as FAILED instead of remaining STARTING', async () => {
  const entry = { id: 'bc-spark', profileId: 'model-spark', name: 'Spark', path: 'C:\\models\\spark.gguf', capabilities: {} };
  const swap = makeSwap(entry);
  await assert.rejects(() => swap.runModel('C:\\models\\missing.gguf'), /belum terpasang/);
  assert.equal(swap.lifecycle.status, 'FAILED');
  assert.match(swap.lifecycle.error, /belum terpasang/);
});

test('model switch restores the previous READY model when the new model fails', async () => {
  const a = { id: 'bc-a', profileId: 'model-a', name: 'Model A', path: 'C:\\models\\a.gguf', capabilities: {} };
  const b = { id: 'bc-b', profileId: 'model-b', name: 'Model B', path: 'C:\\models\\b.gguf', capabilities: {} };
  const swap = makeSwap(a);
  swap.entries = [a, b];
  swap.ensureRunning = async () => ({ models: [a, b] });
  swap.profiles = [{ id: a.profileId }, { id: b.profileId }];
  swap.lifecycle = { status: 'READY', activeModel: swap.entryState(a, 'READY', { health: true }), health: true };
  swap.activateProfileInternal = async () => {};
  swap.warmModel = async () => {};
  swap.waitForReady = async entry => {
    if (entry.id === b.id) throw new Error('fixture B gagal start');
    return { active: { pid: 77 } };
  };
  await assert.rejects(() => swap.runModel(b.path), /fixture B gagal/);
  assert.equal(swap.lifecycle.status, 'READY');
  assert.equal(swap.lifecycle.activeModel.modelId, a.id);
  assert.equal(swap.lifecycle.activeModel.health, true);
  assert.equal(swap.lifecycle.recoveredFrom, b.id);
});

test('runtime crash invalidates READY state from the observed runtime', async () => {
  const entry = { id: 'bc-a', profileId: 'model-a', name: 'Model A', path: 'C:\\models\\a.gguf', capabilities: {} };
  const swap = makeSwap(entry);
  swap.lifecycle = { status: 'READY', activeModel: swap.entryState(entry, 'READY', { health: true }), health: true };
  swap.sidecars = { status: async () => ({ running: true }) };
  swap.runningModels = async () => [];
  swap.getProfiles = async () => ({ active: null, profiles: swap.profiles });
  const result = await swap.status();
  assert.equal(result.status, 'FAILED');
  assert.equal(result.activeModel.status, 'FAILED');
  assert.equal(result.activeModel.health, false);
});

test('runtime status reconstructs the active model after sidecar restart', async () => {
  const entry = { id: 'bc-a', profileId: 'model-a', name: 'Model A', path: 'C:\\models\\a.gguf', capabilities: {} };
  const swap = makeSwap(entry);
  swap.lifecycle = { status: 'STOPPED', activeModel: null, health: false };
  swap.sidecars = { status: async () => ({ running: true }) };
  swap.runningModels = async () => [{ model: entry.id, state: 'ready', pid: 88 }];
  swap.getProfiles = async () => ({ active: entry.profileId, profiles: swap.profiles });
  const result = await swap.status();
  assert.equal(result.status, 'READY');
  assert.equal(result.activeModel.modelId, entry.id);
  assert.equal(result.activeModel.health, true);
});
