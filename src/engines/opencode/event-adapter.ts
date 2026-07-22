import path from 'node:path';
import type {
  ModelRef,
  PermissionV2Request,
  QuestionV2Request,
  V2Event,
} from '@opencode-ai/sdk/v2/types';
import type { EngineEvent } from '../protocol.js';

export interface OpenCodeEventAdapterOptions {
  sessionId: string;
  directory: string;
  model?: string;
  contextWindow?: number;
  onUnknownEvent?: (type: string) => void;
}

export type OpenCodePendingInteraction =
  | { kind: 'question'; request: QuestionV2Request }
  | { kind: 'permission'; request: PermissionV2Request };

interface ToolState {
  name: string;
  input?: unknown;
}

/** Stateful anti-corruption layer from OpenCode v2 events to MetaBot events. */
export class OpenCodeEventAdapter {
  private readonly seenEventIds = new Set<string>();
  private readonly textById = new Map<string, string>();
  private readonly textOrder: string[] = [];
  private readonly tools = new Map<string, ToolState>();
  private readonly pending = new Map<string, OpenCodePendingInteraction>();
  private model: string;
  private inputTokens = 0;
  private outputTokens = 0;
  private reasoningTokens = 0;
  private costUsd = 0;
  private durableSequence = 0;
  private turnStarted = false;
  private terminal = false;
  private readonly startedAt = Date.now();
  private readonly directory: string;

  constructor(private readonly options: OpenCodeEventAdapterOptions) {
    this.directory = path.resolve(options.directory);
    this.model = options.model || 'opencode';
  }

  beginTurn(): void {
    this.turnStarted = true;
  }

  isTerminal(): boolean {
    return this.terminal;
  }

  getDurableSequence(): number {
    return this.durableSequence;
  }

  getPendingInteraction(toolUseId: string): OpenCodePendingInteraction | undefined {
    return this.pending.get(toolUseId);
  }

  clearPendingInteraction(toolUseId: string): void {
    this.pending.delete(toolUseId);
  }

  translate(event: V2Event): EngineEvent[] {
    if (this.terminal || !this.accept(event)) return [];
    if (this.seenEventIds.has(event.id)) return [];
    this.seenEventIds.add(event.id);
    if (event.durable?.seq != null) this.durableSequence = Math.max(this.durableSequence, event.durable.seq);

    switch (event.type) {
      case 'session.next.step.started':
        this.model = formatModel(event.data.model);
        return [];
      case 'session.next.text.started':
        this.ensureText(event.data.textID);
        return [];
      case 'session.next.text.delta':
        this.appendText(event.data.textID, event.data.delta);
        return event.data.delta ? [textDelta(event.data.delta, this.options.sessionId)] : [];
      case 'session.next.text.ended': {
        this.setText(event.data.textID, event.data.text);
        return [assistantText(this.fullText(), this.options.sessionId)];
      }
      case 'session.next.reasoning.started':
      case 'session.next.reasoning.delta':
      case 'session.next.reasoning.ended':
        // Reasoning is deliberately observed but not rendered into the user answer.
        return [];
      case 'session.next.tool.input.started':
        this.tools.set(event.data.callID, { name: event.data.name });
        return [];
      case 'session.next.tool.input.delta':
        return [];
      case 'session.next.tool.input.ended': {
        const prior = this.tools.get(event.data.callID);
        this.tools.set(event.data.callID, {
          name: prior?.name ?? 'Tool',
          input: parseToolInput(event.data.text),
        });
        return [];
      }
      case 'session.next.tool.called': {
        this.tools.set(event.data.callID, { name: event.data.tool, input: event.data.input });
        return [toolUse(event.data.callID, event.data.tool, event.data.input, this.options.sessionId)];
      }
      case 'session.next.tool.progress': {
        const tool = this.tools.get(event.data.callID);
        if (!tool) return [];
        return [toolUse(event.data.callID, tool.name, event.data.structured, this.options.sessionId)];
      }
      case 'session.next.tool.success':
        return [toolResult(event.data.callID, false, this.options.sessionId)];
      case 'session.next.tool.failed':
        return [toolResult(event.data.callID, true, this.options.sessionId, formatError(event.data.error))];
      case 'session.next.shell.started':
        this.tools.set(event.data.callID, { name: 'Bash', input: { command: event.data.command } });
        return [toolUse(event.data.callID, 'Bash', { command: event.data.command }, this.options.sessionId)];
      case 'session.next.shell.ended':
        return [toolResult(event.data.callID, false, this.options.sessionId, event.data.output)];
      case 'session.next.step.ended':
        this.costUsd += event.data.cost;
        this.inputTokens += event.data.tokens.input + event.data.tokens.cache.read + event.data.tokens.cache.write;
        this.outputTokens += event.data.tokens.output;
        this.reasoningTokens += event.data.tokens.reasoning;
        // The real v2 stream does not guarantee a later `session.idle` event.
        // A tool-call finish opens another step; every other finish closes the turn.
        return isToolContinuation(event.data.finish) ? [] : this.finish('success');
      case 'session.next.step.failed':
        return this.finish('failed', formatError(event.data.error));
      case 'question.v2.asked': {
        const toolUseId = questionToolUseId(event.data.id);
        this.pending.set(toolUseId, { kind: 'question', request: event.data });
        return [interactiveTool(toolUseId, event.data.questions, this.options.sessionId)];
      }
      case 'question.v2.replied':
      case 'question.v2.rejected': {
        const toolUseId = questionToolUseId(event.data.requestID);
        this.pending.delete(toolUseId);
        return [toolResult(toolUseId, event.type === 'question.v2.rejected', this.options.sessionId)];
      }
      case 'permission.v2.asked': {
        const toolUseId = permissionToolUseId(event.data.id);
        this.pending.set(toolUseId, { kind: 'permission', request: event.data });
        return [permissionTool(toolUseId, event.data, this.options.sessionId)];
      }
      case 'permission.v2.replied': {
        const toolUseId = permissionToolUseId(event.data.requestID);
        this.pending.delete(toolUseId);
        return [toolResult(toolUseId, event.data.reply === 'reject', this.options.sessionId)];
      }
      case 'session.error':
        return this.finish('failed', formatError(event.data.error ?? 'OpenCode session failed'));
      case 'session.idle':
        return this.turnStarted ? this.finish('success') : [];
      case 'session.next.prompt.admitted':
      case 'session.next.prompted':
      case 'session.next.agent.switched':
      case 'session.next.model.switched':
      case 'session.next.context.updated':
      case 'session.next.synthetic':
      case 'session.next.retried':
      case 'session.next.compaction.started':
      case 'session.next.compaction.delta':
      case 'session.next.compaction.ended':
      case 'session.next.revert.staged':
      case 'session.next.revert.cleared':
      case 'session.next.revert.committed':
        return [];
      default:
        this.options.onUnknownEvent?.(event.type);
        return [];
    }
  }

