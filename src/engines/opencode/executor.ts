import path from 'node:path';
import type { ModelRef, V2Event } from '@opencode-ai/sdk/v2/types';
import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type { ExecutionHandle, ExecutorOptions } from '../execution.js';
import { buildMetaBotApiPromptContext } from '../prompt-context.js';
import type { EngineEvent } from '../protocol.js';
import { SdkOpenCodeControlPlane, type OpenCodeControlPlane } from './control-plane.js';
import { OpenCodeEventAdapter, type OpenCodePendingInteraction } from './event-adapter.js';
import type { OpenCodeRuntime } from './runtime-manager.js';

interface OpenCodeRuntimeProvider {
  start(): Promise<OpenCodeRuntime>;
}

interface ActiveOpenCodeTurn {
  ready: Promise<void>;
  sessionId?: string;
  controlPlane?: OpenCodeControlPlane;
  adapter?: OpenCodeEventAdapter;
  promptSubmitted: boolean;
  completed: boolean;
  cancelPromise?: Promise<void>;
}

export class OpenCodeExecutor {
  private readonly runtime: OpenCodeRuntimeProvider;
  private readonly activeTurns = new Map<string, ActiveOpenCodeTurn>();

  constructor(
    private readonly config: BotConfigBase,
    private readonly logger: Logger,
    runtime: OpenCodeRuntimeProvider,
    private readonly controlPlaneFactory: (runtime: OpenCodeRuntime, directory: string) => OpenCodeControlPlane = (
      activeRuntime,
      directory,
    ) => new SdkOpenCodeControlPlane(activeRuntime.client(directory)),
  ) {
    this.runtime = runtime;
  }

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const queue = new AsyncQueue<EngineEvent>();
    const subscriptionAbort = new AbortController();
    const turnKey = options.apiContext?.chatId ?? `${options.cwd}:${Date.now()}`;
    let aborted = options.abortController.signal.aborted;
    let resolveReady!: () => void;
    const active: ActiveOpenCodeTurn = {
      ready: new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
      promptSubmitted: false,
      completed: false,
    };
    this.activeTurns.set(turnKey, active);

    const push = (events: EngineEvent[]) => {
      for (const event of events) queue.enqueue(event);
    };

    const cancel = (): Promise<void> => {
      if (active.cancelPromise) return active.cancelPromise;
      active.cancelPromise = (async () => {
        if (active.completed) return;
        aborted = true;
        try {
          await active.ready;
        } catch {
          /* ready never rejects; defensive for injected implementations */
        }
        if (active.controlPlane && active.sessionId && active.promptSubmitted) {
          try {
            await active.controlPlane.interrupt(active.sessionId);
          } catch (error) {
            this.logger.warn({ error, engine: 'opencode', sessionId: active.sessionId }, 'OpenCode interrupt failed');
          }
        }
        if (!active.completed) {
          if (active.adapter) push(active.adapter.finish('cancelled'));
          else queue.enqueue(cancelledResult(active.sessionId));
          active.completed = true;
          // Publish the terminal event before closing SSE. Closing first lets the
          // stream-finalizer win the race and finish the queue without a result.
          subscriptionAbort.abort();
          queue.finish();
        }
      })();
      return active.cancelPromise;
    };

    const onAbort = () => {
      void cancel();
    };
    options.abortController.signal.addEventListener('abort', onAbort, { once: true });

    void this.runTurn(options, active, subscriptionAbort, push, resolveReady)
      .catch((error) => {
        if (active.completed || aborted) return;
        this.logger.error({ error, engine: 'opencode', cwd: options.cwd }, 'OpenCode execution failed');
        queue.enqueue(errorResult(active.sessionId, error));
        active.completed = true;
      })
      .finally(() => {
        subscriptionAbort.abort();
        options.abortController.signal.removeEventListener('abort', onAbort);
        if (this.activeTurns.get(turnKey) === active) this.activeTurns.delete(turnKey);
        queue.finish();
      });

