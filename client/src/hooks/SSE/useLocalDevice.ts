import { useEffect } from 'react';
import { useSetRecoilState } from 'recoil';
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

function toLocalMessages(messages: TMessage[], responseId: string): LocalModelMessage[] {
  return messages
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
}

function localModelName(modelPath: string) {
  const normalized = modelPath.replace(/\\/g, '/');
  return normalized.split('/').pop() || 'Local AI';
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
              content: [{ type: 'text', text }],
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
        const result = await localChat(modelMessages, modelPath, controller.signal);
        const answer = String(result?.content || '').trim();
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
