import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type {
  ClaudeExecutor,
  ExecutionHandle,
  ExecutorOptions,
  ApiContext,
  TeamEvent,
} from './claude/executor.js';
import type { CodexExecutor } from './codex/executor.js';
import type { EngineDescriptor } from './registry.js';
import type { EngineEvent } from './protocol.js';
import type { EngineSessionSummary, ListEngineSessionsOptions } from './session.js';

export type { EngineName } from './names.js';
import type { EngineName } from './names.js';

/**
 * An Engine is a programmable agent backend (Claude Code, Kimi Code, …).
 * It produces an Executor that the bridge drives for a single chat session.
 *
 * In Phase 1 we only ship the Claude implementation; the interface lets us
 * drop in a Kimi implementation without touching the bridge.
 */
export interface Engine {
  readonly name: EngineName;
  readonly descriptor: EngineDescriptor;
  /** Returns the executor used to run queries for this engine. */
  createExecutor(): Executor;
  /** Lists native sessions that can be resumed in a working directory. */
  listSessions(options: ListEngineSessionsOptions): Promise<EngineSessionSummary[]>;
  /** Releases engine-owned runtime resources. */
  shutdown?(): Promise<void>;
}

/**
 * Executor abstraction. Both engines must support the multi-turn
 * `startExecution` path (streaming + sendAnswer + resolveQuestion + finish)
 * and the one-shot `execute` path used by voice mode.
 *
 * Native engine protocols are translated into the shared EngineEvent shape at
 * the adapter boundary.
 */
export interface Executor {
  startExecution(options: ExecutorOptions): ExecutionHandle;
  execute(options: ExecutorOptions): AsyncGenerator<EngineEvent>;
  /** Optional native mid-turn steering keyed by the bridge chat id. */
  canSteer?(chatId: string): boolean;
  steer?(chatId: string, prompt: string): Promise<'steered' | 'no-active-turn'>;
}

export type {
  ClaudeExecutor,
  CodexExecutor,
  ExecutionHandle,
  ExecutorOptions,
  EngineEvent,
  ApiContext,
  TeamEvent,
  EngineSessionSummary,
  ListEngineSessionsOptions,
};

/** Context passed to engine factory. */
export interface EngineContext {
  config: BotConfigBase;
  logger: Logger;
}
