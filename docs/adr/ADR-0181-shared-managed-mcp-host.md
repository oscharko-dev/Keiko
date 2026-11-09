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

The server dependency graph owns the lazy managed Jira discovery catalog. Concurrent callers
share its initialization and admitted descriptors. Ordinary Chat can select a narrowed operation
catalog through the same managed-host implementation; the turn closes each replaced selection
after its in-flight round settles, and graph disposal also closes outstanding selections.
Closure before/during initialization refuses late consumers. Independently assembled application graphs remain isolated. Connection
selection uses the private invocation context and current Chat authority, then obtains
the existing generation-bound custody HTTP port with its final dispatch guard. Catalog
discovery itself performs no credential resolution or Jira HTTP. Ordinary Chat turn
orchestration uses the shared bounded loop with provider-specific admission adapters;
complete acceptance remains tracked separately from this architectural decision.

**On-demand Jira schemas (#4287, #4290).** A Chat initially offers `jira.discover`,
`jira.describe` and the existing Knowledge tools. Discovery pages the closed registry of
implemented operations; it does not advertise the unimplemented API inventory as executable.
Describe accepts only exact registry identities and prepares the selected typed tools for the
next model round. A describe replaces the previous additional selection; its result names
every previously selected operation it drops (`deselected`), so a model never loses a tool
without being told. The selection activates only after that describe invocation completes;
failed or timed-out candidates are closed. Neither metadata operation performs Jira HTTP.
Each round still uses the normal authority-filtered binder offer and the same accepted-turn
invocation registry, so selection cannot grant authority or replay earlier effects. Other
connected tool sources remain present when the Jira subset changes.

Schema admission counts the actual offered definitions with the gateway's prompt-token
accounting, including the retained conversation, output reservation and safety margin, against
both the selected model's context and remaining turn budget. A subset that cannot fit is refused
without truncating its schemas. Discovery returns an explicit next-page position when only a
prefix fits. The existing MCP and catalog admission limits remain unchanged.

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

Internal managed invocation duration follows the validated, captured tool descriptor, bounded
by `TOOL_CATALOG_LIMITS.maxDurationMs` (the native timer ceiling, 2^31−1 ms). The host clamps
defensively and passes explicit inactivity and total timeout bounds to the SDK. There is no
additional fixed 30-second internal host ceiling or implicit SDK-default timeout. The external
MCP client keeps its own adapter bounds: a 30-second inactivity budget that a server's progress
notification resets, never beyond a 300-second hard cap (see the external client section below).
External read descriptors declare 60 seconds, and write descriptors add the approval TTL; the
catalog settlement ends the call at that declared duration, so progress cannot carry a catalog
call past its descriptor, and the adapter cap is only the outer bound. Neither the declarations
nor progress can widen the adapter cap. Earlier caller cancellation and the enclosing task or authority deadline still end
the invocation. Caller arguments and metadata cannot extend these bounds. Semantic Knowledge
review reuses the gateway's normal buffered model-call bound; it adds no shorter inner
model deadline. The active model's canonical context profile supplies its output reserve, still
bounded by provider capacity, context fit and the enclosing caller and turn grants. Ordinary
internal tools retain their own declared durations.

Application-initiated corpus receipts use the same synthetic assistant tool call and tool-result
pair as model-initiated observations. Pod metadata never gains a user role. Runtime provenance
remains inside the active turn's explicit dispatch path; provider-controlled ids cannot assert it.
Persisted calls retain only `id`, `name` and `arguments` for compatibility with the previous reader.
Legacy `origin` metadata remains readable but is removed from public projections and every write.
Rollback compatibility covers transcripts written by the corrected writer. Untouched local
pre-release records containing `origin` are not rewritten by a read; they need a normal write
through the current version before the previous build can read those records.

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

Knowledge document and requirement `nextCursor` values locate source pages; they are
not invocation grants. They reuse the existing requirement-inventory cursor codec.
Following one starts a new admitted catalog invocation, with current source selection,
authority, cancellation and fresh budget checks. Re-reading a page consumes another
invocation; the cursor checksum grants no permission. `CatalogContinuation` instead
resumes one captured catalog request and binds its exact request digest, reservation,
single-use state and short expiry. Using that reservation cursor as a document position
would conflate two different lifecycles. Source-position cursors therefore remain data,
while the existing catalog continuation and authority boundaries remain unchanged.

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
uses the same boundary with its currently validated allowed disposition. The one hundred thirty-seven source-defined
administration writes additionally require the explicitly selected `issue-tracker.admin` scope
defined in ADR-0128 D4. A Chat scope change advances the existing binding generation and revokes
earlier approvals; neither schema selection nor Full access supplies administration authority.

Five administration observations retain read effects: three anonymization diagnostics and
metadata-only email-template export have low risk; protected license validation has high risk.
The fixed ZIP byte port uses the existing request lifecycle
and never exposes template bytes to the model or log. File snapshots follow the existing mode-derived
authority: private immutable snapshots in allowed mode and reviewed snapshots where approval is
required. Global template replacement, base-URL consequences and scheme-wide effects cannot be
confirmed from partial configuration readbacks. Exact draft configuration never means publication;
no alternative transport, approval store or replay owner is introduced.

The next native directory/schema/maintenance/issue actions retain the same owners and append
forward-only V76. Native role CAS, fixed named-user forms and scoped experimental requests are
private transport choices, never model headers or alternate dispatch. Known actor and target
identities are distinct. Existing formal rules judge actual schema/type/link impact; group and
maintenance observations do not invent direct membership, complete populations or deployment.
Only seven of the35 actions can confirm bounded configuration; twenty-eight remain unconfirmed.
The existing identity-observation owner handles only exact documented permission/WebSudo401
methods/paths after a current positive identity probe, preserving actual denial and no retry.

HTTP acknowledgement is recorded before parsing a response or evaluating late cancellation.
The fixed Jira request owners share one private admission wrapper over the existing bounded HTTP
executor. Each actual HTTP attempt, including a GET retry, requires synchronous current admission.
Local authority refusal, caller cancellation and the separately bounded phase deadline retain
`effect-denied`, `cancelled` and `timeout`. Actual native acknowledgements and HTTP failures retain
precedence over late cancellation; unexpected implementation errors propagate to existing diagnostics.
The durable journal continues to decide effect uncertainty and replay refusal. Model guidance for a
local refusal follows the recorded outcome, with uncertain effects taking precedence. Report readers
use the same admission owner and retain unknown totals in both exports and result cards.
A cancelled or denied catalog result retains its original closed envelope and null data;
its separately validated, canonical journal observation is retained as `mutationOutcome`
on the existing Chat exchange. The same projection reaches the live model continuation,
reloaded history, compaction, and result card. Approval state reports the decision only and does
not imply a remote effect. A failed UI decision request requires an explicit state refresh;
it never causes an automatic mutation or approval POST retry.

An interrupted Jira draft retains already parsed acknowledgement keys separately as bounded
`draftProgress` on its existing parent Chat exchange. The server-private snapshot reuses the
existing draft result projection and its counts/ranges, runs through the same credential/content
floor and admitted result schema, and preserves an acknowledged but unread-back key as uncertain.
The catalog's timeout/cancellation envelope and null data stay unchanged. Only this invocation's
captured receipts are displayed in the deadline answer, live continuation, history and compaction;
no recovery read or repeated write runs after expiry. The mutation journal and Activity Log keep
no issue keys or provider bodies. This additive transcript field is readable by current readers;
older builds with exact-key transcript validation cannot read affected rows without an explicit
compatible migration, so rollback compatibility is not implied.

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
Restored SDK grants require a finite, non-negative stored expiry. Zero explicitly represents a
token without a server-provided lifetime; missing or malformed expiry requires sign-in again.
Refused expiry metadata does not discard a known token from the bounded credential-redaction
floor. Malformed or oversized historical credential floors refuse restored authority before any
network effect.
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

**A Jira Pod for a Coding run (owner decision 2026-10-30, #3907).** A Coding run can reach Jira
through the same managed provider, host and relay, with no second host, policy layer or connector.
The human picks one Pod explicitly in the Workbench composer (`jiraPodId` on the start request;
none keeps today's behaviour). The pick is the run's Jira read grant: every read tool in
[`JIRA_MANAGED_READ_TOOLS`](../../packages/keiko-contracts/src/jira-tool-fields.ts) is allowed in all
three modes. Ordinary admitted write tools keep following the mode: Ask for approval and Supervised workspace ask through the
existing approval channel, Full access is allowed inside the validated Authority Envelope. Hard
denials stay mode-independent and fail closed with zero HTTP. Administration is a separate
explicit composer opt-in, transmitted as `connectorScopes: ["issue-tracker.admin"]` and bound by
the existing start confirmation. Absent opt-in grants no administration in any mode; legacy
requests and selecting a Pod alone preserve that absence.

The start resolves the Pod before the one-use start confirmation is consumed: it must be the
caller's own (server principal) and ready, on a native `keiko-sidecar` run with the managed relay;
otherwise the start is refused as `invalid-intent` with a closed reason (`pod-not-found`,
`pod-not-ready`, `unsupported-runtime`, `unavailable`). The Pod, its credential generation and
its verification revision join the confirmation claim, so the binding cannot be swapped, and they
are the `credentialGeneration` of the run's synthetic server definition (`jira`, a placeholder
remote URL naming the Pod), which therefore also enters the native mutation journal's
configuration digest. A registry server named `jira` is not admitted into such a run. The
definition is never written to the operator registry and carries no credential.

`ConfiguredMcpConnections` is wrapped per run: every other server is served by the shared
connections, `jira` by a run-bound managed host under its current scope authority (descriptor drift, result
validation, deadlines and `mcp.managed.lifecycle` are the host's), reached through
`createMcpRelayEndpoint`. Discovery and every effect use the registered run envelope and the canonical tool-to-scope
mapping. Every request also re-checks that the Pod is still exactly
the credential the human chose; a replaced token, re-verification, deletion, unfinished custody
work or another owner ends the binding (the relay capability is revoked, later calls perform no
request). Writes pass the relay's existing durable mutation permit before dispatch; a write that
does not complete is an uncertain mutation, and the run enters the existing recovery.
The relayed connection may carry server-owned `instructions`, which the relay announces on
`initialize`; the Jira Pod connection uses it for the shared Jira tool rules (ADR-0128 D4, #4178).
An external server's own instructions are untrusted metadata and never fill that field.

Evidence is `coding-runtime.jira-pod` under the run's correlation: the binding decision at start
(`bound` or `refused` with the closed reason) and one line per call or refusal with the closed Jira
tool and its risk. It carries no Pod id or name, URL, issue key or text. The Pod owner, credentials
and `AtlassianCredentialCustody` are unchanged and never leave custody.

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
The transcript retains one current read-grant view per source kind, with its legacy
single `readGrant` field projecting the latest update. Existing single-source transcripts
and execution paths remain valid.

**Knowledge-only Chat tools (owner correction 2026-11-05).** A Chat with attached Knowledge
Pods has `knowledge.requirements`, `knowledge.documents` and `knowledge.review` through the same
managed MCP host and catalog, including when no Jira Pod or external MCP server is selected. Its
private authority subject is `knowledge-pods`, bound to the current actor, Chat and Knowledge
selection digest, and carries only `knowledge.read`. It neither fabricates Jira credentials nor
reuses or widens the `configured-mcp` subject. The current open Chat, principal, selection, mode,
deployment ceiling, expiry and shared cumulative budget are checked before admission and effects;
Knowledge lifecycle, containment and model-use policy remain provider-owned checks. Modifying
tools are always denied under that subject. When external MCP servers are also selected, the
existing two-source catalog and atomic accepted-turn registry retain both independent authorities
and one budget. Semantic review receives the same server-private turn model meter through either
binding, so its gateway work is charged to the original authority and remains cancellable. The
application graph owns the lazy catalogs and closes their MCP hosts with the graph; a status read
only derives the static tool definitions for context accounting.

A selected Pod set grants access to that logical, server-owned set, like a selected folder, rather
than freezing its member IDs into a second authority registry. Its identity participates in the
selection digest; replacing that selected set invalidates the authority. Changing the membership
of the same set does not by itself invalidate the retained authority. Every source operation
resolves the current members through the existing scope resolver and reapplies containment,
lifecycle and model-use policy. Source snapshots and continuation fingerprints include the resolved
members: a membership change during an operation refuses its result as `source-changed`, and old
source-page cursors cannot continue against the changed membership. This dynamic-set contract does
not permit reads outside the currently resolved selection or transfer its authority to another set.
Authority previews do not open another Knowledge database or retain a membership cache.

Before synthesis, a turn with selected Knowledge Pods obtains one bounded metadata inventory page
through the existing catalog offer, binder and dispatch path. It consumes the same authority and
tool budget as a model-requested read; no extra synthesis allowance or semantic review is implicit.
The persisted call carries `origin: "runtime"`, and the gateway receives its result as untrusted
context before the actual human message, never as an invented model tool call. History selection
and token accounting retain that observation. Counts, cursors and partial coverage remain explicit;
metadata alone neither satisfies content-evidence admission nor suppresses uncited-content warnings.

**Per-Chat and per-run connector selection (owner decision 2026-11-02).** The person picks, in the
Chat composer's Connectors menu, which centrally configured MCP servers and which Jira Pod a Chat
offers to its model; the Coding Workbench composer offers the same menu for a run (`mcpServers` and
`jiraPodId` on the start request). An absent MCP selection offers every enabled server; a list
offers exactly those enabled servers; a disabled server stays unavailable whatever was selected.
An unselected server or Pod contributes no tools and no context. The Chat's MCP authority binds a
configuration digest of the registry revision and the selection, so changing the selection
invalidates the earlier selection's read grants and write approvals. A Coding run's selection
narrows the relay registry and the native read roots for that run only. The selection is
presentation-owned state, never an Authority Envelope; the existing catalog, binder and
authority checks remain authoritative. `chat.scope.update` records the selection only as
`mcpServerSelectionCount`.

Mixed Chat turns create that same accepted-turn authority before continuity, memory and
retrieval preparation. Existing grounding owners assemble their evidence packs before
productive Jira orchestration. Every gateway attempt retains its time charge and its
reported usage. Only the exact, fully observed tool-call response releases its provisional
synthesis slot and leaves the synthesis token grant (#4175, amended 2026-10-31): that tool
round is charged to and bounded by the accepted turn's Authority Envelope (its cumulative
prompt tokens, tool-call and model-call ceilings and deadline), which the envelope is the
turn's only bound for. Discarded, failed or ambiguous attempts retain their slot and grant
charge. The final answer and citation repair share the existing two-attempt synthesis
ceiling and the original token grant. A long Jira turn therefore no longer fails because
earlier tool rounds spent the answer's grant. Jira results stay
in the tool transcript and are attributed separately from connected-evidence citations.
`chat.grounded-tool-round.completed` records that phase and remaining synthesis count
without source content. A nested semantic review also retains the enclosing caller admission and
accepted turn meter. Only a fully observed, parsed review that passes the final source-revision,
authority and result-bound checks can confirm its own factory-owned synthesis reservation as tool
orchestration. Confirmation is bound to that exact reservation and response, including concurrent
results; it cannot release another attempt or a generic caller's grant. Physical usage remains in
the reported total and the accepted turn's cumulative budget. Invalid, stale, cancelled or
unobserved reviews retain their synthesis token and unknown-output charge. A physically settled
nested review releases only its own synthesis call slot, independently of parsed-result
confirmation. The exact reservation's settlement owns that idempotent release, including failures
and retries; cancellation of a caller's wait cannot release a newer or still-running attempt.
The accepted turn's model-call, prompt and cost ceilings remain authoritative. A valid partial review can confirm its observed
work without claiming complete source coverage. Data-only preparation and synthesis keep their
existing path. Marker-only citation repair is explicitly classified on every grounded path,
including Knowledge Pods, and uses the admitted model without re-entering the tool loop. An ended
tool turn is refused at repair admission and cannot start another call through its own entry point.

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
share the canonical identity; neither dispatches a second remote mutation. Exact write
approvals remain visible through the existing canonical-row GET observer while the buffered
grounded request is running.

An accepted read grant (server-established, owner decision 2026-11-02) is retained in the
existing private SQLite store by the existing approval registry, bounded by the original subject, disclosure version, proof
and expiry. Its originating turn reference remains provenance, not an execution lease
restored after restart. A later turn must independently pass its current authority,
custody, generation, model-capability and budget checks. Pending decisions still require
their exact live origin authority and are revoked during shutdown. Lifecycle revocation
persists; clean shutdown preserves only already granted read grants. No turn authority,
usage budget or pending write approval is restored from this record. Write-approval waits
observe the turn's composite cancellation signal, including a shorter synthesis budget.
Cancelling an unclaimed write revokes that decision; an already granted read grant remains
governed by its original expiry and current authority checks. Shutdown
also drains local waiters when a concurrent registry has already advanced the durable row.

If the process stops between the private grant commit and its transcript acknowledgement,
history reads project the decision only onto the exact originating canonical message and
matching grant identity, generations, disclosure and expiry. The projection never changes
the stored transcript or resumes its turn. Existing read-grant observation events retain
the grant proof and a message-hash correlation without exposing private subject details.
Because the projection is not persisted, each (grant, state) observation is recorded once per
process and database from bounded, insertion-ordered memory; repeated history reads stay silent.
The same rule applies to `chat.tool-mutation.projected`: one message's projected set of journal
outcomes is recorded once, and a later change of that set is recorded again.

## Verification

Protocol, declaration drift, schema refusal, context isolation and cancellation tests
use the real SDK path. Architecture fixtures prove both the import isolation and the
contracts/security package boundary. Registered producer-line and analyzer proofs,
production non-Coding binder coverage, Workbench regressions and the complete dependency,
package and release gates are required before final acceptance.

The ordinary Chat consumer retains one bounded invocation loop per accepted human
turn, including context-window retries. Its gateway physical-attempt hook charges
shared authority budgets before dispatch and settles observed usage once.

The context-window owner's existing retry decision reaches the tool-turn failure boundary.
When that owner will retry an adopted window, the same turn retains its settled continuation,
mutation receipts and remaining grants instead of ending with a transcript answer first. A final
overflow, cancellation or refusal retains the existing bounded settlement behavior; the retry
never repeats a committed handler or resets synthesis or authority budgets. The existing
`gateway.context-window.retry` Activity Log records the retry without content.
The already sent correction remains attached only to that active retry. Ended caller grants or
turn envelopes keep the earlier completed answer or transcript fallback, and final settlement
clears the correction before any later synthesis phase.
If that adopted retry is refused during its new preflight, its owner may settle the same retained
turn using the existing earlier-answer or transcript fallback and the first sent prompt's metadata.
This terminal callback is bound to that second attempt and its original reported overflow; it does
not replace an ordinary caller refusal, cancellation or an unexpected failure.

Catalog transport wrappers have a separate fixed depth allowance; each descriptor/schema and
all model arguments retain their original bounds and closed validation. Historical
completed tool results retain their validated descriptor/projection snapshot privately
in the existing Chat row; the public serializer omits that qualification metadata.
Jira write calls likewise capture their immutable operation identity and contract digest before
dispatch, privately beside the existing transcript. Exact approvals and late journal observations
validate against that snapshot, including Full access calls without an approval view, so later
registry revisions do not erase earlier receipts. Legacy rows without a snapshot retain
their original digest validation. Neither form grants execution: the write owner requires the
current registry binding and current authority before dispatch. Replacing a call's snapshot
or digest is refused. Older builds do not understand the new private snapshot; reverting code
requires a compatible forward repair or restoring the pre-update database backup, never dropping
approval history to make an old reader accept it.

Requirement-derived Jira writes also persist a private full source digest in a `write-prepared`
transition before approval or effects. The exact action hash binds that digest beside the operation
contract and original arguments; public tool-call arguments and transcript wire data remain unchanged.
Source preparation belongs to the accepted turn and survives catalog selection within that turn.
It cannot be replaced after preparation, and execution refuses a changed or unavailable source.
Historical approvals and late receipts validate with their captured source digest, including Full
access without an approval card. Missing historical source digests retain the earlier hash formula;
they do not authorize a new traced execution.

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

The local Coding Jira adapter also retains validated mutation results before relay delivery or
recovery. A private permit callback captures the admitted descriptor, operation binding and the
existing catalog compiler's projection once before dispatch. Successful and error results are
written atomically as one started/settled exchange in the existing Coding History user message's
tool transcript. No receipt table, journal phase or separate history format is added. The stored
descriptor snapshot validates later reads without resolving the installed Jira registry. The
original argument digest remains private beside that snapshot, so credential-floor redaction of
the displayed arguments cannot detach the result from its native journal identity. Historical
lookup selects only the exact invocation IDs in the bounded, owned transcript. The ordinary Jira
result cards consume these exchanges on reload. Their mutation state is projected
from the same native journal: a stored successful payload alone never confirms delivery or clears
an uncertainty barrier.
Before issuing that permit, the native owner reserves the existing transcript owner's worst-case
exchange bytes and one slot against actual stored occupancy plus concurrent outstanding captures.
Occupancy and capture pass through the Coding History owner's private run-and-expected-turn-bound
port; the generic Chat APIs remain unable to read or modify Coding messages. Both operations
recheck the same stored user-message ownership, and unreadable non-null transcripts refuse.
It uses the same transcript limits and reservation calculation as Chat. Capture or terminal permit
settlement releases the reservation. Known lack of storage capacity therefore refuses before any
native write; an unpredictable storage failure after a response retains the existing unknown-effect
recovery semantics.

Validated local Jira reads use the same immutable descriptor snapshot, capacity reservation and
run-and-turn-bound transcript port. A private per-call read capture writes success, provider failure
or the closed local scope refusal atomically before delivery. It creates no mutation journal row,
acknowledgement or mutation outcome, and records `effectStarted: false`. Read capture failure
refuses delivery without creating a write recovery barrier. The reservation is released when the
result is durable or the read finishes; cancellation, a changed accepted turn or an already released
capture cannot append a late result. Read history retains the admitted schema without consulting
the current registry, including result paging and unknown totals. Chat and Coding share the existing
Jira result-to-catalog page projection. The existing body-free transcript event records capture;
provider bodies and report content are never added to the Activity Log. Technical relay failures use a separate private read callback and the existing closed failure vocabulary: scope refusal remains denied, technical failure is failed, and deadline/cancellation retain their native catalog classes. A validated provider result or already persisted scope refusal takes precedence over a later relay error. Failed persistence preserves the primary closed failure and both internal causes, releases the reservation and creates no mutation recovery barrier.

Protected Jira input reuses that same invocation and History ownership. The
[Coding input owner](../../packages/keiko-server/src/coding-runtime/codingJiraHumanInput.ts) retains
only bounded pending metadata for the actual run/call lifetime. After schema admission and the
existing mutation check-only path where applicable, it persists a public HumanInput view through the existing
[transcript owner](../../packages/keiko-server/src/store/chatToolTranscript.ts), bound to the real
stored user message and turn. This is pending history, not a completed tool result, mutation ACK
or recovery settlement. No-op or refused calls do not request protected input. No synthetic Chat,
separate question store or OpenCode question carries secret values.

At submission and consumption, the existing current-input callback checks the active task/run,
call identity, canonical original arguments, Pod generation and current Authority Envelope. A
replaced/stopped invocation or changed authority cannot consume a prior selection. The existing
vault/custody owner holds protected values privately and consumes the current one-use claim at
actual dispatch. Public input revision and pending status may survive reload; passwords, licenses,
cookies and human input values do not enter History, catalog results, receipts or Activity Log.
The input supplies a missing secret or factual attestation; it never supplies connector authority
or replaces the existing action approval. Allowed mode remains allowed within its validated
envelope, without a new mandatory approval.

Native password-policy and license-validation POSTs remain reads; license validation additionally
requires explicit administration and high-risk admission. They produce bounded acceptance/count
facts without mutation journal rows. Private account/session writes retain the existing journal:
login can confirm only same-actor cookie proof, profile updates only exact independent metadata,
and password/logout/websudo ACKs remain unconfirmed. Human-attested anonymization unlock retains
the exact task/owner review but no native CAS, and therefore never claims independently confirmed
shutdown or global unlock completion. Forward-only V77 adds the closed writes without changing
historical journal phases or turning these POST observations into writes.

The private session path is a credential capability, not a connected-file grant. Avatar upload
still needs an actual authorized immutable image source and content admission. A Coding task or
workspace path alone does not supply that source, and an uncomposed source refuses before effect.
The 439 mapped native identities remain constrained source coverage; all runtime availability and
AC1–AC9 qualification remain open. Pending-input/history source regressions have not been executed
and this ADR does not claim end-to-end consumer or current-head acceptance.

Only the server-owned local Jira connection can supply this callback; an external server's name,
arguments or metadata cannot enable it. An error result never acknowledges a mutation. A validated
preflight error can remain readable without revoking the run only when the actual native dispatch
gate never opened. After dispatch, the existing failure/recovery path remains authoritative; the
receipt is already durable even if revocation prevents its response reaching the runtime.
For an admitted known Jira write, a local connector-scope refusal is retained under the same
snapshot as `denied/effect-denied` with no provider data. It is not a native Jira permission
response; the journal still distinguishes an unopened gate from a possibly dispatched change.
If scope loss also carries a validated provider receipt, that receipt takes precedence over the
data-free local refusal. Known resource identities remain durable while the same scope error
still prevents delivery, acknowledgement or replay.

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
retain their existing contract; `jira.draft` explicitly uses that same standard dialect for its
two closed input alternatives as specified in ADR-0175 D3. Schema complexity, references and patterns are
bounded before compilation, with no remote schema fetches or execution of schema-supplied code.

### Call resilience of the shared connection (#4271)

An independent audit of OpenCode coding runs through the shared connection corrected these
points; they refine D5 and the section above, they do not widen any authority.

- **Effect is a fact of the transport gate.** `ManagedMcpError.effect` is `none` only for a failure
  that happened before the `tools/call` frame passed the dispatch gate in `ExternalClient`
  (a stalled or failed declaration check, descriptor drift, an abort, a refused `beforeDispatch`);
  every other failure is `possible`. The native relay no longer revokes the run for a `none` failure.
  The durable record becomes `dispatched` at that gate (`ManagedMcpMutationInvocation.dispatch`),
  not at admission, and a failure before it settles the record `not-dispatched` (`release`). A
  permit without `dispatch` keeps the old behaviour: its record was already dispatched, so the relay
  never claims "no effect" for it. Deferral needs a connection that owns such a gate and says so
  (`ExternalMcpConnection.dispatchGate`, set by `ExternalClient` and forwarded by the configured
  connection wrapper). The local Coding Jira connection owns the gate immediately before its first
  native write request; metadata and preflight reads do not dispatch a mutation. For any other connection, the
  relay dispatches the record before the call starts and refuses the call when dispatch is refused,
  so an effect can never exist without a dispatched record behind it. The price is precision, not
  safety: such a connection's later effect-free refusal settles the already dispatched record as
  unconfirmed, never `not-dispatched`. The post-send pin (lost
  response, provider error, malformed result) is unchanged: the run is revoked.
- **`tools/list_changed` retires, it does not cancel.** The consumer-visible `signal` aborts at once
  and no further call is dispatched, but a call whose frame already left keeps its transport until it
  settles (bounded by its own hard cap); the connection then closes and the next consumer reconnects
  against the new catalog.
- **Frame cap above result cap.** The stdio frame buffer is 16 MiB and the delivered result bound
  stays 1 MiB, so a result between the two is refused whole as `result-too-large` (never truncated)
  and the shared connection survives. A single frame beyond 16 MiB still makes the SDK close the
  connection; that bound is the transport's, not a result policy.
- **Catalog narrowing.** A manually discovered server is narrowed to the registry's tools before the
  64-tool cap applies (up to 512 tools and 4 MiB per listing page are inspected; every tool's schema
  still passes admission). Descriptions are cut to 2 KiB each and 128 KiB per catalog on code-point
  boundaries; the listing line carries `omittedToolCount` and `truncatedDescriptionCount`. Automatic
  discovery keeps the whole catalog and the 64-tool cap.
- **Closed failure reasons and budgets.** A request deadline is `deadline-exceeded`, a caller abort
  `aborted`, a lost transport `closed`. A call has its own 30 s idle budget (progress notifications
  extend it) up to a 300 s hard cap; the declaration check has a separate 15 s deadline and its queue
  wait ends with the call's abort. A failed connect records `connectCause`
  (`timeout`, `spawn`, `aborted`, `closed`, `protocol`, `unknown`).
- **Server composition.** Three consecutive timeouts without a success recycle a connected but hung
  server. Consecutive failures back off 5 s doubling to 60 s (the first reconnect is immediate); a
  call during backoff fails at once with the closed `backoff` code, recorded as
  `coding-runtime.mcp-relay` `reconnect-backoff` / `server-hung-recycled`. A revoked relay binding
  answers `binding-revoked` with a fixed message when the caller proves the old capability. The
  shared connection of a bound server is started while the run launches. A harvested OAuth credential
  never replaces one with a later `expires`.
