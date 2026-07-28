import type { BotConfigBase, CodexReasoningEffort } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage } from '../types.js';
import type { IMessageSender } from './message-sender.interface.js';
import { ENGINE_NAMES, getEngineDescriptor, isEngineName, resolveEngineName, SessionManager } from '../engines/index.js';
import type { EngineName, EngineSessionSummary } from '../engines/index.js';
import { MemoryClient } from '../memory/memory-client.js';
import { AuditLogger } from '../utils/audit-logger.js';
import type { DocSync } from '../sync/doc-sync.js';

export class CommandHandler {
  private docSync: DocSync | null = null;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
    private sender: IMessageSender,
    private sessionManager: SessionManager,
    private memoryClient: MemoryClient,
    private audit: AuditLogger,
    private getActiveTask: (chatId: string) => { startTime: number } | undefined,
    private stopTask: (chatId: string) => void,
    /**
     * Drain the chat's queued-message buffer, returning the number of
     * messages discarded. Called from /stop so the user's "stop" intent
     * isn't immediately undone by the next queued message — without this
     * the bridge's processQueue would start the next one as soon as the
     * aborted task's finally block runs.
     */
    private clearQueue: (chatId: string) => number,
    /**
     * Release the persistent Claude process associated with this chat
     * (no-op if the persistent-executor feature flag is off or no
     * executor exists). Called on /reset so teammates and /goal state
     * tied to the old session are torn down with the conversation.
     */
    private releaseExecutor: (chatId: string, reason: string) => Promise<void>,
    /**
     * List the recent sessions for this chat's active engine and working directory
     * (newest first). Backs the direct `/resume <id>` form. Read-only.
     */
    private listSessions: (chatId: string) => EngineSessionSummary[] | Promise<EngineSessionSummary[]>,
    /**
     * Swap the chat into a previous engine session: re-point the sessionId,
     * reset usage counters, release the persistent executor so the next turn
     * resumes via `claude --resume`. Backs both `/resume` forms.
     */
    private applyResume: (chatId: string, sessionId: string) => Promise<void>,
  ) {}

  /** Set the doc sync service (optional, only available for Feishu bots). */
  setDocSync(docSync: DocSync): void {
    this.docSync = docSync;
  }

  /** Returns true if the message was handled as a command, false otherwise. */
  async handle(msg: IncomingMessage): Promise<boolean> {
    const { text } = msg;
    if (!text.startsWith('/')) return false;

    const { userId, chatId } = msg;
    const [cmd] = text.split(/\s+/);

    this.audit.log({ event: 'command', botName: this.config.name, chatId, userId, prompt: cmd });

    switch (cmd.toLowerCase()) {
      case '/help':
        await this.sender.sendTextNotice(chatId, '📖 Help', [
          '**Bot Commands:**',
          '`/reset` - Clear session, start fresh',
          '`/stop` - Abort current running task',
          '`/status` - Show current session info',
          '`/model` - Show current engine/model; `/model list` - Available options',
          `\`${this.engineSwitchUsage()}\` - Switch engine (resets session)`,
          '`/model <name>` - Set model for current engine',
          '`/effort low|medium|high|xhigh|max|ultra` - Set Codex reasoning effort for this chat',
          '`/resume` - List & switch to a previous engine-native session',
          '`/resume <id>` - Resume a session directly by id prefix',
          '`/memory` - Memory document commands',
          '`@Bot /group-reply mention|all|status` - Feishu group reply mode (scoped to this Agent and group)',
          '`/help` - Show this help message',
          '',
          '**Agent Commands:**',
          '`/goal <description>` - Set a goal the agent keeps pursuing across turns (Claude native, Codex bridge-managed)',
          '`/goal status|clear` - Show or clear the current goal',
          '`/background <prompt>` - Run a task in the background while you continue chatting (Claude native, Codex bridge-managed)',
          '`/background list|logs <id>|stop <id>` - Manage Codex background tasks',
          '',
          '**Usage:**',
          'Send any text message to start a conversation with the configured agent engine.',
          'Each chat has an independent session with a fixed working directory.',
          '',
          '**Memory Commands:**',
          '`/memory list` - Show folder tree',
          '`/memory search <query>` - Search documents',
          '`/memory status` - Server health check',
          '',
          '**Sync Commands:**',
          '`/sync` - Sync MetaMemory to Feishu Wiki',
          '`/sync status` - Show sync status',
        ].join('\n'));
        return true;

      case '/reset':
        {
          const task = this.getActiveTask(chatId);
          const cleared = this.clearQueue(chatId);
          if (task) {
            this.audit.log({
              event: 'task_stopped',
              botName: this.config.name,
              chatId,
              userId,
              durationMs: Date.now() - task.startTime,
              meta: { reason: 'reset', clearedQueue: cleared },
            });
            this.stopTask(chatId);
          } else if (cleared > 0) {
            this.audit.log({
              event: 'queue_cleared',
              botName: this.config.name,
              chatId,
              userId,
              meta: { reason: 'reset', clearedQueue: cleared },
            });
          }
        }
        this.sessionManager.resetSession(chatId);
        // Tear down the persistent Claude process for this chat (Stage 3b).
        // Otherwise the old long-lived executor would keep running with its
        // stale (now-cleared) sessionId mapping. No-op when persistent mode
        // is off. Best-effort — log but don't fail the /reset on shutdown errors.
        try {
          await this.releaseExecutor(chatId, 'reset-command');
        } catch (err) {
          this.logger.warn({ err, chatId }, 'Failed to release persistent executor on /reset');
        }
        await this.sender.sendTextNotice(chatId, '✅ Session Reset', 'Conversation cleared. Working directory preserved.', 'green');
        return true;

      case '/stop': {
        const task = this.getActiveTask(chatId);
        // Always drain the queue first — otherwise the running task's
        // finally block immediately picks the next queued message via
        // processQueue and the user's "stop" intent silently fails.
        const cleared = this.clearQueue(chatId);
        if (task) {
          this.audit.log({ event: 'task_stopped', botName: this.config.name, chatId, userId, durationMs: Date.now() - task.startTime, meta: { clearedQueue: cleared } });
          this.stopTask(chatId);
          const body = cleared > 0
            ? `Current task aborted. Discarded **${cleared}** queued message${cleared === 1 ? '' : 's'}.`
            : 'Current task has been aborted.';
          await this.sender.sendTextNotice(chatId, '🛑 Stopped', body, 'orange');
        } else if (cleared > 0) {
          // No running task but queued messages existed — clear them too.
          this.audit.log({ event: 'queue_cleared', botName: this.config.name, chatId, userId, meta: { clearedQueue: cleared } });
          await this.sender.sendTextNotice(
            chatId,
            '🛑 Queue Cleared',
            `No task was running. Discarded **${cleared}** queued message${cleared === 1 ? '' : 's'}.`,
            'orange',
          );
        } else {
          await this.sender.sendTextNotice(chatId, 'ℹ️ No Running Task', 'There is no task to stop.', 'blue');
        }
        return true;
      }

      case '/status': {
        const session = this.sessionManager.getSession(chatId);
        const isRunning = !!this.getActiveTask(chatId);
        const botEngine = resolveEngineName(this.config);
        const activeEngine = session.engine ?? botEngine;
        const defaultModel = this.defaultModelForEngine(activeEngine) || '_default_';
        const activeModel = session.model || defaultModel;
        await this.sender.sendTextNotice(chatId, '📊 Status', [
          `**User:** \`${userId}\``,
          `**Engine:** \`${activeEngine}\`${session.engine ? ' (session override)' : ''}`,
          `**Working Directory:** \`${session.workingDirectory}\``,
          `**Session:** ${session.sessionId ? `\`${session.sessionId.slice(0, 8)}...\`` : '_None_'}`,
          `**Model:** \`${activeModel}\`${session.model ? ' (session override)' : ''}`,
          `**Effort:** \`${session.reasoningEffort || this.config.codex?.reasoningEffort || 'codex default'}\`${session.reasoningEffort ? ' (session override)' : ''}`,
          `**Running:** ${isRunning ? 'Yes ⏳' : 'No'}`,
        ].join('\n'));
        return true;
      }

      case '/memory': {
        const args = text.slice('/memory'.length).trim();
        await this.handleMemoryCommand(chatId, args);
        return true;
      }

      case '/sync': {
        const args = text.slice('/sync'.length).trim();
        await this.handleSyncCommand(chatId, args);
        return true;
      }

      case '/model': {
        const args = text.slice('/model'.length).trim();
        await this.handleModelCommand(chatId, args);
        return true;
      }

      case '/effort': {
        const args = text.slice('/effort'.length).trim();
        await this.handleEffortCommand(chatId, args);
        return true;
      }

      case '/resume': {
        const arg = text.slice('/resume'.length).trim();
        await this.handleResumeCommand(msg, arg);
        return true;
      }

      default:
        // Unrecognized /xxx commands — not handled here, pass through to Claude
        return false;
    }
  }

  private async handleMemoryCommand(chatId: string, args: string): Promise<void> {
    const [subCmd, ...rest] = args.split(/\s+/);

    if (!subCmd) {
      await this.sender.sendTextNotice(
        chatId,
        '📝 Memory',
        'Usage:\n- `/memory list` — Show folder tree\n- `/memory search <query>` — Search documents\n- `/memory status` — Health check',
      );
      return;
    }

    try {
      switch (subCmd.toLowerCase()) {
        case 'list': {
          const tree = await this.memoryClient.listFolderTree();
          const formatted = this.memoryClient.formatFolderTree(tree);
          await this.sender.sendTextNotice(chatId, '📂 Memory Folders', formatted);
          break;
        }
        case 'search': {
          const query = rest.join(' ').trim();
          if (!query) {
            await this.sender.sendTextNotice(chatId, '📝 Memory', 'Usage: `/memory search <query>`');
            return;
          }
          const results = await this.memoryClient.search(query);
          const formatted = this.memoryClient.formatSearchResults(results);
          await this.sender.sendTextNotice(chatId, `🔍 Search: ${query}`, formatted);
          break;
        }
        case 'status': {
          const health = await this.memoryClient.health();
          await this.sender.sendTextNotice(
            chatId,
            '📝 Memory Status',
            `Status: ${health.status}\nDocuments: ${health.document_count}\nFolders: ${health.folder_count}`,
            'green',
          );
          break;
        }
        default:
          await this.sender.sendTextNotice(chatId, '📝 Memory', `Unknown sub-command: \`${subCmd}\`\nUse \`/memory\` for help.`, 'orange');
      }
    } catch (err: any) {
      this.logger.error({ err, chatId }, 'Memory command error');
      await this.sender.sendTextNotice(chatId, '❌ Memory Error', `Failed to connect to memory server: ${err.message}`, 'red');
    }
  }

  private async handleSyncCommand(chatId: string, args: string): Promise<void> {
    if (!this.docSync) {
      await this.sender.sendTextNotice(chatId, '❌ Sync Unavailable', 'Wiki sync is not configured for this bot.', 'red');
      return;
    }

    const [subCmd] = args.split(/\s+/);

    if (!subCmd) {
      // Default: trigger full sync
      if (this.docSync.isSyncing()) {
        await this.sender.sendTextNotice(chatId, '⏳ Sync In Progress', 'A sync is already running. Please wait.', 'orange');
        return;
      }

      await this.sender.sendTextNotice(chatId, '🔄 Sync Started', 'Syncing MetaMemory documents to Feishu Wiki...', 'blue');

      try {
        const result = await this.docSync.syncAll();
        const lines = [
          `**Created:** ${result.created}`,
          `**Updated:** ${result.updated}`,
          `**Skipped:** ${result.skipped} (unchanged)`,
          `**Deleted:** ${result.deleted}`,
          `**Duration:** ${(result.durationMs / 1000).toFixed(1)}s`,
        ];
        if (result.errors.length > 0) {
          lines.push('', `**Errors (${result.errors.length}):**`);
          for (const err of result.errors.slice(0, 5)) {
            lines.push(`- ${err}`);
          }
          if (result.errors.length > 5) {
            lines.push(`- ... and ${result.errors.length - 5} more`);
          }
        }
        const color = result.errors.length > 0 ? 'orange' : 'green';
        await this.sender.sendTextNotice(chatId, '✅ Sync Complete', lines.join('\n'), color);
      } catch (err: any) {
        this.logger.error({ err, chatId }, 'Sync command error');
        await this.sender.sendTextNotice(chatId, '❌ Sync Failed', err.message, 'red');
      }
      return;
    }

    switch (subCmd.toLowerCase()) {
      case 'status': {
        const stats = this.docSync.getStats();
        const spaceId = stats.wikiSpaceId || 'Not configured';
        await this.sender.sendTextNotice(chatId, '📊 Sync Status', [
          `**Wiki Space:** \`${spaceId}\``,
          `**Synced Documents:** ${stats.documentCount}`,
          `**Synced Folders:** ${stats.folderCount}`,
          `**Currently Syncing:** ${this.docSync.isSyncing() ? 'Yes' : 'No'}`,
        ].join('\n'));
        break;
      }
      default:
        await this.sender.sendTextNotice(chatId, '📝 Sync', 'Usage:\n- `/sync` — Sync all documents to Feishu Wiki\n- `/sync status` — Show sync status', 'blue');
    }
  }

  private async handleModelCommand(chatId: string, args: string): Promise<void> {
    const session = this.sessionManager.getSession(chatId);
    const botEngine = resolveEngineName(this.config);
    const activeEngine = session.engine ?? botEngine;
    const botDefault = this.defaultModelForEngine(activeEngine);

    // No args — show current model
    if (!args) {
      const active = session.model || botDefault || '_default_';
      const exampleModels = this.exampleModelsForEngine(activeEngine);
      const lines = [
        `**Engine:** \`${activeEngine}\`${session.engine ? ' (session override)' : ''}`,
        `**Active:** \`${active}\`${session.model ? ' (session override)' : ''}`,
        `**Bot default:** \`${botDefault || '_unset_'}\``,
        '',
        'Usage:',
        '- `/model list` — Show available engines + models',
        `- \`${this.engineSwitchUsage()}\` — Switch engine (resets session)`,
        `- \`/model <name>\` — Set session model (e.g. ${exampleModels})`,
        '- `/model reset` — Clear overrides, use bot defaults',
      ];
      await this.sender.sendTextNotice(chatId, '🤖 Model', lines.join('\n'));
      return;
    }

    const normalized = args.toLowerCase();

    if (normalized !== 'list' && normalized !== 'ls' && this.getActiveTask(chatId)) {
      await this.sender.sendTextNotice(
        chatId,
        '⏳ Task In Progress',
        'A task is active. Use `/stop` first, then change the model.',
        'orange',
      );
      return;
    }

    // Engine switch — names come from the central engine registry.
    if (isEngineName(normalized)) {
      if (activeEngine === normalized) {
        await this.sender.sendTextNotice(
          chatId,
          'ℹ️ Already using ' + normalized,
          `This chat is already on the \`${normalized}\` engine.`,
          'blue',
        );
        return;
      }
      this.sessionManager.setSessionEngine(chatId, normalized);
      await this.sender.sendTextNotice(
        chatId,
        `✅ Engine switched to ${normalized}`,
        [
          `Next message will run on the **${normalized}** engine.`,
          '',
          '_Session ID and model override cleared — a fresh conversation starts on the next turn._',
          this.authTipForEngine(normalized),
        ].join('\n'),
        'green',
      );
      return;
    }

    // List available models
    if (normalized === 'list' || normalized === 'ls') {
      const active = session.model || botDefault;
      const descriptor = getEngineDescriptor(activeEngine);
      const lines = [
        `**Current engine:** \`${activeEngine}\`${session.engine ? ' (session override)' : ''}`,
        '',
        `**Engines:** \`${this.engineSwitchUsage()}\` to switch.`,
        '',
        `**Common ${descriptor.displayName} models:**`,
        '',
      ];
      for (const model of descriptor.exampleModels) {
        const marker = model === active ? ' ✅' : '';
        const description = descriptor.modelDescriptions?.[model];
        lines.push(`- \`${model}\`${description ? ` — ${description}` : ''}${marker}`);
      }
      lines.push('');
      lines.push(`_${descriptor.authTip}_`);
      lines.push('Use `/model <name>` to set the model for the current engine.');
      await this.sender.sendTextNotice(chatId, '🤖 Available Models', lines.join('\n'));
      return;
    }

    // Reset — clear overrides (both engine AND model)
    if (normalized === 'reset' || normalized === 'clear' || normalized === 'default') {
      this.sessionManager.setSessionModel(chatId, undefined);
      this.sessionManager.setSessionEngine(chatId, undefined);
      this.sessionManager.setReasoningEffort(chatId, undefined);
      const fallback = botDefault || '_default_';
      await this.sender.sendTextNotice(
        chatId,
        '✅ Overrides Cleared',
        `Session engine and model overrides cleared. Using bot defaults: engine \`${botEngine}\`, model \`${fallback}\`.`,
        'green',
      );
      return;
    }

    // Set the model (use only the first token, ignore trailing junk)
    const newModel = args.split(/\s+/)[0];
    this.sessionManager.setSessionModel(chatId, newModel, activeEngine);
    await this.sender.sendTextNotice(
      chatId,
      '✅ Model Set',
      `Session model set to \`${newModel}\` on engine \`${activeEngine}\`. It will take effect on the next message.`,
      'green',
    );
  }

  private async handleEffortCommand(chatId: string, args: string): Promise<void> {
    const session = this.sessionManager.getSession(chatId);
    const activeEngine = session.engine ?? resolveEngineName(this.config);
    const normalized = normalizeCodexEffort(args);

    if (!args) {
      const current = session.reasoningEffort || this.config.codex?.reasoningEffort || '_codex default_';
      await this.sender.sendTextNotice(
        chatId,
        '🧠 Effort',
        [
          `**Engine:** \`${activeEngine}\``,
          `**Current:** \`${current}\`${session.reasoningEffort ? ' (session override)' : ''}`,
          '',
          'Usage:',
          '- `/effort low` — fastest',
          '- `/effort medium` — balanced',
          '- `/effort high` — deeper reasoning',
          '- `/effort xhigh` — extra-high reasoning',
          '- `/effort max` — maximum reasoning depth',
          '- `/effort ultra` — maximum reasoning with automatic task delegation',
          '- `/effort reset` — clear session override',
        ].join('\n'),
      );
      return;
    }

    if (activeEngine !== 'codex') {
      await this.sender.sendTextNotice(
        chatId,
        'ℹ️ Codex effort only',
        `This chat is on \`${activeEngine}\`. Switch with \`/model codex\`, then use \`/effort high\`, \`/effort max\`, or \`/effort ultra\`.`,
        'blue',
      );
      return;
    }

    if (normalized === 'reset') {
      this.sessionManager.setReasoningEffort(chatId, undefined);
      await this.sender.sendTextNotice(
        chatId,
        '✅ Effort Reset',
        `Codex reasoning effort override cleared. Using \`${this.config.codex?.reasoningEffort || 'codex default'}\`.`,
        'green',
      );
      return;
    }

    if (!normalized) {
      await this.sender.sendTextNotice(
        chatId,
        '❌ Invalid Effort',
        'Use one of: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.',
        'red',
      );
      return;
    }

    this.sessionManager.setReasoningEffort(chatId, normalized);
    await this.sender.sendTextNotice(
      chatId,
      '✅ Effort Set',
      `Codex reasoning effort set to \`${normalized}\`. It will take effect on the next message.`,
      'green',
    );
  }

  /**
   * `/resume <id-or-prefix>` — switch the chat directly into a previous engine
   * session by (a prefix of) its session id. Bare `/resume` is intercepted by
   * the bridge picker before reaching here; we keep a usage notice as a
   * defensive fallback.
   *
   * Supported for engines that declare native sessions, and refused
   * while a turn is running (the swap would race the in-flight executor).
   */
  private async handleResumeCommand(msg: IncomingMessage, arg: string): Promise<void> {
    const { chatId } = msg;
    const session = this.sessionManager.getSession(chatId);
    const activeEngine = session.engine ?? resolveEngineName(this.config);
    if (!getEngineDescriptor(activeEngine).capabilities.sessions) {
      await this.sender.sendTextNotice(
        chatId,
        '❌ /resume Unsupported',
        `The \`${activeEngine}\` engine does not expose resumable sessions.`,
        'red',
      );
      return;
    }

    if (this.getActiveTask(chatId)) {
      await this.sender.sendTextNotice(
        chatId,
        '⏳ Task In Progress',
        'A task is running. Use `/stop` first, then `/resume`.',
        'orange',
      );
      return;
    }

    if (!arg) {
      await this.sender.sendTextNotice(
        chatId,
        '📝 Resume',
        'Usage: `/resume <session-id-prefix>`, or send a bare `/resume` to pick from a list.',
        'blue',
      );
      return;
    }

    const sessions = await this.listSessions(chatId);
    // Listing sessions crosses an async engine boundary. A task may have
    // started after the first guard, so re-check immediately before mutating
    // the chat's active session.
    if (this.getActiveTask(chatId)) {
      await this.sender.sendTextNotice(
        chatId,
        '⏳ Task In Progress',
        'A task started while sessions were loading. Use `/stop` first, then `/resume`.',
        'orange',
      );
      return;
    }
    if (sessions.length === 0) {
      await this.sender.sendTextNotice(
        chatId,
        'ℹ️ No Previous Sessions',
        `No earlier ${activeEngine} sessions were found for this chat's working directory.`,
        'blue',
      );
      return;
    }

    const exact = sessions.find((s) => s.sessionId === arg);
    const matches = exact ? [exact] : sessions.filter((s) => s.sessionId.startsWith(arg));

    if (matches.length === 0) {
      await this.sender.sendTextNotice(
        chatId,
        '❌ No Match',
        `No session id starts with \`${arg}\`. Send a bare \`/resume\` to see the list.`,
        'red',
      );
      return;
    }
    if (matches.length > 1) {
      const ids = matches.slice(0, 8).map((s) => `\`${s.sessionId.slice(0, 8)}\``).join(', ');
      await this.sender.sendTextNotice(
        chatId,
        '⚠️ Ambiguous',
        `\`${arg}\` matches ${matches.length} sessions: ${ids}. Add more characters.`,
        'orange',
      );
      return;
    }

    const target = matches[0];
    await this.applyResume(chatId, target.sessionId);
    await this.sender.sendTextNotice(
      chatId,
      '✅ Session Resumed',
      `Resumed \`${target.sessionId.slice(0, 8)}\`. Your next message continues that conversation.`,
      'green',
    );
  }

  private defaultModelForEngine(engine: EngineName): string | undefined {
    switch (engine) {
      case 'claude':
        return this.config.claude.model;
      case 'kimi':
        return this.config.kimi?.model;
      case 'codex':
        return this.config.codex?.model || this.config.codex?.displayModel;
      case 'opencode':
        return this.config.opencode?.model;
    }
  }

  private exampleModelsForEngine(engine: EngineName): string {
    return getEngineDescriptor(engine).exampleModels.map((model) => `\`${model}\``).join(', ');
  }

  private authTipForEngine(engine: EngineName): string {
    return `_${getEngineDescriptor(engine).authTip}_`;
  }

  private engineSwitchUsage(): string {
    return ENGINE_NAMES.map((engine) => `/model ${engine}`).join(' | ');
  }
}

function normalizeCodexEffort(value: string): CodexReasoningEffort | 'reset' | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'reset' || normalized === 'clear' || normalized === 'default') return 'reset';
  if (
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh' ||
    normalized === 'max' ||
    normalized === 'ultra'
  ) return normalized;
  return undefined;
}
