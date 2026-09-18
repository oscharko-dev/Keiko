# ADR-0173: Server activity log v2 — a machine-reconstruction contract for autonomous defect triage

## Status

Accepted (Epic #3233, Wave 6 closeout, 2026-08-22). Amended 2026-09-17 to define
the durable CLI control-state boundary for commands that audit or remove runtime state.

Drafted in Wave 1 alongside the envelope's ordering primitive (`seq`) and the minimal exporter/
analyzer, and finalized here once all seven waves of the epic had landed: envelope v2 (D1–D2),
stack frames and their redaction guards (D3–D4), correlation threading end-to-end (D5), the
generated op catalog (D6), process lifecycle events (D7), the support-bundle format and its CLI
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
`keiko support export` and the desktop footer report. Every exit leaves one `process.exiting` line,
and a fatal crash leaves `process.fatal` (D7). The raw `ui.log` channel is retired, and the support
bundle never carries it (D8, D9).

Amended by #3531 on 2026-09-18: `keiko support query` and selective `keiko support export` read the
segmented log in bounded memory through derived, rebuildable per-segment manifests, and select an
operation's whole registered causal closure or report it `insufficient`; required evidence is never
cut to fit a budget (D16). `keiko support analyze` reads its input through the same bounded line
reader.

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
`suppressedNotices`) to the process's stderr stream; and if `process.stderr.write` itself throws
(a closed descriptor, a broken pipe — the stderr stream is not guaranteed writable either), the same
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
the resulting bundle contains that evidence. When a pending normalization meets a symlink or
non-directory state root, the export refuses before reading or exporting the target and emits
`cli.support.export.failed` through the same fixed control-state log, provided canonical isolation
from the selected target can be proved. If isolation itself cannot be proved, the same terminal-only
limit above applies; the command never guesses at a writable evidence location.

### D3 — Keiko-code stack frames: dist-anchored, and why no source maps

Stack frames and cause chains are added to `extra` as `frames?: readonly string[]` and
`causeChain?: readonly string[]` (Wave 2, landed:
`packages/keiko-server/src/observability/stack-frames.ts`). Each frame entry is a single joined
string in one of two shapes: a workspace-package frame,
`"packages/keiko-<pkg>/(dist|src)/relative/path.(js|ts):LINE:COL"`, or, for the root `keiko` bin's
own entrypoint — which lives outside every `packages/*` directory —
`"(dist|src)/cli/relative/path.(js|ts):LINE:COL"`. Both shapes are pinned together by one pattern,
`FRAME_SHAPE_PATTERN` (`stack-frames.ts`), which `log-redaction.ts` re-validates structurally at the
redaction boundary rather than trusting the producer (D4).

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

The consequence for an agent reading a bundle is stated in the playbook this ADR forward-references
(`docs/observability/reproduction-harness.md`, Wave 6): a frame names the `dist` output of the
**exact tagged product version** the customer ran. The agent checks out that tag and lets `tsc`
reproduce the same `dist/<file>.js:LINE` deterministically — this works because Keiko's builds are
reproducible from a tag, not because the frame carries a source location. A future dist→src mapping,
usable only when a local `.js.map` happens to exist, is named as a later nicety and explicitly not
built in this epic.

The redaction side of this decision — why a frame string structurally defeats the existing path
guards, and the field-name-keyed guard that closes the gap for real rather than resting on an
accidental non-match — landed in Wave 2 as `redactKeikoFrames`/`redactCauseChain` in
`log-redaction.ts`; its full shape is D4's scope, not re-litigated here, so this section keeps
stating the reducer's own shape and its no-source-maps rationale.

### D4 — Redaction doctrine is unchanged: body-free, fail-closed, structural

Nothing about this contract relaxes `log-redaction.ts`'s existing doctrine: guards are structural,
not advisory, and do not depend on a caller naming its fields honestly. Every new field this ADR
adds is additive to that doctrine, not an exception carved into it. Wave 2 landed all three
field-name-keyed escape hatches this section anticipated, and all three share one restriction: each
fires only at the TOP LEVEL of `extra` — `redactLogObject`'s own direct call from
`redactLogFields`, never at any nested depth. The trust extended is a promise this log's own
producers make about their own top-level `frames`/`causeChain`/`diagnosticSummary` fields; the same
field name nested inside some unrelated object carries no such promise and takes the ordinary
generic path instead.

