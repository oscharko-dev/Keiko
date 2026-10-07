# ADR-0003: Model Gateway Boundary, Capability Registry, and Cost/Timeout Controls

## Status

Accepted

Superseded by ADR-0019 for module location only (moved from `src/gateway/` to `packages/keiko-model-gateway/` and `packages/keiko-cli/`); the core gateway/resilience/redaction decisions remain in force unchanged. **D3's static-registry-as-single-source claim is superseded for capability sourcing:** the shipped built-in `CAPABILITY_DATA` in [`packages/keiko-model-gateway/src/capabilities.data.ts`](../../packages/keiko-model-gateway/src/capabilities.data.ts) is intentionally empty — Keiko ships no customer or deployment-specific model ids — and the durable capability set is now assembled at runtime from operator-supplied `RuntimeGatewayConfig.capabilities` (see [`packages/keiko-server/src/gateway-setup.ts`](../../packages/keiko-server/src/gateway-setup.ts)), enriched at UI-onboarding time by LiteLLM's `/model/info` endpoint with a generic `/models` discovery fallback (`discoverLiteLlmModelInfo`, and the `/model/info` candidate builder). Readiness-observation reconciliation against that operator configuration is governed by [ADR-0171](ADR-0171-gateway-readiness-capability-reconciliation.md). Runtime-discovered models can carry metadata gaps — for example `contextWindow` defaulting to `0` until an operator supplies the correct value (per GEN-GATE-CONTEXT-001/003/004/005) — and those defaults never mutate `GatewayConfig.capabilities` on the strength of a probe alone. D3's routing invariant (workflows select by capability, never by hard-coded model name) is preserved; only the "single, static, checked-in registry" sourcing model has been replaced by operator configuration plus discovery. D4–D8 (usage metadata, error taxonomy, resilience, redaction, CLI surface) remain in force unchanged.

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

