# ADR-0003: Model Gateway Boundary, Capability Registry, and Cost/Timeout Controls

## Status

Accepted

## Context

Keiko must support customer-supplied language models in regulated banking and insurance environments. Wave 1
delivers a model-agnostic gateway that routes requests through a capability registry instead of hard-coding
model names in workflow logic. Three forces make the design non-trivial:

**Supply-chain constraint (load-bearing).** ADR-0001 is an accepted decision: zero runtime dependencies,
enforced by `dependency-review` and SBOM CI gates on every PR. Adding `openai`, `zod`, `axios`, `node-fetch`,
or any other runtime dependency is not a fallback option. All HTTP, validation, and cancellation logic must
use Node 22 built-ins: `globalThis.fetch`, `AbortController`/`AbortSignal`, and hand-rolled schema checks.

**Modality diversity.** The required model list includes chat/coding models, an OCR/vision model (`dotsocr`),
and an embedding model (`multilingual-e5-large Embedding`). A capability registry designed only for chat
completions cannot represent these without hacks. The registry schema must carry a `kind` discriminant.

**Regulated observability.** In banking/insurance, cost and usage data are compliance artefacts, not optional
telemetry. Usage metadata — request ID, prompt tokens, completion tokens, latency, cost class — must appear
on every response. Issue #10's audit ledger will aggregate this; if metadata is ad-hoc or optional, the
ledger cannot be built reliably.

**Module location.** ADR-0001's accepted source layout explicitly reserves `src/gateway/` as the
"Future: model-agnostic LLM gateway" (see ADR-0001, Source Layout table). Issue #3's routing hint names
`src/model-gateway/**` as "Expected write ownership", but that section is explicitly labelled as a
non-binding template hint ("list files/modules ... or say TBD"). Implementing in `src/model-gateway/`
would contradict ADR-0001 and produce a confusing duplicate of the already-reserved `src/gateway/`
directory. This ADR formally resolves the ambiguity in favour of `src/gateway/`, consistent with the
accepted prior decision.

**Secret safety.** Provider API keys must never appear in logs, error messages, `.toString()` output, or
JSON serialization. The model ID, base URL, and any headers carrying credentials must be treated as
secrets from the moment they are read from the environment.

## Decision

### D1 — Module location

We will implement the model gateway entirely within **`src/gateway/`**, consistent with the reserved
directory in ADR-0001. The `src/gateway/index.ts` placeholder is replaced by the full module barrel.
The `src/model-gateway/` directory name referenced in issue #3 is a non-binding routing hint; this ADR
supersedes it. No code is placed in `src/model-gateway/`.

### D2 — Zero-dependency OpenAI-compatible HTTP adapter

We will implement a hand-rolled HTTP adapter using `globalThis.fetch` (available globally in Node 22
without import), `AbortController`/`AbortSignal` for timeout and cancellation, and a hand-written
config validator with actionable error messages. No npm runtime dependency is introduced. The adapter
targets the OpenAI chat-completions API shape (`POST /chat/completions`, `POST /embeddings`) because
all nine required models are served through OpenAI-compatible endpoints. Base URL and API key are
configurable per model so customer-hosted endpoints work without code changes.

### D3 — Capability registry as the single source of truth for routing

We will implement a static capability registry (`src/gateway/capabilities.ts`) that is the only place
model metadata lives. Workflow code selects a model by querying the registry for a model ID or by
requesting "the cheapest model that supports tool calling and structured output for a chat task" — never
by hard-coding a model name. The registry schema carries a `kind` discriminant (`chat | embedding |
ocr-vision`) and capability flags so that non-chat modalities are first-class.

### D4 — Usage metadata as a first-class field on every response

