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

### D3 — Trusted context stays outside the protocol

Server composition resolves consumer identity, binding generations, authority and
credentials. Invocation-local asynchronous context transfers the trusted object to a
request-keyed weak map; each SDK factory captures only that request's context. No
current-Pod global exists. Arguments cannot replace routing, credentials, binding,
authority or MCP metadata. Ordinary URLs in supported field data remain data.

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
before the SDK can render them into content.

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

## Verification

Protocol, declaration drift, schema refusal, context isolation and cancellation tests
use the real SDK path. Architecture fixtures prove both the import isolation and the
contracts/security package boundary. Registered producer-line and analyzer proofs,
production non-Coding binder coverage, Workbench regressions and the complete dependency,
package and release gates are required before final acceptance.
