import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Logger } from '../../utils/logger.js';
import type { EngineName } from '../types.js';

export interface UserSession {
  sessionId: string | undefined;
  /** Engine that owns sessionId. Engine session stores are not interchangeable. */
  sessionIdEngine?: EngineName;
  workingDirectory: string;
  lastUsed: number;
  /** Cumulative token usage across all queries in this session */
  cumulativeTokens: number;
  /** Cumulative cost (USD) across all queries in this session */
  cumulativeCostUsd: number;
  /** Cumulative duration (ms) across all queries in this session */
  cumulativeDurationMs: number;
  /** Per-session model override (e.g. "claude-opus-4-7"). Falls back to bot default when undefined. */
  model?: string;
  /** Engine that owns model. Model names are engine-specific. */
  modelEngine?: EngineName;
  /** Per-session engine override. Falls back to bot default when undefined. */
  engine?: EngineName;
  /**
   * Mirrored Claude /goal condition. The actual goal mechanism runs inside
   * Claude Code (prompt-based Stop hook); we just remember the text so the
   * Feishu card can show a persistent "🎯 Goal" badge across turns.
   */
  activeGoal?: string;
  /** Wall-clock when the current goal was set (ms since epoch). */
  goalSetAt?: number;
  /** First message preview, used as session title in /sessions listing. */
  title?: string;
}

interface PersistedSession {
  sessionId: string;
  sessionIdEngine?: EngineName;
  workingDirectory: string;
  lastUsed: number;
  cumulativeTokens?: number;
  cumulativeCostUsd?: number;
  cumulativeDurationMs?: number;
  model?: string;
  modelEngine?: EngineName;
  engine?: EngineName;
  activeGoal?: string;
  goalSetAt?: number;
  title?: string;
}

interface PersistedSessionGroup {
  activeIndex: number;
  sessions: PersistedSession[];
}

interface SessionGroup {
  activeIndex: number;
  sessions: UserSession[];
}

export interface SessionListEntry {
  index: number;
  title?: string;
  sessionId?: string;
  lastUsed: number;
  isActive: boolean;
}

// Sessions never expire — user can /reset manually.
// IMPORTANT: When switching a bot's defaultWorkingDirectory, do NOT delete
// session files (~/.metabot/<bot>/sessions-*.json, sessions.db).
// Old sessions must be preserved so the user can switch back to a previous
// project and resume context. loadFromDisk() uses the new defaultWorkingDirectory
// from config, not from the persisted session, so old sessions don't interfere.
const SESSION_TTL_MS = Infinity;
const MAX_SESSIONS = 10_000;
const MAX_SESSIONS_PER_CHAT = 20;

export class SessionManager {
  // Concurrency note: MessageBridge enforces one running task per chatId
  // via its runningTasks map, so activeIndex reads/writes within a single
  // chatId are inherently serialized. No additional locking is needed.
  private groups = new Map<string, SessionGroup>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private persistPath: string;

