import { describe, expect, it, vi } from 'vitest';
import type { SessionV2Info } from '@opencode-ai/sdk/v2/types';
import type { OpenCodeControlPlane } from '../src/engines/opencode/control-plane.js';
import { listOpenCodeSessions } from '../src/engines/opencode/session-lister.js';

function nativeSession(id: string, title: string, updated: number, directory = '/repo'): SessionV2Info {
  return {
    id,
    title,
    projectID: 'project',
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated },
  };
}

describe('listOpenCodeSessions', () => {
  it('filters by authoritative directory and maps newest sessions', async () => {
    const controlPlane = {
      listSessions: vi.fn(async () => ({
        sessions: [
          nativeSession('old', 'Old session', 10),
          nativeSession('other', 'Other project', 30, '/other'),
          nativeSession('new', 'A very useful session', 20),
        ],
      })),
    } as unknown as OpenCodeControlPlane;

    const result = await listOpenCodeSessions({
      controlPlane,
      workingDirectory: '/repo',
      currentSessionId: 'new',
      limit: 10,
    });

    expect(controlPlane.listSessions).toHaveBeenCalledWith({ directory: '/repo', limit: 10 });
    expect(result).toEqual([
      { sessionId: 'new', preview: 'A very useful session', lastActive: 20, sizeBytes: 0, isCurrent: true },
      { sessionId: 'old', preview: 'Old session', lastActive: 10, sizeBytes: 0, isCurrent: false },
    ]);
  });
});
