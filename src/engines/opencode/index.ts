import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import type { Engine, Executor } from '../types.js';
import type { EngineSessionSummary, ListEngineSessionsOptions } from '../session.js';
import { getEngineDescriptor } from '../registry.js';
import { SdkOpenCodeControlPlane } from './control-plane.js';
import { OpenCodeExecutor } from './executor.js';
import { OpenCodeRuntimeManager } from './runtime-manager.js';
import { listOpenCodeSessions } from './session-lister.js';

export class OpenCodeEngine implements Engine {
  readonly name = 'opencode' as const;
  readonly descriptor = getEngineDescriptor(this.name);
  private readonly runtime: OpenCodeRuntimeManager;

  constructor(
    private readonly config: BotConfigBase,
    private readonly logger: Logger,
  ) {
    this.runtime = new OpenCodeRuntimeManager(config.opencode ?? {}, logger);
  }

  createExecutor(): Executor {
    return new OpenCodeExecutor(this.config, this.logger, this.runtime);
  }

  async listSessions(options: ListEngineSessionsOptions): Promise<EngineSessionSummary[]> {
    const runtime = await this.runtime.start();
    const controlPlane = new SdkOpenCodeControlPlane(runtime.client(options.workingDirectory));
    return listOpenCodeSessions({ ...options, controlPlane });
  }

  shutdown(): Promise<void> {
    return this.runtime.close();
  }
}

export { OpenCodeExecutor } from './executor.js';
export { OpenCodeRuntimeManager, SUPPORTED_OPENCODE_VERSION } from './runtime-manager.js';
