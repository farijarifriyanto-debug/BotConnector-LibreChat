import { useCallback, useEffect, useState } from 'react';
import { useRecoilState } from 'recoil';
import {
  ensureLocalModelReady,
  getLocalRuntimeStatus,
  listLocalModels,
  localRuntimeBaseUrl,
  probeLocalRuntime,
  unloadLocalModel,
  verifyLocalModelState,
} from '~/utils/botconnectorLocalRuntime';
import type { LocalInstalledModel } from '~/utils/botconnectorLocalRuntime';
import LocalModelAdvisor from './LocalModelAdvisor';
import store from '~/store';
import { cn } from '~/utils';

type LocalState =
  | 'idle'
  | 'checking'
  | 'offline'
  | 'connected'
  | 'loading'
  | 'unloading'
  | 'ready'
  | 'error';

const COPY = {
  cloud: 'Cloud',
  local: 'Local',
  noLocalModel: 'No local model',
  installRuntime: 'Install Runtime',
  manageLocal: 'Manage Local',
  deviceFit: 'Device fit',
  deviceFitShort: 'Fit',
  deviceFitTitle: 'Scan this device and find local models that fit its CPU, RAM, GPU, and VRAM.',
};

function statusLabel(state: LocalState) {
  switch (state) {
    case 'checking':
      return 'Checking…';
    case 'loading':
      return 'Loading…';
    case 'unloading':
      return 'Unloading…';
    case 'ready':
      return 'Verified loaded';
    case 'offline':
      return 'Runtime offline';
    case 'error':
      return 'Local error';
    default:
      return 'Connected';
  }
}

function modelLabel(model: LocalInstalledModel) {
  const repo = model.repoId ? model.repoId.split('/').pop() : '';
  const base = repo || model.name || 'Local model';
  return model.quant ? `${base} · ${model.quant}` : base;
}

