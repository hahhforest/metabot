import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { Engine } from '../types.js';
import { getEngineDescriptor } from '../registry.js';
import { CodexExecutor } from './executor.js';
import { listCodexSessions } from './session-lister.js';
import type { EngineSessionSummary, ListEngineSessionsOptions } from '../session.js';

export class CodexEngine implements Engine {
  readonly name = 'codex' as const;
  readonly descriptor = getEngineDescriptor(this.name);

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  createExecutor(): CodexExecutor {
    return new CodexExecutor(this.config, this.logger);
  }

  async listSessions(options: ListEngineSessionsOptions): Promise<EngineSessionSummary[]> {
    return listCodexSessions(options);
  }
}

export { CodexExecutor } from './executor.js';
export {
  createCodexTranslatorState,
  translateCodexJsonEvent,
} from './jsonl-translator.js';
export type { CodexJsonEvent, CodexTranslatorState } from './jsonl-translator.js';