- `frames`/`causeChain` (D3) are named, typed escape hatches — `redactKeikoFrames`/`redactCauseChain`
  in `log-redaction.ts`, dispatched by `redactGuardedArrayField` — not a bypass of the generic value
  guards, but a **dedicated, field-name-keyed validator** for exactly these two fields, because the
  generic prose/path guards cannot recognize a dist-anchored frame as safe without also being loose
  enough to leak an unrelated deep path. `frames` is re-checked element-by-element against
  `stack-frames.ts`'s own `FRAME_SHAPE_PATTERN` and `PACKAGE_DIR_NAMES` (imported from that module,
  not restated); `causeChain` is re-checked against `DECLARED_ERROR_CLASS_SHAPE`, imported from the
  leaf `error-classification.ts`. A non-conforming element is dropped, never echoed or replaced in
  place — the same fail-closed direction the existing `path`-field escape hatch (`redactRoutePath`)
  already uses — and each guarded array is additionally capped, after filtering, at the reducer's own
  default element count (8 for `frames`, 5 for `causeChain`), so a forged over-length array cannot
  push a real element out of the result by padding the front with junk. This is the same escape-hatch
  architecture extended with two more named cases, not a second choke point.
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
  and carries no marker. An agent reading a bundle can distinguish "nothing more happened" from "more
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
  HTTP status from the error class alone; `retryAfterMs` is present on the same line only when the provider itself supplied a
  retry value — there is no fallback default, so its absence is itself evidence that the provider
  did not advertise one, not a gap in the record.
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
it, and so does `keiko support export` for the exported directory. The desktop footer shows a
degraded or unavailable state with its reasons.

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
  derived generically from the class's lifecycle and causal declarations. Artifact integrity,
  parent correlation, the class's causal start on a failure's correlation, an unknown failure
  correlation, own-line partial evidence and Activity Log evidence loss all feed it. Loss is
  attributed to the named dropped operation, to the reporting package's classes for a port sink
  failure, or else to the reporting process lifetime. A product loss that its own loss line fully
  evidences keeps the report complete. The projection is carried by `--json`, `--seed` and
  `support.analyze.classified`.
- **A curated end-to-end scenario matrix.** For each surface and each applicable mode,
  `tests/activity-log-scenarios` drives a production entry point through the real file writer. The
  support analyzer must then reach `complete` (`expectActivityLogScenario`). Every failure class
  maps to the scenario of its surface and mode, and no class gets its own journey.

A registration never declares `frames` or `causeChain` required. Redaction omits an empty array, so
a required one would reject the ordinary failure without Keiko frames or a cause. The generator
reports that declaration as `registration-omitted-field-required`.

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
construction: per-provider `modelId`, `endpointHost`, `timeoutMs`, `maxRetries`,
`retryBaseDelayMs` — never `baseUrl` or `apiKey`). Folding the cheap fields into `process.started`
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

### D8 — The support artifact is one JSON-Lines file; the raw `ui.log` is never part of it

**Format.** One `.jsonl` file, not an archive. `server.log` is already valid JSONL and every line
is already redacted at write time, so wrapping it in a zip or tar format would re-redact nothing
while adding a transformation step that is itself a place a leak could be introduced — and no
archive helper exists anywhere in this repository today, so adding one would be exactly the
"parallel subsystem where an existing shape already fits" this repository's reuse discipline warns
against. An agent parsing the artifact wants `readlines()` + `JSON.parse`, with no extraction step.

The artifact is not an undifferentiated concatenation: line 1 is always a manifest, a small number
of subsequent lines are typed `$section`-tagged records, and every remaining line is a verbatim,
byte-for-byte copy of a real `server*.log` line — oldest file first. Nothing already-safe is
re-transformed, so a re-encoding bug cannot introduce a leak into lines that were already safe on
disk.

