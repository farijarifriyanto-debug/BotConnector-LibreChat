import { useCallback, useEffect, useMemo, useState } from 'react';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import {
  getLocalHardware,
  getLocalHardwareRecommendations,
  installLocalRuntimeComponents,
  probeLocalRuntime,
} from '~/utils/botconnectorLocalRuntime';
import type {
  LocalHardwareInfo,
  LocalHardwareRecommendation,
  LocalHardwareRecommendations,
} from '~/utils/botconnectorLocalRuntime';
import { cn } from '~/utils';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const COPY = {
  title: 'Local AI · Device model fit',
  description:
    'BotConnector reads this device locally and uses the Local Runtime advisor to find models and quantizations that fit. Hardware data stays on this device.',
  detectedHardware: 'Detected hardware',
  detectedHardwareHelp: 'CPU, RAM, GPU, VRAM, platform, and runtime backend.',
  scanning: 'Scanning…',
  scanAgain: 'Scan again',
  recommendedModels: 'Recommended local models',
  recommendedModelsHelp:
    'Ranked by llmfit for this hardware. Token speed is an estimate, not a guarantee.',
  advisorSource: 'Advisor: llmfit · llama.cpp',
  installAdvisor: 'Install / repair Local AI advisor',
  installingAdvisor: 'Installing advisor…',
  calculatingFit: 'Detecting hardware and calculating model fit…',
  noRecommendation: 'No compatible recommendation was returned for this device yet.',
  runtimeOffline:
    'BotConnector Local Runtime is not reachable at 127.0.0.1:18764. Open the BotConnector desktop app on this laptop, then scan again. If it is already open, allow Local Network Access for app.botconnector.id in the browser.',
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

function modelMeta(model: LocalHardwareRecommendation) {
  return [
    model.run_mode_label || model.run_mode,
    model.best_quant,
    typeof model.memory_required_gb === 'number'
      ? `Memory ~${model.memory_required_gb.toFixed(1)} GB`
      : '',
    typeof model.estimated_tps === 'number' ? `~${model.estimated_tps.toFixed(1)} tok/s` : '',
  ].filter(Boolean);
}

export default function LocalModelAdvisor({ open, onOpenChange }: Props) {
  const [hardware, setHardware] = useState<LocalHardwareInfo | null>(null);
  const [recommendations, setRecommendations] = useState<LocalHardwareRecommendations | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [runtimeReachable, setRuntimeReachable] = useState<boolean | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await probeLocalRuntime();
      setRuntimeReachable(true);
      const detected = await getLocalHardware();
      setHardware(detected);

      try {
        const result = await getLocalHardwareRecommendations();
        setRecommendations(result);
        if (result?.error) {
          setError(errorMessage(result.error));
        }
      } catch (recommendationError) {
        setRecommendations(null);
        setError(String((recommendationError as Error)?.message || recommendationError));
      }
    } catch (hardwareError) {
      setHardware(null);
      setRecommendations(null);
      const message = String((hardwareError as Error)?.message || hardwareError);
      const networkFailure =
        message === 'Failed to fetch' ||
        message.includes('NetworkError') ||
        message.includes('Load failed');
      if (networkFailure) {
        setRuntimeReachable(false);
        setError(COPY.runtimeOffline);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

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

  const system = recommendations?.system;
  const gpuNames = useMemo(() => {
    const localNames = hardware?.nvidia?.map((gpu) => gpu.name).filter(Boolean) ?? [];
    if (localNames.length) return localNames.join(', ');
    if (system?.gpu_name) return system.gpu_name;
    const recommendedNames = system?.gpus?.map((gpu) => gpu.name).filter(Boolean) ?? [];
    return recommendedNames.length ? recommendedNames.join(', ') : 'No NVIDIA GPU detected';
  }, [hardware?.nvidia, system?.gpu_name, system?.gpus]);

  const models = Array.isArray(recommendations?.models) ? recommendations.models.slice(0, 10) : [];

  const specs = [
    ['CPU', hardware?.cpu || system?.cpu_name || 'Unknown'],
    [
      'RAM',
      typeof hardware?.ramGb === 'number'
        ? `${formatGb(hardware.ramGb)} total · ${formatGb(hardware.freeRamGb)} free`
        : formatGb(system?.total_ram_gb),
    ],
    ['GPU', gpuNames],
    [
      'VRAM',
      hardware?.nvidia?.length
        ? hardware.nvidia
            .map((gpu) =>
              typeof gpu.memoryGb === 'number' ? `${gpu.memoryGb.toFixed(1)} GB` : 'Unknown',
            )
            .join(' + ')
        : 'Not detected',
    ],
    [
      'System',
      [hardware?.platform, hardware?.arch, hardware?.release].filter(Boolean).join(' · ') ||
        'Unknown',
    ],
    ['Backend', system?.backend || 'llama.cpp · automatic'],
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

          <div className="mt-6 flex flex-wrap items-end justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-text-primary">{COPY.recommendedModels}</div>
              <div className="text-xs text-text-secondary">{COPY.recommendedModelsHelp}</div>
            </div>
            {recommendations?.system && (
              <div className="text-xs text-text-secondary">{COPY.advisorSource}</div>
            )}
          </div>

          {error && (
            <div className="mt-3 rounded-xl border border-border-light bg-surface-secondary/50 p-3 text-sm text-text-secondary">
              <div>{error}</div>
              {runtimeReachable === false ? (
                <a
                  href="http://127.0.0.1:18764/api/botconnector/local/health"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex h-9 items-center rounded-xl border border-border-light bg-presentation px-3 text-sm font-medium text-text-primary hover:bg-surface-active-alt"
                >
                  {COPY.testRuntime}
                </a>
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
              {COPY.noRecommendation}
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
                    <div className="mt-2 text-xs text-text-secondary">
                      {COPY.score} {Number(model.score || 0).toFixed(0)} ·{' '}
                      {model.runtime_label || model.runtime || 'llama.cpp'}
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
