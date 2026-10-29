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
orchestration uses the shared bounded loop with provider-specific admission adapters;
complete acceptance remains tracked separately from this architectural decision.

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

The operator `mcp-servers.json` registry, credential relay and encrypted MCP vault remain
shared by ordinary Chat and OpenCode. Settings own configuration and sign-in for external
servers. Server composition owns one OAuth lifecycle and connection owner; the official SDK
inside `keiko-mcp` performs resource/issuer discovery, PKCE and token exchange. The configured
issuer must match protected-resource metadata and validated authorization-server metadata.
Both RFC 8414 and OIDC discovery remain supported. Explicit public client IDs (including
configured metadata-document IDs) or the SDK's legacy dynamic registration path are used;
Keiko does not publish a new public metadata service.

Each sign-in attempt has a private one-use IPv4 loopback callback, separate random OAuth state,
app-session ownership, a five-minute expiry and configuration-generation cancellation. Callback
issuers are validated before code exchange. SDK credentials live in a separate namespace of the
existing MCP vault, bound to server, exact resource, issuer, client and requested scope. Opaque
legacy runtime credentials are never interpreted as SDK tokens; those installations sign in again.
Refreshes are coalesced per current server generation and occur before dispatch. Authentication
failures never replay an MCP tool call. Native production runs consume OAuth servers through the
same run-bound relay as other configured servers; external tokens never enter their configuration
or credential database. The standalone legacy runtime OAuth adapter remains compatibility code.

Successful sign-in and explicit sign-out rotate a durable per-server `credentialGeneration` and
the registry revision. Old connection/relay generations and Chat disclosures become stale while
unrelated server connections remain usable. Removing or changing an OAuth target removes orphaned
central ciphertext through the existing Settings reconciliation; unchanged disabled definitions
retain credentials for explicit later re-enablement. Terminal logging loss never changes an
observed authentication outcome. Registered `mcp.authorization.state` evidence contains only
closed states, opaque attempt identity and completeness/loss/count fields; OAuth state, tokens,
verifiers, endpoints and provider responses are excluded.

Managed Jira providers remain server-composed and require no operator registry entry. Retrieval,
citations and conversation budgets remain owned by their existing paths.

Settings extend the same registry additively: explicit automatic discovery permits an
initially empty tool map, and local secret environment entries use references instead of
literal credentials. Existing explicit tool maps retain their admission semantics. Discovery
never grants execution authority. Server names accept lowercase letters, digits, underscores
and hyphens; ambiguous native action identities across servers are refused. External tool
names retain the MCP grammar through 128 characters. Native action admission allows the full
64-character server name plus separator and 128-character normalized tool name (193 total);
length admission never replaces the exact server/tool grant.

Static credentials reuse the existing MCP encrypted vault in a separate reference namespace.
References are immutable and sealed values are bound to the server name and exact remote
target or local command/environment. Settings writes compare the caller's registry revision,
validate the complete document and use the existing atomic private-file writer. Concurrent
requests in the owning BFF cannot silently overwrite each other. A malformed operator file
is unavailable, never an empty editable configuration. Protocol negotiation and SDK imports
remain in `keiko-mcp`; consumer authority, discovery admission and lifecycle invalidation
remain server responsibilities.

An enabled legacy reference that actually falls back to the BFF environment makes the
Chat configuration revision process-scoped. The existing Settings owner combines its private
startup nonce with the durable registry revision; it never hashes credential values. Persisted
Chat disclosures therefore require fresh acceptance after restart, even when the reference
name is unchanged. Reference metadata identifies sealed values without decrypting them;
vault-only configurations, unused environment variables and disabled connections retain their
stable revision. Unavailable vault metadata fails closed to a process-scoped context. Moving
an active legacy value into the vault requires a fresh reference, like any other credential
replacement: the atomic registry generation then changes together with the reference, so a
crash between vault and registry publication cannot revive an earlier disclosure.

External servers use the same package's SDK client adapter with automatic protocol-version
negotiation. Streamable HTTP is the modern remote transport; explicit legacy HTTP+SSE and
local stdio preserve compatibility with existing servers. Process launch parameters and HTTP
egress are admitted by server composition. The adapter bounds discovery/payloads, rechecks uncached declarations before each call, validates
arguments, keeps invocation context out of MCP arguments, rechecks authority at dispatch and
never replays a tool call after a transport failure. Local stdio explicitly overrides the
SDK's inherited environment defaults; credentials remain in memory at the launch boundary.
The default executable search path includes the configured program's own directory and the
platform's minimal system directories, never the parent process's PATH. Windows keeps the
validated system directory for DLL lookup and uses the private connection directory for
profiles and temporary files. Explicit Windows environment keys are case-folded; collisions
fail closed. Registry paths accept fully qualified drive paths as well as POSIX absolute
paths; UNC shares, device namespaces and drive-relative paths remain denied.
The execution boundary additionally requires the native host path form; a Windows root-relative
POSIX-looking path never inherits the current drive. Local stdio runs behind a byte-preserving
lifetime owner: ordinary POSIX descendants share an owned process group; Windows uses the existing
digest-admitted native supervisor with a non-breakaway, kill-on-close Job Object before launching
the Node owner. Interpreter and loader variables are encoded for the provider, so they cannot
execute inside the lifetime owner. The native owner is an MCP host-process lifetime scope, not a
Coding sandbox or a grant of Coding authority. Windows installations without an admitted owner
report local MCP as unsupported and continue to support remote transports. Daemonized provider
services should use remote MCP; the POSIX process group is not a sandbox against deliberately
escaping operator-trusted code.

