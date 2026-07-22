import type { EngineName } from './names.js';

export interface EngineCapabilities {
  liveText: boolean;
  tools: boolean;
  sessions: boolean;
  questions: boolean;
  permissions: boolean;
  steering: boolean;
  subagents: boolean;
  cancellation: 'best-effort' | 'acknowledged';
}

export interface EngineDescriptor {
  name: EngineName;
  displayName: string;
  capabilities: EngineCapabilities;
  exampleModels: readonly string[];
  modelDescriptions?: Readonly<Record<string, string>>;
  authTip: string;
}

export const ENGINE_DESCRIPTORS: Readonly<Record<EngineName, EngineDescriptor>> = {
  claude: {
    name: 'claude',
    displayName: 'Claude Code',
    capabilities: {
      liveText: true,
      tools: true,
      sessions: true,
      questions: true,
      permissions: false,
      steering: false,
      subagents: true,
      cancellation: 'best-effort',
    },
    exampleModels: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    modelDescriptions: {
      'claude-fable-5': 'Fable 5 · native 1M context · adaptive thinking',
      'claude-opus-4-8': 'Opus 4.8 · high-capability model',
      'claude-sonnet-4-6': 'Sonnet 4.6 · balanced capability and speed',
      'claude-haiku-4-5': 'Haiku 4.5 · fastest option',
    },
    authTip: 'Make sure Claude Code is authenticated (`claude login`).',
  },
  kimi: {
    name: 'kimi',
    displayName: 'Kimi Code',
    capabilities: {
      liveText: true,
      tools: true,
      sessions: true,
      questions: true,
      permissions: false,
      steering: true,
      subagents: true,
      cancellation: 'acknowledged',
    },
    exampleModels: ['kimi-code/k3', 'kimi-code/kimi-for-coding-highspeed'],
    modelDescriptions: {
      'kimi-code/k3': 'Kimi K3 · current subscription model',
      'kimi-code/kimi-for-coding-highspeed': 'Low-latency coding model',
    },
    authTip: 'Make sure `kimi login` has been completed on this host.',
  },
  codex: {
    name: 'codex',
    displayName: 'Codex',
    capabilities: {
      liveText: false,
      tools: true,
      sessions: true,
      questions: false,
      permissions: false,
      steering: false,
      subagents: false,
      cancellation: 'best-effort',
    },
    exampleModels: [
      'gpt-5.6',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.5-codex',
      'gpt-5.2-codex',
    ],
    modelDescriptions: {
      'gpt-5.6': 'General GPT-5.6 Codex model',
      'gpt-5.6-sol': 'Flagship capability model',
      'gpt-5.6-terra': 'Balanced Codex worker model',
      'gpt-5.6-luna': 'Efficient high-volume model',
      'gpt-5.5': 'Legacy Codex model',
      'gpt-5.5-codex': 'Legacy Codex coding model',
      'gpt-5.2-codex': 'Legacy Codex coding model',
    },
    authTip: 'Make sure Codex CLI is authenticated (`codex login`) or configured with an API key.',
  },
  opencode: {
    name: 'opencode',
    displayName: 'OpenCode',
    capabilities: {
      liveText: true,
      tools: true,
      sessions: true,
      questions: true,
      permissions: true,
      steering: true,
      subagents: true,
      cancellation: 'acknowledged',
    },
    exampleModels: ['openai/gpt-5.6', 'anthropic/claude-sonnet-4-6', 'google/gemini-3.1-pro'],
    modelDescriptions: {
      'openai/gpt-5.6': 'OpenAI provider model',
      'anthropic/claude-sonnet-4-6': 'Anthropic provider model',
      'google/gemini-3.1-pro': 'Google provider model',
    },
    authTip: 'Make sure OpenCode is configured (`opencode providers`) and version 1.17.14 is installed.',
  },
};

export function getEngineDescriptor(name: EngineName): EngineDescriptor {
  return ENGINE_DESCRIPTORS[name];
}
