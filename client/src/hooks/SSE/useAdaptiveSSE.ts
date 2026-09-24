import { isAssistantsEndpoint } from 'librechat-data-provider';
import { useRecoilValue } from 'recoil';
import type { TSubmission } from 'librechat-data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import useResumableSSE from './useResumableSSE';
import useLocalDevice from './useLocalDevice';
import useSSE from './useSSE';
import store from '~/store';

type ChatHelpers = Pick<
  EventHandlerParams,
  'setMessages' | 'getMessages' | 'setConversation' | 'setIsSubmitting' | 'newConversation'
>;

/**
 * Adaptive SSE hook that switches between standard and resumable modes.
 * Uses resumable streams by default, falls back to standard SSE for assistants endpoints.
 *
 * Note: Both hooks are always called to comply with React's Rules of Hooks.
 * We pass null submission to the inactive one.
 */
export default function useAdaptiveSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  const computeTarget = useRecoilValue(store.botconnectorComputeTarget);
  const localModelPath = useRecoilValue(store.botconnectorLocalModelPath);
  const localEnabled = computeTarget === 'device';
  const endpoint = submission?.conversation?.endpoint;
  const endpointType = submission?.conversation?.endpointType;
  const actualEndpoint = endpointType ?? endpoint;
  const isAssistants = isAssistantsEndpoint(actualEndpoint);
  const resumableEnabled = !localEnabled && !isAssistants;

  useLocalDevice(localEnabled ? submission : null, chatHelpers, runIndex, localModelPath);
  useSSE(
    !localEnabled && !resumableEnabled ? submission : null,
    chatHelpers,
    isAddedRequest,
    runIndex,
  );

  const { streamId } = useResumableSSE(
    resumableEnabled ? submission : null,
    chatHelpers,
    isAddedRequest,
    runIndex,
  );

  return { streamId: localEnabled ? undefined : streamId, resumableEnabled };
}
