import { endpointSchema } from './config';

describe('custom endpoint programmaticMcpServers', () => {
  const base = {
    name: 'BotConnector',
    apiKey: 'test-key',
    baseURL: 'http://127.0.0.1:49260/v1',
    models: { default: ['default'] },
  };

  test('accepts explicit MCP server names', () => {
    const parsed = endpointSchema.parse({
      ...base,
      programmaticMcpServers: ['fetch', 'sequential-thinking'],
    });
    expect(parsed.programmaticMcpServers).toEqual(['fetch', 'sequential-thinking']);
  });

  test('rejects empty MCP server names', () => {
    expect(
      endpointSchema.safeParse({
        ...base,
        programmaticMcpServers: ['fetch', ''],
      }).success,
    ).toBe(false);
  });
});
