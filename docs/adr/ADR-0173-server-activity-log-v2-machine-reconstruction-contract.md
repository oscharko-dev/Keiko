# ADR-0173: Server activity log v2 — a machine-reconstruction contract for autonomous defect triage

## Status

Accepted (Epic #3233, Wave 6 closeout, 2026-08-22). Amended 2026-09-17 to define
the durable CLI control-state boundary for commands that audit or remove runtime state.

Drafted in Wave 1 alongside the envelope's ordering primitive (`seq`) and the minimal exporter/
analyzer, and finalized here once all seven waves of the epic had landed: envelope v2 (D1–D2),
stack frames and their redaction guards (D3–D4), correlation threading end-to-end (D5), the
generated op catalog (D6), process lifecycle events (D7), the canonical support-report format and its CLI
(D8–D10), the `ERROR_KIND_PATTERN` relocation (D11), HTTP/SSE detail and the browser diagnostic
ingest (D13), and the domain-package log-port wiring recorded in D12. The "Wave N" markers below
are left in place as a record of when each decision became load-bearing, not as an indication that
anything in the original epic is still pending. `keiko support analyze` exposes
`--clusters`/`--seed`/`--emit-fixture` command-line flags for the reproduction-seed
and op-cluster machinery D9 describes, so that machinery is reachable directly from the CLI, not
only by importing it — see D9.

Amended by #3528 on 2026-09-18: daily rotation and retention remain the active disk bound until
immutable segments replace them. Their mutation boundary is hardened to the operating-system user:
owner-private non-redirected directories, held handle/path identity checks, a non-replacing hard-link
winner across processes, a rename fallback only when hard links are unsupported and only after an
exclusive claim of the dated name, and verified
single-link archive handles before retention unlink. The residual same-user pathname race is explicit
and does not authorize unbounded growth.

Amended by #3530 on 2026-09-18: bounded immutable segments replace the single shared
`server.log`, its UTC-daily archives and count-only retention (D14). Each process appends only to its
own active segment; sealed segments are read-only and never rewritten. Retention is bounded by bytes
and age across every segment and legacy file, with crash recovery, retention pins under a reserved
quota, and closed body-free evidence for sealing, recovery, retention, pressure and pins.
`server-log.rotation` and `server-log.capacity-warning` are retired.

Amended by #3554 on 2026-09-18: several cooperating processes sharing one `logs/` directory
previously resolved `KEIKO_LOG_RETENTION_BYTES`/`_DAYS`/`KEIKO_LOG_PIN_QUOTA_BYTES` purely from their
own env, so the byte bound above held only per process, not across them (D14). One closed-grammar
`store-policy.json` record now holds the values every cooperating process actually enforces: the
first process to find no valid record publishes it, race-safe; every later process applies the
STORED values regardless of its own env and records one `activity-log.policy.conflict` line per
process lifetime when they differ; a process may replace a stale or corrupt record only while it is
the directory's sole live writer.

Amended by #3529 on 2026-09-17: the heuristic operation inventory is now a non-authoritative
migration view. Canonical TypeScript-resolved registrations form the versioned production registry,
derive exact emitter types, and are revalidated at the serialization boundary. Persisted v2
identity now includes registry/schema digests and safe build/release/platform/capability dimensions;
readers classify compatibility and sequence integrity explicitly instead of treating every
parseable or partially identified line as valid v2 evidence.

Amended by #3532 on 2026-09-18: every production process now reaches the registry-validated writer
or reports that it cannot (D6). Lost events are counted in one bounded, closed ledger and persisted
as summaries. Diagnostic readiness is a closed state that `/api/health`, `keiko status`,
`keiko support export` and the desktop workspace report. Every exit leaves one `process.exiting` line,
and a fatal crash leaves `process.fatal` (D7). The raw `ui.log` channel is retired, and the support
report never carries it (D8, D9).

Amended by #3534 on 2026-09-30: D8/D9 now define the closed one-file private report, offline
validation and explicit legacy treatment. D16 query bounds remain authoritative; an insufficient
selection may be described in a report but may never be presented as complete.

Amended by #3531 on 2026-09-18: `keiko support query` and selective `keiko support export` read the
segmented log in bounded memory through derived, rebuildable per-segment manifests, and select an
operation's whole registered causal closure or report it `insufficient`; required evidence is never
cut to fit a budget (D16). The local developer reader retains bounded line iteration; received
reports use the independently bounded private-file and decompression validator defined in D9.

## Context

`<stateDir>/logs/server.log` (JSON lines, `KEIKO_LOG_LEVEL`-gated, always on) shipped in #3230. It
made activity evidence exist at all: before it, a customer's stuck
indexing run produced nothing an engineer could read, and a real gateway defect was found only by
asking the customer to run `curl` by hand.

A 12-reader audit of that surface (transport, redaction, HTTP lifecycle, chat/gateway lane,
diagnostics, process lifecycle, browser side, indexing lane, evidence subsystem, silent domain
packages, persistence, tests/gates/docs, agent tooling) found 36 gaps against a stricter bar: not
"is there a log line" but "can an autonomous agent, given nothing but one exported artifact,
reconstruct the failure and write a failing test for it without a human reading the log first."
Seven of the 36 are blockers — no cross-request correlation into the model gateway or WebSocket
layer despite `GatewayCallRequest.logContext` already existing untested-in-production; Keiko-code
stack frames structurally unloggable (`stack`/`cause`/`error` are hard-denied field names); no
process identity or lifecycle events; several domain packages (memory handlers, the UI store, the
memory vault, voice WebRTC, harness/workflow runs, memory consolidation) writing nothing despite a
correct sibling pattern one file away in each case; agent-run events reaching only an in-memory SSE
ring buffer; browser-side failures never leaving the tab; and nothing to export or parse the log at
all, with `op` an uncatalogued free string.

**Goal.** Turn the v1 activity log into a machine-reconstruction contract: an autonomous coding
agent, given one exported support artifact, can order its events unambiguously, join them across
process/request/model-call boundaries, read a Keiko-code stack frame without a human explaining the
directory layout, and scaffold a red-then-green regression test — all without any customer content
ever appearing in the artifact.

**Non-goals.** This epic does not log prompts, responses, document text, secrets, absolute
filesystem paths, or any other customer content — content-shape and counts only, never bodies. It
does not introduce runtime source maps, OpenTelemetry, or a second logging/tracing subsystem; every
change extends the existing `ServerLogSink` / `emitServerDiagnostic` / `KnowledgeLogSink` choke
points. It does not sweep all ~739 bare `catch {}` blocks in `keiko-server`; the audit-named true
positives are fixed directly and the remainder is a separate, explicitly deferred follow-up. It does
not build a JSON request/response shape-skeleton feature; that is specified as a forward guardrail
only (positional locators, never customer field names as object keys), not implemented.

## Decision

### D1 — Envelope v2: what is reserved, and why each field earns that status

`ServerLogEvent` originally gained four process-ordering fields. The physical sink now stamps the
complete v2 identity below; no producer may set or override any of it:

- `schemaVersion: 2` — a literal constant, bumped only on a breaking format change to the line
  shape itself. Lets a consumer (the analyzer, or a human) branch on wire format without probing
  for field presence.
- `pid: number` (`process.pid`) — reserved because it is cheap, universal process identity, but
  **not sufficient alone**: operating systems reuse pids across restarts, so two distinct process
  lifetimes can share a `pid` within one multi-day log file.
- `instanceId: string` — 8 lowercase-hex characters sliced from one `randomUUID()` call made once
  per process start. Reserved specifically to close the gap `pid` alone leaves: `pid` **and**
  `instanceId` together, not `pid` alone, is the process-identity join key an agent uses. Neither
  field is a secret or customer-derived value, so reserving them costs nothing on the redaction
  side.
- `seq: number` — allocated from one module-level counter shared by every `ActiveLog` in the
  process (not one counter per resolved log directory), so a process writing to more than one
  state directory still stamps one monotonic sequence, never two independently-numbered ones.
  Survives segment seals and every `ActiveLog` reinitialization; resets only on process
  restart.
  Reserved because it is the ordering primitive (D2) — if a caller could set `extra.seq`, ordering
  claims would be forgeable.
- `registryVersion`, `schemaDigest`, `catalogDigest` — bind the record to the exact generated
  authoritative registry and schema. The digests are lowercase SHA-256 values generated from
  canonical data, never caller strings.
- `buildClass`, `releaseClass`, `platformClass`, `productVersion` — bounded, body-free dimensions
  needed to select the matching executable contract without admitting paths, endpoints, identities,
  arbitrary environment data, or free metadata.
- `compatibilityState`, `writerCapability` — closed states that say whether the writer is using the
  supported contract and whether the evidence path is active, degraded, or unavailable. A current
  persisted line is `supported`/`active`; failure notices state incomplete/unavailable explicitly.

All identity dimensions join the existing reserved set (`ts`, `level`, `category`, `op`) in
`RESERVED_FIELD_NAMES`, so `redactLogFields` strips a same-named `extra` key before assignment —
identical to how the pre-existing reserved fields already cannot be spoofed today. This is a
structural guarantee enforced at the one physical write boundary (`formatServerLogLine`), not a
convention producers are trusted to honor.

`category` widens from 8 to 9 members, adding `"process"` — an intentional, reviewed union
widening for D7's lifecycle events, not a reuse of the already-declared-but-never-emitted
`"setup"` category, which means something different.

Two fields already producer-suppliable and unchanged in kind — `correlationId?` (existing) and the
new `parentCorrelationId?` (D5) — remain **non-reserved**: a caller is expected to set them, so they
win over a same-named `extra` key at format time exactly as `durationMs`/`status`/`errorKind` do
today. Reserving them would prevent the very thing they exist to do.

### D2 — The ordering guarantee, stated with its explicit limit

`(pid, instanceId, seq)` gives a **total order within one process lifetime, unique across every log
directory that process writes to** — `seq` is allocated from the one process-wide counter D1
describes, not from a counter scoped to a resolved log directory, so a process holding two state
directories open at once cannot stamp the same `(pid, instanceId, seq)` tuple twice no matter how
many directories it writes to. It does **not** give a true cross-process global order: two different
`keiko` processes (a restarted server, or — in a future multi-process shape — two processes running
concurrently) each maintain their own `seq` counting from the same starting point, so a line from
process A carrying `seq: 40` is not orderable against a line from process B carrying `seq: 40` by
the tuple alone.

**The sequence is monotonic and may contain gaps.** Each non-filtered
`createFileSinkFacade.write` invocation reserves one identity before boundary handling or opening the
file. The first record that invocation actually persists — safe-open evidence, segment or retention
evidence, or the caller record — uses that reserved identity; any additional records allocate their
identities immediately before their physical writes. An opening or write failure never rolls an
identity back. Two callers racing the same failure therefore cannot reuse the number that follows it;
a missing number is the strictly safer failure than a repeated one. A gap marks a sink invocation or
subsequent evidence write that could not persist its next record. On a clean exit the associated
failure is accounted for by `reportServerLogFailure`, which emits a throttled, independent-channel
stderr notice (`server-log.write-failed`) whose `suppressedNotices` count accounts for the failed
sink invocations, so the throttle hides the failure's _repetition_, never its _scale_. That
notice travels a fixed **channel order**, each one independent of the one before it: the **file
sink** is the primary write path and is what the notice reports on; failing that, the **stderr
notice** carries the redacted classification (`op`, `failedOp`, `correlationId`, `errorKind`,
`suppressedNotices`) and the failure's dist-anchored Keiko `frames` to the process's stderr
stream; and if `process.stderr.write` itself throws (a closed descriptor, a broken pipe — the
stderr stream is not guaranteed writable either), the same
fields are re-surfaced through a third, independent channel: `process.emitWarning` with
`code: "KEIKO_LOG_NOTICE_FAILED"`, which dispatches Node's `'warning'` event synchronously to any
listener and does not depend on stderr being writable. That count is delivered one of two ways — on
the next unthrottled failure notice, or, if none arrives first, flushed once by
`resetServerLogFailureNotices` (called on every clean shutdown via `shutdownServerLogging`, and by
test teardown) before the counter is cleared. **The stated limit**: a hard kill the process never
gets to handle — `SIGKILL`, a container OOM-kill, power loss — skips shutdown entirely, and whatever
count was still open in that instant is lost with it. The channel layering has the same honest
ceiling, not a stronger one: if the file sink, the stderr notice, _and_ the `process.emitWarning`
fallback are all unavailable in the same instant (for example, stderr is gone and nothing in the
process is listening for `'warning'`), the notice is lost — three independent channels are not an
infinite one. The `seq` gap itself still marks that a write failed even then; only the _count_ of how
many is not recoverable after that kind of exit. Exact accounting across every conceivable process
exit or channel failure was never a promise this design can keep, and this ADR states that limit
rather than the stricter claim the code cannot back.

The wall-clock `ts` field is the only cross-process ordering signal, and it is stated as exactly
that — a **best-effort tiebreak hint**, not a guarantee. Clock skew, coarse timestamp resolution,
and out-of-order flush are all real on a customer's machine and are not corrected for. An agent
reconstructing a single request's lifecycle (the common case: one chat turn, one indexing job, one
gateway call) only ever needs the guarantee that holds — every line from that lifecycle's owning
process, in the exact order it was written — because a single logical operation runs inside one
process lifetime. Cross-process causality, when it ever matters, is established through
`correlationId`/`parentCorrelationId` (D5), never through the ordering tuple.

This limit is stated here rather than discovered later because the alternative considered — a
pre-ordering heuristic that guesses order from timestamps and file-append position — would have
papered over exactly this gap; naming the limit explicitly is what lets Wave 1 avoid needing one.

### D2a — Destructive and read-only CLI commands use a stable control-state root

An operator-selected runtime-state directory cannot be the durable evidence owner for a command
whose contract is to leave that directory untouched or remove it. `keiko audit local-state` and
every operational `keiko uninstall` invocation therefore use a fixed per-user CLI control-state
root: `~/.local/state/keiko/control` on Linux,
`~/Library/Application Support/Keiko/control` on macOS, and
`%USERPROFILE%\AppData\Local\Keiko\control` on Windows. Environment variables cannot redirect this
root. The command resolves existing symlinks before use and refuses when the control root and
selected target contain one another in either direction. It never opens a second durable log. A
control-root overlap or canonicalization failure exits non-zero with a body-free terminal refusal
before any sink is opened: no durable path can simultaneously stay outside an arbitrarily selected
protected target and preserve the single-log contract. Once isolation has been proved, a transient
open failure is retried only through the established control-state log.

This is a placement rule, not a second logging system. The control root receives the existing
`ServerLogSink` at `logs/`, so D1-D14, correlation, redaction, segments, retention, and
the generated op vocabulary apply unchanged. Install-layout normalization is persisted there
before a corrected internal path is consumed, and its correlation id joins the complete command
lifecycle. Audit records start and completion/failure without writing into the audited tree.
Uninstall records start, forced-stop activity, and completion/failure without losing the record when
target state is removed; this includes dry runs and scripts-only operations. Package read and parse
failures are terminal failures, never successful zero-removal outcomes. Events identify selected
state and package targets only by SHA-256, and completion records whether state was absent, removed,
retained, or would be removed/retained plus body-free affected/retained counts.

`keiko support export` keeps successful install-layout normalization in the selected runtime log so
the selected canonical report can retain that evidence. When a pending normalization meets a symlink or
non-directory state root, the export refuses before reading or exporting the target and emits
`cli.support.export.failed` through the same fixed control-state log, provided canonical isolation
from the selected target can be proved. If isolation itself cannot be proved, the same terminal-only
limit above applies; the command never guesses at a writable evidence location.

### D3 — Keiko-code stack frames: dist-anchored, and why no source maps

Stack frames and cause chains are added to `extra` as `frames?: readonly string[]` and
`causeChain?: readonly string[]` (Wave 2, landed:
`packages/keiko-activity-log/src/stack-frames.ts`). Each frame entry is a single joined
string in one of the following shapes: a workspace-package frame,
`"packages/keiko-<pkg>/(dist|src)/relative/path.(js|ts):LINE:COL"`, or, for the root `keiko` bin's
own entrypoint — which lives outside every `packages/*` directory —
`"(dist|src)/cli/relative/path.(js|ts):LINE:COL"`. Both shapes are pinned together by one pattern,
`FRAME_SHAPE_PATTERN` (`packages/keiko-activity-log/src/stack-frames.ts`), which
`packages/keiko-activity-log/src/log-redaction.ts` re-validates structurally at the redaction
boundary rather than trusting the producer (D4). Production browser failures additionally admit only
`dist/ui/static/_next/static/chunks/<chunk>.js:LINE:COL`, validated by the shared
`isClientDiagnosticFrame` guard; the same existing frame reducer revalidates that narrow shape.
Chunk IDs and minified line/column coordinates identify the shipped artifact without transmitting
URL origins, arbitrary paths or enabling source maps.

**No runtime source maps are enabled**, and that is a considered decision, not an oversight. Every
workspace package builds with `sourceMap: false` (only `declarationMap: true`); the root CLI
entrypoint's `tsconfig.build.json` explicitly disables both. Enabling them would cost real startup
time against GEN-PERF-CLI-001's budget and real package size, for a repository that already chose
`declarationMap`-only deliberately. The frame format is therefore anchored on **dist output**, not
source: `packages/<pkgDirName>/(dist|src)/` matched at its **last** occurrence in the absolute
path (not required to be a prefix), which makes the reducer correct across a dev checkout, a
symlinked `node_modules/@oscharko-dev/*` resolution, and a portable/installed product layout without
special-casing any of them. The scan keeps the last occurrence only among matches whose captured
directory name is an actual known workspace package (`PACKAGE_DIR_NAMES`), so a later, unrecognised
directory name can never shadow a real anchor further left in the path; the root-bin anchor
(`(dist|src)/cli/`) is consulted only once that workspace-package scan finds nothing. A Windows
absolute path uses backslashes and a drive letter (`C:\Users\...`), so the reducer normalises every
backslash to a forward slash before anchoring, and splits the trailing `:LINE:COL` from the end via
two successive `lastIndexOf(":")` calls rather than a whole-string regex — a drive-letter colon
earlier in the string must never be mistaken for the line/column separator.

The consequence for an agent reading a report is stated in the playbook this ADR forward-references
(`docs/observability/reproduction-harness.md`, Wave 6): a frame names the `dist` output of the
**exact tagged product version** the customer ran. The agent checks out that tag and lets `tsc`
reproduce the same `dist/<file>.js:LINE` deterministically — this works because Keiko's builds are
reproducible from a tag, not because the frame carries a source location. A future dist→src mapping,
usable only when a local `.js.map` happens to exist, is named as a later nicety and explicitly not
built in this epic.

