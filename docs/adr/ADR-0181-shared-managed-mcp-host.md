# ADR-0181: Shared managed MCP host and governed consumers

## Status

Accepted architecture (2026-10-26, Epic #4081, Issue #4089). Implementation and acceptance
are tracked separately in [the AC matrix](../qa/jira-chat-pods-4081.md). The initial
protocol package does not establish completion of the consumer/binder integration.

## Context

Ordinary Chat needs governed Jira tools. The existing operator MCP registry serves
OpenCode, which owns its client; it cannot supply Chat with an in-process governed
provider. Keiko already owns the catalog, binder, authority, connector custody and
Activity Log. Those remain the execution and policy owners.

## Decision

### D1 — One shared protocol boundary

`keiko-mcp` depends internally only on contracts and security. Only this package may
import official `@modelcontextprotocol/*` packages, enforced by both import policy and
dependency-cruiser with negative fixtures. Split client/server 2.4.0 is pinned exactly.
The package receives provider and log ports; it does not own credentials, Jira HTTP,
policy, the catalog or conversation storage.

A single host entry and SDK client serve managed providers through the official
`createMcpHandler`. The SDK's per-request factory creates a short-lived server instance
for each protocol exchange. That is request isolation, not a server/process/listener or
configuration per Pod. The injected fetch invokes the handler directly and refuses any
other address or method. The internal `.invalid` URL is never dialed.

The server dependency graph now owns one lazy managed Jira catalog. Concurrent callers
share its initialization and admitted descriptors. Disposal closes that same host before
closing the graph's remaining services; closure before/during initialization refuses
late consumers. Independently assembled application graphs remain isolated. Connection
selection uses the private invocation context and current Chat authority, then obtains
the existing generation-bound custody HTTP port with its final dispatch guard. Catalog
discovery itself performs no credential resolution or Jira HTTP. Ordinary Chat turn
orchestration remains separate acceptance work.

### D2 — Explicit modern protocol and bounded capabilities

Both serving and client negotiation select `2026-07-28`; the client pins the revision
and the handler rejects legacy requests. SDK defaults and linked legacy transports do
not qualify this protocol. Tests exercise real discovery, listing and invocation and
assert the modern era and per-request metadata.

Automatic input fulfillment and reconnection retries are disabled. No sampling,
elicitation, resource, prompt or task integration is registered. Unsolicited protocol
behavior cannot create additional model calls or retry a handler. Request/result sizes
are bounded. One invocation deadline covers uncached listing and calling together.
Caller cancellation, host shutdown, request cancellation and the SDK handler signal
are combined in the provider context and its final before-effect guard; settlement
revokes that guard. A timed-out caller cannot leave a delayed provider authorized.

Provider handler references are captured with the initial metadata and served from
immutable host-owned bindings. A provider must return stable functions across
registration queries. Replacing a handler while retaining its name/schema/digest is
still drift and requires a new host/admission. The host rechecks this continuity at
execution and on both sides of the final consumer effect guard, including delayed
handlers. Handler functions are never exposed in catalog metadata or serialized into
protocol/evidence payloads.

### D3 — Trusted context stays outside the protocol

Server composition resolves consumer identity, binding generations, authority and
credentials. Invocation-local asynchronous context transfers the trusted object to a
request-keyed weak map; each SDK factory captures only that request's context. No
current-Pod global exists. Arguments cannot replace routing, credentials, binding,
authority or MCP metadata. Ordinary URLs in supported field data remain data.

The existing catalog binder is parameterized by consumer context, action and effect
guard. Its Coding adapter retains workspace identity and the exact native-read
exception. Other consumers supply their own strict action decoder and private scope
projection; they need no Coding session or synthetic workspace. The binder captures
the decoder functions and hashes a bounded scope projection when offering and
admitting work. That captured scope participates in request identity and continuation
cursors and is rechecked before effects, including after a newer offer is issued.
Coding keeps `workspace-stale`; other consumers use the closed `consumer-stale`
result. Both use the existing invocation records, budgets, settlement and Activity Log.

### D4 — Catalog and binder remain authoritative

Provider declarations carry canonical descriptors and descriptive read/write hints. A
read can still require a durable server invocation key; idempotency accounting is not
a substitute for risk or authority. Write hints require server-key accounting. Neither
MCP annotations nor provider prose grant permission. Admitted declarations are captured;
subsequent declarations and actual uncached SDK listings must match. Drift fails closed
before a handler call. The model receives only compiled catalog projections through the
existing gateway bridge. Server composition must dispatch binder → MCP → domain handler;
MCP does not authorize an invocation or replace the binder's result-envelope validation.

The existing binder is generalized through consumer-specific action/authority/approval
ports, preserving the Coding adapter and every workspace guard. It admits the tool,
revalidates binding/generations and authority/mode, redeems grants or approvals, reserves
existing budgets, executes, settles once and records the lifecycle. Redemption rechecks
all boundaries immediately before the effect. No synthetic Coding workspace is created
for Chat. This wiring remains an explicit acceptance requirement beyond the protocol
package itself.

### D5 — Effect uncertainty and evidence

The host never automatically repeats an invocation. Protocol or handler failure does
not establish absence of a remote effect. Domain handlers and the existing invocation
owner retain durable intent and observed outcomes; confirmed, unconfirmed, rejected and
unknown-effect states remain distinguishable. Arbitrary provider errors are replaced
before the SDK can render them into content. Explicit structured provider failures are byte-bounded, captured before asynchronous validation and checked against the admitted result schema, including when MCP marks the result as an error. Their immutable data is available only through a non-enumerable error accessor; error messages and Activity Log records retain only closed classifications. Consumer result settlement must preserve the distinction between protocol failure and the observed remote effect.

The ordinary Chat consumer exposes all admitted Jira read and mutation declarations through
that same catalog. Mutation execution receives the existing credential owner's HTTP port
factory, never a raw token resolver. Every metadata and confirmation read rechecks current
authority and the Chat read grant. The exact action approval is claimed atomically inside
the durable journal's dispatch boundary, immediately before the first mutating HTTP request;
metadata reads and duplicate deliveries cannot consume or reapply that claim. Full access
uses the same boundary with its currently validated allowed disposition.

HTTP acknowledgement is recorded before parsing a response or evaluating late cancellation.
A cancelled or denied catalog result retains its original closed envelope and null data;
its separately validated, canonical journal observation is retained as `mutationOutcome`
on the existing Chat exchange. The same projection reaches the live model continuation,
reloaded history, compaction, and result card. Approval state reports consent only and does
not imply a remote effect. A failed UI decision request requires an explicit state refresh;
it never causes an automatic mutation or approval POST retry.

When a Jira acknowledgement arrives after the Chat has already ended, message projection
reads the existing durable turn journal and matches the original message, invocation,
operation and exact arguments. It folds that later observation beside the unchanged
catalog envelope, including after reopening the store or when no catalog result was
saved. Current authority is not reacquired to display a historical effect. This read
path neither dispatches nor permits retry; prepared active work remains pending.

A failed pre-effect log write fails closed. A failed terminal write never changes an
already observed execution outcome: it increments the existing process-wide Activity
Log loss ledger, whose registered heartbeat/exit summary reports missing evidence.
It does not trigger another tool call or invent an execution failure.

Registered `mcp.managed.lifecycle` events contain closed phases/reasons, counts, the
admitted declaration digest and opaque correlation/invocation identities. They contain
no arguments, results, endpoints or credentials. The existing Activity Log owns writing
and reconstruction; the host has only an injected port.

### D6 — Compatibility and scope

The operator `mcp-servers.json` grammar, credential relay, OAuth and OpenCode behavior
remain owned by ADR-0137. Managed providers are declared by server composition and do
not add registry entries. Exposing them to OpenCode or external MCP clients and migrating
other sources are outside this epic. Retrieval, citations and conversation budgets
remain owned by their existing paths.

Mixed Chat turns create that same accepted-turn authority before continuity, memory and
retrieval preparation. Existing grounding owners assemble their evidence packs before
productive Jira orchestration. Every gateway attempt retains its cumulative token and
time charge. Only the exact, fully observed tool-call response releases its provisional
synthesis slot; discarded, failed or ambiguous attempts retain theirs. The final answer
and citation repair share the existing two-attempt synthesis ceiling. Jira results stay
in the tool transcript and are attributed separately from connected-evidence citations.
`chat.grounded-tool-round.completed` records that phase and remaining synthesis count
without source content. Data-only preparation and synthesis keep their existing path.

Grounded mixed responses use the existing buffered transport and canonical turn owner.
The ordinary streaming endpoint returns `STREAMING_UNSUPPORTED` before admitting a mixed
turn, and the client follows its existing buffered fallback. That fallback and any replay
share the canonical identity; neither dispatches a second remote mutation. Pending read
consent and exact write approvals remain visible through the existing canonical-row GET
observer while the buffered grounded request is running.

## Verification

Protocol, declaration drift, schema refusal, context isolation and cancellation tests
use the real SDK path. Architecture fixtures prove both the import isolation and the
contracts/security package boundary. Registered producer-line and analyzer proofs,
production non-Coding binder coverage, Workbench regressions and the complete dependency,
package and release gates are required before final acceptance.


The ordinary Chat consumer retains one bounded invocation loop per accepted human
turn, including context-window retries. Its gateway physical-attempt hook charges
shared authority budgets before dispatch and settles observed usage once. Catalog
transport wrappers have a separate fixed depth allowance; each descriptor/schema and
all model arguments retain their original bounds and closed validation. Historical
completed tool results retain their validated descriptor/projection snapshot privately
in the existing Chat row; the public serializer omits that qualification metadata.
