export const ENGINE_NAMES = ['claude', 'kimi', 'codex', 'opencode'] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

const ENGINE_NAME_SET = new Set<string>(ENGINE_NAMES);

export function isEngineName(value: unknown): value is EngineName {
  return typeof value === 'string' && ENGINE_NAME_SET.has(value);
}