export default function LocalComputeControl() {
  const [target, setTarget] = useRecoilState(store.botconnectorComputeTarget);
  const [selectedModelPath, setSelectedModelPath] = useRecoilState(
    store.botconnectorLocalModelPath,
  );
  const [models, setModels] = useState<LocalInstalledModel[]>([]);
  const [state, setState] = useState<LocalState>('idle');
  const [detail, setDetail] = useState('');
  const [advisorOpen, setAdvisorOpen] = useState(false);
  const [activeModelPath, setActiveModelPath] = useState('');

  const refresh = useCallback(async () => {
    const controller = new AbortController();
    setState('checking');
    setDetail('Checking Local Runtime…');
    try {
      await probeLocalRuntime(controller.signal);
      const [installed, runtime] = await Promise.all([
        listLocalModels(controller.signal),
        getLocalRuntimeStatus(controller.signal),
      ]);
      setModels(installed);

      const activePath = runtime?.process?.activeModel?.ggufPath || '';
      setActiveModelPath(activePath);
      const currentExists = installed.some((model) => model.path === selectedModelPath);
      const nextPath =
        (currentExists && selectedModelPath) ||
        (activePath && installed.some((model) => model.path === activePath) ? activePath : '') ||
        installed[0]?.path ||
        '';
      if (nextPath !== selectedModelPath) {
        setSelectedModelPath(nextPath);
      }

      if (!installed.length) {
        setState('connected');
        setDetail('Runtime connected · no GGUF model installed');
      } else if (
        runtime?.process?.status === 'READY' &&
        runtime?.process?.activeModel?.health === true
      ) {
        setState('ready');
        setDetail(
          `Verified loaded on this device · ${runtime.process.activeModel.displayName || 'model active'}`,
        );
      } else {
        setState('connected');
        setDetail('Runtime connected · model will load on first message');
      }
    } catch (error) {
      setModels([]);
      setState('offline');
      setDetail(
        `Local Runtime unavailable on this device: ${String((error as Error)?.message || error)}`,
      );
    }
  }, [selectedModelPath, setSelectedModelPath]);

  useEffect(() => {
    if (target !== 'device') return;
    void refresh();
  }, [target, refresh]);

  const verifyRuntime = useCallback(async () => {
    if (target !== 'device' || state === 'loading' || state === 'unloading') return;
    try {
      if (!selectedModelPath) {
        await probeLocalRuntime();
        if (state === 'offline' || state === 'error') void refresh();
        return;
      }

      const verification = await verifyLocalModelState(selectedModelPath);
      if (!verification.installed) {
        void refresh();
        return;
      }
      if (verification.loaded) {
        setActiveModelPath(selectedModelPath);
        setState('ready');
        setDetail('Verified loaded on this device · runtime health confirmed');
      } else {
        setActiveModelPath('');
        setState('connected');
        setDetail('Verified installed · currently unloaded');
      }
    } catch (error) {
      setActiveModelPath('');
      setState('offline');
      setDetail(`Local Runtime health check failed: ${String((error as Error)?.message || error)}`);
    }
  }, [refresh, selectedModelPath, state, target]);

  useEffect(() => {
    if (target !== 'device') return;
    const check = () => {
      if (document.visibilityState === 'visible') void verifyRuntime();
    };
    const interval = window.setInterval(check, 30_000);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', check);
    };
  }, [target, verifyRuntime]);

  const chooseTarget = useCallback(
    (next: 'cloud' | 'device') => {
      setTarget(next);
      if (next === 'device') {
        void refresh();
      }
    },
    [refresh, setTarget],
  );

  const chooseModel = useCallback(
    async (path: string) => {
      setSelectedModelPath(path);
      if (!path) return;
      setState('loading');
      setDetail('Loading local model…');
      try {
        const runtime = await ensureLocalModelReady(path);
        setActiveModelPath(runtime?.process?.activeModel?.ggufPath || path);
        setState('ready');
        setDetail(
          `Verified loaded on this device · ${runtime?.process?.activeModel?.displayName || 'model active'}`,
        );
      } catch (error) {
        setState('error');
        setDetail(String((error as Error)?.message || error));
      }
    },
    [setSelectedModelPath],
  );

  const unloadActiveModel = useCallback(async () => {
    const path = activeModelPath || selectedModelPath;
    if (!path) return;
    setState('unloading');
    setDetail('Unloading local model from memory…');
    try {
      await unloadLocalModel(path);
      setActiveModelPath('');
      setState('connected');
      setDetail('Verified unloaded · model file remains installed on this device');
    } catch (error) {
      setState('error');
      setDetail(String((error as Error)?.message || error));
    }
  }, [activeModelPath, selectedModelPath]);

  const deviceActive = target === 'device';
  const statusText = statusLabel(state);
  let runtimeAction = (
    <button
      type="button"
      onClick={() => void refresh()}
      className="hidden h-9 rounded-xl border border-border-light bg-presentation px-2.5 text-xs text-text-secondary hover:bg-surface-active-alt hover:text-text-primary sm:block"
      title={detail}
      aria-label="Refresh Local Runtime"
    >
      {statusText}
    </button>
  );
  if (state === 'ready' && activeModelPath) {
    runtimeAction = (
      <button
        type="button"
        onClick={() => void unloadActiveModel()}
        className="hidden h-9 rounded-xl border border-border-light bg-presentation px-2.5 text-xs text-text-secondary hover:bg-surface-active-alt hover:text-text-primary sm:block"
        title="Unload the active local model from RAM/VRAM/NPU. The model file stays installed."
      >
        Unload
      </button>
    );
  }
  if (state === 'offline') {
    runtimeAction = (
      <a
        href="https://botconnector.id/download"
        className="hidden h-9 items-center rounded-xl border border-border-light bg-presentation px-2.5 text-xs text-text-secondary hover:bg-surface-active-alt hover:text-text-primary sm:flex"
        title={detail}
      >
        {COPY.installRuntime}
      </a>
    );
  } else if (state === 'connected' && models.length === 0) {
    runtimeAction = (
      <a
        href={localRuntimeBaseUrl()}
        target="_blank"
        rel="noreferrer"
        className="hidden h-9 items-center rounded-xl border border-border-light bg-presentation px-2.5 text-xs text-text-secondary hover:bg-surface-active-alt hover:text-text-primary sm:flex"
        title={detail}
      >
        {COPY.manageLocal}
      </a>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="botconnector-compute-control">
      <div
        className="flex h-9 flex-shrink-0 items-center rounded-xl border border-border-light bg-presentation p-0.5"
        aria-label="Compute target"
      >
        <button
          type="button"
          onClick={() => chooseTarget('cloud')}
          className={cn(
            'h-8 rounded-[10px] px-2.5 text-xs font-medium transition-colors',
            !deviceActive
              ? 'bg-surface-active-alt text-text-primary'
              : 'text-text-secondary hover:text-text-primary',
          )}
          aria-pressed={!deviceActive}
        >
          {COPY.cloud}
        </button>
        <button
          type="button"
          onClick={() => chooseTarget('device')}
          className={cn(
            'h-8 rounded-[10px] px-2.5 text-xs font-medium transition-colors',
            deviceActive
              ? 'bg-surface-active-alt text-text-primary'
              : 'text-text-secondary hover:text-text-primary',
          )}
          aria-pressed={deviceActive}
        >
          {COPY.local}
        </button>
      </div>

      {deviceActive && (
        <>
          <select
            className="h-9 min-w-0 max-w-[42vw] rounded-xl border border-border-light bg-presentation px-2.5 text-sm text-text-primary outline-none sm:max-w-[300px]"
            value={selectedModelPath}
            onChange={(event) => void chooseModel(event.target.value)}
            aria-label="Local model"
            disabled={state === 'checking' || state === 'loading' || state === 'offline'}
            title={detail}
          >
            {!models.length && <option value="">{COPY.noLocalModel}</option>}
            {models.map((model) => (
              <option key={model.path} value={model.path}>
                {modelLabel(model)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setAdvisorOpen(true)}
            className="h-9 shrink-0 rounded-xl border border-border-light bg-presentation px-2 text-xs font-medium text-text-secondary hover:bg-surface-active-alt hover:text-text-primary sm:px-2.5"
            title={COPY.deviceFitTitle}
          >
            <span className="sm:hidden">{COPY.deviceFitShort}</span>
            <span className="hidden sm:inline">{COPY.deviceFit}</span>
          </button>
          {runtimeAction}
          <LocalModelAdvisor
            open={advisorOpen}
            onOpenChange={setAdvisorOpen}
            onModelsChanged={() => void refresh()}
          />
        </>
      )}
    </div>
  );
}
