import type { TConversation, TModelSpec } from 'librechat-data-provider';
import { clearPreviousModelSpecPresetParams } from '../modelSpecSwitch';

describe('clearPreviousModelSpecPresetParams', () => {
  it('removes Local Trial preset values when switching to a Cloud model', () => {
    const previousConversation = {
      conversationId: 'new',
      endpoint: 'BotConnector',
      model: 'qwen3-0.6b-local-trial',
      spec: 'botconnector-local-trial-qwen3-0.6b',
      maxContextTokens: 2560,
      temperature: 0.4,
      chatProjectId: 'project-1',
      codeEnvironmentMode: 'without_attached',
    } as TConversation;

    const template = {
      ...previousConversation,
      endpoint: 'BotConnector',
    } as Partial<TConversation>;

    const modelSpecs = [
      {
        name: 'botconnector-local-trial-qwen3-0.6b',
        label: 'Qwen3-0.6B',
        preset: {
          endpoint: 'BotConnector',
          model: 'qwen3-0.6b-local-trial',
          maxContextTokens: 2560,
          temperature: 0.4,
        },
      },
    ] as TModelSpec[];

    const result = clearPreviousModelSpecPresetParams(
      template,
      previousConversation,
      modelSpecs,
    );

    expect(result.endpoint).toBe('BotConnector');
    expect(result.model).toBeUndefined();
    expect(result.maxContextTokens).toBeUndefined();
    expect(result.temperature).toBeUndefined();
    expect(result.chatProjectId).toBe('project-1');
    expect(result.codeEnvironmentMode).toBe('without_attached');
  });

  it('leaves ordinary conversations unchanged when no prior spec is active', () => {
    const template = {
      endpoint: 'BotConnector',
      model: 'agnes-3.0-flash',
      maxContextTokens: 30400,
    } as Partial<TConversation>;

    expect(clearPreviousModelSpecPresetParams(template, null, [])).toBe(template);
  });
});
