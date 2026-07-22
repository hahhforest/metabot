import { describe, expect, it, vi } from 'vitest';
import type { SessionV2Info, V2Event } from '@opencode-ai/sdk/v2/types';
import { AsyncQueue } from '../src/utils/async-queue.js';
import type { EngineEvent } from '../src/engines/protocol.js';
import type { OpenCodeControlPlane } from '../src/engines/opencode/control-plane.js';
import { OpenCodeExecutor } from '../src/engines/opencode/executor.js';

const logger = {
  child: () => logger,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function session(id = 'ses_new', directory = '/repo'): SessionV2Info {
  return {
    id,
    projectID: 'project',
    title: 'Test session',
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  };
}

let eventSequence = 0;
function event(type: string, data: Record<string, unknown>, sessionId = 'ses_new'): V2Event {
  return {
    id: `event-${++eventSequence}`,
    type,
    location: { directory: '/repo' },
    data: { sessionID: sessionId, ...data },
  } as V2Event;
}

function buildControlPlane(events: AsyncQueue<V2Event> = new AsyncQueue<V2Event>()) {
  const controlPlane: OpenCodeControlPlane = {
    createSession: vi.fn(async () => session()),
    getSession: vi.fn(async (id) => session(id)),
    switchModel: vi.fn(async () => undefined),
    switchAgent: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    subscribe: vi.fn(async () => events),
    prompt: vi.fn(async (options) => ({
      admittedSeq: 1,
      id: 'input',
      sessionID: options.sessionId,
      prompt: { text: options.text },
      delivery: options.delivery ?? 'queue',
      timeCreated: 1,
    })),
    interrupt: vi.fn(async () => undefined),
    replyQuestion: vi.fn(async () => undefined),
    rejectQuestion: vi.fn(async () => undefined),
    replyPermission: vi.fn(async () => undefined),
    history: vi.fn(async () => []),
    isActive: vi.fn(async () => false),
  };
  return controlPlane;
}

function buildExecutor(controlPlane: OpenCodeControlPlane, opencode: Record<string, unknown> = {}) {
  const config = {
    name: 'test',
    claude: {
      defaultWorkingDirectory: '/repo',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: undefined,
      apiKey: undefined,
      outputsBaseDir: '/tmp/outputs',
      downloadsDir: '/tmp/downloads',
      backend: 'sdk',
    },
    opencode,
  } as any;
  const runtime = {
    start: vi.fn(async () => ({
      url: 'http://127.0.0.1:4096',
      version: '1.17.14',
      ownership: 'external' as const,
      client: vi.fn(() => ({}) as any),
      close: vi.fn(async () => undefined),
    })),
    close: vi.fn(async () => undefined),
  };
  return {
    executor: new OpenCodeExecutor(config, logger, runtime, () => controlPlane),
    runtime,
  };
}

function options(abortController = new AbortController()) {
  return {
    prompt: 'hello',
    cwd: '/repo',
    abortController,
    apiContext: { botName: 'test', chatId: 'chat-1' },
  };
}

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const result: EngineEvent[] = [];
  for await (const item of stream) result.push(item);
  return result;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition not reached');
}

