import { describe, expect, it, vi } from 'vitest';
import type { V2Event } from '@opencode-ai/sdk/v2/types';
import { OpenCodeEventAdapter } from '../src/engines/opencode/event-adapter.js';

const sessionID = 'ses_test';
const location = { directory: '/repo' };

function event(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): V2Event {
  return {
    id: `${type}-${Math.random()}`,
    type,
    location,
    data: { sessionID, ...data },
    ...extra,
  } as V2Event;
}

describe('OpenCodeEventAdapter', () => {
  it('filters another session and directory and deduplicates event ids', () => {
    const adapter = new OpenCodeEventAdapter({ sessionId: sessionID, directory: '/repo' });
    const delta = event('session.next.text.delta', {
      assistantMessageID: 'msg', textID: 'text', timestamp: 1, delta: 'hello',
    });

    expect(adapter.translate({ ...delta, data: { ...delta.data, sessionID: 'other' } } as V2Event)).toEqual([]);
    expect(adapter.translate({ ...delta, location: { directory: '/other' } } as V2Event)).toEqual([]);
    expect(adapter.translate(delta)).toHaveLength(1);
    expect(adapter.translate(delta)).toEqual([]);
  });

  it('streams text deltas and reconciles the completed text', () => {
    const adapter = new OpenCodeEventAdapter({ sessionId: sessionID, directory: '/repo' });
    const first = adapter.translate(event('session.next.text.delta', {
      assistantMessageID: 'msg', textID: 'text', timestamp: 1, delta: 'hel',
    }));
    const completed = adapter.translate(event('session.next.text.ended', {
      assistantMessageID: 'msg', textID: 'text', timestamp: 2, text: 'hello',
    }));

    expect(first[0]?.event?.delta?.text).toBe('hel');
    expect(completed[0]?.message?.content?.[0]?.text).toBe('hello');
  });

  it('maps tools, usage, and idle into a successful terminal result', () => {
    const adapter = new OpenCodeEventAdapter({
      sessionId: sessionID,
      directory: '/repo',
      contextWindow: 200_000,
    });
    adapter.beginTurn();

    adapter.translate(event('session.next.step.started', {
      timestamp: 1,
      assistantMessageID: 'msg',
      agent: 'build',
      model: { providerID: 'openai', id: 'gpt-5.6' },
    }));
    const called = adapter.translate(event('session.next.tool.called', {
      timestamp: 2,
      assistantMessageID: 'msg',
      callID: 'call-1',
      tool: 'bash',
      input: { command: 'pwd' },
      provider: { executed: true },
    }));
    const succeeded = adapter.translate(event('session.next.tool.success', {
      timestamp: 3,
      assistantMessageID: 'msg',
      callID: 'call-1',
      structured: {},
      content: [{ type: 'text', text: '/repo' }],
      provider: { executed: true },
    }));
    adapter.translate(event('session.next.step.ended', {
      timestamp: 4,
      assistantMessageID: 'msg',
      finish: 'stop',
      cost: 0.12,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
    }));
    const result = adapter.translate(event('session.idle', {}));

    expect(called[0]?.message?.content?.[0]).toMatchObject({
      type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'pwd' },
    });
    expect(succeeded[0]?.message?.content?.[0]).toMatchObject({ type: 'tool_result', id: 'call-1' });
    expect(result[0]).toMatchObject({
      type: 'result', subtype: 'success', total_cost_usd: 0.12,
      modelUsage: {
        'openai/gpt-5.6': {
          inputTokens: 112,
          outputTokens: 25,
          contextWindow: 200000,
          costUSD: 0.12,
        },
      },
    });
  });

  it('maps native questions and permissions into correlated interactive tools', () => {
    const adapter = new OpenCodeEventAdapter({ sessionId: sessionID, directory: '/repo' });
    const question = adapter.translate(event('question.v2.asked', {
      id: 'question-1',
      questions: [{
        header: 'Deploy',
        question: 'Continue deployment?',
        options: [{ label: 'Continue', description: 'Proceed.' }],
        multiple: false,
        custom: false,
      }],
    }));
    const permission = adapter.translate(event('permission.v2.asked', {
      id: 'permission-1',
      action: 'write',
      resources: ['/repo/file.ts'],
    }));

    expect(question[0]?.message?.content?.[0]).toMatchObject({
      type: 'tool_use', id: 'opencode-question:question-1', name: 'AskUserQuestion',
    });
    expect(adapter.getPendingInteraction('opencode-question:question-1')?.kind).toBe('question');
    expect(permission[0]?.message?.content?.[0]).toMatchObject({
      type: 'tool_use', id: 'opencode-permission:permission-1', name: 'AskUserQuestion',
    });
    expect(adapter.getPendingInteraction('opencode-permission:permission-1')?.kind).toBe('permission');
  });

  it('turns failures into one terminal error and observes unknown session events', () => {
    const onUnknownEvent = vi.fn();
    const adapter = new OpenCodeEventAdapter({
      sessionId: sessionID,
      directory: '/repo',
      onUnknownEvent,
    });
    adapter.beginTurn();

    expect(adapter.translate(event('session.next.some-new-event', {}))).toEqual([]);
    const failure = adapter.translate(event('session.next.step.failed', {
      timestamp: 1,
      assistantMessageID: 'msg',
      error: { type: 'unknown', message: 'provider failed' },
    }));
    expect(onUnknownEvent).toHaveBeenCalledWith('session.next.some-new-event');
    expect(failure[0]).toMatchObject({
      type: 'result', subtype: 'error_during_execution', errors: ['provider failed'],
    });
    expect(adapter.translate(event('session.idle', {}))).toEqual([]);
  });

  it('tracks the highest durable sequence for reconnect recovery', () => {
    const adapter = new OpenCodeEventAdapter({ sessionId: sessionID, directory: '/repo' });
    adapter.translate(event('session.next.text.started', {
      timestamp: 1, assistantMessageID: 'msg', textID: 'text',
    }, { durable: { aggregateID: sessionID, seq: 7, version: 1 } }));
    adapter.translate(event('session.next.text.delta', {
      timestamp: 2, assistantMessageID: 'msg', textID: 'text', delta: 'x',
    }, { durable: { aggregateID: sessionID, seq: 9, version: 1 } }));
    expect(adapter.getDurableSequence()).toBe(9);
  });
});