Legacy resource URLs containing access_token are normalized by Settings into the existing
encrypted Authorization-header custody before they can be returned or persisted. Startup applies
the same migration. OAuth-configured entries remove the obsolete URL bearer and use their bound
authorization instead. Conflicting or repeated bearer sources fail closed; the protocol adapter
refuses any remaining bearer query URL before network dispatch.

The configured connection owner shares one client per current server definition. Registry
commits synchronously abort the old generation when its server changes, is disabled or is
removed; calls recheck the durable registry before dispatch and before releasing results.
Application shutdown closes these clients. The Settings connection check performs discovery
only, persists a validated tool map with revision comparison and treats unknown tool risk as
write; descriptive remote annotations do not confer authority. Consumers still require their
own catalog admission before invoking any discovered tool.

Settings displays a response-only projection of that existing connection owner: disabled,
idle, connecting, connected or failed, with the actual discovered tool count. Inspection
never starts a transport. SDK close or tool-list drift invalidates the affected live entry
and pending consumer consent immediately. A possibly lost invocation response alone does
not disconnect unrelated consumers. Discovery that changes the stored tool map must reconnect
under its committed generation before returning connected. The UI renders current server
facts, marks unavailable observations explicitly and never persists a local connected flag.
Editing preserves manual admission and existing credentials only for their original target;
a changed endpoint or local command requires fresh credentials for that target.

Remote traffic uses the existing gateway egress with DNS/proxy pinning, TLS verification and
redirect refusal. An explicit private-network selection admits only the configured private
resource; loopback and metadata addresses remain denied. Legacy SSE can address messages
only within the configured origin and resource directory. Local `.env` imports use Node's
literal parser, seal values in the existing vault and store references, never source file paths
or file contents. Empty environment values remain non-secret literals.

A Chat may use its bound Jira Pod and configured MCP servers in the same turn. Server
composition recompiles their admitted descriptors into one catalog projection and uses one
binder and one Chat tool loop. Provider adapters retain the existing credentials, grants,
approvals and mutation journals; neither the model nor tool arguments choose an authority.
Before execution, the existing authority registry atomically retains the complete source
set for the canonical user message. Both envelopes must agree on actor, Chat, mode, ceiling,
deadline and limits, and share the same cumulative usage object. Re-registration cannot add,
remove or replace a source or reset its budget. Current facts for both sources are rechecked
before model work and each effect; revocation terminates authority across the accepted set.
The transcript retains one current read-consent view per source kind, with its legacy
single `readGrant` field projecting the latest update. Existing single-source transcripts
and execution paths remain valid.

Mixed Chat turns create that same accepted-turn authority before continuity, memory and
retrieval preparation. Existing grounding owners assemble their evidence packs before
productive Jira orchestration. Every gateway attempt retains its cumulative token and
time charge. Only the exact, fully observed tool-call response releases its provisional
synthesis slot; discarded, failed or ambiguous attempts retain theirs. The final answer
and citation repair share the existing two-attempt synthesis ceiling. Jira results stay
in the tool transcript and are attributed separately from connected-evidence citations.
`chat.grounded-tool-round.completed` records that phase and remaining synthesis count
without source content. Data-only preparation and synthesis keep their existing path.

An empty connected-evidence pack still permits the already admitted Jira turn to run.
When neither governed Memory context nor the existing own-assessment policy permits an
answer, that exception requires a successful usable tool observation published to this
turn's model continuation. Successful empty results are observations; denied, failed or
unavailable results preserve deterministic Data-only abstention even if the model invents
facts. Their structured cards remain visible. Jira observations carry no Data citations. Missing or denied source paths retain their existing failure behavior.
This exception never changes Memory admission, capture mode, or its deployment ceiling.

Grounded mixed responses use the existing buffered transport and canonical turn owner.
The ordinary streaming endpoint returns `STREAMING_UNSUPPORTED` before admitting a mixed
turn, and the client follows its existing buffered fallback. That fallback and any replay
share the canonical identity; neither dispatches a second remote mutation. Pending read
consent and exact write approvals remain visible through the existing canonical-row GET
observer while the buffered grounded request is running.

Accepted read disclosure consent is retained in the existing private SQLite store by the
existing approval registry, bounded by the original subject, disclosure version, proof
and expiry. Its originating turn reference remains provenance, not an execution lease
restored after restart. A later turn must independently pass its current authority,
custody, generation, model-capability and budget checks. Pending decisions still require
their exact live origin authority and are revoked during shutdown. Lifecycle revocation
persists; clean shutdown preserves only already granted consent. No turn authority,
usage budget or pending write approval is restored from this record. Consent waits observe
the turn's composite cancellation signal, including a shorter synthesis budget. Cancelling
unfulfilled consent or an unclaimed write revokes that decision; already granted read
consent remains governed by its original expiry and current authority checks. Shutdown
also drains local waiters when a concurrent registry has already advanced the durable row.

