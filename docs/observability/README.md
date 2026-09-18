# Observability: the server activity log

Keiko configures one operator-readable activity log for every local install. `KEIKO_LOG_LEVEL`
controls its threshold and can explicitly disable writes with `silent`; a silent interval has no
reconstruction evidence and must not be interpreted as an active writer. This page documents the
log itself, how its lines join together across a request's lifecycle, and how to read it with
`keiko support export` / `keiko support analyze`. It is the consumer-facing counterpart to
[ADR-0173](../adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md), which records
the design decisions behind everything described here.

## File location, daily rotation, and retention

Normal runtime activity lives at `<stateDir>/logs/server.log` — `<stateDir>` is `./.keiko` by
default, or wherever `--state-dir` / `KEIKO_STATE_DIR` points. Commands that must audit or remove
that selected tree write their own lifecycle evidence to a fixed per-user CLI control-state log:

| Platform | CLI control-state log                                         |
| -------- | ------------------------------------------------------------- |
| Linux    | `~/.local/state/keiko/control/logs/server.log`                |
| macOS    | `~/Library/Application Support/Keiko/control/logs/server.log` |
| Windows  | `%USERPROFILE%\AppData\Local\Keiko\control\logs\server.log`   |

The control path accepts no environment override and may not be at or below the selected audit or
uninstall target. `keiko audit local-state` therefore cannot mutate the forensic tree it reads, and
`keiko uninstall --state` cannot delete or asynchronously recreate the store that holds its own
result. If the primary control root overlaps the target or cannot be validated or opened, the
command emits a body-free terminal refusal before any sink opens. It does not create an independent
fallback log root inside an unproved trust boundary. A control-state `server.log` can be passed
directly to `keiko support analyze`.

One correlation id joins install-layout normalization to audit or uninstall start, subordinate
forced-stop activity, and completion/failure. Audit and uninstall events carry SHA-256 identities
for their selected targets instead of paths. Uninstall also logs dry runs and scripts-only work, and
its completion records the state disposition plus body-free affected and retained counts.

Each log is JSON Lines: one `JSON.stringify`-serialized object per line, written synchronously so
that the last line on disk before a hang or a crash is the last line the process actually reached.

When a state directory is configured, failure to create or open its log directory aborts startup
with a closed safe-artifact error. Keiko never silently substitutes a null sink for a configured
activity log; an in-memory/null sink exists only where a caller explicitly selected one, such as a
unit-test composition without a state directory.

At the first write after each UTC day boundary, Keiko seals the finished current file as exactly one
`server-YYYY-MM-DD.log` archive and opens a fresh `server.log`. The default retention window is
seven dated archives; an explicitly configured positive `retentionDays` value replaces that default.
Pruning recognizes only real calendar dates in the closed archive grammar and never deletes a
lookalike, backup, stage, or unrelated file.

The filesystem boundary is the operating-system user. The selected state and log directories must
be owner-matched, non-redirected, and owner-only (`0700` on POSIX; the selected owner's inherited
ACL on Windows). Keiko rechecks their device/inode identity around every link, rename, and unlink.
Before retention removes an archive, an opened handle must prove that the target is a regular,
owner-matched, private, single-link file and still names the checked pathname.

Cross-process rotation uses a hard link to publish the dated destination without replacement:
`EEXIST` means another process won, and the loser preserves that archive. Only errors that state the
filesystem does not support hard links permit the guarded rename fallback. A failed, unsafe, or
ambiguous mutation leaves evidence in place and never escapes into the caller.

`server-log.rotation` records the closed `persistenceStatus`, `rotationReason`, `archivedCount`,
`retentionStatus`, `prunedCount`, and `retainedCount`. A mutation failure is a body-free
`durability-failed` event with partial completeness; paths and filenames never enter the event.

There is a documented residual same-user race: Node has no portable descriptor-relative
link/rename/unlink API, and the rename fallback cannot make a no-replace promise on filesystems that
lack hard links. A process already running as the same OS user can act between pathname checks. The
implementation narrows that window with owner-private directories, held directory/file handles,
pre/post identity checks, and the non-replacing hard-link winner. This residual risk does not justify
removing or postponing bounded retention.

As an additional non-mutating capacity safeguard, the sink emits one correlated
`server-log.capacity-warning` when the current file reaches 256 MiB. The line reports only the
observed byte count, threshold, `operatorAction: "stop-export-replace"`, and
`mutationStatus: "not-attempted"`; it does not rotate, truncate, rename, or delete anything. To
recover capacity safely:

1. Stop every Keiko process using the state directory.
2. Run `keiko support export --state-dir <stateDir> --out <path-outside-stateDir>` and retain both
   the export and its integrity sidecar.
3. With all writers still stopped, verify `logs/server.log` is the expected regular, single-link
   file, then move it intact to an operator-controlled archive outside `logs/`. Never truncate or
   replace a live descriptor.
4. Restart Keiko so the guarded sink creates a new `server.log`; retain the archived original until
   the applicable evidence policy permits disposal.

Immutable byte-bounded segments may replace daily files later, but the daily retention bound remains
active until the replacement is complete on the same revision.

## Log level

`KEIKO_LOG_LEVEL` gates volume, not content: an event below the configured threshold returns
before any string or JSON work happens at all, so a quiet level is also the cheap one. Accepted
values are `debug`, `info` (the default when unset or unrecognized), `warn`, and `error`, plus the
threshold-only `silent` to turn the log off entirely. A handful of common aliases are also
accepted (`trace`/`verbose` → `debug`, `warning` → `warn`, `fatal`/`critical` → `error`,
`off`/`none` → `silent`); a typo falls back to `info` rather than crashing the process or silently
disabling the log the operator is trying to read.

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
update activity fields. Current events are written solely to `logs/server.log`; existing
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

## Worked example: `keiko support analyze`

Given a raw `server.log` (or a full support bundle from `keiko support export` — the analyzer
auto-detects either), reconstruct the timeline for one correlation id:

```bash
keiko support analyze .keiko/logs/server.log --correlation-id 3f9a2b7c-1e44-4d21-9a02-6b1c9e0a5f31
```

```text
Analyzed log: /workspace/.keiko/logs/server.log
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
line** — one written before this envelope shipped in the current file or a compatible legacy
`server-YYYY-MM-DD.log` archive retained by the bounded daily-rotation implementation.
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

## See also

- [ADR-0173](../adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md) — the full
  design record: why each envelope field is reserved, the ordering guarantee's exact limit, the
  redaction escape hatches, and the support-bundle format.
- [`reproduction-harness.md`](reproduction-harness.md) — turning one correlation id's evidence into
  a red-then-green regression test.
- [Troubleshooting guide](../troubleshooting/README.md) — the `logs/server.log` row in the
  "Log locations and debug mode" table, alongside the other operator-facing log files.