    const resolveQuestion = (toolUseId: string, answers: Record<string, string>) => {
      void this.resolveInteraction(active, toolUseId, answers);
    };

    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<EngineEvent>,
      sendAnswer: (toolUseId: string, _sessionId: string, answerText: string) => {
        resolveQuestion(toolUseId, { _answer: answerText });
      },
      resolveQuestion,
      cancel,
      finish: () => {
        void cancel();
      },
    };
  }

  async *execute(options: ExecutorOptions): AsyncGenerator<EngineEvent> {
    const handle = this.startExecution(options);
    try {
      for await (const event of handle.stream) yield event;
    } finally {
      handle.finish();
    }
  }

  canSteer(chatId: string): boolean {
    const active = this.activeTurns.get(chatId);
    return !!active && !active.completed;
  }

  async steer(chatId: string, prompt: string): Promise<'steered' | 'no-active-turn'> {
    const active = this.activeTurns.get(chatId);
    if (!active || active.completed) return 'no-active-turn';
    await active.ready;
    if (!active.controlPlane || !active.sessionId || active.completed) return 'no-active-turn';
    await active.controlPlane.prompt({ sessionId: active.sessionId, text: prompt, delivery: 'steer' });
    return 'steered';
  }

  private async runTurn(
    options: ExecutorOptions,
    active: ActiveOpenCodeTurn,
    subscriptionAbort: AbortController,
    push: (events: EngineEvent[]) => void,
    resolveReady: () => void,
  ): Promise<void> {
    try {
      const runtime = await this.runtime.start();
      const controlPlane = this.controlPlaneFactory(runtime, options.cwd);
      active.controlPlane = controlPlane;
      const model = parseModelRef(options.model ?? this.config.opencode?.model, this.config.opencode?.variant);
      const session = options.sessionId
        ? await controlPlane.getSession(options.sessionId)
        : await controlPlane.createSession({
            directory: path.resolve(options.cwd),
            ...(model ? { model } : {}),
            ...(this.config.opencode?.agent ? { agent: this.config.opencode.agent } : {}),
          });
      assertSessionDirectory(session.location.directory, options.cwd, session.id);
      active.sessionId = session.id;

      if (options.sessionId) {
        if (model) await controlPlane.switchModel(session.id, model);
        if (this.config.opencode?.agent) await controlPlane.switchAgent(session.id, this.config.opencode.agent);
      }

      const adapter = new OpenCodeEventAdapter({
        sessionId: session.id,
        directory: options.cwd,
        model: model ? formatModelRef(model) : undefined,
        contextWindow: this.config.opencode?.contextWindow,
        onUnknownEvent: (type) =>
          this.logger.debug({ engine: 'opencode', type, version: runtime.version }, 'Ignored unknown OpenCode event'),
      });
      active.adapter = adapter;
      queueSessionInit(push, session.id);

      // Subscribe before admitting the prompt so no fast first event can be lost.
      const events = await controlPlane.subscribe(subscriptionAbort.signal);
      resolveReady();
      if (subscriptionAbort.signal.aborted || active.completed) return;

      adapter.beginTurn();
      const prompt = buildPromptWithContext(options);
      await controlPlane.prompt({ sessionId: session.id, text: prompt, delivery: 'queue' });
      active.promptSubmitted = true;

      for await (const event of events) {
        if (subscriptionAbort.signal.aborted || active.completed) break;
        if (await this.handleAutomaticPermission(controlPlane, event)) continue;
        push(adapter.translate(event));
        if (adapter.isTerminal()) {
          active.completed = true;
          break;
        }
      }

      if (!active.completed && !subscriptionAbort.signal.aborted) {
        await this.recoverAfterStreamEnd(controlPlane, session.id, adapter, push);
        active.completed = adapter.isTerminal();
      }
    } catch (error) {
      resolveReady();
      throw error;
    }
  }

  private async recoverAfterStreamEnd(
    controlPlane: OpenCodeControlPlane,
    sessionId: string,
    adapter: OpenCodeEventAdapter,
    push: (events: EngineEvent[]) => void,
  ): Promise<void> {
    const missed = await controlPlane.history(sessionId, adapter.getDurableSequence());
    for (const event of missed) push(adapter.translate(event));
    if (adapter.isTerminal()) return;
    if (await controlPlane.isActive(sessionId)) {
      throw new Error('OpenCode event stream ended while the session was still active');
    }
    push(adapter.finish('success'));
  }

  private async handleAutomaticPermission(controlPlane: OpenCodeControlPlane, event: V2Event): Promise<boolean> {
    if (event.type !== 'permission.v2.asked') return false;
    const mode = this.config.opencode?.permissionMode ?? 'ask';
    if (mode === 'ask') return false;
    await controlPlane.replyPermission(event.data.sessionID, event.data.id, mode === 'auto' ? 'once' : 'reject');
    return true;
  }

  private async resolveInteraction(
    active: ActiveOpenCodeTurn,
    toolUseId: string,
    answers: Record<string, string>,
  ): Promise<void> {
    await active.ready;
    const interaction = active.adapter?.getPendingInteraction(toolUseId);
    if (!interaction || !active.controlPlane || !active.sessionId) return;
    try {
      if (interaction.kind === 'question') {
        await active.controlPlane.replyQuestion(active.sessionId, interaction.request.id, {
          answers: questionAnswers(interaction, answers),
        });
      } else {
        await active.controlPlane.replyPermission(active.sessionId, interaction.request.id, permissionAnswer(answers));
      }
      active.adapter?.clearPendingInteraction(toolUseId);
    } catch (error) {
      this.logger.warn({ error, engine: 'opencode', toolUseId }, 'Failed to resolve OpenCode interaction');
    }
  }
}

