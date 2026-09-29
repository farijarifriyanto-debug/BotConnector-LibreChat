import { useEffect } from 'react';
import { useSetRecoilState } from 'recoil';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TSubmission } from 'librechat-data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import { localChat } from '~/utils/botconnectorLocalRuntime';
import store from '~/store';

type ChatHelpers = Pick<EventHandlerParams, 'setMessages' | 'getMessages' | 'setIsSubmitting'>;

type LocalModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
};

const LOCAL_HISTORY_TOKEN_BUDGET = 4096;

function estimateLocalMessageTokens(message: LocalModelMessage) {
  const text = String(message.content || '');
  return Math.max(1, Math.ceil(text.length / 4)) + 6;
}

export function trimLocalMessages(
  messages: LocalModelMessage[],
  tokenBudget = LOCAL_HISTORY_TOKEN_BUDGET,
): LocalModelMessage[] {
  if (!messages.length || tokenBudget <= 0) return messages.slice(-1);

  const kept: LocalModelMessage[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const cost = estimateLocalMessageTokens(message);
    if (kept.length > 0 && used + cost > tokenBudget) break;
    kept.unshift(message);
    used += cost;
  }

  while (kept.length > 1 && kept[0]?.role === 'assistant') {
    kept.shift();
  }
  return kept;
}

function toLocalMessages(messages: TMessage[], responseId: string): LocalModelMessage[] {
  const localMessages = messages
    .filter(
      (message) =>
        message.messageId !== responseId &&
        typeof message.text === 'string' &&
        message.text.trim().length > 0,
    )
    .map((message) => ({
      role: message.isCreatedByUser === true ? ('user' as const) : ('assistant' as const),
      content: message.text,
    }));

  return trimLocalMessages(localMessages);
}

function localModelName(modelPath: string) {
  const normalized = modelPath.replace(/\\/g, '/');
  const deviceModel = normalized.match(/^device:[^:]+:(.+)$/)?.[1] || normalized;
  return deviceModel.split('/').pop()?.replace(/\.gguf$/i, '') || 'Local AI';
}

export function localizePendingLocalResponse(
  messages: TMessage[],
  responseId: string,
  modelPath: string,
): TMessage[] {
  const sender = 'BotConnector Local';
  const model = localModelName(modelPath);
  let changed = false;

  const next = messages.map((message) => {
    if (message.messageId !== responseId) return message;
    if (message.sender === sender && message.model === model) return message;
    changed = true;
    return { ...message, sender, model };
  });

  return changed ? next : messages;
}

export default function useLocalDevice(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  runIndex = 0,
  modelPath = '',
) {
  const setSubmission = useSetRecoilState(store.submissionByIndex(runIndex));
  const setShowStopButton = useSetRecoilState(store.showStopButtonByIndex(runIndex));
  const { setMessages, getMessages, setIsSubmitting } = chatHelpers;

  useEffect(() => {
    if (submission == null || Object.keys(submission).length === 0) {
      return;
    }

    const responseId = submission.initialResponse?.messageId;
    if (!responseId) {
      setIsSubmitting(false);
      setShowStopButton(false);
      setSubmission(null);
      return;
    }

    const controller = new AbortController();
    let settled = false;

    // The optimistic assistant row is created from the Cloud conversation metadata.
    // Local mode must replace that identity before inference starts; otherwise the
    // processing placeholder briefly shows the previously selected Cloud model.
    const currentMessages = getMessages() ?? [];
    const localizedPending = localizePendingLocalResponse(
      currentMessages,
      responseId,
      modelPath,
    );
    if (localizedPending !== currentMessages) {
      setMessages(localizedPending);
    }

    const updatePending = (text: string) => {
      if (settled) return;
      const messages = getMessages() ?? [];
      const next = messages.map((message) =>
        message.messageId === responseId
          ? {
              ...message,
              text,
              content: [{ type: ContentTypes.TEXT, text }],
              sender: 'BotConnector Local',
              model: localModelName(modelPath),
              unfinished: true,
              error: false,
            }
          : message,
      );
      setMessages(next);
    };

    const finish = (text: string, error = false) => {
      if (settled) return;
      settled = true;
      const messages = getMessages() ?? [];
      const completedAt = new Date().toISOString();
      const settledResponseId = responseId.endsWith('_') ? `${responseId}local` : responseId;
      const next = messages.map((message) =>
        message.messageId === responseId
          ? {
              ...message,
              messageId: settledResponseId,
              text,
              content: [{ type: ContentTypes.TEXT, text }],
              sender: 'BotConnector Local',
              model: localModelName(modelPath),
              createdAt: message.createdAt ?? completedAt,
              updatedAt: completedAt,
              unfinished: false,
              error,
            }
          : message,
      );
      setMessages(next);
      setIsSubmitting(false);
      setShowStopButton(false);
      setSubmission(null);
    };

    void (async () => {
      try {
        if (!modelPath) {
          throw new Error('Pilih model lokal pada header sebelum mengirim pesan.');
        }
        if ((submission.userMessage?.files?.length ?? 0) > 0) {
          throw new Error(
            'Local Device saat ini mendukung chat teks. File belum dikirim ke runtime lokal.',
          );
        }
        const current = getMessages() ?? [];
        // Local Device must not inherit a cloud/provider promptPrefix. Keeping the
        // conversation's cloud system prompt here makes the same local model behave
        // differently from Lemonade's native chat and can leak provider identity
        // (for example, a Google/OpenAI persona) into an otherwise local session.
        // Send only the local chat history; a dedicated Local system prompt can be
        // added later as an explicit Local-AI setting rather than inherited state.
        const modelMessages = toLocalMessages(current, responseId);
        let streamedText = '';
        updatePending('Thinking…');
        const result = await localChat(
          modelMessages,
          modelPath,
          controller.signal,
          (delta) => {
            if (settled) return;
            if (delta.thinking === true && !streamedText) {
              updatePending('Thinking…');
            }
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              streamedText += delta.content;
              updatePending(streamedText);
            }
          },
        );
        const answer = String(result?.content || streamedText || '').trim();
        finish(answer || 'Model lokal tidak mengirim jawaban.');
      } catch (error) {
        if (controller.signal.aborted || (error as Error)?.name === 'AbortError') {
          finish('Generasi lokal dihentikan.');
          return;
        }
        finish(`Local AI error: ${String((error as Error)?.message || error)}`, true);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [
    submission,
    modelPath,
    getMessages,
    setMessages,
    setIsSubmitting,
    setShowStopButton,
    setSubmission,
  ]);
}