An autonomous coding turn is not an interactive answer a person waits on, so it tolerates an outage
instead of failing fast (#3873). The policy is an explicit request signal,
`outagePolicy: "outage-window"` on the `GatewayCallRequest`, and only the coding sidecar route sets
it, on its buffered and its streamed model calls alike. The `coding-workbench` latency profile does
not select it: that profile only raises the timeout floors, and the interactive commit-message
draft borrows it (#3591) while a person waits on the answer. A call with the signal keeps retrying a
transiently unavailable provider (429, a retryable 5xx, a refused connection, a silent attempt) for
the gateway configuration's `codingOutageWindowMs` (default `GATEWAY_CODING_OUTAGE_WINDOW_MS`, 10
minutes; at most one hour) rather than stopping after the provider's `maxRetries`, and it waits
through an open circuit breaker's cooldown and probe slot instead of receiving `CircuitOpenError`
at once. The window extends only the retries after a failure the breaker counts against the
provider (`isNonProviderFault` is false); a retry that reacts to the model's own output, a rejected
tool-call shape and its schema-repair correction, keeps the provider's attempt count and reports
`retryPolicy=attempts`. One policy covers both call shapes: a buffered call's retry loop and a
streamed call's retries before its first answer delta — at startup, and after a stream that has
delivered nothing but forwarded reasoning (#3873 review; see the streamed chunk model below) — run
under the same window, measured from the start of the call, and every admission wait, a streamed
call's first admission included, is clipped to what is left of it. A failure after answer text was
delivered cannot be retried without duplicating that text: the call ends, and the coding runtime
decides whether to retry the turn (`runtimeRetry`, ADR-0173). After a failed half-open probe, a streamed coding turn waits for the next
probe just as a buffered one does. The capped exponential backoff with jitter, any
provider-announced `Retry-After` and the half-open probe limit all still apply, so waiting callers
never add load to a recovering provider.

The window is the operator's explicit bound, not the provider's attempt budget. Under the outage
policy the call's end-to-end budget is the window plus one attempt bound, and never less than the
provider's own budget (`bufferedCallBudgetMs` / `streamedCallBudgetMs`): the configured window holds
even at `maxRetries: 0`, where the provider budget alone is ten minutes, and the attempt the window
admits last keeps its full bound, so a healthy answer is not cut at the window's edge. The sidecar
route's deadline sits behind that budget, from the same derivation. Each attempt keeps its own
bound: a silent attempt ends at the silence floor (at least five minutes without data) when the
answer is read over a stream, otherwise at the buffered floor (at least ten minutes), and it is
retried only while the window still has room. With the default window and floors a silent streamed
attempt is therefore retried once and a silent whole-body attempt not at all; a longer
`codingOutageWindowMs` buys more attempts. A call that outlasts the window ends with
`gateway.retry.exhausted reason=budget`.

A refused connection counts as transient on purpose: while a gateway restarts or sheds load its
listener can refuse connections for a while, which is exactly the outage the window rides out. A
misconfigured route (a wrong host or port) is caught before any coding turn by Gateway Setup's
probe, so a Workbench turn that faces an unreachable gateway waits up to the window
(`codingOutageWindowMs`) before it fails. Every other surface, the commit draft and interactive
chat included, keeps its configured attempt count and fail-fast breaker, and
`codingOutageWindowMs: 0` restores that behaviour for coding calls as well. Gateway Setup keeps the
configured value, an explicit `0` included, through every rebuild of the configuration. The retry
and breaker lines `gateway.retry.scheduled`, `gateway.retry.exhausted` and `gateway.circuit.wait`
carry the applied policy as the closed field `retryPolicy` (`attempts` or `outage-window`), so the
Activity Log tells a deliberate outage window from a retry loop that ignored its attempt count.

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
  readonly timeoutMs: number;            // One attempt; default: 120_000 (#3591)
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
```

`GatewayConfig` has grown several optional blocks since Wave 1 (`capabilities`, `grounding`,
`reranker`, `egress`, `figma`, `branding`, …) that this historical implementation-plan snapshot was
never kept in sync with field-by-field; `packages/keiko-model-gateway/src/types.ts` is the current,
authoritative shape. One addition is documented here because it is otherwise undiscoverable from
code alone: **`branding?: GatewayBrandingConfig`** (Issue #3398) lets an operator declare a public,
immutable, content-hashed HTTPS SVG logo URL for generated PR descriptions —

```typescript
export interface GatewayBrandingConfig {
  readonly logoUrl?: string | undefined;   // Operator-declared candidate only; never trusted as-is
}
```

`config.ts`'s `resolvePrDescriptionBrandingFromConfig` is the sole place that turns
`branding.logoUrl` into a `PrDescriptionBranding`, reusing `validatedPrDescriptionLogoUrl`
(`prDescription/render.ts`) to decide whether it clears the immutable-public-HTTPS-SVG bar. An
absent or invalid value never fails config load — it falls back to Keiko's text-only
`Generated with [Keiko](https://github.com/oscharko-dev/Keiko)` attribution, since branding is
decorative, never load-bearing.

**`groundedAnswers?: GroundedAnswersConfig`** (PR #3678, ADR-0144) is the operator's policy for
Keiko's own, labelled assessment in grounded answers. `ownAssessment` is `allowed` (the default when
absent) or `disabled`. It is a governance setting, so unlike `branding` an explicit value outside
that closed vocabulary fails the configuration load instead of being read as the permissive default.
Setup rebuilds produce only providers and capabilities, so `groundedAnswers` and `branding` carry
over verbatim through `rawConfigFromCurrent` and the setup's optional-block restoration.

```typescript
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
| `ProviderError` | `GATEWAY_PROVIDER_ERROR` | `httpStatus: number`, `retryAfterMs: number \| null` | HTTP 500/502/503/529 before delivered output |
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

1. Per-model env vars: `KEIKO_MODEL_<UPPER_MODEL_ID>_API_KEY` and
   `KEIKO_MODEL_<UPPER_MODEL_ID>_BASE_URL`. `UPPER_MODEL_ID` is the model ID with all
   non-alphanumeric characters replaced by `_` and uppercased.
2. Explicit config file: path from `--config <path>` flag or `KEIKO_CONFIG_FILE` env var. JSON.
   Schema validated before any field is read.
3. Global fallback: `KEIKO_DEFAULT_API_KEY`, `KEIKO_DEFAULT_BASE_URL`.

**Secret sourcing policy:**
- API keys are read only from environment variables or the config file. They are never accepted as
  CLI flags (flags appear in process listing output and shell history).
- `apiKey` and provider `baseUrl` fields are excluded from any `toSafeObject()` browser
  serialisation path.
- All error constructors that include provider-derived strings call `redact()` before constructing the
  message.
- The `validate` CLI command reports config structure errors without printing config values.

### Resilience primitives

**Timeout.** Each attempt creates its own timeout signal via `AbortSignal.timeout()` when the read
has no silence/budget bounds (below), or a pair of plain timers (`timedAbort`) when it does.
`config.timeoutMs` bounds one attempt, and the attempt runs under the smaller of it and what is left
of the call's end-to-end budget (below). If the caller also supplies a `cancellationSignal`, the two
are composed: `AbortSignal.any([timeoutSignal, cancellationSignal])` (Node 22 built-in). The
composed signal is passed to `fetch(url, { signal })`. A signal abort triggered by timeout throws
`TimeoutError`; triggered by cancellation throws `CancelledError`.

**Silence and budget floors (#3591).** The field customer's LiteLLM proxy in front of vLLM answers
slowly at peak load — 30s, 45s, 120s and longer before the first byte, with stalls between stream
chunks — and Keiko must stay in the request rather than abort on its own for such delays. Every
interactive gateway surface therefore floors its effective bound to at least the constants exported
from `resilience.ts`: `GATEWAY_SILENCE_FLOOR_MS` (5 min — the longest wait for the first byte and
between two stream data events), `GATEWAY_STREAM_BUDGET_FLOOR_MS` (30 min — the longest total read
of a streamed answer, `Gateway.chatStream()`), and `GATEWAY_BUFFERED_BUDGET_FLOOR_MS` (10 min — the
longest total read of a buffered answer, `Gateway.chat()`, including coding-workbench and every
buffered call that answers a user action: commit draft, prompt enhancer, memory salience, quality
judge). A caller's own configuration may only raise these bounds, never lower them; an already
generous configured value passes through unmodified. Embeddings, rerank and the voice adapters each
apply their own, smaller per-call floor (`GATEWAY_RETRIEVAL_TIMEOUT_FLOOR_MS` /
`GATEWAY_VOICE_TIMEOUT_FLOOR_MS`, 2 min) to the actual outbound HTTP deadline only — never to the
embedding ladder's own bookkeeping deadline, which stays driven by exactly what the caller
configured (including an intentionally exhausted budget of 0), or the ladder could never expire. The
default provider `timeoutMs` (`config.ts`'s `DEFAULT_TIMEOUT_MS`) is 120s.

**Reading a buffered answer over the stream.** A buffered call to a route whose capability streams
(`streaming: true`, with an adapter that can read a stream) reads each attempt's answer over the
provider's SSE stream instead of waiting for one body. The silence bound — the configured
`timeoutMs` floored to `GATEWAY_SILENCE_FLOOR_MS` — then bounds the provider's silence: before its
response starts, until its first data event, and between two data events. What is left of the
call's end-to-end budget bounds the whole read. A whole-body read (an adapter without
`callStream`, or `chatStream()`'s buffered fallback) has no observable progress, so its single
attempt deadline floors directly to `GATEWAY_BUFFERED_BUDGET_FLOOR_MS` instead (`chatAttemptTimeoutMs`,
`resilience.ts`), and the gateway's call-started line records whichever bound applied. A long generation that
keeps producing is therefore never cut off at `timeoutMs` and generated again, and a silent
provider still ends with a retryable `TimeoutError`. A keep-alive comment (a LiteLLM proxy's
`: ping` while it waits for its upstream) is not a data event. An error frame inside the stream
(`data: {"error": …}`) maps like the same HTTP failure: LiteLLM's `code` is the upstream HTTP status
as a string, and a frame that names no status (OpenAI and Azure name a failure in `code`, `type`
and `message`) is classified by what it says (a context overflow, a rejected key, a missing
permission, a rate limit or an invalid request) before it falls back to a retryable upstream
failure (502), so a terminal failure is never generated again. The read releases the provider's
body on every exit, also when its consumer stops early. The streamed answer runs through the same
normalization as a whole body, and an endpoint that answers a streamed request with
`application/json` is read as that whole body.
An SSE answer counts as complete only after a recognized `finish_reason` or the `data: [DONE]`
marker. If the connection closes after deltas without either signal, the adapter raises a typed
provider error instead of turning the partial text into a successful assistant reply. An unknown
finish reason can still complete when the proxy sends `[DONE]`. An explicit refusal delta retains
its refusal classification on early close instead of being masked by the generic incomplete-stream
error.
An OpenAI-compatible endpoint that explicitly rejects optional `stream_options` receives one
streaming retry without that field. LiteLLM can reinsert the field between Keiko and vLLM, so a
second explicit rejection naming `stream_options` receives one bounded `stream: false` retry. The
buffered answer passes through the same capped body reader, secret redaction, normalization, and
tool-catalog binding as a streamed answer, and the retries share the original deadline. A buffered
upstream sends no header before its generation ends, so the silence bound never applies to a
`stream: false` request: what is left of the read budget bounds when its answer starts, and its
dispatch line records that bound as `timeoutMs` (PR #3600 review). A credential-scoped
compatibility memo avoids repeating rejected shapes for 15 minutes. Generic errors, rejections of
another field, and model or content refusals remain terminal; the body-free compatibility line
records only which field was omitted.
Coding run 30 (2026-09-11): two gpt-5.4 generations of 4.8k to 5.9k output tokens at 27 to 45
tokens per second were cut off at 120 s and generated a second time; Azure answered both with
HTTP 200.

**Bounded retry.** On an error whose `retryable` flag is set, among them `TransportError`,
`TimeoutError` and `RateLimitError`, the gateway retries up to `config.maxRetries` times. The
backoff is `min(retryBaseDelayMs * 2^(attempt - 1), 30_000)` at the top of an equal-jitter band
(each sleep lies between half of it and all of it); a `RateLimitError` that carries `retryAfterMs`
waits at least the stated cooldown instead, subject to the remaining whole-call budget and
platform timer ceiling. Retryable `ProviderError` responses (including HTTP 503) preserve the same
optional `retryAfterMs` duration. OpenAI-compatible adapters parse both delay-seconds and HTTP-date
forms of `Retry-After`; malformed values use the normal backoff. Provider cooldowns are never
shortened to the exponential backoff cap: an overloaded LiteLLM queue may legitimately request
a two-minute wait. Gateway calls add positive backoff jitter after that minimum and refuse a
delay that cannot fit the remaining request budget. The delay uses cancellation-aware `clock.sleep()`. The
following error types are never retried: `AuthenticationError`, `ModelRefusalError`,
`ContextOverflowError`, `CancelledError`, `CircuitOpenError`, `ConfigInvalidError`,
`UnknownModelError`.

**Steered repair of an exhausted or empty answer (#3873, F17, F23).** A `ProviderOutputExhaustedError` — an HTTP
200 answer whose `finish_reason` is `length` with neither a tool call nor content, the model having
spent its whole output budget on reasoning — is never retried as is. On a call that asks for it, it
is not surfaced at once either: the explicit `GatewayCallRequest.answerRepair: "steered"` (local,
never serialized) is set by the coding sidecar route alone, so every other call — the commit draft
and interactive chat included — still surfaces such an answer at once and never makes a hidden second
generation (#3873 review). On such a call the retry loop (`RetryConfig.repair`, `resilience.ts`)
grants exactly one further attempt per call, at once, which the gateway sends as the ORIGINAL request
plus one fixed system message (`OUTPUT_EXHAUSTED_REPAIR_MESSAGE`, `gateway.ts`): the model is told
that its previous answer used the whole budget without a tool call or a final answer and asked to
reply with that directly, keeping any reasoning to a few sentences. The repair follows the tool-schema
repair's pattern — one correction at a time, never the exhausted answer quoted back — but is its own
retry-loop hook, separate from the schema correction, and applies to a buffered call, to a stream
before its first content, and (owner decision 2026-10-06, option iii) to a stream that has delivered
nothing but forwarded reasoning alike: the retry loop is resumed after the exhausted attempt
(`executeWithRetry`'s `resume`, which carries the call's attempt and repair counts across every loop
of the call), the caller then sees a second reasoning passage, and no answer text or tool call is
ever duplicated. The provider-reported usage of the repaired attempt (and of every other attempt the
call discarded: a rejected tool call, a stream that failed after its usage arrived) rides on the
answer as `discardedAttemptUsage`, so the coding run's prompt allowance counts every prompt the
provider processed (ADR-0137 D2); `usage` keeps describing the answer itself. A delivered answer delta or tool call, and a repair that already ran,
close the window for good, so a later exhaustion surfaces at once. It is not a provider retry: neither `maxRetries` nor the coding outage window
counts it, only what is left of the call's budget can refuse it (the call then ends as a budget stop
rather than a terminal one), and the breaker never counts either answer. Its scheduled line is
`gateway.retry.scheduled` with `reason: "output-exhausted-repair"` and `delayMs: 0` (and
`retryPolicy: "attempts"`, D6: the outage window never extends a repair); an ordinary retry
carries `reason: "retryable-error"`. A repaired attempt that exhausts the budget again surfaces that
second `ProviderOutputExhaustedError` once, marked `outputRepair: "exhausted-again"` on the error; one
that fails for another reason carries `outputRepair: "failed"`; a recovered answer carries
`outputRepair: "recovered"` on the `NormalizedResponse`. The coding sidecar route reads those marks for
its own evidence and answers a repaired-and-exhausted-again turn as final to the runtime (ADR-0173).
Live qualification of 1.1.x with Gemma 4 31B behind LiteLLM (run
`324076066246415201273338647160811469441`) motivated this: the fourth turn reasoned for its whole 8k
budget, the runtime retried the identical turn twice, and every attempt cost seven minutes at 20
tokens per second with nothing steering the model.

The same one repair covers an answer that ended **after reasoning without a tool call or any text**
(F23). That answer is a `ProviderEmptyAnswerError` (#3610: HTTP 200, a finish reason other than
`length`, neither content nor a tool call), and it carries `afterReasoning` — a flag the adapter sets
when the answer carried reasoning, never the reasoning itself (`carriedReasoning`, `normalize.ts`). Only
that empty answer is repaired; an empty answer that carried no reasoning is the model's final word,
surfaces at once, and is never retried, exactly as before. `steeredAnswerRepair` (`resilience.ts`) is
the single classification the buffered attempt, the streamed startup and the stream resumed after
forwarded reasoning all consult, and the repair is granted once per call whichever of the two failures
comes first. The gateway sends the original request plus its own fixed system message
(`EMPTY_ANSWER_REPAIR_MESSAGE`): the previous answer ended after reasoning without a tool call or a
final answer, so call the next tool now or give the final answer, keeping any reasoning to a few
sentences. Its scheduled line carries `reason: "empty-answer-repair"`. The marks name how the repaired
attempt ended, whichever failure triggered the repair: `exhausted-again` (it spent the whole budget),
`empty-again` (it ended without any text or tool call), `failed` (it failed for another reason, or the
repair never ran). Gemma 4 31B streamed through LiteLLM (run `74202984158312182524609898190850427735`)
motivated this: turn 5 reasoned for about 4,500 tokens and ended empty, the coding runtime retried the
identical turn six more times, and the failed turns' reasoning stayed in the resent history. A coding
sidecar turn whose repair ended `empty-again` is answered as final to the runtime (ADR-0173), and the
sidecar drops that reasoning from every later request instead of resending it upstream: reasoning
fields of prior assistant messages and assistant messages that carry nothing but reasoning never reach
the gateway request, and `coding-sidecar.gateway.request-validated` records how many it dropped.

**End-to-end budget.** A buffered call as a whole is bounded by `providerRequestBudgetMs(provider)`
(`resilience.ts`): `(maxRetries + 1) × timeoutMs` plus 30 s before each retry reserves
all configured attempts and exponential backoff windows. A provider cooldown above 30 s consumes
the same fixed whole-call budget and may leave fewer attempts; it never expands the deadline. A retry
whose delay does not fit what is left of the budget could never run, so the call ends at once with
the last error (`gateway.retry.exhausted` with `reason: "budget"`, the delay and the remaining
budget) instead of sleeping the rest of it away. An attempt that starts with less than `timeoutMs`
left, after earlier attempts or provider cooldowns consumed that budget, runs under what is left.
A caller that builds its own deadline around a gateway call derives it from the same function; the
coding sidecar route adds a grace so the gateway settles its own timeout first. The budget never exceeds 2^31 − 1 ms (`MAX_TIMER_DELAY_MS`, `config.ts`): config validation holds each of its terms to that timer ceiling but not their sum, and a deadline armed past the ceiling fires at once, so the derivation clamps the sum, and the adapter's read deadline and the coding sidecar route clamp whatever bound they are handed (PR #3452 review). A stream read (`chatStream`) may retry a retryable startup failure only before delivering its
first non-empty delta or terminal response. Empty role deltas do not commit the answer. Once any
content is delivered, a failure is terminal: replay must never duplicate text or tool effects.
Startup retries use the existing retry executor, configured retry count, backoff, cancellation,
and activity-log events; every attempt reserves and settles its own spend budget. On a terminal response, the provider iterator closes, the admission and reservation settle, and completion evidence is emitted before `done` reaches the consumer. A consumer that stops reading at `done` without another `next()` or `return()` cannot strand a half-open probe, spend reservation or outcome line. A later iterator cleanup never duplicates settlement. Cancellation before the first attempt and early consumer departure release their admitted circuit probe without counting as provider recovery or failure. Every admission settles once and is bound to its circuit generation; old completions cannot release, close or reopen a later probe window. This applies to streamed and buffered calls, including spend refusal. Stream startup retries treat tool-catalog validation failures as terminal rather than replaying unchanged tool arguments. Half-open
circuit probes get one attempt. All attempts and delays share one `streamRequestBudgetMs`
deadline; each subsequent read receives only its remaining silence and total budget. Since #3591
streaming is NOT left unbounded either —
`Gateway.chatStream()` builds its own `StreamReadBounds` from the provider's (possibly
Coding-Workbench-raised) `timeoutMs`, floored to `GATEWAY_SILENCE_FLOOR_MS` for silence and
`GATEWAY_STREAM_BUDGET_FLOOR_MS` for the total read, and passes them to `adapter.callStream()` —
before that fix the call omitted bounds entirely, so a real adapter fell back to its own flat
`STREAM_IDLE_TIMEOUT_MS` (60 s, `openai-adapter.ts`, unchanged as the fallback for a caller that
still omits bounds) for silence and one whole-request `timeoutMs` for the total read, cutting off a
live generation and reproducing coding run 30's failure on every desktop chat stream, not just the
buffered path PR #3452 fixed. Until PR #3452 (2026-09-11) the provider's
`timeoutMs` reached the retry loop as the budget of the whole call, so an attempt that hung to its
timeout left no budget and a `TimeoutError` was never retried (coding run 23).

The Coding Workbench uses a local `coding-workbench` latency profile on its sidecar gateway calls.
That profile (`codingWorkbenchProviderTimeoutMs`, `resilience.ts`) raises a provider attempt below
`GATEWAY_SILENCE_FLOOR_MS` to it — the two constants are equal since #3591 raised the historical
90-second Workbench floor to match the universal silence floor, so a slow Workbench provider now
gets no special treatment past what every other interactive `Gateway.chat()`/`chatStream()` caller
already receives; a larger configured timeout is retained. The sidecar route derives its backstop
from the same effective timeout. Retrieval, indexing and voice retain their own, smaller per-call
floor (above). The gateway's body-free call-started line records the effective `timeoutMs` so a
slow self-hosted provider can be distinguished from a hung turn. **`latencyProfile` selects timeout
floors only.** It never selects the retry policy (the explicit `outagePolicy: "outage-window"`, which
only the coding sidecar route sets) and never the reasoning delivery (the explicit
`reasoningDelivery: "forward"`, below), so an interactive surface that borrows the profile for its
floors — the commit draft does — still fails fast and still receives its answer without the model's
reasoning (#3873, F23).

**The streamed chunk model and model reasoning (#3878, 2026-10-06).** `GatewayStreamChunk` has
three kinds: `delta` (answer text), `reasoning` (the model's own reasoning, which LiteLLM normalises
as `reasoning_content` for a reasoning parser behind vLLM and for Anthropic thinking; a server that
names it `reasoning` is read the same way) and the terminal `done`. Reasoning never enters
`content`: the normalized response carries it as `reasoning`, its UTF-8 size as
`usage.reasoningBytes`, and the provider's own `usage.completion_tokens_details.reasoning_tokens`
as `usage.reasoningTokens` when the provider reports it (never estimated). It passes the same
secret redaction as the answer, in a hold-back lane of its own, and a reasoning-only answer still
fails as output-exhausted or empty. The gateway hands reasoning only to a call that asks for it with
the explicit `GatewayCallRequest.reasoningDelivery: "forward"` (local, never serialized; only the
coding sidecar route sets it, beside the `coding-workbench` latency profile and the outage policy),
and only while the configuration's `codingReasoningDisplay` is not `"off"` (owner decision
2026-10-06: on by default, opt-out only); every other surface keeps its answer without reasoning,
whatever latency profile it borrows. Until #3873 (F23) the gateway keyed forwarding on the latency
profile, so the commit draft, which borrows the profile for its timeout floors, received the
reasoning too (`reasoningDisposition=forwarded` on its completion line); it now records `discarded`.
Discarded reasoning chunks are dropped where the provider stream is read, below the commit point:
a discarded thought is never a delivered chunk, so it neither starts the caller's answer nor ends
the startup retries. Forwarded reasoning does not commit the stream either (owner decision
2026-10-06, #3873 F17 option iii: a further reasoning passage is acceptable, answer text is never
duplicated): while a stream has delivered nothing but reasoning, its failure goes back to the call's
retry loop, which decides it exactly like a startup failure (#3873 review) — the one steered repair
described under "Steered repair of an exhausted or empty answer", a schema correction after a catalog
rejection, or a provider retry under the call's policy, the outage window included. A call forwards
at most two reasoning passages, the first and the steered repair's: any other attempt after forwarded
reasoning streams its reasoning undelivered, so a retried outage never repeats a passage. Only a
delivered answer delta or the terminal answer commits the stream; nothing is ever replayed after it.
Reasoning is a body: `chat.response.streamed` records its events and bytes, and
`gateway.chat.completed` and `gateway.stream.completed` record `reasoningBytes`, `reasoningTokens`
and `reasoningDisposition` (`none`, `forwarded`, `discarded`), never the text.

**Coding sidecar streaming (lab ledger F2, #3873, 2026-10-06).** The coding sidecar profile used
to be hard-coded as non-streaming, so the sidecar read a streaming provider in full before OpenCode
saw a byte. It now streams wherever the coding model's capability streams and the configuration's
`codingStreaming` is not `"off"` (default on): OpenCode receives each answer and reasoning delta as
an OpenAI-compatible SSE frame (`content`, `reasoning_content`) as it arrives, and the tool calls,
assembled from their fragments and bound against the catalog first, as complete `tool_calls`
deltas with their `index`. Usage and prompt settlement, the spend reservation and the completion
evidence still settle before the terminal `[DONE]`. The answer (text and tool calls) and the
forwarded reasoning are each bounded by the turn's output allowance in bytes, apart from each
other, so a reasoning model keeps its whole answer budget; the forwarded reasoning by two passages'
worth, the gateway's own cap. A stream cut at either bound ends `output-limit` with the bound named
(`limit`: `answer` or `reasoning`). A buffered answer is complete when it arrives: its reasoning
never refuses it — an oversized reasoning is withheld and the answer delivered
(`reasoningWithheld`). `codingStreaming: "off"` restores the buffered answer, and with it the
shared output reserve rather than the coding reserve, so a runaway whole-body attempt ends as an
exhausted answer the gateway repairs, not as a timeout the breaker counts.

**Circuit breaker.** One `CircuitBreaker` instance per `(modelId, baseUrl)` pair, keyed in a `Map`.
States:

- **Closed**: requests pass through. Consecutive failure counter increments on each `GatewayError`
  except the ones in `gateway.ts`'s `NON_PROVIDER_FAULTS` list — `CancelledError`,
  `ConfigInvalidError`, `MalformedToolCallError`, since #3591 `ProviderOutputExhaustedError`, and,
  since #3610, `ProviderEmptyAnswerError`: a reasoning model that spends its whole output budget on
  an HTTP 200 answer is a caller-fixable budget problem, not a provider failure, and must not open
  the breaker and lock out every other caller of that model. The same holds for an HTTP 200 answer
  that completed with neither content nor a tool call: the provider answered, the model produced
  nothing usable. It keeps the provider error code, so the chat surfaces are unchanged, and the
  coding runtime reports it as its own `empty-answer` turn-failure cause instead of a broken
  stream; an empty answer that carried reasoning first gets the one steered repair described above
  before it surfaces (#3873, F23). A stream that ends without any terminal frame is still a provider
  failure.
  `MalformedToolCallError` covers the model's own tool call that did not parse or did not match the
  tool's schema, including the catalog rejection `GatewayToolCatalogError` and the redaction-depth
  refusal `ResponseRedactionError`, which both extend it. The gateway still retries a schema
  rejection so the model can regenerate the call — on the buffered and, since the #3873 review, the
  streamed path alike: a streamed tool call is delivered only with the terminal answer, so a rejected
  one was never handed to the caller, and the next attempt carries the schema correction
  (`gateway.tool-catalog.repair state=scheduled`); a streamed rejection that carries no correction is
  never replayed as it was. The correction is decided when the attempt that carries it starts, on the
  retry loop's own attempt count, so a steered repair on top of the provider's attempts never leaves
  a rejection uncorrected or re-sends a stale correction. The provider answered every time: a lab run of
  1.1.8 behind a LiteLLM `hosted_vllm` route opened the breaker after five such calls and failed the
  run on `CircuitOpenError`. The coding runtime reports it as its own `invalid-tool-call`
  turn-failure cause, except the redaction-depth refusal: no tool call need be involved, so the
  coding runtime reports that one as `turn-rejected` and keeps its error-level diagnostic. A `TimeoutError` DOES count: with the silence and budget floors of #3591 a
  timeout is a multi-minute silence, which is the outage signal the breaker exists for. When counter
  reaches `failureThreshold`, transition to **Open** and record `openedAt = clock.now()`.
- **Open**: a fresh call without an announced provider cooldown immediately throws
  `CircuitOpenError` without contacting the provider. The existing per-model breaker retains an
  announced cooldown, so later calls wait for that minimum before requesting admission. Retry
  callers recovering from an announced cooldown also wait out the remaining breaker cooldown
  inside their original request budget; if admission cannot fit, they retain their own original
  provider error rather than replacing it with `CircuitOpenError`.
  Refused admission terminates retry accounting without inventing another provider attempt.
  A fresh blocked caller receives `CircuitOpenError`; an exhausted caller with no circuit
  blockage retains `TimeoutError`. Retryable parallel responses from the generation that opened
  the current outage may extend its announced recovery minimum. They cannot alter probe ownership
  or a later half-open, recovered or reopened generation. Terminal HTTP failures do not announce
  a shared recovery minimum, and waiters are notified only when admission state changes.
  When `clock.now() - openedAt >= cooldownMs`, transition to **Half-Open**.
- **Half-Open**: the next `halfOpenProbes` calls are forwarded as probes. Each success decrements the
  probe counter. When the counter reaches zero, transition to **Closed** and reset all counters. Any
  failure transitions back to **Open** immediately and resets `openedAt`.
  Recovering cooldown callers wait for a saturated probe slot instead of failing immediately.
  Cancellation, expiry and settlement dispose the wait timer and notification subscription.
  Generation checks still prevent an older admission from changing a later circuit generation;
  waiting and its outcome emit body-free `gateway.circuit.wait` lifecycle evidence. A blocked
  admission that cannot fit its caller budget records `budget-refused`, with the remaining budget
  and proposed delay, even when no wait timer starts.

Circuit state is observable via `gateway.circuitStatus(modelId): CircuitBreakerStatus`.

**Shared provider cooldown.** A retryable HTTP 429 or provider failure carrying `Retry-After`
announces a per-model recovery minimum even while the breaker remains Closed. Every later caller
using that breaker observes the same deadline, including after the announcing request ends.
Its duration is capped only by the platform timer ceiling (2,147,483,647 ms); the expired deadline
does not block later calls. A waiting admission samples positive jitter only when it encounters
an active provider cooldown, using `max(1, round(retryBaseDelayMs * random()))`. Retries use the
equal-jitter backoff ladder above. Both stay inside the caller's original whole-request budget.
An admission refusal retains the previous provider error when present; otherwise a blocked caller
receives `CircuitOpenError`, while an exhausted healthy admission receives `TimeoutError`.
Late Closed-generation failures may extend the outage they opened. Late half-open probes cannot
extend the outage reopened by a sibling probe or affect the next probe generation.

`gateway.circuit.wait` records reasons `provider-cooldown`, `circuit-cooldown`, or `probe-saturated`
and outcomes `started`, `timer`, `changed`, `cancelled`, `failed`, or `budget-refused`.
For saturated probes there is no proposed cooldown duration: `delayMs` records the remaining
request budget, including zero at refusal, rather than the platform timer ceiling. Stream lifecycle
starts before admission waiting and settles with a zero-chunk failure if admission fails.

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
| `config.test.ts` | Valid config file parses without error; missing `apiKey` field throws `ConfigInvalidError` with descriptive message; `timeoutMs: -1` throws `ConfigInvalidError`; `KEIKO_DEFAULT_API_KEY` env var is applied; `toSafeObject()` output does not contain `apiKey` or provider `baseUrl` fields |
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
