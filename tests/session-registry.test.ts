import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionRegistry } from '../src/session/session-registry.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('SessionRegistry (file-backed)', () => {
  let registry: SessionRegistry;
  let storeDir: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'metabot-registry-test-'));
    process.env.SESSION_STORE_DIR = storeDir;
  });

  afterEach(() => {
    if (registry) registry.close();
    delete process.env.SESSION_STORE_DIR;
    rmSync(storeDir, { recursive: true, force: true });
  });

  describe('bootstrapFromSessionMaps', () => {
    it('auto-imports sessions from sessions-<bot>.json on startup', () => {
      const sessionMap = {
        'oc_chat_abc': {
          sessionId: 'sess-111',
          workingDirectory: '/home/user/project-a',
          lastUsed: 1700000000000,
        },
        'oc_chat_def': {
          sessionId: 'sess-222',
          workingDirectory: '/home/user/project-b',
          lastUsed: 1700000001000,
        },
      };
      writeFileSync(join(storeDir, 'sessions-testbot.json'), JSON.stringify(sessionMap));

      registry = new SessionRegistry(createLogger());

      const sessions = registry.listSessions('testbot');
      expect(sessions).toHaveLength(2);
      expect(sessions[0].botName).toBe('testbot');
      expect(sessions[0].claudeSessionId).toBe('sess-222');
      expect(sessions[0].platform).toBe('feishu');
      expect(sessions[1].claudeSessionId).toBe('sess-111');
    });

    it('does not overwrite existing meta entries', () => {
      const sessionMap = {
        'oc_existing': {
          sessionId: 'sess-old',
          workingDirectory: '/old/path',
          lastUsed: 1700000000000,
        },
      };
      writeFileSync(join(storeDir, 'sessions-bot1.json'), JSON.stringify(sessionMap));

      registry = new SessionRegistry(createLogger());
      registry.createOrUpdate({
        chatId: 'oc_existing',
        botName: 'bot1',
        claudeSessionId: 'sess-new',
        workingDirectory: '/new/path',
        prompt: 'hello',
      });
      registry.close();

      // Re-bootstrap should not overwrite
      registry = new SessionRegistry(createLogger());
      const session = registry.getSession('oc_existing');
      expect(session?.claudeSessionId).toBe('sess-new');
    });
  });

  describe('getMessages (JSONL parsing)', () => {
    it('reads user and assistant messages from JSONL transcript', () => {
      const workdir = join(storeDir, 'test-project');
      mkdirSync(workdir, { recursive: true });

      // Compute the encoded workdir path
      const sanitized = workdir.replace(/[^a-zA-Z0-9]/g, '-');
      const transcriptDir = join(homedir(), '.claude', 'projects', sanitized);
      mkdirSync(transcriptDir, { recursive: true });

      const sessionId = 'test-session-id';
      const jsonlLines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello world' }, timestamp: 1700000000000 }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }, timestamp: 1700000001000 }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'How are you?' }] }, timestamp: 1700000002000 }),
      ];
      writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), jsonlLines.join('\n'));

      // Create a registry entry pointing to this session
      registry = new SessionRegistry(createLogger());
      registry.createOrUpdate({
        chatId: 'web_test_chat',
        botName: 'testbot',
        claudeSessionId: sessionId,
        workingDirectory: workdir,
        prompt: 'Hello world',
      });

      const messages = registry.getMessages('web_test_chat');
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({ role: 'user', text: 'Hello world', timestamp: 1700000000000 });
      expect(messages[1]).toMatchObject({ role: 'assistant', text: 'Hi there!', timestamp: 1700000001000 });
      expect(messages[2]).toMatchObject({ role: 'user', text: 'How are you?', timestamp: 1700000002000 });

      // Cleanup transcript
      rmSync(transcriptDir, { recursive: true, force: true });
    });

    it('returns empty array when no JSONL file exists', () => {
      registry = new SessionRegistry(createLogger());
      registry.createOrUpdate({
        chatId: 'web_no_jsonl',
        botName: 'testbot',
        claudeSessionId: 'nonexistent-session',
        workingDirectory: '/nonexistent/path',
        prompt: 'test',
      });

      const messages = registry.getMessages('web_no_jsonl');
      expect(messages).toEqual([]);
    });

    it('filters by since timestamp', () => {
      const workdir = join(storeDir, 'test-since');
      mkdirSync(workdir, { recursive: true });
      const sanitized = workdir.replace(/[^a-zA-Z0-9]/g, '-');
      const transcriptDir = join(homedir(), '.claude', 'projects', sanitized);
      mkdirSync(transcriptDir, { recursive: true });

      const sessionId = 'since-test-session';
      const jsonlLines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Old message' }, timestamp: 1700000000000 }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'New message' }, timestamp: 1700000002000 }),
      ];
      writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), jsonlLines.join('\n'));

      registry = new SessionRegistry(createLogger());
      registry.createOrUpdate({
        chatId: 'web_since_test',
        botName: 'testbot',
        claudeSessionId: sessionId,
        workingDirectory: workdir,
        prompt: 'test',
      });

      const messages = registry.getMessages('web_since_test', 1700000001000);
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('New message');

      rmSync(transcriptDir, { recursive: true, force: true });
    });
  });

  describe('CRUD operations', () => {
    it('creates and retrieves a session', () => {
      registry = new SessionRegistry(createLogger());
      const id = registry.createOrUpdate({
        chatId: 'oc_test1',
        botName: 'mybot',
        claudeSessionId: 'sess-abc',
        workingDirectory: '/tmp/test',
        prompt: 'Hello',
        responseText: 'Hi there',
      });

      const session = registry.getSession(id);
      expect(session).not.toBeNull();
      expect(session!.botName).toBe('mybot');
      expect(session!.claudeSessionId).toBe('sess-abc');
      expect(session!.title).toBe('Hello');
      expect(session!.platform).toBe('feishu');
    });

    it('updates existing session on second call', () => {
      registry = new SessionRegistry(createLogger());
      registry.createOrUpdate({
        chatId: 'oc_test2',
        botName: 'mybot',
        claudeSessionId: 'sess-v1',
        workingDirectory: '/tmp/test',
        prompt: 'First',
      });
      registry.createOrUpdate({
        chatId: 'oc_test2',
        botName: 'mybot',
        claudeSessionId: 'sess-v2',
        workingDirectory: '/tmp/test',
        prompt: 'Second',
      });

      const session = registry.getSession('oc_test2');
      expect(session!.claudeSessionId).toBe('sess-v2');
    });

    it('persists and restores across restarts', () => {
      registry = new SessionRegistry(createLogger());
      registry.createOrUpdate({
        chatId: 'oc_persist',
        botName: 'mybot',
        claudeSessionId: 'sess-persist',
        workingDirectory: '/tmp/test',
        prompt: 'Persist test',
      });
      registry.close();

      registry = new SessionRegistry(createLogger());
      const session = registry.getSession('oc_persist');
      expect(session).not.toBeNull();
      expect(session!.claudeSessionId).toBe('sess-persist');
    });
  });
});
