import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../src/engines/claude/session-manager.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('SessionManager', () => {
  let manager: SessionManager;
  let storeDir: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'metabot-session-test-'));
    process.env.SESSION_STORE_DIR = storeDir;
  });

  afterEach(() => {
    if (manager) manager.destroy();
    delete process.env.SESSION_STORE_DIR;
    rmSync(storeDir, { recursive: true, force: true });
  });

  it('creates a new session with default working directory', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const session = manager.getSession('chat1');
    expect(session.workingDirectory).toBe('/tmp/test-dir');
    expect(session.sessionId).toBeUndefined();
  });

  it('returns the same session for the same chatId', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const s1 = manager.getSession('chat1');
    const s2 = manager.getSession('chat1');
    expect(s1).toBe(s2);
  });

  it('returns different sessions for different chatIds', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const s1 = manager.getSession('chat1');
    const s2 = manager.getSession('chat2');
    expect(s1).not.toBe(s2);
  });

  it('sets session ID', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.getSession('chat1');
    manager.setSessionId('chat1', 'sess-abc', 'codex');
    const session = manager.getSession('chat1');
    expect(session.sessionId).toBe('sess-abc');
    expect(session.sessionIdEngine).toBe('codex');
  });

  it('tracks model engine and clears it with the model override', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.setSessionModel('chat1', 'gpt-5.5-codex', 'codex');

    let session = manager.getSession('chat1');
    expect(session.model).toBe('gpt-5.5-codex');
    expect(session.modelEngine).toBe('codex');

    manager.setSessionModel('chat1', undefined);
    session = manager.getSession('chat1');
    expect(session.model).toBeUndefined();
    expect(session.modelEngine).toBeUndefined();
  });

  it('persists session and model engine metadata', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger(), 'persist-test');
    manager.setSessionId('chat1', 'sess-abc', 'codex');
    manager.setSessionModel('chat1', 'gpt-5.5-codex', 'codex');
    manager.destroy();

    manager = new SessionManager('/tmp/test-dir', createLogger(), 'persist-test');
    const session = manager.getSession('chat1');
    expect(session.sessionId).toBe('sess-abc');
    expect(session.sessionIdEngine).toBe('codex');
    expect(session.model).toBe('gpt-5.5-codex');
    expect(session.modelEngine).toBe('codex');
  });

  // --- Multi-session (SessionGroup) tests ---

  describe('resetSession (multi-session)', () => {
    it('creates a new session and preserves the old one', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.setSessionId('chat1', 'sess-old');
      manager.resetSession('chat1');

      const current = manager.getSession('chat1');
      expect(current.sessionId).toBeUndefined();

      const sessions = manager.listSessions('chat1');
      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBe('sess-old');
      expect(sessions[1].isActive).toBe(true);
    });

    it('active index points to the new session', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.setSessionId('chat1', 'sess-1');
      manager.resetSession('chat1');
      expect(manager.getActiveIndex('chat1')).toBe(1);
    });
  });

  describe('listSessions', () => {
    it('returns empty array for unknown chatId', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      expect(manager.listSessions('unknown')).toEqual([]);
    });

    it('returns sessions with correct format', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.setSessionId('chat1', 'sess-aaa');
      manager.setTitle('chat1', 'Hello world');
      manager.resetSession('chat1');
      manager.setSessionId('chat1', 'sess-bbb');

      const sessions = manager.listSessions('chat1');
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({ index: 0, title: 'Hello world', sessionId: 'sess-aaa', isActive: false });
      expect(sessions[1]).toMatchObject({ index: 1, sessionId: 'sess-bbb', isActive: true });
    });
  });

  describe('switchSession', () => {
    it('switches to a valid index', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.setSessionId('chat1', 'sess-aaa');
      manager.resetSession('chat1');
      manager.setSessionId('chat1', 'sess-bbb');

      const switched = manager.switchSession('chat1', 0);
      expect(switched).toBe(true);
      expect(manager.getSession('chat1').sessionId).toBe('sess-aaa');
      expect(manager.getActiveIndex('chat1')).toBe(0);
    });

    it('returns false for invalid index', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.getSession('chat1');
      expect(manager.switchSession('chat1', 5)).toBe(false);
      expect(manager.switchSession('chat1', -1)).toBe(false);
    });

    it('returns false for unknown chatId', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      expect(manager.switchSession('unknown', 0)).toBe(false);
    });
  });

  describe('getVirtualChatId', () => {
    it('returns plain chatId for index 0', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.getSession('chat1');
      expect(manager.getVirtualChatId('chat1')).toBe('chat1');
    });

    it('returns chatId::N for non-zero index', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.getSession('chat1');
      manager.resetSession('chat1');
      expect(manager.getVirtualChatId('chat1')).toBe('chat1::1');
    });
  });

  describe('setTitle', () => {
    it('sets title on the active session', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.getSession('chat1');
      manager.setTitle('chat1', 'My first message');
      const sessions = manager.listSessions('chat1');
      expect(sessions[0].title).toBe('My first message');
    });

    it('does not overwrite an existing title', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.getSession('chat1');
      manager.setTitle('chat1', 'First');
      manager.setTitle('chat1', 'Second');
      const sessions = manager.listSessions('chat1');
      expect(sessions[0].title).toBe('First');
    });
  });

  describe('switchToSessionByPrefix', () => {
    it('finds and switches to session by prefix', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.setSessionId('chat1', 'abcdef1234567890');
      manager.resetSession('chat1');
      manager.setSessionId('chat1', 'xyz98765abcdef00');

      const idx = manager.switchToSessionByPrefix('chat1', 'abcdef12');
      expect(idx).toBe(0);
      expect(manager.getActiveIndex('chat1')).toBe(0);
    });

    it('returns -1 for no match', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.setSessionId('chat1', 'abcdef1234567890');
      expect(manager.switchToSessionByPrefix('chat1', 'xxxxxxxx')).toBe(-1);
    });

    it('rejects prefixes shorter than 8 chars', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      manager.setSessionId('chat1', 'abcdef1234567890');
      expect(manager.switchToSessionByPrefix('chat1', 'abc')).toBe(-1);
    });
  });

  describe('MAX_SESSIONS_PER_CHAT limit', () => {
    it('trims oldest sessions when exceeding limit', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger());
      // Create 20 sessions (the max)
      for (let i = 0; i < 20; i++) {
        if (i > 0) manager.resetSession('chat1');
        manager.setSessionId('chat1', `sess-${String(i).padStart(3, '0')}`);
      }
      expect(manager.listSessions('chat1')).toHaveLength(20);

      // One more reset should trim
      manager.resetSession('chat1');
      const sessions = manager.listSessions('chat1');
      expect(sessions).toHaveLength(20);
      // The oldest (sess-000) should be gone
      expect(sessions.find(s => s.sessionId === 'sess-000')).toBeUndefined();
    });
  });

  describe('persistence with session groups', () => {
    it('saves and restores session groups', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger(), 'group-test');
      manager.setSessionId('chat1', 'sess-aaa');
      manager.setTitle('chat1', 'First topic');
      manager.resetSession('chat1');
      manager.setSessionId('chat1', 'sess-bbb');
      manager.setTitle('chat1', 'Second topic');
      manager.destroy();

      manager = new SessionManager('/tmp/test-dir', createLogger(), 'group-test');
      const sessions = manager.listSessions('chat1');
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({ sessionId: 'sess-aaa', title: 'First topic' });
      expect(sessions[1]).toMatchObject({ sessionId: 'sess-bbb', title: 'Second topic', isActive: true });
    });

    it('preserves upstream fields (engine, model, goal) through groups', () => {
      manager = new SessionManager('/tmp/test-dir', createLogger(), 'fields-test');
      manager.setSessionId('chat1', 'sess-aaa');
      manager.setSessionModel('chat1', 'claude-opus-4-7', 'claude');
      manager.setGoal('chat1', 'fix all bugs');
      manager.destroy();

      manager = new SessionManager('/tmp/test-dir', createLogger(), 'fields-test');
      const session = manager.getSession('chat1');
      expect(session.model).toBe('claude-opus-4-7');
      expect(session.modelEngine).toBe('claude');
      expect(session.activeGoal).toBe('fix all bugs');
    });
  });

  describe('legacy format migration', () => {
    it('migrates old flat format to session group', () => {
      // Write old flat format directly
      const persistPath = join(storeDir, 'sessions-migrate-test.json');
      const oldData = {
        chat1: {
          sessionId: 'legacy-sess-id',
          workingDirectory: '/old/dir',
          lastUsed: Date.now(),
          cumulativeTokens: 100,
          cumulativeCostUsd: 0.5,
          cumulativeDurationMs: 5000,
        },
      };
      writeFileSync(persistPath, JSON.stringify(oldData));

      manager = new SessionManager('/tmp/test-dir', createLogger(), 'migrate-test');
      const session = manager.getSession('chat1');
      expect(session.sessionId).toBe('legacy-sess-id');
      expect(session.workingDirectory).toBe('/old/dir');

      const sessions = manager.listSessions('chat1');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].isActive).toBe(true);
    });
  });
});