If the process stops between the private consent commit and its transcript acknowledgement,
history reads project the decision only onto the exact originating canonical message and
matching grant identity, generations, disclosure and expiry. The projection never changes
the stored transcript or resumes its turn. Existing read-grant observation events retain
the grant proof and a message-hash correlation without exposing private subject details.

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

## Centrally configured external MCP servers (#4081)

The same package owns SDK clients for configured stdio, Streamable HTTP and legacy SSE servers.
Server composition shares their connections and obtains credentials from the existing vault only
at the transport boundary. Native OpenCode reaches these connections through its existing,
run-bound MCP relay; its configuration contains a revocable relay capability, never provider
credentials. Disabling or changing a server invalidates that generation and its relay capabilities.

A native managed MCP write requires the owning run's recovery callback before dispatch. A lost,
malformed or error result after invoking the write, including observed cancellation, synchronously
revokes all MCP relay capabilities for that run and asks the existing authority lifecycle to revoke
and enter recovery. One run-local recovery promise prevents duplicate recovery actions; other runs
and shared connections remain available. The existing active-run snapshot reconciliation handles
restart admission. The existing lifecycle event queues `recovery-required` before revocation;
the orchestrator persists that state and retains it across late stop/failure events. Recovery
requires the existing explicit human acknowledgement and fresh-retry boundary.

Native mutations use the existing durable mutation journal and real Coding History user-message
and run bindings. The identity combines the producer's run, session, message and call identifiers
with server, tool and canonical argument digest. The native permission request carries the
configured MCP tool's exact arguments privately; the relay joins only one matching prepared call
and rechecks the current native authority immediately before dispatch. The relay records an
observed MCP success before forwarding it. A lost response, restart or new model call cannot
create a second effect while that outcome remains unconfirmed.

Confirmation comes from the existing committed producer-history tool settlement, after content
normalization and the containing Code Mode program finish. The earlier `execute.after` hook is
insufficient: OpenCode 2.1.4 normalizes content afterward, and inner calls share their enclosing
program's call identity ([producer tool execution](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/tool.ts),
[Code Mode execution](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/codemode/tool.ts)).
Different admitted inner actions may proceed sequentially within that exact parent call; identical
inner actions remain once-only. The existing history parser recognizes an outer program error even
when its tool part says `completed`. Such failure retains `succeeded-unconfirmed`; a missing provider reply
retains `unknown`. A new model call cannot pass either barrier. Successful persisted completion
settles every observed mutation of that parent, allowing new calls afterward.

Schema 54 retains the single physical-dispatch index and unchanged Chat behavior while permitting
multiple observed native results to await their shared parent completion. The transaction enforces
the exact parent identity. Internal continuations retain their accepted human-turn binding and
cannot reopen a closed one. Native slash-command writes remain unavailable until the actual
producer user-message identity is bound; ordinary human prompts use their stable submitted ID.
No synthetic Chat rows, secondary effect journal or public evidence fields are introduced.

Because separate inner MCP actions reuse the producer's parent call ID, each received permission
check receives a server-generated budget identity bound to its permission and bounded arguments.
Even identical physical reads consume separate calls. Rechecking that same request consumes no
second reservation. Schema 54 retains the first admitted budget identity with the existing native
mutation receipt, so final relay admission uses the same reservation. This identity never changes
the canonical mutation ID, and a repeated permission request cannot replace it. Legacy receipts
remain readable; missing budget identities refuse new native dispatch. Only hashes are retained.

A server-managed stdio provider runs outside the coding process's workspace sandbox. Its actions
therefore use the external-effect policy, just like a managed HTTPS provider: Ask for approval and
Supervised workspace require the existing action approval; Full access may act within its validated
authority. The relay uses the already admitted loopback gateway route. This capability does not
relax the coding process's network sandbox or the Full access restriction on direct external
connections, including the existing native OAuth path.


Ordinary Chat also consumes this Settings-owned catalog. Its consumer uses the existing
accepted-turn authority and a configured-MCP subject (actor, Chat and configuration identity),
without a Coding session or Jira Pod identity. Read disclosure and exact write approvals reuse
the existing registry and authenticated routes. The common bounded Chat loop owns model
attempts, tool calls, transcript pairing and cumulative budgets; provider adapters supply
catalog admission and durable mutation outcomes. The existing mutation journal stores MCP
protocol acknowledgement without an invented HTTP status. Unknown effects remain non-replayable.

External schemas follow the explicitly separate JSON Schema dialect described in
[ADR-0175 D3](ADR-0175-canonical-governed-tool-catalog.md#d3--digest-inputs-and-compatibility).
The adapter preserves admitted remote schemas and validates actual arguments and results;
it does not strip unsupported constraints to make a server connect. Internal closed schemas
retain their existing contract. External schema complexity, references and patterns are
bounded before compilation, with no remote schema fetches or execution of schema-supplied code.
