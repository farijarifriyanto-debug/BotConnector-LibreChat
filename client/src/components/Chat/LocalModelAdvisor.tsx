import { useCallback, useEffect, useMemo, useState } from 'react';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import {
  getDeviceHardwareRecommendations,
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
  title: 'Device fit',
  description:
    'Choose local models using this device’s real hardware, runtime compatibility, and fit estimates.',
  detectedHardware: 'Detected hardware',
  detectedHardwareHelp: 'CPU, RAM, GPU, VRAM, platform, and runtime backend.',
  scanning: 'Scanning…',
  scanAgain: 'Scan again',
  recommendedModels: 'Recommended local models',
  recommendedModelsHelp:
    'Chosen and ranked by BotConnector from the detected device hardware. Runtime is prepared only when you install or run a model.',
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
      ? `${model.download_size_gb.toFixed(1)} GB download`
      : '',
    typeof model.memory_required_gb === 'number'
      ? `~${model.memory_required_gb.toFixed(1)} GB RAM recommended`
      : '',
    typeof model.estimated_tps === 'number' ? `~${model.estimated_tps.toFixed(1)} tok/s estimated` : '',
  ].filter(Boolean);
}

function fitTone(model: LocalHardwareRecommendation) {
  const value = String(model.fit_level || model.fit_label || '').toLowerCase();
  if (value.includes('great') || value.includes('excellent') || value.includes('loaded')) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500';
  }
  if (value.includes('ok') || value.includes('good') || value.includes('installed')) {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-500';
  }
  if (value.includes('warn') || value.includes('tight') || value.includes('limited')) {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-500';
  }
  if (value.includes('no') || value.includes('unsupported')) {
    return 'border-red-500/30 bg-red-500/10 text-red-500';
  }
  return 'border-border-light bg-presentation text-text-secondary';
}

function confidenceLabel(model: LocalHardwareRecommendation) {
  if (model.confidence === 'verified') return 'Verified';
  if (model.confidence === 'unknown') return 'Unknown';
  return 'Estimated';
}