The redaction side of this decision — why a frame string structurally defeats the existing path
guards, and the field-name-keyed guard that closes the gap for real rather than resting on an
accidental non-match — landed in Wave 2 as `redactKeikoFrames`/`redactCauseChain` in
`packages/keiko-activity-log/src/log-redaction.ts`; its full shape is D4's scope, not re-litigated
here, so this section keeps
stating the reducer's own shape and its no-source-maps rationale.

### D4 — Redaction doctrine is unchanged: body-free, fail-closed, structural

Nothing about this contract relaxes `packages/keiko-activity-log/src/log-redaction.ts`'s existing
doctrine: guards are structural, not advisory, and do not depend on a caller naming its fields
honestly. Every new field this ADR
adds is additive to that doctrine, not an exception carved into it. Wave 2 landed all three
field-name-keyed escape hatches this section anticipated, and all three share one restriction: each
fires only at the TOP LEVEL of `extra` — `redactLogObject`'s own direct call from
`redactLogFields`, never at any nested depth. The trust extended is a promise this log's own
producers make about their own top-level `frames`/`causeChain`/`diagnosticSummary` fields; the same
field name nested inside some unrelated object carries no such promise and takes the ordinary
generic path instead.

- `frames`/`causeChain` (D3) are named, typed escape hatches — `redactKeikoFrames`/`redactCauseChain`
  in `packages/keiko-activity-log/src/log-redaction.ts`, dispatched by
  `redactGuardedArrayField` — not a bypass of the generic value guards, but a **dedicated,
  field-name-keyed validator** for exactly these two fields, because the generic prose/path guards
  cannot recognize a dist-anchored frame as safe without also being loose enough to leak an unrelated
  deep path. `frames` is re-checked element-by-element against
  `packages/keiko-activity-log/src/stack-frames.ts`'s own `FRAME_SHAPE_PATTERN` and
  `PACKAGE_DIR_NAMES` (imported from that module, not restated); `causeChain` is re-checked against
  `DECLARED_ERROR_CLASS_SHAPE`, imported from the leaf
  `packages/keiko-activity-log/src/error-classification.ts`. A non-conforming element is dropped,
  never echoed or replaced in place — the same fail-closed direction the existing `path`-field escape
  hatch (`redactRoutePath`) already uses — and each guarded array is additionally capped, after
  filtering, at the reducer's own default element count (8 for `frames`, 5 for `causeChain`), so a
  forged over-length array cannot push a real element out of the result by padding the front with
  junk. This is the same escape-hatch architecture extended with two more named cases, not a second
  choke point.
- `diagnosticSummary` (g29 — `ServerDiagnosticRecord.message` projected under a name other than
  `message`, since `message` is itself a denied field name) needed a THIRD, scalar hatch of the same
  shape — `redactProseAllowedValue`, dispatched by `redactGuardedScalarField` — discovered by a
  failing test rather than designed up front: its legitimate values are complete sentences, which the
  generic `hasProseShape` rule refuses regardless of field name, collapsing the value to
  `[redacted:shape]` and defeating the field's own purpose. The hatch trusts the field NAME to lift
  the prose-shape rule alone; every other guard (secret, personal-identifier, structured-payload,
  length, path) still applies. This is sound specifically because `diagnosticSummary` — unlike
  `frames`/`causeChain` — is never a directly caller-settable field on `ServerDiagnosticRecord`: it is
  computed at exactly one call site (`diagnosticActivityLogFields`), always via `allowlistedSummary`
  against a fixed, code-declared vocabulary, so trusting the name does not widen what can reach the
  log beyond what that one call site already enforces.
- Truncation becomes visible rather than silent, and the marker itself CONSUMES A SLOT rather than
  riding along for free: when an array actually exceeds its cap, only `MAX_LOG_ARRAY_LENGTH - 1` real
  elements survive, plus one bounded marker element (`DROPPED_LENGTH`); when the field-count cap
  breaks early, only `MAX_LOG_FIELD_COUNT - 1` accepted fields survive, plus one synthetic
  `_truncatedFieldCount: true` key. Either way the configured cap (`MAX_LOG_ARRAY_LENGTH`,
  `MAX_LOG_FIELD_COUNT`) holds EXACTLY — never one over. An input at or under the cap is untouched
  and carries no marker. An agent reading a record can distinguish "nothing more happened" from "more
  happened and was cut for size."
- A closed-vocabulary helper, `closeReasonVocabulary`, gives any future bounded-string-array field
  (starting with `unsupportedReasons`) the same structural `Set`-plus-fallback closure categories
  already have, replacing a comment-only closure with an enforced one.

The product-level guarantee this preserves: the contract admits more **structure**, never more
**content**. Every new field is a shape, a count, a class name, or a hash — never a body.

### D5 — Correlation threading is end-to-end, with an explicit parent link

`correlationId` already exists on `ServerLogEvent`. This contract closes the places it does not yet
reach and adds the one relationship it cannot express today:

- **UI → BFF**: the desktop chat SSE path and ordinary BFF requests share one correlation id,
  minted or read consistently, rather than two disconnected id spaces in the same file.
- **BFF → gateway**: `GatewayCallRequest.logContext`/`ModelGatewayLogContext` — already defined and
  unit-tested with zero production callers — become the wiring every model-call site uses, so a
  gateway retry, circuit-breaker transition, or provider error line carries the same id as the BFF
  request that triggered it. A rate-limited call always carries `httpStatus` on that same line —
  the provider's actual status, with `429` only as the default a standard rate-limit error
  assumes when none was supplied — so an agent reconstructing the failure never has to infer the
  HTTP status from the error class alone; `retryAfterMs` carries a parsed provider retry value,
  never the gateway's fallback backoff. OpenAI-compatible HTTP errors also carry the closed
  `retryAfterHeader` observation (`absent`, `valid`, `unparseable`, or `elapsed`) on the existing
  retry events. A rejected header therefore remains distinguishable from an absent header without
  logging its contents. Legacy adapters that do not supply this observation retain unknown header
  availability; absence of `retryAfterMs` alone must not be interpreted as proof of no header.
- **BFF → WebSocket**: one correlation id is resolved once per connection at upgrade time, not
  re-minted per failure, so every diagnostic a WS session emits over its lifetime is joinable to
  the same id.
- **BFF → background job**: a background run (a harness run, a workflow event) spawned from a
  request whose id is known carries a new `parentCorrelationId?: string` pointing at the spawning
  request's `correlationId`. This is additive — a top-level request has no parent — and is the
  mechanism an agent uses to walk from "what the customer directly triggered" to "what that
  triggered in turn," which `correlationId` alone cannot express because it names only the current
  operation, not its ancestry.

Server bootstrap follows the same operation model even though it has no HTTP request: composition
mints one valid bootstrap correlation and threads it through persistent store migrations, store and
memory-vault opening, security/config resolution, gateway initialization, runtime construction, and
initial task-workspace composition. A detached startup job mints its own correlation and points its
`parentCorrelationId` at that bootstrap id. Process-lifecycle events remain the deliberate exception
described in D9 and continue to use `(pid, instanceId, seq)`. Test-only and in-memory stores receive
no implicit process sink, so constructing a fixture cannot contaminate the running application's
activity log. `UNKNOWN_CORRELATION_ID` remains available only when a reusable internal operation
genuinely has neither a request, run, job, nor bootstrap context; it is not a bootstrap default.

`parentCorrelationId` reuses the existing `isValidCorrelationId` shape guard; it is not a new trust
boundary, and browser-supplied values are never accepted as authoritative without server-side
validation — the same posture that already governs `correlationId`.

### D6 — The generated typed registry is the single production authority

Every production operation is declared through `defineActivityLogOperation` and emitted through
`activityLogEvent`. The declaration is data-only and lives at the owning package, but it is not a
free-form object: it names the literal operation/category, owning emitter, exact flattened fields,
primitive types, maximum lengths/counts, closed values and data classes, correlation requirement,
lifecycle phase, analyzer projection, supported failure classes, executable proof ids, and release
impact. TypeScript derives the exact event field type from that declaration, including required and
optional fields; unknown keys and wrong values are compile errors.

Generation resolves the two canonical `keiko-contracts` APIs through TypeScript declaration and
alias symbols. A local same-shaped helper is unrelated and ignored. A non-literal or unresolved
canonical registration/emission, a duplicate operation, a registration with no emitter, an emitter
without its registration, or relevant compiler diagnostics is an actionable closed violation. The
checked-in catalog and generated runtime module come from those canonical declarations. The runtime
module contains the complete safe operation schemas and failure-class coverage as well as the
registry/schema/catalog identity constants; it is not a digest-only index. The drift check requires
both byte equality and an empty authoritative violation set.

The predecessor bracket scanner remains temporarily in the same generated file as a visibly
non-authoritative migration input. Its `<dynamic>` and `unknown` records authorize nothing and must
disappear as producers migrate; no second catalog or parallel runtime vocabulary exists. Runtime
construction validates the registration-derived fields, binds the registration non-enumerably to
the event, and the physical sink repeats validation immediately before serialization. This second
check closes post-construction mutation and protects JavaScript callers that did not pass through
the TypeScript checker. A rejection produces only a closed body-free rejection kind; it never
echoes the rejected operation, field, or value and cannot recursively enter the failed sink.

Every generated operation schema includes required `completeness` and `loss` contracts. The event
constructor supplies the safe defaults `complete` and `none`, while a producer that observed
partial evidence or known loss overrides those values explicitly. Central ownership makes the two
signals structurally present without duplicating identical declarations across every emitter.

The registry also generates two derived governance surfaces from those same declarations. Stable
implementation-obligation categories give later quality gates one machine vocabulary rather than
redeclared documentation rules. The failure-class coverage matrix groups each supported class by
owner, operation and lifecycle role, causal edges, safe context/evidence classes, loss signals,
analyzer projection, and executable proof or replay references; release expectation is 100%
complete. Missing required completeness, loss, or proof evidence is a registry violation.

There is one exemption schema inside this registry and no side list. It scopes one reviewed record
to one exact registered operation/failure-class pair at an unavoidable platform or durability
boundary and requires a stable id, owner, technical reason, linked issue, and expiry. Validation
rejects broad or unknown scope, duplicates, stale/expired records, and any extra key that attempts
to authorize prohibited fields, silent loss, or incomplete evidence. Exemptions cannot modify an
operation schema or reduce a supported class's sufficiency requirement.

**One command enforces the contract permanently.** `npm run check:activity-log` builds the packages
and then evaluates the complete registered inventory on every run by composing the checks that own
each rule: `check:op-catalog` (registry, exemptions, failure-class coverage, failure-surface
inventory, proof and scenario resolution), `test:activity-log-scenarios` (executes the curated
scenario matrix the inventory resolves), `check:error-observability`, `arch:check` with
`arch:check:negative`, and `check:release-impact`. Required CI runs that exact command. It takes no
changed-file input, so diff awareness can never narrow what it proves. That includes the catch
rule of `check:error-observability`: it scans every production file on every run, and the failure
paths that predate the full-tree rule sit in a committed register that may only shrink
(`docs/observability/legacy-failure-path-register.json`); nothing adds to it. The exemption validator also
requires the record's owner to be the operation's owning package and its expiry to lie at most 180
days ahead, so no record is unowned or permanent.