Every `NormalizedResponse` carries a non-optional `usage: UsageMetadata` field. Partial or missing
provider usage data is normalised to zero, never omitted. This makes the audit ledger (issue #10)
buildable without ad-hoc parsing.

### D5 — Typed error taxonomy with stable string code discriminants

We will define a closed set of typed error subclasses, each with a stable string `code` that callers
switch on. Codes never change after acceptance; a new failure mode gets a new code. Errors never embed
raw credentials or provider responses verbatim; they carry a redacted summary.

### D6 — Resilience via injectable clock

Timeout uses `AbortSignal.timeout()` (Node 22 built-in). Retry backoff and circuit-breaker cooldown
use an injectable `Clock` interface (`{ now(): number; sleep(ms: number): Promise<void> }`). In
production the clock delegates to `Date.now()` and `setTimeout`. In tests the clock is replaced by a
deterministic stub — no `vi.useFakeTimers`, no actual delays. This makes resilience tests fast and
mutation-robust.

### D7 — Secret redaction at the boundary

A `redact()` helper in `src/gateway/redaction.ts` strips known secret patterns (API keys, bearer
tokens, header values) from strings before they reach any error message, log call, or serialised
artefact. All error constructors call `redact()` on provider-derived strings. Config serialisation
omits credential fields.

### D8 — CLI surface: `keiko models`

We will add a `models` sub-command to the CLI with two sub-commands: `list` (prints capability
metadata to stdout, no credentials) and `validate` (loads and validates config, reports errors to
stderr). The existing `--help`, `--version`, and unknown-command behaviours are preserved; these paths
are not touched.

## Consequences

### Positive

- Zero new runtime dependencies. `npm audit` on the published package remains empty. Compliance sign-off
  path is unchanged.
- Capability registry as routing source eliminates model-name string literals from workflow code;
  swapping a model does not require touching workflow logic.
- Injectable clock makes resilience tests deterministic and instant; no `setTimeout` races in CI.
- Stable error `code` strings allow callers to handle specific failure modes without parsing messages.
- Usage metadata on every response gives issue #10's audit ledger a reliable, typed aggregation target.
- `src/gateway/` aligns with ADR-0001; no directory drift.

### Negative

- Hand-rolled HTTP adapter does not implement streaming chunked-response processing in Wave 1. The
  `StreamEvent` type and `stream: true` flag are defined in the schema so a future implementor can add
  streaming without breaking the interface, but the Wave 1 adapter blocks until the full response body
  arrives. Callers expecting sub-token streaming latency cannot use Wave 1.
- Hand-rolled config validation produces less ergonomic error messages than a schema library such as
  zod. Tradeoff accepted: zero-dependency constraint is non-negotiable; error message quality is a QoL
  concern addressed by explicit, descriptive `ConfigInvalidError` messages.
- Circuit-breaker state is in-process and per-gateway-instance. In a multi-process or serverless
  deployment each process has independent breaker state. Distributed circuit breaking (e.g., backed by
  a shared store) is out of scope for Wave 1.
- `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` require defensive `?? undefined` patterns
  when reading registry entries; developers unfamiliar with these flags will encounter confusing type
  errors on first contact.

### Neutral

- OCR/vision and embedding models are registered in the same registry as chat models. They are not
  callable through the chat-completions adapter in Wave 1 (`callOcr` and `callEmbedding` are stubbed).
  The registry entry carries `kind: 'embedding'` or `kind: 'ocr-vision'` as a signal that a different
  request path is required; a chat request targeting such a model throws `UnknownModelError` with a
  clear message explaining the kind mismatch.
- All registry values (context window, cost class, etc.) are documented assumptions, not contractual
  guarantees. The registry is editable config; uncertain values are marked `[assumption]` in comments.
  The developer may update them when the customer provides authoritative deployment figures.

## Alternatives Considered

### Alternative 1: Use the official `openai` npm package as the HTTP adapter

- **Pros**: full streaming support; typed request/response out of the box; maintained by OpenAI;
  handles retry and timeout internally.
- **Cons**: adds a runtime dependency (`openai@4.x` has approximately 15 transitive deps). This
  violates ADR-0001's zero-dependency constraint and would trigger the `dependency-review` CI gate,
  blocking merge. Even if the gate were overridden (it cannot be without bypassing branch protection),
  the SBOM diff would require a formal compliance review cycle.
- **Why rejected**: zero-dependency constraint is load-bearing (ADR-0001, Accepted). This alternative
  cannot be chosen without first superseding ADR-0001.

### Alternative 2: Use `node:undici` directly instead of `globalThis.fetch`

- **Pros**: `undici` ships with Node 22 as a built-in (`import { fetch } from 'node:undici'`); exposes
  lower-level streaming APIs and connection pooling that `globalThis.fetch` wraps.
- **Cons**: `node:undici`'s public API surface is larger and less stable across Node minor versions
  than the WHATWG `fetch` global. `globalThis.fetch` in Node 22 delegates to undici internally; there
  is no performance difference for Wave 1's non-streaming use case. Using undici directly couples the
  code to Node-specific internals and makes it harder to follow the WHATWG Fetch spec for future
  portability.
- **Why rejected**: `globalThis.fetch` + `AbortSignal` covers all Wave 1 requirements without coupling
  to an unstable internal API surface. Undici can be revisited if connection pooling or streaming frame
  access becomes a measured requirement.

### Alternative 3: Use `axios` or `node-fetch` as the HTTP adapter

- **Pros**: familiar to most JavaScript developers; axios has a rich interceptor model; node-fetch is
  lightweight.
- **Cons**: both are runtime dependencies. Same rejection reason as Alternative 1. Additionally,
  `node-fetch@3` is ESM-only and its abort-signal integration has historically had edge cases that the
  WHATWG `fetch` built-in handles natively.
- **Why rejected**: runtime dependencies are forbidden by ADR-0001.

### Alternative 4: Hard-code model names in workflow logic (no capability registry)

- **Pros**: simpler implementation; no indirection; easy to understand for a small fixed model set.
- **Cons**: every model swap requires touching workflow code. In a regulated environment, workflow code
  changes require re-review. A registry externalises model selection so the workflow logic is stable
  even when the model list changes. Issue #3 acceptance criteria explicitly require capability-based
  routing.
- **Why rejected**: violates acceptance criteria. Creates tight coupling between workflow policy
  (high-level) and provider identity (low-level), inverting the dependency direction rule.

### Alternative 5: Use `zod` for config schema validation

- **Pros**: excellent developer ergonomics; typed parse output; `.safeParse()` gives structured errors
  without throwing; widely understood in the TypeScript ecosystem.
- **Cons**: runtime dependency. Same rejection reason as Alternative 1. `zod@3.x` has zero transitive
  deps of its own, but it is still a runtime dep that appears in the SBOM and must be audited.
- **Why rejected**: zero-dependency constraint is load-bearing. Hand-rolled validators with explicit
  `if`/`throw` are less elegant but fully adequate for a fixed-schema config object.

### Alternative 6: Implement in `src/model-gateway/` (follow the issue routing hint literally)

- **Pros**: matches the `src/model-gateway/**` path named in issue #3's routing hint; a developer
  reading only the issue would find the code where they expect it.
- **Cons**: ADR-0001 is an accepted decision that explicitly reserves `src/gateway/` for this purpose.
  Creating `src/model-gateway/` would produce a confusing duplicate directory alongside the
  already-reserved `src/gateway/`, leave the `src/gateway/index.ts` placeholder orphaned, and
  constitute drift from an accepted ADR. The issue routing hint is explicitly labelled non-binding in
  the issue template.
- **Why rejected**: ADR-0001's accepted layout is authoritative. The issue hint is a non-binding
  template artefact. This ADR records the reconciliation explicitly so the deviation from the hint is
  on the record.

## Implementation Plan

This section doubles as the spec a `developer` agent builds from directly.

### File map

```
src/gateway/
  index.ts           # Barrel: re-exports all public types and the Gateway class
  types.ts           # All interfaces and type aliases (no runtime code)
  errors.ts          # Error taxonomy: base class + typed subclasses + code constants
  capabilities.ts    # Registry data (9 models) + lookup/routing helpers
  config.ts          # Config loading, validation, redaction-aware serialisation
  redaction.ts       # redact() helper + secret pattern rules
  resilience.ts      # Clock interface, timeout wrapper, bounded retry, circuit breaker
  openai-adapter.ts  # fetch-based OpenAI-compatible provider implementation
  normalize.ts       # Provider payload → NormalizedResponse + tool-call normalisation
  gateway.ts         # Orchestrator: routes requests through registry + adapter + resilience

tests/gateway/
  capabilities.test.ts    # Registry lookups, routing, unknown-model handling
  config.test.ts          # Valid config load, missing required field, extra field, env override
  redaction.test.ts       # API key patterns redacted, benign strings unchanged
  errors.test.ts          # Each error code correct, instanceof checks, message safety
  normalize.test.ts       # Chat response, tool-call, structured output, malformed payload
  resilience.test.ts      # Timeout, bounded retry with backoff, circuit-breaker state machine
  openai-adapter.test.ts  # Success, 401, 429, network failure, cancellation, body not echoed
  gateway.test.ts         # End-to-end with mocked adapter: routing, usage, secrets, CLI contract
```

Each source file is bounded: `types.ts` approximately 200 LOC (interfaces only), `capabilities.ts`
approximately 350 LOC (data table dominates), all others approximately 150–250 LOC. All functions
50 LOC maximum. Cyclomatic complexity 10 maximum. No `any`.

### Key TypeScript interfaces

All interfaces live in `src/gateway/types.ts`. Relative imports in `src/gateway/*.ts` use `.js`
extensions (`import type { ... } from './types.js'`). Type-only imports use `import type`.

```typescript
// ─── Modality discriminant ────────────────────────────────────────────────────

export type ModelKind = 'chat' | 'embedding' | 'ocr-vision';

export type CostClass = 'low' | 'medium' | 'high';

export type LatencyClass = 'fast' | 'standard' | 'slow';

// ─── Capability registry entry ────────────────────────────────────────────────

export interface ModelCapability {
  readonly id: string;
  readonly kind: ModelKind;
  readonly contextWindow: number;        // Tokens; 0 = unknown or N/A for this kind
  readonly maxOutputTokens: number;      // 0 = unknown or N/A
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly streaming: boolean;           // Provider API supports SSE; Wave 1 adapter does not process
  readonly costClass: CostClass;
  readonly latencyClass: LatencyClass;
  readonly throughputHint: string;       // Human label, e.g. "~200 tok/s"; not a contract
  readonly preferredUseCases: readonly string[];
  readonly knownLimitations: readonly string[];
}

// ─── Provider configuration ───────────────────────────────────────────────────

export interface ModelProviderConfig {
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;               // Read from env/config; never logged
  readonly timeoutMs: number;            // Default: 30_000
  readonly maxRetries: number;           // Default: 3
  readonly retryBaseDelayMs: number;     // Initial backoff; doubles each attempt; default: 500
}

export interface CircuitBreakerConfig {
  readonly failureThreshold: number;     // Consecutive failures to open; default: 5
  readonly cooldownMs: number;           // Open → Half-Open wait; default: 30_000
  readonly halfOpenProbes: number;       // Successes to close; default: 2
}

export interface GatewayConfig {
  readonly providers: readonly ModelProviderConfig[];
  readonly circuitBreaker: CircuitBreakerConfig;
}

// ─── Request / response ───────────────────────────────────────────────────────

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string | undefined;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;  // JSON Schema object
}

export type ResponseFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_schema'; readonly schema: Record<string, unknown> };

export interface GatewayRequest {
  readonly modelId: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly responseFormat?: ResponseFormat | undefined;
  readonly stream?: boolean | undefined;          // Wave 1: schema only; adapter ignores
  readonly cancellationSignal?: AbortSignal | undefined;
}

// ─── Tool-call normalisation ──────────────────────────────────────────────────

export interface NormalizedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;  // Parsed from JSON; fail-closed on parse error
}

// ─── Usage metadata (first-class, non-optional on every response) ─────────────

export interface UsageMetadata {
  readonly requestId: string;           // UUID v4, generated by gateway (not provider)
  readonly promptTokens: number;        // 0 if provider omits
  readonly completionTokens: number;    // 0 if provider omits
  readonly latencyMs: number;           // Wall-clock: request start to body received
  readonly costClass: CostClass;        // From capability registry for this model
}

// ─── Normalised response ──────────────────────────────────────────────────────

export type FinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'error'
  | 'cancelled';

export interface NormalizedResponse {
  readonly modelId: string;
  readonly content: string;             // '' when finishReason is 'tool_calls'
  readonly finishReason: FinishReason;
  readonly toolCalls: readonly NormalizedToolCall[];
  readonly structuredOutput: Record<string, unknown> | null;
  readonly usage: UsageMetadata;        // Non-optional
}

// ─── Streaming (schema only — Wave 1 adapter does not process chunked streams) ─

export interface StreamDelta {
  readonly role?: 'assistant' | undefined;
  readonly contentDelta?: string | undefined;
  readonly toolCallDelta?: Partial<NormalizedToolCall> | undefined;
  readonly finishReason?: FinishReason | undefined;
  readonly usage?: UsageMetadata | undefined;    // Present on the final delta only
}

export type StreamEvent =
  | { readonly type: 'delta'; readonly delta: StreamDelta }
  | { readonly type: 'done'; readonly response: NormalizedResponse };

// ─── Provider adapter interface ───────────────────────────────────────────────

export interface ProviderAdapter {
  readonly call: (
    request: GatewayRequest,
    config: ModelProviderConfig,
  ) => Promise<NormalizedResponse>;
}

// ─── Clock interface (injectable for deterministic tests) ─────────────────────

export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

// ─── Circuit-breaker observable state ────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerStatus {
  readonly modelId: string;
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;    // clock.now() value; null when closed
}
```

### Error taxonomy

All errors extend `GatewayError`. Each subclass has a stable `code` string constant. Callers switch
on `error.code`; they do not parse `error.message`. Error messages are safe to log (secrets redacted
before message construction).

**Stable error code constants (`src/gateway/errors.ts`):**

```typescript
export const ERROR_CODES = {
  AUTHENTICATION:       'GATEWAY_AUTHENTICATION',
  TRANSPORT:            'GATEWAY_TRANSPORT',
  MODEL_REFUSAL:        'GATEWAY_MODEL_REFUSAL',
  MALFORMED_TOOL_CALL:  'GATEWAY_MALFORMED_TOOL_CALL',
  CONTEXT_OVERFLOW:     'GATEWAY_CONTEXT_OVERFLOW',
  RATE_LIMIT:           'GATEWAY_RATE_LIMIT',
  TIMEOUT:              'GATEWAY_TIMEOUT',
  CANCELLED:            'GATEWAY_CANCELLED',
  CIRCUIT_OPEN:         'GATEWAY_CIRCUIT_OPEN',
  PROVIDER_ERROR:       'GATEWAY_PROVIDER_ERROR',
  CONFIG_INVALID:       'GATEWAY_CONFIG_INVALID',
  UNKNOWN_MODEL:        'GATEWAY_UNKNOWN_MODEL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
```

**Subclasses:**

| Class | Code | Extra fields | Retryable |
|---|---|---|---|
| `AuthenticationError` | `GATEWAY_AUTHENTICATION` | — | No |
| `TransportError` | `GATEWAY_TRANSPORT` | — | Yes |
| `ModelRefusalError` | `GATEWAY_MODEL_REFUSAL` | — | No |
| `MalformedToolCallError` | `GATEWAY_MALFORMED_TOOL_CALL` | — | No |
| `ContextOverflowError` | `GATEWAY_CONTEXT_OVERFLOW` | — | No |
| `RateLimitError` | `GATEWAY_RATE_LIMIT` | `retryAfterMs: number \| null` | Yes (with delay) |
| `TimeoutError` | `GATEWAY_TIMEOUT` | — | Yes |
| `CancelledError` | `GATEWAY_CANCELLED` | — | No |
| `CircuitOpenError` | `GATEWAY_CIRCUIT_OPEN` | — | No |
| `ProviderError` | `GATEWAY_PROVIDER_ERROR` | `httpStatus: number` | No |
| `ConfigInvalidError` | `GATEWAY_CONFIG_INVALID` | — | No |
| `UnknownModelError` | `GATEWAY_UNKNOWN_MODEL` | — | No |

### Capability registry — nine required models

All values are documented assumptions. Figures marked `[assumption]` are conservative estimates based
on public model cards and provider documentation as of 2026-05-28. The registry is editable config;
the developer may update values when the customer provides authoritative deployment figures.

| Model ID | Kind | Context window | Max output | Tool calling | Structured output | Streaming | Cost class | Latency class | Preferred Wave 1 use cases | Known limitations |
|---|---|---|---|---|---|---|---|---|---|---|
| `Qwen3-Coder-480B-A35B-Instruct-FP8` | chat | 128 000 [assumption] | 8 192 [assumption] | true | true | true | high | slow | Large-codebase refactor, cross-file analysis | Very high VRAM; slow for interactive use |
| `Qwen/Qwen3-Coder-Next-FP8` | chat | 128 000 [assumption] | 8 192 [assumption] | true | true | true | high | slow | Deep code synthesis requiring maximum reasoning depth | Same VRAM/latency constraints as Qwen3-Coder-480B; treat as next-generation upgrade path |
| `Devstral-2-123B-Instruct-2512` | chat | 128 000 [assumption] | 8 192 [assumption] | true | true | true | high | standard | Agentic code completion, multi-step software engineering | 123B scale; requires dedicated GPU allocation; not suitable for high-QPS workloads |
| `gpt-oss-120b` | chat | 128 000 [assumption] | 8 192 [assumption] | true | true | true | high | standard | General-purpose coding, code review, explanation | Customer-hosted OSS model; endpoint reliability depends on customer infrastructure |
| `Mistral-Small-3.1-24B-Instruct-2503` | chat | 128 000 | 8 192 [assumption] | true | true | true | medium | fast | Interactive code assist, quick edits, low-latency agent steps | Smaller model; may require multi-turn for complex reasoning |
| `Qwen2.5-Coder-7B-Instruct` | chat | 128 000 | 4 096 [assumption] | true | false [assumption] | true | low | fast | Inline completion, snippet generation, high-throughput batch coding tasks | Limited structured-output reliability; context degradation beyond 64 K tokens observed in benchmarks [assumption] |
| `gemma-4-31b-it` | chat | 128 000 [assumption] | 8 192 [assumption] | true | true | true | medium | standard | Document summarisation, code explanation, regulated-context Q&A | Instruction-tuned variant; verify function-calling reliability against customer endpoint |
| `dotsocr` | ocr-vision | 0 | 0 | false | false | false | medium | standard | Document OCR, scanned contract/form extraction, image-to-text in regulated workflows | Not a chat model; chat-completions adapter does not apply; callOcr method is Wave 2 |
| `multilingual-e5-large Embedding` | embedding | 512 [assumption] | 0 | false | false | false | low | fast | Semantic search, RAG retrieval, similarity ranking across multilingual content | Max 512 tokens per input; callEmbedding method is Wave 2 |

Notes on registry design:
- `streaming: true` means the provider API supports SSE. The Wave 1 adapter does not process chunked
  streams. The flag is metadata for a Wave 2 streaming implementation.
- A chat request targeting a model with `kind: 'embedding'` or `kind: 'ocr-vision'` throws
  `UnknownModelError` with a message explaining the kind mismatch, not a cryptic type error.
- Context windows for customer-hosted models are `[assumption]`; override in the config file.

### Config loading and secret sourcing policy

Precedence order (highest wins):

1. Explicit config file: path from `--config <path>` flag or `KEIKO_CONFIG_FILE` env var. JSON.
   Schema validated before any field is read.
2. Per-model env vars: `KEIKO_MODEL_<UPPER_MODEL_ID>_API_KEY` and
   `KEIKO_MODEL_<UPPER_MODEL_ID>_BASE_URL`. `UPPER_MODEL_ID` is the model ID with all
   non-alphanumeric characters replaced by `_` and uppercased.
3. Global fallback: `KEIKO_DEFAULT_API_KEY`, `KEIKO_DEFAULT_BASE_URL`.

**Secret sourcing policy:**
- API keys are read only from environment variables or the config file. They are never accepted as
  CLI flags (flags appear in process listing output and shell history).
- `apiKey` fields are excluded from any `toSafeObject()` or JSON serialisation paths.
- All error constructors that include provider-derived strings call `redact()` before constructing the
  message.
- The `validate` CLI command reports config structure errors without printing config values.

### Resilience primitives

**Timeout.** Each call creates a timeout signal via `AbortSignal.timeout(config.timeoutMs)`. If the
caller also supplies a `cancellationSignal`, the two are composed:
`AbortSignal.any([timeoutSignal, cancellationSignal])` (Node 22 built-in). The composed signal is
passed to `fetch(url, { signal })`. A signal abort triggered by timeout throws `TimeoutError`;
triggered by cancellation throws `CancelledError`.

**Bounded retry.** On `TransportError`, `TimeoutError`, or `RateLimitError` (when `retryAfterMs` is
null or zero), the gateway retries up to `config.maxRetries` times with exponential backoff:
`delay = min(retryBaseDelayMs * 2^(attempt - 1), 30_000)`. The delay uses `clock.sleep()`. The
following error types are never retried: `AuthenticationError`, `ModelRefusalError`,
`ContextOverflowError`, `CancelledError`, `CircuitOpenError`, `ConfigInvalidError`,
`UnknownModelError`.

**Circuit breaker.** One `CircuitBreaker` instance per `(modelId, baseUrl)` pair, keyed in a `Map`.
States:

- **Closed**: requests pass through. Consecutive failure counter increments on each `GatewayError`.
  When counter reaches `failureThreshold`, transition to **Open** and record `openedAt = clock.now()`.
- **Open**: any call immediately throws `CircuitOpenError` without contacting the provider.
  When `clock.now() - openedAt >= cooldownMs`, transition to **Half-Open**.
- **Half-Open**: the next `halfOpenProbes` calls are forwarded as probes. Each success decrements the
  probe counter. When the counter reaches zero, transition to **Closed** and reset all counters. Any
  failure transitions back to **Open** immediately and resets `openedAt`.

Circuit state is observable via `gateway.circuitStatus(modelId): CircuitBreakerStatus`.

### CLI commands

The `models` sub-command is dispatched from `runCli` in `src/cli/runner.ts` when `args[0] === 'models'`.
The implementation lives in `src/cli/models.ts` as `runModelsCli(args: readonly string[], io: CliIo, gateway: Gateway): number`.

**`keiko models list`**

```
stdout (tab-separated columns, one row per registered model):
  ID                                    KIND      COST    LATENCY  TOOLS  STRUCT  USE-CASES
  Qwen3-Coder-480B-A35B-Instruct-FP8   chat      high    slow     yes    yes     large-codebase-refactor,...
  ...
  (no API keys, no base URLs, no secrets)

exit code: 0 on success, 1 on unexpected error
```

**`keiko models validate [--config <path>]`**

```
stdout (valid config):
  Gateway config valid. 9 model providers configured.

stderr (invalid config):
  Error [GATEWAY_CONFIG_INVALID]: providers[2].timeoutMs must be a positive integer
  (one diagnostic per line; no credential values in output)

exit code: 0 on valid, 1 on invalid config or runtime error, 2 on usage error (bad flag)
```

**Existing smoke test behaviour preserved:**

| Command | Exit code | Output |
|---|---|---|
| `keiko --help` | 0 | Contains "keiko", "--help", "--version", exit codes |
| `keiko --version` | 0 | Semver string matching `/keiko \d+\.\d+\.\d+/` |
| `keiko unknown-cmd` | 2 | Stderr contains "unknown", "keiko --help" |
| `keiko models` (no sub-command) | 2 | Stderr contains usage hint |

### Test behaviour matrix

All tests use mocked providers. No network I/O. No real time delays. All time-dependent tests use a
deterministic `Clock` stub.

| File | Required behaviours |
|---|---|
| `capabilities.test.ts` | Lookup by valid ID returns correct entry; lookup of unknown ID returns `undefined`; routing query finds cheapest chat model with tool-calling; routing an ocr-vision model via chat path returns kind-mismatch error |
| `config.test.ts` | Valid config file parses without error; missing `apiKey` field throws `ConfigInvalidError` with descriptive message; `timeoutMs: -1` throws `ConfigInvalidError`; `KEIKO_DEFAULT_API_KEY` env var is applied; `toSafeObject()` output does not contain `apiKey` field |
| `redaction.test.ts` | Bearer token pattern (`Bearer sk-...`) fully redacted; `sk-` prefix pattern redacted; benign string unchanged; empty string unchanged; string with multiple secret patterns: all redacted |
| `errors.test.ts` | Each error code is the expected stable string (snapshot or equality); all subclasses pass `instanceof GatewayError`; `RateLimitError.retryAfterMs` is null when not provided; error message constructed with a redacted input does not contain the literal string "apiKey" or the raw key value |
| `normalize.test.ts` | Well-formed chat response normalises correctly with populated `usage`; tool-call response: `toolCalls` array populated, `content` is `''`, `finishReason` is `'tool_calls'`; structured output: `structuredOutput` is parsed object; malformed tool-call JSON argument string throws `MalformedToolCallError`; provider omits `usage` field: all usage counts normalised to zero; unrecognised `finish_reason` value maps to `'stop'` |
| `resilience.test.ts` | Timeout signal fires before stub response resolves: `TimeoutError` thrown; 2 transport failures then success: 3 total calls, backoff delays match formula via clock stub; `maxRetries` exhausted: throws last error after N+1 total calls; auth error: not retried, thrown immediately; circuit breaker: 5 consecutive failures opens circuit; open state: next call throws `CircuitOpenError` without calling adapter; half-open after cooldown: probe succeeds, circuit closes, next real call proceeds; half-open: probe fails, circuit reopens |
| `openai-adapter.test.ts` | 200 response: returns `NormalizedResponse` with correct `modelId` and `usage`; HTTP 401: throws `AuthenticationError`; HTTP 429 with `Retry-After: 5` header: throws `RateLimitError` with `retryAfterMs: 5000`; `fetch` throws `TypeError` (network failure): throws `TransportError`; `cancellationSignal` already aborted on entry: throws `CancelledError`; raw response body not included verbatim in any thrown error |
| `gateway.test.ts` | Successful call: `usage.requestId` is UUID v4 format; `usage.latencyMs` is a positive number; `usage.costClass` matches registry entry for the requested model; chat request to embedding model: throws `UnknownModelError` with kind in message; thrown error message does not contain the literal `apiKey` value from config; `circuitStatus(modelId)` returns `'closed'` before any failures; `models list` CLI output contains all 9 model IDs; no line in list output matches an API key pattern; `models validate` with invalid config: exits 1, stderr contains `GATEWAY_CONFIG_INVALID` |

## Related

- ADR-0001: Project Foundation and Toolchain (zero-dependency constraint, `src/gateway/` reservation,
  TypeScript strict/NodeNext/ESM settings, file/function LOC limits)
- ADR-0002: CI and Supply-Chain Security Baseline (dependency-review gate, SBOM, 7 required CI checks)
- Issue #3: Define model gateway, capability registry, and cost/timeout controls
- Issue #10: Audit ledger (aggregates `UsageMetadata` from every gateway response)
- WHATWG AbortSignal.any(): https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static
- Circuit Breaker pattern: https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker
- OpenAI Chat Completions API (adapter target shape): https://platform.openai.com/docs/api-reference/chat

## Date

2026-05-28
