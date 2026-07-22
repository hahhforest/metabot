import path from 'node:path';
import type { EngineSessionSummary, ListEngineSessionsOptions } from '../session.js';
import type { OpenCodeControlPlane } from './control-plane.js';

export async function listOpenCodeSessions(
  options: ListEngineSessionsOptions & {
    controlPlane: OpenCodeControlPlane;
    previewMaxLength?: number;
  },
): Promise<EngineSessionSummary[]> {
  const limit = options.limit ?? 10;
  const previewMaxLength = options.previewMaxLength ?? 80;
  const directory = path.resolve(options.workingDirectory);
  const page = await options.controlPlane.listSessions({ directory, limit });
  return page.sessions
    .filter((session) => path.resolve(session.location.directory) === directory)
    .sort((a, b) => b.time.updated - a.time.updated)
    .slice(0, limit)
    .map((session) => ({
      sessionId: session.id,
      preview: truncate(session.title || '(no preview)', previewMaxLength),
      lastActive: session.time.updated,
      sizeBytes: 0,
      isCurrent: session.id === options.currentSessionId,
    }));
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}
