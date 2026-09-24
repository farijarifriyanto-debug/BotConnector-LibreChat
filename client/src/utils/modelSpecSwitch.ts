import type { TConversation, TModelSpec } from 'librechat-data-provider';

/**
 * Clears settings that came from the previously selected model spec before a
 * raw endpoint/model selection is applied.
 *
 * A model spec may set model-specific values such as maxContextTokens,
 * temperature, reasoning controls, or provider options. Keeping those values
 * while only replacing `model` makes the old spec silently override the new
 * model's native defaults. Endpoint identity is preserved because routing has
 * already been resolved for the target selection; all other values explicitly
 * owned by the old preset are removed and can then be filled by the new model.
 */
export function clearPreviousModelSpecPresetParams(
  template: Partial<TConversation>,
  previousConversation: TConversation | null | undefined,
  modelSpecs: TModelSpec[],
): Partial<TConversation> {
  const previousSpecName = previousConversation?.spec;
  if (!previousSpecName) {
    return template;
  }

  const previousPreset = modelSpecs.find((spec) => spec.name === previousSpecName)?.preset;
  if (!previousPreset) {
    return template;
  }

  const cleaned = { ...template } as Record<string, unknown>;
  for (const key of Object.keys(previousPreset)) {
    if (key === 'endpoint' || key === 'endpointType') {
      continue;
    }
    delete cleaned[key];
  }

  return cleaned as Partial<TConversation>;
}
