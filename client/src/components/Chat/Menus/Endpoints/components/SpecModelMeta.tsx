import type { TModelSpec, ModelCapabilityEvidence } from 'librechat-data-provider';
import { cn } from '~/utils';

const STATUS_STYLE: Record<ModelCapabilityEvidence, string> = {
  runtime_verified: 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300',
  experimental: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  source_declared: 'border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  unsupported: 'border-border-light bg-surface-secondary text-text-tertiary',
};

const STATUS_MARK: Record<ModelCapabilityEvidence, string> = {
  runtime_verified: '●',
  experimental: '◐',
  source_declared: '○',
  unsupported: '×',
};

export default function SpecModelMeta({ spec }: { spec: TModelSpec }) {
  const capabilities = spec.modelCapabilities ?? [];
  if (!spec.computeTargetLabel && !spec.runtimeLabel && capabilities.length === 0) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {spec.computeTargetLabel && (
          <span className="rounded-md border border-border-light bg-surface-secondary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
            🖥 {spec.computeTargetLabel}
          </span>
        )}
        {capabilities.map((capability) => (
          <span
            key={capability.id}
            title={capability.status.replaceAll('_', ' ')}
            className={cn(
              'rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
              STATUS_STYLE[capability.status],
            )}
          >
            {STATUS_MARK[capability.status]} {capability.label}
          </span>
        ))}
      </div>
      {spec.runtimeLabel && (
        <span className="break-words text-[10px] leading-4 text-text-tertiary">
          {spec.runtimeLabel}
        </span>
      )}
    </div>
  );
}
