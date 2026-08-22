# ADR-0173: Server activity log v2 — a machine-reconstruction contract for autonomous defect triage

## Status

Proposed (Epic #3233, Wave 1, 2026-08-21).

Wave 1 of a seven-wave plan. This ADR is drafted before the implementation lands and finalized
(Proposed → Accepted) in Wave 6, once the described contract exists in full. Sections below name
which decisions are already load-bearing in Wave 1 and which are forward references to later waves.

## Context

`<stateDir>/logs/server.log` (JSON lines, day rotation, 7-day retention, `KEIKO_LOG_LEVEL`-gated,
always on) shipped in #3230. It made activity evidence exist at all: before it, a customer's stuck
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

`ServerLogEvent` gains four fields, additive only — no existing field is removed or retyped:

- `schemaVersion: 2` — a literal constant, bumped only on a breaking format change to the line
  shape itself. Lets a consumer (the analyzer, or a human) branch on wire format without probing
  for field presence.
- `pid: number` (`process.pid`) — reserved because it is cheap, universal process identity, but
  **not sufficient alone**: operating systems reuse pids across restarts, so two distinct process
  lifetimes can share a `pid` within one rotated, multi-day log file.
- `instanceId: string` — 8 lowercase-hex characters sliced from one `randomUUID()` call made once
  per process start. Reserved specifically to close the gap `pid` alone leaves: `pid` **and**
  `instanceId` together, not `pid` alone, is the process-identity join key an agent uses. Neither
  field is a secret or customer-derived value, so reserving them costs nothing on the redaction
  side.
- `seq: number` — allocated from one module-level counter shared by every `ActiveLog` in the
  process (not one counter per resolved log directory), so a process writing to more than one
  state directory still stamps one gap-free sequence, never two independently-numbered ones.
  Survives day rotation and every `ActiveLog` reinitialization; resets only on process restart.
  Reserved because it is the ordering primitive (D2) — if a caller could set `extra.seq`, ordering
  claims would be forgeable.

All four join the existing reserved set (`ts`, `level`, `category`, `op`) in
`RESERVED_FIELD_NAMES`, so `redactLogFields` strips a same-named `extra` key before assignment —
identical to how the four pre-existing reserved fields already cannot be spoofed today. This is a
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

**"Gap-free" means every claimed `seq` is accounted for, not that every claimed `seq` reaches disk —
and that accounting is delivered on the next notice or at shutdown, never guaranteed against every
possible exit.** A `seq` value is claimed in `createFileSinkFacade.write` — before the write it
numbers is attempted — and is never rolled back if that write then throws; this is claim-before-write
by design, not an oversight. Two callers racing the same failure must not both observe the same
pre-failure counter value and then both claim the number that follows it, silently reusing a sequence
number for two different lines — a missing number is the strictly safer failure than a repeated one.
A gap in the `seq` sequence therefore marks a line the sink attempted to persist and could not, and is
not silently lost on a clean exit: `reportServerLogFailure` emits a throttled, independent-channel
stderr notice (`server-log.write-failed`) whose `suppressedNotices` count accounts for the failed
writes a gap represents, so the throttle hides the failure's *repetition*, never its *scale*. That
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
ceiling, not a stronger one: if the file sink, the stderr notice, *and* the `process.emitWarning`
fallback are all unavailable in the same instant (for example, stderr is gone and nothing in the
process is listening for `'warning'`), the notice is lost — three independent channels are not an
infinite one. The `seq` gap itself still marks that a write failed even then; only the *count* of how
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
  request that triggered it. A rate-limited call always carries `httpStatus` (429) on that same
  line, so an agent reconstructing the failure never has to infer the HTTP status from the error
  class alone; `retryAfterMs` is present on the same line only when the provider itself supplied a
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

`parentCorrelationId` reuses the existing `isValidCorrelationId` shape guard; it is not a new trust
boundary, and browser-supplied values are never accepted as authoritative without server-side
validation — the same posture that already governs `correlationId`.

### D6 — The op catalog is a generated, drift-tested closed vocabulary, not a compile-time union

`op` stays a plain `string` at the type level: a compile-time closed union across dozens of scattered
call sites in six-plus packages would be unmaintainable churn, and `route-template.ts` already makes
the same choice for path segments. Closure is enforced by generation instead: a script walks every
package's source for a literal `op: "..."` inside a category-bearing log-event object, writes a
checked-in catalog (`op`, `category`, `package`, call site), and a drift test regenerates in memory
and asserts exact equality against the checked-in file — the same "derive, don't hand-maintain, pin
with a drift test" pattern `route-template.test.ts` already runs.

A companion dev-time shape check asserts every extracted `op` literal matches a fixed naming
pattern. This runs at generation/CI time **only** — never in the runtime request path. A bad `op`
string fails the build; it never silently substitutes a marker for a real value at runtime, and it
never adds a hot-path validation cost to logging itself.

**Unresolvable `op` expressions are recorded, not treated as a build failure.** A small,
enumerated set of positional logging helpers (`POSITIONAL_OP_HELPERS`) forward an `op` value they
receive as a parameter one layer down into the real event call — a closure argument, a re-thrown
failure context, a caller-supplied `ServerDiagnosticRecord.operation` — rather than minting a new
vocabulary member of their own. The generator cannot statically resolve that kind of expression to
a literal, and it does not guess: it records a `<dynamic>` catalog entry naming the call's own file
and line, pinned byte-for-byte by the drift test exactly like every literal entry, so the site
stays visible in the checked-in catalog rather than silently vanishing or being fabricated. This is
sound only because it is paired with a closure obligation: every caller that hands such a helper an
`op` value must itself pass a literal, which the generator resolves and catalogs at *that* call
site — the vocabulary is closed at the literal's origin, not at the forwarding helper. A `<dynamic>`
entry at a helper is therefore never the last word on what operation ran; it is a pointer to go read
the actual call sites, all of which are separately, statically cataloged. Failing generation on
these forwarding sites would make the generator unconditionally unable to run on unmodified, correct
source, for no closure benefit the per-caller literal requirement does not already provide.

### D7 — Process lifecycle events give the log a subject

Before this contract, the log recorded what happened but never which process, running which
version, configured how. `category: "process"` events close that gap: `process.started` (node
version, platform, arch, product version, install mode, host, port, resolved log level, a
closed-union `stateDirSource` label — never the raw state-dir path, which can embed an OS username
that the existing path guard exists to refuse), `process.heartbeat` (memory and event-loop-delay
gauges on an `unref()`'d interval that never keeps a one-shot CLI command alive and is cleared on
every shutdown branch), and `process.exiting` (reason, uptime), which closes the log descriptor
cleanly on every real shutdown path using the sink's own close function — already built, but dead in
production until this wave wires a real shutdown path to call it.

Configuration identity (`process.config` at process start; a gateway-specific
`gateway.config.resolved` line once `GatewayConfig` is assembled) is deliberately split across the
wave that has the cheap fields in scope and the later wave that has the gateway-specific ones, so
neither wave's diff stubs fields it cannot honestly populate yet. Feature flags are an explicitly
named, out-of-scope-for-this-epic follow-up.

### D8 — The support artifact is one JSON-Lines file; `ui.log` is excluded by default

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

**`ui.log` is excluded by default.** That channel is a verified, acknowledged-unredacted operator
stream (`${error.name}: ${error.message}`, raw). A customer-facing export tool that blends a
redacted structured stream with an unredacted free-text one in the same artifact would undermine the
body-free contract by construction. `ui.log` is therefore always listed in the manifest's
`sectionsExcluded`, with an explicit `--include-ui-log --i-understand-this-is-unredacted`
double-confirmation flag (both flags required together) for an operator who has made an informed
decision to attach it anyway. The manifest always records whether it was included — never silently.
This opt-in gate is not removed once the fatal-crash-path fix (D3's neighbor, Wave 2) stops new
`ui.log` lines from carrying raw messages, because a bundle exported later can still be exported
against a `stateDir` whose history predates that fix.

**Size bounds.** Capped at the sink's own retention window, further capped by an overall byte
ceiling; files are dropped oldest-first when the ceiling is exceeded, and every drop is recorded in
the manifest's `truncatedLogFiles` — never silent.

### D9 — CLI surface: `keiko support export` and `keiko support analyze`

Two new commands under one `support` command family (not `bundle export` / `log:analyze` — a single
coherent noun groups the artifact producer and its own consumer under one verb space):

- `keiko support export [--out PATH] [--state-dir PATH]` composes only existing, already-hardened
  pieces in Wave 1's minimal form: the evidence index listing, the audit summary, and a plain
  read-and-concatenate of the rotated log files. No new redaction logic is written for the bulk of
  the file — every line copied in is a line that was already redacted at write time.
- `keiko support analyze FILE [--correlation-id ID] [--json]` reconstructs two complementary views
  from the same parsed lines, because `correlationId` alone cannot carry everything Wave 1 needs to
  reconstruct: a **per-correlation timeline** for every line that carries a `correlationId`, ordered
  within one process lifetime by `seq` and across lifetimes by first file-position (D2); and a
  **per-process-lifetime summary** (`processes[]`, keyed by `(pid, instanceId)`) built from every
  line carrying the full v2 identity triple regardless of `correlationId`, so the lifecycle events
  D7 introduces (`process.started`/`process.heartbeat`/`process.exiting`, which carry no
  `correlationId` and so belong to no timeline) are still reconstructable — first/last `seq`,
  first/last `ts`, line count, and the `process.started`/`process.exiting` payloads when seen. The
  analyzer also reports `legacyLineCount` — lines it parsed successfully but that are missing the
  full identity triple — and a `warnings[]` entry naming that count when it is nonzero, so the
  admission that some lines fell back to file-position ordering is machine-readable rather than a
  silent omission. Separately, `malformedLineCount` counts lines that could not be read as a log
  record at all (not valid JSON, or valid JSON missing `ts`/`category`/`op`) — evidence of
  corruption, never conflated with a legacy line, which parses cleanly and is merely missing the v2
  identity triple. `--json` emits all of this in Wave 1; the fuller analyzer output (stack-frame
  unions, gateway replay scripts, a reproduction-seed fixture emitter) is Wave 6 scope, once the
  fields it reads exist. Among those fields: a rate-limited call always carries `httpStatus` (429),
  so a replay script's rate-limit attempt never has to infer its HTTP status from the outcome
  discriminant alone; `retryAfterMs` rides along on the same line only when the provider supplied
  one, with no synthesized fallback.

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
`server.log` keeps a 7-day retention window (#3230), so a log file spanning the upgrade to this
contract can still hold lines written before `seq`/`schemaVersion` shipped: valid, successfully
parsed log records with no `pid`, `instanceId`, or `seq` field to order by. D9's exporter copies
these verbatim (D8's "one JSON-Lines file" format applies uniformly; there is no schema-aware
filtering at export time), so the analyzer must define what happens to them rather than silently
dropping or misordering them. The compatibility rule: a retained pre-v2 line is never discarded and
never treated as malformed — it is ordered by its own position in the file (the same signal used to
rank process lifetimes against each other, D2), counted in `legacyLineCount`, and surfaced through
exactly one `warnings[]` entry when that count is nonzero. This is a stated, bounded compatibility
window, not a permanent second ordering path: once a log file's 7-day retention has rolled fully
past the upgrade, no pre-v2 line can appear in it again.

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
  override), so nothing is lost. Its integrity sidecar (a `sha256` file alongside the bundle, Wave
  6) exists because the
  bundle crosses a real trust boundary — customer machine → support ticket → agent — the same
  boundary ADR-0048's confidentiality tiers were written to reason about.

## How an agent reads the log

This section is the operational summary of the join keys this ADR defines, stated once in one place
rather than left implicit across the Decision section:

1. **Within one process lifetime**, order every line carrying the full v2 identity triple by
   `(pid, instanceId, seq)` — exact, gap-free (in the sense D2 defines: every claimed `seq` is
   accounted for, whether or not its write landed), guaranteed (D2). A retained pre-v2 line carries
   no such triple; it is ordered by its own file position instead, counted in `legacyLineCount`, and
   never treated as belonging to a process lifetime (D10).
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
7. **For what could not be reconstructed**, read the analyzer's `warnings` array rather than assuming
   silence means nothing happened — Wave 1 already populates it with exactly one entry naming
   `legacyLineCount` when a retained pre-v2 line is present (D10); Wave 6 extends the same array with
   further evidence-gap classes (stack-frame unions, gateway replay scripts, and other later-wave
   evidence). A warning names exactly what evidence class is missing and why, so an agent's report to
   a human names the actual gap instead of guessing.

## Consequences

- A customer support ticket, from Wave 1 onward, already carries a deterministically orderable
  artifact — the sequencing decision in D10 means no wave has to build and then retire a fallback
  heuristic for any v2 line.
- The ordering guarantee is honestly bounded (D2): an agent that assumes cross-process global
  ordering from the envelope alone is reasoning outside what this contract promises, and must fall
  back to `correlationId`/`parentCorrelationId` for cross-process causality. Within a process,
  `(pid, instanceId, seq)` uniqueness holds across every log directory that process writes to,
  because `seq` is allocated from one process-wide counter (D1), never one scoped per directory.
  "Gap-free" is a claim about accounting, not delivery: a gap marks a write the sink attempted and
  could not persist, and the throttled stderr failure notice's `suppressedNotices` count accounts
  for exactly those gaps (D2).
- Retained pre-v2 log lines are a real, bounded compatibility case, not an oversight: a line written
  before this contract shipped can still appear in a log file inside the sink's 7-day retention
  window. The analyzer never drops or misorders such a line — it orders it by file position, counts
  it in `legacyLineCount`, and surfaces exactly one `warnings[]` entry naming that count (D9, D10).
  An agent must read `warnings[]` before trusting that every line in a bundle came from an ordered
  v2 process lifetime.
- Process lifecycle events (`process.started`/`process.heartbeat`/`process.exiting`) carry no
  `correlationId` and so never enter a per-correlation timeline; the analyzer's `processes[]`
  summaries (D9) are the reconstruction path for them, keyed by `(pid, instanceId)` rather than by
  operation.
- The no-source-maps decision (D3) means reading a frame meaningfully requires building the exact
  tagged version the customer ran; this is a documented, deliberate cost, not a gap to be quietly
  worked around by enabling source maps later without amending this ADR.
- `ui.log`'s default exclusion (D8) keeps the body-free contract intact by default, at the cost of
  an operator needing an explicit double-confirmation flag for the (rare, informed) case where they
  want it included anyway.
- The op catalog's closed vocabulary (D6) is enforced at the literal's origin, not at every
  forwarding call: a positional helper that cannot be statically resolved to a literal is recorded
  as `<dynamic>` at its own call site rather than failing generation, on the condition that every
  caller supplying that helper an `op` is itself a literal the generator catalogs separately. A
  `<dynamic>` entry is a pointer to those call sites, never the last word on what operation ran.
- The `ERROR_KIND_PATTERN` relocation (D11) deleted `error-kind-pattern-drift.test.mjs` and replaced
  it with the stronger `error-kind-pattern-single-source.test.mjs` pin as part of making its invariant
  structurally unbreakable; this ADR is the documented justification a reviewer checks that deletion
  against, and no later change may cite this ADR to justify a second copy reappearing.
- This ADR is Proposed, not Accepted, because Waves 3 through 6 have not landed yet. A reader relying
  on this document today should treat the op catalog's fully finalized vocabulary (D6), D8's full
  manifest shape, and D9's fuller analyzer output (stack-frame unions, gateway replay scripts, a
  reproduction-seed fixture emitter) as forward references until the corresponding wave merges. D1,
  D2, D4's truncation markers, D5's minimal wiring, D6's dynamic-entry policy, D7, D9's minimal
  analyzer output (`processes[]`, `legacyLineCount`, `warnings[]`), and D10 are Wave 1 scope; D3
  (stack frames), D4's three named escape hatches, and D11 (the `ERROR_KIND_PATTERN` relocation) are
  Wave 2 scope — every one of them already load-bearing.

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
