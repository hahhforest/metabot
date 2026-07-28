# ADR 0001: Integrate OpenCode through its Server and TypeScript SDK

- Status: Accepted
- Date: 2026-07-22

## Context

MetaBot needs a first-class OpenCode engine. The earlier PR #279 spawned
`opencode run --format json` once per turn and translated its JSONL output. That
path can display completed text and tool parts and can resume a session, but it
cannot faithfully expose the runtime's question, permission, cancellation, and
event-stream semantics. OpenCode's run command itself uses the OpenCode server
and client internally, so the CLI JSON is an additional lossy projection rather
than an independent control plane.

## Decision

MetaBot will integrate OpenCode through the official headless Server API and a
version-pinned `@opencode-ai/sdk`. The integration will support both:

- managed loopback runtimes started by MetaBot; and
- external runtimes explicitly configured by URL.

The Server/SDK implementation is the only production transport in the initial
release. It maps OpenCode native events into a MetaBot-owned `EngineEvent`
protocol and declares runtime capabilities explicitly.

MetaBot starts managed servers itself with `opencode serve` instead of using
the SDK's convenience server helper. This keeps executable selection, loopback
binding, Basic Auth, environment, stderr capture, and process ownership under
one explicit lifecycle. The initial contract pins both runtime and SDK to
OpenCode 1.17.14 because the v2 event and durable-history API is still evolving.

### MetaBot platform contracts

OpenCode is a fourth implementation of MetaBot's engine boundary, not a
parallel application stack. The integration therefore adopts the platform
contracts introduced in MetaBot v1.3:

- `EngineEvent`, execution, session, descriptor, and capability types remain
  MetaBot-owned. OpenCode SDK wire types do not escape `src/engines/opencode`.
- `ExecutionHandle.cancel()` is the engine-neutral asynchronous cancellation
  boundary. It resolves after the native runtime acknowledges interruption;
  `finish()` remains the local-consumption compatibility boundary. Async
  Bridge shutdown awaits cancellation before releasing engine-owned runtimes.
- Every executor uses the same `Current MetaBot Context` builder. The Bridge
  supplies the selected engine, current native session when known, and the
  compact Team Context; OpenCode must not maintain a second prompt-context
  schema.
- Team Context is only an active roster and dispatch hint. Tasks, messages,
  runs, outputs, and member prompts remain durable state queried through
  `metabot teams` rather than copied into model context.
- MetaBot-owned Skills are canonical user-global bundles. OpenCode discovers
  them through the shared Agent Skills root; installation never recreates a
  project-level MetaBot Skill mirror or overwrites user-owned `AGENTS.md` and
  `CLAUDE.md` files.

This separation keeps transport concerns inside the engine adapter, current
chat and Team semantics inside the platform, and reusable CLI behavior inside
the canonical Skill bundles.

## Alternatives

### Spawn `opencode run --format json`

This is smaller initially and resembles the existing Codex adapter. It was
rejected because it loses interactive control, uses best-effort process signals
for cancellation, and duplicates a lifecycle already implemented below it by
the OpenCode server.

### Support both Server/SDK and CLI fallback

This improves compatibility with restricted installations. It was rejected for
the first release because it doubles lifecycle, capability, event, and test
semantics without an identified deployment requirement. It can be reconsidered
only with a concrete environment where the Server API cannot be used.

### Reuse the Kimi snapshot-polling adapter

This would reuse an established MetaBot pattern. It was rejected as the primary
transport because OpenCode exposes native server-sent events. Snapshots or
message reads remain appropriate for bounded recovery and reconciliation.

### Give OpenCode its own prompt and project Skill mirror

This would minimize changes to the existing OpenCode executor, but was rejected
because runtime identity, Team routing, and installed behavior would drift by
engine. A stale workspace mirror could also shadow the global MetaBot Skill.
The shared context and global-install contracts are deliberately stronger than
engine convenience.

## Consequences

Positive:

- Preserves native sessions, cancellation, questions, permissions, and event
  ordering.
- Uses generated official types and one runtime for many sessions.
- Establishes a reusable capability-aware engine boundary.

Negative:

- MetaBot must manage server health, ownership, startup, shutdown, and event
  subscription recovery.
- SDK and compatible runtime versions must be documented and tested.
- The shared engine protocol and bridge capability routing require a focused
  refactor before OpenCode can be considered complete.

## Security and operations

- Managed runtimes bind to `127.0.0.1` only.
- External URLs require explicit configuration and are never terminated by
  MetaBot.
- Permission handling defaults to fail-closed.
- Authentication material is passed through environment/config without being
  logged.
- Runtime health and version are included in diagnostics and unknown-event
  telemetry.