function recommendationReason(
  model: LocalHardwareRecommendation,
  preference: LocalAdvisorPreference,
) {
  if (Array.isArray(model.reasons) && model.reasons.length) {
    return model.reasons.join(' ');
  }
  const parts = [
    fitLabel(model) !== 'Fit unknown' ? `Hardware fit: ${fitLabel(model)}.` : '',
    typeof model.memory_required_gb === 'number'
      ? `Recommended memory is about ${model.memory_required_gb.toFixed(1)} GB.`
      : '',
    model.best_quant ? `Suggested quantization: ${model.best_quant}.` : '',
    `Profile preference: ${preference}.`,
  ].filter(Boolean);
  return parts.join(' ');
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
  const [modelSort, setModelSort] = useState<'best' | 'smallest' | 'name'>('best');
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
        if (deviceDetected) {
          setRecommendations(
            getDeviceHardwareRecommendations(deviceDetected, { useCases, preference }),
          );
          setError('');
        } else {
          setRecommendations(null);
          setError(COPY.deviceOffline);
        }
        return;
      }

      try {
        const result = await getLocalHardwareRecommendations(undefined, { useCases, preference });
        const hasRuntimeModels =
          (Array.isArray(result?.models) && result.models.length > 0) ||
          (Array.isArray(result?.compatible_models) && result.compatible_models.length > 0);

        if (!hasRuntimeModels && deviceDetected) {
          setRecommendations(
            getDeviceHardwareRecommendations(deviceDetected, { useCases, preference }),
          );
          setError('');
        } else {
          setRecommendations(result);
          if (result?.error) {
            setError(errorMessage(result.error));
          }
        }
      } catch {
        if (deviceDetected) {
          setRecommendations(
            getDeviceHardwareRecommendations(deviceDetected, { useCases, preference }),
          );
          setError('');
        } else {
          setRecommendations(null);
        }
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
  const installedRecommendations: LocalHardwareRecommendation[] = installedModels.map((model) => ({
    name: model.name,
    model_id: model.modelId || model.name,
    best_quant: model.quant || undefined,
    download_size_gb:
      typeof model.size === 'number' && Number.isFinite(model.size)
        ? model.size / (1024 * 1024 * 1024)
        : undefined,
    runtime_label: `Installed · ${model.source || model.recipe || model.runtime || 'local runtime'}`,
    runtime: model.recipe || model.runtime,
    downloaded: true,
    installed_path: model.path,
    fit_label: activeModelPath === model.path ? 'Verified loaded' : 'Verified installed',
  }));
  const sourceModels =
    modelView === 'recommended'
      ? recommendedModels
      : modelView === 'installed'
        ? installedRecommendations
        : compatibleModels;

  const models = sourceModels
    .filter((model) =>
      normalizedSearch
        ? [
            model.name,
            model.model_id,
            model.best_quant,
            model.runtime_label,
            model.runtime,
            fitLabel(model),
          ]
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
      if (modelSort === 'smallest') {
        const aSize =
          typeof a.download_size_gb === 'number' ? a.download_size_gb : Number.POSITIVE_INFINITY;
        const bSize =
          typeof b.download_size_gb === 'number' ? b.download_size_gb : Number.POSITIVE_INFINITY;
        if (aSize !== bSize) return aSize - bSize;
        return String(a.name || '').localeCompare(String(b.name || ''));
      }
      const scoreDelta = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDelta !== 0) return scoreDelta;
      const aMemory =
        typeof a.memory_required_gb === 'number' ? a.memory_required_gb : Number.POSITIVE_INFINITY;
      const bMemory =
        typeof b.memory_required_gb === 'number' ? b.memory_required_gb : Number.POSITIVE_INFINITY;
      return aMemory - bMemory;
    });

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

  const primarySpecs = [
    ['CPU', hardware?.cpu || system?.cpu_name || 'Unknown'],
    ['RAM', ramSummary],
    ['GPU', gpuNames],
    [
      'Backend',
      system?.backend ||
        (runtimeReachable ? runtimeKind || 'Local runtime' : 'Not running'),
    ],
  ];

  const secondarySpecs = [
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
  ];

  const modelViewLead =
    modelView === 'recommended'
      ? 'Ranked for this hardware, selected capabilities, and preference.'
      : modelView === 'installed'
        ? 'Models already available on this device.'
        : 'Browse compatible models discovered by the local advisor.';

  const availableMemory =
    typeof hardware?.freeRamGb === 'number'
      ? hardware.freeRamGb
      : typeof system?.available_ram_gb === 'number'
        ? system.available_ram_gb
        : undefined;

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="flex h-[min(92vh,52rem)] w-11/12 max-w-5xl flex-col gap-0 overflow-hidden border-border-light bg-surface-primary p-0 shadow-2xl">
        <OGDialogHeader className="shrink-0 border-b border-border-light px-5 py-4 pr-14">
          <OGDialogTitle className="text-left text-lg font-semibold">{COPY.title}</OGDialogTitle>
          <p className="mt-1 max-w-2xl text-left text-sm text-text-secondary">{COPY.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
            <span className="inline-flex items-center gap-1.5">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  error
                    ? 'bg-amber-500'
                    : hardware || recommendations?.system
                      ? 'bg-emerald-500'
                      : 'bg-text-secondary',
                )}
              />
              {loading
                ? 'Scanning device…'
                : hardwareSource === 'device'
                  ? 'Detected locally · Device CLI connected'
                  : hardwareSource === 'runtime'
                    ? 'Detected through local runtime'
                    : 'Waiting for device scan'}
            </span>
            {recommendations?.source && <span>Advisor · {recommendations.source}</span>}
          </div>
        </OGDialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section className="rounded-2xl border border-border-light bg-surface-secondary/20 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-text-primary">This device</div>
                <div className="mt-0.5 text-xs text-text-secondary">
                  Real CPU, memory, GPU and runtime data used for model fit.
                </div>
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading || installing || Boolean(managingModel)}
                className="h-9 rounded-xl border border-border-light bg-presentation px-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface-active-alt disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? COPY.scanning : COPY.scanAgain}
              </button>
            </div>

            {(hardware || recommendations?.system) && (
              <>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {primarySpecs.map(([label, value]) => (
                    <div
                      key={label}
                      className="min-w-0 rounded-xl border border-border-light bg-presentation/70 px-3 py-2.5"
                    >
                      <div className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                        {label}
                      </div>
                      <div className="mt-1 truncate text-sm font-semibold text-text-primary" title={value}>
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
                <details className="mt-2 rounded-xl border border-border-light bg-presentation/40">
                  <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
                    Hardware details
                  </summary>
                  <div className="grid gap-2 border-t border-border-light p-3 sm:grid-cols-2 lg:grid-cols-4">
                    {secondarySpecs.map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <div className="text-[11px] text-text-secondary">{label}</div>
                        <div className="mt-0.5 break-words text-xs font-medium text-text-primary">
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              </>
            )}
          </section>

          <section className="mt-3 grid gap-2 lg:grid-cols-[1.4fr_0.6fr]">
            <div className="rounded-2xl border border-border-light bg-surface-secondary/20 p-3">
              <div className="mb-2 text-xs font-semibold text-text-primary">Use cases</div>
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

            <label className="rounded-2xl border border-border-light bg-surface-secondary/20 p-3">
              <div className="mb-2 text-xs font-semibold text-text-primary">Preference</div>
              <select
                value={preference}
                onChange={(event) => setPreference(event.target.value as LocalAdvisorPreference)}
                className="h-9 w-full rounded-xl border border-border-light bg-presentation px-3 text-sm text-text-primary outline-none"
              >
                <option value="fast">Fast · prioritize speed</option>
                <option value="balanced">Balanced · speed + quality</option>
                <option value="quality">Quality · larger models first</option>
              </select>
            </label>
          </section>

          <section className="mt-4">
            <div className="grid grid-cols-3 rounded-xl border border-border-light bg-presentation p-1">
              {[
                ['recommended', 'Recommended', recommendedModels.length],
                ['installed', 'Installed', installedModels.length],
                ['all', 'All compatible', compatibleModels.length],
              ].map(([value, label, count]) => (
                <button
                  key={String(value)}
                  type="button"
                  onClick={() => setModelView(value as 'recommended' | 'installed' | 'all')}
                  className={cn(
                    'flex h-9 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-xs font-semibold transition-colors',
                    modelView === value
                      ? 'bg-surface-active-alt text-text-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary',
                  )}
                >
                  <span className="truncate">{label}</span>
                  <span className="rounded-md bg-surface-secondary px-1.5 py-0.5 text-[10px]">
                    {count}
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-text-secondary">{modelViewLead}</p>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading || installing || Boolean(managingModel)}
                className="h-8 rounded-lg border border-border-light bg-presentation px-2.5 text-xs font-medium text-text-secondary hover:bg-surface-active-alt hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Refreshing…' : 'Refresh models'}
              </button>
            </div>

            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-secondary">
                  ⌕
                </span>
                <input
                  type="search"
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder="Search model, runtime, or quantization"
                  className="h-10 w-full rounded-xl border border-border-light bg-presentation pl-8 pr-3 text-sm text-text-primary outline-none placeholder:text-text-secondary focus:border-border-medium"
                />
              </div>
              <select
                value={modelSort}
                onChange={(event) =>
                  setModelSort(event.target.value as 'best' | 'smallest' | 'name')
                }
                className="h-10 min-w-36 rounded-xl border border-border-light bg-presentation px-3 text-sm text-text-primary outline-none"
              >
                <option value="best">Best fit</option>
                <option value="smallest">Smallest first</option>
                <option value="name">Name A–Z</option>
              </select>
            </div>
          </section>

          {verificationNotice && (
            <div className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-xs font-medium text-emerald-500">
              {verificationNotice}
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-text-secondary">
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
            <div className="mt-3 space-y-2">
              {[0, 1, 2].map((item) => (
                <div
                  key={item}
                  className="h-28 animate-pulse rounded-2xl border border-border-light bg-surface-secondary/30"
                />
              ))}
            </div>
          )}

          {!loading && !error && models.length === 0 && (
            <div className="mt-3 rounded-2xl border border-border-light bg-surface-secondary/30 p-5 text-sm text-text-secondary">
              <div className="font-medium text-text-primary">
                {modelSearch ? 'No models match this search' : 'No models available in this view'}
              </div>
              <div className="mt-1 text-xs">
                Try another use case, preference, or clear the search field.
              </div>
            </div>
          )}

          {!loading && models.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-2xl border border-border-light bg-surface-secondary/10">
              {models.map((model, index) => {
                const meta = modelMeta(model);
                const label = fitLabel(model);
                const topRecommendation = modelView === 'recommended' && index === 0;
                const headroom =
                  typeof availableMemory === 'number' &&
                  typeof model.memory_required_gb === 'number'
                    ? availableMemory - model.memory_required_gb
                    : undefined;
                const reason = recommendationReason(model, preference);
                const isLoaded =
                  Boolean(model.downloaded) &&
                  Boolean(model.installed_path) &&
                  activeModelPath === model.installed_path;

                return (
                  <article
                    key={`${model.name || 'model'}-${model.model_id || index}`}
                    className={cn(
                      'border-b border-border-light p-4 last:border-b-0',
                      topRecommendation && 'bg-emerald-500/[0.035]',
                    )}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="break-words text-sm font-semibold text-text-primary">
                            {model.name || 'Local model'}
                          </h3>
                          {isLoaded && (
                            <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-500">
                              Loaded
                            </span>
                          )}
                        </div>

                        <div className="mt-1 text-xs text-text-secondary">
                          {[model.runtime_label || model.runtime, model.best_quant]
                            .filter(Boolean)
                            .join(' · ') || 'Local model'}
                        </div>

                        {topRecommendation && (
                          <div className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2">
                            <div className="text-xs font-semibold text-text-primary">
                              Recommended for this device
                            </div>
                            <div className="mt-0.5 text-[11px] text-text-secondary">
                              {Array.isArray(model.reasons) && model.reasons.length
                                ? model.reasons[0]
                                : `${label} · selected for the current ${preference} profile`}
                            </div>
                          </div>
                        )}

                        <div className="mt-3 flex flex-wrap gap-1.5">
                          <span className="rounded-md border border-border-light bg-presentation px-2 py-1 text-[11px] font-medium text-text-primary">
                            Text
                          </span>
                          {useCases
                            .filter((item) => item !== 'general')
                            .map((item) => (
                              <span
                                key={item}
                                className="rounded-md border border-border-light bg-presentation px-2 py-1 text-[11px] text-text-secondary"
                              >
                                {item === 'indonesian'
                                  ? 'Bahasa Indonesia'
                                  : item.charAt(0).toUpperCase() + item.slice(1)}
                              </span>
                            ))}
                        </div>

                        {meta.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-text-secondary">
                            {meta.map((item) => (
                              <span key={String(item)}>{item}</span>
                            ))}
                            {typeof headroom === 'number' && headroom >= 0 && (
                              <span>~{headroom.toFixed(1)} GB free RAM after load</span>
                            )}
                          </div>
                        )}

                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
                          <span>
                            {model.model_id
                              ? model.model_id.includes('/')
                                ? model.model_id.split('/')[0]
                                : model.model_id
                              : 'Local catalog'}
                          </span>
                          <span>·</span>
                          <span>{confidenceLabel(model)}</span>
                        </div>

                        {reason && modelView === 'recommended' && (
                          <details className="mt-2">
                            <summary className="cursor-pointer list-none text-xs font-semibold text-text-secondary hover:text-text-primary">
                              Why this model? <span aria-hidden="true">⌄</span>
                            </summary>
                            <div className="mt-2 rounded-xl border border-border-light bg-presentation/60 p-3 text-xs leading-5 text-text-secondary">
                              {reason}
                            </div>
                          </details>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-row flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                        <span
                          className={cn(
                            'rounded-lg border px-2 py-1 text-[11px] font-semibold',
                            fitTone(model),
                          )}
                        >
                          {label} · {confidenceLabel(model)}
                        </span>

                        <div className="flex flex-wrap justify-end gap-2">
                          {model.runtime && model.model_id && !model.downloaded && (
                            <button
                              type="button"
                              onClick={() => void installRecommended(model)}
                              disabled={Boolean(downloadingModel) || Boolean(managingModel)}
                              className="h-8 rounded-lg border border-border-medium bg-presentation px-3 text-xs font-medium text-text-primary transition-colors hover:bg-surface-active-alt disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {downloadingModel === model.model_id ? 'Downloading…' : 'Download'}
                            </button>
                          )}
                          {model.downloaded &&
                            model.installed_path &&
                            activeModelPath === model.installed_path && (
                              <button
                                type="button"
                                onClick={() => void unloadRecommended(model)}
                                disabled={Boolean(managingModel) || Boolean(downloadingModel)}
                                className="h-8 rounded-lg border border-border-light bg-presentation px-3 text-xs font-medium text-text-primary hover:bg-surface-active-alt disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {managingModel === model.installed_path ? 'Unloading…' : 'Unload'}
                              </button>
                            )}
                          {model.downloaded && model.installed_path && (
                            <button
                              type="button"
                              onClick={() => void uninstallRecommended(model)}
                              disabled={Boolean(managingModel) || Boolean(downloadingModel)}
                              className="h-8 rounded-lg border border-border-light bg-presentation px-3 text-xs font-medium text-text-secondary hover:bg-surface-active-alt hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {managingModel === model.installed_path ? 'Working…' : 'Delete'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {hardwareSource === 'device' && (
            <details className="mt-3 rounded-xl border border-border-light bg-surface-secondary/20">
              <summary className="cursor-pointer list-none px-3 py-2.5 text-xs font-medium text-text-secondary hover:text-text-primary">
                Advanced · Download by model ID
              </summary>
              <div className="border-t border-border-light p-3">
                <div className="text-xs text-text-secondary">
                  {runtimeKind === 'llamacpp'
                    ? 'Enter a Hugging Face GGUF repository ID. BotConnector chooses a practical quantization automatically.'
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
              </div>
            </details>
          )}

          <div className="mt-3 px-1 text-[11px] leading-5 text-text-secondary">
            {COPY.fitFootnote}
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
