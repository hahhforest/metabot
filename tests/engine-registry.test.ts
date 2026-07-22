import { describe, expect, it } from 'vitest';
import {
  ENGINE_NAMES,
  createEngine,
  getEngineDescriptor,
  isEngineName,
  resolveEngineName,
} from '../src/engines/index.js';

const logger = {
  child: () => logger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as any;

const config = {
  name: 'test',
  claude: {
    defaultWorkingDirectory: '/tmp',
    maxTurns: undefined,
    maxBudgetUsd: undefined,
    model: undefined,
    apiKey: undefined,
    outputsBaseDir: '/tmp/outputs',
    downloadsDir: '/tmp/downloads',
    backend: 'sdk',
  },
} as any;

describe('engine registry', () => {
  it('has one truthful descriptor for every engine name', () => {
    for (const name of ENGINE_NAMES) {
      const descriptor = getEngineDescriptor(name);
      expect(descriptor.name).toBe(name);
      expect(descriptor.displayName).toBeTruthy();
      expect(descriptor.exampleModels.length).toBeGreaterThan(0);
    }
  });

  it('uses the centralized name parser for configuration', () => {
    expect(isEngineName('claude')).toBe(true);
    expect(isEngineName('kimi')).toBe(true);
    expect(isEngineName('codex')).toBe(true);
    expect(isEngineName('opencode')).toBe(true);
    expect(isEngineName('unknown')).toBe(false);
  });

  it('creates an engine whose descriptor matches the selected transport', () => {
    for (const name of ENGINE_NAMES) {
      const engine = createEngine(config, logger, name);
      expect(engine.name).toBe(name);
      expect(engine.descriptor).toBe(getEngineDescriptor(name));
    }
  });

  it('falls back to Codex for an invalid environment default', () => {
    const previous = process.env.METABOT_ENGINE;
    process.env.METABOT_ENGINE = 'not-an-engine';
    try {
      expect(resolveEngineName(config)).toBe('codex');
    } finally {
      if (previous === undefined) delete process.env.METABOT_ENGINE;
      else process.env.METABOT_ENGINE = previous;
    }
  });
});
