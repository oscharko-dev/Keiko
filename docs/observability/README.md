# Observability: the server activity log

Keiko configures one operator-readable activity log for every local install. `KEIKO_LOG_LEVEL`
controls its threshold. `silent` suppresses ordinary events but never the log's own lifecycle,
loss and readiness evidence, and a silent interval is reported as degraded readiness rather than
passing for an active writer. This page documents the
log itself, how its lines join together across a request's lifecycle, and how to read it with
`keiko support export` / `keiko support analyze`. It is the consumer-facing counterpart to
[ADR-0173](../adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md), which records
the design decisions behind everything described here.

## File location, segments, and retention

Normal runtime activity lives in `<stateDir>/logs/`. `<stateDir>` is `./.keiko` by default, or
wherever `--state-dir` / `KEIKO_STATE_DIR` points. Commands that must audit or remove that selected
tree write their own lifecycle evidence to a fixed per-user CLI control-state log directory:

| Platform | CLI control-state log directory                     |
| -------- | --------------------------------------------------- |
| Linux    | `~/.local/state/keiko/control/logs/`                |
| macOS    | `~/Library/Application Support/Keiko/control/logs/` |
| Windows  | `%USERPROFILE%\AppData\Local\Keiko\control\logs\`   |

The control path accepts no environment override and may not be at or below the selected audit or
uninstall target. `keiko audit local-state` therefore cannot mutate the forensic tree it reads, and
`keiko uninstall --state` cannot delete or asynchronously recreate the store that holds its own
result. If the primary control root overlaps the target or cannot be validated or opened, the
command emits a body-free terminal refusal before any sink opens. It does not create an independent
fallback log root inside an unproved trust boundary. Any Activity Log file from a control-state log
directory can be passed directly to `keiko support analyze`.

One correlation id joins install-layout normalization to audit or uninstall start, subordinate
forced-stop activity, and completion/failure. Audit and uninstall events carry SHA-256 identities
for their selected targets instead of paths. Uninstall also logs dry runs and scripts-only work, and
its completion records the state disposition plus body-free affected and retained counts.

Each log is JSON Lines: one `JSON.stringify`-serialized object per line, written synchronously so
that the last line on disk before a hang or a crash is the last line the process actually reached.

When a state directory is configured, failure to create or open its log directory aborts startup
with a closed safe-artifact error. Keiko never silently substitutes a null sink for a configured
activity log; an in-memory/null sink exists only where a caller explicitly selected one, such as a
unit test that installs the test writer (see [Writer wiring](#writer-wiring-loss-accounting-and-readiness)).

### Segments

The directory holds one logical log, stored as immutable segments:

| File                                                     | Meaning                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| `activity-<start>-<pid>-<instance>-<index>.active.jsonl` | The segment one running process writes. Only it appends here. |
| `activity-<start>-<pid>-<instance>-<index>.jsonl`        | A sealed segment: read-only, never changed again.             |
| `server.log`, `server-YYYY-MM-DD.log`                    | Legacy files from earlier releases. Read-only; they age out.  |
| `pin-<id>.json`                                          | A retention pin that protects segments from deletion.         |

`<start>` is the segment's UTC start time. `<pid>` and `<instance>` identify the writing process, as
its lines do, and `<index>` counts that process's segments. The logical order is the legacy archives
by day, then `server.log`, then the segments by start time. `keiko support export` reads them in that
order for you.

A process seals its active segment in four cases:

- the next line would exceed the segment size;
- the segment reaches its maximum age;
- the process shuts down;
- a pin is requested.

The seal writes a final `activity-log.segment.sealed` line with the seq range (ending with its own seq), the line count and bytes of the lines before it, the duration and the dropped-event count. It then drops `.active` from the name and makes the file
read-only.

If a process crashes, its active segment stays behind. The next Keiko process seals it as it is, at
startup or before opening its next segment. A partial last line is kept and reported by
`activity-log.segment.recovered` with `tailState: "truncated"` and `truncatedBytes`. Complete lines
are never rewritten.

### Retention and limits

Retention runs at startup and before every new segment. It counts every file in the directory,
including legacy files and other processes' active segments. It deletes the oldest unprotected
sealed and legacy files first: those older than the retention age, then as many more as the byte
budget requires. Each pass is recorded as `activity-log.retention.pruned`. Total disk use stays
within the byte budget plus the pin quota.

| Variable                    | Default | Meaning                                                                          |
| --------------------------- | ------- | -------------------------------------------------------------------------------- |
| `KEIKO_LOG_SEGMENT_BYTES`   | 8 MiB   | Seal a segment before it exceeds this size. At least 32 KiB, at most 1/4 budget. |
| `KEIKO_LOG_SEGMENT_SECONDS` | 3600    | Seal a segment after this many seconds, from 1 to 604800.                        |
| `KEIKO_LOG_RETENTION_BYTES` | 256 MiB | Byte budget for every unpinned file. At least 64 KiB.                            |
| `KEIKO_LOG_RETENTION_DAYS`  | 14      | Delete sealed and legacy files older than this, from 1 to 3650 days.             |
| `KEIKO_LOG_PIN_QUOTA_BYTES` | 64 MiB  | Extra space reserved for pinned segments.                                        |

Each value must be a positive whole number within its range. Anything else falls back to the
default, so a typo never removes the bound.

A pin protects a time window, or named segments, from retention until it expires, within the pin
quota. `activity-log.pin.created` and `activity-log.pin.expired` record its lifecycle; a pin released before its expiry is recorded with `expiryReason: "released"`. A pin that
the quota cannot hold is still recorded, with `quotaStatus: "exceeded"`. One
`activity-log.pin.quota-exhausted` line then states how much evidence stays unprotected.

When storage runs short, `activity-log.pressure` records the transition. The states are
`low-disk-space`, `disk-full`, `backpressure`, `budget-exceeded` and `retention-blocked`, plus
`cleared` when the condition ends. The line carries the dropped-event count and the used, budget,
pin-quota and free bytes, so a gap in the log is never silent.

### Filesystem boundary

The filesystem boundary is the operating-system user. The selected state and log directories must
be owner-matched, non-redirected, and owner-only (`0700` on POSIX; the selected owner's inherited
ACL on Windows). Keiko rechecks their device/inode identity around every link, rename, and unlink,
and never lists, recovers, or prunes through a redirected directory.

Before a seal or a deletion, an opened handle must prove that the target is a regular,
owner-matched, private, single-link file that still names the checked pathname. Every link, rename,
and unlink also carries its source file's device/inode, taken from a descriptor held open until the
mutation returns. The mutation helper acts on the name only while it still has that identity, so a
process can never delete or publish a file that replaced the verified one. Holding the descriptor
matters because Linux reuses a freed inode number immediately.

Sealing publishes the sealed name with a hard link, which never replaces an existing name, and then
removes the active name. Only errors that state the filesystem does not support hard links permit
the guarded rename fallback. That fallback first claims the destination with an exclusive no-follow
create. A failed, unsafe, or ambiguous mutation leaves the file in place, is recorded as body-free
evidence, and never escapes into the caller.

There is a documented residual same-user race. Node has no portable descriptor-relative
link/rename/unlink API, and filesystems that lack hard links offer no no-replace rename, so the
fallback relies on its exclusive name claim. A process already running as the same OS user can act
between pathname checks. The implementation narrows that window with owner-private directories,
held directory and file handles, pre/post identity checks, and the non-replacing hard link. This
residual risk does not justify removing or postponing bounded retention.

### Upgrading from daily files

Earlier releases wrote one shared `server.log` and daily `server-YYYY-MM-DD.log` archives. After
the upgrade those files stay where they are, as read-only legacy segments. They are exported and
analyzed like segments, count toward the byte budget, and are deleted by the same retention once
they age out. `server-log.rotation` and `server-log.capacity-warning` are no longer written; old
lines that carry them stay readable.

## Log level

`KEIKO_LOG_LEVEL` gates volume, not content: an event below the configured threshold returns
before any string or JSON work happens at all, so a quiet level is also the cheap one. Accepted
values are `debug`, `info` (the default when unset or unrecognized), `warn`, and `error`, plus the
threshold-only `silent` to turn ordinary events off. A handful of common aliases are also
accepted (`trace`/`verbose` → `debug`, `warning` → `warn`, `fatal`/`critical` → `error`,
`off`/`none` → `silent`); a typo falls back to `info` rather than crashing the process or silently
disabling the log the operator is trying to read.

The log's own evidence is written at every level, `silent` included: `process.started`,
`process.exiting`, `process.fatal`, `activity-log.readiness`, `activity-log.loss`, and every
operation registered with `lifecycle: "loss"`. A quieted log therefore still says that it was
quieted (readiness reason `level-silent`) and whether it lost anything.

## Writer wiring, loss accounting, and readiness

**Every process writes, or says that it cannot.** A process resolves its log directory the way the
CLI does: a non-empty `KEIKO_STATE_DIR`, resolved against the working directory when relative,
otherwise `<cwd>/.keiko`. Commands that never set the variable (`keiko run`, `keiko memory`,
`keiko evaluate`, `keiko update`) therefore write the same log that `keiko start` in that directory
would. When the directory cannot be opened, the logger counts every event it receives as lost
(`logger-unavailable`) and tries again on the next event. A writer that discards events exists only
in tests, where the vitest setup files install it explicitly.

**Domain packages write through the process sink.** Each domain package owns an injected log port
(`SecurityLogSink`, `KnowledgeLogSink`, `MemoryVaultLogSink`, `ConsolidationLogSink`,
`ModelGatewayLogSink`), and the server and CLI composition roots pass every port the process sink.
A port catches its own sink failures and counts every one of them. A new package follows the same
pattern; ADR-0173 D6 states it as five rules.

**The UI process has no second log.** `keiko start` ignores the UI process's stdout and stderr,
because every diagnostic already reaches this log. Earlier versions copied that raw output into
`<stateDir>/ui.log`. An existing `ui.log` is left in place, never read into a support report, and
removed with the rest of the runtime state by `keiko uninstall --state`. When the UI does not become
healthy, `keiko start` names a closed outcome (`process-exited` or `health-timeout`), and a crash is
recorded as `process.fatal`.

**Loss is counted under a closed reason.** Every place that loses an event counts it in one bounded,
process-wide ledger:

| Reason                                                                                                                           | Counted when                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `logger-write-failed`                                                                                                            | The logger caught a failure while building or writing an event.                           |
| `logger-unavailable`                                                                                                             | No writable log directory existed for the process.                                        |
| `schema-rejected`                                                                                                                | The sink's registry validation refused an event.                                          |
| `persistence-failed`                                                                                                             | The file sink dropped an event after a failed append.                                     |
| `diagnostic-sink-failed`                                                                                                         | A server diagnostic record could not be delivered.                                        |
| `port-sink-failed`                                                                                                               | A domain package's log port threw. Every failure counts, not only the first.              |
| `port-unwired`                                                                                                                   | A domain package's log port had no sink wired, so the event went nowhere.                 |
| `client-rejected`, `client-rate-suppressed`                                                                                      | The BFF refused a malformed or oversized browser report, or its rate limiter dropped one. |
| `client-buffer-evicted`, `client-post-throttled`, `client-post-failed`, `client-rejection-suppressed`, `client-error-suppressed` | The browser reported loss on its own side of the transport.                               |
| `collector-dropped`                                                                                                              | The CLI's deferred security-event collector dropped events.                               |
| `summary-write-failed`                                                                                                           | The loss summary itself could not be written.                                             |

The counters are persisted as an `activity-log.loss` summary, one count field per reason that lost
anything. A heartbeat writes a summary only when the counters changed; the exit summary is always
written, so a clean shutdown also proves that nothing was lost. A summary that cannot be written only increments
`summary-write-failed`, so the accounting never recurses into a failing sink. The browser sends its
counts with its next report, and once more when the page is hidden.

**Readiness says whether this log can be trusted right now.** Each process evaluates a closed state:

- `ready`: every check passed.
- `degraded`: evidence is being recorded, with a named gap.
- `unavailable`: the registry identity is incoherent, or the log cannot be written at all.

The reasons are closed too: `catalog-mismatch`, `sink-unwritable`, `storage-pressure`,
`budget-exceeded`, `port-unwired`, `level-silent` and `storage-check-failed` (the storage could not
be inspected at all, for example an unlistable `logs/` directory; readiness reports it as degraded
and never passes the underlying error, which can name a path, to any surface). The startup check
runs before the server listens and persists an `activity-log.readiness` line through the real
append path. The heartbeat re-evaluates it and logs every transition.

Readiness covers the segment store through its health report: writability, the byte budget and
storage pressure, including blocked retention. Segment manifests are not a readiness input. They
are derived metadata that a query rebuilds whenever one is missing or stale, and they are never on
the path that writes or reads evidence, so their state cannot make evidence unwritable or
unreadable. `keiko support manifest verify` reports it.

| Where to read it                   | What it shows                                                        |
| ---------------------------------- | -------------------------------------------------------------------- |
| `keiko status`                     | `Diagnostic evidence: <state> (<reasons>); lost events: N.`          |
| `keiko ui` (foreground)            | A line naming the state and reasons when readiness is not `ready`.   |
| `keiko support export`             | The exported directory's readiness, after the report is written.     |
| `GET /api/health`                  | The `diagnostics` block: state, reasons, writer kind, lost events.   |
| The desktop footer                 | A badge when readiness is `degraded` or `unavailable`, with reasons. |
| The log (`activity-log.readiness`) | The startup state and every later transition.                        |

## The op catalog

[`op-catalog.generated.json`](op-catalog.generated.json) is the single generated registry. Its
`typedRegistry.operations` array is the authoritative production contract: each operation is a
literal `defineActivityLogOperation` declaration bound to an `activityLogEvent` emitter through
TypeScript symbol resolution. Non-literal registrations, duplicate operations, unregistered
emissions, and registrations with no emitter are closed violations with an exact source site and
corrective action.

The root `entries`/`operations` arrays remain only as a non-authoritative migration input for code
that still uses the predecessor's bracket scanner. Their `<dynamic>` and `unknown` values are
reported in `legacyDiscovery`; they can neither register nor authorize a production operation.
Producers move into the authoritative array operation by operation, without adding a second
catalog or treating heuristic inference as contract truth.

Each authoritative entry defines the exact flattened fields a producer may emit, including their
primitive types, maximum lengths/counts, closed values and safe data classes. It also records the
causal and lifecycle role, analyzer projection, supported failure classes, executable proof ids,
and release impact. The runtime event constructor derives its TypeScript shape from that entry and
the physical sink validates the same contract again immediately before serialization. A caller
therefore cannot add arbitrary metadata, widen a field after construction, or use an unregistered
operation as an escape hatch.

The generated contracts runtime exports those complete safe operation schemas and the derived
failure-class coverage alongside the identity digests. Every schema receives mandatory
`completeness` and `loss` fields centrally; emitters get the safe defaults `complete` and `none` and
override them only when they observed partial evidence or a known loss.

`typedRegistry.obligationCategories` is the stable machine vocabulary for future implementation
gates. `typedRegistry.failureClassCoverage` groups the same operation declarations into a generated
matrix of owning product surfaces, lifecycle transitions, causal edges, safe context fields,
frame/cause availability, loss signals, analyzer projections, and executable proof or replay
references. The release expectation is `100%-complete`; a class missing required completeness,
loss, or proof evidence is an authoritative registry violation.

`typedRegistry.exemptions` is governed by its adjacent `exemptionSchema`. The list is intentionally
empty by default. A reviewed entry may cover only one exact registered operation/failure-class
pair at an unavoidable platform or durability boundary, and must include an owner, technical
reason, linked issue, and expiry. Unknown or broad scope, stale/expired records, and extra keys that
attempt to authorize fields, prohibited data, silent loss, or incomplete evidence fail closed.

A registration never declares `frames` or `causeChain` required
(`ACTIVITY_LOG_OMITTED_WHEN_EMPTY_FIELD_NAMES`): redaction omits an empty array, so a required one
would reject every failure line without Keiko frames or a cause. The generator reports it as
`registration-omitted-field-required`.

## Proofs, the failure-surface inventory, and sufficiency

Three generated or derived views turn the registry into executable evidence. None of them is a
second catalog: each is computed from the typed registry and the sources.

**Executable proofs.** Every proof id is `<op>.<suffix>`. It resolves only when a test in the
operation's owning package calls one of these helpers with the id as a string literal:

- `expectActivityLogProof("<proof id>", line)` checks a line the production file sink persisted, or
  an event passed through `formatActivityLogProofLine(event)`. That function is the real
  `formatRegisteredServerLogLine`, so it revalidates the registration, the fields, and this build's
  v2 identity.
- `expectActivityLogStderrProof("<proof id>", line)` checks the emergency stderr notice the sink
  writes when it cannot persist.

Both helpers live in `tests/support/activity-log-proof.ts`. A captured event object alone cannot
satisfy them. The generator finds the calls with the TypeScript parser, so a commented-out call or a
call spelled inside a string does not count. The following are violations:

- a proof call in another package;
- a non-literal or unregistered proof id;
- a registered proof id that no test resolves.

**The failure-surface inventory.**
[`failure-surface-inventory.generated.json`](failure-surface-inventory.generated.json) is written by
`generate:op-catalog` and pinned byte for byte by `check:op-catalog`. It carries only what the
catalog does not, and it joins the catalog by operation name.

- A closed rule table in `scripts/lib/activity-log-failure-surfaces.mjs` maps each owner package and
  emitter-module prefix to one of nine surfaces: `ui`, `bff`, `client-diagnostics`,
  `model-gateway`, `tools-workflows`, `memory-knowledge`, `editor-delivery`, `lifecycle-crash` and
  `runtime-packages`. An unmapped operation, an ambiguous rule, or an unused rule is a violation.
  So is a surface with no operation.
- Each surface lists its owners, the log ports they emit through, its operations, and its
  scenarios.
- Each failure class maps to `<surface>.<mode>`. The mode is one of `rejection`,
  `dependency-failure`, `crash` and `loss`. It comes from a registered loss lifecycle or from closed
  operation-name tokens.
- `proofs` and `scenarios` name the test files that resolve them. An empty list means unresolved.
- The autonomy mode is recorded as closed context: it is not a matrix multiplier. The inventory
  lists the operations that carry it.

The same op-to-surface map is generated into the contracts runtime as
`ACTIVITY_LOG_OPERATION_SURFACES` and `ACTIVITY_LOG_FAILURE_SURFACES`.

**Per-failure-class sufficiency.** `keiko support analyze` projects every failure class an artifact
observed to `complete`, `degraded` or `insufficient`. The reasons come from the closed
`DIAGNOSTIC_SUFFICIENCY_REASONS` in the contracts. The projection is derived generically from the
registry's lifecycle and causal declarations, in `support-analyze-sufficiency.ts`:

- **Insufficient** means required evidence is missing: corrupt lines, a parent-correlated operation
  without its parent, an end or failure without its class's causal start on the same correlation,
  or no registered evidence at all.
- **Degraded** means localization remains possible, but there is a closed warning or a bounded loss:
  - truncated, unsupported or incomplete lines;
  - a duplicate, decreasing or reset sequence (a gap alone is not degraded, because it can be a
    write to another state directory);
  - a failure line without a known correlation;
  - an emitter that declared its own line partial;
  - Activity Log evidence loss.
- **Evidence loss** is attributed as precisely as its loss line allows:
  - a line that names the dropped operation affects that operation's classes;
  - a port sink failure affects the owning package's classes in the same process;
  - any other loss affects every class in the same process.

  The `activity-log.loss` summary propagates only its Activity Log counters. The browser-side
  `client*` counts do not propagate, because the client-diagnostic loss lines evidence them.

- A product loss that its own registered loss line fully evidences keeps the report complete. A
  rate-limited client report and a bounded discovery are examples.

The projection appears in several places:

- the `--json` output, as `sufficiency` on the whole artifact and on a single timeline;
- every `--seed`, narrowed to the timeline's classes;
- the `support.analyze.classified` line, as `sufficiency`, `sufficiencyReasons` and the class
  counts.

**The scenario matrix.** `tests/activity-log-scenarios/*.test.ts` drive production entry points of
every surface into each applicable failure mode. The real file writer runs under a temporary
`KEIKO_STATE_DIR`. Each scenario then calls
`expectActivityLogScenario("<surface>.<mode>", { stateDir, startedAtMs, expectedOps })` from
`tests/support/activity-log-scenario.ts`. That call reconstructs the persisted log with the analyzer
and asserts four things:

- only supported evidence;
- the expected operations in causal order;
- a failure class that the inventory maps to the scenario;
- a `complete` projection.

Every failure class maps to the scenario of its surface and mode. There is no separate journey per
class.

**One command runs the whole gate.** `npm run check:activity-log` builds the packages and then
runs `check:op-catalog`, the scenario matrix, `check:error-observability`, `arch:check`,
`arch:check:negative` and `check:release-impact`. The catalog, proof and scenario checks cover the
full registered inventory on every run, and `check:error-observability` checks every `catch` in the
whole tree, never only a diff. Failure paths older than that check are listed in
`legacy-failure-path-register.json`, which may only shrink: a failure path outside it fails the
gate wherever it is, and an entry whose path is gone fails it too until
`node scripts/check-error-observability.mjs --prune-register` removes it. Required CI runs the gate
on every pull request.

## Redaction scope, stated honestly

Every field this log can carry passes through `redactLogFields` before it reaches disk. That
guarantee has an honest, stated limit, reused verbatim from the redaction test suite's own header
(`packages/keiko-server/src/observability/log-redaction.test.ts`) rather than restated in looser
words here:

> Scope, stated honestly: the guarantee is over CONTENT SHAPES (prose, markup/JSON, control
> characters, credential formats, filesystem paths, over-long strings), not over arbitrary short
> opaque tokens. A caller who base64-encodes a body into a 20-character identifier defeats any
> redactor, and no policy that still admits `errorCode: "INVALID_CAPSULE_PLAN"` can distinguish
> the two. Everything a real body, prompt, document or key actually looks like is covered.

Nothing in this log is ever a prompt, a response, document text, a secret, or an absolute
filesystem path that could carry an operator's username — only counts, closed-vocabulary labels,
hashes, and shapes.

## Joining lines across a request's lifecycle

Every successfully persisted v2 line carries `schemaVersion`, `registryVersion`, the schema and
catalog SHA-256 digests, `buildClass`, `releaseClass`, `platformClass`, `productVersion`,
`compatibilityState`, and `writerCapability`. The central sink stamps these fields; producers cannot
supply or override them. A current writer persists normal records only with the exact supported
schema/catalog identity and `supported`/`active` capability.

When validation or persistence fails, the file sink cannot promise to persist a notice about its own
failure. It instead attempts the existing independent body-free fallback chain: stderr first, then
`process.emitWarning`. The notice carries `incomplete`/`unavailable` and an explicit loss state, but
all three channels can be unavailable during the same failure. A later sequence gap can prove that a
write was attempted; after a hard kill or total channel failure, the exact count may be unrecoverable.
This is the loss ceiling, not a complete persisted-notice guarantee.

The line also carries `pid`, `instanceId` (8 hex characters, minted once per process start), and a
process-wide, monotonically allocated `seq`. Together, `(pid, instanceId, seq)` give
a **total order over persisted lines within one process lifetime**. The sequence may contain gaps
when an opening or write attempt fails, and the fallback channels attempt to provide the closed
classification; there is no true cross-process global order. Two different process lifetimes
each count `seq` from their own start, so a `seq` value from one process is not orderable against
the same `seq` value from another by the tuple alone. The wall-clock `ts` field is a best-effort
tiebreak hint only, never a guarantee, and should not be relied on to order lines across processes.

`keiko support analyze` validates the complete identity tuple. It distinguishes supported, legacy,
unsupported, corrupt, truncated, and incomplete evidence and reports
sequence gaps, duplicates, decreasing/reset values, and reorder deterministically for each
`(pid, instanceId)` lifetime. These states are evidence, not warnings to ignore: an unsupported or
incomplete input cannot be treated as a complete reconstruction.

For current-registry records the analyzer also validates the operation, category, exact flattened
field set, required fields, and closed error kind against the generated runtime schema. A complete
but unknown operation or extra field is corrupt evidence; an absent required field is incomplete
evidence; a mismatched registry/schema/catalog identity is unsupported.

### Closed evidence states

These values are the complete current vocabularies; readers reject additions until the versioned
contract, analyzer, and proofs change together.

| Dimension            | Closed values                                                                                | Meaning                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `completeness`       | `complete`, `partial`, `unknown`                                                             | All required evidence is present; a known subset is present; or completeness cannot be established.                                            |
| `loss`               | `none`, `event-dropped`, `event-location-unknown`, `publication-unavailable`                 | No known loss; a record was not persisted; durability/location cannot be proven; or a requested support publication could not be made durable. |
| `writerCapability`   | `active`, `degraded`, `unavailable`                                                          | The primary writer is fully usable; it has an explicit reduced capability; or the primary evidence path cannot write.                          |
| `compatibilityState` | `supported`, `legacy-supported`, `unsupported-version`, `corrupt`, `truncated`, `incomplete` | The writer's declared compatibility; the analyzer still validates the actual record and may lower trust.                                       |

### Compatibility and deprecation matrix

| Input on disk                                                                                                                    | Contract state / analyzer classification | Reader behavior                                                                                | Retirement rule                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete v2 identity, current registry/schema/catalog, `supported`/`active`                                                      | `supported`                              | Validate the registered operation, exact fields, vocabularies, bounds, and sequence integrity. | Supported for the current contract; a breaking identity or schema change requires a versioned compatibility change.                                                       |
| Parseable pre-v2 line with no v2 identity                                                                                        | `legacy-supported` / `legacy`            | Preserve it, order it by file position, count it, and emit one legacy warning.                 | Remove only when reviewed release-impact/support baselines and bounded retention prove no supported log can still contain such a line; remove reader/tests/docs together. |
| Unknown schema version or mismatched registry/schema/catalog identity                                                            | `unsupported-version` / `unsupported`    | Preserve the classification, but do not treat the record as trusted current evidence.          | No implicit upgrade or coercion; support requires the matching versioned contract.                                                                                        |
| Invalid JSON away from the terminal fragment, invalid types/ranges, or a current-registry record with an unknown operation/field | `corrupt`                                | Report the defect and exclude it from trusted reconstruction.                                  | Never reclassify as legacy merely because parsing partly succeeded.                                                                                                       |
| An unterminated terminal fragment or explicitly declared truncated evidence                                                      | `truncated`                              | Report truncation and keep the surviving evidence distinguishable from complete input.         | Retained as an explicit loss state; it is not silently normalized away.                                                                                                   |
| Partial v2 identity, missing required evidence, declared `incomplete`, or any non-`active` writer capability                     | `incomplete`                             | Report the missing capability/evidence and do not claim complete reconstruction.               | Becomes supported only after the producer emits a complete current contract; readers never synthesize the missing fields.                                                 |

The predecessor literal scanner is likewise migration-only. It may be removed only after every
production producer is represented by canonical typed registration/emission and authoritative
generation reports no legacy production dependency; remove the scanner, its compatibility tests,
and its documentation in the same change.

Cross-process (and cross-request) causality is instead established through two id fields:

- **`correlationId`** ties every line belonging to one logical operation together — one chat turn,
  one indexing job, one gateway call, one WebSocket session — across the UI, the BFF, the model
  gateway, and back.
- **`parentCorrelationId`** is set on a background operation (a harness run, a workflow event)
  spawned from a request whose id is already known, pointing back at the spawning request's
  `correlationId`. A top-level request has no parent. This is the mechanism for walking from "what
  the customer directly triggered" to "what that triggered in turn" — `correlationId` alone names
  only the current operation, not its ancestry.

Startup is an operation too: one server-bootstrap correlation joins persistent store migrations,
store and memory-vault opening, security/config resolution, gateway initialization, runtime
construction, and task-workspace composition. Detached startup work receives a fresh child
correlation plus the bootstrap id as `parentCorrelationId`. Process lifecycle lines remain
correlation-free and are joined by `(pid, instanceId, seq)`. In-memory/test stores are not wired to
the process sink by default, preventing fixture construction from appearing in the live product log.

Governed updates add two body-free join keys to those envelope ids: `candidateId` binds the exact
preflight offer to its confirmation and session, while `sessionId` binds lifecycle, recovery, and
remediation records after execution begins. `keiko support analyze --json` exposes the resulting
`updateAttempts[]` projection. Each attempt contains its ordered lines and every explicitly linked
request or background correlation id. The analyzer follows `parentCorrelationId` from a bound
request to child work, but never groups by target version, wall-clock proximity, or guessed install
facts. Candidate execution tokens, release-note prose, filesystem paths, and command output are not
update activity fields. Current events are written solely to the Activity Log in `logs/`; existing
`updates/update-audit.jsonl` files are retained historical data, not a second active writer or
recovery authority. Startup attempts a bounded schema-1 snapshot import after recovery/listen and
before `process.started`. Import uses the existing file sink, formatter, redaction and sequence;
records are explicitly historical, retain deterministic legacy identities, and have no invented
candidate/session/request links. A separate `update.runtime.legacy-snapshot-imported` record binds
the source digest, imported-ID-set digest and count after same-descriptor durability checks.

Import is deferred when info logging is filtered, input or destination checks fail, or durability
cannot be established. Non-filtered deferrals emit the closed reason through
`update.runtime.legacy-import-deferred` and a generic body-free stderr notice; startup continues.
Intentional level filtering remains silent. A fresh logging owner inspects and durably delimits an
unterminated current-log tail before retrying, without truncating or crediting the malformed record.
Limits are 1 MiB / 2,048 source events / 8,192 bytes per line and a scan of at
most 16 canonical log files / 32 MiB. The source is always retained: snapshot consistency does not
prove that every older writer has stopped. The current producer is retired; the compatibility
reader and source recognition expire together with updater runtime-state schema-1 migration,
when a reviewed release-impact/support-baseline change excludes every release capable of
writing that state or journal. The current [release-impact policy](../release/release-impact-runbook.md#catalog-rules)
still includes the `0.2.0` baseline, so no removal date or release is asserted. Remove the importer,
CLI startup seam, server exports, tests, operation-catalog entries and historical-input guidance
together at that policy boundary. Physical deletion additionally requires durable import of the
exact unchanged snapshot and exclusion of old writers, or an explicit reviewed retention decision;
the current importer has no deletion authority.
Sequential retries deduplicate deterministic identities; concurrent processes may leave duplicate
physical lines with the same identity, so this is not a cross-process exactly-once guarantee.
Historical records do not become a complete `updateAttempts[]` timeline when their original schema
lacks the required causal joins. The importer passed independent security review; current verification
and remaining limits are recorded in the [repair ledger](../qa/built-in-updater-repair-3405.md).

Read the log in this order for one failure:

1. Find the `correlationId` of the request the customer reported (the UI shows it, or the server's
   error response echoes it back in `X-Keiko-Correlation-Id` / `error.correlationId`).
2. Collect every line sharing that `correlationId` — this is one process lifetime's worth of a
   single logical operation, so `(pid, instanceId, seq)` orders them exactly.
3. Follow any `parentCorrelationId` you find back to the request that spawned it, and repeat.
4. For an error, read `errorKind` for the closed-vocabulary classification, and (when present)
   `extra.frames` / `extra.causeChain` for the dist-anchored Keiko-code stack — see
   [`reproduction-harness.md`](reproduction-harness.md) for how to read a frame against the exact
   product version that produced it.
5. For process-level events (`process.started`, `process.heartbeat`, `process.exiting`), which
   carry no `correlationId` and so never belong to a per-correlation timeline, read
   `keiko support analyze`'s `processes[]` summary instead, keyed by `(pid, instanceId)`.
6. Before you trust an absence, read that process's `activity-log.readiness` and
   `activity-log.loss` lines. A missing line during a period with a non-zero loss count is lost
   evidence, not proof that nothing happened.

## Worked example: `keiko support analyze`

Given one raw Activity Log file (a segment or a legacy file from `<stateDir>/logs/`) or a full
support bundle from `keiko support export` (the analyzer auto-detects either), reconstruct the
timeline for one correlation id. An operation that spans several segments is complete only in the
bundle, which joins every file in logical order:

```bash
keiko support analyze .keiko/logs/activity-20260821T090000000Z-4242-bbbbbbbb-000001.jsonl --correlation-id 3f9a2b7c-1e44-4d21-9a02-6b1c9e0a5f31
```

```text
Analyzed log: /workspace/.keiko/logs/activity-20260821T090000000Z-4242-bbbbbbbb-000001.jsonl
State directory: /workspace/.keiko
Source: raw-log
Newest event: 2026-08-21T09:14:02.901Z
Newest instance: bbbbbbbb
Freshness: current
Process activity: apparently-active

correlationId=3f9a2b7c-1e44-4d21-9a02-6b1c9e0a5f31 lines=4 durationMs=812
  2026-08-21T09:14:02.118Z 118 info http request [812ms]
  2026-08-21T09:14:02.204Z 119 info gateway gateway.chat.started
  2026-08-21T09:14:02.887Z 121 error gateway gateway.chat.failed [GATEWAY_RATE_LIMIT] [683ms]
  2026-08-21T09:14:02.901Z 122 info http request [812ms]
```

Each line orders by `seq` (the second column) within the process lifetime that wrote it — never
by file position, for a v2 line. Reading top to bottom: the request line opens the timeline, the
gateway call starts, the gateway call fails with a rate limit, and the request line's own record
closes it out. `--json` emits the same reconstruction as a machine-readable `LogTimeline`
(`lines`, `firstTs`, `lastTs`, `durationMs`, `errorKinds`, and — when any line in the timeline
carried them — `frames`) instead of the human-rendered form above; omitting `--correlation-id`
prints every timeline found in the file, plus the file-wide `processes[]`/`legacyLineCount`/
`warnings` summary described above.

The context header is part of the diagnostic contract, not decoration. For a raw
`<state-dir>/logs/server*.log`, it reports the resolved input path and inferred state directory,
the newest valid event timestamp, the instance id from the newest valid process observation, and a
freshness/process-activity assessment. A raw log more than five minutes old — five expected
heartbeat intervals — is marked `stale` and `inactive` with a machine-readable warning, so an old
checkout log is not mistaken for the running instance. A fresh log is only
`apparently-active` when its newest process has not recorded an exit and that PID still exists;
otherwise the analyzer says `inactive` or `unknown`. Support bundles are historical artifacts, so
their process activity is `not-applicable`. Missing or invalid observations remain `not reported`/
`unknown`; file mtimes and guessed instance ids are never substituted.

A line successfully parsed but missing the full `(pid, instanceId, seq)` triple is a **legacy
line** — one written before this envelope shipped, in a retained legacy `server.log` or
`server-YYYY-MM-DD.log` file.
It is never dropped or misordered; it is ordered by its own file position, counted in
`legacyLineCount`, and named in exactly one `warnings[]` entry when that count is nonzero. Treat
that warning as an instruction to read the file position ordering with less confidence for those
specific lines, not as a defect.

Epic #3384's repository-delivery journey (intake, mutation authority, verified commit, push, draft
PR, CI readiness — including the `pr-mark-ready` draft-to-ready transition (#3389) — description
generation/apply, and the recorded journey outcome) reconstructs on the same per-correlation
timeline as every other operation — `git.delivery.*` (including
`git.delivery.pr-mark-ready.approval.required`/`.minted`/`.executed`/`.drift`),
`git.pr-description`/`git.pr-description.receipt`, `pr-description.chat.turn.admitted`/`.denied`
(Chat's own description-generation admission gate ahead of the Model Gateway),
`coding-runtime.description` (the server-side automatic-description dispatch lifecycle — dispatched,
coalesced, superseded, blocked, generated, failed — named in its own `event` extra field),
`git.journey-observation`/`git.journey-outcome.recorded`, `coding-context.github*` and
`git-change.chat.*` lines simply appear on it like any other line, and `--clusters` groups them the
same way. `keiko support
analyze --seed --correlation-id <id>` additionally assembles an `issueToPrJourney` view onto the
`ReproductionSeed`: one step per recognised line, tagged with a closed `phase`
(`intake`/`authority`/`commit`/`push`/`pr`/`readiness`/`description`/`outcome`) and carrying the
emitter's own `status`/`reason` and the digest/id fields (`runId`, `headSha`, `evidenceRef`,
`snapshotDigest`, …) a replay needs — every value copied verbatim off the producer's own
closed-vocabulary `extra`, never invented. Each step's fields are read back through the SAME
`redactLogFields` choke point the activity-log sink itself writes through; a line whose `extra`
carries a body-bearing value under an otherwise-innocuous name is reported by field name under that
step's `redactionViolations` and withheld from the seed instead of rendered, and a `redactionVerified:
false` step (no redactor supplied) carries no content fields at all rather than trusting an
unverified line.

## Local support incidents

Keiko keeps a small, local list of incident candidates, so the evidence of a failure is still there
when someone looks at it. Nothing is ever sent anywhere; a candidate only protects and describes
evidence that is already in the Activity Log.

A candidate is created in two ways:

- **Automatically.** An event logged at level `error` whose operation the registry declares with the
  `failure` lifecycle and at least one supported failure class creates one. There is one open
  automatic candidate per defect fingerprint; a recurrence is logged as
  `support.incident.deduplicated`. Each process evaluates at most one failure per fingerprint every
  60 seconds and at most six per minute.
- **By you.** `keiko support incident report` records a problem Keiko did not detect. It needs no
  failure event; every report is its own occurrence.

Each candidate pins the Activity Log from 15 minutes before to 5 minutes after the incident, across
every process, including segments sealed later in that window. For the automatic trigger, that pin is
published synchronously in the same turn as the failure that caused it, before any later maintenance
pass — this process's own next segment admission, or another process sharing the state directory —
can run against the window. The pin expires with the candidate after 14 days; it is released by
`dismiss`, and also when a duplicate or a rejected candidate finds it no longer needs the window its
trigger pre-published. It holds only within `KEIKO_LOG_PIN_QUOTA_BYTES`; the candidate shows
`pinned`, `quota-exceeded` or `rejected`, plus `evidenceLostBeforePin` when a sealed segment inside
the window was already gone by the time the pin actually covered it.

| Command                               | What it does                                                 |
| ------------------------------------- | ------------------------------------------------------------ |
| `keiko support incident list`         | Lists the open candidates.                                   |
| `keiko support incident preview <id>` | Shows the public projection: the fields safe to share.       |
| `keiko support incident show <id>`    | Adds the private, still body-free fields for local analysis. |
| `keiko support incident report`       | Records a problem you noticed.                               |
| `keiko support incident dismiss <id>` | Deletes the candidate and releases its pin.                  |

Every command accepts `--state-dir` and `--json`. Exit codes: `0` success, `1` not found, rejected
or window not resolvable, `2` usage error.

- **Identifiers.** `incidentId` is 128 random bits and names one occurrence. `defectFingerprint` is a
  versioned SHA-256 over the owning surface, the operation, the closed `errorKind` and the normalized
  Keiko module frames. It contains no line, column, build, time, process, host, user or path value,
  so the same defect groups together across builds. Defects that are indistinguishable by those
  inputs share a fingerprint by design.
- **Sufficiency.** A candidate reports `complete`, `degraded` or `insufficient` with closed reasons,
  from the same projection `keiko support analyze` uses. A report whose window holds no registered
  failure is `insufficient` with `no-registered-failure`: an instrumentation gap, never a complete
  record.
- **Store.** Candidates live in `<stateDir>/support-incidents/` (owner-only), one
  `incident-<32 hex>.json` of at most 4 KiB each. At most 32 are open, at most 24 of them automatic,
  so explicit reports always have room. A full store rejects the new candidate
  (`support.incident.rejected`) and never evicts an existing one. Candidates expire after 14 days
  (`support.incident.expired`).

## Querying the log and selective export

`keiko support query` answers a question about the Activity Log of one state directory without
loading the log. It reads line by line and keeps only what it selects, so a long history needs
bounded memory. There are two kinds of question:

- **A causal closure.** `--correlation-id`, `--incident` or `--defect-fingerprint` selects one
  operation and everything causally connected to it: every ancestor reached over
  `parentCorrelationId` and every descendant, such as a background job the request started.
  Unrelated correlations, siblings included, are never selected. A narrow context is added: the
  uncorrelated process signals (lifecycle, resource, loss, backpressure, disk) of the same process
  lifetimes, within `--context-ms` (0 to 600000, default 5000) of the closure. An incident or
  fingerprint is resolved through the local support incidents. A reported incident also selects its
  whole pinned window and treats every correlation in it as a root. The three selectors exclude each
  other and do not combine with the event filters.
- **Matching events.** `--parent-correlation-id`, `--op`, `--error-kind`, `--failure-class`, `--from`
  and `--to` select single events and combine with AND. An operation, error kind or failure class
  must be one the registry declares.

| Command                                      | What it does                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `keiko support query --correlation-id <id>`  | Prints the causal closure of one operation.                            |
| `keiko support query --incident <id>`        | Prints the causal closure of an incident.                              |
| `keiko support query --op <op> --from <iso>` | Prints the matching events.                                            |
| `keiko support export --correlation-id <id>` | Writes a report with only that closure.                                |
| `keiko support manifest rebuild`             | Derives every segment manifest again and replaces the stored one.      |
| `keiko support manifest verify`              | Derives them without writing and reports stored manifests that differ. |

`keiko support export` also takes `--incident` and `--defect-fingerprint`. The `query` and
`manifest` commands accept `--state-dir` and `--json`. Every result states exactly one diagnostic
sufficiency, `complete`, `degraded` or `insufficient`, with closed reasons, from the same projection
`keiko support analyze` uses. `--json` prints the versioned machine form (`keiko.support.query`,
schema version 1): the provenance (product version, registry version, schema and catalog digests,
manifest schema version), the segments read and skipped, the closure's correlations and edges, and
the integrity, coverage, loss and truncation of the selection. The human output is derived from it.

- **Nothing required is cut to fit.** `--max-bytes` (default 16 MiB) bounds the selection. A closure
  that does not fit returns no events and is `insufficient` with `report-budget-exceeded`. Only the
  optional context may be dropped, and that is declared as `context-truncated` (`degraded`). A
  selection whose evidence retention already removed, or that was never written, is `insufficient`
  with `evidence-not-retained`; a candidate segment that cannot be read makes it `insufficient` with
  `segment-unreadable`. Selective export follows the same rule: a selection that does not fit its
  `--max-bytes` or cannot be found writes nothing, and the command exits 1. The report's manifest
  line states the selection and its sufficiency.
- **Exit codes.** `query` exits `0` when it printed a result, whatever its sufficiency; `1` when the
  selection cannot be resolved, the log cannot be listed, or the query's own evidence cannot be
  written; `2` on a usage error. `manifest rebuild` exits `1` when a segment cannot be read or a
  manifest cannot be written. `manifest verify` exits `1` when a stored manifest differs from its
  segment or a segment cannot be read. A segment that has no manifest yet is not an error: the next
  query builds it.
- **Manifests.** Each sealed segment has a derived, rebuildable manifest in
  `<stateDir>/activity-log-manifests/` (owner-only), one `manifest-<segmentId>.json` of at most
  256 KiB. It holds safe metadata only: the time, process and sequence ranges, the registered
  categories, operations, error kinds and failure classes with counts, the loss and integrity
  state, a Bloom filter over correlation ids (hash bits only), and a SHA-256 digest. A query uses it
  to skip, without opening it, a segment that cannot match. A manifest is computed from the
  segment's bytes and the build's catalog alone, so a rebuild reproduces it byte for byte. The
  Activity Log writer never writes one: query, export and rebuild do, and they remove the manifests
  of segments retention has deleted. A missing, torn or stale manifest is rebuilt, and deleting the
  directory is always safe.
- **Bounds.** Reads use one 64 KiB buffer and hold at most one line of up to 1 MiB. A closure holds
  at most 4096 correlations, a result at most `--max-bytes`. The correlation filter uses about 10
  bits per key (roughly 1% false positives), at most 128 KiB. A checked-in long-history test builds
  80 MiB of history in 40 sealed segments and runs the built command under a 112 MiB heap cap. Peak
  resident memory may grow by at most 32 MiB over the same command on an empty state directory, and
  instrumented reads prove that segments the manifests rule out are never opened. Measured on macOS
  arm64 with Node 24: the empty-state baseline takes 0.94 s, of which about 0.93 s is loading the
  server modules; a cold query that builds all 40 manifests takes 2.1 to 2.5 s; a warm query takes
  1.1 to 1.2 s and opens 3 segments (two hold the closure, one is a filter false positive). Peak
  memory grew by at most about 7 MiB over the baseline.
- **Versioned output.** `--json` forms name themselves and their version: `keiko.support.query`,
  `keiko.support.manifest`, the stored `keiko.activity-log.segment-manifest`, and the export
  manifest line's `selection` member, `keiko.support.export-selection`, all at version 1.
  `keiko support analyze --json` now carries `kind` and `schemaVersion` as well:
  `keiko.support.analyze` for every timeline and `keiko.support.analyze-timeline` with
  `--correlation-id`, both at version 1. Every field the earlier output had is unchanged, so an
  existing reader such as `keiko investigate --from-timeline` keeps working; `--seed` already
  carried `schemaVersion`. `--clusters --json` still prints the same bare, unversioned array
  byte-for-byte — no existing reader breaks — but it is deprecated: every use prints a one-line
  stderr notice naming its versioned replacement, the `clusters` member `keiko.support.analyze`
  (schema version 1) now carries under plain `--json`, which holds exactly the same data inside a
  versioned envelope.
- **Analyze streams too.** `keiko support analyze` reads its file through the same bounded line
  reader, including for `--seed` and `--emit-fixture`. A seed's `sourceArtifact.sha256` is the
  SHA-256 of the file's bytes, the value `shasum -a 256` and a report's `.sha256` file state.
- **Evidence.** `support.query.completed`, `support.query.failed` and `support.manifest.rebuilt`
  record the query class, candidate and result counts, selected bytes, truncation, integrity and
  loss, never the query text, an event body, a name or a path.

## See also

- [ADR-0173](../adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md) — the full
  design record: why each envelope field is reserved, the ordering guarantee's exact limit, the
  redaction escape hatches, and the support-bundle format.
- [`reproduction-harness.md`](reproduction-harness.md) — turning one correlation id's evidence into
  a red-then-green regression test.
- [Troubleshooting guide](../troubleshooting/README.md) — the `logs/` row in the
  "Log locations and debug mode" table, alongside the other operator-facing log files.