**Every production process has a writer, and a missing one is visible (#3532).** The registry is
authoritative only when every production emitter reaches the sink that enforces it. The
process-wide logger therefore resolves the runtime state directory exactly as the CLI does: a
non-empty `KEIKO_STATE_DIR`, resolved against the working directory when relative, else
`<cwd>/.keiko`. So `keiko run`, `keiko memory`, `keiko evaluate` and every other command that never
set the variable write the same Activity Log that `keiko start` in that directory would.

- A logger that writes nothing exists only when a test installs it explicitly: the vitest setup
  files set a global test-writer symbol.
- A production process whose log directory cannot be opened gets an unavailable logger. It counts
  every event it receives as lost, and it is rebuilt on the next event instead of being memoised.
- The log's own evidence bypasses the `KEIKO_LOG_LEVEL` threshold: `process.started`,
  `process.exiting`, `process.fatal`, `activity-log.readiness`, `activity-log.loss`, and every
  `lifecycle: "loss"` registration. `silent` can quiet the log. It can never hide that the log was
  quieted or that it lost data.

Domain packages keep their own injected port (`SecurityLogSink`, `KnowledgeLogSink`,
`MemoryVaultLogSink`, `ConsolidationLogSink`, `ModelGatewayLogSink`). The composition roots hand
every port the process sink. `keiko memory` hands it to the memory vault and security ports. The
Gateways built by CLI model resolution, `keiko run`, the prompt enhancer and `keiko evaluate` write
through it, and so does the Quality Intelligence capsule store. `cli.audit.*` is now registered
like every other operation. Before this, those lines were unregistered plain objects that the
production sink refused.

Adapters preserve the event's non-enumerable registration and rejection markers when adding
correlation context. `withActivityLogCorrelation` and `withActivityLogParentCorrelation` share one
copying implementation; producer-owned ids remain authoritative. A plain spread is not a valid
forwarding operation. Readiness initialization forwards both its own lifecycle events and nested
HTTP transport events through this path. Its regression validates the forwarded events with the
real registered formatter, and the installed Workbench journey requires complete exported and
analyzed failure evidence, including bound seed data and safe failure-site frames.

**The port pattern for a new package (BYOA #482).** A package that performs work follows five rules:

1. It declares its own `<Package>LogSink { write(event) }` port.
2. It builds its events with `activityLogEvent` from its own registrations.
3. It receives the process sink from the server or CLI composition root. It never constructs a file
   sink and never reads `KEIKO_STATE_DIR` itself.
4. It isolates its sink. A throwing `write` is caught and counted as `port-sink-failed` in the loss
   ledger, every time and not only the first. An event handed to a port with no sink wired is
   counted as `port-unwired`, so a missed composition edge is visible instead of silent.
5. It reports a failing sink once per sink instance, on the independent process-warning channel.

**Loss is counted, never silent (#3532).** One bounded, process-wide loss ledger lives in the
contracts leaf, so every layer can reach it without a dependency edge that points the wrong way.
It is a fixed record of saturating counters, never a queue and never content. Each counter has a
closed reason:

- the logger: a failed write, or no writer at all;
- a schema rejection;
- a persistence failure;
- a failed diagnostic sink or domain-port sink;
- the BFF's rejected and rate-suppressed browser reports;
- the browser's own evicted, throttled, failed and cap-suppressed reports;
- events the CLI collector dropped;
- a summary that could not be written.

The server persists the counters as an `activity-log.loss` summary: on a heartbeat when the
counters changed, and always at exit, so a clean shutdown also proves that nothing was lost. A
summary that cannot be written only increments its own counter, so the accounting never recurses
into the failing sink. The browser counts its own side in the same closed vocabulary. It sends the
counts with its next report and once more when the page is hidden. The BFF adds them to its ledger
and records them on the `client.diagnostic` line.

**Readiness is a closed, observable state (#3532).** Each process evaluates whether it can currently
produce reconstruction evidence. The result is one of three states: `ready`, `degraded` or
`unavailable`. It carries three more facts:

- the closed reasons: `catalog-mismatch`, `sink-unwritable`, `storage-pressure`,
  `budget-exceeded`, `port-unwired`, `level-silent` and `storage-check-failed` (a storage check that
  throws is reduced to this reason and its error is dropped, so readiness never freezes on a stale
  state and never carries a path);
- the writer kind: `production-file`, `test-injected` or `unavailable`;
- the lost-event total.

The startup evaluation runs before the server listens. It persists its `activity-log.readiness` line
through the durable append path, so the probe is a real write, not a permission check. A failed write
means `unavailable`, with the reason `sink-unwritable`. Storage conditions come from the segment
store's own health report (`activityLogStorageHealth`), which covers the segment store's state:
writability, byte budget and pressure, including blocked retention. Segment manifests (D16) are not a
readiness input: they are derived metadata, rebuilt whenever missing or stale, and never on the path
that writes or reads evidence, so their state cannot make evidence unwritable or unreadable;
`keiko support manifest verify` reports it. The heartbeat re-evaluates without a probe
and logs every transition. A persistence loss since the last evaluation degrades readiness with
`sink-unwritable`. `GET /api/health` returns the snapshot as `diagnostics`. `keiko status` prints
it, and so does `keiko support export` for the exported directory. The desktop workspace shows a compact notice when readiness is degraded or unavailable,
with an error-report action. Closed technical reasons remain in the health response, Activity
Log and exported report; the notice uses plain language. The shell owns the health poll, so
readiness does not depend on the lazy footer module. Verified degraded or unavailable snapshots
are displayed immediately; transport unavailability requires two consecutive failed polls so one
transient read does not become a persistent outage notice. Each report selects the actual observed
health request correlation and any captured failure facts. Observations without attribution request
client-only evidence instead of selecting an unrelated latest incident. A pending or ready report
keeps its original selector through health recovery. The footer displays the installed version.

**Sufficiency is proven compositionally (#3532).** Four mechanisms close the gap between declared
and demonstrated evidence. Each is derived from the registry, never maintained beside it.

- **Contract-level proofs.** A proof id (`<op>.<suffix>`) resolves only through a literal
  `expectActivityLogProof` or `expectActivityLogStderrProof` call in a test of the owning package.
  The call asserts a line that the real formatter produced: `formatRegisteredServerLogLine`, or the
  file sink itself. It checks this build's v2 identity and the registered fields, so a captured
  event object can never stand in for a persisted line. The generator reports an unresolved,
  misplaced, non-literal or unregistered proof as a violation.
- **The failure-surface inventory.** `docs/observability/failure-surface-inventory.generated.json`
  maps every operation to one of nine product surfaces through a closed rule table (owner package
  plus emitter-module prefix). It maps every owner to its log port, and every failure class to a
  `<surface>.<mode>` scenario, where the mode is `rejection`, `dependency-failure`, `crash` or
  `loss`. The autonomy mode is closed context on events, not a matrix multiplier. The inventory
  holds only what the catalog does not carry, and `check:op-catalog` pins it byte for byte.
- **Per-failure-class sufficiency.** `keiko support analyze` projects every observed class to
  `complete`, `degraded` or `insufficient`. The closed reasons are `DIAGNOSTIC_SUFFICIENCY_REASONS`
  in the contracts, and there is one status rule, `diagnosticSufficiencyStatus`. The projection is
  derived generically from the class's lifecycle and causal declarations. Artifact integrity, parent
  correlation, the class's causal start on a failure's correlation, an unknown failure correlation,
  own-line partial evidence and Activity Log evidence loss all feed it. Loss, including a producer's
  confirmed drop such as a segment seal's `droppedEventCount`, is attributed to the named dropped
  operation, to the reporting package's classes for a port sink failure, or else to the reporting
  process lifetime. A product loss that its own loss line fully evidences keeps the report complete.
  The projection is carried by `--json`, `--seed` and `support.analyze.classified`.
- **A curated end-to-end scenario matrix.** For each surface and each applicable mode,
  `tests/activity-log-scenarios` drives a production entry point through the real file writer. The
  support analyzer must then reach `complete` (`expectActivityLogScenario`). Every failure class
  maps to the scenario of its surface and mode, and no class gets its own journey.

A registration never declares `frames` or `causeChain` required. Redaction omits an empty array, so
a required one would reject the ordinary failure without Keiko frames or a cause. The generator
reports that declaration as `registration-omitted-field-required`.

Grounded diagnostics use the same registry and request correlation. `search.citations.reconciled`
covers numeric references and file locations for Knowledge Pod, folder, multi-source and hybrid
answers. `citationKind` identifies `numeric` or `file`; hybrid may emit one of each. Required
reference, attached and dangling counts share the closed reconciliation outcome. File lines add
`ambiguousMarkerCount` and `droppedImplicitCount`; optional weak-overlap/grouped counts describe
only measurements actually made. Omitted metrics must not be interpreted as measured zeroes.

`client.citation.activated` records a citation click and its source selection under the
activation correlation. `reason` describes the source fingerprint: `matched` (one root),
`unmatched`, `absent`, `malformed`, or `ambiguous` (several matches). `outcome` records
`opened`, `open-refused`, `picker-opened`, `picker-dismissed`, or `refused`; an opened picker
is not a successfully opened file. `rootCount` and `matchCount` explain the choice without
recording the fingerprint, file path, source label or citation text. The registered server
projection retains these closed fields on the existing Activity Log timeline.

The `grounded-pack-validation` diagnostic carries closed `validationReasons`, `violationCount`,
`validatorThrew`, sanitized `originalCode`, optional `sourceIndex`, and `diagnosticOutcome`.
`source-skipped` is a warning preserving independent healthy sources; `request-failed` retains the
failure status. `search.connected-context.completion-details` separates scope-context state,
observed/retained files and charged/capacity bytes; excerpt omitted ranges, truncated windows,
unread files and stop reasons; and metadata observed, retained and discarded counts. These are
phase measurements, not a claim that every discovered file reached the model.
`workspace.root.denied` records the actual safe errno or error class as `failureKind`, preserving
the underlying recognized cause of `WorkspaceNotFoundError`, with error kind, frames and cause
chain when available. It no longer substitutes a constant root-not-found label for every cause.

### D7 — Process lifecycle events give the log a subject

Before this contract, the log recorded what happened but never which process, running which
version, configured how. `category: "process"` events close that gap: `process.started` (node
version, platform, arch, product version, install mode — and, when detection failed, its own
error kind — host, port, resolved log level, the count of configured gateway providers, and a
closed-union `stateDirSource` label — never the raw state-dir path, which can embed an OS username
that the existing path guard exists to refuse), `process.heartbeat` (memory and event-loop-delay
gauges on an `unref()`'d interval that never keeps a one-shot CLI command alive and is cleared on
every shutdown branch), and `process.exiting` (reason, uptime), which closes the log descriptor
cleanly on every real shutdown path using the sink's own close function.

Configuration identity ended up carried by two lines rather than three: the cheap, universally
available fields (node/platform/arch/product version, install mode, host, port, log level, gateway
provider count) ride directly on `process.started` itself — there is no separate `process.config`
op — while the gateway-specific fields that are only knowable once a `GatewayConfig` has been
assembled ride on their own `gateway.config.resolved` line (emitted once per `Gateway`
construction: `providerCount` and `providerConfigDigest`, a digest over the per-provider
`modelId`, `endpointHost`, `timeoutMs`, `maxRetries` and `retryBaseDelayMs` — never `baseUrl`
or `apiKey`). Folding the cheap fields into `process.started`
rather than a separate `process.config` line avoids a second, always-co-occurring event for data
that is knowable at the exact same instant `process.started` already fires. Feature flags remain an
explicitly named, out-of-scope-for-this-epic follow-up.

Every exit leaves exactly one `process.exiting` line (#3532). A fatal uncaught exception or
unhandled rejection writes three lines in order, then the process exits:

1. `process.fatal`, which goes to the resolved runtime state directory even when no server was ever
   built;
2. the exit loss summary;
3. `process.exiting` with the reason `fatal-exception`.

A server error takes the same path. Each other exit records its own closed reason: `sigint`,
`sigterm`, `sighup`, `server-close` or `shutdown-request`. A `process.exit` fallback records
`process-exit` when no other path ran first. A process-wide latch makes the first recorded reason
the only one, so the close that a crash causes is never relabelled. The lines carry the classified
error kind and Keiko-code frames only.

### D8 — One canonical private support report (#3534)

The export is one canonical UTF-8 JSON file, kind `keiko.support.report`, schema version 1. It
contains only the validated private SupportIncident projection, a closed selection verdict with each
process lifetime's start account (`selected`, `absent` or `lost`), registered causal events, and
integrity metadata. It does not copy raw log text. The event section is canonical structured JSON,
losslessly compacted with deflate/base64; every decoded record is validated against its exact
repository-owned registry. No sender-provided registration or self-asserted redaction flag is
authority. The recorded product version identifies the bundled package versions, which the product's
version-consistency gate keeps in lockstep; persisted events retain their exact
build/release/platform classes and registry/schema/catalog digests.

New exports replace correlation, parent and opaque customer identifiers with consistent ordinal
references local to that report. The mapping is never exported; causal joins remain intact without
revealing the original labels. Paths, routes and prose remain redaction markers. Diagnostic modules,
declared Error classes and technical tokens must belong to the generated product-source inventory
or a closed runtime vocabulary; merely looking like a technical identifier does not authorize a
string. Unknown diagnostic details are omitted or marked, with insufficient evidence reported when
immutable failure provenance cannot be preserved. Historical schema-1 reports remain readable.
Archived releases use their producing release's pinned code-module inventory, paired with the
archived registry identity. Module moves in a later release therefore do not discard an otherwise
valid historical failure frame. These inventories are generated from trusted release commits,
never from customer reports, and decoded within a fixed byte limit.
For an explicitly selected desktop failure, sufficiency and segment references derive from the
selected causal evidence rather than the later click-time incident window. Missing or truncated
evidence remains insufficient under the ordinary query and report validators.

The desktop exposes the same canonical report as a local JSON download at actionable failures.
The healthy workspace footer has no report action. Exact browser resize notifications and Monaco
cancellations are classified before failure caps; they do not create incidents or report actions.
An uncaught browser error or rejected promise
reveals a compact, dismissible workspace notice tied to that failure; handled contextual errors retain
their own action. Each active failure shares one bounded report generation, keeps a download link
available for repeated attempts, and remains visible until human dismissal. Failed creation remains
retryable and unmounting cancels pending work. The selected
incident and compressed event section travel together, so support can inspect the evidence without
access to the customer's complete logs. Export uses the existing paired application session and a
bounded worker; it never uploads externally by itself.

Browser-only failures retain at most 100 projected diagnostics for report delivery. Export waits
for ingest acknowledgement; if the original delivery failed or was throttled, a human report action
may redeliver it under the same correlation, within a separate six-per-minute client budget and the
server's unchanged admission limits. The 35-second export deadline includes that delivery. Missing
delivery remains retryable without exporting an unrelated incident or filing another reporting
incident. Successful saves deliberately excluded from history by secret protection have no report
action; degraded history protection retains its contextual action.

The fixed bounds are 10 MiB for the entire file, 1 MiB for the incident projection, 16 MiB for the
decoded event section, 64 KiB per event, 20,000 records, 12 JSON nesting levels, 250,000
containers, 3,000,000 values and 256 keys per object. The shape bounds are checked on the raw text
before `JSON.parse` allocates anything, and every string is printable ASCII. Derived ordinary
and update timelines share an additional ceiling of 80,000 record occurrences and 64 MiB of UTF-8
record-view payloads; parent fan-out is charged before expansion. A producer that exceeds these
limits emits explicitly insufficient evidence, while an incoming report is rejected before output.
`--max-bytes`
may lower the final-file ceiling but cannot raise it. These are separate limits: compression cannot
hide unbounded decoded input. Every real #3532 fault-injection scenario also passes its incident
and selected closure through the production report builder and offline analyzer. These traces fit
below 128 KiB without losing any selected record, and sufficient inputs remain complete. The
production-record calibration in `support-report.test.ts`
retains 2,000 diagnostic failure events plus process context below 128 KiB, with exact event-count
and complete-reconstruction assertions, including an offline run under a 128 MiB Node heap. The 10 MiB ceiling leaves substantial headroom for less
repetitive safe signals while fitting attachment policies that permit 10 MiB. Operators with a
narrower policy lower it explicitly. There is no universal attachment-size promise.

The existing selective query still owns causal closure and bounded process context (D16).
Required evidence is never silently cut. When it cannot fit, the report contains an explicit
`insufficient` verdict, closed reasons and the bytes a complete selection needs: the query's
required event bytes when the event section is the limit, or the complete report's size when the
final-file budget is; the evidence section is empty rather than falsely complete. If even the
bounded incident/header cannot fit, no report is published. A selected record that the incident's
exact registry cannot validate (for example one written by another release after an upgrade) is
left out and named by `unsupported-evidence`; every other record is kept. Optional context loss
remains explicit.

Integrity uses SHA-256 section digests and one digest over the canonical report excluding only
its own digest member. There is no sidecar. A seed additionally names the digest of the exact
received file bytes. Neither digest authenticates a sender: analysis always says `authenticity:
unknown`. Encryption, signatures and key distribution/rotation/recovery remain future hardening
requiring a separately governed design, not this epic's privacy boundary.

Raw `ui.log`, screenshots, free-text notes, arbitrary files, configuration snapshots and full
EvidenceStore manifests are excluded structurally. All former inclusion flags are refused.
An old `ui.log` remains untouched; UI diagnostics use the existing Activity Log. Producer-only
prose/route hatches (`path`, `routeTemplate`, `clientNote`, `diagnosticSummary`) become explicit
redaction markers in the report projection. They never import narratives or usable addresses.
Frames and causes are reverified through the existing owning reducers, and every other received
producer field must be a fixed point of the existing `redactLogFields` redaction: a value that
redaction would still change (an endpoint, a secret shape, a home path) refuses the report. Envelope
labels (`op`, `errorKind`, correlation ids) and the incident's correlation references must
likewise be fixed points of the writer's label redaction, so a credential-shaped correlation id that
the correlation grammar admits is refused; the incident producer never adopts such an id.

### D9 — Export, offline validation and replay preparation (#3534)

`keiko support export [--out DIRECTORY] [--state-dir PATH] [--max-bytes N]` optionally selects
`--incident ID`, `--correlation-id ID` or `--defect-fingerprint SHA256`. Without a selector it
creates a user-reported incident. An explicit causal selection is evaluated before that creation, so
recording a new incident cannot manufacture retained evidence for an absent correlation.

The default location is `<stateDir>/support-reports/`. Its directory is owner-only (0700): it is
created so, or it must already be a real directory of this user, and it is hardened through a
descriptor that refuses a final symlink, so a redirected `support-reports` never has its target
changed. The report `keiko-support-v1-<12 hex incident prefix>-<UTC date>.json` is owner-only
(0600). The name contains no host, user, workspace or path name; its date is the incident's UTC
creation date. Explicit `--out` selects a directory, never a file: a new one is created owner-only,
an existing one must not be writable by group or others, and no directory inside the state or
control-state Activity Log is accepted (compared by device and inode as well as by path, so a
firmlink or bind-mount alias cannot pass). The closed filename class always applies. The directory
never enters the report or Activity Log. An unknown `--incident` or `--defect-fingerprint` records
nothing and exits 1. Publication reuses `publishSafeArtifactFileSet` with one entry and no fixed
publication slot. It atomically and exclusively commits the fully prepared file, cleans intermediate
stages on success, and never replaces an existing destination. A crash leaves private, recognizable
staging/recovery state. Retrying the exact bytes may recover; changed bytes, a conflicting target or
unsafe recovery state fail closed. No stage is treated as a valid report merely because it exists:
the next export into the directory names how many `.keiko-publish-<24 hex>-<n>.stage` files it
found, and the runtime-state contract classifies them, with the closed report names, as Keiko-owned
in `support-reports/`. The strict reader rejects incomplete bytes and invalid digests.

**Desktop local export (owner decision, 2026-10-03):** an explicit report action downloads the same
validated, content-free report through the browser. Its configured download destination and
filesystem permissions apply, including a default Downloads directory without a save dialog.
The browser API cannot enforce the CLI's 0700/0600 modes, exclusive no-follow publication, or
owner-private receiving-file check. Those guarantees above apply to CLI exports, not browser
downloads. Keiko performs no automatic upload or disclosure. A downloaded report must still pass
the canonical offline validator before it is analyzed; operators who use the owner-private CLI
reader first place it in a private directory and file according to the receiving-file contract.

Report creation is reported as readiness, never as download initiation or an acknowledged
operating-system save. The report action exposes a persistent **Download report** link for a real
user gesture; it performs no asynchronous synthetic-anchor download. The same link retries the
prepared bytes without a second report request. The BFF serves a standard gzip HTTP attachment
at `/api/diagnostics/report/download/:downloadId`; decompression yields the exact canonical report
bytes. The outer gzip framing is transport, not integrity-covered report content: section/report
digests and `sourceArtifactDigest` cover decoded canonical text. Equivalent gzip metadata may
therefore yield the same artifact digest; exact received-file custody requires a separate file
hash. Bounded decompression and canonical validation remain mandatory. The response has `application/gzip` content type and an attachment filename ending in
`.json.gz`, without `Content-Encoding` that would cause transparent decoding during download.
Full reports require the exact existing session that generated the artifact; their opaque
reference conveys no authority. Failure to acknowledge browser diagnostic delivery does not
remove access to retained server evidence under an already valid session.

The report action's request correlation identifies its own preparation and cleanup lifecycle. It
never substitutes for a missing original Support-ID. Full-report descriptor preparation normalizes
the selected identity through the shared report contract before looking up retained candidates; an
unselected manual descriptor receives a fresh opaque incident correlation. An explicitly invalid
evidence selector is refused before reading diagnostics, rather than selecting another failure.

If the local session is absent, forged or expired, an explicitly insufficient client-only report
can be produced without reading private server state. An explicit client-only privacy selection
uses the same branch. It never reads a log, creates an incident or retention pin, or attributes a
registered server failure. The manual header remains unattributed with unknown error kind and zero
frames; server evidence is empty. The optional closed `clientReport` projection records
`serverEvidence: unavailable` and the closed reason for excluding server evidence. This field describes
which evidence is available **in the artifact**, not whether the backend is healthy. An authorized
explicit client-only selection records `client-only-selected`; a displayed validated client failure
without a trustworthy original correlation records `correlation-unavailable`. Missing authority
records `session-unavailable`. Actual selection/delivery and service failures keep
`diagnostic-delivery-unavailable` and `service-unavailable`; a scope choice never invents such an outage.
Both the live BFF's limited branch and
the browser-produced report preserve the validated original Support-ID and available closed
client failure descriptors. The bounded 1024-byte request includes complete optional stack evidence
when it fits; otherwise that optional evidence is absent, never represented as an observed empty
stack. Kind and closed context remain available. Unverified client descriptors stay separate from
registered server attribution, and authenticated full reports use authoritative server evidence.
Original messages, paths, stacks and credentials are excluded. The UI presents ordinary report readiness
and a download action; detailed evidence availability belongs inside the report.

Only validated limited bytes can be served under a client-only attachment reference without a
session; that reference never grants access to a full report. Reports remain schema v1 with
canonical integrity hashes. Older strict consumers may reject the new optional projection rather
than silently claim compatibility; receiving operators use the current canonical validator and
analyzer. If the BFF or the report module is unavailable, the resident shared canonical producer
can compose a bounded client report locally. Local download bytes use the same standard gzip
transport, and existing fulfilled reports preserve their canonical content during transport
recovery. Readiness and a manual initiation never claim an operating-system save. Successful local
preparation emits the routine `client.support-report.prepared` state on the existing diagnostic
sink, with the original correlation when available, closed evidence scope and availability reason,
the already measured canonical byte count, and artifact quality in `reportCompleteness` and
`reportLoss`. The event itself is complete with no event loss when recorded successfully.
`availabilityReason` is present only for client-only scope, and canonical structural completeness
does not imply diagnostic sufficiency. It contains no report content or failure kind
and creates no new failure incident. A failed local attempt uses the same preparation member's
closed `outcome: failed` variant with only an error kind and measured duration; it never invents
artifact bytes or availability. Ingest records `client.support-report.preparation-failed` as routine
causal state evidence without replacing the selected browser failure or opening another incident.
This browser-local outcome does not close a server report lifecycle and does not fabricate a server
request start; server report failures retain their existing start and terminal obligations.
Ordinary server preparation retains its existing lifecycle without duplicating this browser recovery state.
Process-local delivery caching is bounded by twice the canonical per-report cap (20 MiB), 128 entries
and a 15-minute lifetime. The server remains authoritative for attachment expiry. The browser
projects that response's server expiry onto its local download timer using the HTTP `Date` header,
subtracting its one-second precision uncertainty and observed time spent reading and validating
the body after the headers arrive. Preparation before the response does not consume a newly issued
capability's lifetime. Network transit before header receipt cannot be measured separately from
preparation; the server's expiry check remains authoritative. The browser never rewrites the wire
timestamp. Older responses with no `Date` retain strict local-clock bounds; malformed dates never
grant an extended lifetime.
The normal manual-download diagnostic retains its existing source, scope and digest.
The aggregate byte allowance retains one ready maximum-size artifact while
its replacement is prepared, also admitting a small canonical limited report beside one full report.
Each artifact remains capped at 10 MiB. This is a payload-byte retention bound, not an exact resident-memory measurement: JavaScript object overhead and temporary compression buffers are additional. Only the retained raw or compressed representation is charged;
gzip replaces its raw ownership after successful compression. Concurrent downloads share one
compression attempt; a failed attempt releases only its memoized promise so a later user retry can
recompress the same retained canonical bytes. After compression, delivery rechecks the original
authority, expiry and exact live cache entry before writing an attachment. A disposed entry cannot
later emit a delivered result. Limited entries are removed before protected
entries under byte or count pressure; unauthenticated limited creation cannot evict a protected
artifact. Before admitting a limited replacement, the cache checks the existing protected byte and
entry reservations. If protected artifacts leave insufficient capacity, refusal preserves already
prepared limited artifacts rather than evicting them in a futile attempt to fit the replacement.
Genuine exhausted protected capacity returns a `503 SUPPORT_REPORT_UNAVAILABLE` response and
records the closed `delivery-capacity` reason, allowing the existing browser-local report fallback
without growing memory. Quota, evaluation and report-size refusals intentionally use the same
recoverable preparation response; the Activity Log preserves their specific closed reasons. Only
an active-worker `busy` refusal remains `429`; a missing requested selection retains its distinct
`SUPPORT_REPORT_SELECTION_UNAVAILABLE` code. The routine `support.report.ui.delivery-released` state records actual expiry,
byte-pressure or entry-pressure disposal using the original creation correlation, canonical and
charged retained byte counts, and closed authority and evidence scope. It contains no attachment
token, filename or report body and does not claim evidence loss or an operating-system save. Expiry makes report creation available again. The response uses `no-store`,
`nosniff`, and the closed canonical filename. Older-server local object URLs are released on
eviction or explicit global-error dismissal. A global error stays visible until human dismissal.
The body-free `support.report.ui.delivered` state records canonical artifact bytes and the separate
compressed transport byte count, without claiming that the operating system saved them. It emits
only on response finish; `parentCorrelationId` joins the creating request and `reportDigest`
identifies the canonical artifact. `support.report.ui.failed` records cancellation, compression
failure and response-write failure. `support.report.ui.download-refused` records closed authority
or unavailable-reference refusals. Neither implies a successful download. The routine
`client.support-report.download-started` line records manual initiation and its causal link to the
selected error. Structured delivery facts preserve the source (`server` or `browser`), evidence scope
(`server` or `client-only`), and canonical report digest when available, including when a server report
is served again through a local Blob. Legacy string `automatic` and `manual` values are accepted only
for older clients. The line carries no report body, destination, filename or saved claim.

`client.files-scope.decision` records closed source-ownership and grounding-queue state, with
optional source/candidate counts and a binding fingerprint; it contains no source references or
content. `CLIENT_FILES_SCOPE_DECISIONS` is the shared vocabulary: `restored`, `owned-elsewhere`,
`released`, `blocked-ambiguous`, `fingerprint-absent`, `conflict-retried`, `ack-missing`,
`acknowledged`, `ack-invalidated`, `automatic-suppressed`, `timeout-blocked`, `timeout-recovered`,
`timeout-rejected` and `request-superseded`. Current queue and retry producers identify
`mutationSurface` explicitly as `files`, `local-knowledge` or `git-change` using the same shared
contract tuple as the validator and registered line. The original action retains its correlation
through a timeout and later recovery. Each actually refused attempt records one `timeout-rejected`
under its own correlation, with the blocking action as `parentCorrelationId`. Only
`timeout-recovered` carries `rejectionCount`: the exact nonnegative safe-integer number of refused
attempts, including zero. These are separate actions plus a recovery summary, not repeated failures
of the original action or a count of missing log events.

`gateway.setup.metadata.resolved` records the discovery outcome (`available`, `unavailable`,
`cancelled` or `failed`) and elapsed time. When setup supplied explicit selections,
`selectedModelCount` counts selected chat and embedding entries. After successful discovery,
`metadataEnrichedModelCount` counts role-compatible selected entries with nonempty discovered
metadata, `roleMismatchModelCount` counts discovered selections incompatible with their selected
role, and `notDiscoveredModelCount` counts selections absent from discovery. A role-compatible
entry without metadata belongs to none of those three subsets, so their sum need not equal the
selected count. Discovery-only calls omit selection counts; failed or cancelled discovery can
retain the known selected count but omits the three unmeasured result counts. The event contains
no model identifiers, endpoints or credentials and does not claim that every selected model has a
known context window.

The shared desktop report action preserves the selected error when reporting itself fails. A
session refusal offers report regeneration, a local service failure names application recovery, and a
rate refusal names the bounded retry delay; none grants authority or automatically replays a write.
An explicit report action first joins the existing same-bearer session confirmation after boot pairing.
This restores only valid cookie projections; absent, revoked, expired or forged bearers receive no
new authority and can still obtain the explicitly limited artifact. Cancellation during confirmation
prevents a subsequent report POST.
An exhausted diagnostic reservation buffer must not prevent manual export of already retained evidence. Desktop and CLI
export may prepare the canonical user-report descriptor without a persistent slot or retention pin,
then compose and validate the same bounded report. An unavailable independent candidate directory or
an oversized candidate record also permits this transient preparation after the existing body-free
refusal evidence. Explicit correlations must first resolve to readable Activity Log evidence;
unknown correlations and unavailable named incident/fingerprint selections remain refused. Candidate
lookup failure never broadens a selected report to another error or bypasses guarded log reads. Byte pressure rolls the oldest eligible diagnostic candidate out through its existing claim and pin
cleanup. Admission retries the actual exclusive slot claim after a removed candidate; incomplete
pin or fingerprint cleanup remains partial evidence without pretending that a released slot is still
occupied. A retained or peer-replaced slot claim still prevents admission. Pin capacity likewise
follows actual pin ownership rather than unrelated claim cleanup. In-flight reservations are never stolen. The report summary distinguishes stored from
transient descriptors with `retentionDisposition`; a transient descriptor omits `pinDisposition`
because it owns no retained pin and must not imply that a pin attempt occurred. Desktop and CLI
completion events carry the canonical incident ID, report digest, actual `incidentTrigger`, and
`retentionDisposition`; the validated selected correlation joins a transient preparation back to its
quota-refusal evidence. `pinDisposition` is emitted only for a stored descriptor with an actual pin
attempt. CLI analysis of an imported report does not claim local retention or pin ownership.
After a desktop artifact is successfully prepared and
admitted to the existing fifteen-minute memory download cache, its durable candidate and pin are
released. This means the artifact is prepared, not that it was saved or sent. Failed preparation or
cache admission preserves pre-existing diagnostic candidates. The owner preparation callback marks
only a newly created retained manual candidate; cancellation, timeout, worker failure or failed
delivery admission withdraws that exact owned candidate and its claims and pin through the existing
retirement path. Its `support.incident.dismissed` line carries the closed `abandoned` reason and
candidate state, never a successful-report or human-dismissal claim. Failed record inspection or
expiry inspection emits `support.incident.retirement-failed` on the owning Activity Log port with
the attempted incident ID, closed read/sweep stage, original reduced error class, safe frames and
causes, and request correlation. It leaves ownership intact and does not invent unavailable record
metadata or counts. Successful dismissal still requires its complete descriptor metadata. Existing candidates and
transient descriptors grant no abandonment ownership. No additional report archive is created.

After successful descriptor inspection, `support.incident.retirement-started` records the actual
withdrawal attempt under the retirement request correlation, joined to the original incident through
its parent. The terminal dismissal closes that request lifecycle and explicitly records `removalStatus`, `claimsStatus` and `pinRelease`. A
failed record removal preserves the intended candidate/reported state and leaves claims and the
pin `not-attempted`; failure after removal yields `dismissed-incomplete`, with the record already
withdrawn and remaining cleanup explicitly incomplete. The CLI reports this distinction and exits
nonzero. Dismissal and expiry failures persist warning-level canonical error kinds, reduced original
classes, and available frames/causes on their terminal lines. The dismissal request is joined to
the original incident lifecycle through its parent correlation. A missing or peer-released pin is
`not-pinned`, while a rejected pin release remains incomplete. Successful prepared completion can
never carry `abandoned`, even if a structurally wider caller object supplies that option.

When a manual descriptor's supported causal selection retains a registry-eligible failure
under the requested root or its direct child, shared CLI and desktop composition derives a
registered-failure identity from that retained event using the existing fingerprint, frame and
correlation rules. Selecting a failing child directly preserves its real parent edge.
This applies to both transient fallback descriptors and retained manual descriptors created when
regenerating an artifact after the original diagnostic candidate was released. Only candidates
whose original frames survive the shipped report code-inventory policy may supply the immutable
failure fingerprint. Error diagnostics take priority over warning summaries; framed diagnostics
take priority over unframed events at the same level. A diagnostic-category event wins the remaining
category tie; otherwise the first retained candidate is stable. No durable candidate, pin or quota slot is created by this
attribution. A selection without an eligible failing event keeps the unattributed manual identity;
deeper descendant failures remain in evidence without inventing a direct parent edge.
Unknown selected correlations remain refused before any descriptor is created. The existing
`support.incident.rejected`, `support.report.ui.*`, HTTP request and client diagnostic events retain
the quota, export outcome and closed recovery failure class.

`keiko support analyze FILE [--correlation-id ID] [--json] [--clusters] [--seed] [--emit-fixture PATH]`
reads only the explicitly chosen owner-private, single-link regular file. It reads bounded chunks,
checks UTF-8, canonical JSON, nesting, every section and record, identity and provenance, all
digests, and failure-class sufficiency **before** any rendering. Duplicate keys, controls (including
escaped terminal/bidi controls), unknown sections, unsafe fields, trailing compressed bytes and
decompression bombs fail closed. Embedded segment identifiers are closed provenance values; analysis
never resolves them against local files or the network and never executes report content or probes
its recorded PIDs.

The existing analyzer also accepts lazy option resolution after that complete validation. The CLI
uses the validated base analysis to load tool-lifecycle validators only when needed, then derives
the option-aware analysis and seed from the same decoded evidence. This avoids parsing, integrity
verification and inflation a second time; synchronous analyzer calls retain their synchronous
return type. Invalid input never reaches the resolver. The incident seed is reused for its own
correlation, while an explicitly selected different timeline receives a separately prepared seed.

The reader uses the report's exact registry/schema/catalog identity. Trusted immutable snapshots
cover every stable release from 1.1.9 up to the current version, generated from the release tags
into a data-only module; `npm run set-version` regenerates it, and a drift test fails when a shipped
release is missing or differs from its release commit. The frozen pre-move production fixture
(#3558) reconstructs against its recorded release registry. Only a matching snapshot is inflated, on
demand. Unknown registries or schemas fail closed as `unsupported-report`; a report whose bounded
declared minimum analyzer version is newer than the reader names that version. The current registry
is never substituted for an older report. A local Activity Log line without an explicit registry is
judged by the registry it records, so evidence written before an upgrade stays evidence.

Analysis recomputes sufficiency from the decoded evidence and takes the union with the declared
verdict: it can only downgrade a declared `complete`, never upgrade an `insufficient` one. The
header's provenance must agree with the evidence: the declared integrity maps to its completeness
and loss, the window is anchored at the incident's creation, a user report carries the unattributed
constants, and a registered incident's surface follows from its operation. When its own failing line
(its operation under the correlation that failure carried: the declared child, else the root) is
retained, the incident's error kind, Keiko frame count, canonical fingerprint and correlation must
be the ones the producer's rules derive from that line, so a declared child is connected to its root
only through that line's parent edge; when it is not retained, the analysis is insufficient
(`evidence-not-retained`). A child declared without its root, which no producer emits, is refused.
Another request's failure of the same operation, the root's own included, neither completes the
incident nor refuses it. A contradiction is `unsafe-report`. Every closure member, each incident
correlation and every parent a retained line names, needs a directly recorded line: a timeline
derived only through a child never proves its parent (`parent-correlation-missing`,
`evidence-not-retained`). The selection accounts for exactly the process lifetimes the evidence
shows, and the evidence must carry that account: a `selected` start missing from it, a start beside
a `lost` or `absent` one, or a heartbeat (written only after a start) beside an `absent` one is
`unsafe-report`, so dropping a start never reads as a lifetime that had none; a `lost` start, or an
`absent` one whose first segment the report no longer shows, is `evidence-not-retained`. A sender
who rewrites the account and the evidence together stays indistinguishable from an honest one, which
is why authenticity is reported as unknown. Every narrowed view, the `--correlation-id` timeline and
each seed, keeps the report's effective selection reasons, so a projection never reads more complete
than the report it came from.

`--json` streams a fully validated `keiko.support.report-analysis` in bounded chunks, schema version
1: validated private incident, selection verdict, unknown authenticity, section/report and
exact-file digests, the existing ordered timelines, process summaries, failure clusters and a
deterministic ReproductionSeed when the incident correlation has evidence. With `--correlation-id`,
`--json` emits only that validated timeline as `keiko.support.report-timeline`, schema version 1,
which `keiko investigate --from-timeline` consumes. The seed uses the incident timestamp, not the
receiver's clock. `--seed` uses that correlation by default or an explicit `--correlation-id`; safe
gateway replay preparation reuses the existing builder and exclusive fixture writer. Missing replay
capability remains explicit. Human output derives from this validated analysis. No output claims a
recorded historical PID is currently running. Support execution emits correlated body-free
`support.report.started`, `support.report.completed` or `support.report.failed`, alongside the
existing query/manifest evidence; a failure names its closed reason and a completion that is
`insufficient` is a warning. An analysis that proceeds without the lazily loaded tool-lifecycle
validator records `support.report.degraded` (`lifecycle-validator-unavailable` with error kind
`unavailable`, the error class, cause classes and Keiko frames) before its completion. An analysis
completion names the view it produced (`analysis`, `clusters`, `timeline`, `seed`), whose
correlation a seed used (`incident` or `selected`, never the id, but its SHA-256 digest) and a
published replay fixture. A degraded line whose error carries no Keiko frame (a native loader
rejection) names the catch site's own dist-anchored frames. Export writes them to the selected state
directory's Activity Log, analysis and a refused destination to the CLI control state. After a
successful export the CLI states the exported directory's diagnostic readiness (#3532), persisted
after the report so the report stays the evidence that existed when it was taken. Logger failure
uses its existing independent loss channel.

**Compatibility:** legacy JSONL bundles and raw logs are not accepted as received support reports;
they are refused by the closed reason `legacy-input`.
They lack the closed format and embedded integrity. In particular, legacy manifest/config/evidence
sections can contain prohibited data, so the receiver never imports or renders them. Regenerate
on the originating installation. The existing raw-log reader/analyzer remains available to local
queries and developer tests; it is not an untrusted-report admission boundary. Existing scripts
must remove inclusion flags and use the new versioned machine envelope. Controlled manual handling
is specified in [the support workspace guide](../observability/support-workspace.md).

### D10 — Why Wave 1 ships the exporter and analyzer alongside `seq`, not after it

The obvious sequencing — ship the ordering primitive first, add tooling once there is something
worth tooling — was considered and rejected. Shipping `seq`/`schemaVersion` and a minimal
`support export`/`support analyze` in the **same** wave means the analyzer is never written, FOR V2
LINES, against a log that lacks its own ordering field — there is no pre-`seq` fallback heuristic
for any line that carries the full v2 identity triple, because no such line has ever existed without
one. Building a v2 fallback and then retiring it is strictly more work than never building it, and a
fallback heuristic is exactly the kind of undocumented, silently approximate behavior this contract
exists to eliminate. Wave 1 therefore already changes what a customer can send Keiko's support
channel — a support ticket opened the day this wave ships already gets an artifact an agent can
order deterministically for every v2 line, rather than waiting for a later wave to make the exporter
worth using.

**This is a claim about v2 lines only — it is not a claim that no fallback ordering exists at all.**
An existing `server.log` can span the upgrade to this contract and still hold lines written before
`seq`/`schemaVersion` shipped: valid, successfully
parsed log records with no `pid`, `instanceId`, or `seq` field to order by. The local raw-log
reader must define what happens to them rather than silently dropping or misordering them.
This compatibility path does not admit raw logs or legacy records into D8's received-report
boundary: that report accepts only validated structured events. The local-reader compatibility
rule: a retained pre-v2 line is never discarded and
never treated as malformed — it is ordered by its own position in the file (the same signal used to
rank process lifetimes against each other, D2), counted in `legacyLineCount`, and surfaced through
exactly one `warnings[]` entry when that count is nonzero. This compatibility path remains required
while a current file or retained segment may span releases. It may be retired only when a reviewed
release-impact/support-baseline change and bounded retention prove that no supported log can still
contain a pre-v2 line; the reader, tests, operator documentation, and release-impact record then
change together.

A partially present or invalid v2 tuple is not legacy. The analyzer classifies each input as
supported, legacy, unsupported, corrupt, truncated, or incomplete and validates
schema version, positive integer pid/seq, bounded instance id, registry/schema/catalog identity,
compatibility, and writer capability. For a record carrying the current registry identity, it also
validates the operation, category, exact registered field set, closed error kind, and required
fields against the generated runtime schema. Within each `(pid, instanceId)` lifetime it reports sequence
gaps, duplicates, decreasing/reset values, and reorder deterministically. These machine states are
included in human and JSON output; a line cannot become trusted v2 evidence merely because its JSON
parsed successfully.
Canonical support reports intentionally select causal evidence, so the first observed event of
each process supplies the sequence baseline rather than declaring its unselected prefix missing.
Later positive jumps likewise cannot establish missing process events: unrelated retained records
may be intentionally absent from the selection. Duplicate, reset and decreasing values remain
observable in the selected records. Declared source-integrity losses and selection reasons, plus
malformed, unsupported, truncated and incomplete records, retain their existing fail-closed handling.
Raw-log and bundle analysis still reports all gaps, including a missing prefix from sequence one.

The compatibility and deprecation contract is explicit:

| Input or contract surface                                                                                      | Contract state / analyzer classification | Required behavior                                                                                     | Retirement condition                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete v2 identity with current registry/schema/catalog and `supported`/`active`                             | `supported`                              | Validate the registered operation, exact fields, closed vocabularies, bounds, and sequence integrity. | A breaking change requires a new versioned compatibility contract; it is never inferred from shape.                                                       |
| Parseable pre-v2 line with no v2 identity                                                                      | `legacy-supported` / `legacy`            | Preserve, order by file position, count, and warn exactly once per analysis.                          | Reviewed release-impact/support baselines plus bounded retention prove no supported input can contain it; remove reader/tests/docs together.              |
| Unknown schema version or mismatched registry/schema/catalog identity                                          | `unsupported-version` / `unsupported`    | Preserve the classification but exclude the record from trusted current reconstruction.               | No implicit coercion; analyze with the matching versioned contract.                                                                                       |
| Invalid JSON away from a terminal fragment, invalid types/ranges, or invalid current-registry operation/fields | `corrupt`                                | Report and exclude from trusted reconstruction.                                                       | Never demote to legacy because a prefix or subset parsed.                                                                                                 |
| Unterminated terminal fragment or explicitly declared truncation                                               | `truncated`                              | Preserve the surviving evidence and report that it is not complete.                                   | Remains explicit; no reader may silently normalize it away.                                                                                               |
| Partial v2 identity, missing required evidence, declared `incomplete`, or non-`active` writer capability       | `incomplete`                             | Report the missing evidence/capability and refuse a complete-reconstruction claim.                    | Only a complete record emitted under the current contract is supported; readers do not synthesize missing fields.                                         |
| Predecessor literal scanner                                                                                    | migration-only                           | May inventory migration candidates but authorizes no operation.                                       | Remove only when all production producers use canonical typed registration/emission and authoritative generation reports no legacy production dependency. |

The other closed evidence vocabularies are equally versioned: `completeness` is exactly
`complete | partial | unknown`; `loss` is exactly
`none | event-dropped | event-location-unknown | publication-unavailable`; and writer capability is
exactly `active | degraded | unavailable`. `complete`/`none` are the normal constructor defaults.
`partial` names a known subset, `unknown` means completeness cannot be established,
`event-dropped` means a record was not persisted, `event-location-unknown` means post-write
durability or location cannot be proven, and `publication-unavailable` means the requested support
publication could not be made durable. Any non-`active` writer is incomplete evidence to the
analyzer. Extending a vocabulary requires the versioned producer, analyzer, proofs, and these docs
to change together.

### D11 — `ERROR_KIND_PATTERN` consolidation (Wave 2, landed) is a relocation, not a relaxation

Recorded here because AGENTS.md treats this exact class of edit as the highest-consequence mistake
this repository can produce. `ERROR_KIND_PATTERN` was defined byte-identically in three packages
(`keiko-server`, `keiko-model-gateway`, `keiko-local-knowledge`), pinned only by
`scripts/__tests__/error-kind-pattern-drift.test.mjs`, a test that diffed the three declarations
against each other and whose own header stated the consolidated form was the structurally correct
answer: "a single definition cannot drift from itself." Wave 2 moved the pattern into
`packages/keiko-contracts/src/observability.ts` (the leaf every other package already depends on
inward toward, per ADR-0019) and deleted that drift test.

The three packages did not all converge on the shared constant the same way, and both shapes are
load-bearing:

- `keiko-model-gateway` and `keiko-local-knowledge` import `classifyErrorKind` from
  `keiko-contracts` directly — literal delegation, so their `code`/`name` gate cannot drift from the
  canonical pattern because there is no local copy of it left to drift.
- `@oscharko-dev/keiko-activity-log`'s `errorKindOf`
  (`packages/keiko-activity-log/src/server-log.ts`) was rewritten in the same wave to route through
  `packages/keiko-activity-log/src/error-classification.ts`'s
  `machineToken`/`contentFreeErrorClass` instead — a different, purpose-built composition, not a call
  to `classifyErrorKind`. This still satisfies the invariant `ERROR_KIND_PATTERN` protects (there is
  no second textual declaration of the pattern in `@oscharko-dev/keiko-activity-log`), and it closes
  a gap `classifyErrorKind` alone cannot: that function only judges a string already in hand, while
  `errorKindOf` also has to safely READ a hostile `code`/`name` property whose accessor may throw,
  and — when `code` is absent — fall back to a declared class name.
  `error-classification.ts` bundles exactly that reflective-read hardening
  (`safeProperty`/`machineToken`/`contentFreeErrorClass`), so the Activity Log package composes from
  it instead of composing `classifyErrorKind` with a second, hand-rolled hardening layer beside it.

The relocated pin is `scripts/__tests__/error-kind-pattern-single-source.test.mjs`: instead of
diffing three declarations against each other, it asserts — by a repository-wide text search over
every tracked (and staged-but-uncommitted) file — that exactly one file,
`packages/keiko-contracts/src/observability.ts`, declares `ERROR_KIND_PATTERN` at all, and that the
canonical declaration still gates the shapes the guard exists for (an identifier passes, a sentence
and an over-long run do not). This is a STRONGER pin than the one it replaced: the retired test could
only ever catch drift AFTER one copy relaxed; this one fails the instant a fourth package, or a
reintroduced local copy in one of the original three, declares the pattern anywhere in the tree,
before it ever has the chance to diverge.

This is named explicitly, in this ADR, as an invariant **relocation**: the invariant the deleted test
protected — "these three copies never silently diverge" — is not weakened, it is made structurally
impossible to violate, because there is no longer more than one copy to diverge. It is not a
relaxation of the pin, and no future change may cite this ADR to justify re-introducing a second
copy without a single source of truth.

The pattern remains a defense-in-depth reducer for hostile `code`/`name` properties; it no longer
authorizes a persisted error kind. Production registrations and envelopes use the versioned closed
`ACTIVITY_LOG_ERROR_KINDS` vocabulary. A shape-valid but unknown token maps to the closed `internal`
fallback (or to `validation-failed` for contract rejection) and the rejected token is never echoed.
Completeness, loss, compatibility, and writer-capability states follow the same closed-vocabulary
rule. Extending any of them is a reviewed contract change with matching registration, analyzer, and
proof updates, not acceptance of another arbitrary machine-shaped string.

### D13 — HTTP and SSE lifecycle detail, and a body-free browser diagnostic ingest (Wave 5, landed)

Chat context selection emits `chat.context.selected` before the provider call for buffered,
streaming and regenerated turns. Its request correlation joins the compacted/retained history
counts, estimated removed-prefix and summary costs, savings, final estimated prompt cost,
effective input budget and image reserve. This evidence survives generation timeout or
cancellation; the successful-turn compaction manifest remains separate. These are local estimates,
not provider-measured usage, and no conversation or image content is recorded.

Only an explicit `STREAMING_UNSUPPORTED` response permits the browser to retry a chat request
through buffered transport. Ambiguous non-envelope responses or a missing stream body retain the
request identity and require reconciliation, without automatic replay.

The live grounded context meter records `conversationInputBudgetTokens` and
`sourceCapacityTokens` on `chat.context.management`. Its compaction threshold applies to the
bounded conversation lane, not the whole model input; unused source capacity remains separately
identified. Checkpoint validity uses that same lane profile. These fields are counts only and
retain the existing timeline, causal correlation and sufficiency contract.

Gateway admission additionally records `imageCount`, the selected `imageAccounting` rule,
`imageReserveTokens`, `localPromptTokens`, `fallbackPromptTokens`, and, when present,
`reportedPromptTokens` plus schema-adjusted `providerPromptTokens`. A positive reported count
replaces the image reserve even when the local text/tool/schema floor determines the final total;
a zero count retains the reserve. The recorded candidates make those decisions distinguishable.

On retries, `reportedPromptTokens` always describes only the current counter response and is
absent when that response has no count. `providerPromptTokens` adds the current response-schema
cost to that raw count; `retainedPromptTokens` separately records the carried measurement floor
plus schema cost. Admission preserves the maximum of local, current-provider and retained
candidates. `counterSource` identifies a winning retained floor as `retained-measurement`, and
`imageAccounting` uses that disposition when only the retained positive measurement replaces the
image reserve. Neither retained value is presented as a new provider observation.

Git draft resilience correction (2026-09-27): `git.commit.draft.completed` also records observed
`promptTokens`, `maxPromptTokens`, `diffCompacted`, `generationAttempts` and `reused`. The values
explain model-context compaction, a corrective generation and a cached result without retaining
paths, prompts or draft bodies. Once normalization runs, the selected result also carries `normalizationVersion`, `normalizationRule`, `normalizationChanged`, `bodyBulletCount`, `trailerLikeLineCount`, `trailerCount`, `trailerContinuationCount`, `trailerParagraphBreakCount`, `referenceTrailerCount` and `breakingTrailerCount`. The rule is a closed class and counts are bounded by the validated 12,000-character model body. Successful generation and cache reuse carry the same structural evidence; a policy-rejected normalized answer retains it, while failures before normalization omit it. Each preparation/generation attempt separately emits `git.commit.draft.attempt.completed` under the same correlation, with `attempt`, outcome, closed failure code, bounds and that attempt's normalization evidence. The completion line describes only the selected result; attempt lines retain earlier rejected normalizations and the cause of repair, including when recovery fails before formatting or is refused before a second model call. Cache hits emit no attempt line. The timeline therefore distinguishes retained footers from normalized body items without storing labels, references or content. Chat retries before the first delivered chunk use the existing
`gateway.retry.*` operations under the same correlation; a partial answer is never replayed.

Repository-add lifecycle correction (2026-09-27): clone/register emits
`client.git-operation.attempted` before sending the request with that same correlation id.
An active dialog reports `client.git-operation.settled` with `succeeded` or `failed`; failures also
retain `client.diagnostic` with structured error evidence. Actual dismissal retains
`discarded-succeeded`/`discarded-failed`; React effect replay is not dismissal. The existing
ingest transport, routine/failure budgets, loss reporting and closed operation/outcome validation
apply to all of these reports. All clone/register lifecycle outcomes, including discarded settlements, require a correlation id accepted
by the canonical Activity Log guard; malformed ids are rejected instead of assigning unrelated
ingest identities to the attempt and settlement. Browser delivery-loss counts enter the existing
process loss ledger once after rate admission and before routine diversion. A rate-limited report
carrying loss returns 429, without consuming its client-supplied counters; the browser restores them
for later delivery. The server records this refused report once as `client-rate-suppressed`; a recognized `RATE_LIMITED`/429 response restores carried counters without also adding `client-post-failed`. Network errors, other HTTP errors and unclassified 429 responses still count as failed POSTs. Reports without loss retain the bounded, body-free 204 drop behavior. The final pagehide flush uses the closed `delivery-loss` kind with required validated loss counters. It spends a separate fixed 60-per-minute process budget, using the existing limiter and per-budget drop notices. Exhausting routine or failure traffic cannot prevent that final accounting; exhausting the loss budget itself still refuses counts with 429. This reserves admission without allowing unlimited client-count injection. It does not promise delivery during transport failure or saturation of the reserved budget.
Commit-draft refusal retains its measured prompt budget; generated and cached outcomes share a
body-free draft-key digest. No repository path or remote URL enters the evidence.

Wave 5 closes the gap between "a request line exists" and "a request line is enough to reproduce the
request":

- **The `request` line carries the exact matched route, not a guess.** `routeTemplate` is the
  `RouteDefinition.pattern` the dispatcher actually resolved (`/api/relationships/:id`), recorded by
  a per-request context the dispatcher fills and the close-time writer reads — never derived from
  the raw path after the fact, where a customer id shaped like a route word would misclassify.
  Unmatched and static requests fall back to `redactRoutePath`. `queryParamNames` lists the query
  parameter NAMES only (deduplicated, shape-checked against a bounded identifier pattern, sorted,
  capped at 16; anything dropped is counted in `queryParamDroppedCount`), never a value.
  `responseBytes` is what the response actually put on the socket — headers and body, compressed
  as sent — measured as the socket's `bytesWritten` delta from request arrival to response close,
  so JSON, gzip, static files and streams are counted the same way.
  `aborted` is computed at `close` by the shared `requestAlreadyClosed` predicate, and a request the
  client abandoned before any write logs `status: 0` instead of Node's default `200` — the
  predicate was corrected in the same wave so a normally ended response (which Node also marks
  `destroyed`) is not mistaken for an abort.
- **Every SSE stream ends with exactly one terminal line.** `sse.stream.closed` (`frameCount`,
  `bytesStreamed`, `durationMs`, `reason`) is emitted once per response on its `close` event by the
  shared frame recorder every SSE writer already funnels through; `reason` is the closed
  vocabulary `completed | client-disconnected | backpressure-killed | server-error`, and a write path
  that destroys the socket because a write was rejected marks the stream first so a backpressure
  kill is never reported as a client disconnect. `http.request.body.received` records the media
  type and byte count of an accepted request body; the six ad hoc body readers that predated
  `readBoundedRequestBody` were consolidated onto it so the line — and the 413 path — have one
  owner.
- **Every composition writes the per-request line.** `createUiServer` writes the one `http`/`request`
  line per request through the sink it is given and, when none is given, through the process
  activity log (file-backed wherever the process has a state directory, silent in a unit test that
  sets none), never a null sink. The dev lane's BFF passed no sink, so no request ever reached its
  `server.log` and a failed browser request left no server-side trace (F84, Coding Workbench run 30).
- **Diagnostic `operation` labels never carry a raw request path.** `diagnosticLabel` reduces a
  path-bearing operation label through the same route reducer the activity log uses and degrades to
  the fixed `server.operation` fallback when the path cannot be templated; the two git diff handlers
  now pass their route literal instead of `ctx.url.pathname` at the source.
- **The browser reports to the log, body-free.** `POST /api/diagnostics/client` accepts a
  `ClientDiagnosticIngestRequest` (`keiko-contracts`) — a bounded message, `clientTs`, an optional
  SSE `readyState`, a closed `kind`, and an optional `correlationId` that the server re-validates
  with `isValidCorrelationId` — and writes `client.diagnostic` with the message
  redacted into `clientNote` (never under a `message` key) behind a process-wide token bucket
  (reusing the editor's inline-completion limiter, 60 s window) that logs one
  `client.diagnostic.rate-limited` line per window carrying the count of further drops it
  suppressed, and answers `204` whether a report was kept or dropped.
  A note survives that redaction only in a code-owned shape (F29, Coding Workbench run 28, where 53
  of the 77 notes the browser sends had collapsed to the shape marker): an exact sentence, or a
  template whose every variable has a closed vocabulary. An error travels as its class name, a
  count as digits, a status as a closed label, and the editor's runtime notices as closed codes
  (`keiko-editor` `runtime-notice.ts`; the two language loaders in `keiko-ui`). The class name is
  itself closed: a name is text the error chose, so only the vocabulary `keiko-contracts` owns
  (`CLIENT_ERROR_CLASSES`: the JavaScript built-ins, the browser platform's errors, Keiko's own
  browser error classes and the `typeof` of a thrown non-Error) survives, and every producer
  reports any other name as `Error`. A note is admitted only within the logged-string bound
  (`MAX_LOG_STRING_LENGTH`, which producers read as `CLIENT_NOTE_MAX_LENGTH`), and a producer
  whose parts would not fit folds them into a count (review on PR #3452). Anything else, including a code-owned template filled with foreign text, takes the generic
  redaction every logged string takes: an over-long value, a secret, a personal identifier, a
  structured payload, prose and an unknown path each become their marker, and only a value none of
  those checks flags survives as sent (an empty note, or a short code-like one), so the browser can
  never widen what the log admits.
  Shared on-demand readiness work retains each waiting request's causality. The first caller owns
  the probe's start and completion; every concurrent caller emits `gateway.readiness.automatic.joined`
  with its request correlation and the probe correlation as its parent (omitted for an identical
  correlation). The model's digest and the configuration generation identify the shared work
  without making another provider call. Both successful and failed probes remain traceable from create, send and
  regeneration requests. Assistant-response links accept only validated correlation identities;
  malformed response bodies and invalid identities produce no fabricated link.
  Known browser prerequisite failures use closed structured fields: a Git-sync validator chunk
  failure records `moduleLoadFailure: git-sync` before any Git request, with a fresh correlation ID
  shared by the UI error and diagnostic. Markdown layout evidence may carry a separately validated,
  bounded opaque `messageId`; Coding Workbench uses its run ID as the diagnostic correlation so
  provider message IDs shorter than the correlation minimum remain joinable. Native recorder
  errors retain their cause in memory; browser failure reports may also carry a closed error class,
  up to five closed cause classes and up to eight production chunk coordinates. The browser reduces
  same-origin stack locations to `dist/ui/static/_next/static/chunks/<chunk>.js:LINE:COL`; the shared
  wire guard and existing frame redaction boundary independently revalidate the bounded shape.
  Shape validation does not prove a client-supplied basename belongs to the build. At the central
  persistence boundary, the asset path before `:LINE:COL` is therefore reduced with SHA-256 over
  `keiko-client-diagnostic-chunk-v1\0<asset path>`. Only the resulting `sha256-<digest>.js`
  identity and bounded coordinates reach the log. An operator can compute that identity for the
  exact shipped assets; a forged basename never survives verbatim.
  Function names, origins, query strings, source paths and raw messages/stacks remain excluded.
  Development frames without a production chunk anchor are omitted, never invented.
  A valid original request correlation takes precedence. Reports without one, including reports
  whose supplied id fails validation, use the validated ingest request correlation; internal
  callers without either use `UNKNOWN_CORRELATION_ID`. Rate-limit notices use the ingest request
  correlation. This keeps message-only browser notices reconstructable without inventing an
  original request or admitting a malformed client id.
  The route's body reader returns a module-tagged outcome, not a duck-typed `RouteResult`, so a
  client body shaped like `{status, body}` can never be reflected as the route's own response. On the
  browser side the existing `reportClientDiagnostic` sink fans out to the console and to this route
  (best-effort, throttled, never awaited); the four native `EventSource.onerror` sites report
  `readyState` and a closed reason label, and every call site that catches an `ApiError` passes its
  `correlationId` through a structured `meta` argument — the join that lets an agent pair a
  browser-visible failure with the exact server request line it came from. Producers that
  structurally have no id (native `EventSource`, message-only notices) say so in their doc comments
  rather than inventing one.

Desktop chat transport failures retain the original failure once under the request or echoed
response correlation. Before validated SSE headers and a response body, their client diagnostic
kind is `other`; after stream establishment it is `sse-error`. Idle stalls classify as `timeout`.
Expected turn/scope admission refusals and deliberate cancellation do not create an additional
client failure incident; their owning lifecycle evidence remains.

- **Routine browser evidence is not a failure, and every browser report is a closed shape**
  (#3557). A live dev log showed 416 of 449 `client.diagnostic` lines were a window's routine
  stage evidence, all at `warn` with `errorKind: unknown`, burying the real failures. The route
  now accepts four closed shapes, each with its own operations:
  - a message: `client.diagnostic`, at `error` for operation timeouts so the existing automatic
    incident trigger retains their window; other client warnings remain at `warn`;
  - a window or folder-navigation stage: `client.stage.started` / `client.stage.settled` at `info`.
    Folder stages use `files-directory-load`, `files-directory-navigation`,
    `files-project-selection`, and `editor-project-selection`. Directory loads send their
    stage correlation id with the HTTP request; failed reads emit a correlated body-free
    diagnostic and settle. Paths and document bodies are never recorded. One
    client-minted correlation id per mount joins both phases, and the duration is monotonic and
    bounded to the contract's ceiling. A window chunk that has not arrived 10 seconds after its
    stage started is reported as stalled, a `client.diagnostic` at `error` with `errorKind: timeout` under
    that stage's id, and the window offers the reload that requests it fresh: a chunk request the
    browser loses never settles, and the bundler keeps it pending, so nothing inside the page can
    request it again (dev CI run 35438847738, a WebKit network process crash);
  - a restored window's binding: `client.binding.resolved` at `info`,
    `client.binding.candidates-offered`, `client.binding.choice-kept` and
    `client.binding.choice-withdrawn` at `info`, or `client.binding.target-missing` at `warn`
    with `errorKind: unavailable`. It carries the
    persisted reference's closed shape (`uuid`, `opaque`, `redacted`, `fingerprint`,
    `user-selected`) and whether the card-number heuristic flags the reference's hyphenated form (`heuristicFlagged`), never the
    reference itself. No reference is exempt from that heuristic, and no stored form works around
    it. The server issues every reference a window persists (chat, PR description proposal,
    Figma snapshot, QI run and agent run ids) through `newReferenceId`, which never draws an id
    the heuristic flags. Every issued id is `reference-id.issued` with the number of draws the
    heuristic flagged first, zero included, so a clean first draw is told apart from a path that
    never ran the check; an exhausted draw is `reference-id.exhausted`. Both sit under the
    requesting operation's correlation id. An older chat can still carry a flagged id: its window
    records a one-way SHA-256 fingerprint of the id, computed synchronously in the commit that
    shows the id, so persistence never stores the redaction marker without it. On restore the
    window finds its chat again by comparing that fingerprint with the chats the server lists
    (reference shape `fingerprint`). A snapshot an older build wrote holds the redaction marker
    without a fingerprint, which identifies nothing: no listed chat can be proven to be the one it
    named, so that window is never rebound on its own. It reports its chat missing and offers the
    chats it may have shown: the listed chats whose ids persistence redacts, the most recently
    active first, each named by its title and when it was last active, to the second. Two offers
    that would still read alike (one title, one second) also show the shortest start of their
    chat's fingerprint, six hex digits or more, that tells them apart, so no two offers ever read
    alike. The offer is `client.binding.candidates-offered` with `candidateCount` and
    `disambiguatedCount` (how many offers show such a reference), zero included, under the list
    loads that decided it. Only the person's choice binds the window, recorded as reference shape
    `user-selected` under the list load that offered the chat. Nothing proves that choice right,
    so it stays a choice, across reloads (the closed `chatIdChosen` marker), until the person
    keeps it: the window shows the conversation, so the person can check it, and offers to keep
    it (`client.binding.choice-kept`) or to withdraw it and choose again
    (`client.binding.choice-withdrawn`, which returns the window to the chats it may have shown).
    Keeping needs the chosen chat on screen: while it opens, while its lookup failed, and once it
    is missing, while the window shows it or after a reload, the choice can only be withdrawn,
    and the withdrawal names the chat by the fingerprint the window persisted, under the list
    loads that found it gone. A fingerprint that no listed chat has any more is reported missing
    as that fingerprint (`referenceShape: fingerprint`, `targetFingerprint`) under the lookup's
    own loads, never like a marker that named nothing. The browser and
    the server budget binding reports by one rule (`CLIENT_BINDING_FAILURE_OUTCOMES`): only a
    missing target spends the failure budget.
    A binding found again after redaction (`fingerprint`, `user-selected`) and each decision
    name the chat by its fingerprint (`targetFingerprint`, the form the window persists), never
    by its id, so two choices from one list answer stay apart. While the project catalog loads, the
    window waits; when the catalog failed, or it lacks the window's project, the window shows that
    the way it does for any chat, and the lookup runs as soon as the catalog changes. A list that
    cannot be read decides nothing: the fingerprint lookup, the candidate scan, and the legacy scan
    of a window without a project run again after a bounded backoff. A list that failed is reported
    under the id its load was sent with and its closed `errorKind`, even when the transport
    failed before any response. A binding found again this way names the chat list load of its
    own lookup, never a later load of the active project. The window's own persisted id, which
    persistence holds to a closed safe shape, reaches the server whole and is logged only as its
    digest (`bindingDigest`), so two windows never share one. Its correlation id is that of the
    chat list load that decided the outcome; a missing legacy binding names every list its scan
    read, with the ids those loads carried, in `relatedCorrelationIds`. When more loads decided
    the outcome than the line names, `decidingLoadCount` states the total and the line is
    `partial` with `loss: event-location-unknown`;
  - a stale-session repair: `client.session-repair.recovered` at `info` (outcome `replayed`
    or `stream-repaired`), or `client.session-repair.failed` at `warn` with outcome
    `replay-failed`, `replay-skipped` or `repair-failed`. A repaired read sits on the denied
    request's timeline, because the replay reuses that request's correlation id. A stream
    (`EventSource`) exposes no request id, so its repair sits on the stream's failure streak: a
    client-minted id that the streak's `sse-error` diagnostics carry too, with the closed
    `stream` name. The local-session endpoint acknowledges whether or not it issued a cookie, so
    an acknowledged repair is its own state, `client.session-repair.acknowledged`, and a stream
    reports `stream-repaired` only when it opens again after it. A streak that keeps failing after
    the acknowledgement shows a repair that did not restore the stream. A suspension (a hidden
    page, reserved capacity) ends the streak, so a resumed stream repairs again.
    Every repair report names the repair request's id, and a failed repair its closed failure
    class: the ingest contract refuses a report without that id, or with one outside the server's
    correlation rule, as malformed, so no line claims a complete repair it cannot link. The
    repair request itself (the local-session ensure) mints its id before it is sent, so
    a failure that never reached the server is still recorded under that id with its closed
    class, which a message report may now carry as `errorKind`.
  Routine evidence (a stage, a resolved binding, a recovered repair) spends its own rate-limit
  budget in the browser (60 per minute, failures 20) and on the server (a separate 60-per-minute
  sliding window), so it can never starve a failure report. Every drop is still counted as loss.

The agent-reading step this adds: **for a failed request**, read `routeTemplate`,
`queryParamNames`, `responseBytes`, `aborted` and — for a stream — the `sse.stream.closed` line's
`reason`, then look for a `client.diagnostic` line sharing the `correlationId` to learn what the
browser saw. Everything on these lines is a count, a closed label, a template, or an id.
**For a restored window that shows "not found"**, read its `client.binding.target-missing` line.
`referenceShape: redacted` means the reference was lost at persistence. `uuid` means the target
is really gone. The line's correlation id, and `relatedCorrelationIds`, name the list loads the
verdict came from; a `partial` line says how many it could not name. A window restored from a
snapshot without a fingerprint also logs `client.binding.candidates-offered`: `candidateCount`
says how many chats it offered and `disambiguatedCount` how many of those showed a fingerprint
reference. A later `client.binding.resolved` with `referenceShape: user-selected` names the chat
the person chose by its `targetFingerprint`, and `client.binding.choice-kept` or
`client.binding.choice-withdrawn` says whether they kept it. **For a conversation
refused as not ready**, read `readinessObservation` on the rejection. `unobserved` means no check
ran in that process. `not-ready` means a check ran and failed. Then read that check's lines: the
on-demand probe a conversation entry point runs logs `gateway.readiness.automatic.started` /
`.completed` (a request that joined a probe already running logs
`gateway.readiness.automatic.joined`, with the probe's correlation id as its parent), and a check
run from the settings dialog logs `gateway.readiness.started` / `.completed` with
`trigger: settings`. A refused or checked model appears
on these lines only as the 16-hex `modelIdDigest` of the whole id, never as the id itself: a model
id is caller content or operator-chosen text that no check proves body-free. Two refused
candidates stay apart, a retried one reads as the same, and a reader who holds the configuration
recomputes the digest to name the model.

The Coding Workbench model selector stays a passive catalog reader (ADR-0124 D5). Its gateway
profile read, `GET /api/coding-sidecar/gateway/profile`, is not passive any more (owner decision
for 1.1.1, reversing #3561): what Keiko can determine itself it determines itself, so a customer
is never sent to Gateway Settings to click a check or copy a value. On that read the server
verifies, for every chat model that claims tool calling, what the Workbench needs and the stored
configuration does not prove: an expired or missing forced tool-call proof (`tool_calling`), and a
context window below the 32,000-token minimum (`long_context`), which is what a gateway that
declares no token limits leaves behind as the 4,096 setup placeholder. Expect
`gateway.readiness.automatic.started` / `.completed` under the profile read's correlation id;
`.completed` carries `verifiedContextTokens` when the long-context probe passed, and the same run
persists the renewed proof and raises the stored window (raise-only). A model whose proof the
config loader demoted to `toolCalling: false` after it aged out still claims tool calling (ADR-0124
D5): after a restart the day after setup its read starts that automatic run, and a read that
answers while the run is still open logs `coding-sidecar.gateway.readiness-insufficient` with
`reason: "model-verification-pending"`. For such a model, `reason: "no-tool-calling"` follows only
a run whose probe refuted tool calling. The work is bounded: one
attempt per deployment identity within a six-hour cooldown, never for a model that does not
claim tool calling, never while a subscription source is selected, and only the model the
Workbench would elect is awaited. A profile read that
finds nothing to prove writes no automatic record, and its absence is then not a lost call.

For received reports, first analyze the artifact without a correlation selector. New exports
replace local labels with artifact-local ordinal references. Select the exported root from
`incident.correlation.rootCorrelationId` or a validated timeline reference when using
`support analyze FILE --correlation-id <exported-ref>`. The UI Support ID and original run/request
IDs below select only the originating installation's Activity Log; no reverse mapping is exported.

The Coding Workbench gateway connects each authenticated request to its run with
`parentCorrelationId: runId`. An upstream chat or stream failure keeps the request correlation on
its redacted diagnostic and names the run as parent, so concurrent failed requests remain
distinguishable. `keiko support query --correlation-id <requestId> --json` retrieves the diagnostic;
`keiko support query --correlation-id <runId> --json` retrieves the run's closed turn-failure projection
and its linked request timeline. The analyzer follows an explicit `parentCorrelationId` edge for
one hop and includes every line with that child request correlation, including provider dispatch
and diagnostics that do not repeat the parent field. Direct request lookup remains available;
the analyzer does not infer relationships from message or error text. Request validation and
rejection retain the same request-to-run edge for causal queries.
The shared `unknown-correlation-id` fallback is not a unique child request identity: a run query
includes only fallback records that individually name that run as parent, so unrelated failures
cannot contaminate its timeline. Direct fallback-id lookup still shows all such records.
Before ranking process lifetimes, the expanded run timeline restores original file order across
run and request records; otherwise a parent-first join can reverse the first-seen lifetime order.
`chat.request.dispatch` records the
stream usage flag and tool count before the provider call; a strict OpenAI-compatible proxy's
one-time retry without `stream_options`, and the one bounded `stream: false` retry after a second
rejection naming that field, each record `chat.request.compatibility-retry` with the closed
`omittedField` (`stream_options` or `stream`). These lines
contain counts, status, closed reasons, and digests only. A readiness probe records its own
compatibility retry as `gateway.readiness.compatibility-retry` (`.failed`, `.skipped`); a rejection
whose body cannot be read is handed back as a bare status and never reaches the probe's own failure
path, so its `.skipped` line carries the read error's Keiko-code `frames` and `causeChain`. The Workbench receives a separate
`failure-redacted` SSE event with a closed gateway-turn cause while the runtime is still active;
the event carries no provider response body or customer content. Each gateway turn failure,
including another failed model request at the same task revision, writes
`coding-sidecar.gateway.turn-failed` with the closed failure code, request correlation, run parent,
revision, state, a closed publication reason (published, unavailable hub, terminal run, invalid
event, exhausted sequence, or capacity pressure), and `runtimeRetry`: `refused` when the provider
rejected the turn in a way no retry can change (a 4xx other than 408/409/429, a refused credential,
an invalid configuration — the gateway's own retry policy calls it terminal), `allowed` otherwise.
A refused turn is answered to the runtime as a final 400 — an HTTP 400 before the stream opened, an
error chunk with `code: 400` and `type: invalid_request_error` after it — which OpenCode 2.0.10
reads as final; `finish_reason: "error"` or a 503, which it retries, stays the answer to everything
else (lab 2026-09-26: a provider 400 was retried without end). When the turn failed on an error, the line also
carries that error's Keiko-code `frames` and `causeChain`: a model-answer failure (`empty-answer`,
`output-exhausted`, `invalid-tool-call`) writes no error-level diagnostic while the line is written,
so this line is where its frames live. A revision is a task-state version, not a turn identifier, so
it must not suppress later turn failures.
A sidecar process that exits while its run is active publishes one `failure-redacted` event
(`runtime-failed`) and writes the `coding-runtime.exit` diagnostic with the numeric exit code and
the Keiko-code frames of the site that observed the exit (#3593). An approval published while no
Workbench window is subscribed stays retained in the run's event hub and reaches the next
subscriber once.
On completed buffered and streamed requests, `coding-sidecar.gateway.usage-settled` records the count and
closed source (`provider-reported`, `streamed-byte-estimate`, or `output-byte-estimate`) beneath
the request correlation and run parent. A positive provider count takes precedence over a byte
estimate; a response without usage derives a count from streamed content or terminal tool output.
Mixed text and tool output uses the complete output-byte estimate.
The same usage line records the prompt-token count used for authority accounting and its closed
source (`provider-reported` or `reserved-estimate`); absent or zero provider prompt usage
retains the pre-call reservation. Its closed settlement status distinguishes a successful authority
reconciliation from a reservation retained after an authority refusal, an unverified result, or a
deployment without a settlement port. A refused or unverified settlement reports the retained
reservation rather than the provider count requested by the caller.
`coding-sidecar.gateway.outcome`
records the closed accepted, cancelled, failed, or output-limit result under that same request and
run correlation; streamed acceptance is recorded after the terminal frame is written. These records
contain request and run correlations, counts, closed states, and the source, without message bodies.
Generic provider policy refusals remain terminal; an error
that identifies the optional `stream_options` or `include_usage` field may take the bounded
compatibility retries that ADR-0003 describes.

### D14 — Bounded immutable segments under the OS-user filesystem boundary

The Activity Log is one logical log stored as immutable segments in one closed-grammar directory,
`<stateDir>/logs/`. Segments replaced the single shared `server.log`, its UTC-daily archives and
count-only retention in #3530. A byte bound and an age bound hold at every revision; a successor
storage design must replace them in the same revision rather than remove them first.

**Layout.** The grammar lives in `keiko-contracts` (`activity-log-files.ts`). The writer and every
reader import it; nothing restates it.

| Name                                                     | Meaning                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `activity-<start>-<pid>-<instance>-<index>.active.jsonl` | The active segment of one process instance. Only that process appends. |
| `activity-<start>-<pid>-<instance>-<index>.jsonl`        | A sealed segment: read-only (`0400`), never rewritten.                 |
| `server-YYYY-MM-DD.log`, `server.log`                    | Legacy files of the retired daily rotation. Read-only.                 |
| `pin-<24 hex>.json`                                      | A retention-pin record.                                                |
| `store-policy.json`                                      | The store's one governing policy record (#3554); never log content.   |

`<start>` is the segment's UTC start time (`YYYYMMDDTHHMMSSmmmZ`), `<pid>` and `<instance>` are the
envelope's process identity, and `<index>` counts that instance's segments from `000001`. Sealing
drops only `.active`, so a segment keeps one id for its whole life. The logical order is the legacy
archives by day, then the legacy current file, then segments by start time and owning process.
Within one process instance the order is exact; across processes the start time is a best-effort
hint, exactly like `ts` (D2).

**Writing and sealing.** Each process creates its own active segment with an exclusive create and
never opens another instance's active segment for writing, so no two processes append to one file.
A segment is sealed:

- when the next line would exceed `KEIKO_LOG_SEGMENT_BYTES`;
- when it is older than `KEIKO_LOG_SEGMENT_SECONDS`, measured by the wall clock or the monotonic
  clock, whichever is further (a backwards wall-clock step beyond five seconds seals it with
  `clock-change`);
- at shutdown;
- on a pin request.

Sealing writes a final `activity-log.segment.sealed` line and fsyncs. The line carries the seal reason, the seq range (which ends with the seal line's own seq), the line count and byte size of the lines before it, the duration, the dropped-event count and the configured limits. Sealing then publishes the sealed name with the guarded primitive described under
**Trust boundary** and makes the file read-only. A seal that fails leaves the file under its active
name; the writer never appends to it again, and the next maintenance pass recovers it. Lines over
8 KiB are still replaced by `server-log.line-dropped`.

A write that finds its segment full or expired rotates make-before-break (#3557): the next segment's
file is created under its active name before the full one is sealed, and the admission re-check
then runs with that new, still empty segment at its full reservation, so the byte bound is
unchanged. A peer that lists the directory in that moment counts the writer once: an empty active
segment whose instance still holds an older active segment counts only its actual size, because
its writer re-checks admission before it writes a byte into it. At the minimum budget two writers
therefore still fit, and no peer drops an event while another rotates. The writer's own re-check
never discounts its own segments: when its full segment could be neither sealed nor recovered, it
keeps its active name, and the next segment is admitted only if both fit. A process that keeps writing is therefore never without an active segment, which is the
one sign of a live writer a starting peer can see before it decides whether it may replace the
store policy. Sealing first and opening the next segment only after a maintenance pass had left a
busy writer invisible for that whole pass, and a peer starting then replaced a running writer's
policy. Only the idle-segment timer, shutdown and a pin request seal without opening the next
segment.

**Recovery.** At startup and before every new segment, the writer seals orphaned active segments. A
segment is orphaned when:

- its owner has exited, or its pid now belongs to this process;
- it is older than two segment windows and unwritten for one (pid reuse);
- it is this instance's own abandoned segment.

Recovery seals the file as it is: a partial final line is kept and reported (`tailState:
"truncated"`, `truncatedBytes`), and valid lines are never rewritten. An interrupted seal whose seal
line is already present is only completed. Every recovery is `activity-log.segment.recovered`
evidence with lifecycle `loss`.

**Retention and the bound.** Retention runs at startup and before every new segment, never
deferred. It counts every file in the grammar: legacy files, sealed segments, pin records, and every
active segment at its reservation, the larger of its size and the segment size. Oldest first, it
deletes the unprotected sealed and legacy files that are past `KEIKO_LOG_RETENTION_DAYS`. It then
deletes as many more as the `KEIKO_LOG_RETENTION_BYTES` budget requires, including the reservation of
the segment about to open.

- **Deletion.** Every deletion is the guarded, identity-bound unlink of `removeSafeArtifactFile`. A
  failed deletion is counted and retried after a 60-second backoff; the next candidate is tried
  meanwhile.
- **Admission.** A new segment is admitted only when the unprotected total, including its
  reservation, fits the budget. Admission is checked again after the exclusive create. Concurrent
  processes can therefore observe the same free reservation only while their new segments are still
  empty, and the loser withdraws its segment.
- **Budget exceeded.** When the budget cannot be met, the event is dropped and counted, and
  `activity-log.pressure` reports `budget-exceeded`.
- **Evidence.** Each pass that deletes or fails to delete is `activity-log.retention.pruned`
  evidence. `prunedUnprotectedPinnedSegmentCount` and `prunedUnprotectedPinnedBytes` count only
  successfully removed segments requested by a still-active pin but outside its protection quota.
  Failed removals, protected segments and ordinary unpinned retention do not enter these counts;
  overlapping pins count each removed segment once. Actual pinned-evidence removal declares
  `completeness: "partial"` and `loss: "event-dropped"`. The operation remains a shared-store state
  observation: it can remove a peer's segments and must not mark the maintenance writer's own
  retained records as dropped. Queries for missing selected evidence remain insufficient with
  `evidence-not-retained`; unrelated complete request traces retain their own sufficiency. These
  count fields are optional on historical records and always emitted by the current writer.

Total disk use is therefore at most the byte budget plus the pin quota.

**One governing policy across processes (#3554).** The five variables above are read from each
process's own env, so several cooperating processes — a long-running server plus a one-off CLI
invocation, or two server instances across a restart — could previously enforce retention under
different views of the budget: a smaller one could prune segments a larger one relied on to keep,
and a larger one was never capped by a stricter peer's limit. `store-policy.json` (deliberately
outside the grammar above and never read as log content) now holds the retention bytes/days and pin
quota every cooperating process enforces. The first process that finds no valid record publishes its
own, race-safe through the same exclusive-create primitive pin records use. Every later process
applies the STORED values, whatever its own env says, and — when they differ — records one
`activity-log.policy.conflict` line per process lifetime: the differing setting names, and the
stored and requested values, as closed and bounded fields. A process may replace a stale or corrupt
record only while it is the store's sole live writer (every other active segment belongs to a
confirmed-exited instance), which is what lets a changed `KEIKO_LOG_RETENTION_BYTES` take effect on
the next clean restart without letting a stray concurrent process silently override a running
server's governance. Every maintenance pass re-reads the record before it deletes anything, so a
process that held no active segment while the record was replaced (an idle server) adopts the new
values on its next pass instead of pruning under its first read. Segment size/age stay per-writer settings, clamped against the governing
retention bytes with the same invariant as before. Total disk use is therefore at most the ONE
governing byte budget plus the pin quota, even when cooperating processes' own env values disagree.

**Pins.** `pinActivityLogWindow` protects one of two scopes until an expiry of at most 3650 days:

- a time window of up to seven days, across every process instance, including segments sealed later
  inside it;
- up to 64 named segments.

The ceiling check, rollover and pin admission all use `activeActivityLogPins`: only valid, unexpired pins count, so expired records awaiting cleanup never displace live evidence. At most 64 pins are active. The pin record is published before the current segment is sealed, so
the next retention pass honors it. Pinned sealed segments count against `KEIKO_LOG_PIN_QUOTA_BYTES`,
oldest pin first, and only while the quota lasts. A pin the quota cannot hold is still recorded with
`quotaStatus: "exceeded"`. Its unprotected remainder produces one `activity-log.pin.quota-exhausted`
protection-failure record with segment counts, bytes and the seq span. It declares partial protection
and `loss: "none"`: the marker is emitted before retention may delete the unprotected segments, so
it cannot claim an event was dropped. This is a non-causal observation of the shared pin pool:
maintenance may carry an unrelated or unknown correlation without claiming a missing pin start.
Individual pin creation and expiry retain their causal lifecycle. The pin class remains degraded by `evidence-partial`;
unrelated retained process evidence is not classified as lost. Historical registered quota records
that declared `event-dropped` retain their exact bytes and are interpreted as this same protection
failure. Derived manifests are rebuilt under version 3 so their process-loss count reflects this
distinction. Confirmed write/drop counters, corrupt beginnings and missing retained segments still
fail the existing evidence checks. Expired and invalid pin records are removed with `activity-log.pin.expired`. `releaseActivityLogPin` removes a pin before its expiry, for example once its incident was reported or dismissed; the same line records it with `expiryReason: "released"`. Neither pin function ever throws: an unlistable directory or a failed removal is a closed, evidenced rejection, because both are reachable from a sink's own write path. #3530 provides the primitive; #3533 decides when and what to pin.
The legacy update-audit import pins its durable batch (`reason: "durable-batch"`).

**Pressure and health.** `activity-log.pressure` records transitions between these closed states:

- `low-disk-space`: free space is below the larger of four segments and 64 MiB;
- `disk-full`: a write failed with `ENOSPC`, `EDQUOT` or `EFBIG`;
- `backpressure`;
- `budget-exceeded`;
- `retention-blocked`;
- `cleared`.

The line carries the dropped-event count and the used, budget, pin-quota and free bytes. Writing
never stalls silently. `activityLogStorageHealth(stateDir)` returns a read-only snapshot: one
listing, the pin records and one `statfs`. Diagnostic readiness (#3532) consumes it.

**Configuration.** Five environment variables bound the store. Each value must be a positive decimal
integer inside its bounds. Any other value falls back to the default, so a typo never disables the
bound.

| Variable                    | Default | Bounds                                                     |
| --------------------------- | ------- | ---------------------------------------------------------- |
| `KEIKO_LOG_SEGMENT_BYTES`   | 8 MiB   | At least 32 KiB; at most a quarter of the retention budget |
| `KEIKO_LOG_SEGMENT_SECONDS` | 3600    | 1 to 604800                                                |
| `KEIKO_LOG_RETENTION_BYTES` | 256 MiB | At least 64 KiB                                            |
| `KEIKO_LOG_RETENTION_DAYS`  | 14      | 1 to 3650                                                  |
| `KEIKO_LOG_PIN_QUOTA_BYTES` | 64 MiB  | At least 1 byte                                            |

Segments stay uncompressed. A sealed segment is directly readable by the local reader/query engine and by
line tools, and the byte budget already bounds disk use.

**Calibration (#3532).** The defaults were checked against the traces of the 29 failure scenarios,
each run through the real file writer in one process. Together they wrote 128 lines and 95,305 bytes:
2 to 20 lines and 1,400 to 15,076 bytes per scenario (median 2,534 bytes), 745 bytes per line on
average. The largest trace, the memory-knowledge loss scenario, is 20 lines and 15,076 bytes. At that
line size an 8 MiB segment holds about 11,000 lines, and the 256 MiB budget about 360,000. The
64 MiB pin quota holds about 4,400 incident traces of the largest measured size. No default had to
grow. The report-size cap belongs to #3534, which is not part of this change; for reference, a 1 MiB
cap would leave more than 60 times the largest trace.

**Legacy input.** Existing `server.log` and `server-YYYY-MM-DD.log` files are read-only legacy
segments. They count toward the budget, age out under the same retention, and are never rewritten or
appended to. `server-log.rotation` and `server-log.capacity-warning` are retired; lines that carry
them stay readable as legacy evidence.

**Trust boundary.** The trust boundary is the operating-system user. The log directory is accepted
only while it remains owner-matched, non-redirected, and owner-only (`0700` on POSIX; the selected
owner's inherited ACL on Windows). Maintenance refuses to list, recover, or prune through a
redirected directory. Directory device/inode identity is captured and rechecked before and after
every link, rename, and unlink. Every target is opened without following its final symlink. It must
be a regular, owner-matched, private, single-link file whose descriptor and pathname identities agree
immediately before the mutation.

Publication of a sealed name uses `link(2)` as a non-replacing primitive and then removes the active
name, leaving the sealed segment as a single-link file. `EEXIST` means the sealed name already
exists; Keiko verifies and preserves it rather than overwriting it. Rename is reachable only for
filesystem error codes that explicitly classify hard links as unsupported. Ordinary permission, I/O,
link-count, unsafe-target, and identity failures do not enter that fallback. Mutation failures are
body-free evidence and never escape into the product operation that triggered the write.

**Residual same-user race.** Node exposes no portable descriptor-relative link/rename/unlink API,
and a filesystem without hard links offers no portable no-replace rename. The rename fallback
therefore first claims the destination name with an exclusive no-follow create. A concurrent
publication that loses the claim preserves the winner's file, and the winner's rename can replace
only its own empty claim.

Every link, rename, and unlink carries the device/inode of a source descriptor that its caller holds
open until the helper returns. The mutation helper acts on the name only while it still has that
identity. The held descriptor keeps the inode allocated: Linux file systems hand a freed inode number
to the next file at once, so an identity without a holder could match the replacement. A process
that completes a peer's interrupted seal can therefore never delete a file that replaced the
verified one, and no link or rename publishes such a file.

A process already executing as the same OS user can still act in the narrow interval between
pathname checks. Owner-private directories, held descriptors, pre/post identity checks, the
non-replacing link, closed names, and target-handle verification narrow and detect that interval.
They do not claim to eliminate it. This residual is part of the stated OS-user threat model and is
never a reason to disable or defer bounded retention.

### D15 — Local support incidents are a body-free descriptor over pinned evidence

An incident is a control artifact over the Activity Log, not a second log (#3533). A local candidate
is created automatically for a registered failure operation logged at `error` with at least one
supported failure class, or explicitly by the user (`keiko support incident report`); a closed
`trigger` records which. Eligibility derives from the registry, never from a UI-side list. A process
evaluates at most one failure per defectFingerprint every SUPPORT_INCIDENT_SUPPRESSION_MS and, across
every fingerprint together, at most MAX_SUPPORT_INCIDENT_EVALUATIONS_PER_MINUTE per rolling minute.
The first bound loses no evidence (the fingerprint's own candidate already pins its window), but the
second can drop a defect Keiko has never seen before, purely because the shared cap was already
spent; that case is evidenced as `support.incident.rejected` (`evaluation-rate-limited`), throttled
to at most one line per suppression window so a storm reports the loss once rather than flooding the
log with one line per dropped evaluation (#3533 audit). That rejection's stored-record count uses a
single directory-entry scan over regular closed-name records, including unreadable records; it does
not open or parse their contents, follow symlinks, or run expiry cleanup. This is an observed count,
not admission authority: exclusive slot claims still govern concurrent admission. Expiry cleanup
continues to validate canonical record deadlines. A fresh post-publication snapshot supplies both
the observed created count and immediate slot-retention selection, without another full parse.
The pin-ceiling path inspects a fresh snapshot only when that ceiling is reached.

On the registered-failure trigger, the window's Activity Log retention pin (15 minutes before, 5
minutes after, through D14's pin primitive, across every process instance) is requested
synchronously, in the same turn as the triggering write. When capacity permits, it protects the
window before a later maintenance pass or segment admission can remove evidence. This immediate
request never retires another candidate to recover pin capacity: deduplication and candidate
admission must succeed first. A newly admitted candidate whose immediate pin was rejected retries
the existing pin manager without first deleting another candidate; a duplicate preserves the original candidate
and its pin. Deduplication, quota admission, and the record write run outside the logging call and
never transfer data. A duplicate or rejected candidate releases any pin its trigger already
published instead of leaving it until its TTL. A queued candidate retains the original trigger-time
sealed-segment snapshot when immediate protection is rejected; admission retries compare against
that same snapshot, so evidence removed while the candidate was waiting remains observable.
The residual race a synchronous publish cannot fully close on its own — a concurrent process's
retention removing a sealed segment in the narrow gap between observing the window and the pin
actually covering it — is detected by comparing that snapshot to the pin's own outcome and reported
as the pin's `evidenceLostBeforePin`, so the window is never reported as a clean "pinned" when part
of it was already lost. No causal-closure computation happens at pin time; a later selective export
chooses the closure from the pinned window.

Two identifiers serve two purposes. `incidentId` is random and names one occurrence.
`defectFingerprint` is deterministic and versioned over allowlisted stable inputs (owning surface,
operation, closed `errorKind`, normalized Keiko frame signature) and carries no time, process,
instance, host, user or path value; it groups recurrences for deduplication and fix linkage. A change
to its inputs or algorithm bumps the algorithm version; a golden-value test enforces that. Version 1
preimages remain unchanged and historical records remain readable. Client diagnostics use version 2:
closed diagnostic/render/module context and reduced shipped browser-chunk digests distinguish known
failure shapes without retaining messages, paths or customer identifiers. Line and column do not
enter either version. Shipped chunk digests may change across releases, so version-two browser
fingerprints do not promise cross-release grouping.

Browser diagnostics can still be indistinguishable when they carry no usable product frame or
closed feature context. Their retention claim is therefore scoped to the occurrence's validated
causal reference as well as its defect fingerprint. Replaying the same request deduplicates; a later
request retains its own window instead of discarding it under a coarse defect claim.
The local claim key is a hash and is never exported as a customer reference. Existing automatic
byte reservations and evaluation rate limits apply. Browser candidates may use one quarter of the
reservation pool; all automatic candidates may use three quarters, preserving manual-report
headroom. Browser evaluation remains at most two of the six evaluations per rolling minute,
reserving the remaining evaluations for server failures. Existing atomic claims and closed
rejection evidence apply to both classes. Server failures and historical version-one browser
records keep their fingerprint-scoped deduplication.

The descriptor has a strict public projection and a richer, still body-free private projection from
the same record; both expose the sufficiency status, and only the private one carries reasons and
coverage. The store is owner-private and uses the existing governing Activity Log retention-byte
policy to size its reservation pool. Each slot reserves one maximal 4 KiB candidate plus the two
opaque owning-id claim payloads; there is no independent candidate-count setting. Exactly one slot
inside this existing byte pool is held as an atomic publication reserve. The retained capacity is
the pool less that technical slot, not an additional user quota. A replacement exclusively claims
a free slot, writes and fsyncs its new immutable record, and only then retires an eligible older
candidate and releases its owned claims and pin. A failed publication releases only its own new
claims and pin and preserves prior candidates. Concurrent publishers cannot steal a held reserve;
a fully occupied pool can restore its publication reserve by retiring one eligible older candidate
only when every occupied pool slot has a matching durable record and owning claim, and the eligible
class stock exceeds its governing share. Protected classes occupying overlapping indexes do not
count as that surplus. Admission then retries exclusive claiming once. Recovery reuses that admission's slot-occupancy
snapshot, checks missing durable owners before opening claim contents, and reads only the occupied
slot owners; it does not rescan fingerprint claims. A confirmed peer unlink between inspection and
open declines recovery without inventing a store outage. Retention evidence counts the full open
store even when only one priority class is eligible for eviction. Each retention expiry records the
closed `retentionCause` (`slot-pressure` or `pin-ceiling`), the actual `evictingCorrelationId` and the
replacement's assigned `evictingIncidentId`. These are references to the displacing action, not a new
parent edge: the victim's original lifecycle correlation and ancestry remain intact, including when
the replacement is already its descendant. The canonical report aliases these opaque references
through the same privacy projection as other identifiers. If full-pool reserve recovery actually
removes a victim and the subsequent claim or publication fails, the existing rejection also records
that exact `evictedIncidentId` and subtracts the removed victim from its retained-count snapshot.
A refused removal emits no such rejection field; expiry by time carries no eviction fields.
Any unpublished, torn or mismatched peer claim keeps the existing
`quota-exhausted` refusal; failed or changed-file cleanup retains truthful partial evidence. This
exception repairs interrupted post-publication retirement and legacy full pools without stealing
in-flight ownership or enlarging the byte pool. Unreported
candidates expire after twenty-four hours, including older records written with a longer expiry.
One pure contract computes the effective deadline from the original expiry and the current lifetime;
admission, reads, retirement, projections, recent selection and CLI output use that same deadline.
Historical records are not rewritten. When the sweep has reached the effective deadline but is
still before the original deadline, the existing
`support.incident.expired` event records the closed reason `ttl-shortened`, releases the owned pin
and claims, and retains truthful partial evidence if any cleanup fails. Sweeps at or after the original deadline use ordinary expiry. Ordinary expiry and byte
pressure retain their distinct `expired` and `retention` reasons.
On byte pressure, the oldest eligible candidate rolls out and its pin and claims are released.
Generated reports remain only in the existing transient download cache, without a disk archive.
Health exposes the existing Activity Log readiness, closed reasons and lost-event count without
scanning the incident store. The unused candidate-count/capacity projection and its
`support.diagnostics.capacity` operation are retired: the metadata reservation and shared pin
pool are different constraints, so a combined headroom figure was misleading. Legacy optional
count fields remain accepted for wire compatibility but are no longer produced. Candidate
creation, rejection and retirement continue to carry their actual counts and lifecycle evidence.
An absent bootstrap policy permits the existing environment fallback; a present unreadable or
corrupt governing policy still refuses diagnostic admission and is evidenced by that owner.
An incomplete or invalid-JSON policy read is retried once immediately through the same guarded
reader, allowing a concurrent publisher that has since finished to be observed. This bounded retry
does not wait for a stalled publisher or eliminate the publication window. Persistent corruption
still fails closed; unsafe filesystem reads and valid JSON outside the policy schema are not retried.
The existing Activity Log pin ceiling remains unchanged. After durable publication, pressure at
that ceiling retires one older eligible diagnostic candidate with an exact owned `incident` window
pin, preserving one free pin slot inside the existing ceiling for the next publication. Its own
newly published candidate is never selected for this cleanup. Durable-batch and other unowned pins
are preserved. A legacy or foreign-filled pin pool can still refuse protection: the new record
truthfully retains its rejected pin outcome instead of claiming a recovered pin. A failed owned
pin release also remains evidenced and does not claim recovered capacity. The before/after segment
check still reports any evidence lost before the new pin; no cleanup invents recovered bytes.

Both the defectFingerprint dedup rule and the byte-reservation pool hold atomically across every process
sharing the state directory (#3533 review 4050606506), not from a directory-listing count two
processes could each read as "still free": a registered failure claims its deduplication key's own
`fingerprint-<64 hex>.claim` file by exclusive-create before it decides duplicate-or-new, and every
candidate claims one of a bounded pool of `slot-<nonnegative safe integer>.claim` files (automatics from slot 0 up, user
reports from the top down, so the reserve holds without a shared counter) before its record is
written. Both claim grammars are recognized by the same `parseSupportIncidentFileName` the
repair/uninstall ownership predicate already calls, so state-paths.ts needed no change to own them.
Legacy two-digit slot claims remain readable; no destructive migration is required. Reservation
indices are generated lazily against the actual occupied claims, without allocating an array sized
to the configured byte pool. A claim releases with its record on dismissal, expiry, rolling eviction
or successful preparation into the download cache. Between a claim and its record, and between
a record's exclusive create and its bytes, another process can see a claim without a record or an
unreadable record at any moment, so such a file is treated as in flight until it is older than a
one-minute grace by its own mtime: a repeat of the same retention key deduplicates onto the id
the claim names instead of taking the claim over, and neither the orphan sweep nor torn-record
recovery removes it. Only an older file has lost its writer (a crash in that gap) and is swept,
against a fresh, per-claim read before removal. A validated retained owner from the same sweep
can justify keeping its claim without another body read; if a peer removes that owner afterward,
cleanup waits for the next sweep. An owner absent from that snapshot must still be read freshly:
a peer may have published it in the meantime. Snapshot absence never authorizes deletion. An occurrence that finds an abandoned claim the sweep could not remove, or a claim still torn
on a second read, gives up as `store-unavailable` rather than publish a second candidate.
Acknowledge, dismiss and report remain explicit human actions; nothing is disclosed automatically.

### D16 — Queries select whole causal closures through derived segment manifests

`keiko support query`, selective `keiko support export` and incident resolution share one streaming
engine (#3531). It never loads a whole segment or the whole log. It streams candidate segments line
by line and retains only the selected events, up to a report budget.

**Manifests are derived metadata, not a second log.** Each sealed segment has one manifest in the
owner-private, closed-grammar store `<stateDir>/activity-log-manifests/`
(`manifest-<segmentId>.json`, at most 256 KiB). It carries the schema and catalog versions, the safe
time range, the process and sequence ranges, the registered categories, operations, error kinds and
failure classes with counts, the loss and integrity state, the count of lines in which its process
recorded losing its own evidence (a loss summary's process counters or a producer's confirmed drop,
such as the seal's), a Bloom filter over the correlation keys (hash bits only) and a SHA-256 digest.
An `incidentId` or `defectFingerprint` appears only when a registered operation that declares that
field carries it; a sealed segment is never touched to add one. Every value is a pure function of
the segment's bytes and the build's catalog, so deleting the store and rebuilding it reproduces
every manifest byte for byte. A stored manifest is accepted only when it re-serializes to its own
bytes and its digest matches; anything else is rebuilt. Only the query, export and rebuild commands
write manifests, never the Activity Log writer, and each pass removes the manifests of segments that
retention deleted, so the store follows the log's own bound.

**Residual same-user manifest forging.** The trust boundary is the same OS user as D14's segments.
A process already executing as that user could hand-edit a stored manifest — for example, to make
it falsely claim a segment holds none of a query's correlation keys — and pair the edit with a
digest recomputed over the forged content, so the manifest's own self-consistency check accepts it:
the digest binds a manifest to its own bytes, not to the segment it describes. A forged manifest can
therefore hide a segment from a routine query or export, which trusts a stored manifest without
re-deriving it from the segment every time. It cannot alter the segment itself: the segment's own
bytes, and the digest a fresh derivation would compute from them, stay exactly what the writer
sealed. `keiko support manifest verify` detects the forgery by deriving every manifest again,
directly from its segment, and reporting any stored manifest that differs from that derivation.
This residual is part of the same OS-user threat model D14 already states and is never a reason to
disable or defer manifests.

**A closure is selected whole.** A correlation, an incident or a defect fingerprint selects the
registered causal closure: the roots, every ancestor over `parentCorrelationId` and every
descendant, and never an unrelated correlation. A narrow context adds only the uncorrelated process
signals of the closure's own process lifetimes within a configured window (default 5 seconds), and
each lifetime's own `process.started` (its runtime) wherever it lies, outside the context cap, so a
long-running process keeps its Node version, platform and architecture (#3534). Only `keiko ui`
writes a start; a one-shot command writes none (its fatal and exit lines come without one). The
writer numbers a lifetime's segments from 1 and retention prunes the oldest first, so a lifetime
without a start is complete only while its segments still run unbroken from its first, every one
readable with only supported records (a torn tail may end only the last, where a crash stops it),
and its process recorded losing none of its own evidence (no process counter in its loss summary,
never the browser ones, and no seal's confirmed drop, which each manifest counts, so no body is read
for it): then it never wrote one, and the first line of its first segment travels with the selection
when no other line shows that beginning. Otherwise its start may have been pruned or damaged, before
or after its first heartbeat; the selection is `evidence-not-retained` and carries the lifetime's
first heartbeat, when one is retained, as the proof a receiver recomputes. Legacy files carry no
segment index and prove no beginning. The result accounts for each selected lifetime's start as
`selected`, `absent` or `lost`, and a report carries that account. A user-reported incident also
selects diagnostic correlations in its pinned window as roots. Independently correlated, registered
HTTP transport with no causal parent, an explicit successful numeric status (200–399), no warning, error, error kind
or aborted flag is optional context under the existing 256-event cap; unknown or failed transport
remains mandatory. Other independently correlated, registered non-diagnostic activity is also
optional only when it is informational or debug, explicitly complete and loss-free, has no failure
lifecycle, failure facts or uncertain status, and names no causal parent. Diagnostic, warning,
error, partial and loss evidence remains mandatory. Successful ancestors and descendants of a
selected diagnostic root remain part of its complete causal closure. The incident header evaluates the evidence actually exported,
including declared selection loss and budget reasons, rather than a separate unexported window.

**Nothing required is truncated.** A closure that does not fit the budget returns no events and is
`insufficient` with `report-budget-exceeded`. Its `requiredBytes` counts the closure with every
start, beginning line and heartbeat proof it requires, measured even when the closure alone exceeds
the budget, independently of record capacity. The lifetimes measured are bounded like the
closure's correlations; beyond that bound the requirement is unknown (0). Evidence retention removed
is `evidence-not-retained`; an unreadable candidate segment is `segment-unreadable`. Only optional
context may be dropped, declared as `context-truncated`. Every result carries its provenance,
integrity, coverage, loss and truncation, and exactly one sufficiency status from the per-class
projection `keiko support analyze` uses.

The query applies the canonical 20,000-record parsing ceiling while streaming, before report
encoding. Required causal and lifetime-anchor records take precedence; fitting optional context is
retained and the rest is counted as omitted. Both byte and record requirements are reported
separately. A required closure that cannot fit remains explicitly insufficient rather than being
presented as a complete partial chain. The existing `support.query.completed` event carries the
required record count alongside its byte count. Older reports without that count remain readable.

Optional context is ranked by its distance to the nearest selected closure event time, with log
order breaking ties. A bounded heap keeps nearby events within the remaining record and byte
budgets; an individually oversized optional event is omitted without blocking later fitting
context. This is a streaming selection, not a byte-packing optimization. The final evidence stays
in log order, required roots and edges retain priority, and every omitted context event still
contributes to `context-truncated` and its count.

**No database.** Manifests and streaming meet the measured need: a checked-in long-history test
bounds peak memory and proves that manifest-pruned segment bodies are never opened. A database
requires recorded measurements that manifests are insufficient and an explicit re-scope of epic
#3527.

### D12 — Relation to prior decisions

- **ADR-0010** (audit ledger and evidence manifests) established the precedent this contract
  extends: redacted-by-construction, deep field-wise, before serialization. The canonical support
  report follows the identical shape discipline through closed typed incident, selection, event,
  and integrity sections. It includes neither a legacy manifest nor an evidence-index dump.
- **ADR-0019** (modular package architecture) governs every new dependency edge this contract adds.
  Domain packages (memory, local-knowledge, security, memory-consolidation) each declare their own
  narrow, structural log-sink port — the same `KnowledgeLogEvent`-shaped pattern already proven —
  and depend on nothing new. Only the `keiko-server` composition root, which already depends inward
  on every domain package, wires a real `ServerLogSink` into each port. No domain package gains a
  dependency on `keiko-server`, and no new package is introduced merely to hold a shared log type
  that two packages could otherwise structurally agree on without importing each other.
  `keiko-contracts` (the leaf) gains only pure wire/data shapes used by more than one package
  (the client-diagnostics ingest request, a store-fingerprint data shape) — never logic.
- **Wave 4a** (epic #3233 §8) added two more ports of that same shape: `SecurityLogSink`
  (`keiko-security/src/log-port.ts`, categories `security`/`diagnostic`) and `MemoryVaultLogSink`
  (`keiko-memory-vault/src/vault-log.ts`, categories `memory`/`diagnostic`). `keiko-server`'s
  `processServerLogSink()` supplies both at every call site: `keiko-memory-vault`'s `cipher.ts`
  (`keyFromKeychain`, threaded through `createMemoryVault`'s `securityLogSink` option from
  `memory-handlers.ts`'s `createBffMemoryVault`), `qualityIntelligence/figmaSnapshotOrchestration.ts`,
  `conversation-attachment-store.ts`, and `editor/localHistory/localHistoryStore.ts` (the latter two
  via `deps.ts`). Each site degrades to a silent no-op sink when unwired, so a missing composition
  edge fails closed rather than throwing.
- **Gap g18** (epic #3233 §8, later in Wave 4a): `resolveLocalVaultKey`
  (`keiko-security/src/secret-vault.ts`), the shared env -> macOS Keychain -> keyfile key-tier
  resolver every local vault composes, had no `sink` parameter at all, so none of its production
  callers could ever report which tier answered or that the keychain tier fell back — independent
  of the `SecurityLogSink` port existing. It now emits `security.vault.key-resolved`
  (`extra.source: "env" | "keychain" | "keyfile"`) on every resolution, and its own keychain reader
  (`createKeychainVaultKeyAccess`, a separate implementation from `macos-keychain.ts`'s
  `readMacosKeychainSecret` — it spawns `security` through an injectable `KeychainCommandRunner`
  rather than that function) reports `security.keychain.fallback` via the same
  `emitKeychainFallback` helper `macos-keychain.ts` exports, so the two keychain surfaces cannot
  report the fallback shape differently. `processServerLogSink()` reaches it through every caller:
  `credentialVault.ts` and `gateway-setup.ts`'s `persistGatewayConfig`/`durableStoredGatewayConfig`
  (the provider-credential vault), `atlassian/credentialVault.ts` via `atlassian/wiring.ts`,
  `editor/hotExitStore.ts`, `localKnowledgeKeyProvider.ts`, `workspace-index-provider.ts` (all five
  via `deps.ts`), and the `conversation-attachment-store.ts`/`editor/localHistory/localHistoryStore.ts`
  sink options wired in the earlier bullet, which reached the sharded vault's shard reads but not
  this key-resolution layer until now.
- **ADR-0048** (evidence artifact confidentiality) governs the same owner-private artifact class.
  The canonical report carries only registered safe events and the closed private incident
  projection. Legacy audit/config/evidence sections are retired, and the integrity metadata is
  embedded in the one report (D8), never a separate `.sha256` file.

## How an agent reads the log

This section is the operational summary of the join keys this ADR defines, stated once in one place
rather than left implicit across the Decision section:

1. **Within one process lifetime**, order every persisted line carrying the full v2 identity triple
   by `(pid, instanceId, seq)` — exact and strictly monotonic, but not gap-free (D2). A gap marks a
   sink invocation or subsequent evidence record whose next physical write did not persist. A
   retained pre-v2 line carries no such triple; it is ordered by its own file position instead,
   counted in `legacyLineCount`, and never treated as belonging to a process lifetime (D10).
2. **Across process lifetimes**, do not rely on the ordering tuple; use `ts` only as a best-effort
   hint, and prefer to reason about one logical operation (one request, one job) at a time, since
   that operation's lines all share one process lifetime by construction.
3. **Within one logical operation**, join every line — HTTP request, gateway call, WebSocket
   session — by `correlationId` (D5).
4. **Across a spawning relationship** (a background job triggered by a request), follow
   `parentCorrelationId` from the spawned operation's lines back to the spawning operation's
   `correlationId` (D5).
5. **For process lifecycle events** (`process.started`/`process.heartbeat`/`process.exiting`), which
   carry no `correlationId` and so never enter a per-correlation timeline, read the analyzer's
   `processes[]` summaries instead — one entry per `(pid, instanceId)` lifetime (D9).
6. **For an error**, read `errorKind` for the closed-vocabulary classification, and
   `extra.frames`/`extra.causeChain` for the dist-anchored Keiko-code stack (landed Wave 2), resolved
   against the exact product version named in the validated report's incident and events (D3, D12).
7. **For what could not be reconstructed**, read a `warnings` array rather than assuming silence
   means nothing happened — there are two, at two different scopes, and neither is silent about a
   gap. The whole-file `AnalyzeAllResult.warnings` carries exactly one entry naming
   `legacyLineCount` when a retained pre-v2 line is present (D10). The per-correlation
   `ReproductionSeed.warnings` (D9) is richer: it always names the standing by-design gap that no
   prompt/response body is ever logged, plus one entry for each evidence class this particular
   correlation id's timeline could not supply (missing stack frames, no gateway call, no HTTP
   request line, no store fingerprint). A warning names exactly what evidence class is missing and
   why, so an agent's report to a human names the actual gap instead of guessing.
8. **For a failed or slow request** (landed Wave 5), read the `request` line's `routeTemplate`,
   `queryParamNames`, `responseBytes` and `aborted`, the stream's `sse.stream.closed` `reason`, and
   any `client.diagnostic` line that shares the request's `correlationId` (D13).
9. **Before trusting an absence**, read the same process lifetime's `activity-log.readiness` lines
   (state, closed reasons, writer) and its `activity-log.loss` summaries (lost events per closed
   reason, written when the counters change and always at exit) (D6). A timeline gap during a period with a non-zero loss
   count is lost evidence, not evidence that nothing happened.
10. **For one operation in a long history**, run `keiko support query --correlation-id <id> --json`
    (or `--incident`, `--defect-fingerprint`) instead of reading whole segments. It returns the
    operation's whole registered causal closure with its sufficiency, or `insufficient` with a
    closed reason when the closure does not fit or is no longer retained (D16).

## Consequences

- A customer support ticket, from Wave 1 onward, already carries a deterministically orderable
  artifact — the sequencing decision in D10 means no wave has to build and then retire a fallback
  heuristic for any v2 line.
- The ordering guarantee is honestly bounded (D2): an agent that assumes cross-process global
  ordering from the envelope alone is reasoning outside what this contract promises, and must fall
  back to `correlationId`/`parentCorrelationId` for cross-process causality. Within a process,
  `(pid, instanceId, seq)` uniqueness holds across every log directory that process writes to,
  because `seq` is allocated from one process-wide counter (D1), never one scoped per directory.
  The sequence is deliberately not gap-free: a gap marks a sink invocation or subsequent evidence
  record whose next physical write could not persist. The throttled stderr failure notice's
  `suppressedNotices` counts failed sink invocations; it is not an exact persisted-gap counter when
  one invocation attempted more than one record (D2).
- Retained pre-v2 log lines are a real compatibility case, not an oversight: a line written before
  this contract shipped can still appear in a retained legacy `server.log` or
  `server-YYYY-MM-DD.log` file. The analyzer never drops or misorders such a line — it orders it by file position, counts
  it in `legacyLineCount`, and surfaces exactly one `warnings[]` entry naming that count (D9, D10).
  An agent must read `warnings[]` before trusting that every line it analyzed came from an ordered
  v2 process lifetime.
- Bounded immutable segments are the disk bound (D14): total use is at most the byte budget plus
  the pin quota. No process appends to another process's segment, publication never replaces an
  existing name, pruning cannot select a non-grammar name or an unverified target, a crash-torn tail
  is reported rather than rewritten, and every outcome is reconstructable from typed body-free
  evidence.
  The documented residual same-user pathname race is a limit of Node's portable filesystem API,
  not permission to remove the bound.
- Process lifecycle events (`process.started`/`process.heartbeat`/`process.exiting`) carry no
  `correlationId` and so never enter a per-correlation timeline; the analyzer's `processes[]`
  summaries (D9) are the reconstruction path for them, keyed by `(pid, instanceId)` rather than by
  operation.
- The no-source-maps decision (D3) means reading a frame meaningfully requires building the exact
  tagged version the customer ran; this is a documented, deliberate cost, not a gap to be quietly
  worked around by enabling source maps later without amending this ADR.
- Retiring the raw `ui.log` (D8) removes the one free-text channel beside the body-free log. The
  cost is that an operator can no longer read a UI process's raw console output after the fact.
  Anything worth reconstructing has to be recorded as a registered, body-free Activity Log line,
  which is the contract this ADR sets for every change.
- Loss and readiness are counts and closed states, never content (D6). An operator learns that
  evidence was lost, how much and why, but never what the lost lines said. The ledger saturates
  instead of growing, so a storm of failures can never itself exhaust memory.
- The op catalog's closed vocabulary (D6) is enforced at the literal's origin, not at every
  forwarding call: a positional helper that cannot be statically resolved to a literal is recorded
  as `<dynamic>` at its own call site rather than failing generation, on the condition that every
  caller supplying that helper an `op` is itself a literal the generator catalogs separately. A
  `<dynamic>` entry is a pointer to those call sites, never the last word on what operation ran.
- The `ERROR_KIND_PATTERN` relocation (D11) deleted `error-kind-pattern-drift.test.mjs` and replaced
  it with the stronger `error-kind-pattern-single-source.test.mjs` pin as part of making its invariant
  structurally unbreakable; this ADR is the documented justification a reviewer checks that deletion
  against, and no later change may cite this ADR to justify a second copy reappearing.
- This ADR is Accepted: every decision above (D1–D13) is load-bearing in the shipped code, the op
  catalog is generated and drift-tested against the full, final vocabulary (D6), and the "Wave N"
  markers throughout this document are a record of when each decision landed, not an admission that
  anything remains pending.
- **Recorded limitation — the bare-`catch` sweep is bounded, not exhaustive.** The 12-reader audit
  that opened this epic found roughly 739 bare `catch {}` blocks across `keiko-server`; this
  contract fixes the audit-named true positives at the sites the audit identified as silently
  losing real diagnostic value, and does not sweep the remaining population. A `catch` outside
  those named sites that merely narrows an already-handled error class, or that intentionally
  discards an expected, already-classified condition, is not a gap this ADR leaves open by
  accident — it was never in scope. A future pass sweeping the remainder would be new, separately
  scoped work, not a continuation this ADR defers.
- **Recorded limitation — no JSON request/response shape-skeleton feature.** D9's forward-referenced
  guardrail (positional locators over a request/response shape, never customer field names as
  object keys) remains a specified guardrail for a feature this epic does not build. Nothing in the
  shipped contract logs a request or response shape at all; this bullet exists so a future author
  reads the constraint before building the feature, not as a pending deliverable of this epic.
- **Recorded limitation — connector crawl logging is manual, not integrated.** Connector ingestion
  (for example, the Atlassian and Figma connectors' crawl/sync loops) emits through the same
  `ServerDiagnosticSink`/structural log-port choke points this contract wires everywhere else it
  touches, but this epic did not perform a dedicated audit-and-instrument pass over every connector
  crawl step the way it did for the memory, harness, and gateway lanes. Any gap in a specific
  connector's crawl-step logging is tracked as ordinary product work against that connector, not as
  unfinished business of this ADR.

## References

- [ADR-0010](ADR-0010-audit-ledger-and-evidence-manifests.md) — redacted-by-construction evidence
  manifests; the precedent this contract's canonical report extends.
- [ADR-0019](ADR-0019-modular-package-architecture.md) and [ADR-0179](ADR-0179-activity-log-package-boundary.md) — dependency direction and the writer/store/reader package boundary; every new log-port
  edge in this contract points inward, and the server composition root is the only place a real sink
  is wired to a domain package's port.
- [ADR-0048](ADR-0048-evidence-artifact-confidentiality.md) — confidentiality tiers and write-time
  permission enforcement for evidence artifacts; the canonical support report is an artifact class in the
  same spirit.
- Epic #3233 — the governing epic; its 12-reader audit is the source of the 36 gaps this contract
  and its later waves close.
- #3230 — shipped the v1 activity log (`<stateDir>/logs/server.log`) this contract extends.
- `packages/keiko-activity-log/src/server-log.ts`,
  `packages/keiko-activity-log/src/log-redaction.ts`, and
  `packages/keiko-activity-log/src/server-logger.ts` — the Activity Log choke points every new log
  field in this contract routes through.
- `packages/keiko-server/src/observability/route-template.ts` — the server-only route-template
  composition point this contract routes through; the server installs its reducer into the Activity
  Log redaction through `configureActivityLogRouteRedactor`, which fails closed until configured
  (ADR-0179).
- `packages/keiko-server/src/correlation.ts` and `packages/keiko-server/src/diagnostics-log.ts` — the
  existing correlation-id guard and diagnostic-projection machinery this contract wires further
  rather than replaces.
