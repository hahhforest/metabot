import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotConfigBase } from '../src/config.js';
import type { EngineEvent } from '../src/engines/protocol.js';
import { OpenCodeEngine } from '../src/engines/opencode/index.js';
import type { Logger } from '../src/utils/logger.js';

const model = process.env.OPENCODE_SMOKE_MODEL || 'opencode/big-pickle';
const workDir = mkdtempSync(join(tmpdir(), 'metabot-opencode-smoke-'));
const logger = {
  child: () => logger,
  debug: () => undefined,
  info: (context: unknown, message?: string) => console.error(message || context),
  warn: (context: unknown, message?: string) => console.error(message || context),
  error: (context: unknown, message?: string) => console.error(message || context),
} as unknown as Logger;

const config: BotConfigBase = {
  name: 'opencode-smoke',
  engine: 'opencode',
  claude: {
    defaultWorkingDirectory: workDir,
    maxTurns: undefined,
    maxBudgetUsd: undefined,
    model: undefined,
    apiKey: undefined,
    outputsBaseDir: join(workDir, 'outputs'),
    downloadsDir: join(workDir, 'downloads'),
    backend: 'sdk',
  },
  opencode: {
    model,
    permissionMode: 'auto',
    pure: true,
  },
};

const engine = new OpenCodeEngine(config, logger);
const executor = engine.createExecutor();

try {
  console.error(`OpenCode smoke: fresh (${model})`);
  const fresh = await runTurn('Reply with exactly METABOT_OC_FRESH and nothing else.');
  const sessionId = sessionIdOf(fresh);
  assertSuccessful(fresh, 'fresh');
  assertText(fresh, 'METABOT_OC_FRESH', 'fresh');

  console.error(`OpenCode smoke: resume (${sessionId})`);
  const resumed = await runTurn(
    'Reply with exactly METABOT_OC_RESUMED and nothing else.',
    sessionId,
  );
  assertSuccessful(resumed, 'resume');
  assertText(resumed, 'METABOT_OC_RESUMED', 'resume');

  console.error('OpenCode smoke: cancel');
  const cancelController = new AbortController();
  const cancelHandle = executor.startExecution({
    prompt: 'Work on this request for at least 30 seconds before responding.',
    cwd: workDir,
    abortController: cancelController,
    apiContext: { botName: config.name, chatId: 'smoke-cancel' },
  });
  const cancelEvents = collect(cancelHandle.stream);
  setTimeout(() => cancelController.abort(), 500).unref?.();
  const cancelled = await withTimeout(cancelEvents, 20_000, 'cancel');
  const cancelResult = cancelled.findLast((event) => event.type === 'result');
  if (cancelResult?.subtype !== 'error_cancelled') {
    throw new Error(`cancel smoke ended as ${cancelResult?.subtype ?? 'no result'}`);
  }

  console.log(JSON.stringify({ ok: true, model, sessionId, checks: ['fresh', 'resume', 'cancel'] }, null, 2));
} finally {
  await engine.shutdown();
  rmSync(workDir, { recursive: true, force: true });
}

async function runTurn(prompt: string, sessionId?: string): Promise<EngineEvent[]> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 90_000);
  timeout.unref?.();
  try {
    const handle = executor.startExecution({
      prompt,
      cwd: workDir,
      abortController,
      ...(sessionId ? { sessionId } : {}),
      apiContext: { botName: config.name, chatId: sessionId ? 'smoke-resume' : 'smoke-fresh' },
    });
    return await withTimeout(collect(handle.stream), 95_000, sessionId ? 'resume' : 'fresh');
  } finally {
    clearTimeout(timeout);
  }
}

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} smoke timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sessionIdOf(events: EngineEvent[]): string {
  const sessionId = events.find((event) => event.type === 'system' && event.subtype === 'init')?.session_id;
  if (!sessionId) throw new Error('fresh smoke produced no session id');
  return sessionId;
}

function assertSuccessful(events: EngineEvent[], label: string): void {
  const result = events.findLast((event) => event.type === 'result');
  if (result?.subtype !== 'success') {
    const errors = result?.errors?.join('; ') || 'no result event';
    throw new Error(`${label} smoke failed: ${errors}`);
  }
}

function assertText(events: EngineEvent[], expected: string, label: string): void {
  const text = events
    .filter((event) => event.type === 'assistant')
    .flatMap((event) => event.message?.content ?? [])
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
  if (!text.includes(expected)) throw new Error(`${label} smoke response did not contain ${expected}: ${text}`);
}
