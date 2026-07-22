import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { Engine, Executor } from '../types.js';
import { getEngineDescriptor } from '../registry.js';
import { ClaudeExecutor } from './executor.js';

export class ClaudeEngine implements Engine {
  readonly name = 'claude' as const;
  readonly descriptor = getEngineDescriptor(this.name);

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  createExecutor(): Executor {
    return new ClaudeExecutor(this.config, this.logger);
  }
}

export { ClaudeExecutor } from './executor.js';
export { StreamProcessor, extractImagePaths } from './stream-processor.js';
export { DEFAULT_CODEX_GOAL_MAX_ITERATIONS, SessionManager } from './session-manager.js';
export type { UserSession } from './session-manager.js';
export type {
  ExecutionHandle,
  ExecutorOptions,
  ApiContext,
  TeamEvent,
} from './executor.js';
export type { EngineEvent } from '../protocol.js';
export type { DetectedTool } from './stream-processor.js';
