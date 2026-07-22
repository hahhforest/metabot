import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { Engine, Executor } from '../types.js';
import { getEngineDescriptor } from '../registry.js';
import { KimiExecutor } from './executor.js';
import { listKimiSessions } from './session-lister.js';
import type { EngineSessionSummary, ListEngineSessionsOptions } from '../session.js';

/**
 * Kimi engine. Uses Kimi Code's official local Server API and reuses the
 * Claude `StreamProcessor`, translating atomic frontend snapshots into the
 * shared card event shape.
 */
export class KimiEngine implements Engine {
  readonly name = 'kimi' as const;
  readonly descriptor = getEngineDescriptor(this.name);

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  createExecutor(): Executor {
    return new KimiExecutor(this.config, this.logger);
  }

  async listSessions(options: ListEngineSessionsOptions): Promise<EngineSessionSummary[]> {
    return listKimiSessions({
      ...options,
      executable: this.config.kimi?.executable,
      serverUrl: this.config.kimi?.serverUrl,
      apiKey: this.config.kimi?.apiKey,
    });
  }
}

export { KimiExecutor } from './executor.js';
