# OpenCode Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add OpenCode as a first-class MetaBot engine through the official local Server and TypeScript SDK.

**Architecture:** Correct the shared engine boundary first by moving the internal event protocol out of Claude and making capabilities explicit. Then add a managed-or-external OpenCode runtime, an event-driven executor and session adapter, followed by every product entry point and end-to-end verification.

**Tech Stack:** TypeScript ESM, Node.js 22, `@opencode-ai/sdk`, Vitest, OpenCode headless Server/SSE.

---

### Task 1: Establish the engine-owned protocol

**Files:**
- Create: `src/engines/protocol.ts`
- Modify: `src/engines/types.ts`
- Modify: `src/engines/claude/executor.ts`
- Modify: `src/engines/claude/stream-processor.ts`
- Modify: engine adapters and tests importing `SDKMessage`

**Steps:**

1. Add a compile-time test importing `EngineEvent` without importing Claude.
2. Move the current shared event fields into `src/engines/protocol.ts` and name
   the public type `EngineEvent`.
3. Update Claude, Codex, Kimi, StreamProcessor, and tests to consume the shared
   type.
4. Run `npm run build:bridge` and focused engine/stream tests.
5. Commit the protocol migration independently.

### Task 2: Add engine descriptors and capability routing

**Files:**
- Modify: `src/engines/types.ts`
- Modify: `src/engines/index.ts`
- Modify: `src/engines/{claude,codex,kimi}/index.ts`
- Modify: `src/bridge/message-bridge.ts`
- Modify: `src/bridge/command-handler.ts`
- Test: `tests/engine-factory.test.ts`
- Test: bridge question/steering tests

**Steps:**

1. Write failing tests for descriptors and the Kimi question path when Claude's
   configured backend is PTY.
2. Add `EngineDescriptor` and `EngineCapabilities`.
3. Define truthful descriptors for the three existing engines.
4. Remove dead `createStreamProcessor()` implementations.
5. Route questions, cancellation, steering, model hints, and session behavior by
   descriptor/capability instead of engine-specific presentation checks.
6. Run focused bridge and engine tests, then commit.

### Task 3: Add OpenCode configuration and runtime manager

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/config.ts`
- Create: `src/engines/opencode/runtime-manager.ts`
- Create: `src/engines/opencode/types.ts`
- Test: `tests/opencode-runtime-manager.test.ts`
- Test: config tests

**Steps:**

1. Add `@opencode-ai/sdk` and inspect the installed generated types used by the
   selected SDK version.
2. Write failing tests for config precedence, loopback defaults, external URL
   ownership, startup deduplication, and close semantics.
3. Add normalized OpenCode config: executable/server URL, managed/external mode,
   hostname/port, model, agent, variant, permission mode, and environment.
4. Implement the runtime manager with injectable server/client factories.
5. Ensure managed runtime startup is deduplicated and external runtimes are
   never closed.
6. Run tests and commit.

### Task 4: Implement the native event adapter

**Files:**
- Create: `src/engines/opencode/event-adapter.ts`
- Create: `tests/opencode-event-adapter.test.ts`

**Steps:**

1. Record minimal event fixtures for session, text, reasoning, tool lifecycle,
   usage, question, permission, error, and idle state.
2. Write failing translator tests including session filtering, duplicate events,
   and unknown events.
3. Implement a stateful adapter that emits only current-turn `EngineEvent`s.
4. Preserve native IDs for tool/question/permission correlation.
5. Run tests and commit.

### Task 5: Implement OpenCode execution and sessions

**Files:**
- Create: `src/engines/opencode/executor.ts`
- Create: `src/engines/opencode/session-lister.ts`
- Create: `src/engines/opencode/index.ts`
- Modify: `src/engines/index.ts`
- Test: `tests/opencode-executor.test.ts`
- Test: `tests/opencode-session-lister.test.ts`

**Steps:**

1. Write failing tests for fresh session, resume, subscribe-before-prompt,
   terminal completion, native abort, question reply, permission reply, and
   event disconnect.
2. Implement `OpenCodeExecutor` with a turn-local async queue and deterministic
   cleanup.
3. Implement native session listing filtered by normalized working directory.
4. Register `OpenCodeEngine` and its truthful capabilities.
5. Run focused tests and commit.

### Task 6: Complete every product integration surface

**Files:**
- Modify: `src/config.ts`
- Modify: `src/bridge/command-handler.ts`
- Modify: `src/bridge/message-bridge.ts`
- Modify: `src/api/bot-registry.ts`
- Modify: `src/api/routes/bot-routes.ts`
- Modify: `src/api/routes/core-chat-routes.ts`
- Modify: Agent Teams engine parsing/routes
- Modify: `packages/server` chat and bot routes
- Modify: `packages/web-ui/src/routes/chat.tsx`
- Modify: installer/runtime prerequisite code
- Modify: `.env.example` and example bot configs
- Test: corresponding config, command, API, UI, and installer tests

**Steps:**

1. Add failing tests demonstrating `opencode` is accepted and displayed at each
   public boundary.
2. Replace duplicated engine parsing/default metadata with the shared engine
   registry where practical.
3. Add OpenCode config serialization through every bot adapter.
4. Add model, authentication, resume, and prerequisite guidance.
5. Run affected package and bridge tests, then commit.

### Task 7: Documentation, real smoke, and completion audit

**Files:**
- Modify: `docs/concepts/architecture.md`
- Modify: `docs/concepts/architecture.zh.md`
- Modify: configuration, installation, and troubleshooting docs
- Create: `scripts/smoke-opencode.ts`
- Modify: CI or package scripts for an opt-in smoke target

**Steps:**

1. Document managed/external runtime modes, security defaults, capability
   differences, configuration, and supported OpenCode version.
2. Add a smoke script that creates a temporary project and runtime, performs two
   session-continuous turns, and verifies native abort without modifying a user
   workspace.
3. Run formatter, lint, typecheck, all tests, build, and the real smoke test.
4. Review the diff against every requirement in the design and ADR.
5. Commit the final docs and verification artifacts.
