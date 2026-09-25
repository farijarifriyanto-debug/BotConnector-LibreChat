import { useCallback, useEffect, useMemo, useState } from 'react';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import {
  getLocalHardware,
  getLocalHardwareRecommendations,
  getLocalRuntimeStatus,
  listLocalModels,
  installLocalRuntimeComponents,
  installRecommendedLocalModel,
  probeLocalRuntime,
  unloadLocalModel,
  uninstallLocalModel,
} from '~/utils/botconnectorLocalRuntime';
import type {
  LocalHardwareInfo,
  LocalHardwareRecommendation,
  LocalHardwareRecommendations,
  LocalInstalledModel,
  LocalAdvisorPreference,
  LocalAdvisorUseCase,
} from '~/utils/botconnectorLocalRuntime';
import { useAuthContext } from '~/hooks';
import { cn } from '~/utils';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onModelsChanged?: () => void;
};

const COPY = {
  title: 'Local AI · Device model fit',
  description:
    'BotConnector reads hardware from the connected Device CLI first. A local runtime is only needed to install, manage, or run local models.',
  detectedHardware: 'Detected hardware',
  detectedHardwareHelp: 'CPU, RAM, GPU, VRAM, platform, and runtime backend.',
  scanning: 'Scanning…',
  scanAgain: 'Scan again',
  recommendedModels: 'Recommended local models',
  recommendedModelsHelp:
    'Chosen and ranked by BotConnector for this hardware and use case when a local model runtime is available.',
  advisorSource: 'Advisor: BotConnector',
  allModels: 'All compatible models',
  allModelsHelp:
    'Browse models this device can run. Smaller models save storage and memory, but may reduce answer quality.',
  installAdvisor: 'Install / repair Local AI advisor',
  installingAdvisor: 'Installing advisor…',
  calculatingFit: 'Detecting hardware and calculating model fit…',
  noRecommendation: 'No compatible recommendation was returned for this device yet.',
  runtimeOffline:
    'Hardware was detected through BotConnector Device CLI. Start a local model runtime only when you want to install, manage, or run a local model.',
  deviceOffline:
    'No connected BotConnector Device was found and no local model runtime is reachable. Connect this device from the Devices panel, then scan again.',
  testRuntime: 'Test Local Runtime',
  fitFootnote:
    'Fit is based on detected memory and runtime capability. Actual speed also depends on context length, quantization, GPU offload, thermals, and other programs using RAM/VRAM.',
  score: 'Score',
};

