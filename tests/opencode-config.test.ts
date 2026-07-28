import { afterEach, describe, expect, it } from 'vitest';
import { buildOpenCodeConfig, webBotFromJson } from '../src/config.js';

const KEYS = [
  'OPENCODE_EXECUTABLE_PATH',
  'OPENCODE_SERVER_URL',
  'OPENCODE_SERVER_PORT',
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_MODEL',
  'OPENCODE_AGENT',
  'OPENCODE_VARIANT',
  'OPENCODE_PERMISSION_MODE',
  'OPENCODE_PURE',
  'OPENCODE_CONTEXT_WINDOW',
] as const;

const previous = new Map(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('buildOpenCodeConfig', () => {
  it('returns undefined when no OpenCode configuration exists', () => {
    for (const key of KEYS) delete process.env[key];
    expect(buildOpenCodeConfig()).toBeUndefined();
  });

  it('normalizes environment configuration', () => {
    process.env.OPENCODE_SERVER_URL = 'http://127.0.0.1:4096';
    process.env.OPENCODE_SERVER_PORT = '43123';
    process.env.OPENCODE_MODEL = 'openai/gpt-5.6';
    process.env.OPENCODE_PERMISSION_MODE = 'ask';
    process.env.OPENCODE_PURE = 'true';
    process.env.OPENCODE_CONTEXT_WINDOW = '272000';

    expect(buildOpenCodeConfig()).toEqual(expect.objectContaining({
      serverUrl: 'http://127.0.0.1:4096',
      port: 43123,
      model: 'openai/gpt-5.6',
      permissionMode: 'ask',
      pure: true,
      contextWindow: 272000,
    }));
  });

  it('gives bots.json fields precedence over environment defaults', () => {
    process.env.OPENCODE_MODEL = 'openai/gpt-5.6';
    process.env.OPENCODE_PERMISSION_MODE = 'auto';

    expect(buildOpenCodeConfig({ model: 'anthropic/claude-sonnet-4-6', permissionMode: 'deny' }))
      .toEqual(expect.objectContaining({
        model: 'anthropic/claude-sonnet-4-6',
        permissionMode: 'deny',
      }));
  });

  it('accepts only registered engine names at the untyped JSON boundary', () => {
    const base = { name: 'web', defaultWorkingDirectory: '/tmp' };
    expect(webBotFromJson({ ...base, engine: 'opencode' }).engine).toBe('opencode');
    expect(webBotFromJson({ ...base, engine: 'future-engine' as any }).engine).toBeUndefined();
  });
});