function queueSessionInit(push: (events: EngineEvent[]) => void, sessionId: string): void {
  push([{ type: 'system', subtype: 'init', session_id: sessionId }]);
}

function parseModelRef(value: string | undefined, variant?: string): ModelRef | undefined {
  if (!value) return undefined;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`OpenCode model must use provider/model format: ${value}`);
  }
  return {
    providerID: value.slice(0, separator),
    id: value.slice(separator + 1),
    ...(variant ? { variant } : {}),
  };
}

function formatModelRef(model: ModelRef): string {
  return `${model.providerID}/${model.id}${model.variant ? `:${model.variant}` : ''}`;
}

function assertSessionDirectory(actual: string, expected: string, sessionId: string): void {
  if (path.resolve(actual) !== path.resolve(expected)) {
    throw new Error(`OpenCode session ${sessionId} belongs to ${actual}, not ${path.resolve(expected)}`);
  }
}

function buildPromptWithContext(options: ExecutorOptions): string {
  const sections: string[] = [];
  if (options.outputsDir) {
    sections.push(
      `## Output Files\nWhen producing output files for the user, copy them to: ${options.outputsDir}\nMetaBot will automatically send files placed there.`,
    );
  }
  if (options.apiContext) {
    sections.push(buildMetaBotApiPromptContext(options.apiContext));
    if (options.apiContext.teamContext) sections.push(options.apiContext.teamContext);
    const peers = options.apiContext.groupMembers?.filter((name) => name !== options.apiContext?.botName) ?? [];
    if (peers.length > 0 && options.apiContext.groupId) {
      sections.push(
        `## Group Chat\nYou are in a group chat (group: ${options.apiContext.groupId}) with these bots: ${peers.join(', ')}.\nTo talk to another bot, use: \`metabot talk <botName> grouptalk-${options.apiContext.groupId}-<botName> "message"\``,
      );
    } else if (peers.length > 0) {
      sections.push(`## Agent Organization\nOther Agents in this group: ${peers.join(', ')}.`);
    }
  }
  return sections.length > 0 ? `${options.prompt}\n\n---\n\n${sections.join('\n\n')}` : options.prompt;
}

function questionAnswers(
  interaction: Extract<OpenCodePendingInteraction, { kind: 'question' }>,
  answers: Record<string, string>,
): string[][] {
  return interaction.request.questions.map((question) => {
    const raw = answers[question.question] ?? answers[question.header] ?? answers._answer ?? answers._auto ?? '';
    const values = raw
      .split(/[,，\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
    return values.length > 0 ? values : [raw];
  });
}

function permissionAnswer(answers: Record<string, string>): 'once' | 'always' | 'reject' {
  const value = Object.values(answers).join(' ').toLowerCase();
  if (/always|始终|总是/.test(value)) return 'always';
  if (/reject|deny|拒绝|不允许/.test(value)) return 'reject';
  return 'once';
}

function errorResult(sessionId: string | undefined, error: unknown): EngineEvent {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    session_id: sessionId,
    duration_ms: 0,
    is_error: true,
    errors: [error instanceof Error ? error.message : String(error)],
  };
}

function cancelledResult(sessionId: string | undefined): EngineEvent {
  return {
    type: 'result',
    subtype: 'error_cancelled',
    session_id: sessionId,
    duration_ms: 0,
    is_error: true,
    errors: ['Aborted by user'],
  };
}
