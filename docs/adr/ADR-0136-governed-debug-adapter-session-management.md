# ADR-0136: Governed Debug Adapter Session Management

## Status

Accepted (2026-07-12). Architecture and contract foundation for Issue
[#2342](https://github.com/oscharko-dev/Keiko/issues/2342), the first child of Epic
[#2096](https://github.com/oscharko-dev/Keiko/issues/2096).

## Date

2026-07-12

## Version

1.0

## Context

Epic #2096 introduces governed Node.js/TypeScript debugging through the Debug Adapter Protocol
(DAP). Debugging is an execution and instrumentation capability: Keiko must start an
operator-provisioned adapter, launch workspace code, exchange bidirectional protocol messages,
project bounded state to a local browser, and tear down every descendant when authority or the
session ends. No existing subsystem owns that complete lifecycle.

The implementation must extend, not duplicate or weaken, these existing decisions and seams:

- ADR-0069 and `packages/keiko-server/src/editor/lsp/` provide the hardened long-lived-process
  floor: `lspProcessManager.ts`, `lspNodeAdapter.ts`, `lspTransport.ts`, `lspFrameCodec.ts`,
  `lspJsonRpcClient.ts`, `lspRestartThrottle.ts`, and `lspLifecycleLedger.ts`.
- ADR-0043 and `packages/keiko-sandbox/src/plan.ts` provide enforced `network: "none"` and strict
  `filesystem: "execution-root"` isolation with attestation. `packages/keiko-tools/src/exec.ts`
  remains the one-shot governed command boundary; its literal output buffering is not suitable for
  a bidirectional DAP stream.
- `packages/keiko-server/src/command-runner.ts`, its routes, and
  `packages/keiko-contracts/src/editor-verification.ts` provide the server-frozen command catalog,
  workspace-trust decision, and exact `npm run <scriptName>` entries.
- ADR-0124, ADR-0125, and ADR-0129 provide the Authority Envelope, deployment ceiling, three product
  modes, separately approved delivery boundary, and stricter-wins policy.
- ADR-0132's managed-LSP activation and ADR-0133's editor settings/control plane provide the
  revisioned, server-owned, explicit-opt-in precedents. The concrete human-debug composition points
  are `editorSettingsControlFactory.ts` and `deps.ts`, which inject the debug-specific deployment
  provider. `gitDelivery/runBoundAuthority.ts` and `agentAuthorityRegistry.ts` contribute stricter-wins
  and Authority Envelope vocabulary only; correcting #2342's wording here avoids fabricating an
  editor-agent authority for a human-started session.
- ADR-0042 D2/D3 require same-origin browser-to-BFF communication and unchanged CSP. ADR-0018
  forbids restoring a PTY or interactive shell.

Upstream `js-debug` source provides a private socket-path server transport on POSIX in addition to
its TCP server modes. A host-side adapter and a separately isolated debuggee would not share a
provable private transport when each receives its own namespace. Allowing host networking to repair
that topology would violate the v1 no-egress requirement. The design therefore has to decide the
adapter/debuggee topology before any manager, route, or UI code is implemented.

This ADR specifies architecture and pseudocode contract shapes only. It changes no runtime,
contract, route, sandbox, editor, or UI code.

## Decision

### D1 — Build a sibling DAP manager and reuse hardening primitives

Keiko will implement a **sibling DAP session manager**, not extract a shared LSP/DAP process-manager
core. The sibling is a new DAP-specific orchestration layer. It must reuse the existing exported LSP
hardening primitives where their contracts are protocol-independent:

- workspace-external executable resolution using both lexical and realpath containment checks;
- copy-only environment construction and an ephemeral HOME/USERPROFILE;
- detached process-group spawning and TERM-to-KILL escalation;
- the 8 KiB `Content-Length` header ceiling, UTF-8 byte-count framing, and reject-before-body-read
  behavior of the existing framing implementation.

Reuse means importing or moving only already exported, behaviorally stable primitives through their
supported package surface. It does not authorize edits to the LSP manager in an M8 child. If a
required primitive is not exported, #2343 may add a narrow export without changing LSP behavior and
must prove existing LSP tests unchanged.

A shared manager extraction is rejected because DAP has a per-debug-run lifecycle, adapter-originated
reverse requests, launch authority bound to an Authority Envelope, a private adapter endpoint, a
debuggee descendant, pause-generation references, and whole-capsule teardown. LSP instead owns a
warm workspace provider, negotiated language capabilities, background health, and bounded restart
after crashes. A shared lifecycle state machine would either encode protocol-specific branches into
the common core or change proven LSP behavior.

The migration cost of extraction would touch every named LSP module, its fakes, activation/status
consumers, and all managed-language providers before DAP has a production consumer. Its blast radius
would include all five managed-language paths. The sibling confines M8 failures to the new DAP
surface. A future extraction may be proposed only after both managers have production evidence for a
smaller stable primitive used in at least three places; it must be a separate ADR and migration.

### D2 — One strict session capsule contains adapter and debuggee

Every debug run uses one sandboxed **session capsule** with:

- enforced `network: "none"`;
- enforced `filesystem: "execution-root"` rooted at the exact validated execution root;
- no host filesystem exposure beyond immutable, explicitly mounted runtime/provisioning artifacts;
- one OS-enforced descendant ownership boundary, in addition to a detached process group; and
- a current attestation proving backend, filesystem, network, workspace, activation revision,
  provisioning identity, and launch identity.

On POSIX, Keiko prefers upstream `js-debug`'s source-confirmed private Unix-domain-socket endpoint.
The manager creates a host runtime directory outside the workspace with mode `0700`, verifies its
owner and lexical/real paths, and gives the sandbox plan one explicitly modeled read-write runtime
directory mount. The capsule sees that directory at a fixed private mount point and receives only the
in-capsule socket pathname. `js-debug` creates the socket inode there; the manager waits for a socket
owned by the service identity with no symlink traversal, then connects through the corresponding host
pathname. The sandbox attestation covers both host and capsule mount identities. Bubblewrap and OCI
must implement the same modeled mount or fail closed. No stdio/TCP bridge and no TCP listener are
created when this transport is available. `js-debug` launches the debuggee as its descendant from a
server-built closed launch configuration. The directory and socket are session-private, deleted
during teardown, never serialized, and never evidence.

On Linux, a qualified native capsule also creates a PID namespace and runs a minimal capsule init as
PID 1/subreaper. Terminating that namespace init kills every remaining descendant even if hostile
workspace code calls `setsid` or changes process groups. A qualified OCI capsule uses its container
identity and cgroup as the kill scope and enables an init process. A detached process group remains
the graceful TERM-to-KILL path, but it is not the orphan-freedom boundary. macOS and Windows require
an enforcing container backend until a native PID/job ownership mechanism has equivalent automated
proof.

On Windows, the private adapter endpoint must be an ACL-restricted named pipe bound to the Keiko service
identity and current session, or an enforcing-container transport with equivalent private endpoint
and descendant proof. If neither is available, startup fails closed. The browser never receives or
observes a socket, pipe, or port and communicates only with same-origin `/api` routes.

Adapter provisioning identity and the approved `node`/`npm` runtime identities resolve outside the
workspace with lexical and realpath planted-binary defense. Strict execution-root containment is
applied to every workspace mount and launch target, including symlink-resolved targets. No host home,
ambient PATH directory, host temp directory, credential store, or unrelated filesystem path is
exposed. The one session runtime-directory mount is the sole exception and is separately attested.

If no backend can enforce this exact topology, startup fails closed before evidence or spawn is
reported as successful. Network-only isolation, host networking, a host adapter, or separately
isolated adapter/debuggee namespaces are insufficient. On Windows, debugging is qualified only when
an enforcing container backend proves filesystem, network, namespace, descendant, and process-tree
containment. Native Windows child-process killing is not accepted as equivalent evidence. #2348
maintains the platform qualification matrix; unsupported hosts advertise debugging as unavailable.

### D3 — One canonical registry owns capacity and teardown

`DebugSessionRegistry`, implemented by #2343, is the only canonical owner of:

- reservation and activation of session capacity;
- one active session per canonical workspace and two active sessions per server;
- canonical workspace identity and local browser-session binding;
- activation revision, wall time, inactivity time, and pause generation;
- adapter, debuggee, output, and pending-request state;
- exactly-once capacity release and idempotent whole-capsule teardown.

#2343 provides the manager, canonical registry, aggregate concurrency and timers, protocol,
lifecycle ledger, cumulative output accounting, evidence projector, and exactly-once teardown.
#2344 is stateless: it provides closed launch builders and returns one validated, attested capsule
launch plan to #2343. It owns no counter, timer, registry, child handle, lifecycle ledger, or evidence
ledger. #2345 exposes the canonical #2343 state through strict contracts/routes and projects its
events onto the existing SSE transport; it does not recreate or shadow session state.

Any startup failure, explicit stop, adapter exit, debuggee exit, malformed frame, frame overflow,
output overflow, wall-time expiry, inactivity expiry, activation revocation, BFF
shutdown, or server shutdown enters the same idempotent teardown path. It rejects new work, cancels
pending requests, closes protocol input, terminates the entire detached process group, escalates to a
hard kill, cleans capsule resources, records the terminal state, and releases capacity exactly once.
An error in one cleanup step cannot skip later steps. No child is restarted after the debuggee has
launched.

### D4 — Launch input is an opaque target, never execution data

The browser may submit exactly one of two mutually exclusive target references:

1. an opaque catalog target id naming a trusted, currently discovered npm script; or
2. a validated workspace-relative file id naming an exact Node.js/TypeScript file target.

The server resolves the canonical workspace and re-derives the target from live state immediately
before launch. Workspace trust is mandatory for both shapes. A file target is resolved lexically and
by realpath inside the strict execution root, checked against the closed supported file policy, and
built as an exact `node <resolved-target>` launch. A catalog target must equal an existing
server-frozen `npm run <scriptName>` entry from `command-runner.ts`; the builder passes exactly the
reviewed executable and argument tuple `npm`, `run`, `<scriptName>` inside the strict capsule.

The script body is never tokenized, parsed, expanded, or reinterpreted as Node argv. Its repository
authorship is why workspace trust is required; the capsule, not text inspection, contains its
effects. An npm target uses the existing non-interactive package-script shell semantics, not a PTY or
browser-supplied shell. Keiko fixes the approved workspace-external shell identity, supplies a private
approved PATH, ignores workspace/user/global npm configuration, sets `ignore-scripts` so implicit
pre/post lifecycle hooks cannot run, and invokes only the explicitly selected script. Workspace
`script-shell`, PATH shadowing, lifecycle hooks, and npm configuration cannot replace those fixed
values. The request schema has no argv, env, cwd, runtime executable, runtime arguments, port,
adapter endpoint, attach pid, script text, shell, or inspector fields. Both builders return closed
discriminated server types. Layer-2 validation independently compares the final capsule launch plan
to the exact builder output before spawn. Therefore free-form browser data cannot structurally reach
the spawn boundary.

For a file target, the closed extension set is `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, and `.cts`; the
adapter launch projection fixes `request: "launch"`, the approved absolute Node identity, `program`
to the in-capsule contained target, an empty argument list, the fixed execution-root cwd, and
`console: "internalConsole"`. For a catalog target, the projection fixes the approved npm identity
and exact server-built `--ignore-scripts`, approved `--script-shell`, `run`, and script-name
arguments, with no user environment or runtime arguments and `console: "internalConsole"`.
`runInTerminal` remains rejected for both variants.

The complete pre-spawn order is binding: resolve canonical workspace and activation revision;
reserve capacity; resolve and approve adapter, Node/npm, and shell identities outside the workspace;
require command-rule approval; construct the copy-only environment and ephemeral HOME; re-derive and
Layer-2-validate the exact launch plan; build and attest the strict sandbox plan including its runtime
directory; durably append start evidence; and only then invoke the capsule spawn port. Any failure
rolls back the reservation and creates zero child processes.

### D5 — DAP protocol and request lanes are bounded

DAP uses the existing `Content-Length: N\r\n\r\n` framing behavior. Header accumulation stops at
8 KiB. A declared body greater than 1 MiB is rejected before reading the body, and the entire capsule
is torn down. JSON must be valid UTF-8, structurally closed for the handled message kind, and within
the corresponding payload caps before dispatch.

The client-originated request ledger allows at most 32 pending requests. Capacity is partitioned so
ordinary inspection/evaluation cannot consume a reserved control lane required for stop, pause,
continue, and cancellation. The adapter-originated reverse-request ledger allows at most 16 pending
requests. Unknown or unsupported reverse requests receive a typed failure. `runInTerminal` and
`startDebugging` are always rejected in v1; the server starts the session with a client-originated,
server-built DAP `launch` request, so no adapter-originated request can introduce argv, env, cwd,
shell, terminal, or a second spawn boundary.

Deadlines are fixed ceilings:

| Operation class | Deadline |
| --- | ---: |
| DAP `initialize` | 10 s |
| pause, continue, step, disconnect, terminate, and cancellation controls | 2 s |
| stack, scopes, variables, evaluate/watch, breakpoint, and `setVariable` inspection | 3 s |
| graceful shutdown before process-group escalation | 5 s |

Timeout, cancellation, malformed response, unknown references, or ledger saturation produces a
closed error code with no raw adapter text, request body, expression, path, stack, or output. Before
the debuggee launches, startup may attempt at most twice in a rolling 60-second window. After launch,
there is no adapter or debuggee restart; the user starts a new governed session.

### D6 — Session lifetime and instrumentation authority are explicit

Each session has a 30-minute wall-time ceiling and a 15-minute inactivity ceiling. Activity means an
explicit local-human debug control or inspection request, not adapter output, heartbeats, SSE reads,
or background polling. Exceeding either ceiling tears down the whole capsule.

Breakpoint conditions, logpoints, watch/evaluate, and `setVariable` are local-human debug
instrumentation effects under an already activated session. They do not widen the Authority Envelope
or create delivery authority. Activation is revalidated immediately before dispatch.

Watch expressions are bounded, explicitly authored by the local human, and may have program side
effects; the UI must disclose that fact at creation and evaluation. Model output, connector content,
retrieval content, snippets, agents, imported state, and program output cannot create or modify a
watch. There is no arbitrary debug-console REPL or statement-input surface in v1. The console renders
bounded program output and results of explicit registered watches only.

`setVariable` is allowed only through the Variables panel for a variable reference returned by the
current paused state. Stack-frame, scope, variable, and evaluate references are bound to the session
id and current pause generation. Resume, step, restart absence, stop, or a new pause invalidates all
prior references. `setVariable` cannot accept a free-form evaluate expression or statement and must
target an existing bounded variable name from the current snapshot.

### D7 — Activation is revisioned minimum-wins and has no restart state

Effective debug activation is the fail-closed minimum of:

1. product support for Node.js/TypeScript debugging on the qualified platform;
2. the debug-specific deployment-policy provider injected through
   `editorSettingsControlFactory.ts` and `deps.ts`, returning only `allowed | denied | unavailable`;
3. current approved adapter and runtime provisioning;
4. explicit local-human opt-in in the server-owned M7 settings surface.

Unknown, malformed, unavailable, stale, or inconsistent inputs deny activation. A legacy enable is a
ceiling only and never substitutes for opt-in; a legacy disable denies. This composes ADR-0132's
managed-LSP activation and ADR-0133's settings control plane without copying either store or policy
mechanism. `gitDelivery/runBoundAuthority.ts` and `agentAuthorityRegistry.ts` are stricter-wins vocabulary
and Authority Envelope precedents only; a human-started debug session must not fabricate or register
an editor-agent authority record. `unavailable` and provider errors deny activation.

The canonical durable opt-in is ADR-0133's existing M7 `debuggingEnabled` setting. No second
`debugActivationStore`, activation flag, or durable debug truth is permitted. A thin control surface
may project provisioning prerequisites and effective activation state, but all reads and writes of
human intent resolve through `debuggingEnabled`.

There is no `restartRequired` activation state in v1. DAP sessions are per-run and hold no warm
process pool or editable provider configuration. A changed activation or provisioning revision
revokes the current session; the next run starts from a newly validated revision. No real-world v1
state requires retaining a stale debug session while advertising a restart.

#2347 owns a revisioned `DebugCapabilityGate` with `resolve` and `subscribe`. The canonical M7
settings mutation publishes its new revision and awaits session revocation before the mutation
returns. Every operation also revalidates immediately before dispatch. The
process-environment-backed deployment ceiling is immutable for one BFF lifetime; changing it
restarts the BFF, whose shutdown path tears down all sessions. Any future live policy provider must
publish through the same subscription port. A one-second server watchdog may recheck provisioning as
defense in depth, but it is not the primary revocation mechanism. Resolver failure or unavailability
is revocation, not stale-allow. Revocation first rejects new work, cancels pending requests, and tears
down the capsule; only then may the gate acknowledge the revision. UI advertisement is removed
immediately.

### D8 — Browser authority and route security remain unchanged

Session ids are cryptographically random, opaque, and unguessable. They are bound in the canonical
registry to the canonical workspace identity and a separate server-minted browser-session
capability. They are correlation identifiers, never sufficient bearer authority. The capability is
minted by a same-origin debug bootstrap route, stored only in an `HttpOnly`, `SameSite=Strict`,
API-path-scoped cookie, rotates on BFF restart, expires after the bounded browser-session lifetime,
and is never returned to JavaScript, logged, or persisted as evidence. JSON routes and EventSource
requests must present the cookie automatically and match the session's canonical workspace binding;
missing, expired, replayed across a restarted BFF, or cross-browser-profile capabilities fail closed.
The BFF does not promise isolation between tabs in the same authenticated local browser profile; it
does guarantee cross-workspace and cross-profile isolation. Every route re-resolves both bindings.

BFF mutations retain the existing loopback Host validation, same-origin Origin validation, CSRF
header, strict JSON content type, closed body parser, and body-size limit. Browser traffic stays on
same-origin `/api` paths. SSE uses the existing same-origin event transport. No adapter/debuggee port,
WebSocket destination, direct DAP connection, worker connection, or CSP change is introduced.

### D9 — Evidence exists before spawn and remains content-free

A canonical `debug-session-start` record must be durably accepted before any capsule process is
spawned. Evidence failure before spawn fails closed and releases the reservation. The start record
binds the opaque session id, closed target kind, activation revision, provisioning identity digest,
sandbox-attestation enums, and reservation timestamp without storing the target, path, script name,
or launch body.

Allowed evidence fields are limited to schema version, closed event kind, opaque session id, closed
state/reason/target/backend/network/filesystem enums, a 64-character lowercase hexadecimal
provisioning identity digest, timestamps, bounded counts, truncation counters, and activation
revision. Evidence never contains workspace roots, relative paths, executable paths, script names,
argv, env names or values, breakpoints, conditions, logpoints, expressions, variable names or values,
types, stack frames, source, adapter messages, output, endpoints, ports, credentials, or errors.

#2343 owns and invokes the content-free session evidence builder/projector and a durable canonical
lifecycle journal through the registry for session start, active, stop, failure, session-revoked, and
teardown transitions. #2347 owns activation-change evidence for enable, disable, policy denial,
prerequisite loss, and the activation decision that triggers revocation. #2345 exposes only bounded
live projections and owns no evidence ledger. A terminal safety effect never waits for evidence:
teardown first
makes the capsule non-running. The terminal operation is not acknowledged and capacity is not reused
until its canonical terminal record is durably appended. If that append fails, the registry enters a
closed `evidencePending` health state, blocks new sessions, retains the bounded retry record, and
retries without raw content; the pre-spawn start record remains durable proof of the unsettled
session. A content-free operator diagnostic exposes the projection gap. The registry may release the
slot only after durable reconciliation, so a missing terminal audit record cannot silently look like
a completed session.

### D10 — Browser projections have hard UTF-8-safe caps

All byte caps are measured after UTF-8 encoding. Truncation occurs only at a complete UTF-8 code-point
boundary. Every truncated collection or string includes an explicit fixed marker and original/omitted
count where the protocol can determine it. A marker consumes the same enclosing cap. Silent clipping
is forbidden.

| Surface | Bound | Required projection behavior |
| --- | ---: | --- |
| Breakpoints | 64 per file; 200 per workspace | Reject additions beyond the cap; return retained and rejected counts. |
| Condition or logpoint text | 1 KiB each | Reject oversize input; never truncate executable instrumentation text. |
| Watches | 32 per session; 1 KiB expression | Reject additions/updates beyond the cap; never truncate an expression. |
| Watch/evaluate result | 4 KiB value; 256 B type | UTF-8-safe truncate complete records with fixed markers and original byte counts. |
| Aggregate watch projection | 128 KiB | Return only complete bounded watch records with retained and omitted counts inside the 256 KiB HTTP ceiling. |
| Audit retention | 128 events per workspace | Evict oldest projection with an explicit cumulative eviction count; canonical ledger rules still apply. |
| HTTP response | 256 KiB | Return a valid closed envelope with `truncated`, retained counts, and omitted counts. |
| SSE event | 64 KiB | Emit a valid fixed truncation event instead of splitting or emitting an invalid event. |
| Stack | 64 frames per page; 128 retained | Page deterministically; report total/retained/omitted counts. |
| Scopes | 32 per frame | Retain deterministic order and report omitted count. |
| Variables | 200 per expansion | Retain deterministic order and report omitted count. |
| Variable graph | depth 4; 1,000 nodes per snapshot | Replace deeper/excess nodes with a typed truncated sentinel and omitted count. |
| Variable name | 512 B | UTF-8-safe truncate with a fixed marker and original byte count. |
| Variable type | 256 B | UTF-8-safe truncate with a fixed marker and original byte count. |
| Variable value | 4 KiB | UTF-8-safe truncate with a fixed marker and original byte count. |
| Inline value decorations | 200 | Retain source-order entries and report omitted count; never add decoration work beyond the cap. |
| Adapter output event | 16 KiB | UTF-8-safe truncate each accepted event with marker and omitted byte count. |
| Session output accepted | 1 MiB | Accept up to the cap, emit exactly one fixed output-limit event, and enter whole-capsule teardown so a hostile producer cannot consume unbounded hidden resources. |
| Browser output retention | 512 KiB and 2,000 entries | Evict oldest entries deterministically and expose cumulative evicted bytes/entries. |

The 1 MiB session-output acceptance counter is canonical in `DebugSessionRegistry`; browser
retention is a smaller view and cannot reset or expand it. Output-limit teardown records counts only.
Program output is transient and visible only to the initiating local browser session. It is never
evidence or a server log.

Breakpoint and watch persistence share one canonical server-owned, per-workspace record in the same
fingerprinted private-state location pattern as M7 settings, outside the workspace. #2345 owns its
strict parser, monotonic revision, atomic replacement, per-file/total breakpoint rejection, and
watch-count/expression rejection. #2346 owns only UI projection and unsaved drafts. Browser storage
is not canonical and may not restore either collection without server reconciliation. Conditions,
log messages, and watch expressions are bounded user content in this private state, never evidence,
diagnostics, or session lifecycle records. Session evaluation results are never persisted.

### D11 — Interface and type sketches

The following pseudocode is binding shape guidance for #2345. Actual TypeScript belongs in
`keiko-contracts` and must use strict, closed, throw-free validators.

```ts
type DebugSessionState =
  | "reserved"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed"
  | "revoked";

type DebugLaunchTarget =
  | { kind: "catalog"; targetId: OpaqueCatalogTargetId }
  | { kind: "file"; fileId: WorkspaceRelativeFileId };

interface DebugSession {
  schemaVersion: "1";
  sessionId: OpaqueDebugSessionId;
  workspaceId: OpaqueWorkspaceId;
  state: DebugSessionState;
  targetKind: DebugLaunchTarget["kind"];
  activationRevision: number;
  pauseGeneration: number;
  startedAtMs: number;
  wallDeadlineMs: number;
  inactivityDeadlineMs: number;
  output: { acceptedBytes: number; truncated: boolean };
}

interface DebugBreakpoint {
  breakpointId: OpaqueBreakpointId;
  fileId: WorkspaceRelativeFileId;
  line: number;
  column?: number;
  enabled: boolean;
  condition?: UserAuthoredBoundedText;
  logMessage?: UserAuthoredBoundedText;
  verification: "pending" | "verified" | "rejected";
}

interface DebugStackPage {
  sessionId: OpaqueDebugSessionId;
  pauseGeneration: number;
  frames: readonly DebugStackFrame[];
  nextPage?: OpaquePageCursor;
  retainedCount: number;
  omittedCount: number;
  truncated: boolean;
}

interface DebugStackFrame {
  frameRef: PauseBoundReference;
  name: Utf8BoundedText;
  sourceFileId?: WorkspaceRelativeFileId;
  line: number;
  column: number;
}

interface DebugScope {
  scopeRef: PauseBoundReference;
  name: Utf8BoundedText;
  expensive: boolean;
  variableCount?: number;
}

interface DebugVariablePage {
  parentRef: PauseBoundReference;
  variables: readonly DebugVariable[];
  retainedCount: number;
  omittedCount: number;
  truncated: boolean;
}

interface DebugVariable {
  variableRef?: PauseBoundReference;
  name: Utf8BoundedText;
  type?: Utf8BoundedText;
  value: Utf8BoundedText;
  presentation: "data" | "method" | "property" | "virtual";
  truncated: boolean;
}

interface DebugWatch {
  watchId: OpaqueWatchId;
  expression: ExplicitLocalHumanText;
  enabled: boolean;
}

interface DebugWatchResult {
  watchId: OpaqueWatchId;
  pauseGeneration: number;
  state: "value" | "error" | "truncated";
  value?: Utf8BoundedText;
  type?: Utf8BoundedText;
  variableRef?: PauseBoundReference;
}

interface DebugEvidence {
  schemaVersion: "1";
  kind:
    | "session-start"
    | "session-active"
    | "session-stop"
    | "session-failure"
    | "session-revoked"
    | "session-teardown";
  sessionId: OpaqueDebugSessionId;
  state: ClosedDebugEvidenceState;
  reason?: ClosedDebugReason;
  targetKind: "catalog" | "file";
  provisioningIdentityDigest: LowercaseSha256;
  sandbox: {
    backend: ClosedSandboxBackend;
    network: "none";
    filesystem: "execution-root";
  };
  timestampMs: number;
  activationRevision: number;
  counts: ClosedDebugEvidenceCounts;
  truncationCounts: ClosedDebugTruncationCounts;
}

interface DebugActivationEvidence {
  schemaVersion: "1";
  action: "enable" | "disable" | "policyReevaluate" | "prerequisiteReevaluate";
  outcome: "accepted" | "denied" | "revoked" | "failed" | "noOp";
  reason: ClosedDebugActivationReason;
  actorClass: "localHuman" | "deploymentPolicy" | "systemPrerequisite";
  priorState: ClosedDebugActivationState;
  effectiveState: ClosedDebugActivationState;
  activationRevision: number;
  timestampMs: number;
  counts: ClosedDebugActivationEvidenceCounts;
}
```

Activation evidence never carries a session id, launch target, provisioning/path identity, argv,
environment data, breakpoint/watch content, variable/output content, or other user-authored text.

All opaque references are validated against session, workspace, local browser session, and current
pause generation. Wire records reject unknown keys and sparse arrays. Cursors are server-minted,
bounded, expiring projections and carry no raw adapter reference.

### D12 — Performance evidence extends B1–B13 with a B5 addendum

The existing editor performance baseline is B1–B13. M8 does not invent B14. Debug UI code remains
lazy and must preserve B1–B4 and B6–B13, including bundle, memory, large-file, search, and editor
budgets. The idle-debug acceptance measurement is an addendum to B5: with one active session paused
or running but no incoming visible output, per-keystroke main-thread work remains below 50 ms with no
new long task attributable to debug polling, SSE projection, inline decoration, or state selectors.

The measurement is non-vacuous: #2348 retains the existing long-task guard, where any
debug-attributable task greater than 50 ms fails, and adds Event Timing processing duration or a
trace/CDP-derived main-thread slice for each interaction. A zero sample from the long-task observer
means only that no qualifying long task occurred and must never be reported as zero milliseconds of
main-thread work.

The activation monitor's at-most-one-second idle poll executes server-side. Browser debug state is
event-driven and selector-bounded. Inline values are computed only while paused and capped at 200;
they are cleared on resume or pause-generation change.

The pre-M8 baseline is clean `origin/dev@bbda3c43c39fabe6c743b8be5d144abccd866397`.
#2348 measures that revision and the candidate in clean worktrees under identical Linux,
Node 24.18.0, npm 11.16.0, lockfile, Playwright/Chromium, hardware, and warm-up conditions. Each
revision receives at least three complete repetitions with `KEIKO_PERF_RUNS >= 10`; evidence uses the
median run-level percentile, alternates baseline/debug ordering, preserves raw samples and exact
toolchain provenance, and names a source commit reachable from candidate HEAD. Absolute B1–B13 gates
remain binding. In addition, B4 may regress by no more than `max(100 ms, 10%)`, B6 by no more than
`max(10 ms, 10%)` while remaining at p75 at most 200 ms, idle-debug B5 adds no long tasks and must
report the measured-work delta, and B11 reports candidate-minus-baseline peak plus post-stop residual.
Exact B1/B2/B3/B10 byte deltas are reported even when their ceilings pass.

#2348 also measures two cap-sized browser scenarios without adding B14. A stopped projection contains
128 retained stack frames across pages, 32 scopes, one 200-variable expansion, a depth-four/1,000-node
snapshot, and 200 inline decorations; stop-to-interactive/render p75 is at most 200 ms and no task
exceeds 50 ms. An output-flood scenario reaches the 1 MiB terminal limit, observes exactly one fixed
limit marker, never retains more than 512 KiB or 2,000 browser entries, keeps rendered rows bounded,
keeps Stop responsive up to the terminal boundary at p75 at most 200 ms with no task above 50 ms, and
leaves at most 16 MiB residual heap over the same-run baseline after teardown and UI close.

#2348 records Linux-authoritative B1–B13 and the B5 idle-debug addendum. A passing average cannot hide
a B5 long task, stale provenance, a cap scenario that never reached its cap, or unbounded retained
DOM/state.

### D13 — Verification and mutation-testing obligations

CI requires no real `js-debug` binary. An injected fake adapter is the authoritative deterministic
gate for framing, reverse requests, launch authorization, deadlines, pause generations, output caps,
revocation, crash handling, and exact teardown. An operator-provisioned real-adapter smoke is optional,
never a release gate, and must run under the identical strict capsule and emit content-free results.

A deterministic manager-overhead harness uses at least 20 cold create/dispose samples and 100 warm
samples per control/projection operation. Its initial ceilings are: fake-adapter initialize p95 at
most 250 ms; warm pause/continue/step p95 at most 25 ms; capped 200-variable and 64-frame projection
p95 at most 50 ms; dispose orchestration p95 at most 100 ms; two-session RSS delta at most 64 MiB;
and zero residual timers, requests, listeners, or child handles after disposal. These measure Keiko
orchestration, not operator `js-debug` startup performance.

Once implemented, every DAP security-critical parser, executable resolver, launch-policy builder,
session-registry module, and activation resolver is included in `stryker.security.conf.json`'s
`mutate` scope. Tests must kill mutations that weaken planted-binary defense, catalog identity,
closed argv, env copying, strict topology attestation, frame/depth/size bounds, generation binding,
capacity, activation minimum-wins, or teardown.

The deterministic suite must also prove that a debuggee which calls `setsid` cannot escape the PID
namespace/container kill scope; a planted workspace `script-shell`, `.npmrc`, lifecycle hook, PATH
entry, or npm configuration cannot change the exact catalog launch; an output flood reaches the
1 MiB limit and terminates the capsule while controls remain responsive; browser-session cookies
cannot be replayed across profiles, workspaces, expiry, or BFF restart; and a failed terminal-journal
append blocks capacity reuse until durable reconciliation. These are implementation-child tests, not
documentation-only closeout assertions.

## Epic #2096 architecture-invariant map

| Epic invariant | Binding design decision |
| --- | --- |
| Existing boundaries, gates, security, evidence, and deterministic verification are not weakened. | D1 reuses narrow hardening primitives without changing LSP; D2 requires strict attestation; D13 uses fake-adapter and mutation gates. |
| Debugging is off by default, ceilinged, explicitly activated, and audit-evidenced. | D7 defines the four-factor minimum and revision monitor; D9 requires canonical evidence before spawn and on terminal paths. |
| ADR-0069 hardening is the floor. | D1 reuses executable/env/HOME/kill/framing behavior; D4 requires command approval, copy-only env, launch equality, sandbox attestation, durable evidence, and zero child creation before successful preflight; D5 fixes protocol deadlines and restart bounds; D9 fixes typed content-free failures. |
| Debuggee launch uses the governed, attested boundary and closed targets. | D2 defines the attested capsule; D4 defines exact catalog/file builders and Layer-2 equality validation. |
| Debugger wiring is private with no browser destination or CSP change. | D2 uses a session-private UDS on POSIX (or a qualified private Windows transport) and keeps inspector loopback inside one namespace; D8 keeps same-origin `/api` and existing CSP. |
| Variable/stack payloads are capped and evidence excludes values/source/output. | D9 excludes content; D10 sets every byte, count, page, depth, node, and truncation rule. |
| Contract-first debug state and editor budgets remain authoritative. | D11 supplies closed contract sketches; D12 preserves B1–B13 and adds idle-debug evidence to B5. UI tokens, SHA-locked global CSS, a11y, and gutter composition remain #2346/#2348 obligations. |
| Session and resource bounds are explicit and fail closed. | D3 caps sessions and centralizes teardown; D5 caps ledgers/frames/attempts; D6 caps lifetime/inactivity; D10 caps projections/output. |

The attempted-bypass classes are mapped concretely: workspace-planted binaries fail D1/D2
lexical-plus-realpath resolution; catalog/argv escape is structurally absent in D4; oversized or deep
payloads fail D5/D10; environment leakage is blocked by D1/D2 copy-only env and ephemeral HOME; and
orphaned descendants are blocked by D2/D3 whole-group teardown and Windows qualification.

## Child ownership and implementation order

| Issue | Ownership against this ADR |
| --- | --- |
| #2343 — manager and adapter | Implement sibling DAP manager, canonical `DebugSessionRegistry`, aggregate concurrency/wall/inactivity timers, protocol/ledger, frame handling, private endpoint client, hardening primitive reuse, reverse-request bounds, deadlines, cumulative output, lifecycle evidence builder/projector, whole-group supervision, exactly-once teardown, fake adapter, and no-post-launch-restart rule. |
| #2344 — governed launch | Implement stateless strict capsule launch planning, platform attestation requirements, POSIX private-socket/Windows private-pipe topology, exact file and frozen npm-script builders, and Layer-2 launch-plan validation. Return the closed plan to #2343; own no counter, timer, registry, process handle, or ledger. |
| #2345 — contracts and routes | Implement strict wire contracts/validators, canonical server-owned breakpoint/watch persistence, pause references, browser-session bootstrap/cookie validation, Host/Origin/CSRF/JSON routes, and bounded HTTP/SSE projection of #2343's canonical registry/events. Own no second session state, timer, capacity counter, output ledger, lifecycle ledger, or evidence projector. |
| #2346 — editor surface | Implement gutter composition, exception/conditional/log breakpoints, toolbar, stack/scopes/variables/watch, bounded output-only console, inline values, `setVariable`, reveal navigation, status, a11y, and explicit side-effect disclosure. |
| #2347 — activation and policy | Implement four-factor minimum-wins resolution over the existing M7 `debuggingEnabled` durable opt-in, debug-specific deployment-policy provider, `DebugCapabilityGate` subscription, prerequisite watchdog, activation-change evidence, immediate awaited revoke/teardown ordering, and no `restartRequired` or second activation store. |
| #2348 — quality closeout | Implement bypass, hermetic e2e, teardown/orphan, UTF-8/truncation, mutation, coverage, a11y, B1–B13/B5-addendum, platform-qualification, and release evidence. |

Children must land in this order and may not transfer canonical ownership to a convenience layer.
In particular, #2343 owns the registry, aggregate limits, timers, lifecycle ledger, cumulative output,
evidence projection, child supervision, and teardown; #2344 returns a stateless validated launch plan;
and #2345 owns contracts, canonical breakpoint/watch private-state persistence, routes, and HTTP/SSE
projection, but no duplicate session lifecycle authority.

This ownership map supersedes conflicting draft deliverables in the live child descriptions under the
repository rule that ADR decisions win. Before runtime implementation, #2344's `debugLaunchBounds`,
`debugLaunchLedger`, and `debugLaunchEvidence` deliverables are removed or reduced to stateless plan
validation; #2347's second `debugActivationStore` is removed in favor of M7 `debuggingEnabled`; and
#2345's in-memory-only breakpoint assumption is replaced by the canonical private-state record above.
No child may claim its superseded duplicate as an acceptance requirement; PR completion notes must
cite this reassignment explicitly.

## Consequences

### Positive

- The adapter and its debuggee can communicate over a private POSIX socket or qualified Windows
  transport without exposing a port or relaxing network isolation.
- DAP receives hardened primitives already proven by LSP while the working LSP lifecycle remains
  outside the M8 blast radius.
- Closed launch builders structurally eliminate browser argv/env/cwd/runtime/attach authority.
- One registry makes capacity, revocation, output accounting, and teardown race-safe and auditable.
- Numeric caps and UTF-8-safe markers give contracts, server, and editor one deterministic projection
  model.

### Negative and neutral

- Strict capsule topology reduces platform availability; native macOS and Windows require an
  enforcing container backend until equivalent capsule-wide descendant ownership is proven, and
  unsupported hosts fail closed.
- Operator provisioning must include compatible `js-debug`, Node, and npm identities; Keiko does not
  download or repair them.
- Repository-authored npm scripts can execute arbitrary repository logic, so workspace trust and
  strict isolation remain mandatory even though argv is frozen.
- DAP and LSP retain sibling orchestration code. This deliberate duplication is smaller and safer
  than a premature shared lifecycle abstraction.
- Watch evaluation and `setVariable` can alter program behavior. They are explicit local-human
  instrumentation effects, generation-bound, and unavailable to agents.

## Alternatives considered

### Extract a shared LSP/DAP manager core

Rejected. It would modify proven LSP lifecycle and activation consumers while forcing DAP reverse
requests, per-run launch, capsule identity, and descendant teardown into a shared state machine. D1
records migration cost and blast radius.

### Put adapter and debuggee in separate namespaces

Rejected. Separate `network: "none"` namespaces cannot provide the same descendant and private
endpoint proof. A cross-namespace relay would create another transport and supervision boundary.

### Relax the adapter or capsule to host networking

Rejected. Host networking violates v1 `network: "none"`, enlarges endpoint exposure, and makes a
namespace-private adapter port observable outside the session.

### Reuse literal `runCommand` output buffering

Rejected. DAP is bidirectional and asynchronous. One-shot buffering would retain unbounded protocol
and output data until exit and cannot serve adapter-originated requests. DAP uses the ADR-0043
isolation plan and attestation, not `runCommand`'s buffering contract.

### Run DAP in the browser

Rejected. Browser-side DAP would expose a port, widen CSP/connect destinations, duplicate authority
and protocol parsing, and bypass server-side launch, evidence, and teardown ownership.

## Non-goals

Every Epic #2096 non-goal remains binding:

1. No adapter beyond Node.js/TypeScript; Python, Go, Rust, and Java are follow-ups.
2. No attach to arbitrary/local processes, remote targets, network debugging, or caller-supplied
   ports; v1 is launch-only from closed targets.
3. No bundled, downloaded, self-updated, or workspace-supplied `js-debug`; provisioning is
   operator-owned and workspace-external.
4. No user-facing PTY, shell, terminal, or arbitrary debug-console REPL/statement input; ADR-0018
   remains in force. A trusted catalog target may use npm's fixed non-interactive package-script
   shell inside the strict capsule, but the browser cannot select, configure, or interact with it.
5. No agent-driven debug session or instrumentation. A future read-only `editor_debug_snapshot` may
   land through `WorkspaceToolHost`/`EditorAgentToolHost` only after a separate policy classification;
   this ADR grants no such tool or authority.
6. No debuggee network egress; workloads requiring egress are unsupported in v1.
7. No hot reload or edit-and-continue.

The architecture issue itself also ships no manager, adapter, process spawn, sandbox change,
contract TypeScript, route, persistence, UI, activation setting, test suite, or release evidence.

## Compliance with prior ADRs

- **ADR-0018:** no user-facing PTY, interactive shell, arbitrary terminal, or free-form statement
  console is introduced; fixed internal npm package-script execution is not exposed as a tool or UI.
- **ADR-0042:** browser code remains same-origin and browser-tier; DAP terminates server-side and CSP
  is unchanged.
- **ADR-0043:** launch requires current strict filesystem/network attestation and fails closed when no
  enforcing backend exists.
- **ADR-0069:** its hardening primitives and framing behavior are reused as a floor; LSP lifecycle,
  restart, negotiation, and activation behavior are unchanged.
- **ADR-0124/0125/0129:** validated bounded authority and stricter-wins ceilings remain mandatory;
  debugging does not authorize delivery or authority widening.
- **ADR-0132/0133:** activation and settings are composed through their server-owned revisioned
  control-plane precedent and the existing M7 `debuggingEnabled` opt-in; no parallel store, policy,
  or `restartRequired` state is added.

## Verification

This architecture-only change requires:

- `npm run check:adr-index`
- Prettier validation of this ADR and `docs/adr/README.md`

Runtime children must additionally satisfy D13 and their issue-specific repository gates. The fake
adapter is the deterministic authority; an optional real-adapter smoke cannot replace it.

## Related

- [ADR-0018](ADR-0018-terminal-tool-boundary-and-permitted-commands.md)
- [ADR-0042](ADR-0042-keiko-editor-package-and-boundaries.md)
- [ADR-0043](ADR-0043-enforced-execution-isolation.md)
- [ADR-0069](ADR-0069-governed-lsp-process-manager.md)
- [ADR-0124](ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md)
- [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md)
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md)
- [ADR-0132](ADR-0132-managed-multi-language-lsp-activation-and-configuration.md)
- [ADR-0133](ADR-0133-editor-m7-personalization-and-resilience-control-plane.md)
- Epic [#2096](https://github.com/oscharko-dev/Keiko/issues/2096)
- Issue [#2342](https://github.com/oscharko-dev/Keiko/issues/2342)
