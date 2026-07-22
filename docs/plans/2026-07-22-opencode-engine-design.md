# OpenCode Engine Design

## Purpose

MetaBot integrates an agent runtime, not a command-line transcript. The OpenCode
integration must preserve the runtime concepts needed by MetaBot: durable
sessions, observable turn progress, tool activity, cancellation, questions, and
permissions. OpenCode's headless Server and official TypeScript SDK provide
those concepts directly, so they are the canonical transport. The
`opencode run --format json` output is intentionally not a fallback transport;
supporting it would introduce a second, less capable lifecycle and event model.

## Requirements

### Functional

- Select `opencode` anywhere an engine can be configured or selected.
- Start or connect to one loopback OpenCode Server per runtime configuration.
- Create a native OpenCode session for a new MetaBot chat and resume the same
  session on later turns.
- Translate native OpenCode events into the engine-neutral event protocol used
  by `MessageBridge` and `StreamProcessor`.
- Surface assistant text, tool lifecycle, usage, completion, failure, questions,
  and permission requests without replaying old session history.
- Abort an active OpenCode session through the native API.
- List resumable OpenCode sessions for the active working directory.
- Expose OpenCode through bot configuration, `/model`, Core Chat, Agent Teams,
  the Web UI, installer checks, and documentation.

### Non-functional

- Bind managed servers to loopback only and never expose them on the network by
  default.
- Use the official generated SDK types at the transport boundary.
- Keep OpenCode wire types inside `src/engines/opencode`.
- Make unsupported capabilities explicit; never satisfy an interface with a
  silent no-op.
- Distinguish managed server ownership from an externally supplied server URL.
- Make event subscription and cancellation deterministic under abort, timeout,
  server exit, malformed events, and reconnect.
- Preserve existing Claude, Codex, and Kimi behavior while removing their
  dependency on a Claude-owned shared message type.

## Architecture

```text
Channel / Core request
        |
        v
MessageBridge ---- SessionManager (chat -> engine -> native session)
        |
        v
Engine registry ---- EngineDescriptor / EngineCapabilities
        |
        v
OpenCodeExecutor ---- OpenCodeRuntimeManager
        |                    |
        |                    +-- external URL: connect only
        |                    +-- managed: spawn `opencode serve`, own close()
        v
OpenCode SDK client
        |
        +-- session.create / session.get / session.list
        +-- event subscription (subscribe before prompt)
        +-- session.promptAsync
        +-- session.abort
        +-- question.reply / reject
        +-- permission.reply
        |
        v
OpenCodeEventAdapter -> EngineEvent -> StreamProcessor -> CardState
```

The runtime manager is shared by turns from one engine instance. A managed
runtime chooses a loopback port, generates Basic Auth credentials when the
operator did not provide them, owns the child server, and closes it during
MetaBot shutdown. An external runtime is never terminated by MetaBot.
Individual chats map to individual native sessions; a server is not started per
chat or per turn. MetaBot starts the process directly instead of using the SDK
server helper because process executable, authentication, environment, and
ownership must remain explicit.

## Engine Boundary

The current `SDKMessage` is physically defined in the Claude executor but is
already produced by every engine. It becomes `EngineEvent` in
`src/engines/protocol.ts`. The first migration preserves the event semantics
consumed by `StreamProcessor`, then tightens the type into discriminated event
variants as adapters are migrated. This is a boundary correction, not an
OpenCode-specific fork.

Each engine exposes an immutable descriptor:

```ts
interface EngineDescriptor {
  name: EngineName;
  displayName: string;
  capabilities: EngineCapabilities;
  defaultModel?: string;
  exampleModels: readonly string[];
}

interface EngineCapabilities {
  liveText: boolean;
  tools: boolean;
  sessions: boolean;
  questions: boolean;
  permissions: boolean;
  steering: boolean;
  subagents: boolean;
  cancellation: 'best-effort' | 'acknowledged';
}
```

`ExecutionHandle` always provides an event stream and `cancel()`. Question,
permission, and steering operations are optional and must agree with the
descriptor. The existing `finish()` compatibility path is migrated to
`cancel()` rather than retained as an ambiguous resource-cleanup method.

`Engine.createStreamProcessor()` is removed because engines produce domain
events while the bridge owns presentation. The current bridge never calls the
method, so retaining it would falsely imply renderer polymorphism.

## OpenCode Turn Data Flow

1. Resolve the OpenCode runtime for the bot configuration and working
   directory.
2. Create a session when no OpenCode-owned session ID exists; otherwise verify
   and reuse the saved session.
3. Subscribe to the server-global native event stream before submitting the
   prompt, recording the session ID, location filter, and durable baseline.
4. Submit the user prompt asynchronously with the selected provider/model,
   agent, and variant.
5. Translate only events belonging to the active session and current turn.
6. Emit terminal success when the session returns to idle after the submitted
   turn; emit failure for provider/session errors and cancellation for abort.
7. Stop the subscription and release turn-local resources without terminating
   the shared runtime.

Durable session history and message retrieval are recovery mechanisms, not the
primary event transport. The global stream carries live text and tool-input
deltas that the durable per-session stream does not retain. On subscription
interruption, the executor reconciles from the last durable sequence, emits
unseen completed parts, and either resumes the global subscription or returns a
structured transport error. It must never replay the pre-turn transcript.

## Questions and Permissions

Question and permission events are correlated by native request ID and session
ID. They remain pending until the bridge sends a reply or the turn is aborted.
The bridge routes them by engine capability, not by Claude PTY configuration.

Default permission behavior is fail-closed. `auto` may approve requests only
when explicitly configured by the operator; it must not silently turn on for
OpenCode. A denied or unhandled request becomes a visible terminal error rather
than leaving a turn indefinitely busy.

## Failure Modes

| Failure | Required behavior |
|---|---|
| OpenCode executable missing | Fail startup/prerequisite check with installation guidance. |
| External server unavailable | Do not spawn a replacement; return a connection error. |
| Managed server fails to start | Include bounded stderr context and clean partial resources. |
| SSE disconnects | Reconcile once, retry with a bound, then fail visibly. |
| Prompt accepted but response times out | Native abort, then terminal timeout event. |
| MetaBot `/stop` | Await native abort acknowledgement and close turn subscription. |
| Unknown native event | Ignore safely but emit debug telemetry with runtime version. |
| Question/permission has no UI consumer | Fail closed; never auto-answer implicitly. |
| MetaBot exits | Close managed runtimes only; leave external runtimes untouched. |

## Verification

- Pure adapter tests with recorded native event fixtures.
- Runtime-manager tests for managed/external ownership, startup deduplication,
  loopback enforcement, health failure, and shutdown.
- Executor tests for fresh session, resume, baseline filtering, tools, terminal
  state, questions, permissions, abort, and disconnect recovery.
- Bridge tests proving capability-based question routing and engine-owned
  sessions.
- Product tests for config, commands, API, Agent Teams, Web UI, and installer.
- An opt-in real smoke test using the installed OpenCode runtime: create a
  session, complete a turn, resume it for a second turn, and abort a long turn.
