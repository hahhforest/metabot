import type { CodexReasoningEffort } from '../config.js';
import type { EngineEvent } from './protocol.js';
import type { ApiContext } from './prompt-context.js';

export type { ApiContext } from './prompt-context.js';

/** Engine-neutral team activity surfaced to the Bridge team panel. */
export type TeamEvent =
  | {
      kind: 'task_created';
      taskId: string;
      subject: string;
      description?: string;
      teammate?: string;
      teamName?: string;
    }
  | {
      kind: 'task_completed';
      taskId: string;
      subject: string;
      teammate?: string;
      teamName?: string;
    }
  | {
      kind: 'teammate_idle';
      teammate: string;
      teamName: string;
    };

export interface ExecutorOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  abortController: AbortController;
  outputsDir?: string;
  apiContext?: ApiContext;
  maxTurns?: number;
  model?: string;
  /** Engine-specific reasoning effort. Non-Codex engines ignore it. */
  reasoningEffort?: CodexReasoningEffort;
  /** Empty means no tools. Engines map names onto their native policy surface. */
  allowedTools?: string[];
  onTeamEvent?: (event: TeamEvent) => void;
}

/** One in-flight turn and its user-interaction control surface. */
export interface ExecutionHandle {
  stream: AsyncGenerator<EngineEvent>;
  sendAnswer(toolUseId: string, sessionId: string, answerText: string): void;
  resolveQuestion(toolUseId: string, answers: Record<string, string>): void;
  finish(): void;
}