  finish(outcome: 'success' | 'failed' | 'cancelled', error?: string): EngineEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const cancelled = outcome === 'cancelled';
    const failed = outcome === 'failed';
    return [{
      type: 'result',
      subtype: cancelled ? 'error_cancelled' : failed ? 'error_during_execution' : 'success',
      session_id: this.options.sessionId,
      duration_ms: Date.now() - this.startedAt,
      total_cost_usd: this.costUsd,
      result: this.fullText(),
      is_error: cancelled || failed,
      ...(cancelled
        ? { errors: ['Aborted by user'] }
        : failed
          ? { errors: [error ?? 'OpenCode session failed'] }
          : {}),
      modelUsage: {
        [this.model]: {
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens + this.reasoningTokens,
          contextWindow: this.options.contextWindow ?? 0,
          costUSD: this.costUsd,
        },
      },
    }];
  }

  private accept(event: V2Event): boolean {
    const data = event.data as { sessionID?: string };
    if (data.sessionID !== this.options.sessionId) return false;
    if (event.location?.directory && path.resolve(event.location.directory) !== this.directory) return false;
    return true;
  }

  private ensureText(textId: string): void {
    if (this.textById.has(textId)) return;
    this.textById.set(textId, '');
    this.textOrder.push(textId);
  }

  private appendText(textId: string, delta: string): void {
    this.ensureText(textId);
    this.textById.set(textId, `${this.textById.get(textId) ?? ''}${delta}`);
  }

  private setText(textId: string, text: string): void {
    this.ensureText(textId);
    this.textById.set(textId, text);
  }

  private fullText(): string {
    return this.textOrder.map((id) => this.textById.get(id) ?? '').join('');
  }
}

export function questionToolUseId(requestId: string): string {
  return `opencode-question:${requestId}`;
}

export function permissionToolUseId(requestId: string): string {
  return `opencode-permission:${requestId}`;
}

function textDelta(delta: string, sessionId: string): EngineEvent {
  return {
    type: 'stream_event',
    session_id: sessionId,
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } },
  };
}

function assistantText(text: string, sessionId: string): EngineEvent {
  return {
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { content: [{ type: 'text', text }] },
  };
}

function toolUse(id: string, name: string, input: unknown, sessionId: string): EngineEvent {
  return {
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  };
}

function toolResult(id: string, isError: boolean, sessionId: string, text?: string): EngineEvent {
  return {
    // Tool results are user-side messages in the shared EngineEvent protocol.
    // StreamProcessor uses that role transition to complete the active tool.
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', id, text }] },
    is_error: isError,
  };
}

function interactiveTool(
  id: string,
  questions: QuestionV2Request['questions'],
  sessionId: string,
): EngineEvent {
  return toolUse(id, 'AskUserQuestion', {
    questions: questions.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options,
      multiSelect: question.multiple ?? false,
    })),
  }, sessionId);
}

function permissionTool(id: string, request: PermissionV2Request, sessionId: string): EngineEvent {
  const resources = request.resources.length > 0 ? request.resources.join(', ') : 'the requested resource';
  return interactiveTool(id, [{
    header: 'Permission',
    question: `Allow OpenCode to ${request.action} on ${resources}?`,
    options: [
      { label: 'Allow once', description: 'Approve only this request.' },
      { label: 'Always allow', description: 'Approve and save this permission.' },
      { label: 'Reject', description: 'Deny this request.' },
    ],
    multiple: false,
    custom: false,
  }], sessionId);
}

function parseToolInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text ? { input: text } : {};
  }
}

function formatModel(model: ModelRef): string {
  return `${model.providerID}/${model.id}${model.variant ? `:${model.variant}` : ''}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    if (typeof value.message === 'string') return value.message;
    if (value.data && typeof value.data === 'object' && typeof (value.data as Record<string, unknown>).message === 'string') {
      return String((value.data as Record<string, unknown>).message);
    }
    try {
      return JSON.stringify(error);
    } catch {
      return 'OpenCode session failed';
    }
  }
  return String(error);
}

function isToolContinuation(finish: string): boolean {
  return finish === 'tool-calls' || finish === 'tool_calls' || finish === 'tool';
}
