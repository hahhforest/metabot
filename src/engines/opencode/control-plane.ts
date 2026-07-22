import type {
  ModelRef,
  PermissionV2Reply,
  QuestionV2Reply,
  SessionDurableEvent,
  SessionInputAdmitted,
  SessionV2Info,
  V2Event,
} from '@opencode-ai/sdk/v2/types';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';

export interface OpenCodeSessionPage {
  sessions: SessionV2Info[];
  nextCursor?: string;
}

export interface OpenCodeControlPlane {
  createSession(options: { directory: string; model?: ModelRef; agent?: string }): Promise<SessionV2Info>;
  getSession(sessionId: string): Promise<SessionV2Info>;
  switchModel(sessionId: string, model: ModelRef): Promise<void>;
  switchAgent(sessionId: string, agent: string): Promise<void>;
  listSessions(options: { directory: string; limit?: number; cursor?: string }): Promise<OpenCodeSessionPage>;
  subscribe(signal: AbortSignal): Promise<AsyncIterable<V2Event>>;
  prompt(options: { sessionId: string; text: string; delivery?: 'steer' | 'queue' }): Promise<SessionInputAdmitted>;
  interrupt(sessionId: string): Promise<void>;
  replyQuestion(sessionId: string, requestId: string, reply: QuestionV2Reply): Promise<void>;
  rejectQuestion(sessionId: string, requestId: string): Promise<void>;
  replyPermission(sessionId: string, requestId: string, reply: PermissionV2Reply): Promise<void>;
  history(sessionId: string, after?: number): Promise<SessionDurableEvent[]>;
  isActive(sessionId: string): Promise<boolean>;
}

export class SdkOpenCodeControlPlane implements OpenCodeControlPlane {
  constructor(private readonly client: OpencodeClient) {}

  async createSession(options: { directory: string; model?: ModelRef; agent?: string }): Promise<SessionV2Info> {
    const body = await request(
      this.client.v2.session.create(
        {
          location: { directory: options.directory },
          ...(options.model ? { model: options.model } : {}),
          ...(options.agent ? { agent: options.agent } : {}),
        },
        { throwOnError: true },
      ),
    );
    return body.data;
  }

  async getSession(sessionId: string): Promise<SessionV2Info> {
    const body = await request(this.client.v2.session.get({ sessionID: sessionId }, { throwOnError: true }));
    return body.data;
  }

  async switchModel(sessionId: string, model: ModelRef): Promise<void> {
    await request(
      this.client.v2.session.switchModel(
        {
          sessionID: sessionId,
          model,
        },
        { throwOnError: true },
      ),
    );
  }

  async switchAgent(sessionId: string, agent: string): Promise<void> {
    await request(
      this.client.v2.session.switchAgent(
        {
          sessionID: sessionId,
          agent,
        },
        { throwOnError: true },
      ),
    );
  }

  async listSessions(options: { directory: string; limit?: number; cursor?: string }): Promise<OpenCodeSessionPage> {
    const body = await request(
      this.client.v2.session.list(
        {
          directory: options.directory,
          order: 'desc',
          ...(options.limit ? { limit: options.limit } : {}),
          ...(options.cursor ? { cursor: options.cursor } : {}),
        },
        { throwOnError: true },
      ),
    );
    return { sessions: body.data, nextCursor: body.cursor.next };
  }

  async subscribe(signal: AbortSignal): Promise<AsyncIterable<V2Event>> {
    const result = await this.client.v2.event.subscribe({
      signal,
      sseMaxRetryAttempts: 3,
      sseMaxRetryDelay: 2_000,
    });
    return result.stream;
  }

  async prompt(options: {
    sessionId: string;
    text: string;
    delivery?: 'steer' | 'queue';
  }): Promise<SessionInputAdmitted> {
    const body = await request(
      this.client.v2.session.prompt(
        {
          sessionID: options.sessionId,
          prompt: { text: options.text },
          delivery: options.delivery ?? 'queue',
          resume: true,
        },
        { throwOnError: true },
      ),
    );
    return body.data;
  }

  async interrupt(sessionId: string): Promise<void> {
    await request(this.client.v2.session.interrupt({ sessionID: sessionId }, { throwOnError: true }));
  }

  async replyQuestion(sessionId: string, requestId: string, reply: QuestionV2Reply): Promise<void> {
    await request(
      this.client.v2.session.question.reply(
        {
          sessionID: sessionId,
          requestID: requestId,
          questionV2Reply: reply,
        },
        { throwOnError: true },
      ),
    );
  }

  async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
    await request(
      this.client.v2.session.question.reject(
        {
          sessionID: sessionId,
          requestID: requestId,
        },
        { throwOnError: true },
      ),
    );
  }

  async replyPermission(sessionId: string, requestId: string, reply: PermissionV2Reply): Promise<void> {
    await request(
      this.client.v2.session.permission.reply(
        {
          sessionID: sessionId,
          requestID: requestId,
          reply,
        },
        { throwOnError: true },
      ),
    );
  }

  async history(sessionId: string, after?: number): Promise<SessionDurableEvent[]> {
    const body = await request(
      this.client.v2.session.history(
        {
          sessionID: sessionId,
          limit: 200,
          ...(after != null ? { after } : {}),
        },
        { throwOnError: true },
      ),
    );
    return body.data;
  }

  async isActive(sessionId: string): Promise<boolean> {
    const body = await request(this.client.v2.session.active({ throwOnError: true }));
    const active = body.data[sessionId];
    return !!active && typeof active === 'object' && 'type' in active && active.type === 'running';
  }
}

async function request<T>(promise: Promise<{ data: T; response: Response }>): Promise<T> {
  const result = await promise;
  return result.data;
}