  constructor(
    private defaultWorkingDirectory: string,
    private logger: Logger,
    botName: string = 'default',
  ) {
    const dataDir = process.env.SESSION_STORE_DIR
      || path.join(os.homedir(), '.metabot');
    fs.mkdirSync(dataDir, { recursive: true });
    this.persistPath = path.join(dataDir, `sessions-${botName}.json`);

    this.loadFromDisk();

    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60 * 60 * 1000);
  }

  private getOrCreateGroup(chatId: string): SessionGroup {
    let group = this.groups.get(chatId);
    if (!group) {
      if (this.totalSessionCount() >= MAX_SESSIONS) {
        this.evictOldest();
      }
      group = {
        activeIndex: 0,
        sessions: [this.createFreshSession()],
      };
      this.groups.set(chatId, group);
    }
    return group;
  }

  private createFreshSession(): UserSession {
    return {
      sessionId: undefined,
      workingDirectory: this.defaultWorkingDirectory,
      lastUsed: Date.now(),
      cumulativeTokens: 0,
      cumulativeCostUsd: 0,
      cumulativeDurationMs: 0,
    };
  }

  private totalSessionCount(): number {
    let count = 0;
    for (const group of this.groups.values()) {
      count += group.sessions.length;
    }
    return count;
  }

  getSession(chatId: string): UserSession {
    const group = this.getOrCreateGroup(chatId);
    const session = group.sessions[group.activeIndex];
    session.lastUsed = Date.now();
    return session;
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, group] of this.groups) {
      for (const s of group.sessions) {
        if (s.lastUsed < oldestTime) {
          oldestTime = s.lastUsed;
          oldestKey = key;
        }
      }
    }
    if (oldestKey) {
      this.groups.delete(oldestKey);
      this.logger.debug({ chatId: oldestKey }, 'Evicted oldest session group (capacity limit)');
    }
  }

  setSessionId(chatId: string, sessionId: string, engine?: EngineName): void {
    const session = this.getSession(chatId);
    session.sessionId = sessionId;
    session.sessionIdEngine = engine;
    this.logger.debug({ chatId, sessionId: sessionId.slice(0, 8), engine }, 'Session ID updated');
    this.saveToDisk();
  }

  /** Set per-session model override. Pass undefined to clear. */
  setSessionModel(chatId: string, model: string | undefined, engine?: EngineName): void {
    const session = this.getSession(chatId);
    session.model = model;
    session.modelEngine = model ? engine : undefined;
    this.logger.info({ chatId, model, engine: session.modelEngine }, 'Session model override updated');
    this.saveToDisk();
  }

  /**
   * Set per-session engine override. Pass undefined to clear and fall back
   * to the bot's configured engine. Switching engines also clears the prior
   * `sessionId` (engines track conversation state in different stores) and
   * any stale model override, so the next turn starts a fresh session.
   */
  setSessionEngine(chatId: string, engine: EngineName | undefined): void {
    const session = this.getSession(chatId);
    if (session.engine === engine) return;
    session.engine = engine;
    session.sessionId = undefined;
    session.sessionIdEngine = undefined;
    session.model = undefined;
    session.modelEngine = undefined;
    this.logger.info({ chatId, engine }, 'Session engine override updated (session reset)');
    this.saveToDisk();
  }

  /**
   * Set the mirrored /goal condition for this session. Pass undefined to
   * clear it. The actual goal mechanism runs inside Claude Code; this is
   * purely so the card can display a persistent badge.
   */
  setGoal(chatId: string, condition: string | undefined): void {
    const session = this.getSession(chatId);
    if (condition) {
      session.activeGoal = condition;
      session.goalSetAt = Date.now();
    } else {
      session.activeGoal = undefined;
      session.goalSetAt = undefined;
    }
    this.logger.info({ chatId, hasGoal: !!condition }, 'Session goal updated');
    this.saveToDisk();
  }

  /** Accumulate token/cost/duration from a completed query into the session totals. */
  addUsage(chatId: string, tokens: number, costUsd: number, durationMs: number): void {
    const session = this.getSession(chatId);
    session.cumulativeTokens += tokens;
    session.cumulativeCostUsd += costUsd;
    session.cumulativeDurationMs += durationMs;
    this.saveToDisk();
  }

  /**
   * Create a new session in the group instead of clearing the old one.
   * Old sessions are preserved and can be switched back via /sessions.
   */
  resetSession(chatId: string): void {
    const group = this.groups.get(chatId);
    if (group) {
      const newSession = this.createFreshSession();
      group.sessions.push(newSession);
      group.activeIndex = group.sessions.length - 1;
      // Trim oldest sessions if over limit (keep the active one)
      while (group.sessions.length > MAX_SESSIONS_PER_CHAT) {
        const removeIdx = group.activeIndex === 0 ? 1 : 0;
        group.sessions.splice(removeIdx, 1);
        if (group.activeIndex > removeIdx) group.activeIndex--;
      }
      this.logger.info({ chatId, sessionCount: group.sessions.length }, 'New session created (old sessions preserved)');
      this.saveToDisk();
    }
  }

  /** Set display title on the active session (typically first message preview). */
  setTitle(chatId: string, title: string): void {
    const session = this.getSession(chatId);
    if (!session.title) {
      session.title = title;
      this.saveToDisk();
    }
  }

  /** List all sessions in a chat group for /sessions display. */
  listSessions(chatId: string): SessionListEntry[] {
    const group = this.groups.get(chatId);
    if (!group) return [];
    return group.sessions.map((s, i) => ({
      index: i,
      title: s.title,
      sessionId: s.sessionId,
      lastUsed: s.lastUsed,
      isActive: i === group.activeIndex,
    }));
  }

  /** Switch to a different session by index. Returns false if index is out of range. */
  switchSession(chatId: string, index: number): boolean {
    const group = this.groups.get(chatId);
    if (!group || index < 0 || index >= group.sessions.length) return false;
    group.activeIndex = index;
    group.sessions[index].lastUsed = Date.now();
    this.logger.info({ chatId, index, sessionCount: group.sessions.length }, 'Switched active session');
    this.saveToDisk();
    return true;
  }

  /** Get the active session index for a chat. Returns 0 if no group exists. */
  getActiveIndex(chatId: string): number {
    const group = this.groups.get(chatId);
    return group ? group.activeIndex : 0;
  }

  /**
   * Virtual chatId for SessionRegistry isolation.
   * Different sessions within the same chat get distinct registry entries.
   */
  getVirtualChatId(chatId: string): string {
    const idx = this.getActiveIndex(chatId);
    return idx === 0 ? chatId : `${chatId}::${idx}`;
  }

  /**
   * Find and switch to a session by sessionId prefix (8+ chars).
   * Returns the matched index or -1 if not found.
   */
  switchToSessionByPrefix(chatId: string, prefix: string): number {
    const group = this.groups.get(chatId);
    if (!group || prefix.length < 8) return -1;
    const lowerPrefix = prefix.toLowerCase();
    for (let i = 0; i < group.sessions.length; i++) {
      const sid = group.sessions[i].sessionId;
      if (sid && sid.toLowerCase().startsWith(lowerPrefix)) {
        group.activeIndex = i;
        group.sessions[i].lastUsed = Date.now();
        this.logger.info({ chatId, index: i, prefix }, 'Switched session by prefix');
        this.saveToDisk();
        return i;
      }
    }
    return -1;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const [chatId, group] of this.groups) {
      const allExpired = group.sessions.every(s => now - s.lastUsed > SESSION_TTL_MS);
      if (allExpired) {
        this.groups.delete(chatId);
        this.logger.debug({ chatId }, 'Expired session group cleaned up');
        changed = true;
      }
    }
    if (changed) {
      this.saveToDisk();
    }
  }

  private saveToDisk(): void {
    try {
      const data: Record<string, PersistedSessionGroup> = {};
      for (const [chatId, group] of this.groups) {
        // Persist all sessions in a group — even new ones without a sessionId yet.
        // The group is the unit of persistence; filtering individual sessions
        // would lose newly-created (post-/reset) sessions before their first turn.
        const hasContent = group.sessions.some(
          s => s.sessionId || s.model || s.engine || s.activeGoal || s.title,
        );
        if (hasContent || group.sessions.length > 1) {
          data[chatId] = {
            activeIndex: group.activeIndex,
            sessions: group.sessions.map(s => this.sessionToPersisted(s)),
          };
        }
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn({ err }, 'Failed to persist sessions to disk');
    }
  }

  private sessionToPersisted(s: UserSession): PersistedSession {
    return {
      sessionId: s.sessionId || '',
      sessionIdEngine: s.sessionIdEngine,
      workingDirectory: s.workingDirectory,
      lastUsed: s.lastUsed,
      cumulativeTokens: s.cumulativeTokens,
      cumulativeCostUsd: s.cumulativeCostUsd,
      cumulativeDurationMs: s.cumulativeDurationMs,
      model: s.model,
      modelEngine: s.modelEngine,
      engine: s.engine,
      activeGoal: s.activeGoal,
      goalSetAt: s.goalSetAt,
      title: s.title,
    };
  }

  private persistedToSession(p: PersistedSession): UserSession {
    return {
      sessionId: p.sessionId || undefined,
      sessionIdEngine: p.sessionIdEngine,
      workingDirectory: p.workingDirectory,
      lastUsed: p.lastUsed,
      cumulativeTokens: p.cumulativeTokens ?? 0,
      cumulativeCostUsd: p.cumulativeCostUsd ?? 0,
      cumulativeDurationMs: p.cumulativeDurationMs ?? 0,
      model: p.model,
      modelEngine: p.modelEngine,
      engine: p.engine,
      activeGoal: p.activeGoal,
      goalSetAt: p.goalSetAt,
      title: p.title,
    };
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data: Record<string, PersistedSessionGroup | PersistedSession> = JSON.parse(raw);
      let loaded = 0;
      for (const [chatId, entry] of Object.entries(data)) {
        // Detect old flat format (has 'sessionId' at top level) vs new group format (has 'sessions' array)
        if (this.isLegacyPersistedSession(entry)) {
          const session = this.persistedToSession(entry);
          this.groups.set(chatId, { activeIndex: 0, sessions: [session] });
          loaded++;
        } else {
          const groupData = entry as PersistedSessionGroup;
          const sessions = groupData.sessions.map(p => this.persistedToSession(p));
          if (sessions.length > 0) {
            const activeIndex = Math.min(groupData.activeIndex, sessions.length - 1);
            this.groups.set(chatId, { activeIndex: Math.max(0, activeIndex), sessions });
            loaded++;
          }
        }
      }
      if (loaded > 0) {
        this.logger.info({ loaded, path: this.persistPath }, 'Restored sessions from disk');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load sessions from disk, starting fresh');
    }
  }

  private isLegacyPersistedSession(entry: unknown): entry is PersistedSession {
    return typeof entry === 'object' && entry !== null && 'workingDirectory' in entry && !('sessions' in entry);
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.saveToDisk();
  }
}