function formatGb(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} GB` : 'Unknown';
}

function fitLabel(model: LocalHardwareRecommendation) {
  return model.fit_label || model.fit_level || 'Fit unknown';
}

function errorMessage(value: unknown) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'message' in value) {
    return String((value as { message?: unknown }).message || '');
  }
  return String(value);
}

type ConnectedDevice = {
  id: string;
  name?: string;
  online?: boolean;
  hardware?: LocalHardwareInfo | null;
};

async function connectedDeviceHardware(token?: string): Promise<LocalHardwareInfo> {
  const headers = new Headers({ accept: 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);

  const listResponse = await fetch('/api/devices', {
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const listPayload = await listResponse.json().catch(() => ({}));
  if (!listResponse.ok) {
    throw new Error(listPayload?.error?.message || listPayload?.message || 'Unable to read Devices.');
  }

  const devices = Array.isArray(listPayload?.devices) ? (listPayload.devices as ConnectedDevice[]) : [];
  const device = devices.find((item) => item?.online === true && item?.hardware);
  if (!device) throw new Error('No online BotConnector Device with hardware data.');

  const refreshHeaders = new Headers(headers);
  refreshHeaders.set('content-type', 'application/json');
  try {
    const refreshResponse = await fetch(`/api/devices/${encodeURIComponent(device.id)}/request`, {
      method: 'POST',
      headers: refreshHeaders,
      credentials: 'same-origin',
      body: JSON.stringify({ method: 'hardware.get', params: {} }),
    });
    const refreshed = await refreshResponse.json().catch(() => null);
    if (
      refreshResponse.ok &&
      refreshed?.result &&
      typeof refreshed.result === 'object'
    ) {
      return refreshed.result as LocalHardwareInfo;
    }
  } catch {
    // Fall back to the last hardware snapshot from device.hello.
  }

  return device.hardware as LocalHardwareInfo;
}

function modelMeta(model: LocalHardwareRecommendation) {
  return [
    model.run_mode_label || model.run_mode,
    model.best_quant,
    typeof model.download_size_gb === 'number'
      ? `Storage ~${model.download_size_gb.toFixed(1)} GB`
      : '',
    typeof model.memory_required_gb === 'number'
      ? `Memory ~${model.memory_required_gb.toFixed(1)} GB`
      : '',
    typeof model.estimated_tps === 'number' ? `~${model.estimated_tps.toFixed(1)} tok/s` : '',
  ].filter(Boolean);
}

export default function LocalModelAdvisor({ open, onOpenChange, onModelsChanged }: Props) {
  const { token } = useAuthContext();
  const [hardware, setHardware] = useState<LocalHardwareInfo | null>(null);
  const [hardwareSource, setHardwareSource] = useState<'runtime' | 'device' | null>(null);
  const [recommendations, setRecommendations] = useState<LocalHardwareRecommendations | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [runtimeReachable, setRuntimeReachable] = useState<boolean | null>(null);
  const [runtimeKind, setRuntimeKind] = useState('');
  const [downloadingModel, setDownloadingModel] = useState('');
  const [activeModelPath, setActiveModelPath] = useState('');
  const [managingModel, setManagingModel] = useState('');
  const [verificationNotice, setVerificationNotice] = useState('');
  const [error, setError] = useState('');
  const [useCases, setUseCases] = useState<LocalAdvisorUseCase[]>(['general']);
  const [preference, setPreference] = useState<LocalAdvisorPreference>('balanced');
  const [installedModels, setInstalledModels] = useState<LocalInstalledModel[]>([]);
  const [modelView, setModelView] = useState<'recommended' | 'installed' | 'all'>('recommended');
  const [modelSearch, setModelSearch] = useState('');
  const [modelSort, setModelSort] = useState<'smallest' | 'name'>('smallest');
  const [manualModelId, setManualModelId] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    setVerificationNotice('');

    let deviceDetected: LocalHardwareInfo | null = null;
    try {
      deviceDetected = await connectedDeviceHardware(token);
      setHardware(deviceDetected);
      setHardwareSource('device');
    } catch {
      setHardware(null);
      setHardwareSource(null);
    }

    try {
      const probe = await probeLocalRuntime();
      const runtimeAvailable = probe?.available !== false;
      setRuntimeReachable(runtimeAvailable);
      setRuntimeKind(String(probe?.runtime || ''));

      const [runtimeStatus, installed] = await Promise.all([
        getLocalRuntimeStatus(),
        listLocalModels(),
      ]);

      if (!deviceDetected) {
        try {
          const runtimeDetected = await getLocalHardware();
          setHardware(runtimeDetected);
          setHardwareSource('runtime');
        } catch {
          // Runtime hardware is optional when Device CLI already owns hardware discovery.
        }
      }

      setInstalledModels(installed);
      setActiveModelPath(runtimeStatus?.process?.activeModel?.ggufPath || '');

      if (!runtimeAvailable) {
        setRecommendations(null);
        setError(deviceDetected ? COPY.runtimeOffline : COPY.deviceOffline);
        return;
      }

      try {
        const result = await getLocalHardwareRecommendations(undefined, { useCases, preference });
        setRecommendations(result);
        if (result?.error) {
          setError(errorMessage(result.error));
        }
      } catch {
        // Device CLI may use a runtime such as Ollama that does not expose
        // BotConnector's recommendation inventory. Model management and chat
        // still work; recommendations are optional in that case.
        setRecommendations(null);
      }
    } catch {
      setRuntimeReachable(false);
      setRuntimeKind('');
      setRecommendations(null);
      setInstalledModels([]);
      setActiveModelPath('');
      setError(deviceDetected ? COPY.runtimeOffline : COPY.deviceOffline);
    } finally {
      setLoading(false);
    }
  }, [token, useCases, preference]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const toggleUseCase = useCallback((next: LocalAdvisorUseCase) => {
    setUseCases((current) => {
      if (next === 'general') return ['general'];
      const specific = current.filter((item) => item !== 'general');
      const updated = specific.includes(next)
        ? specific.filter((item) => item !== next)
        : [...specific, next];
      return updated.length ? updated : ['general'];
    });
  }, []);

  const enableAdvisor = useCallback(async () => {
    setInstalling(true);
    setError('');
    try {
      await installLocalRuntimeComponents('auto');
      await refresh();
    } catch (installError) {
      setError(String((installError as Error)?.message || installError));
    } finally {
      setInstalling(false);
    }
  }, [refresh]);

  const installRecommended = useCallback(
    async (model: LocalHardwareRecommendation) => {
      const modelId = String(model.model_id || '').trim();
      if (!modelId) return;
      setDownloadingModel(modelId);
      setError('');
      setVerificationNotice('');
      try {
        const verification = await installRecommendedLocalModel(modelId);
        if (verification.verified && verification.installed) {
          setVerificationNotice(`Verified installed on this device · ${model.name || modelId}`);
        }
        await refresh();
        onModelsChanged?.();
      } catch (downloadError) {
        setError(String((downloadError as Error)?.message || downloadError));
      } finally {
        setDownloadingModel('');
      }
    },
    [onModelsChanged, refresh],
  );

  const installManualModel = useCallback(async () => {
    const modelId = manualModelId.trim();
    if (!modelId) return;
    setDownloadingModel(modelId);
    setError('');
    setVerificationNotice('');
    try {
      const verification = await installRecommendedLocalModel(modelId);
      if (verification.verified && verification.installed) {
        setVerificationNotice(`Verified installed on this device · ${modelId}`);
        setManualModelId('');
      }
      await refresh();
      onModelsChanged?.();
    } catch (downloadError) {
      setError(String((downloadError as Error)?.message || downloadError));
    } finally {
      setDownloadingModel('');
    }
  }, [manualModelId, onModelsChanged, refresh]);

  const unloadRecommended = useCallback(
    async (model: LocalHardwareRecommendation) => {
      const modelPath = String(model.installed_path || '').trim();
      if (!modelPath) return;
      setManagingModel(modelPath);
      setError('');
      setVerificationNotice('');
      try {
        const verification = await unloadLocalModel(modelPath);
        if (verification.verified && !verification.loaded) {
          setVerificationNotice(`Verified unloaded · ${model.name || modelPath}`);
        }
        await refresh();
        onModelsChanged?.();
      } catch (unloadError) {
        setError(String((unloadError as Error)?.message || unloadError));
      } finally {
        setManagingModel('');
      }
    },
    [onModelsChanged, refresh],
  );

  const uninstallRecommended = useCallback(
    async (model: LocalHardwareRecommendation) => {
      const modelPath = String(model.installed_path || '').trim();
      if (!modelPath) return;
      const approved = window.confirm(
        'Uninstall ' +
          (model.name || 'this local model') +
          ' from this device?\n\nThe model file will be deleted from this laptop. If it is loaded, BotConnector will unload it first.',
      );
      if (!approved) return;

      setManagingModel(modelPath);
      setError('');
      setVerificationNotice('');
      try {
        const verification = await uninstallLocalModel(modelPath);
        if (verification.verified && !verification.installed && !verification.loaded) {
          setVerificationNotice(
            `Verified uninstalled from this device · ${model.name || modelPath}`,
          );
        }
        await refresh();
        onModelsChanged?.();
      } catch (uninstallError) {
        setError(String((uninstallError as Error)?.message || uninstallError));
      } finally {
        setManagingModel('');
      }
    },
    [onModelsChanged, refresh],
  );

  const system = recommendations?.system;
  const gpuNames = useMemo(() => {
    const localNames = [
      ...(hardware?.nvidia ?? []),
      ...(hardware?.amd ?? []),
      ...(hardware?.intel ?? []),
    ]
      .map((gpu) => gpu.name)
      .filter(Boolean);
    if (localNames.length) return localNames.join(', ');
    if (system?.gpu_name) return system.gpu_name;
    const recommendedNames = system?.gpus?.map((gpu) => gpu.name).filter(Boolean) ?? [];
    return recommendedNames.length ? recommendedNames.join(', ') : 'No supported GPU detected';
  }, [hardware?.nvidia, hardware?.amd, hardware?.intel, system?.gpu_name, system?.gpus]);

  const recommendedModels = Array.isArray(recommendations?.models)
    ? recommendations.models.slice(0, 10)
    : [];
  const compatibleModels = Array.isArray(recommendations?.compatible_models)
    ? recommendations.compatible_models
    : [];
  const normalizedSearch = modelSearch.trim().toLowerCase();
  const browseModels = compatibleModels
    .filter((model) =>
      normalizedSearch
        ? [model.name, model.best_quant, model.runtime_label]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(normalizedSearch)
        : true,
    )
    .slice()
    .sort((a, b) => {
      if (modelSort === 'name') {
        return String(a.name || '').localeCompare(String(b.name || ''));
      }
      const aSize =
        typeof a.download_size_gb === 'number' ? a.download_size_gb : Number.POSITIVE_INFINITY;
      const bSize =
        typeof b.download_size_gb === 'number' ? b.download_size_gb : Number.POSITIVE_INFINITY;
      if (aSize !== bSize) return aSize - bSize;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  const installedRecommendations: LocalHardwareRecommendation[] = installedModels.map((model) => ({
    name: model.name,
    model_id: model.modelId || model.name,
    best_quant: model.quant || undefined,
    download_size_gb:
      typeof model.size === 'number' && Number.isFinite(model.size)
        ? model.size / (1024 * 1024 * 1024)
        : undefined,
    runtime_label: `Installed · ${model.recipe || model.runtime || 'local runtime'}`,
    runtime: model.recipe || model.runtime,
    downloaded: true,
    installed_path: model.path,
    fit_label: activeModelPath === model.path ? 'Verified loaded' : 'Verified installed',
  }));
  const models =
    modelView === 'recommended'
      ? recommendedModels
      : modelView === 'installed'
        ? installedRecommendations
        : browseModels;

  let ramSummary = 'Unknown';
  if (hardwareSource === 'device' && typeof hardware?.ramGb === 'number') {
    ramSummary = `${formatGb(hardware.ramGb)} total · ${formatGb(hardware.freeRamGb)} free`;
  } else if (typeof system?.total_ram_gb === 'number') {
    ramSummary = `${formatGb(system.total_ram_gb)} total · ${formatGb(
      system.available_ram_gb ?? hardware?.freeRamGb,
    )} available`;
  } else if (typeof hardware?.ramGb === 'number') {
    ramSummary = `${formatGb(hardware.ramGb)} total · ${formatGb(hardware.freeRamGb)} free`;
  }

  let vramSummary = 'Not detected';
  const localGpus = [
    ...(hardware?.nvidia ?? []),
    ...(hardware?.amd ?? []),
    ...(hardware?.intel ?? []),
  ];
  if (localGpus.length) {
    const knownVram = localGpus.filter((gpu) => typeof gpu.memoryGb === 'number');
    vramSummary = knownVram.length
      ? knownVram.map((gpu) => `${gpu.memoryGb?.toFixed(1)} GB`).join(' + ')
      : 'Shared / dynamic';
  } else if (typeof system?.gpu_vram_gb === 'number') {
    vramSummary = `${system.gpu_vram_gb.toFixed(1)} GB`;
  } else if (system?.gpus?.some((gpu) => typeof gpu.vram_gb === 'number')) {
    vramSummary = system.gpus
      .map((gpu) => (typeof gpu.vram_gb === 'number' ? `${gpu.vram_gb.toFixed(1)} GB` : 'Unknown'))
      .join(' + ');
  }

  const specs = [
    ['CPU', hardware?.cpu || system?.cpu_name || 'Unknown'],
    ['RAM', ramSummary],
    ['GPU', gpuNames],
    ['VRAM', vramSummary],
    ['NPU', hardware?.npu?.name || system?.npu_name || 'Not detected'],
    [
      'System',
      [hardware?.platform, hardware?.arch, hardware?.release].filter(Boolean).join(' · ') ||
        'Unknown',
    ],
    [
      'Hardware source',
      hardwareSource === 'device' ? 'BotConnector Device CLI' : 'Local model runtime',
    ],
    [
      'Model backend',
      system?.backend ||
        (runtimeReachable
          ? runtimeKind
            ? runtimeKind
            : 'Local runtime'
          : 'Not running'),
    ],
  ];

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="flex h-[min(90vh,48rem)] w-11/12 max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <OGDialogHeader className="shrink-0 border-b border-border-light px-5 py-4 pr-14">
          <OGDialogTitle className="text-left text-base">{COPY.title}</OGDialogTitle>
          <p className="mt-1 text-left text-sm text-text-secondary">{COPY.description}</p>
        </OGDialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-text-primary">{COPY.detectedHardware}</div>
              <div className="text-xs text-text-secondary">{COPY.detectedHardwareHelp}</div>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading || installing}
              className="h-9 rounded-xl border border-border-light bg-presentation px-3 text-sm text-text-primary hover:bg-surface-active-alt disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? COPY.scanning : COPY.scanAgain}
            </button>
          </div>

          {(hardware || recommendations?.system) && (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {specs.map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-xl border border-border-light bg-surface-secondary/40 p-3"
                >
                  <div className="text-xs text-text-secondary">{label}</div>
                  <div className="mt-1 break-words text-sm font-medium text-text-primary">
                    {value}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-border-light bg-surface-secondary/30 p-3">
              <div className="mb-2 text-xs font-medium text-text-secondary">
                Use cases · select one or more
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  ['general', 'General'],
                  ['indonesian', 'Bahasa Indonesia'],
                  ['coding', 'Coding'],
                  ['reasoning', 'Reasoning'],
                  ['vision', 'Vision'],
                  ['tools', 'Tools'],
                ].map(([value, label]) => {
                  const typedValue = value as LocalAdvisorUseCase;
                  const selected = useCases.includes(typedValue);
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => toggleUseCase(typedValue)}
                      className={cn(
                        'h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors',
                        selected
                          ? 'border-border-medium bg-surface-active-alt text-text-primary'
                          : 'border-border-light bg-presentation text-text-secondary hover:text-text-primary',
                      )}
                    >
                      {selected ? '✓ ' : ''}
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="rounded-xl border border-border-light bg-surface-secondary/30 p-3">
              <div className="mb-1 text-xs font-medium text-text-secondary">Preference</div>
              <select
                value={preference}
                onChange={(event) => setPreference(event.target.value as LocalAdvisorPreference)}
                className="w-full rounded-lg border border-border-light bg-presentation px-2 py-2 text-sm text-text-primary"
              >
                <option value="fast">Fast</option>
                <option value="balanced">Balanced</option>
                <option value="quality">Quality</option>
              </select>
            </label>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <div className="flex h-9 items-center rounded-xl border border-border-light bg-presentation p-0.5">
              <button
                type="button"
                onClick={() => setModelView('recommended')}
                className={cn(
                  'h-8 rounded-[10px] px-3 text-xs font-medium transition-colors',
                  modelView === 'recommended'
                    ? 'bg-surface-active-alt text-text-primary'
                    : 'text-text-secondary hover:text-text-primary',
                )}
              >
                Recommended
              </button>
              <button
                type="button"
                onClick={() => setModelView('installed')}
                className={cn(
                  'h-8 rounded-[10px] px-3 text-xs font-medium transition-colors',
                  modelView === 'installed'
                    ? 'bg-surface-active-alt text-text-primary'
                    : 'text-text-secondary hover:text-text-primary',
                )}
              >
                Installed ({installedModels.length})
              </button>
              <button
                type="button"
                onClick={() => setModelView('all')}
                className={cn(
                  'h-8 rounded-[10px] px-3 text-xs font-medium transition-colors',
                  modelView === 'all'
                    ? 'bg-surface-active-alt text-text-primary'
                    : 'text-text-secondary hover:text-text-primary',
                )}
              >
                All compatible ({compatibleModels.length})
              </button>
            </div>
            {recommendations?.system && (
              <div className="text-xs text-text-secondary">
                {recommendations?.source || COPY.advisorSource}
              </div>
            )}
          </div>

          <div className="mt-2">
            <div className="text-sm font-medium text-text-primary">
              {modelView === 'recommended'
                ? COPY.recommendedModels
                : modelView === 'installed'
                  ? 'Installed on this device'
                  : COPY.allModels}
            </div>
            <div className="text-xs text-text-secondary">
              {modelView === 'recommended'
                ? COPY.recommendedModelsHelp
                : modelView === 'installed'
                  ? 'Verified from this laptop. Loaded models are marked and can be unloaded without deleting the model file.'
                  : COPY.allModelsHelp}
            </div>
          </div>

          {modelView === 'all' && (
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
              <input
                type="search"
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder="Search model, quantization, runtime…"
                className="h-9 rounded-xl border border-border-light bg-presentation px-3 text-sm text-text-primary outline-none placeholder:text-text-secondary"
              />
              <select
                value={modelSort}
                onChange={(event) => setModelSort(event.target.value as 'smallest' | 'name')}
                className="h-9 rounded-xl border border-border-light bg-presentation px-3 text-sm text-text-primary"
              >
                <option value="smallest">Smallest first</option>
                <option value="name">Name A–Z</option>
              </select>
            </div>
          )}

          {hardwareSource === 'device' && (
            <div className="mt-3 rounded-xl border border-border-light bg-surface-secondary/30 p-3">
              <div className="text-sm font-medium text-text-primary">Download local model</div>
              <div className="mt-1 text-xs text-text-secondary">
                {runtimeKind === 'llamacpp'
                  ? 'Enter a Hugging Face GGUF repository ID. BotConnector will choose a practical quantization automatically.'
                  : 'Enter a model ID supported by the active local runtime, for example qwen3:4b on Ollama.'}
              </div>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={manualModelId}
                  onChange={(event) => setManualModelId(event.target.value)}
                  placeholder={
                    runtimeKind === 'llamacpp'
                      ? 'Hugging Face repo, e.g. Qwen/Qwen3-4B-GGUF'
                      : 'Model ID, e.g. qwen3:4b'
                  }
                  className="h-9 min-w-0 flex-1 rounded-xl border border-border-light bg-presentation px-3 text-sm text-text-primary outline-none placeholder:text-text-secondary"
                />
                <button
                  type="button"
                  onClick={() => void installManualModel()}
                  disabled={
                    runtimeReachable !== true ||
                    !manualModelId.trim() ||
                    Boolean(downloadingModel) ||
                    Boolean(managingModel)
                  }
                  className="h-9 rounded-xl border border-border-light bg-presentation px-3 text-sm font-medium text-text-primary hover:bg-surface-active-alt disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {downloadingModel === manualModelId.trim() ? 'Downloading…' : 'Download'}
                </button>
              </div>
              {runtimeReachable === false && (
                <div className="mt-2 text-xs text-text-secondary">
                  Start a local model runtime first.
                </div>
              )}
            </div>
          )}

          {verificationNotice && (
            <div className="mt-3 rounded-xl border border-border-light bg-surface-secondary/30 p-3 text-xs font-medium text-text-primary">
              {verificationNotice}
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-xl border border-border-light bg-surface-secondary/50 p-3 text-sm text-text-secondary">
              <div>{error}</div>
              {runtimeReachable === false ? (
                <button
                  type="button"
                  onClick={() => void refresh()}
                  disabled={loading || installing}
                  className="mt-3 inline-flex h-9 items-center rounded-xl border border-border-light bg-presentation px-3 text-sm font-medium text-text-primary hover:bg-surface-active-alt disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? COPY.scanning : COPY.testRuntime}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void enableAdvisor()}
                  disabled={installing || loading}
                  className="mt-3 h-9 rounded-xl border border-border-light bg-presentation px-3 text-sm font-medium text-text-primary hover:bg-surface-active-alt disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {installing ? COPY.installingAdvisor : COPY.installAdvisor}
                </button>
              )}
            </div>
          )}

          {!error && loading && (
            <div className="mt-3 rounded-xl border border-border-light bg-surface-secondary/40 p-4 text-sm text-text-secondary">
              {COPY.calculatingFit}
            </div>
          )}

          {!loading && !error && models.length === 0 && (
            <div className="mt-3 rounded-xl border border-border-light bg-surface-secondary/40 p-4 text-sm text-text-secondary">
              {modelView === 'recommended'
                ? COPY.noRecommendation
                : modelView === 'installed'
                  ? 'No local model is currently installed on this device.'
                  : 'No compatible model matches this search.'}
            </div>
          )}

          {models.length > 0 && (
            <div className="mt-3 space-y-2">
              {models.map((model, index) => {
                const meta = modelMeta(model);
                const label = fitLabel(model);
                return (
                  <div
                    key={`${model.name || 'model'}-${index}`}
                    className="rounded-xl border border-border-light bg-surface-secondary/30 p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="break-words text-sm font-medium text-text-primary">
                          {index + 1}. {model.name || 'Local model'}
                        </div>
                        {meta.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-text-secondary">
                            {meta.map((item) => (
                              <span key={String(item)}>{item}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span
                        className={cn(
                          'shrink-0 rounded-lg border border-border-light px-2 py-1 text-xs font-medium',
                          'bg-presentation text-text-primary',
                        )}
                      >
                        {label}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
                      <span>
                        {modelView === 'recommended'
                          ? `${COPY.score} ${Number(model.score || 0).toFixed(0)} · `
                          : modelView === 'installed'
                            ? 'Verified on this device · '
                            : 'User choice · '}
                        {model.runtime_label || model.runtime || 'llama.cpp'}
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        {model.downloaded && (
                          <span className="text-xs text-text-secondary">
                            Verified installed on this device
                          </span>
                        )}
                        {model.runtime && model.model_id && !model.downloaded && (
                          <button
                            type="button"
                            onClick={() => void installRecommended(model)}
                            disabled={Boolean(downloadingModel) || Boolean(managingModel)}
                            className="h-8 rounded-lg border border-border-light bg-presentation px-2.5 text-xs font-medium text-text-primary hover:bg-surface-active-alt disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {downloadingModel === model.model_id
                              ? 'Installing…'
                              : 'Install on this device'}
                          </button>
                        )}
                        {model.downloaded &&
                          model.installed_path &&
                          activeModelPath === model.installed_path && (
                            <button
                              type="button"
                              onClick={() => void unloadRecommended(model)}
                              disabled={Boolean(managingModel) || Boolean(downloadingModel)}
                              className="h-8 rounded-lg border border-border-light bg-presentation px-2.5 text-xs font-medium text-text-primary hover:bg-surface-active-alt disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {managingModel === model.installed_path ? 'Unloading…' : 'Unload'}
                            </button>
                          )}
                        {model.downloaded && model.installed_path && (
                          <button
                            type="button"
                            onClick={() => void uninstallRecommended(model)}
                            disabled={Boolean(managingModel) || Boolean(downloadingModel)}
                            className="h-8 rounded-lg border border-border-light bg-presentation px-2.5 text-xs font-medium text-text-primary hover:bg-surface-active-alt disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {managingModel === model.installed_path ? 'Working…' : 'Uninstall'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-5 rounded-xl border border-border-light bg-surface-secondary/30 p-3 text-xs text-text-secondary">
            {COPY.fitFootnote}
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