describe('OpenCodeExecutor', () => {
  it('subscribes before prompting and completes a fresh native session', async () => {
    const events = new AsyncQueue<V2Event>();
    const controlPlane = buildControlPlane(events);
    const order: string[] = [];
    vi.mocked(controlPlane.subscribe).mockImplementation(async () => {
      order.push('subscribe');
      return events;
    });
    vi.mocked(controlPlane.prompt).mockImplementation(async (request) => {
      order.push('prompt');
      events.enqueue(
        event('session.next.text.delta', {
          timestamp: 1,
          assistantMessageID: 'msg',
          textID: 'text',
          delta: 'hello',
        }),
      );
      events.enqueue(
        event('session.next.text.ended', {
          timestamp: 2,
          assistantMessageID: 'msg',
          textID: 'text',
          text: 'hello',
        }),
      );
      events.enqueue(event('session.idle', {}));
      return {
        admittedSeq: 1,
        id: 'input',
        sessionID: request.sessionId,
        prompt: { text: request.text },
        delivery: 'queue',
        timeCreated: 1,
      };
    });
    const { executor } = buildExecutor(controlPlane, { model: 'openai/gpt-5.6', agent: 'build' });

    const messages = await collect(executor.startExecution(options()).stream);

    expect(order).toEqual(['subscribe', 'prompt']);
    expect(controlPlane.createSession).toHaveBeenCalledWith({
      directory: '/repo',
      model: { providerID: 'openai', id: 'gpt-5.6' },
      agent: 'build',
    });
    expect(messages[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'ses_new' });
    expect(messages.at(-1)).toMatchObject({ type: 'result', subtype: 'success', result: 'hello' });
  });

  it('resumes an owned session and applies model and agent overrides', async () => {
    const events = new AsyncQueue<V2Event>();
    const controlPlane = buildControlPlane(events);
    vi.mocked(controlPlane.prompt).mockImplementation(async (request) => {
      events.enqueue(event('session.idle', {}, 'ses_existing'));
      return {
        admittedSeq: 1,
        id: 'input',
        sessionID: request.sessionId,
        prompt: { text: request.text },
        delivery: 'queue',
        timeCreated: 1,
      };
    });
    const { executor } = buildExecutor(controlPlane, {
      model: 'anthropic/claude-sonnet-4-6',
      agent: 'plan',
      variant: 'high',
    });

    await collect(executor.startExecution({ ...options(), sessionId: 'ses_existing' }).stream);

    expect(controlPlane.createSession).not.toHaveBeenCalled();
    expect(controlPlane.getSession).toHaveBeenCalledWith('ses_existing');
    expect(controlPlane.switchModel).toHaveBeenCalledWith('ses_existing', {
      providerID: 'anthropic',
      id: 'claude-sonnet-4-6',
      variant: 'high',
    });
    expect(controlPlane.switchAgent).toHaveBeenCalledWith('ses_existing', 'plan');
  });

  it('acknowledges abort through the native interrupt API', async () => {
    const events = new AsyncQueue<V2Event>();
    const controlPlane = buildControlPlane(events);
    const abortController = new AbortController();
    const { executor } = buildExecutor(controlPlane);
    const handle = executor.startExecution(options(abortController));
    const reading = collect(handle.stream);
    await waitUntil(() => vi.mocked(controlPlane.prompt).mock.calls.length === 1);

    abortController.abort();
    const messages = await reading;

    expect(controlPlane.interrupt).toHaveBeenCalledWith('ses_new');
    expect(messages.at(-1)).toMatchObject({ type: 'result', subtype: 'error_cancelled' });
  });

  it('routes question answers in native question order', async () => {
    const events = new AsyncQueue<V2Event>();
    const controlPlane = buildControlPlane(events);
    vi.mocked(controlPlane.prompt).mockImplementation(async (request) => {
      events.enqueue(
        event('question.v2.asked', {
          id: 'question-1',
          questions: [
            {
              header: 'Deploy',
              question: 'Continue deployment?',
              options: [{ label: 'Continue', description: 'Proceed.' }],
              multiple: false,
              custom: false,
            },
          ],
        }),
      );
      return {
        admittedSeq: 1,
        id: 'input',
        sessionID: request.sessionId,
        prompt: { text: request.text },
        delivery: 'queue',
        timeCreated: 1,
      };
    });
    const { executor } = buildExecutor(controlPlane);
    const handle = executor.startExecution(options());
    const iterator = handle.stream[Symbol.asyncIterator]();
    await iterator.next(); // session init
    const question = await iterator.next();
    expect(question.value?.message?.content?.[0]?.id).toBe('opencode-question:question-1');

    handle.resolveQuestion('opencode-question:question-1', { 'Continue deployment?': 'Continue' });
    await waitUntil(() => vi.mocked(controlPlane.replyQuestion).mock.calls.length === 1);
    expect(controlPlane.replyQuestion).toHaveBeenCalledWith('ses_new', 'question-1', { answers: [['Continue']] });
    events.enqueue(event('session.idle', {}));
    await iterator.next();
  });

  it('auto-approves permission once only when explicitly configured', async () => {
    const events = new AsyncQueue<V2Event>();
    const controlPlane = buildControlPlane(events);
    vi.mocked(controlPlane.prompt).mockImplementation(async (request) => {
      events.enqueue(
        event('permission.v2.asked', {
          id: 'permission-1',
          action: 'write',
          resources: ['/repo/file.ts'],
        }),
      );
      events.enqueue(event('session.idle', {}));
      return {
        admittedSeq: 1,
        id: 'input',
        sessionID: request.sessionId,
        prompt: { text: request.text },
        delivery: 'queue',
        timeCreated: 1,
      };
    });
    const { executor } = buildExecutor(controlPlane, { permissionMode: 'auto' });

    const messages = await collect(executor.startExecution(options()).stream);

    expect(controlPlane.replyPermission).toHaveBeenCalledWith('ses_new', 'permission-1', 'once');
    expect(
      messages.some((message) =>
        message.message?.content?.some((part) => part.id === 'opencode-permission:permission-1'),
      ),
    ).toBe(false);
  });

  it('uses native steer delivery for an active turn', async () => {
    const events = new AsyncQueue<V2Event>();
    const controlPlane = buildControlPlane(events);
    const { executor } = buildExecutor(controlPlane);
    const handle = executor.startExecution(options());
    const reading = collect(handle.stream);
    await waitUntil(() => vi.mocked(controlPlane.prompt).mock.calls.length === 1);

    await expect(executor.steer('chat-1', 'also fix tests')).resolves.toBe('steered');
    expect(controlPlane.prompt).toHaveBeenLastCalledWith({
      sessionId: 'ses_new',
      text: 'also fix tests',
      delivery: 'steer',
    });
    events.enqueue(event('session.idle', {}));
    await reading;
  });

  it('recovers durable completion when the live event stream ends', async () => {
    const controlPlane = buildControlPlane();
    vi.mocked(controlPlane.subscribe).mockResolvedValue((async function* () {})());
    vi.mocked(controlPlane.history).mockResolvedValue([
      event('session.next.text.ended', {
        timestamp: 1,
        assistantMessageID: 'msg',
        textID: 'text',
        text: 'recovered',
      }) as any,
    ]);
    vi.mocked(controlPlane.isActive).mockResolvedValue(false);
    const { executor } = buildExecutor(controlPlane);

    const messages = await collect(executor.startExecution(options()).stream);

    expect(controlPlane.history).toHaveBeenCalledWith('ses_new', 0);
    expect(messages.at(-1)).toMatchObject({ type: 'result', subtype: 'success', result: 'recovered' });
  });

  it('rejects a resumed session owned by another directory', async () => {
    const controlPlane = buildControlPlane();
    vi.mocked(controlPlane.getSession).mockResolvedValue(session('ses_other', '/other'));
    const { executor } = buildExecutor(controlPlane);

    const messages = await collect(executor.startExecution({ ...options(), sessionId: 'ses_other' }).stream);

    expect(messages.at(-1)).toMatchObject({ type: 'result', subtype: 'error_during_execution' });
    expect(messages.at(-1)?.errors?.[0]).toContain('belongs to /other');
    expect(controlPlane.prompt).not.toHaveBeenCalled();
  });
});
