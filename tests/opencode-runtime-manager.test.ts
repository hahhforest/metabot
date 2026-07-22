import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  OpenCodeRuntimeManager,
  normalizeServerUrl,
  SUPPORTED_OPENCODE_VERSION,
} from '../src/engines/opencode/runtime-manager.js';

const logger = {
  child: () => logger,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function fakeChild() {
  const emitter = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.stderr = new PassThrough();
  emitter.kill = vi.fn((signal: NodeJS.Signals) => {
    emitter.signalCode = signal;
    queueMicrotask(() => emitter.emit('exit', null, signal));
    return true;
  });
  return emitter;
}

describe('OpenCodeRuntimeManager', () => {
  it('connects to an explicit external server and never owns its shutdown', async () => {
    const createClient = vi.fn(() => ({}) as any);
    const manager = new OpenCodeRuntimeManager(
      { serverUrl: 'http://127.0.0.1:4096/', serverUsername: 'bot', serverPassword: 'secret' },
      logger,
      {
        createClient,
        probe: async () => ({ healthy: true, version: SUPPORTED_OPENCODE_VERSION }),
      },
    );

    const runtime = await manager.start();

    expect(runtime.ownership).toBe('external');
    expect(runtime.url).toBe('http://127.0.0.1:4096');
    runtime.client('/repo');
    expect(createClient).toHaveBeenLastCalledWith(expect.objectContaining({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/repo',
      headers: { Authorization: `Basic ${Buffer.from('bot:secret').toString('base64')}` },
    }));
    await manager.close();
  });

  it('deduplicates managed startup, binds loopback, authenticates, and owns shutdown', async () => {
    const child = fakeChild();
    const spawnServer = vi.fn(() => child as any);
    const manager = new OpenCodeRuntimeManager(
      { executable: '/usr/local/bin/opencode', pure: true },
      logger,
      {
        spawnServer,
        createClient: vi.fn(() => ({}) as any),
        findFreePort: async () => 43123,
        probe: async () => ({ healthy: true, version: SUPPORTED_OPENCODE_VERSION }),
      },
    );

    const [first, second] = await Promise.all([manager.start(), manager.start()]);

    expect(first).toBe(second);
    expect(first.ownership).toBe('managed');
    expect(spawnServer).toHaveBeenCalledTimes(1);
    expect(spawnServer).toHaveBeenCalledWith(
      '/usr/local/bin/opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '43123', '--pure'],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCODE_SERVER_USERNAME: 'opencode',
          OPENCODE_SERVER_PASSWORD: expect.any(String),
        }),
      }),
    );

    await manager.close();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails fast when the server and pinned SDK contract do not match', async () => {
    const manager = new OpenCodeRuntimeManager(
      { serverUrl: 'http://127.0.0.1:4096' },
      logger,
      {
        createClient: vi.fn(() => ({}) as any),
        probe: async () => ({ healthy: true, version: '1.18.4' }),
      },
    );

    await expect(manager.start()).rejects.toThrow(
      `Unsupported OpenCode server version 1.18.4; MetaBot requires ${SUPPORTED_OPENCODE_VERSION}`,
    );
  });

  it('rejects non-HTTP external server URLs', () => {
    expect(() => normalizeServerUrl('file:///tmp/opencode.sock')).toThrow('must use http or https');
  });
});

