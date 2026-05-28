# ADR-0004: Agent Harness Boundary, State Machine, and Hexagonal Ports

## Status

Accepted

## Context

Keiko's core value proposition in a regulated banking and insurance environment is that every
developer-assist action is explainable, evidence-backed, and developer-controlled. Issue #4 delivers
the Wave-1 agent harness — the component that owns the run loop for all bounded task types. Three
forces make its design non-trivial:

**Control ownership.** Language model outputs are probabilistic. If the model response drives control
flow (e.g., the harness interprets a "do X next" string in the model's reply and executes it), the
system becomes non-deterministic and untestable. The harness must own all branching decisions; model
responses are inputs to the next harness decision, not instructions.

**Observability for regulated environments.** In banking and insurance, every automated action that
touches a codebase must be attributable, timestamped, and reproducible for post-hoc audit. An ad-hoc
logging approach cannot satisfy this: the audit ledger (issue #10) and the local UI (issue #13) both
need a stable, structured event stream they can consume without parsing terminal output.

**Boundary stability for downstream issues.** Issues #6 (tool execution), #10 (audit ledger), and
#13 (UI) each depend on seams exposed by this harness. If those seams are internal implementation
details rather than explicit typed interfaces, every downstream issue risks rewriting parts of the
harness. The seams must be stable typed ports defined before those issues begin.

**Zero-dependency constraint (ADR-0001, load-bearing).** All runtime behaviour must use Node 22
built-ins. This rules out state-machine libraries (XState), event-emitter libraries (EventEmitter3),
RxJS, or any other runtime npm package. The harness implements its own lightweight state machine,
cancellation, and event delivery using `AbortController`/`AbortSignal` and plain TypeScript.

**LOC discipline (ADR-0001).** File ≤ 400 LOC, function ≤ 50 LOC, cyclomatic complexity ≤ 10. The
harness is architecturally large; it must be decomposed into many small, single-responsibility files
from the start.

**Module location.** ADR-0001 explicitly reserves `src/harness/` for the agent run loop. This ADR
implements that reservation. The current stub (`src/harness/index.ts`) is replaced by the full module.

## Decision

### D1 — The harness owns an explicit named state machine; model responses are loop inputs

We will implement the harness as a **named, explicit state machine** whose transitions are driven
entirely by harness logic. Model responses are data: the harness reads a `NormalizedResponse`, applies
its own rules to determine the next state, and transitions accordingly. The model never "decides" to
call a tool or terminate — the harness inspects `finishReason` and `toolCalls` and decides.

The named states (from the `HarnessState` discriminated union) are:

```
intake → planning → context-selection → model-call → tool-call → patch-proposal
       → verification → reporting

terminal states: completed | cancelled | failed | limit-exceeded
```

Every state transition is emitted as a structured event before it takes effect. This means the event
stream is the authoritative record of what the harness did and why.

### D2 — Three hexagonal ports isolate the harness from all I/O concerns

The harness (high-level policy) depends on three abstractions (ports), never on concretions:

**ModelPort** — wraps the existing `Gateway` from ADR-0003. The harness does not import `Gateway`
directly; it depends on the `ModelPort` interface. The production adapter passes the run's
`AbortSignal` as `GatewayRequest.cancellationSignal`, propagating cancellation to the model call.

**ToolPort** — a NEW interface the harness depends on for all tool execution. Issue #6 implements
the real file/test/command executors later. Wave 1 ships only: the `ToolPort` interface, an
in-memory no-op mock (for tests), and a dry-run executor that records calls without executing them.
`ToolPort` must accept and honour an `AbortSignal`; any implementation that spawns a child process
must terminate it on abort (no zombie processes). Real tool execution is explicitly OUT OF SCOPE for
this ADR and issue #4.

**EventSink** — a NEW interface the harness emits structured events to. Issue #10 (audit) and
issue #13 (UI) each plug in their own `EventSink` implementation. Wave 1 ships: the `EventSink`
interface, a collecting in-memory sink for tests, and a CLI text renderer.

We chose a **callback-style EventSink** (`emit(event: HarnessEvent): void`) over async-iterable or
Node `EventEmitter`. See Alternatives Considered for the full analysis. The upgrade path to
async-iterable is non-breaking: the `EventSink` interface is the only caller-visible surface.

**Clock** — reuse the `Clock` interface from `src/gateway/types.ts` (ADR-0003, D6). Inject via
`HarnessDeps`. No new clock type.

**IdSource / Fingerprinter** — a NEW port for generating run IDs and config fingerprints
deterministically. In production: `randomUUID()` for run IDs, SHA-256 over canonical JSON for
fingerprints (both from `node:crypto`). In tests: a counter-based or literal ID source so run IDs
are fixed across test runs.

### D3 — Configurable safety limits enforce bounds on every dimension of a run

We will define `HarnessLimits` as a configuration object with explicit defaults. Each limit produces
a typed `LimitExceededFailure` with a stable `category` string discriminant when breached, causing a
transition to the `limit-exceeded` terminal state. The harness checks limits at the top of the loop
before entering any state that could consume the bounded resource.

Limits and where they are enforced:

| Limit | Default | Enforcement point |
|---|---|---|
| `maxIterations` | 10 | Top of loop, before `planning` |
| `maxModelCalls` | 20 | Before `model-call` state entry |
| `maxToolCalls` | 30 | Before `tool-call` state entry |
| `maxCommandExecutions` | 10 | Before `tool-call` state entry, tool kind `command` |
| `maxContextBytes` | 512_000 | Before `model-call`, after context assembly |
| `maxPatchBytes` | 65_536 | At `patch-proposal`, before emitting event |
| `maxWallTimeMs` | 300_000 | Top of loop, using `clock.now()` |
| `maxFailureAttempts` | 3 | On any non-terminal failure before retry |

`maxContextBytes` is measured in UTF-8 bytes of the serialised message array, not tokens. Tokens are
model-specific and require a tokeniser; UTF-8 bytes are a zero-dependency proxy. The limit is
intentionally conservative (default 512 KB ≈ ~128 K chars) to stay well within any model's context
window.

### D4 — Single AbortController per run; documented cancellation bound

Each run receives a single `AbortController` created at run start. The `AbortSignal` is passed to
`ModelPort.call()` and `ToolPort.execute()` on every invocation. The cancellation bound is:

> **Abort takes effect before the next state transition, model call, or tool call, whichever comes
> first.** The harness checks `signal.aborted` at the top of the main loop and before each port
> call. When abort is detected, the harness transitions to `cancelled` terminal state, emits a
> `run:cancelled` event, and returns. No further model or tool calls are made. The harness never
> writes a partial patch to any output; patch state is accumulated in memory and is abandoned on
> cancellation.

The public `cancel()` method on the session object calls `controller.abort(reason)`. The `reason`
is included in the `run:cancelled` event for audit.

### D5 — Versioned discriminated-union event stream as the harness's primary output

We will define `HarnessEvent` as a versioned discriminated union with a `schemaVersion: '1'`
literal and a stable `type` string discriminant on every variant. The event stream is the harness's
primary output — CLI rendering, audit persistence, and UI display all consume events; none of them
re-parse terminal output.

Variants (see Implementation Plan for full TypeScript types):

| Event type | When emitted |
|---|---|
| `run:started` | Immediately after the run begins, before any state entry |
| `state:transition` | Before every state change (from-state, to-state, reason) |
| `model:call:started` | Before the ModelPort call |
| `model:call:completed` | After the ModelPort call returns (includes usage metadata) |
| `model:call:failed` | After the ModelPort call throws |
| `tool:call:started` | Before each ToolPort execute() |
| `tool:call:completed` | After ToolPort execute() returns |
| `tool:call:failed` | After ToolPort execute() throws |
| `reasoning:trace` | Harness rationale for a decision (redaction-flagged) |
| `patch:proposed` | When a patch diff is assembled (includes diff, redaction-flagged) |
| `verification:result` | After the verification state completes |
| `run:completed` | On terminal `completed` state |
| `run:cancelled` | On terminal `cancelled` state |
| `run:failed` | On terminal `failed` or `limit-exceeded` state |

### D6 — Reasoning-trace events carry redaction-aware fields

We will emit a `reasoning:trace` event at each harness decision point where model rationale or
task-specific content is captured. Fields that may carry sensitive content are flagged with a
documentation comment `// SENSITIVE: pass through redact() before persisting`. The harness calls
`redact()` from `src/gateway/redaction.ts` on these fields before emitting the event to any sink
that is not the in-memory test collector. The audit ledger (#10) may apply additional redaction
before persistence.

Sensitive fields: `reasoning:trace.rationale`, `reasoning:trace.modelResponse`,
`patch:proposed.diff`, `model:call:started.messages` (content only), `run:failed.detail`.

### D7 — Deterministic run-ID scheme and canonical configuration fingerprint

**Run ID**: generated by an injectable `IdSource` (default: `randomUUID()` from `node:crypto`). In
tests, `IdSource` is replaced by a deterministic counter or literal function so IDs are fixed across
test runs and reproducible for replay.

**Configuration fingerprint**: SHA-256 (hex digest) over the UTF-8 encoding of a canonical,
key-sorted JSON object containing: `taskType`, `taskInput` (sanitized — secrets excluded), `limits`
(fully resolved including defaults), `modelId`, and `harnessVersion`. The fingerprint is computed at
run start and attached to every `HarnessEvent`. Two runs with the same fingerprint used the same
effective configuration.

**Replay/evidence manifest** (the minimal record the audit ledger needs to re-run under the same
model/config): `runId`, `fingerprint`, `harnessVersion`, `taskType`, `taskInput`, `limits`,
`modelId`, `startedAt` (wall-clock ISO-8601), `events` (the full ordered event array). This is
the `RunManifest` type. Issue #10 persists this; the harness produces it via `collectManifest()` on
the in-memory sink.

### D8 — Three bounded Wave-1 task types with explicit state paths

We will implement exactly three task types in Wave 1. Each task type has a typed input and a bounded
state path through the state machine.

**`generate-unit-tests`**:
- Input: `{ filePath: string; targetFunction?: string | undefined; context?: string | undefined }`
- State path: `intake → planning → context-selection → model-call → patch-proposal → verification → reporting → completed`
- May loop back from `verification` to `model-call` (up to `maxFailureAttempts` times) if
  verification fails.
- May reach `patch-proposal`; the harness NEVER applies the patch. The diff is proposed in an event
  and returned in the session result. Apply mode is OFF by default; the CLI dry-run never writes to
  the repository.

**`investigate-bug`**:
- Input: `{ description: string; filePaths?: readonly string[] | undefined; context?: string | undefined }`
- State path: `intake → planning → context-selection → model-call [→ tool-call]* → patch-proposal → verification → reporting → completed`
- Tool calls are optional: the model may propose a patch directly or may request tool invocations.
- Patch is proposed, not applied.

**`explain-plan`**:
- Input: `{ filePath: string; question?: string | undefined }`
- State path: `intake → planning → context-selection → model-call → reporting → completed`
- Inherently read-only: `patch-proposal`, `tool-call`, and `verification` states are NEVER entered.
  `ToolPort` is not called. The harness enforces this by task-type routing in the loop, not by
  configuration.

### D9 — Typed session API on both CLI and SDK surfaces

The session/run API is the public surface callers use to start a bounded task and observe events:

```typescript
// Expanded AgentConfig (in src/sdk/index.ts):
interface AgentConfig {
  readonly model: string;
  readonly workingDirectory: string;
  readonly limits?: Partial<HarnessLimits> | undefined;
  readonly dryRun?: boolean | undefined;        // default true; patch is never auto-applied
}

// Session object returned by runAgent():
interface AgentSession {
  readonly runId: string;
  readonly fingerprint: string;
  readonly result: Promise<RunResult>;
  readonly cancel: (reason?: string) => void;
}
```

The CLI exposes a `keiko run` command (dispatched from `runCli`) that accepts a task type and
required args, wires mocked model/tool fixtures for the dry-run path, and renders events to
`CliIo`. The dry-run path never writes to the repository.

### D10 — Typed error taxonomy mirrors ADR-0003; machine-readable failure categories

The harness defines its own error taxonomy extending the gateway's pattern. Harness errors have
stable `code` string constants (callers switch on `code`, never parse `message`). Messages are safe
to log via `redact()`.

Harness-level failure categories (in `HarnessFailure.category`):

| Category | When produced |
|---|---|
| `HARNESS_LIMIT_ITERATIONS` | `maxIterations` exceeded |
| `HARNESS_LIMIT_MODEL_CALLS` | `maxModelCalls` exceeded |
| `HARNESS_LIMIT_TOOL_CALLS` | `maxToolCalls` exceeded |
| `HARNESS_LIMIT_COMMAND_EXECUTIONS` | `maxCommandExecutions` exceeded |
| `HARNESS_LIMIT_CONTEXT_SIZE` | `maxContextBytes` exceeded |
| `HARNESS_LIMIT_PATCH_SIZE` | `maxPatchBytes` exceeded |
| `HARNESS_LIMIT_WALL_TIME` | `maxWallTimeMs` exceeded |
| `HARNESS_LIMIT_FAILURE_ATTEMPTS` | `maxFailureAttempts` exceeded |
| `HARNESS_MODEL_ERROR` | Non-retryable gateway error |
| `HARNESS_TOOL_ERROR` | Non-retryable tool error |
| `HARNESS_INTERNAL` | Unexpected harness-internal error |

## Consequences

### Positive

- The state machine is the authoritative contract: a new engineer reads the state-transition table
  and knows exactly what the harness can and cannot do. No implicit "it just calls the model until
  it stops" behaviour.
- Hexagonal ports mean issues #6, #10, and #13 can be implemented and tested entirely against the
  typed interfaces without touching the harness. The harness never changes because a downstream
  issue was implemented.
- The versioned event stream (`schemaVersion: '1'`) is a stability guarantee: issue #10 can write
  an audit persister today and the schema will not silently change under it. Breaking changes
  require a new schema version.
- Cancellation propagates to both ModelPort and ToolPort via `AbortSignal`; no zombie processes are
  possible if ToolPort implementors honour the contract (enforced by the interface and documented).
- Deterministic run IDs and fingerprints enable exact replay in CI and post-incident investigation.
- Injectable `Clock` and `IdSource` make every test deterministic without `vi.useFakeTimers` or
  real network calls.
- Patch-never-applied-by-default is enforced at the harness level, not by configuration. The
  `explain-plan` task type cannot reach `patch-proposal` by construction. For other task types,
  the patch is emitted as an event and returned in the result; nothing writes to disk in Wave 1.

### Negative

- The callback-style `EventSink` has no backpressure mechanism. If a consumer is slow (e.g., a UI
  that blocks in the `emit` callback), events accumulate in the synchronous call stack. For Wave 1's
  use cases (CLI renderer, in-memory test collector), this is not a problem. A high-throughput or
  network-backed sink would require async-iterable; see Alternatives Considered.
- The named state machine adds a modest upfront implementation cost vs. a simple `while` loop.
  This cost is paid once and recovered on every downstream issue that benefits from the explicit
  state contract.
- `maxContextBytes` (UTF-8 bytes) is a coarse token proxy. A 512 KB context limit may still
  overflow some models if they use a multi-byte vocabulary. The limit is conservative by design;
  a future tokeniser port can refine it without changing the limit interface.
- The `reasoning:trace` event carries model responses that may be verbose. In-memory sinks for
  tests will hold the full text. Operators must size their audit storage accordingly; the ADR flags
  which fields are SENSITIVE.
- Three task types only. Customers who expect a fully autonomous agent will be disappointed by
  the bounded scope. This is a feature, not a bug: bounded tasks are auditable; unbounded agents
  are not.

### Neutral

- The harness is implemented under `src/harness/**` across ~12 files to respect the LOC limit.
  This increases file count but keeps each file under 400 LOC with a single responsibility.
- The `explain-plan` task type shares the same event schema and state machine infrastructure as
  patching tasks, even though it uses only a subset of states. This is acceptable: the shared
  infrastructure is not wasteful, and uniform event schemas simplify consumers.
- `AgentConfig.dryRun` defaults to `true` in Wave 1. A future issue can set it to `false` and
  add the apply-mode path without changing the harness API.

## Alternatives Considered

### Alternative 1: Model-driven control flow (model response decides next action)

In this approach, the model's response text or structured output specifies the next action
("call tool X", "generate patch", "done"). The harness is a thin dispatcher that parses model
output and routes to functions.

- **Pros**: simpler harness implementation; follows the "ReAct" and function-calling patterns used
  by many open-source agent frameworks (LangChain, AutoGPT, CrewAI). Familiar to engineers who
  have read those codebases.
- **Cons**: control flow correctness now depends on model output quality. A single hallucinated
  action name or malformed JSON from the model can put the system in an unspecified state. In a
  regulated environment, "the model told it to do that" is not an acceptable audit trail. Limit
  enforcement becomes ad-hoc: the model can bypass a loop limit by generating output that the
  harness interprets as "skip the check". Tests require mocking a model that produces syntactically
  and semantically correct control-flow instructions — a fragile dependency.
- **Why rejected**: contradicts the fundamental requirement that "the harness — not model output —
  owns control flow". Model-driven dispatch is appropriate for exploratory chatbots; it is
  incompatible with regulated, evidence-backed delivery. The state machine approach costs more
  upfront but is the only design that satisfies the auditability requirement.

### Alternative 2: Async-iterable EventSink instead of callback

In this approach, `HarnessRun.events()` returns an `AsyncIterable<HarnessEvent>`. The harness
pushes events into a queue and the consumer pulls. This provides natural backpressure: if the
consumer is slow, the queue grows and the harness waits.

- **Pros**: standard Node.js pattern for streaming data; composable with `for await...of`; supports
  backpressure without external libraries; plays well with the `ReadableStream` Web Streams API.
- **Cons**: async-iterable push-from-producer requires a hand-rolled async queue with signal
  semantics (a "readable stream with manual push"). Implementing this correctly in TypeScript
  without a library is ~80–100 LOC of non-trivial plumbing (concurrent readers, done/error
  signalling). For Wave 1, the consumers are: (a) in-memory test collector — synchronous and
  always faster than the producer; (b) CLI renderer — writes to stdout, which is synchronous.
  Backpressure is not a real problem at Wave 1's scale. The callback interface is simpler and can
  be wrapped in an async-iterable adapter by a consumer if needed.
- **Why rejected**: YAGNI for Wave 1. The async-iterable upgrade path is non-breaking: issue #13
  can add an `AsyncIterableEventSink` adapter that implements `EventSink` internally, without
  changing the harness. Deferred until a measured need (e.g., a network-backed UI sink) exists.

### Alternative 3: Node.js EventEmitter for event delivery

Use the built-in `node:events` `EventEmitter` (or a `typed-event-emitter` pattern) to emit named
events. The harness inherits from or composes an `EventEmitter`.

- **Pros**: built into Node.js; no interface definition needed; familiar to Node developers;
  supports multiple listeners per event type.
- **Cons**: `EventEmitter` is untyped by default. TypeScript wrappers for typed emitters are
  verbose boilerplate. More critically: `EventEmitter` leaks the emitter as a public API surface,
  making it impossible to replace the emission mechanism later. An `EventSink` interface is
  easier to mock in tests (a simple object with an `emit` function) vs. a real `EventEmitter`
  with `on`/`off` lifecycle. `EventEmitter` also encourages multiple consumers that each register
  listeners; this creates ordering and lifecycle complexity the harness does not need.
- **Why rejected**: the typed `EventSink` interface is simpler to mock, easier to test, and easier
  to replace. `EventEmitter` is not a bad choice for general event multiplexing; it is the wrong
  abstraction for a single-producer, structured-event pipeline that must be testable without
  `EventEmitter` listener teardown.

### Alternative 4: Single monolithic harness file with inline state transitions

Implement the harness as one file with a `while` loop, inline `if`/`switch` for state transitions,
and inline event emission. No separate port interfaces; the gateway and tools are called directly.

- **Pros**: minimum file count; easiest to read in one sitting; no indirection; straightforward to
  implement quickly.
- **Cons**: a single-file harness that handles all task types, all limits, all port integrations,
  all event emission, and all state transitions would be 600–900 LOC — violating the ≤400 LOC
  limit (ADR-0001). Inline tool calls and model calls make tests require mocking at the module
  level (brittle, order-dependent). The port interfaces exist exactly so tests can inject fakes
  without module-level mocking.
- **Why rejected**: violates ADR-0001 LOC limits by construction. Also makes issues #6, #10, and
  #13 impossible to implement without modifying the harness, which is the opposite of the
  stability goal.

### Alternative 5: XState or a state-machine library for the loop

Use a state-machine library (XState v5, robot3, etc.) to define and run the state machine.

- **Pros**: formal state machine with guards, actions, and services; built-in visualization;
  type-safe transitions out of the box.
- **Cons**: runtime npm dependency. ADR-0001's zero-dependency constraint is non-negotiable.
  XState v5 alone is ~45 KB minified; it also introduces a programming model that every team
  member must learn before modifying harness code. The harness's state machine has ~12 states
  and ~25 transitions — well within the complexity range where a hand-rolled switch is clear
  and manageable.
- **Why rejected**: runtime npm dependency is forbidden by ADR-0001. Even if the constraint were
  relaxed, the hand-rolled state machine is adequate for this scope and introduces no new concepts.

## Implementation Plan

This section doubles as the spec a `developer` agent builds from directly.

### File map

```
src/harness/
  index.ts              # Barrel: re-exports all public types and createSession()          ~60 LOC
  types.ts              # All harness interfaces, states, events, limits, task types       ~350 LOC
  errors.ts             # HarnessError subclasses, HARNESS_CODES, failure categories       ~120 LOC
  loop.ts               # Main run loop: state machine driver, limit checks, abort checks  ~250 LOC
  planner.ts            # planning + context-selection state handlers                      ~120 LOC
  executor.ts           # model-call + tool-call state handlers                            ~180 LOC
  patcher.ts            # patch-proposal + verification + reporting state handlers         ~140 LOC
  ports.ts              # ModelPort, ToolPort, EventSink, IdSource interfaces               ~80 LOC
  adapters.ts           # GatewayModelPort adapter (wraps Gateway), DryRunToolPort         ~150 LOC
  sinks.ts              # MemoryEventSink (tests), CliEventSink (CLI renderer)             ~120 LOC
  session.ts            # AgentSession implementation, createSession() factory             ~180 LOC
  fingerprint.ts        # configFingerprint() and canonicalise() using node:crypto         ~80 LOC
  tasks/
    generate-unit-tests.ts  # Task input type, state-path validator, plan builder         ~100 LOC
    investigate-bug.ts      # Task input type, state-path validator, plan builder         ~100 LOC
    explain-plan.ts         # Task input type, state-path validator (read-only enforcer)  ~80 LOC

src/sdk/index.ts        # Expand AgentConfig; re-export AgentSession, RunResult, runAgent ~80 LOC
src/cli/runner.ts       # Add 'run' dispatch branch alongside 'models'                   (extend)
src/cli/run.ts          # runAgentCli(): parse args, build session, render events         ~180 LOC
src/index.ts            # Re-export harness public surface alongside gateway surface      (extend)

tests/harness/
  loop.test.ts          # Normal flow to completed; all limit breaches; cancellation      ~250 LOC
  adapters.test.ts      # GatewayModelPort wires AbortSignal; DryRunToolPort records      ~120 LOC
  sinks.test.ts         # MemoryEventSink collects in order; CliEventSink writes to io    ~100 LOC
  session.test.ts       # createSession API; cancel() propagates; result Promise resolves ~150 LOC
  fingerprint.test.ts   # Same config → same fingerprint; key order irrelevant; IdSource  ~80 LOC
  tasks/
    generate-unit-tests.test.ts   # Full state path; patch proposed, not applied         ~120 LOC
    investigate-bug.test.ts       # Tool-call loop; patch proposed; loop bound            ~120 LOC
    explain-plan.test.ts          # Read-only enforcement; no patch event emitted         ~80 LOC
  cli-run.test.ts       # Dry-run path; no repo writes; events rendered to CliIo         ~120 LOC
  reasoning-trace.test.ts         # Trace events emitted; sensitive fields redacted      ~80 LOC
```

LOC budgets respect ≤ 400 LOC per file. The largest file (`types.ts` at ~350 LOC) is pure type
declarations with no runtime code, consistent with the ADR-0003 precedent for `types.ts`.

### Key TypeScript interfaces

All harness interfaces live in `src/harness/types.ts` and `src/harness/ports.ts`. Relative imports
within `src/harness/*.ts` use `.js` extensions. Type-only imports use `import type`.

```typescript
// ─── State machine ────────────────────────────────────────────────────────────

export type HarnessStateName =
  | 'intake'
  | 'planning'
  | 'context-selection'
  | 'model-call'
  | 'tool-call'
  | 'patch-proposal'
  | 'verification'
  | 'reporting'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'limit-exceeded';

export type TerminalState = 'completed' | 'cancelled' | 'failed' | 'limit-exceeded';

export const TERMINAL_STATES: ReadonlySet<HarnessStateName> = new Set<HarnessStateName>([
  'completed', 'cancelled', 'failed', 'limit-exceeded',
]);

export interface StateTransition {
  readonly from: HarnessStateName;
  readonly to: HarnessStateName;
  readonly reason: string;
}

// ─── Safety limits ────────────────────────────────────────────────────────────

export interface HarnessLimits {
  readonly maxIterations: number;            // default: 10
  readonly maxModelCalls: number;            // default: 20
  readonly maxToolCalls: number;             // default: 30
  readonly maxCommandExecutions: number;     // default: 10
  readonly maxContextBytes: number;          // default: 512_000
  readonly maxPatchBytes: number;            // default: 65_536
  readonly maxWallTimeMs: number;            // default: 300_000
  readonly maxFailureAttempts: number;       // default: 3
}

export const DEFAULT_LIMITS: HarnessLimits = {
  maxIterations: 10,
  maxModelCalls: 20,
  maxToolCalls: 30,
  maxCommandExecutions: 10,
  maxContextBytes: 512_000,
  maxPatchBytes: 65_536,
  maxWallTimeMs: 300_000,
  maxFailureAttempts: 3,
} as const;

// ─── Task types ───────────────────────────────────────────────────────────────

export type TaskType =
  | 'generate-unit-tests'
  | 'investigate-bug'
  | 'explain-plan';

export interface GenerateUnitTestsInput {
  readonly filePath: string;
  readonly targetFunction?: string | undefined;
  readonly context?: string | undefined;
}

export interface InvestigateBugInput {
  readonly description: string;
  readonly filePaths?: readonly string[] | undefined;
  readonly context?: string | undefined;
}

export interface ExplainPlanInput {
  readonly filePath: string;
  readonly question?: string | undefined;
}

export type TaskInput =
  | { readonly taskType: 'generate-unit-tests'; readonly input: GenerateUnitTestsInput }
  | { readonly taskType: 'investigate-bug'; readonly input: InvestigateBugInput }
  | { readonly taskType: 'explain-plan'; readonly input: ExplainPlanInput };

// ─── Runtime counters (harness-internal mutable state) ───────────────────────

export interface RunCounters {
  iterations: number;
  modelCalls: number;
  toolCalls: number;
  commandExecutions: number;
  failureAttempts: number;
}

// ─── Run result ───────────────────────────────────────────────────────────────

export type RunOutcome = 'completed' | 'cancelled' | 'failed' | 'limit-exceeded';

export interface RunResult {
  readonly runId: string;
  readonly fingerprint: string;
  readonly outcome: RunOutcome;
  readonly taskType: TaskType;
  readonly report?: string | undefined;         // present when outcome === 'completed'
  readonly patchDiff?: string | undefined;      // present when a patch was proposed
  readonly failure?: HarnessFailure | undefined; // present when outcome !== 'completed'
  readonly startedAt: number;                   // clock.now() at run start
  readonly finishedAt: number;                  // clock.now() at terminal state
  readonly events: readonly HarnessEvent[];     // full ordered event array (the manifest)
}

// ─── Replay manifest (consumed by audit ledger, issue #10) ───────────────────

export interface RunManifest {
  readonly runId: string;
  readonly fingerprint: string;
  readonly harnessVersion: string;
  readonly taskType: TaskType;
  readonly taskInput: TaskInput;
  readonly limits: HarnessLimits;
  readonly modelId: string;
  readonly startedAt: string;   // ISO-8601 wall-clock
  readonly events: readonly HarnessEvent[];
}

// ─── Failure taxonomy ─────────────────────────────────────────────────────────

export const HARNESS_CODES = {
  LIMIT_ITERATIONS:        'HARNESS_LIMIT_ITERATIONS',
  LIMIT_MODEL_CALLS:       'HARNESS_LIMIT_MODEL_CALLS',
  LIMIT_TOOL_CALLS:        'HARNESS_LIMIT_TOOL_CALLS',
  LIMIT_COMMAND_EXEC:      'HARNESS_LIMIT_COMMAND_EXECUTIONS',
  LIMIT_CONTEXT_SIZE:      'HARNESS_LIMIT_CONTEXT_SIZE',
  LIMIT_PATCH_SIZE:        'HARNESS_LIMIT_PATCH_SIZE',
  LIMIT_WALL_TIME:         'HARNESS_LIMIT_WALL_TIME',
  LIMIT_FAILURE_ATTEMPTS:  'HARNESS_LIMIT_FAILURE_ATTEMPTS',
  MODEL_ERROR:             'HARNESS_MODEL_ERROR',
  TOOL_ERROR:              'HARNESS_TOOL_ERROR',
  INTERNAL:                'HARNESS_INTERNAL',
} as const;

export type HarnessCode = (typeof HARNESS_CODES)[keyof typeof HARNESS_CODES];

export interface HarnessFailure {
  readonly category: HarnessCode;
  readonly message: string;    // safe to log; no secrets; call redact() at construction
  readonly detail?: string | undefined;  // SENSITIVE: redact() before persisting
}

// ─── Structured event stream (versioned discriminated union) ──────────────────

// schemaVersion is a literal '1'. A breaking schema change produces schemaVersion '2'
// as a new union member; consumers narrow on schemaVersion before narrowing on type.

interface BaseEvent {
  readonly schemaVersion: '1';
  readonly runId: string;
  readonly fingerprint: string;
  readonly seq: number;          // monotonically increasing within a run; starts at 1
  readonly ts: number;           // clock.now() at emission
}

export interface RunStartedEvent extends BaseEvent {
  readonly type: 'run:started';
  readonly taskType: TaskType;
  readonly modelId: string;
  readonly limits: HarnessLimits;
}

export interface StateTransitionEvent extends BaseEvent {
  readonly type: 'state:transition';
  readonly from: HarnessStateName;
  readonly to: HarnessStateName;
  readonly reason: string;
}

export interface ModelCallStartedEvent extends BaseEvent {
  readonly type: 'model:call:started';
  readonly modelId: string;
  readonly messageCount: number;
  // SENSITIVE: messages[*].content may carry task context — redact() before persisting
  readonly contextBytes: number;  // UTF-8 byte count of serialised messages
}

export interface ModelCallCompletedEvent extends BaseEvent {
  readonly type: 'model:call:completed';
  readonly modelId: string;
  readonly finishReason: string;
  readonly toolCallCount: number;
  readonly usage: {
    readonly requestId: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly latencyMs: number;
  };
}

export interface ModelCallFailedEvent extends BaseEvent {
  readonly type: 'model:call:failed';
  readonly modelId: string;
  readonly errorCode: string;
  readonly message: string;   // redacted before construction
}

export interface ToolCallStartedEvent extends BaseEvent {
  readonly type: 'tool:call:started';
  readonly toolName: string;
  readonly toolCallId: string;
  // SENSITIVE: args may carry file paths or content — redact() before persisting
}

export interface ToolCallCompletedEvent extends BaseEvent {
  readonly type: 'tool:call:completed';
  readonly toolName: string;
  readonly toolCallId: string;
  readonly durationMs: number;
}

export interface ToolCallFailedEvent extends BaseEvent {
  readonly type: 'tool:call:failed';
  readonly toolName: string;
  readonly toolCallId: string;
  readonly errorCode: string;
  readonly message: string;   // redacted before construction
}

export interface ReasoningTraceEvent extends BaseEvent {
  readonly type: 'reasoning:trace';
  readonly phase: HarnessStateName;
  // SENSITIVE: rationale and modelResponse carry model output — redact() before persisting
  readonly rationale: string;
  readonly modelResponse?: string | undefined;
}

export interface PatchProposedEvent extends BaseEvent {
  readonly type: 'patch:proposed';
  readonly targetFile: string;
  readonly patchBytes: number;
  // SENSITIVE: diff carries source code — redact() before persisting
  readonly diff: string;
}

export interface VerificationResultEvent extends BaseEvent {
  readonly type: 'verification:result';
  readonly passed: boolean;
  readonly detail: string;
}

export interface RunCompletedEvent extends BaseEvent {
  readonly type: 'run:completed';
  readonly report: string;
  readonly patchDiff?: string | undefined;
}

export interface RunCancelledEvent extends BaseEvent {
  readonly type: 'run:cancelled';
  readonly reason?: string | undefined;
  readonly atState: HarnessStateName;
}

export interface RunFailedEvent extends BaseEvent {
  readonly type: 'run:failed';
  readonly failure: HarnessFailure;
  readonly atState: HarnessStateName;
  // SENSITIVE: detail may carry task context — redact() before persisting
}

export type HarnessEvent =
  | RunStartedEvent
  | StateTransitionEvent
  | ModelCallStartedEvent
  | ModelCallCompletedEvent
  | ModelCallFailedEvent
  | ToolCallStartedEvent
  | ToolCallCompletedEvent
  | ToolCallFailedEvent
  | ReasoningTraceEvent
  | PatchProposedEvent
  | VerificationResultEvent
  | RunCompletedEvent
  | RunCancelledEvent
  | RunFailedEvent;

// ─── Ports (in src/harness/ports.ts) ─────────────────────────────────────────

import type { GatewayRequest, NormalizedResponse, ChatMessage } from '../gateway/types.js';

export interface ModelPort {
  readonly call: (
    request: GatewayRequest,
    signal: AbortSignal,
  ) => Promise<NormalizedResponse>;
}

export interface ToolCallRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly signal: AbortSignal;    // MUST be honoured; abort = terminate any subprocess
}

export interface ToolCallResult {
  readonly toolCallId: string;
  readonly output: string;
  readonly durationMs: number;
}

export interface ToolPort {
  readonly execute: (request: ToolCallRequest) => Promise<ToolCallResult>;
  readonly listTools: () => readonly import('../gateway/types.js').ToolDefinition[];
}

export interface EventSink {
  readonly emit: (event: HarnessEvent) => void;
}

export interface IdSource {
  readonly newRunId: () => string;
}

export interface Fingerprinter {
  readonly compute: (input: FingerprintInput) => string;
}

export interface FingerprintInput {
  readonly taskType: TaskType;
  readonly taskInput: TaskInput;
  readonly limits: HarnessLimits;
  readonly modelId: string;
  readonly harnessVersion: string;
}

// ─── Session / run API (in src/harness/session.ts, re-exported from src/sdk/) ─

export interface HarnessDeps {
  readonly model: ModelPort;
  readonly tools: ToolPort;
  readonly sink: EventSink;
  readonly clock?: Clock | undefined;            // default: systemClock from gateway
  readonly idSource?: IdSource | undefined;      // default: randomUUID-based
  readonly fingerprinter?: Fingerprinter | undefined;  // default: SHA-256 over canonical JSON
}

export interface AgentSession {
  readonly runId: string;
  readonly fingerprint: string;
  readonly result: Promise<RunResult>;
  readonly cancel: (reason?: string) => void;
}

export function createSession(
  task: TaskInput,
  config: AgentConfig,
  deps: HarnessDeps,
): AgentSession { /* ... implemented in session.ts ... */ }
```

Note: `createSession` is declared here as a signature for documentation; the implementation lives
in `src/harness/session.ts`. The `import type { Clock }` comes from `'../gateway/types.js'`.

### State-transition table

The table shows every valid transition. "Trigger" is the harness-internal condition, not model
output. Limit checks apply at every "top of loop" entry to `planning`. Abort checks apply before
every state entry and before every port call.

| From state | Trigger | To state |
|---|---|---|
| _(initial)_ | `createSession()` called | `intake` |
| `intake` | task validated | `planning` |
| `intake` | task validation fails | `failed` |
| `planning` | plan constructed | `context-selection` |
| `planning` | limit: `maxIterations` exceeded | `limit-exceeded` |
| `planning` | limit: `maxWallTimeMs` exceeded | `limit-exceeded` |
| `planning` | `signal.aborted` | `cancelled` |
| `context-selection` | context assembled, bytes ok | `model-call` |
| `context-selection` | limit: `maxContextBytes` exceeded | `limit-exceeded` |
| `context-selection` | `signal.aborted` | `cancelled` |
| `model-call` | limit: `maxModelCalls` exceeded | `limit-exceeded` |
| `model-call` | `signal.aborted` (pre-call check) | `cancelled` |
| `model-call` | ModelPort returns `finishReason: 'stop'`, no tools | `patch-proposal` (if task allows) or `reporting` |
| `model-call` | ModelPort returns `finishReason: 'tool_calls'` | `tool-call` |
| `model-call` | ModelPort throws non-retryable GatewayError | `failed` |
| `model-call` | ModelPort throws, `failureAttempts` < max | `planning` (retry loop) |
| `model-call` | ModelPort throws, `failureAttempts` >= max | `limit-exceeded` |
| `model-call` | `signal.aborted` (post-call check) | `cancelled` |
| `tool-call` | limit: `maxToolCalls` exceeded | `limit-exceeded` |
| `tool-call` | limit: `maxCommandExecutions` exceeded (tool kind: command) | `limit-exceeded` |
| `tool-call` | `signal.aborted` (pre-call check) | `cancelled` |
| `tool-call` | all tool calls in batch completed | `model-call` (feed results back) |
| `tool-call` | ToolPort throws, task continues | `model-call` (error result fed back) |
| `tool-call` | ToolPort throws, non-recoverable | `failed` |
| `patch-proposal` | limit: `maxPatchBytes` exceeded | `limit-exceeded` |
| `patch-proposal` | patch assembled and emitted | `verification` |
| `patch-proposal` | `signal.aborted` | `cancelled` |
| `verification` | verification passes | `reporting` |
| `verification` | verification fails, `failureAttempts` < max | `planning` (re-plan) |
| `verification` | verification fails, `failureAttempts` >= max | `limit-exceeded` |
| `verification` | `signal.aborted` | `cancelled` |
| `reporting` | report generated and emitted | `completed` |
| `completed` | _(terminal)_ | — |
| `cancelled` | _(terminal)_ | — |
| `failed` | _(terminal)_ | — |
| `limit-exceeded` | _(terminal)_ | — |

Additional constraint: for `explain-plan` task type, the harness NEVER transitions to
`tool-call`, `patch-proposal`, or `verification`. Any model response with `finishReason: 'tool_calls'`
is treated as a harness internal error (`HARNESS_INTERNAL`) for this task type.

### Test behaviour matrix

All tests use injected fakes (no real Gateway, no real tools, no network I/O, no real timers). The
`MemoryEventSink` collects events in order for assertion. `IdSource` is a counter-based stub.

| Test file | Required behaviours |
|---|---|
| `loop.test.ts` | Normal `explain-plan` flow: `intake → planning → context-selection → model-call → reporting → completed`; `run:completed` event emitted last; `RunResult.outcome === 'completed'`; `maxIterations` exceeded: transitions to `limit-exceeded`, failure `category === 'HARNESS_LIMIT_ITERATIONS'`; `maxModelCalls` exceeded: `HARNESS_LIMIT_MODEL_CALLS`; `maxToolCalls` exceeded: `HARNESS_LIMIT_TOOL_CALLS`; `maxContextBytes` exceeded: `HARNESS_LIMIT_CONTEXT_SIZE`; `maxWallTimeMs` exceeded (stub clock returns time past limit): `HARNESS_LIMIT_WALL_TIME`; `maxPatchBytes` exceeded: `HARNESS_LIMIT_PATCH_SIZE`; `maxFailureAttempts` exceeded on model failure: `HARNESS_LIMIT_FAILURE_ATTEMPTS` |
| `adapters.test.ts` | `GatewayModelPort.call()` passes `signal` as `GatewayRequest.cancellationSignal`; aborted signal before call: `CancelledError` propagated; `DryRunToolPort.execute()` records the call without executing; `DryRunToolPort.listTools()` returns the registered list |
| `sinks.test.ts` | `MemoryEventSink.emit()` appends to internal array; `MemoryEventSink.events()` returns in emission order; `CliEventSink.emit()` writes a non-empty line to `CliIo.out()` for each event; `CliEventSink` does not write sensitive fields verbatim for `reasoning:trace` and `patch:proposed` events |
| `session.test.ts` | `createSession()` returns an `AgentSession` with non-empty `runId` and `fingerprint`; `result` Promise resolves to `RunResult`; `cancel()` before run start: `RunResult.outcome === 'cancelled'`; `cancel()` during model-call wait (stubbed async): subsequent state is `cancelled`, no further model/tool calls; `cancel(reason)` propagates `reason` to `run:cancelled` event |
| `fingerprint.test.ts` | Same `FingerprintInput` → same fingerprint; key order in input object is irrelevant (canonical JSON sorts keys); different `modelId` → different fingerprint; different `limits.maxIterations` → different fingerprint; `IdSource` counter stub: first call returns `'run-1'`, second returns `'run-2'` |
| `generate-unit-tests.test.ts` | Full state path includes `patch-proposal`; `patch:proposed` event emitted before `completed`; `RunResult.patchDiff` is non-empty; patch is not written to disk (no `fs` calls); `verification` state entered and emitted |
| `investigate-bug.test.ts` | Tool-call loop: mocked model returns `finishReason: 'tool_calls'`, DryRunToolPort records the call, model returns `stop` on second call; loop respects `maxToolCalls`; `tool:call:started` and `tool:call:completed` events emitted; patch proposed, not applied |
| `explain-plan.test.ts` | State path never includes `tool-call`, `patch-proposal`, or `verification`; model response with `finishReason: 'tool_calls'` produces `HARNESS_INTERNAL` failure; `RunResult.patchDiff` is `undefined`; no `ToolPort.execute()` call made |
| `cli-run.test.ts` | `keiko run generate-unit-tests --file src/foo.ts` dispatches through `runAgentCli`; all events rendered to `CliIo.out()` or `CliIo.err()`; no file system writes; exit code `0` on `completed`; exit code `1` on `failed`; exit code `1` on `limit-exceeded` with diagnostic to stderr |
| `reasoning-trace.test.ts` | `reasoning:trace` event emitted at planning phase; `rationale` field is non-empty; `CliEventSink` does not print `rationale` verbatim (prints a summary line); `redact()` called on `rationale` before emitting to non-memory sinks |

## Related

- ADR-0001: Project Foundation and Toolchain (zero-dependency constraint, `src/harness/` reservation,
  strict TypeScript/ESM/LOC limits)
- ADR-0002: CI and Supply-Chain Security Baseline (7 required CI checks, no new runtime deps)
- ADR-0003: Model Gateway Boundary, Capability Registry, and Cost/Timeout Controls (ModelPort
  adapts `Gateway`; `Clock`; `redact()` helper; `GatewayRequest.cancellationSignal`)
- Issue #4: Implement the scoped agent harness for developer-assist tasks
- Issue #6: Tool execution layer (implements `ToolPort` with real file/test/command executors)
- Issue #10: Audit ledger (consumes `EventSink` and persists `RunManifest`)
- Issue #13: Local UI (consumes `EventSink` for live run display)
- Ports and Adapters (Hexagonal Architecture): https://alistair.cockburn.us/hexagonal-architecture/
- ReAct: Synergizing Reasoning and Acting in Language Models (Yao et al., 2022) — the pattern this
  ADR explicitly rejects for control-flow: https://arxiv.org/abs/2210.03629
- WHATWG AbortSignal.any(): https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static

## Date

2026-05-28