**The raw `ui.log` is retired, and never part of a report (#3532).** Earlier versions of
`keiko start` copied the detached UI process's raw stdout and stderr into `<stateDir>/ui.log`. That
channel was free text, including raw error messages, so it could never meet the body-free contract.
A customer-facing export that mixes it with the redacted structured stream would undermine the
contract by construction.

The UI process's stdio is now ignored. Every diagnostic it produces already reaches the Activity
Log, and a crash that happens before the first log line is still recorded: `process.fatal` falls
back to the resolved state directory (D7). When the UI does not become healthy, `keiko start` names
a closed outcome (`process-exited` or `health-timeout`) instead of pointing at a raw log.

The former opt-in flags (`--include-ui-log --i-understand-this-is-unredacted`) are refused as a
usage error rather than ignored. An existing `ui.log` from an earlier version is left in place,
never read into a report, and removed with the rest of the runtime state by
`keiko uninstall --state`. The manifest still names `ui-log` in
`sectionsExcluded`, so a reader of an old or a new bundle sees the same, explicit exclusion.

**Size bounds.** Capped by an overall export byte ceiling; files are dropped oldest-first when the
ceiling is exceeded, and every drop is recorded in
the manifest's `truncatedLogFiles` — never silent. The current (never-dropped) file is not exempt
from the ceiling: when it alone still exceeds the residual budget, only its tail is exported —
the newest bytes, advanced to the next line boundary so the first exported line is always
complete — read with a bounded reader rather than loading the whole oversized file, and recorded
in the manifest's `currentFileTailTruncated` (name and dropped-byte count only, never a path).

### D9 — CLI surface: `keiko support export` and `keiko support analyze`

Two new commands under one `support` command family (not `bundle export` / `log:analyze` — a single
coherent noun groups the artifact producer and its own consumer under one verb space):

- `keiko support export [--out PATH] [--state-dir PATH] [--max-bytes N]
  [--include-evidence RUNID[,RUNID...]]` composes existing,
  already-hardened pieces — the evidence index listing, the local-state audit summary, a redacted
  config-snapshot of Keiko's own resolved `KEIKO_*` runtime configuration, and a concatenation of
  every Activity Log file in logical-log order (legacy files, then sealed and active segments, D14),
  selected oldest-first within the byte budget, each read
  through a no-follow, private, single-link regular-file descriptor (a symlink, hard link, or
  non-regular entry at a log name is skipped by name with its closed refusal kind, never read
  through) — into one manifest-led
  `.jsonl` bundle, plus a
  `<output>.sha256` integrity sidecar (D12). No new redaction logic is written for the bulk of the
  file — every log line copied in is a line that was already redacted at write time. A legacy raw
  `ui.log` is never read into the bundle, and the retired flags that once attached it are refused
  (D8). `--include-evidence` attaches the full `EvidenceStore` manifest for each named run id,
  beyond the index-only summary, for deep replay. After a successful export, the command evaluates
  the exported directory's diagnostic readiness (D6) and prints it. That readiness line is persisted
  after the report is written, so the report stays exactly the evidence that existed when it was
  taken.
- `keiko support analyze FILE [--correlation-id ID] [--json]` reconstructs three complementary
  views from the same parsed lines, because `correlationId` alone cannot carry everything an agent
  needs to reconstruct: a **per-correlation timeline** for every line that carries a
  `correlationId`, ordered within one process lifetime by `seq` and across lifetimes by first
  file-position (D2), additionally carrying the union of every `frames[]` entry seen for that id;
  a **per-process-lifetime summary** (`processes[]`, keyed by `(pid, instanceId)`) built from every
  line carrying the full v2 identity triple regardless of `correlationId`, so the lifecycle events
  D7 introduces (`process.started`/`process.heartbeat`/`process.exiting`, which carry no
  `correlationId` and so belong to no timeline) are still reconstructable — first/last `seq`,
  first/last `ts`, line count, and the `process.started`/`process.exiting` payloads when seen; and
  whole-file `clusters` — every parsed line grouped by `(category, op, errorKind)` regardless of
  correlationId. The analyzer also reports `legacyLineCount` — lines it parsed successfully but
  that are missing the full identity triple — and a `warnings[]` entry naming that count when it is
  nonzero, so the admission that some lines fell back to file-position ordering is machine-readable
  rather than a silent omission. Separately, `malformedLineCount` counts lines that could not be
  read as a log record at all (not valid JSON, or valid JSON missing `ts`/`category`/`op`) —
  evidence of corruption, never conflated with a legacy line, which parses cleanly and is merely
  missing the v2 identity triple. `--json` emits the timeline/process/cluster reconstruction above.
  The fuller per-correlation output — a `ReproductionSeed` (`gatewayScript`/`httpRequest`/
  `storeFingerprint`/`indexingJob`/`stackFrames`/`causeChain`, each with its own honest `warnings`
  entry when it cannot be reconstructed) and a pasteable gateway-replay-script fixture — is
  implemented and exported (`buildReproductionSeed`, `renderGatewayReplayScriptFixture` in
  `packages/keiko-cli/src/support-analyze.ts`), unit-tested directly, and wired to
  `support analyze` itself: `--clusters` renders the whole-file `(category, op, errorKind)`
  grouping, `--seed` builds the `ReproductionSeed` for the id named by `--correlation-id`, and
  `--emit-fixture PATH` writes the pasteable gateway-replay-script fixture to `PATH`. Both
  `--clusters` and `--seed` render as human-readable text by default and as the same JSON shape the
  underlying builder produces when `--json` is also given. `--emit-fixture` is fail-closed: it
  refuses to overwrite a file that already exists at `PATH`, creates any missing parent directories
  before writing, and reports the written path on success rather than the fixture body. Among the
  `ReproductionSeed`'s fields: a rate-limited call always carries `httpStatus` — the provider's
  actual status (`429` is only the default for a standard rate-limit error, never a replacement for
  a supplied `503`) — so a replay script's rate-limit attempt never has to infer its HTTP status
  from the outcome discriminant alone; `retryAfterMs` rides along on the same line only when the
  provider supplied one, with no synthesized fallback.

  The default and per-correlation analyzer reports also carry an `analysisContext` identifying the
  resolved input file, an inferable state directory for raw `<state-dir>/logs/server*.log` inputs,
  the newest valid event timestamp and newest observed process instance, plus explicit freshness
  and process-activity states. A raw log older than five expected one-minute heartbeat intervals is
  `stale`/`inactive` and contributes a warning; a fresh raw log is only `apparently-active` when the
  newest process did not record an exit and its PID still exists. Bundles are historical artifacts
  (`not-applicable` process activity), and missing or invalid data remains `unknown`. The analyzer
  never replaces missing evidence with a file mtime, the current process, or a guessed state dir.

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
parsed log records with no `pid`, `instanceId`, or `seq` field to order by. D9's exporter copies
these verbatim (D8's "one JSON-Lines file" format applies uniformly; there is no schema-aware
filtering at export time), so the analyzer must define what happens to them rather than silently
dropping or misordering them. The compatibility rule: a retained pre-v2 line is never discarded and
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
- `keiko-server`'s own `errorKindOf` (`server-log.ts`) was rewritten in the same wave to route
  through `error-classification.ts`'s `machineToken`/`contentFreeErrorClass` instead — a different,
  purpose-built composition, not a call to `classifyErrorKind`. This still satisfies the invariant
  `ERROR_KIND_PATTERN` protects (there is no second textual declaration of the pattern anywhere in
  `keiko-server`), and it closes a gap `classifyErrorKind` alone cannot: that function only judges a
  string already in hand, while `errorKindOf` also has to safely READ a hostile `code`/`name`
  property whose accessor may throw, and — when `code` is absent — fall back to a declared class
  name. `error-classification.ts` bundles exactly that reflective-read hardening
  (`safeProperty`/`machineToken`/`contentFreeErrorClass`), so `keiko-server` composes from it instead
  of composing `classifyErrorKind` with a second, hand-rolled hardening layer beside it.

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

The agent-reading step this adds: **for a failed request**, read `routeTemplate`,
`queryParamNames`, `responseBytes`, `aborted` and — for a stream — the `sse.stream.closed` line's
`reason`, then look for a `client.diagnostic` line sharing the `correlationId` to learn what the
browser saw. Everything on these lines is a count, a closed label, a template, or an id.

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
  evidence.

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
server's governance. Segment size/age stay per-writer settings, clamped against the governing
retention bytes with the same invariant as before. Total disk use is therefore at most the ONE
governing byte budget plus the pin quota, even when cooperating processes' own env values disagree.

**Pins.** `pinActivityLogWindow` protects one of two scopes until an expiry of at most 3650 days:

- a time window of up to seven days, across every process instance, including segments sealed later
  inside it;
- up to 64 named segments.

At most 64 pins are active. The pin record is published before the current segment is sealed, so
the next retention pass honors it. Pinned sealed segments count against `KEIKO_LOG_PIN_QUOTA_BYTES`,
oldest pin first, and only while the quota lasts. A pin the quota cannot hold is still recorded with
`quotaStatus: "exceeded"`. Its unprotected remainder produces one `activity-log.pin.quota-exhausted`
loss marker with segment counts, bytes and the seq span. Expired and invalid pin records are removed with `activity-log.pin.expired`. `releaseActivityLogPin` removes a pin before its expiry, for example once its incident was reported or dismissed; the same line records it with `expiryReason: "released"`. Neither pin function ever throws: an unlistable directory or a failed removal is a closed, evidenced rejection, because both are reachable from a sink's own write path. #3530 provides the primitive; #3533 decides when and what to pin.
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

Segments stay uncompressed. A sealed segment is directly readable by `keiko support analyze` and by
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
`trigger` records which. Eligibility derives from the registry, never from a UI-side list.

On the registered-failure trigger, the window's Activity Log retention pin (15 minutes before, 5
minutes after, through D14's pin primitive, across every process instance) is published
synchronously, in the same turn as the triggering write — before any later maintenance pass, this
process's own next segment admission or another process sharing the state directory, can run against
an unprotected window. Only the rest of candidate creation — deduplication, the quota check, and the
record write — runs outside the logging call; it never transfers data. A duplicate or a rejected
candidate releases the pin its trigger already published instead of leaving it to sit until its own
TTL. The residual race a synchronous publish cannot fully close on its own — a concurrent process's
retention removing a sealed segment in the narrow gap between observing the window and the pin
actually covering it — is detected by comparing that snapshot to the pin's own outcome and reported
as the pin's `evidenceLostBeforePin`, so the window is never reported as a clean "pinned" when part
of it was already lost. No causal-closure computation happens at pin time; a later selective export
chooses the closure from the pinned window.

Two identifiers serve two purposes. `incidentId` is random and names one occurrence.
`defectFingerprint` is deterministic and versioned over allowlisted stable inputs (owning surface,
operation, closed `errorKind`, normalized Keiko frame signature) and carries no time, process,
instance, host, user or path value; it groups recurrences for deduplication and fix linkage. A change
to its inputs or algorithm bumps the algorithm version; a golden-value test enforces that.

The descriptor has a strict public projection and a richer, still body-free private projection from
the same record; both expose the sufficiency status, and only the private one carries reasons and
coverage. The store is owner-private, closed-grammar and quota-bounded (32 open candidates, 8 of them
reserved for explicit reports, 4 KiB each), and candidates expire after 14 days. Acknowledge, dismiss
and report remain explicit human actions; nothing is disclosed automatically.

### D16 — Queries select whole causal closures through derived segment manifests

`keiko support query`, selective `keiko support export` and incident resolution share one streaming
engine (#3531). It never loads a whole segment or the whole log. It streams candidate segments line
by line and retains only the selected events, up to a report budget.

**Manifests are derived metadata, not a second log.** Each sealed segment has one manifest in the
owner-private, closed-grammar store `<stateDir>/activity-log-manifests/`
(`manifest-<segmentId>.json`, at most 256 KiB). It carries the schema and catalog versions, the safe
time range, the process and sequence ranges, the registered categories, operations, error kinds and
failure classes with counts, the loss and integrity state, a Bloom filter over the correlation keys
(hash bits only) and a SHA-256 digest. An `incidentId` or `defectFingerprint` appears only when a
registered operation that declares that field carries it; a sealed segment is never touched to add
one. Every value is a pure function of the segment's bytes and the build's catalog, so deleting the
store and rebuilding it reproduces every manifest byte for byte. A stored manifest is accepted only
when it re-serializes to its own bytes and its digest matches; anything else is rebuilt. Only the
query, export and rebuild commands write manifests, never the Activity Log writer, and each pass
removes the manifests of segments that retention deleted, so the store follows the log's own bound.

**A closure is selected whole.** A correlation, an incident or a defect fingerprint selects the
registered causal closure: the roots, every ancestor over `parentCorrelationId` and every
descendant, and never an unrelated correlation. A narrow context adds only the uncorrelated process
signals of the closure's own process lifetimes within a configured window (default 5 seconds). A
user-reported incident also selects its pinned window and takes every correlation in it as a root.

**Nothing required is truncated.** A closure that does not fit the budget returns no events and is
`insufficient` with `report-budget-exceeded`; evidence retention removed is
`evidence-not-retained`; an unreadable candidate segment is `segment-unreadable`. Only optional
context may be dropped, declared as `context-truncated`. Every result carries its provenance,
integrity, coverage, loss and truncation, and exactly one sufficiency status from the per-class
projection `keiko support analyze` uses.

**No database.** Manifests and streaming meet the measured need: a checked-in long-history test
bounds peak memory and proves that manifest-pruned segment bodies are never opened. A database
requires recorded measurements that manifests are insufficient and an explicit re-scope of epic
#3527.

### D12 — Relation to prior decisions

- **ADR-0010** (audit ledger and evidence manifests) established the precedent this contract
  extends: redacted-by-construction, deep field-wise, before serialization. The support artifact's
  manifest line follows the identical shape discipline — a typed record, never a raw dump — and the
  evidence-index section it embeds is the same `listEvidence()` output ADR-0010's lineage already
  produces, never re-derived.
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
- **ADR-0048** (evidence artifact confidentiality) classified evidence artifacts into confidentiality
  tiers and mandated write-time permission enforcement. The support bundle is a new artifact class in
  that same spirit: every log line it carries was already redacted before this contract existed
  (`redactLogFields`'s choke point, unchanged here), and the one field this contract adds outside
  that pipeline — the manifest's `auditSummary`, built from the `AuditResult` `keiko audit
local-state` already produces — is redacted by a dedicated projection in
  `buildSupportBundleManifest` (`support-export.ts`) that drops `AuditResult.stateDir` before the
  manifest is ever assembled, because that field echoes the absolute directory the audit ran
  against and can embed the operator's OS username on a real machine. That projection is a
  purpose-built field-level redaction colocated with the manifest builder, not a routing of
  `auditSummary` through `redactLogFields` itself — `AuditResult` is a typed value, not a log line,
  so the log envelope's choke point does not apply to it. The manifest's `stateDirSource`
  closed-union label already carries everything an agent needs from that field (default vs.
  override), so nothing is lost. Its integrity sidecar (a `sha256` file alongside the bundle, Wave 6) exists because the
  bundle crosses a real trust boundary — customer machine → support ticket → agent — the same
  boundary ADR-0048's confidentiality tiers were written to reason about.

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
   against the exact tagged product version named in the support bundle's manifest (D3, D12).
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
  An agent must read `warnings[]` before trusting that every line in a bundle came from an ordered
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
  manifests; the precedent this contract's support-bundle manifest extends.
- [ADR-0019](ADR-0019-modular-package-architecture.md) — dependency direction; every new log-port
  edge in this contract points inward, and the server composition root is the only place a real sink
  is wired to a domain package's port.
- [ADR-0048](ADR-0048-evidence-artifact-confidentiality.md) — confidentiality tiers and write-time
  permission enforcement for evidence artifacts; the support bundle is a new artifact class in the
  same spirit.
- Epic #3233 — the governing epic; its 12-reader audit is the source of the 36 gaps this contract
  and its later waves close.
- #3230 — shipped the v1 activity log (`<stateDir>/logs/server.log`) this contract extends.
- `packages/keiko-server/src/observability/server-log.ts`, `log-redaction.ts`,
  `server-logger.ts`, `route-template.ts` — the existing choke points every new field in this
  contract routes through.
- `packages/keiko-server/src/correlation.ts`, `diagnostics-log.ts` — the existing correlation-id
  guard and diagnostic-projection machinery this contract wires further rather than replaces.
