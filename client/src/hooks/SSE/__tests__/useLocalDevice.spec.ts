import type { TMessage } from 'librechat-data-provider';
import { localizePendingLocalResponse, trimLocalMessages } from '../useLocalDevice';

describe('Local Device pending response identity', () => {
  it('relabels the optimistic Cloud response before Local inference starts', () => {
    const user = {
      messageId: 'user-1',
      isCreatedByUser: true,
      text: 'cek spesifikasi laptop saya',
      sender: 'User',
    } as TMessage;
    const pending = {
      messageId: 'response-1_',
      isCreatedByUser: false,
      text: '',
      sender: 'Agnes 3.0 Flash · Free',
      model: 'agnes-3.0-flash',
    } as TMessage;

    const next = localizePendingLocalResponse(
      [user, pending],
      'response-1_',
      'device:llamacpp:Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    );

    expect(next[0]).toBe(user);
    expect(next[1]).toMatchObject({
      sender: 'BotConnector Local',
      model: 'Qwen2.5-1.5B-Instruct-GGUF',
      text: '',
    });
  });

  it('trims old Local history to the token budget while keeping the latest user turn', () => {
    const trimmed = trimLocalMessages(
      [
        { role: 'user', content: 'old '.repeat(400) },
        { role: 'assistant', content: 'older answer '.repeat(300) },
        { role: 'user', content: 'siapa anda' },
      ],
      40,
    );

    expect(trimmed).toEqual([{ role: 'user', content: 'siapa anda' }]);
  });

  it('does not begin a trimmed Local history with an orphaned assistant turn', () => {
    const trimmed = trimLocalMessages(
      [
        { role: 'assistant', content: 'old assistant' },
        { role: 'user', content: 'latest user' },
      ],
      100,
    );

    expect(trimmed).toEqual([{ role: 'user', content: 'latest user' }]);
  });

  it('does not rewrite unrelated messages', () => {
    const messages = [
      {
        messageId: 'other-response',
        isCreatedByUser: false,
        text: '',
        sender: 'Agnes 3.0 Flash · Free',
      } as TMessage,
    ];

    expect(
      localizePendingLocalResponse(messages, 'response-1_', 'device:llamacpp:model-1'),
    ).toBe(messages);
  });
});
