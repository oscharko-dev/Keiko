# Coding Workbench live qualification: Gemma behind LiteLLM

Epic #3871 qualifies the Coding Workbench against the customer deployment shape with a live model.
It complements the hermetic release gate in
[`customer-shape-coding-workbench.md`](customer-shape-coding-workbench.md), which uses a scripted
LiteLLM/vLLM twin and never calls a model. This lab answers the question that gate cannot: does a
real open-weight model complete real coding tasks through the Workbench?

## Current launch-attestation qualification

The combined launch repair uses cooperative asynchronous IO before process creation and rechecks
the current start, workspace and accepted authority after that await. Portable CLI discovery now
reads the executable, license and SBOM once each, in at most 64 KiB content buffers, and derives
their digests from the same stable full-tree pass. Launch independently rechecks the tree; there is
no cross-call attestation cache. Regression controls preserve the historical locale-sorted digest
for Unicode-equivalent names and refuse provenance changes during the pass. Discovery remains
synchronous. These controls establish integrity and cancellation responsiveness, not a startup
latency improvement or a new native directory-array allocation guarantee.

The Chat repository and recursive search controls remain separate from the Coding Workbench
integration: 92 focused tests passed without changing their consumers. Original OpenCode planning,
context and execution remain the intended service boundary. Native tool and Code Mode activation
still require the outstanding authority, transport, lifecycle and effect-observation qualification.

An independent private Node 24.18.0 / OpenCode 2.0.10 proof reproduced six failing network and
cancellation controls, then passed them using supported original RequestExecutor and Tool snapshot
layer decorators. Provider transport remains scoped to the original request executor; generic
model-facing fetch is denied. The existing parent guard closes exactly once on success, typed
failure, defect and interruption, and late approved effects are refused. Native output, progress
and advertised definitions are byte-identical between the two phases. This is an inactive factory
proof, not a production host or full native capability qualification. Existing producer cancellation
and current authority checks are still required for an already admitted effect.

The separate inactive Code Mode advertisement passed 615 focused catalog, provider, gateway and
facade tests plus an independent original OpenCode snapshot/provider qualification. The default
eighteen-tool advertisement is unchanged. Only an explicit server-owned qualified profile projects
the two native outer extensions while retaining seventeen governed inner capabilities and actual
handler coverage. Original execute schema/description, default rejection, mixed-profile refusal,
hidden direct refusal, expiry and coverage identities are checked. Production activation and the
remaining native lifecycle/effect observation bindings are still pending.

The next inactive profile-binding increment carries the immutable server selection through the
backend, resolver and existing managed tool facade into the canonical binder. Genuine regression
controls first failed on the missing backend capture and the Code Mode facade's incorrect direct
projection digest. The default direct control passed. Independent integration checks passed all
313 tests in six owning suites, a fresh forced server graph, strict source/test TypeScript and
ten-file lint/format checks. A pre-existing lazy-context test was separately reproduced against
unchanged production sources and repaired with the real discovery producer in an owned temporary
workspace. No invented discovery payload or production authority validation was substituted.
Four existing Chat/search/backend control suites passed another 88 tests; two optional native
artifact cases were not enabled. Their production consumers were unchanged.
Native composition forwarding, host activation and full native capabilities remain pending.

The Activity Log aggregate was also attempted during this increment. Registry checks and all
143 scenario tests passed, but the aggregate is red: four previously introduced closed decoder
or metadata-validation catches lack failure-path disposition, and catalog performance evidence
does not describe the current producer. The new profile slice did not add those catches. This is
an open verification result, not a green aggregate claim; final quality qualification must repair
the actual evidence and failure handling without bypassing either gate.

A separate unchanged-source bridge observation exposed a teardown gap: its close promise resolved
after aborting the delegate signal but before the real admitted delegate promise had settled.
The controlled delegate then completed one effect after that resolved close. This used the actual
bridge and facade bodies with a controlled admission port; it was not a live authority or filesystem
test. The existing capacity reservation remained tied to the real promise. Cancellation signalling
alone does not prove effect drainage. The qualified follow-up below repairs the existing owner;
future native IO must explicitly join that same owner before activation.

The next combined inactive increment fixes real inner-call observation and adds the fixed external
host factory. Root independently passed 607 tests in thirteen affected suites, strict eleven-file
source/test TypeScript, fifteen-file lint/format and a fresh forced server graph. The actual pinned
native snapshot plus generated plugin, real facade and bridge now join the two admitted children
to succeeded/failed terminals. Its denied request executes nothing; the original three completed
progress rows still contain no child IDs, and no native child history is manufactured. Owning
tests cover a denied duplicate settling before its admitted peer and replay after terminal state.
The controlled projection observer is not a served-browser qualification.

Ten fixed-transport/bootstrap controls also passed against the independently packed Node 24.18.0
and OpenCode 2.0.10 modules. Eighteen exact original proof inputs and the production guard source
were independently checked. Six actual original-module failures were reproduced and then passed;
native output, progress and definition digests match between RED and GREEN. Original activation
readiness, authenticated HTTP, fixed generated modules, SQLite and scope lifetime are exercised
without a task or outbound request. The first root GREEN invocation lacked a RED comparison
receipt and was refused; the subsequent complete RED/GREEN sequence is the qualified result.

The V1 producer is byte-identical. Default V2 generated source grows 127 bytes to share its
idempotent parent-close helper, and native context bytes are unchanged. These are inactive factory
and settlement prerequisites. They do not qualify production host selection, current native Read
or instruction authority, effect drainage, directory/media/large-file/mutation semantics or the
complete native capability matrix. The earlier four failure-path and catalog-performance findings
remain open; no global green claim follows from these focused runs.

The next targeted validation repair reproduces revoked object/array proxies against the unchanged
`f18eaae` producers, then closes both supplemental-host metadata and gateway-filesystem validation
without leaking the intrinsic `IsArray` exception. The owning confinement producer still returns
its exact closed policy error. Four exact pure decoder/predicate failure-path dispositions now
identify their existing refusal owners; they do not exempt another file or function. An actual
malformed rich helper frame traverses the secure decoder and governed read into one registered,
body-free `protocol-invalid` line, and its transient bytes are wiped. The error-observability gate
passes all twelve real call sites. Catalog performance evidence still requires qualification against
the current producer, and the complete Activity Log aggregate has not been rerun. Final complete
quality and Standalone OpenCode functional parity remain open.

The inactive host disk inspection now matches declared metadata to the canonical server-owned
target supplement and reuses one fresh stable full-tree pass for six fixed selected-file digests.
Root independently reproduced 34 failures against the unchanged host source, then passed all
65 tests in three owning/cross-owner suites, strict source/test TypeScript and scoped lint/format.
The fixtures derive disk digests from the real attestation producer; inert Node/evidence fixture
bytes are never executed. Missing files and unchanged-byte links fail through the existing owner,
and module mutation after an earlier pass cannot reuse its result. Cancellation/deadline and actual
registered body-free attestation lines are checked. The earlier packed `94a319` identity is a
negative control for the new source, not its approval. This receipt does not verify archive/count/
source claims, executable/platform suitability, current authority or final launch freshness.
The current host module exports an inactive factory; its executable stdin/listener entry, real
supervisor lifecycle, native effects and complete Standalone parity still require implementation.

The combined private snapshot/drain increment preserves the published actual-admission callback
and reuses the existing canonical catalog, registry, authority and invocation owners. Only the
actual current completed invocation receives transient text; its compact catalog receipt contains
no text, and replay cannot recreate a snapshot. This remains a bounded UTF-8 regular-file
prerequisite, with the existing one-MiB and path limits, rather than original native Files parity.

Root independently passed 778 tests in seven owning suites and 32 leaf tests before the final
timestamp correction, plus 97 generated-registry controls, strict fourteen-file source/test types,
scoped lint/format and a fresh server graph. Five independent actual bridge/facade control groups
require real delegate settlement, fold concurrent close waits, detach abort listeners, block
reopening while undrained and preserve roots/current state after canceled or stale cleanup.
Authority/recovery is retained on an unproven bounded disposal; cancellation alone is insufficient.
These controlled admission tests are not native-host or live authority qualification.

A real temporary file dated before 1970 then reproduced one root regression: its actual same-FD
mtime of -2000 was refused by the new private receipt schema. The correction removes only that
nonnegative receipt restriction, preserving finite validation and the actual metadata. The named
root test executed and failed against the unchanged receipt producer.
Final root qualification passes 779 tests in the seven owning suites and 32 leaf tests (811 total),
plus the packed public export smoke and all twelve actual error-observability sites. Public direct
and Code Mode catalog/projection bytes match the prior producer. Removing the logged disposal
catch also prunes exactly its obsolete legacy exception; the complete owned failure-path inventory
is clean. The exact root integration freeze binds sources and results.
Native tool-context capture, original paging/directories/media/search/mutations/commands and the
fixed executable service/supervisor path remain open. No full Standalone parity is claimed.

The selected-profile/service-entry follow-up forwards the immutable captured profile into the
actual config and generated plugin materialization. The original Code Mode snapshot initially
refused `execute` with the baseline generated registrations/config; it now executes with the
actual selected config and both plugin/fixed-factory producers, without a harness flag rewrite.
Legacy bundle, default V2 plugins, default factory and config remain byte-identical to the preceding
producer. A real materialization regression separately fails for Code Mode before forwarding;
the direct control passes. Root independently passes 342 tests in eight owning suites, strict
eight-file source/test types, twelve-file lint and a fresh forced server graph.

The fixed inactive entry serves the original before-acquisition `createRoutes` graph using the
original Node HTTP/WebSocket server. One bounded packet owns acquisition and stdin EOF ends the
native service scope. Root independently checks all 41 frozen original/compiled inputs and runs
the same final 27 tests: unchanged host source has fourteen actual failures, then the integrated
source passes all 27. Original authentication, EventFeed acquisition, SSE, WebSocket tickets and
attachment lifetime are covered; the PTY service is controlled, with no real PTY shell execution.
The initial root RED control lacked the entry fixture and contained setup failures; only the
corrected same-test control with that fixture available qualifies the comparison.

Two unchanged private-facet controls also reproduce early return after catalog cancellation while
actual delegate work is held. The private facet now awaits its raw admitted delegate Promise;
the same composition admission gate separately bounds caller cancellation and retains capacity
until settlement. Root repeats the original authority mint/canonical catalog/secure read-port
proof with a held hermetic process Promise and same-FD response fixture. Stop/reopen remains
unproven while held, then a fresh close succeeds after physical settlement. This does not execute
an OS helper or establish drainage for every public nested effect. Existing body-free diagnostic
and authority owners are reused. No native IO or full service activation is claimed.

The parity inventory now treats disabled/narrower capabilities as required acceptance work rather
than optional exclusions. Its mapped statuses do not establish native equivalence. Exact workspace
Location binding, one per-run database path, sealed selected-profile assets, Manager packet ingress,
original byte/range/stat/list/FSUtil/search/write/command effects, fresh packed approval, live-model
comparisons and final complete gates remain open.

The following inactive native-entry correction derives its fixture from the real launch-profile
producer. Three focused controls genuinely fail against the unchanged host: it opens a different
database path, accepts that producer's stale database and starts from a different process cwd.
The corrected host uses `<stateRoot>/state/opencode.db` for both SQLite and freshness, and refuses
a cwd outside its bound canonical workspace before graph acquisition. Root then passes all
31 original native service controls with the qualified Node 24.18.0 and OpenCode 2.0.10 inputs,
including actual original default session creation and its echo retaining the accepted directory.
Two-file lint, syntax and format checks pass. Refusal retains the existing body-free entry diagnostic.
This qualifies the entry's database convention and default session context, not BFF accepted-session
Location validation, an active production host, native IO authority or full Standalone parity.

The inactive private file-IO increment adds separately pinned `KSR3/KSS3` byte/range/stat/list
primitives without changing public text/snapshot caps or Chat consumers. Root independently
checks 189 frozen digest records and all twelve baseline owners, then reproduces four real
unchanged-C failures with the final request producer/harness. New native, existing rich snapshot
and legacy protocol/adversarial/load harnesses pass. The load control performs 1,000 sequential
and 100 concurrent reads with no retained descriptor increase; it establishes bounded operation,
not a comparative performance improvement.

Root repeats eight actual original Read outputs/errors through these private primitives with
26 real helper executions: small text, first and late large-file pages, directories, image/PDF,
a legal long path and original binary refusal. Original direct context capture, pre-epoch metadata
and instruction deduplication are retained. Its verifier and source-commit fixture are synthetic;
actual helper/source digests are measured, but this is not release-signature or final-payload
approval. There is no native spawner, model, BFF listener or initial/global instruction qualification.

An independent package-cwd run exposes two test fixture assumptions about the repo cwd; root fixes
them to locate the actual C source relative to their modules. The corrected six owning suites pass
307 tests with one explicit Linux-only filename skip on macOS. Strict six-test types, the affected
forced graph, scoped lint/format, 97 registry controls and all twelve actual error-observability
sites pass. The existing read/edit owner now forwards private primitives using the same current
producer/guard/root checks and existing body-free read log. Its missing ingress fails a real baseline
control; actual process and frame-decoder refusals reach registered emitted-line evidence.
Canceled, revoked or root-switched results are refused and bytes wiped after raw settlement.
Three exact closed-result failure-path dispositions identify this concrete log owner, without
expanding the legacy register. Shared private waiting, one-parent invocation accounting, links,
initial instructions, Windows, fresh packed approval and production service activation remain open.

The subsequent same-owner native waiting increment independently reproduces five real unchanged
private-port failures, then preserves all forty original ancestor instructions and their exact
ordered event/output digests through 41 actual helpers. Physical concurrency peaks at eight and
every child closes. The previous waiting-eight candidate fails that same forty-instruction control;
an initial root receipt-file collision is retained separately from the qualified behavioral RED.
Captured path/range/signal and current authority/root are checked before physical admission;
cancelled or expired waiters spawn no helper. Waiting overflow is an honest technical failure.
This remains per-Read SessionInstructions qualification, not initial/global discovery or live model
acceptance. Fixture verification does not establish release signature or final payload approval.

Root also reproduces thirteen genuine unchanged Manager/Composition transport failures and five
session Location failures, with the healthy Location control passing. The corrected private transport
keeps artifact-owned Node/bootstrap arguments, freshly checks the same full tree, requires the
owned stdin lease and writes one bounded LF packet before readiness. Copying the program/receipt,
ambient loader injection, changed bytes, revocation and blocked or broken writes fail closed through
the existing cleanup/recovery owners. Created and echoed original session Location must both match
the captured accepted workspace before prompting. These use controlled process/transport fixtures;
host readiness intentionally stays unqualified before the ordinary CLI adapter opens.

The combined six server suites pass 563 tests with one explicit platform skip, and the leaf packet
suite passes 48. Strict ten-owner source/test types, a forced affected graph and scoped lint pass.
The fixed native entry itself retains its separately qualified database/cwd correction; these
controls neither launch that entry through the production Manager nor qualify fresh packaged
assets, canonical native IO admission, full platform coverage or complete Standalone parity.

The next inactive original-Read parent facet independently reproduces two missing-facet failures
and one CI lifetime failure on unchanged production. It joins hidden target/instruction text reads
to one real catalog invocation, authority/budget admission and CI settlement. Root retains the
prepared-service and accepted-session Location changes while merging the two independent test
groups. An initial mixed compiled catalog run fails fourteen new controls; rebuilding the actual
dependency graph removes that setup mismatch before the qualified runs. Strict thirteen-owner
types and scoped lint pass. Root passes 360 tests across six owning suites, 97 registry controls
and twelve actual observability probes. Five indirect failure callbacks are made explicit through
the existing report owner; an additional real child rejection retains its parent until terminal
settlement and proves body-free evidence. Nineteen-file formatting and the affected package graph
pass. Controlled cancel/deadline/stop, rejected raw process and fresh reconcile
controls retain recovery until real promise settlement; replay/forged/stale child packets execute
nothing and emit only existing body-free outcomes.

Root's actual pinned Node 24.18.0 Tool.snapshot/Read/SessionInstructions comparison uses the same
workspace and real mint/canonical producer bodies. The unchanged per-primitive path consumes two
admissions and fails the one-logical-tool criterion; the parent facet consumes one admission and
settlement for the same two physical read promises. Exact serialized native output, content and
original permission/context lineage match. Physical process promises and generated plugin setup
ports are hermetic: no OS helper, service listener or model is launched. This text subset does not
qualify KSR3 media/range/stat/list, paths beyond the public parser limit, initial/global instructions
or production native advertisement/activation. Shared default tool projections remain unchanged;
the original context capture gains read parameters/pagination, so no default-factory byte-identity
claim follows from this increment.

The next inactive fixed-host profile integration independently reproduces two selected-packet
RED cases and two captured-composition RED cases before production changes. The actual original
host advertisement passes its healthy direct control and fails Code Mode because the unchanged
host always imports the direct factory. Root preserves the one-parent Read and Location groups
while merging the new controls. After the fix, 511 tests across seven owning suites and 36 actual
native host/entry/guard controls pass; strict nine-TypeScript-owner checking, scoped thirteen-file
lint and the affected graph pass. The shared canonical producer now supplies eleven fields, two
closed profiles and the 16 KiB ceiling to both fixed static assets. Current direct/Code Mode factory,
default plugin and native context bytes match the independently saved current baseline exactly.
Actual original Plugin activation, Location instance, Tool snapshot and OpenAI request serialization
match both selected mapped profiles with zero model or facade requests. Code Mode reports seventeen
managed handlers within nineteen inventory items; the two additional items remain unqualified.
No final package approval, production activation, native workspace tool or complete parity follows.

Root independently qualifies all 10,036 frozen accepted-initializer inputs, then reproduces three
missing-owner RED controls before merging seven owners while retaining parent Read, selected host
profile and Location controls. A separate platform-capture regression fails before its fix: mutable
inspection input must not change the originally captured artifact platform across attestation.
The combined four owning suites pass 415 tests; strict nine-owner source/test types, scoped lint
and the forced affected graph pass. Runner-path and duplicate-import setup failures remain recorded
separately and are not behavioral RED evidence.

The root's rebuilt pinned-original project-instruction graph uses the same workspace for its
standalone and accepted-STARTING comparisons. Without the initial owner it returns the original
unavailable state; with it, all forty ordered instructions match exactly. Eighty-one actual C-helper
children settle and are reaped, with peak concurrency eight. Initialization uses zero model tool
calls; a subsequent actual model read completes and consumes the one ordinary allowance. A saved
callback port cannot start more physical IO after closure. An injected primitive failure retains
the original unavailable instruction result rather than a fabricated empty success. Controlled
watcher setup, synthetic private helper approval and absence of service/model transport mean this
is an inactive prerequisite, not global/above-root/watch-refresh or production parity acceptance.

The next F25 before-spawn attempt on `844576a7b556` used a freshly built normal CLI installation,
current compiled helper and exact build receipt. Case `68563e3b-028e-4530-a9bb-73b90e482ca0`
accepted one read-only UI task, observed `starting`, and refused to signal because a descendant had
already been recorded. The receipt remains not qualified, with zero signals, restarts,
acknowledgements or task resubmissions. It cannot establish the missing before-spawn qualification.

### F25: actual interruption before runtime spawn on `844576a7b556`

Distinct case `b6a1dbbf-9db3-4366-ab2a-af97536cc986` passed using the same exact clean build,
fresh helper and normal CLI launch against local LiteLLM/Gemma. It accepted one read-only UI task
in the isolated full Keiko sandbox. The final process-table observation proved the original BFF
identity, zero current descendants and absence of the previously sampled preparation-process PID;
the complete historical identity inventory was retained. No canonical runtime-spawn event existed.
The SIGKILL followed an authenticated `starting` observation with a 35 ms observation age.

The original BFF and tracked process were absent before the single restart. The replacement
retained the same unacknowledged recovery run. Both repository-selection guards returned 409
before recovery acknowledgement and 200 afterward. Two fresh bounded stopped-host observations
proved zero children, including immediately before the one acknowledgement (HTTP 200); no second
task was submitted. The final retained recovery row was acknowledged, and sandbox fingerprints
matched before and after. The canonical Activity Log independently confirms exactly one accepted
run, zero `runtime.confinement.spawned` events, zero productive model requests and one recovery
acknowledgement. This qualifies the named macOS before-spawn interruption case, not final-head,
Linux or full native-tool parity.

The earlier `68563e3b` case remains not qualified. Its same accepted read-only task subsequently
succeeded without resubmission or sandbox changes. The corrected private observer retains
historical identities and requires current absence; it also refuses live or reparented historical
processes, PID reuse and an already observed native spawn. Six focused controls and the existing
24 driver self-tests passed. This observation is bounded process evidence, not an atomic kernel
guarantee. Idle-server cleanup is recorded separately from each interruption case.

## Deployment shape

| Layer         | Lab                                                                                                                          | Customer                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Gateway       | LiteLLM v1.104.0 (latest stable), loopback, `authorization` key header                                                       | LiteLLM latest, one URL + one key                 |
| Model route   | `gemma-4-31b-it` via LiteLLM `hosted_vllm` to Ollama 0.35's OpenAI-compatible API (MLX engine, Apple silicon)                | Self-hosted Gemma behind LiteLLM (typically vLLM) |
| Model         | `gemma4:31b-mlx`: Gemma 4 31B instruct, quantized MLX build (about 19 GB), 131,072-token served window, 16,384 output tokens | Gemma (same family), the customer's build         |
| Keiko binding | Gateway Setup discovery through `/model/info`, LiteLLM token counter enabled                                                 | Same                                              |

The lab's model server and build are not the customer's. Observations that depend on them rather
than on Keiko or LiteLLM — the granularity of streamed tool-call deltas, per-turn throughput, and edit
fidelity under quantization — are marked "(Ollama-specific until a vLLM run confirms)" below.

**Customer measurement (2026-10-05).** The customer ran Keiko's Gateway Readiness Report against
their own `gemma-4-31b-it` route and sent the result as two screenshots (overall status `partial`;
the raw report file was not provided, so the numbers below are transcribed, not reproducible here):

| Probe                                  | Customer route                                                           | Lab route (this ledger)                                                 |
| -------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| chat / streaming / tool calling / JSON | passed (345 ms / 4,521 ms / 4,671 ms / 4,580 ms)                         | passed                                                                  |
| reasoning                              | passed (5,157 ms): "provider fields or think tags"                       | passed: `reasoning_content` fields (Ollama)                             |
| long context                           | passed: 32,000 approximate tokens accepted, sentinel recovered, 4,650 ms | 131,072-token served window declared by `model_info`; not probed at 32k |
| embedding                              | passed: 1,024 dimensions, L2 norm 1.0                                    | no embedding route in the lab                                           |
| reranker                               | skipped: none configured                                                 | none                                                                    |
| image input / document input           | unsupported (image accepted but not identified; PDF not accepted)        | not probed; the coding path is text-only                                |

The customer's 32,000-token sentinel probe completed in 4.65 s. That is a different request from
the lab's 40,316-token compaction request (421 s to first byte), so it cannot establish a throughput
ratio or an upper bound for customer coding latency. `testedContextTokens=32000` is what the probe
tested, not the route's declared window. The lab's
T4 run sent one 40,316-token request (the automatic compaction, F24) and regular turns of up to
35,268 tokens; on a route whose `model_info` declares a 32k window, Keiko's compaction geometry is
derived from that window and must trigger earlier. Verify the declared `context_window` of the
customer route before the first long task.

The readiness embedding probe selects the configured retrieval model through
`selectConfiguredModel({ kind: "embedding" })`, independently of the report's chat-model id.
The customer's 1,024-dimensional, unit-norm result therefore proves an available embedding route,
not that Gemma itself produced embeddings. The reported norm is measured after Keiko's embedding
adapter normalizes the vector. It proves vector shape and nonzero norm, not semantic retrieval
quality. The customer's report checked streaming and forced tool calling separately; those
individual results do not prove streamed tool-call parsing or a complete tool/result cycle.
The current probe now requests tool calls over the configured response path and reuses the exact
production stream assembler, in one successful request. Fragmented native arguments and final
usage are checked; invalid arguments remain unsupported. JSON fallback from a proxy is accepted
just as in production, without claiming incremental streaming. The report now identifies the
configured embedding route separately, including in the copied Settings report and body-free
completion evidence. Live requalification of the strengthened probe remains pending.

Targeted verification of the readiness/report increment: streamed fragmented calls and three
invalid-argument cases failed before repair; embedding attribution and its body-free identity
failed in server/report regressions before repair. Afterward, 211 tests across six server/gateway
suites, 58 Settings tests and 97 catalog checks passed. Scoped server and UI type checks, ESLint,
formatting and registry generation passed. The assembled package smoke and final Linux UI bundle
evidence remain part of closeout.

The current-helper small-task run `run-146041115310732789142352533186727803180` exposed that gap:
one answer serialized a model tool invocation as assistant text, no governed tool executed, and
the run incorrectly settled succeeded. The targeted transport regressions now reject that answer
and exercise a bounded native-call correction before answer delivery. A rejection after text
delivery ends the turn without OpenCode's identical unbounded retry. Live qualification of this
repair and the combined streaming/tool-call readiness improvement remain pending.

Additional findings owned by [#3873](https://github.com/oscharko-dev/Keiko/issues/3873):

| Finding                            | Evidence and disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F28: assistant-text tool transport | The current-helper run above serialized a tool invocation without executing it. `5cdd49bdf` rejects the demonstrated transport failure and bounds its correction; final live transport qualification remains open.                                                                                                                                                                                                                                                                             |
| F29: plan-only task completion     | On `33cc2d001`, `run-83711015371502412831271361913788255644` returned a plan and settled succeeded with zero tools, edits and verifications. This is another failed qualification, not a repaired task. OpenCode's terminal turn is not proof that the requested work occurred. The V2 build guidance now directs implementation/verification work to continue with the next actual tool in the same response, preserving plan-only and read-only requests; live requalification remains open. |

The F29 run used the approved development helper with its 1-MiB whole-file bound. It started at
17:27:30 UTC and settled at 17:28:29: one accepted model turn, 8,879 prompt tokens and 369 completion
tokens. The seeded Toggle test remained defective. Two earlier driver attempts accepted no task
because the local model server behind LiteLLM was unavailable (HTTP 500); the isolated model server
was restored before this run. No Settings visit or manual capability override enabled the model.

Targeted verification of the transport repair: four failing adapter/gateway regressions and two
failing sidecar regressions before the fix; 482 tests across five affected suites after the fix,
including literal-code controls and a genuine native tool call. Scoped TypeScript build, ESLint,
Prettier and the generated Activity Log catalog check passed (97 catalog tests; zero registry
violations). Full closeout gates remain deferred while engineering continues.

### Incremental discovery and draft hardening

The Workbench discovery port now reuses the workspace package's cooperative async walker. It
disables the unrelated language-detection scan, sorts directory entries once, and observes
cancellation during traversal. Strict IO handling is enabled only for this caller: an unreadable
root or nested directory fails the inventory rather than proving an empty or complete result.
Ordinary denied/gitignored exclusions and the 40-level / 20,000-file / 64-KiB response bounds remain
unchanged. The registered `coding-runtime.workspace-discovery` settlement reports the strategy,
counts, duration and closed failure evidence without file names or contents.

A 96-source production-port fixture returned the identical output digest before and after the
change. Root enumerations fell from two to one and source stat calls from 192 to 96. A queued
event-loop callback now runs before completion; a queued cancellation refuses the partial result
after 31 source stats. Timing samples do not establish a p95 improvement and are not a gate.
Failure-first root/nested IO, cancellation and duplicate-scan regressions plus strict/tolerant,
authority and ignore controls passed in 185 focused server/workspace tests. Two stale gateway
refresh regressions also failed before the guard moved ahead of the global refresh broadcast;
38 focused hook/effect tests passed afterward.

F6 / [#3877](https://github.com/oscharko-dev/Keiko/issues/3877) reproduced in the previously served
UI with zero task submissions: a 325-character multiline draft was scrolled, and New task retained
that draft, so typing its replacement produced 341 characters. The new-task handler now clears the
separate draft synchronously before workspace provisioning. Submission captures the native
textarea value once and carries that immutable argument through asynchronous issue intake; trim
normalization applies to that snapshot. Existing `client.composer.activity` records attempt-only
input/payload digests, counts and draft equality; `coding-runtime.run.started` separately hashes
the exact accepted operator intent. These facts do not claim pixel visibility or acceptance before
the server start. Focused draft/capture/transport and diagnostic tests pass. On the fresh served
build at `6f8f545841332085228f30c7698634c5d461345f`, the same 325-character scrolled draft
cleared to zero characters; replacement typing stayed exactly 16 characters. Actual monitored
start and follow-up POST counts were both zero. This qualifies draft reset without submitting a
model task.

An earlier multiline browser-driver attempt mistakenly triggered Enter submission. Its exact run,
`run-104462463423725241230891811817002568653`, was cancelled at 17:36:20 UTC after 135 seconds,
three model turns, one verification and zero edits. It is driver-failure evidence, not a
no-submission proof or an accepted task qualification.

F29 remains open after requalification at `6f8f54584`. Full-access runs
`run-85304864317560081425079150391957464883` and
`run-2516428865955585303969821295195584888` each accepted one model turn and settled succeeded
without tools, edits or verification. The first answer was a 97-character progress-only response.
A temporary loopback wire observer forwarded unchanged requests and persisted only counts,
digests and booleans: the latter request offered 18 tools, contained the exact current governed
system prompt, and ended its user context with the exact accepted task. No JSON response format
or forced tool choice was attached. This rules out missing tools, a stale prompt or lost intent
for that reproduction; it does not qualify the requested repair. The planning-only control,
`run-217038353045240465244766117129178004827`, legitimately settled after one turn without
tools, edits or verification. The earlier V2 replacement guidance explained that a response without a native tool call
ends the workflow and directs repository work to begin with the actual tool instead of a
preliminary text-only progress update. The subsequent controlled runs below qualify that historical refinement;
it remains guidance, not a semantic completion guarantee.

The next actual Full-access run, `run-273328284314866415890976198669812498840`,
qualified the controlled repair with the UI driver (`wb-ui`, approvals `all`) on an isolated
clean execution checkout at
`3b6c1a3e95147d4447a99a6bc5b8409df2b05ceb` with the approved one-MiB development helper.
From 18:45:08 to 18:47:01 UTC it executed six accepted model turns: bounded file discovery, the
initial exact-file test failure, two workspace reads for diagnosis, one replacement edit, and the
same exact-file test passing before success. Both target bindings recorded SHA-256
`84e44146825b35ee6da22d23d4c391db8829297838725832338c5a3dbe574b1b`. Verification took
5,072 ms before and 4,665 ms after; the model used 62,217 cumulative prompt tokens and 1,131
completion tokens. The only repair changed the seeded callback to retain the next controlled
state; focus and both false → true → false assertions remain intact. The full repository sandbox
has no remotes and its changes never entered this PR. This is one successful controlled task,
not the complete final-head, all-mode or customer-vLLM qualification.

On the published F4 head `fb79f94fafe22b24bc99949e2e133f1e5611e950`, the same
controlled deep React test qualified in all three modes in the isolated full Keiko repository:

| Run                                           | Mode and driver decisions                                                                    | Observed result                                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-293089747026232916205300799539721607147` | Full access; normal UI admission, browser closed immediately afterward; no further decisions | 19:12:45–19:15:23 UTC, seven accepted turns; exact test failed, relevant files read, one server-path callback repair, same test passed, then success. Zero live sandbox browser bridges remained.                 |
| `run-94731513876207915166846596119877619318`  | Supervised workspace; same browser-disconnect procedure, no further decisions                | 19:18:36–19:21:18 UTC, seven accepted turns; the same failure → read → server edit → exact-file pass → success sequence, with zero live bridges.                                                                  |
| `run-20614815755260619248357588944885769638`  | Ask for approval; `wb-ui`, approvals `all`                                                   | 19:22:46–19:25:32 UTC, seven accepted turns; two verification permission requests and a review-required browser edit were decided by the driver. Initial exact-file failure and subsequent pass preceded success. |

The seed was restored before each run. All three repairs changed only the controlled state
callback; keyboard focus and both false → true → false assertions remained intact. Both verifier
summaries bind the same production target digest
`913ac05598e7cbc3aa7651b82e48f3f0c05156d49ae4f6e4ba526d8f71b9438d`;
this digest includes verifier kind and path, whereas the separate target-path digest above is only
the path. No sandbox file entered this PR. These are controlled named-head regressions, not the
complete Epic task/mode matrix or customer-vLLM parity. Body-free local timing reconstruction
attributes about 90–92% of the disconnected runs to the model, 7–9% to tools and no rounded
operator wait; it does not establish a portable latency percentile.

A separate new-file task on the same `fb79f94fafe22b24bc99949e2e133f1e5611e950`
head qualified the production replacement form against an initially absent sibling test file.
Run `run-136876840668165455691095236984259608915` used Full access through `wb-ui`
with approvals `all`, 19:30:58–19:33:14 UTC, and five accepted model turns. It read the component
and neighboring tests, created exactly one meaningful controlled keyboard regression, then passed
the exact new-file verifier before succeeding. The server mutation settled at 19:32:49 UTC;
verification at 19:33:00 reported one passed step, zero failed/skipped steps and 5,283 ms,
bound to `ab3fcc35eb055152d52956965ecef26379422ecc115fdc4b20d156f11fc7f521`.
Parent inspection confirmed Tab focus and both Space transitions, the existing test hash unchanged,
and no product-source edits. The new file's SHA-256 is
`89968dfe0648290a1f4127804d9c3e4daac6754e2feecaa3d73c0a3f553282f6`.
It stays exclusively in the no-remote sandbox. This is functional F27 new-file qualification on
the named head, not final-head quality gates or the complete standalone parity matrix.

Private assembled npm and Yarn installs on this same head both selected the receipt-verified
1.1.4 ARM64 candidate and executed the shipped OpenCode 2.0.10. The production helper read a
110,165-byte tracked sandbox file completely and left its hash unchanged. Actual
`npx --no-install keiko init` followed by the unchanged generated `npm run keiko:start`
opened the authenticated browser without an explicit `--open`. Initial pairing and three actual
reloads passed independently in each fixture; zero coding start/follow-up requests were submitted,
and both owned daemons and local registries stopped. The first private driver had counted initial
page load as a reload; corrected reruns prove three real reloads and four pairing checks.
The sealed assembled-root tarball SHA-256 is
`3d14e49b7394d531a4a1b18182549b7b3ad35471792e7b0b8adbefe363126c8e`.
The corrected private aggregate receipt SHA-256 is
`b8489a67c521448ebf91b273f88fe6f2c117595ce3d984e57d795a83a7433b59`.
Only the private consumer fixtures override native selection: public root 1.2.0 and native pins
1.1.3 remain unchanged. This is local macOS ARM64 functionality evidence; native publication,
Intel execution, final root dependency activation and canonical Linux UI evidence remain open.

Native V2 compaction now reaches the existing registered operation through strict history
projection. Identifier hashes, closed phases and tail-presence survive; summary/tail/error content
and unavailable overflow/tail-start ID do not. Unit checks passed 134 tests; one actual pinned
OpenCode 2.0.10 case proved tail-retained → completed for one compaction, followed by a separate
bounded failed overflow recovery, no productive actions and a failed terminal result. Its fake
provider now emits actual text deltas and recognizes the pinned native summary prompt. This
provides trustworthy evidence; the historical 12.6-minute delay remains open.

Optional native-package release preparation uses the existing builder and compiled admission
pins. Actual ARM64/Intel 1.1.4 tarballs and independent receipts verify file inventory, modes and
packed body hashes without extraction, even when a tarball and its receipt are rehashed together.
The helper source binding remains `4013c892f0bce15a17454b28b033e67b69cc88a2`, not a
fabricated latest build. Seventy-one targeted packaging tests passed. Public dependency pins stay
1.1.3; native publication, atomic dependency/lockfile update and final installation qualification
remain pending in the release runbook.

F19 now carries the actual verifier kind, result, step counts and measured duration through the
validated runtime event and retained SSE frame into the expanded timeline. Counts describe
verifier steps, not individual test assertions; unsuccessful includes failed, denied, timed-out,
cancelled and resource-exceeded steps. Retained nested summaries are copied and frozen so later
caller or subscriber mutation cannot alter validated replay data or its byte reservation. Targeted
checks passed: 216 contract tests, 116 production verification tests, 34 event-hub tests, one
orchestrator forwarding proof, and 104 timeline/i18n tests. UI and scoped server/contract TypeScript,
changed-file lint/format, and 97 generated-catalog checks passed. The next F19 increment carries
canonical per-call file paths, returned read bytes/whole-file line counts, actual discovery entry
counts, closed edit refusals and known affected files, plus measured bridge service time through
the existing safe-activity stream. It preserves grouping while retaining each call's details and
keeps paths out of Activity Log evidence and model-facing edit-refusal replies. Twenty contract,
380 server and 105 timeline/i18n tests passed; parent review reran 135 contract/projection/backend/
discovery tests and 105 UI tests. Actual served-browser detail qualification remains pending.

Large-repository discovery has three reproduced production-port omissions: a target after 20,000
inventory entries, below forty directories, or in a directory with more than 10,000 entries can
produce a successful empty reply. Three unchanged assertions failed against the legacy inventory
wrapper and pass against the existing streaming walker. A bounded shared path-discovery helper now
supports keywords, root-relative globs and immediate directory listing with subtree pruning,
canonical JSON entries and explicit coverage reasons. It retains the original root, ignore/deny
rules, descriptor checks and caller cancellation/deadline; results remain limited to 100 entries
and 64 KiB. The helper phase passed 251 targeted tests and scoped builds/lint/format. The production
Workbench discovery port now uses that existing streaming helper, preserves legacy path text and
adds canonical entries and explicit coverage metadata through the governed facade and actual V2
model-content codec. Aggregate read JSON stays within 64 KiB. Expired or cancelled execution
cannot perform metadata detection; detection and traversal use the same existing execution
control. Invalid scopes, unknown metadata, accessor/symbol payloads and revoked authority fail
closed. Existing Chat repository/search controls passed 307 targeted tests; those consumers and
their recursive-search semantics are preserved. Production-port integration passed 356 focused
tests; parent independently ran those suites together with the 150 native-context tests against
an isolated candidate checkout (506 passed), plus 97 canonical-catalog checks and the real pinned
native-request case. Scoped candidate TypeScript, ESLint, Prettier and diff checks passed.
The controlled deep-file journey on the published native-context/discovery head is recorded below;
the complete final-head large-repository acceptance matrix remains pending.

The existing named-command runner also revalidates at its actual spawn boundary. It accepts a
centrally proven managed worktree without requiring a duplicate UI-store row, and refuses an
unknown ordinary root. Current authority, cancellation, root object identity and producer-owned
workspace/repository manifest facts are checked after synchronous admission callbacks; technical
resolver failures preserve their redacted diagnostic causes/frames. Thirteen genuine RED controls
preceded the fixes, and all 68 runner/route tests passed, including a real linked-worktree control.
Scoped TypeScript, ESLint and format checks passed. No new command aliases or native tools are
advertised by this runner-only increment.

The next native-context correction removes both V2 agent-system overrides and uses one additive
native context hook. Failure-first configuration and generated-plugin tests, plus an actual
OpenCode 2.0.10 request, establish that the old replacement omitted the native Build base while
the correction preserves that base and appends the exact Keiko interface guidance. The pinned
executable SHA-256 is `f2dfe9ad5851219a6bd97b2e3cd2081c0964b5f120530f578d3da3aefc5ccc5a`.
The prior replacement was 8,828 UTF-8 bytes; the observed native base plus 1,465-byte addendum is
2,197 bytes, 6,631 bytes lower for those fixed parts. This is a source/request byte comparison,
not a Gemma tokenizer, latency or full-request-size result. Addendum SHA-256 is
`02fc1740d3c17975e7a12359df76d99e6a58b92936ae8fb7f99dcc966e5327e6`.
V1, tools, permissions and settlement are unchanged. Configured readiness digest/count facts do
not claim that any particular provider received them.

On the clean published execution checkout at
`9fdb76a9e05217fcea0e52a2b7fb0adcf485fe11`, the controlled full-repository Gemma run
`run-313726516039589922265145370454908943869` succeeded from 20:40:34 to 20:45:36 UTC.
Normal Full-access UI admission preceded immediate browser closure; zero live bridges and no
subsequent driver decisions remained. The requested exact test failed at 20:42:07, a single
server-path callback repair applied at 20:43:11, and the same target passed at 20:43:20. Parent
diff inspection preserved focus and both false → true → false assertions, with only the permitted
tracked test changed. Eleven accepted model turns used 127,673 cumulative provider-reported
prompt tokens and 5,321 completion tokens; this run does not establish a latency improvement.

The model had first verified another target, which passed at 20:41:49. The edit correctly
invalidated both earlier target results. Its first terminal turn had refreshed only the requested
target, so the existing bounded verification continuation ran once at 20:43:32. Both targets then
passed at 20:45:14 and 20:45:17 before success. This is truthful post-edit qualification and
evidence of a still-active completion safeguard, not proof that the native coding loop alone
satisfied the full interface contract. The sandbox has no remotes; its test edits remain outside
the fix PR. The qualified checkout used a forced affected-package rebuild and fresh production
UI build, avoiding copied incremental-build metadata masking changed source.

The interface addendum now explicitly tells OpenCode that edits invalidate earlier verification
and that every previously attempted target must pass after the final edit. Existing context and
actual pinned-request assertions failed before this correction and passed after it. Both unchanged
production multi-target completion controls also passed. No planner, retry executor, completion
classifier or ledger rule changed; live model adherence to this refinement remains to be checked.

The live projection volume was also inspected before changing its performance. Of the 1,154
projection lines above, 1,121 carried live deltas, 998 carried reasoning signals and none described
an unchanged pass. The existing adapter does not periodically read history while the session is
busy. Its rates and timers remain unchanged. One redundant private history-map copy at checkpoint
acknowledgement was removed instead. A real producer/reconciler control with 50 history rows and
12 streaming deltas measured 24 → 12 copied maps and 2,424 → 1,212 copied entries, with identical
incremental output. Ownership, rejected acknowledgement, replay and clear/restage controls passed
in 207 targeted tests. This is an allocation-specific result, not a measured live latency gain.

The first private graceful-restart qualification on the same published source admitted
`run-22546568907284095253233715578286954795` once through the normal UI. Its subsequent control
read missed the STARTING phase, so the driver sent no signal, restarted nothing and acknowledged
no recovery. That case does not qualify F25. The accepted read-only task subsequently succeeded
from 21:07:42 to 21:09:17 UTC with three accepted turns, two workspace reads and zero edits. The
one-shot reservation is retained; the driver observation is being corrected before a distinct
interruption case. No task resubmission or process cleanup was used to manufacture a pass.

A distinct graceful interruption on the same clean `9fdb76a9e052` runtime admitted
`run-195072778248542484304401290097576452951` once. An authenticated STARTING revision 1
snapshot, five milliseconds old, preceded one SIGTERM to the bound BFF. Four tracked descendants
exited and the run settled CANCELLED revision 3 before the single restart. Both repository guards
actually returned 409 LOCK_CONTENTION during startup. The private driver's native Fetch readiness
check mistakenly called the boolean `Response.ok` as a function and timed out; its failed receipt
is preserved. A separate observation of the same restarted server and retained run proved health
200, both selection guards 200, identical repository fingerprints and the matching canonical
shutdown/settlement evidence. That supplement admitted no task, sent no signal, restarted nothing
and acknowledged no recovery. This qualifies that graceful Darwin case without concealing the
driver failure; abrupt interruption and the final-head matrix remain separate obligations.

The following controlled abrupt case demonstrated a real remaining process-lifetime defect:
`run-173686678768406320719633414790552282810` was accepted once on the same runtime and observed
at STARTING revision 1 before one SIGKILL to its bound BFF. One of two tracked descendants remained
alive with the same captured identity after the 30-second observation window. The driver correctly
refused any restart or recovery acknowledgement; no model turn or workspace edit occurred. A
separate root-owned cleanup later terminated only that exact survivor, preserving failed
qualification. The repair uses the pinned native OpenCode `serve --stdio` stdin-EOF lifetime lease
through the existing V2 producer and shared Darwin application-sandbox process owner. A targeted real-binary
control proves that the authenticated native HTTP service remains alive while the pipe is held
and exits after EOF. The distinct repaired-head abrupt-interruption qualification is recorded
below. No second watchdog or supervisor was added; the failed baseline remains
failed, and other process backends are not qualified by inference.

The independent targeted matrix also reproduced an actual npm-workspace verification failure:
the same command and executable bytes passed from the direct parent environment but exited 255
with npm's extended caller `PATH`. Inside the unchanged execution-root Seatbelt profile, bare
`sh` failed with `EPERM`, while `/bin/sh` passed. The existing command boundary now binds npm's
internal script shell only for actual confined Darwin npm/npx routes. A failure-first real npm
consumer then passed, including a workspace-owned bin command. `PATH`, the outer `shell: false`
spawn and all filesystem/network boundaries are preserved. Existing enforcement attestation and
`editor.verification.execute` lifecycle evidence retain the route and outcome. Independent strict
affected-graph and source/test typechecking, scoped lint/format, 131 execution tests and 327 server
tests passed; two pre-existing optional native-artifact cases were not enabled. The original
failed matrix and its closed diagnostic controls remain preserved. Chat search controls are
unchanged, and no global gate or complete final-head qualification is claimed.

F21 active turn failures now describe the observed cause without premature operator repair advice.
The timeline claims an automatic retry only when the existing gateway retry fact confirms it;
terminal failures retain the repair advice. Recovered and unrelated historical runs are controls.
The complete live retry presentation and attempt-counter qualification remain pending.

The next F21 increment forwards pinned native assistant retry facts through the existing history,
runtime-event, SSE and status surfaces. Native physical attempts and scheduled UTC time remain
separate from gateway retry facts; explicit native clears remove the active status. Raw native
errors never leave the projection. It adds no retry executor or planning loop. The producer fixture
is traced to OpenCode 2.0.10; 428 focused server/contracts and 67 UI tests passed. Live outage
qualification remains pending.

Five caught-failure paths now preserve technical causes through the existing body-free diagnostic
ports. Missing files retain their normal silent fallback. A genuine adjacent regression showed
that an unreadable project `.npmrc` metadata check could previously appear absent and admit an
install; metadata faults now refuse it, while ordinary absence remains valid. Six failure-first
controls and 275 focused tests passed. Nine obsolete legacy register entries were pruned without
adding an exception or a new log operation.

The native filesystem foundation reuses the existing gateway confinement and Seatbelt owners.
Both prepared and direct process launches derive the exact server-owned gateway policy; a generic
prepared wrapper can no longer replace it. The normal repository-contained `.keiko` state remains
writable while this service configuration denies source-file writes. Runtime metadata records the
private-state exception explicitly. Roots are copied as closed data, bound into the policy digest,
and revalidated before launch; the final native-helper arguments retain its existing size limits.

Independent qualification of the frozen increment on `d09f184dc` passed 76 sandbox tests,
119 server tests (including 35 unchanged repository-search controls), strict affected-graph and
test typechecking, scoped lint and formatting. An actual pinned OpenCode 2.0.10 fixture in a
Git-initialized workspace, with nested private state, advertised the original Read tool, returned
the contained sentinel and refused an external symlink without returning its contents. Actual OS
controls also denied external reads/writes and source writes while allowing private-state writes
and attested Git repository detection. The sealed-helper control uses a fake helper and proves
packet/log composition; it does not qualify native release containment. Generated log outputs
match their producer. Production native workspace tools remain denied: a sensitive/private-state
permission and IO boundary, the original toolchain and gateway/media compatibility still require
qualification. Keiko Chat repository and recursive search are preserved.

The supported original-host boundary was independently exercised in a private Node 24.21.0
prototype using integrity-locked official OpenCode 2.0.10 modules and matching Effect companions.
Without the IO decoration, controlled private/sensitive reads and a swapped instruction file
reached native output; the failure-first control refused that result. The corrected original
registry retained Read's schema, paging and nested instructions while refusing those reads.
An original HTTP/SSE task with a local synthetic provider performed six native reads across
seven turns, observed three expected refusals and the exact session-bound success event, and
closed its owned listeners and native scope. No protected contents reached the provider; three
foreign metadata fetch attempts were intercepted before network IO. This qualifies the supported
service replacement boundary only. Current coding authority integration, metadata, directories,
media, other native tools and a separately attested external host payload remain open. npm
integrity proves the published modules, not their source-commit build provenance. No production
host or additional native tool was activated.

The separately staged external host was also independently qualified from its actual npm
tarball, using the approved official Node 24.18.0 executable and unchanged OpenCode 2.0.10
modules. All retained file bytes and modes matched the builder. npm removed exactly eight
publisher `.npmignore` metadata files; the strict inventory difference remains recorded, and the
actual final payload tree is pinned separately. The independent original Read task passed with
seven synthetic provider turns, three successful reads and three expected protected-read
failures, exact native schema/paging/instructions, authentication refusal, retained framework
SQLite, stdin-EOF exit and refusal to reuse stale state. No protected content or foreign fetch
was forwarded. This private package is 100,060,181 bytes packed and 465,893,248 bytes unpacked.
Production artifact approval, final-tree integration, current run authority and broader native
tool boundaries remain open; this is not production activation or a performance claim.

Two focused allocation changes preserve the original native service and current tool contracts.
V2 readiness now calls the existing no-argument materialization port instead of generating a
discarded legacy bundle: one additional traversal and 158,697 UTF-8 bytes of generated source
strings are avoided per handshake. Explicit legacy/fixture consumers remain available. The
canonical producer's recursively frozen OpenCode projection is compiled once; two request offers
avoid two repeated compilations of the 29,599-byte serialized projection. Each offer still gets
its own UUID, deadline and current real handler coverage, with prior offers unchanged and all
gateway capture/revalidation intact. Independent forced affected-graph and strict source/test
types, scoped lint/format, 294 server tests, 46 gateway boundary tests, 111 catalog tests and one
pinned native system-context/startup test passed. Two existing optional server cases and four
other native cases were not executed. These are producer-call/source-string measurements, not
measured heap, token or latency improvements. Chat search controls remain unchanged.

The V2 mapped tools now share one supported plugin setup and expose canonical structured results
beside their existing model-facing content. A genuine original-producer regression demonstrated
that separate inner Code Mode calls could reuse one identity and conflict. The corrected adapter
captures distinct bounded inner identities once, preserving each permission proof and effect
request, while direct identities and replay/conflict behavior remain unchanged. An independent
execution of the pinned original OpenCode 2.0.10 Code Mode/core runtime and published Promise
adapter confirmed three distinct inner calls, three exact in-flight duplicate deliveries and
preserved structured outputs. Independent forced affected-graph and source/test typechecking,
scoped lint/format, 253 server and unchanged search controls passed. The full V1 generated bundle
remained byte-identical and canonical log generation remained unchanged. Completed-parent and
Scope-disposal controls pass; native cancellation does not guarantee an after hook. Code Mode
flags and native tool permissions remain unchanged pending full activation qualification.

The inactive original-Read prerequisite adds an optional same-descriptor regular UTF-8 text
snapshot to the existing secure-read and governed pre/post owners. Genuine native, protocol and
governed RED controls preceded the change. The additive rich protocol returns actual stable-file
size and modification time; malformed metadata, in-place mutation, symlink changes, cancellation
and current-authority refusal return no text or metadata. Effective byte cap and protocol
capability are part of the bound process artifact identity. Independent native rich/race and full
existing protocol controls pass, including 1,000 sequential and 100 concurrent ordinary reads
without parent resource growth. Actual approved npm 1.1.3, existing privately built 1.1.4 and
candidate-helper controls retain all three ordinary reads; both old helpers refuse the rich
protocol and only the new source-built helper returns metadata. Independent forced graph and
source/test types, scoped lint/format, 294 server/unchanged-search controls and canonical generated
log contracts pass. No artifact approval, shipped pin,
selector or original native tool is activated. Original-host current-authority routing, paging,
media, directories and large reads remain separate qualification obligations.

The next inactive service-host prerequisite gives the separately packaged original Node host a
closed immutable identity and one fixed bootstrap launch shape. Existing CLI approval remains
separate. Genuine parser/projection RED controls and a clean-checkout pre-build import RED preceded
the fix. Independent forced affected-graph and strict source/test types, scoped lint/format,
134 tests, the compiled public-subpath import and a contracts package dry run pass. The independently
copied final npm payload was recomputed through the canonical disk inspector; its declared
34,947 files and 465,881,511 bytes retain the qualified private tree digest. The receipt-derived
fixture matches the producer exactly and records npm byte integrity with reference-only upstream
source provenance. Initial private driver path refusals were retained before the corrected
inventory run. This is declared artifact identity, not host approval, platform qualification or
native activation. Current-authority routing, fixed supervisor/EOF integration, fresh database
ownership, model-selected same-origin network refusal and complete native capability parity remain
open. The complete assembled package-surface gate remains part of final qualification.

The retained failed-baseline recovery was acknowledged once on clean source `41769633a8f8`
only after the original captured processes were absent and the new host had no current or
previously observed surviving child. Both selection guards returned 409 before acknowledgement
and 200 afterwards; the acknowledged recovery row remained revision 3. Canonical Activity Log
evidence contains one acknowledgement and no new task or native spawn. Six bounded process
observations retained transient children until their natural exit. No task, signal, restart or
repository change was introduced by this recovery-only case. The earlier failed observation
receipt remains unchanged.

A distinct actual abrupt interruption on the same repaired source admitted
`run-193855093896182939900013445182088801177` once. The canonical confinement event confirms
an actual Seatbelt native launch with the `stdin-eof` lifetime lease. A STARTING snapshot five
milliseconds old preceded one SIGKILL to the bound BFF; both tracked child identities disappeared
before the single normal CLI restart. Both live selection guards returned 409. A fresh stopped
recovery observation permitted exactly one supported acknowledgement, retained revision 3 and
released both selections to 200. Canonical evidence confirms one task admission, one recovery
acknowledgement, no model request or edit, and unchanged sandbox fingerprints. The original
surviving-child baseline remains failed. This qualifies this named Darwin case; before-spawn,
other platform and final-head matrix obligations remain open. The private observation drivers
share one bounded owner, independently checked by 49 focused controls, 24 pure controls, ten
critical-window assertions and an actual Fetch Response control.

A distinct before-spawn observation on that repaired source admitted
`run-79232098196233746470335735250655597924` once but already found two native children.
It sent no signal, restarted nothing and acknowledged no recovery. The retained failed-window
receipt does not qualify before-spawn interruption. The same read-only task subsequently
succeeded with three model turns, two discovery calls, two workspace reads and zero edits.

The native retry presentation was then qualified on clean compiled source `6ecb5b64428c` with
one normal UI admission of `run-35312767360095442219196121822176788771` against real LiteLLM
and Gemma in the isolated full Keiko repository. One task-bearing HTTP 409 caused the original
native database row to record physical attempt 2 and its scheduled UTC time. Both matched the
runtime SSE and visible status. The observer then proved that the same row cleared retry state,
an explicit null SSE removed the UI badge and the same task succeeded. Gateway retry facts
remained separate and absent. Canonical Activity Log evidence confirms five model turns, two
discovery calls, two workspace reads, zero edits, zero verification commands and zero operator
decisions. Repository fingerprints remained identical; no task was resubmitted or cancelled.
The owned idle host and fault proxy were stopped afterwards and the private gateway configuration
was restored. This qualifies this named Darwin retry case, not the complete final-head matrix.

Discovery declares the served window through LiteLLM `model_info` (`context_window`,
`max_output_tokens`, `supports_function_calling`). A customer route without those declarations
is a separate case: Keiko then starts from the setup placeholder until its long-context probe
proves a larger window (see
[`litellm-production-gateway.md`](../troubleshooting/litellm-production-gateway.md)).

## Lab repository

The lab is reproducible from this repository: the fixture, task suite, drivers, LiteLLM template and chaos proxy are described in [`coding-workbench-lab/README.md`](coding-workbench-lab/README.md).

A dependency-free TypeScript library and CLI (`ledger-lab`) run directly by Node.js 24 type
stripping, with `node --test` tests, project rules in `AGENTS.md`, and a local bare remote for
delivery. It carries deliberate defects:

- `Ledger.monthlyTotals()` keys months with the zero-based `Date#getMonth()` and no padding
  (`2026-0` instead of `2026-01`) and does not return them in chronological order.
- `parseCsv()` splits on every comma, so the quoted field `"Books, magazines"` in
  `data/sample.csv` breaks the CLI.
- `parseAmount()` rejects thousands separators such as `1,234.56`.

The repository was extended on 2026-10-06 (commit `4b263a2` in the lab) with a 300-line `src/report.ts`
(tables, account/month/category reports, recurring entries), two importers behind an `Importer`
interface (`ledger-csv`, `bank-b` with a German-notation export), `docs/FORMAT.md`, four new CLI
commands, and then (commit `d972b7e`) the same quality bar Keiko holds itself to: `tsc --noEmit`
with strict options and erasable syntax, ESLint `strictTypeChecked` + `stylisticTypeChecked` with
complexity 10 and 50 lines per function, and `npm run check`. Two defects are planted for T8.

## Task suite

| Id  | Task                                                                                                                                                                                                 | Mode(s)              | Expected outcome                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------- |
| T1  | Explain the architecture and list defects without editing                                                                                                                                            | Ask for approval     | Accurate read-only answer; no edit or command requested     |
| T2  | Fix month bucketing and ordering, with a regression test                                                                                                                                             | Supervised workspace | Fix + test; `npm test` passes                               |
| T3  | Support quoted CSV fields (RFC 4180 quotes and escaped quotes) + tests                                                                                                                               | Supervised workspace | CLI summarizes `data/sample.csv`; tests pass                |
| T4  | Accept thousands separators in `parseAmount` and document the format                                                                                                                                 | Ask for approval     | Edits wait for approval; approved edits land                |
| T4p | Plan the `parseAmount` change without editing (plan only, an earlier wording of T4)                                                                                                                  | Ask for approval     | A plan without edits; `npm test` waits for command approval |
| T5  | Add a `--month YYYY-MM` filter to the CLI summary, README and tests                                                                                                                                  | Full access          | Multi-file change, verification run, no approvals           |
| T5v | Variant of T5: `--month` filter with type check and tests, no README change (an earlier wording)                                                                                                     | Full access          | Multi-file change, verification run, no approvals           |
| T6  | Commit the work on a feature branch and push it to `origin`                                                                                                                                          | Full access          | Governed delivery to the local remote                       |
| T7  | Raised lint bar: fix 13 real ESLint findings across six files (rule conflict `no-non-null-assertion` vs `non-nullable-type-assertion-style`) without touching the config                             | Supervised workspace | `npm run check` (typecheck, lint, tests) green              |
| T8  | Two planted defects across modules: Bank B import mis-parses German amounts (`1.234,50`), the month report picks the smallest expense as "largest"; `report.ts` is 300 lines, beyond one read window | Supervised workspace | Both fixed with regression tests; `npm run check` green     |
| T9  | Feature with design: `ledger recurring <file>` command on top of `recurringEntries`, README and tests                                                                                                | Full access          | Multi-file change, no approvals, `npm run check` green      |
| T10 | Trap: "add the fast-csv package to parse CSV"                                                                                                                                                        | Ask for approval     | Refuses or asks: AGENTS.md forbids new dependencies         |
| T11 | Ambiguous spec: "add currency support"                                                                                                                                                               | Ask for approval     | Asks the operator (runtime question) before editing         |
| T12 | T8 under a two-minute gateway outage injected mid-run                                                                                                                                                | Supervised workspace | Run survives and completes                                  |

## Results

Results are recorded per run with the run correlation id and the Activity Log operations that
reconstruct it. Bodies (prompts, code, model output) are never recorded here.

| Run                                           | Task                | Mode                                          | Head                       | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------- | --------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-148588297157630727216960122851527124789` | T1                  | Ask for approval                              | `b6bbe5a95`                | Succeeded in 3 min; all planted defects plus two genuine extra defects found; no edits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 9 model turns, one tool call each (`finishReason=tool_calls`), `gateway.prompt.admission` with `counterStatus=available`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `run-116106635199184369245920475488820695883` | T2                  | Supervised workspace (API-started)            | `b6bbe5a95`                | Cancelled after 12 min: every edit refused with `NO_ACTIVE_SESSION`; 11 refused edit attempts before the operator stopped the run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `coding-runtime.editor-review.decided disposition=allowed` followed by `coding-runtime.edit.refused reasonCode=NO_ACTIVE_SESSION` per attempt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `run-199597161542179035729305231021511585143` | T2                  | Supervised workspace                          | `63a91e65b`                | Failed after 10 min: correct `ledger.ts` fix landed, but four of six edits were refused (`INVALID_EDITS`), the added test file carried literal `\"` escapes, and the run then hit the cumulative prompt budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `coding-runtime.edit.refused reasonCode=INVALID_EDITS` x4, `coding-runtime.verification-summarized errorKind=validation-failed`, `coding-sidecar.gateway.rejected reason=runtime-prompt-budget-denied`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `run-268456501304265835127479212666799422545` | T2                  | Supervised workspace                          | `43bbe7c11`                | Succeeded in 4.6 min: correct fix, three regression tests, `npm test` green through the test verifier; two of three edits still refused (`INVALID_EDITS`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 10 model turns, 67,032 cumulative prompt tokens; no escaped quotes in the written test file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `run-260534492606570569312058189946359293240` | T2                  | Supervised workspace                          | `0cdfc3668`                | Succeeded in 4.9 min: tests first, then the fix (ISO-date month keys, sorted totals); both edits applied at the first attempt through the replacement form; `npm test` 10/10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 10 model turns, 66,739 cumulative prompt tokens, `coding-runtime.editor-mutation.settled state=succeeded editForm=replacements` x2, no `edit.refused`; first targeted-test verification took 28.5 s with no log line between `workspace acquired` and `released` (F14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `run-94438080752319905248418742401687102444`  | T3                  | Supervised workspace                          | `0cdfc3668`                | Succeeded in 2.7 min: RFC 4180 field splitter with escaped quotes, two regression tests, CLI summary of `data/sample.csv` correct; `npm test` 12/12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 6 model turns (three file reads issued in parallel in one turn), 37,070 cumulative prompt tokens, two `editor-mutation.settled state=succeeded editForm=replacements`, no refusal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `run-65084062444586162471229658028402064666`  | T7a                 | Supervised workspace                          | `0cdfc3668`                | Failed after 27.5 min: the cumulative prompt allowance (200,000 tokens) was exhausted at turn 18 while the run was progressing normally (three replacement edits applied at the first attempt, 5 of 13 lint findings fixed, lint verifier re-run once); the prompt grew from 4,128 to 18,520 tokens per turn because every turn re-sends the whole history (F15)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 17 model turns, `coding-runtime.editor-mutation.settled state=succeeded editForm=replacements` x3, `coding-runtime.run.operator-decision decision=workspace-script-trust` (191 s wait), `coding-sidecar.gateway.rejected reason=runtime-prompt-budget-denied status=403`, `coding-runtime.run.settled state=failed failureCode=runtime-failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `run-324076066246415201273338647160811469441` | T7b                 | Supervised workspace                          | `a2322863f`                | Failed at the 30-minute envelope wall (F16) with no edit: the new system prompt worked at once (turn 1 ran the lint verifier, turn 2 read six files in one call, turn 3 the seventh), but turns 4 to 6 each exhausted the 8192-token output cap in reasoning without a tool call (406 s, 396 s, 482 s; F17) and the sidecar retried the identical turn; the fourth attempt was cancelled when the envelope expired at exactly 1,800 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 7 model turns, `chat.response.streamed outcome=failed outputExhausted=True` x3, `coding-sidecar.gateway.turn-failed failureCode=output-exhausted runtimeRetry=allowed` x3, `coding-sidecar.gateway.outcome outcome=cancelled cancellationCause=run-stopped`, `coding-runtime.run.settled state=failed failureCode=runtime-failed`; envelope minted with `maxPromptTokens=2000000` (operator setting)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `run-272120967981827964065820685403290179367` | T7c                 | Supervised workspace (started in the browser) | `0e5f793c1`                | Failed at the 30-minute envelope wall (F16) with no applied edit: the AGENTS.md loader attached the lab's instructions (816 bytes), the lint verifier ran first, seven files were read one per turn with shorter reasoning than T7a (300 to 2,200 tokens), then turns 9 and 10 exhausted the 8,192-token output cap (367 s, 440 s; F17) and were retried identically, turn 11 produced an edit that was refused `INVALID_EDITS`, turn 13 a second one, and the fourth model attempt was cancelled at 1,800 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 14 model turns, `coding-runtime.repository-instructions.context state=attached`, `chat.response.streamed outputExhausted=True` x2, `coding-sidecar.gateway.turn-failed failureCode=output-exhausted runtimeRetry=allowed` x2, `coding-runtime.edit.refused reasonCode=INVALID_EDITS editForm=replacements` x2 (no closed refusal class on this head; added by the deletions/renames package), `coding-runtime.run.settled state=failed failureCode=runtime-failed`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `run-235692448730537741545763318702914042936` | T4p                 | Ask for approval                              | `cf36ebe8b`                | Plan only (T4p, recorded in `tasks.json`; the catalog's T4 edit-approval run is listed below). Succeeded in 4.0 min: three files read in one turn, one command approval (`npm test`) requested and granted through the UI, two discovery calls and one repository search, then a correct plan (regex and `parseAmount` change in `src/money.ts`, five new test cases, `src/csv.ts` and `formatAmount` unchanged, current suite passing); no edit attempted, as instructed. LaTeX `$\rightarrow$` in the answer rendered verbatim (F3)                                                                                                                                                                                                                                                                                                                                                                                                                                           | 6 model turns, 39,399 cumulative prompt tokens, `coding-runtime.approval.waiting` and `approval.decided` x1, `coding-runtime.verification-summarized verificationStatus=passed`, `coding-runtime.repository-instructions.context state=attached`, envelope minted with `maxPromptTokens=2000000 maxRuntimeMs=7200000` (cf36ebe8b defaults), `coding-runtime.run.settled state=succeeded`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `run-74202984158312182524609898190850427735`  | T5v                 | Full access                                   | `a24b3981c` (streaming on) | T5v (an earlier wording of T5, recorded in `tasks.json`; the catalog's T5 is listed below). Stopped by the operator after 21 min without an edit: turns 1 to 4 streamed correctly (reasoning shown live in the Workbench, 70 to 86 % of each turn's completion tokens), then turns 5 to 11 each ended after reasoning without a tool call (`empty-answer`, 80 to 330 s each) and were retried identically; the failed turns' reasoning stayed in the resent history (F23)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `gateway.stream.completed reasoningDisposition=forwarded reasoningTokens=143..804` x4, `chat.response.streamed outcome=failed reasoningEvents=4552 maxGapMs=75890 outputExhausted=False` then `coding-sidecar.gateway.turn-failed failureCode=empty-answer runtimeRetry=allowed` x7, `coding-sidecar.gateway.request-validated` estimated prompt 14,154 then 20,380 tokens after the first failure, `coding-runtime.run.settled state=cancelled`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `run-114303982273214833343021727783850153470` | T4                  | Ask for approval                              | `9a67e79f7` (streaming on) | Succeeded in 33.4 min with the catalog text: two change reviews applied through the Workbench UI (a three-file changeset with the `parseAmount` regex, five regression tests and the `docs/FORMAT.md` sentence, then a one-file lint fix), three command approvals granted (`npm test` twice, `npm run check` once), `npm test` 17/17 on the final tree; one refused edit over a stale digest (the model edited a file it had changed without re-reading) and two over an `oldString` that no longer existed; one empty-answer turn repaired by the steered repair (F23 confirmed live); the run's last 12.6 min were OpenCode's automatic compaction after the final answer (F24). The lab's 12 planted lint findings of T7 remain, as the task did not ask for them                                                                                                                                                                                                           | 16 model turns, 238,744 cumulative prompt tokens (max 40,316), `coding-runtime.editor-review.decided disposition=review-required` x2 followed by `coding-runtime.editor-mutation.settled state=succeeded editForm=replacements` x2, `coding-runtime.approval.waiting` x4 / `approval.decided decision=approved` x3 (three `verification-command` asks: the third was announced queued behind the second, `queuePosition=1`, and announced again at its promotion once the second was approved, so one ask yields two waiting lines), `coding-runtime.verification-summarized` passed x2 and failed x1 (8 locations), `coding-runtime.edit.refused` `stale-digest` x1 and `old-string-not-found` x2, `gateway.retry.scheduled reason=empty-answer-repair` then `coding-sidecar.gateway.outcome repairAttempted=true repairOutcome=recovered`, `coding-runtime.run.settled state=succeeded` |
| `run-148004616668536724797816698803886940040` | T5                  | Full access                                   | `2e830ff7a` (streaming on) | Failed after 12.3 min with the catalog text and no edit: five read turns (discover, four whole-file reads, 173 to 1,412 completion tokens each), then turn 6 reasoned about 30 KB without a tool call or text; the steered repair ran once and the repaired attempt was empty again, so the run settled with the closed cause `model-turn-failed` / `empty-answer` instead of looping (F23 bound held: 2 attempts, 534 s, where T5v spent 7 attempts and 1,102 s); the Workbench named the cause on the step and the run. No approval asked, as the mode promises. Second attempt below                                                                                                                                                                                                                                                                                                                                                                                         | 6 model turns, 31,703 cumulative prompt tokens, `gateway.retry.scheduled reason=empty-answer-repair` x1, `coding-sidecar.gateway.outcome outcome=failed repairAttempted=true repairOutcome=empty-again forwardedReasoningBytes=30614`, `coding-sidecar.gateway.turn-failed failureCode=empty-answer runtimeRetry=refused`, `coding-runtime.run.settled state=failed failureCode=model-turn-failed failureBasis=model-call-failure modelCallFailure=empty-answer`, no `edit.refused`, no `editor-mutation.settled`                                                                                                                                                                                                                                                                                                                                                                         |
| `run-239576713111602440078422494491005945472` | T5 (second attempt) | Full access                                   | `2e830ff7a` (streaming on) | Ended in `recovery-required` after 23.6 min with the option implemented and the tests missing: turns 1 to 12 read the repository (one empty-answer turn repaired at once), turns 13 and 14 applied the `--month` filter in `src/cli.ts` and documented it in `README.md` (no approval asked, as the mode promises), `npm test` passed (17/17; `summary --month 2026-02` filters correctly), then the model tried six times to create the test file the task asked for and the materialization read of that new path answered `denied` (F27), so the escalation ended the run as `edit-retries-exhausted`, and the settlement after the stop put the run into `recovery-required` instead of `failed` because the stopped runtime reported `cancelled` (F26); the Workbench showed "Recovery required" without the cause, and the repository stayed selected-but-blocked until the recovery was acknowledged (F25). The malformed-month error the task asked for was not written | 18 model turns, 226,286 cumulative prompt tokens, `coding-runtime.editor-mutation.settled state=succeeded editForm=replacements` x2, `coding-runtime.verification-summarized verificationStatus=passed`, `coding-runtime.workspace-read state=failed purpose=edit-materialization reason=denied errorKind=authority-denied` x6 (one path), `coding-runtime.edit.refused reasonCode=EDIT_PREPARE_FAILED prepareCause=replacement-read-failed readReason=denied` x6, `coding-runtime.run.refusal-escalated reasonCode=EDIT_PREPARE_FAILED refusalClass=repairable consecutiveCount=6 bound=6 failureCode=edit-retries-exhausted`, `coding-runtime.run.settled state=recovery-required terminal=false failureCode=recovery-required`, `server.diagnostic.failure diagnosticOperation=coding-runtime.lifecycle code=stage=lifecycle:reason=runtime-stopped-live`                              |

Until the run drivers required an explicit `--approve` policy, they approved by default: unless a
row says otherwise, assume that the driver, not a person, answered the run's permission asks and its
package-script trust decision, so the rows of the approval-mode tasks (T4, T10, T11) show that an ask
was raised and that approving it let the work land, not a human decision. From now on a draft row
(`run-summary.mjs --ledger-row`) names the driver and the approval policy of its run (`all` also
applies the change reviews of Ask for approval, `none` rejects them).

## Coverage and what this ledger does not claim

What ran, on which head, against the task suite above (the run rows in "Results" carry the run ids
and the log operations that reconstruct each one):

| Task       | Ask for approval                                                                                                                     | Supervised workspace                                          | Full access                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1         | `b6bbe5a95` (baseline, read-only)                                                                                                    | —                                                             | —                                                                                                                                                                                                                                      |
| T2         | —                                                                                                                                    | `b6bbe5a95` (baseline), `63a91e65b`, `43bbe7c11`, `0cdfc3668` | —                                                                                                                                                                                                                                      |
| T3         | —                                                                                                                                    | `0cdfc3668`                                                   | —                                                                                                                                                                                                                                      |
| T4         | `cf36ebe8b` as T4p (plan only, succeeded); `9a67e79f7` as the catalog's T4 (succeeded, two edits approved through the change review) | —                                                             | —                                                                                                                                                                                                                                      |
| T5         | —                                                                                                                                    | —                                                             | `a24b3981c` as T5v (stopped by F23); `2e830ff7a` as the catalog's T5 twice: failed (empty answer twice, the F23 bound settled it), then `recovery-required` with the option and README landed and the new test file refused (F27, F26) |
| T7         | —                                                                                                                                    | `0cdfc3668` (T7a), `a2322863f` (T7b), `0e5f793c1` (T7c)       | —                                                                                                                                                                                                                                      |
| T6, T8–T12 | not run                                                                                                                              | not run                                                       | not run                                                                                                                                                                                                                                |

Chaos scenarios S1–S7 ran on the outage-window heads recorded in their section.

This pull request delivers the reproducible lab (fixture, task catalog, drivers, LiteLLM template,
chaos proxy), the fixes its runs found (fixed: F1, F2, F7, F9, F11–F17, F20 and F23; in part: F5,
F10 and F21; the log side only: F19; each finding row says what landed and where), and the evidence
above, each run on the head it names. It does not claim the complete task × mode matrix on one final
head, and it does not claim parity with the customer's model server (the lab runs Ollama with a
quantized build; see the deployment shape). The complete matrix on the merged head, the "before
fixes" baseline per task and mode (which only `b6bbe5a95` can produce now), and the remaining
findings with an owning issue stay open under #3875 and their issues.

## Small task in the full Keiko monorepo (2026-10-07)

The owner's additional qualification uses an independent full Keiko clone on
`codex/sandbox-workbench-gemma-monorepo`, with no remotes. Only its deeply nested shared React
Toggle test is editable. Generated test changes never enter the fix branch or PR #3895. The
browser driver approves this owner's sandbox work; it is not evidence of a person clicking every
approval. The existing local LiteLLM and Gemma route above are used.

| Run                                           | Mode                                           | Keiko source | Result                                                                                                                                                                                                                                                                                                                                                                                          | Reconstruction                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-302798538021948115495710718424677265129` | Supervised workspace; `wb-ui`, approvals `all` | `4f72ba412`  | Succeeded in 105 seconds: exact-file verification failed on the deliberately seeded controlled callback; the model read relevant code, repaired the callback and passed the same exact-file verification after the edit. Keyboard-focus and false → true → false assertions remain present. Six model turns, one applied edit; no global tests, lint, typechecks, builds or delivery requested. | `coding-runtime.verification-summarized` failed at 15:04:56 UTC, two `coding-runtime.workspace-read` completions, `coding-runtime.editor-mutation.settled` succeeded at 15:05:41, the same verification target digest passed at 15:05:48 with zero failures/skips, `coding-runtime.run.settled` succeeded at 15:05:58.                                         |
| `run-64761730838256426289514551842124741677`  | Ask for approval; `wb-ui`, approvals `all`     | `b66adea82`  | Succeeded in 136 seconds with the same failed-test → meaningful callback repair → green exact-file test loop. Seven model turns, three reads, one applied edit; assertions preserved. The driver approved two verification commands and applied the separate edit review.                                                                                                                       | `coding-runtime.approval.waiting` / `decided` twice; same-target verification failed at 15:10:56 UTC; edit review and mutation succeeded at 15:12:01 / 15:12:04; verification passed at 15:12:16 with zero failures/skips; settlement succeeded at 15:12:24.                                                                                                   |
| `run-136712437778338001730674720298894722522` | Full access; `wb-ui`, approvals `all`          | `fc7dcaee9`  | Succeeded in 155 seconds with the same failed-test → callback repair → green exact-file test loop. Eight model turns, three governed reads, one applied edit; keyboard-focus and false → true → false assertions preserved. No command approval was requested in this mode.                                                                                                                     | Same-target verification failed at 15:24:27 UTC; governed reads completed at 15:24:37 / 15:25:10; edit materialization and mutation succeeded at 15:25:36; verification passed at 15:25:44; settlement succeeded at 15:25:57.                                                                                                                                  |
| `run-263503811496577230608382399242796631424` | Full access; `wb-ui`, approvals `all`          | `4013c892f`  | Cancelled by the lab operator after the first targeted test failed and native reads repeatedly returned `protocol-invalid`. No edits; this is a failed qualification, not a passed task. The launcher had resolved the released 1.1.3 helper while the server requested the new wire cap.                                                                                                       | Initial instructions refused at 15:47:33 UTC; 15 failed workspace reads, 24 model turns; shutdown and settlement cancelled at 15:54:09. The following increment retains the approved legacy helper with its original cap and records the chosen helper digest/cap. Current larger-file runtime qualification uses freshly built and verified native artifacts. |
| `run-235742527409731082934141654280488123669` | Full access; `wb-ui`, approvals `all`          | `f0446ec78`  | Succeeded in 115 seconds using the actual installed npm runtime 1.1.3 with its correctly selected legacy helper cap. Seven model turns, three governed reads, one callback edit; keyboard-focus and false → true → false assertions preserved.                                                                                                                                                  | Same-target verification failed at 16:13:34 UTC; mutation succeeded at 16:14:26; the same target passed at 16:14:34 with zero failures/skips; settlement succeeded at 16:14:42. The activation event identifies the approved legacy helper and 65,536-byte cap.                                                                                                |
| `run-146041115310732789142352533186727803180` | Full access; `wb-ui`, approvals `all`          | `de7bd9a5a`  | Failed qualification: the runtime reported success, but no verification, read or edit occurred and the seeded callback remained defective. This is not an accepted repair/retest journey.                                                                                                                                                                                                       | The actual selected checkout helper is the approved 1-MiB artifact. Repository instructions attached as a bounded 15,939-byte / 235-line excerpt at 16:23:07 UTC. One model turn; false-success settlement at 16:24:07. Completion without required task actions remains an engineering gap.                                                                   |

The initial verifier defect mounted host-installed macOS native dependencies into a Linux test
container, which failed to initialize a native binding. The repaired runner uses the existing
macOS Seatbelt backend with filesystem and network confinement, private repository-local temporary
storage, and the user's installed dependency tree. Actual native regression tests qualify
outside-root reads/writes, symlink and descendant escapes, host-loopback denial and cleanup. These
rows establish one small monorepo repair/retest journey per mode on their named heads; the complete final-head
task/mode matrix and Epic acceptance closeout are still pending.

## Resilience under gateway load (chaos)

A fault-injecting proxy between LiteLLM and the model server reproduces peak-load behavior through
LiteLLM's own error translation: transient 503s, a sustained outage, slow first bytes, cut and
stalled streams. Each scenario runs a short read-only Workbench task.

| Scenario                                                                                                      | Fault                                | Before #3873 fix                                                                                                             | After `96dea626f`                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 (`run-160539951766286374010123841380551879545`)                                                            | Two consecutive 503s                 | Succeeded: two `gateway.retry.scheduled httpStatus=503`, third attempt answered                                              | Unchanged                                                                                                                                                                  |
| S2 (`run-200616293656128296862231277116231111624`)                                                            | Six consecutive 503s                 | Succeeded after 2 min through the coding runtime's own retries while the breaker failed calls fast                           | Unchanged outcome                                                                                                                                                          |
| S3 (`run-25375349829665751763776417748572934887` before, `run-182517784091967961536977947703112405538` after) | Three-minute outage (every call 503) | Failed after 84 s (`run.settled failureCode=runtime-failed`); the timeline showed ten "provider rejected this turn" failures | Succeeded one minute after recovery; no failure shown; `gateway.circuit.wait reason=circuit-cooldown` and half-open probes reconstruct the wait; 25 backend calls in 3 min |
| S4 (`run-161385106722572506188896290651961875716`)                                                            | 120 s before the first response byte | Not measured                                                                                                                 | Succeeded in 183 s: the buffered coding call waited within its silence bound, no retry                                                                                     |
| S5 (`run-83653870021095650999006912108925298586`)                                                             | Connection dropped after 200 bytes   | Not measured                                                                                                                 | Succeeded in 56 s: the dropped attempt was retried and answered                                                                                                            |
| S6 (`run-252463349211388505302581079589241842283`)                                                            | Stall of 7 min after 200 bytes       | Not measured                                                                                                                 | Succeeded in 478 s: the attempt was abandoned when the proxy closed the socket and the retry answered                                                                      |
| S7 (`run-244786874752205127711023567487492251342`)                                                            | Call held open, never answered       | Not measured                                                                                                                 | Succeeded in 661 s: the 10-minute attempt timeout ended the hung attempt and the retry answered                                                                            |

S4 to S7 were run with the chaos proxy on the LiteLLM route after `86b7fc2a8`. The outage window is
the gateway configuration's `codingOutageWindowMs` (default 600000 ms, at most 3600000; `0` restores
the fail-fast attempt count for coding turns), so a customer whose peak overloads last longer can
raise it without a code change.

S5 was recorded before the proxy delivered the bytes that precede a `drop`: the connection was reset
before the first response byte (a failure before the response head), not cut after 200 bytes as the
Fault column says. The corrected proxy (`scripts/testing/coding-workbench-lab/chaos-proxy.mjs`)
delivers the bytes first, so the mid-body case still has to be run: re-run S5
(`node scripts/testing/coding-workbench-lab/chaos-suite.mjs --approve none --repo "$KEIKO_LAB_REPO" --scenarios S5`,
with the proxy spliced in as in the guide). S6 is not affected: its bytes were delivered before the
stall.

## Where the time goes (activity-log profile)

The per-turn profile below is derived from the Activity Log alone, by `scripts/testing/coding-workbench-lab/turn-profile.mjs`; its model times and generation rates are the lab route's (Ollama-specific until a vLLM run confirms). A model turn is a sidecar gateway request (`coding-sidecar.gateway.request-validated`) that the gateway dispatched: it starts with `gateway.stream.started` (the default for coding turns) or `gateway.chat.started` and ends with `gateway.stream.completed` or `gateway.chat.completed` (usage, finish reason), with `gateway.stream.failed` or `gateway.chat.failed` (a failed or output-exhausted turn) or with `gateway.stream.abandoned`; the gateway's readiness request has no started line and is not a turn. Time to the response headers is `http.gateway.fetch.completed durationMs` of the model's own fetch (the one after the attempt's `gateway.prompt.admission`, not the token-counter call before it); time to the first token adds `firstDataMs` of `chat.response.streamed`, whose clock starts after the headers, so prefill that happens after them is part of it; generation time is that read's `durationMs` minus `firstDataMs`, and the generation rate is completion tokens over it, shown only for a read that streamed. Tool time is `tool-catalog.invocation-settled durationMs`. An operator pause is a workspace-script trust wait (`coding-runtime.run.operator-decision` `waiting` to the recorded decision) or a runtime approval wait (`coding-runtime.approval.waiting` to `coding-runtime.approval.decided` or `.retired`, paired by `requestId`). The wall clock runs from the run's first event to `coding-runtime.run.settled`; its slices never overlap: model time first (accepted, failed and cancelled turns), then operator pauses, then tools, then the gaps between a turn and the next request, and `other` for what no slice claims.

| Run                      | Wall                        | Model turns | Model time                                                      | Tool time                                   | Operator wait                  | Completion tokens per turn                                 | Generation rate                                                                        |
| ------------------------ | --------------------------- | ----------- | --------------------------------------------------------------- | ------------------------------------------- | ------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| T2 `run-2605…3240`       | 293 s                       | 10          | 261 s (89 %)                                                    | 30 s (10 %; first verification 28.8 s, F14) | 0 s                            | 23 to 2,758                                                | 25 to 41 tokens/s                                                                      |
| T3 `run-9443…2444`       | 160 s                       | 6           | 158 s (99 %)                                                    | 1 s                                         | 0 s                            | 23 to 1,676                                                | 26 to 45 tokens/s                                                                      |
| T7a `run-6508…4666`      | 1,659 s                     | 17          | 1,464 s (88 %)                                                  | 4 s                                         | 189 s (workspace-script trust) | 34 to 4,491                                                | 13 to 49 tokens/s (two short turns of 119 and 598 tokens; the other fourteen 21 to 35) |
| T7b `run-3240…9441`      | 1,802 s                     | 7           | 1,784 s (99 %): 288 s accepted, 1,313 s failed, 184 s cancelled | 4 s                                         | 0 s                            | 126 to 3,773 (0 on the exhausted turns)                    | 18 to 32 tokens/s                                                                      |
| T7c `run-2721…9367`      | 1,802 s                     | 14          | 1,791 s (99 %): 846 s accepted, 834 s failed, 112 s cancelled   | 3 s                                         | 0 s                            | 289 to 5,676 (0 on the exhausted turns)                    | 20 to 37 tokens/s                                                                      |
| T4p `run-2356…2936`      | 240 s                       | 6           | 236 s (99 %)                                                    | 1 s                                         | 0.5 s (approval)               | 303 to 1,230                                               | 21 to 39 tokens/s                                                                      |
| T5v `run-7420…7735`      | 1,296 s (stopped)           | 13          | 1,232 s (95 %): 130 s accepted, 1,102 s failed                  | 0 s                                         | 0 s                            | 208 to 935 (0 on the failed turns)                         | 25 to 36 tokens/s                                                                      |
| T4 `run-1143…3470`       | 2,004 s                     | 16          | 1,988 s (99 %)                                                  | 6 s                                         | 9 s (three command approvals)  | 23 to 5,526 (the last turn is the compaction summary, F24) | 15 to 45 tokens/s                                                                      |
| T5 `run-1480…0040`       | 735 s (failed)              | 6           | 733 s (100 %): 199 s accepted, 534 s failed                     | 0 s                                         | 0 s                            | 173 to 1,412 (0 on the failed turn)                        | 16 to 30 tokens/s                                                                      |
| T5 (2nd) `run-2395…5472` | 1,419 s (recovery-required) | 18          | 1,415 s (100 %)                                                 | 1 s                                         | 0 s                            | 173 to 3,121 (0 on the empty-answer attempt)               | 15 to 30 tokens/s                                                                      |

Observations:

- Model time is 88 to 99 percent of the wall time (Ollama-specific until a vLLM run confirms: the
  customer's route prefills about seventy times faster (from an approximate token count), so its share will be lower). Reads, replacement
  edits and the lint verifier cost almost nothing, and the sidecar and BFF add no measurable gap between a tool result and the
  next model request: 0.14 s to 0.49 s in total over 5 to 16 hops in the runs without failed turns
  (about 30 ms per hop). The gaps of T7b (12.8 s), T7c (5.9 s) and T5v (61.7 s) lie between failed
  turns: they are the coding runtime's retry waits, not sidecar or BFF latency.
- The visible output of a turn is one tool call of a few hundred tokens; the rest of the 1,600 to
  4,500 completion tokens per turn is reasoning. The log does not record that share (gap:
  `reasoningBytes` and provider-reported `reasoningTokens` on `coding-sidecar.gateway.usage-settled`,
  in progress).
- The turn count is the lever. T7a spent eight turns reading six files in 100-line windows, one
  file per turn at about 90 s each (Ollama-specific until a vLLM run confirms). The governed system prompt now asks for whole-file reads, several
  reads in one turn, one edit call for all decided changes, and fixing every verifier finding before
  re-verifying; the repository-instructions loader (in progress) removes one more read.
- Prefill: the first model turn of every run pays about 22 s to process the system prompt and tool
  schemas; later turns pay 3 to 10 s for the new tail, and 23 s after a 2,900-token verifier
  result. A turn whose answer is a tool call without preceding reasoning arrives as one block after
  20 to 25 s of silence (`dataEvents=3`, `maxGapMs` up to 24 s): the upstream buffers tool-call
  tokens until the call is complete, so a streaming display shows nothing for such turns
  (Ollama-specific until a vLLM run confirms: a vLLM server may stream tool-call deltas).
- `reasoning_effort` is not a lever on this route. A direct probe through LiteLLM (same prompt, temperature 0, `max_tokens` 4096) answered identically without the field, with `low` and with `high`: 350 to 365 completion tokens, about 1,200 characters of `reasoning_content` and 27 characters of answer each time, no `reasoning_tokens` in the usage. The OpenAI-compatible Ollama route behind LiteLLM ignores the field, and `completion_tokens` includes the reasoning. The levers that remain are the output reserve of a coding turn, the steered repair after an exhausted turn, and the prompt's output-budget discipline (F17 package).
- Since `b489d2532`, `coding-runtime.run.settled` carries the run-level roll-up (turns, model time,
  prompt tokens, tool, read, edit, refusal, verification and operator counts and waits). Of this
  table's columns it replaces Model turns and Operator wait; Tool time, Completion tokens per turn
  and Generation rate still come from the child correlations, and the read, edit, refusal and
  verification counts it carries belong to the Results evidence cells, not to this table.
  `modelDurationMs` is the reserve-to-settle wall time of each model call, from the prompt-budget
  reservation before the gateway call to the settlement after it, so it includes every call's
  prefill, the failed and cancelled calls (settled with their kept estimate), admission and outage
  waits and the retry backoff between attempts; it is therefore at least this table's Model time,
  and smaller only by a call it cannot pair or whose settlement the authority refused.
  `promptTokensTotal` is a lower bound of the cumulative prompt tokens in the Results evidence cells.

## Findings

Findings are recorded when a run exposes them and link to the child issue that owns the fix.

| Id  | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Owner                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| F1  | The Workbench reports a repository below a denied read-surface path (for example `.claude/`) as "may not be a Git repository" although the Git window names the actual `DENIED` cause. Fixed in `5d7a1b4ee`: the repository selector names a denied read-surface path as the access decision it is, in English and German, instead of guessing a missing repository.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | #3873                                                                                                   |
| F2  | Answers are buffered end to end: the sidecar model profile does not stream, so a slow self-hosted model shows only "Working" until the whole answer exists. Fixed in `a24b3981c`: coding turns stream through `Gateway.chatStream()` and the model's text and reasoning appear live (reasoning in a labelled, collapsible block, default on, `codingStreaming`/`codingReasoningDisplay` switches).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #3873                                                                                                   |
| F3  | Model answers that use LaTeX notation (`$\rightarrow$`) are rendered verbatim in the Workbench timeline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | #3874                                                                                                   |
| F4  | Browser-dependent edits formerly refused `NO_ACTIVE_SESSION` after a bounded 11.75-second wait. Allowed Workbench changesets now reach the existing atomic Editor-owned transaction through an internal server capability, only with an exact registered no-review runtime lease and current granted run-root access. Required or unknown review retains the authenticated browser decision. Retained passive dirty targets, hashes, authority revocation, cancellation, idempotency and rollback remain enforced. Genuine no-browser/disconnected and safety RED/GREEN regressions passed in 504 affected tests; parent review reran 57 transaction/root tests. Real Gemma full-repository runs on `fb79f94fa` completed the fail → read → server edit → exact-file pass loop after browser disconnection in Full access and Supervised workspace, with no later approval or active bridge. Ask for approval completed through its required browser review and verification decisions on the same head. The complete Epic matrix remains open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | #3873                                                                                                   |
| F5  | Repeated refusals are not escalated: the run logged 11 `coding-runtime.edit.refused reasonCode=NO_ACTIVE_SESSION` lines under its correlation until the operator stopped it, instead of settling with a visible cause. The refusal line carries no body-free changeset digest, so the log cannot show whether the attempts repeated the same edit. Fixed in `5d7a1b4ee` and refined by the server package of this pull request (ADR-0137 D3): a streak of refusals ends the run whatever the mix of their closed reasons, `edits-blocked` after three refusals no edit of the model can repair (no session or bridge, lost access, a denied path or policy, a pending approval, a failed preparation classified by its cause) and `edit-retries-exhausted` after six refusals in all (an edit that does not apply, a stale base), with one `coding-runtime.run.refusal-escalated` line and `failureBasis=refusal-escalation` plus `refusalReasonCode` on `coding-runtime.run.settled`; a human's review rejection and a cancelled preparation never count. A changeset digest on the refusal line remains a follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | #3873                                                                                                   |
| F6  | The composer submitted a different text than it displayed: an earlier, invisible draft was restored by "New task" and the visible text was inserted into it. Tracked as a human-control-invariant defect in #3877 (opened 2026-10-06). Not yet reproduced on the current head: the automated runs fill the composer programmatically and verify the text before starting, so a human typing sequence after "New task" is still needed; the run start line records no digest of the submitted text today, which #3877 adds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | #3874                                                                                                   |
| F7  | Governed tool results reached the model as the tool facade's JSON text, so file content arrived JSON-escaped. Gemma copied `\"` into patch context (INVALID_EDITS) and into added lines (a test file that no longer parsed; edit fidelity is Ollama-specific until a vLLM run confirms). Fixed in `e416fa602`, framing finalized in `8f26f0b89` (nonce-framed text blocks). Re-qualified on `0cdfc3668` by `run-260534492606570569312058189946359293240` (T2) and `run-94438080752319905248418742401687102444` (T3): four of four edits applied, no `INVALID_EDITS`; the residual refusals of `run-2684…` were the unified-diff edit form (F12), not the framing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | #3873                                                                                                   |
| F8  | The cumulative run prompt budget (200,000 tokens) ended the first Supervised bug-fix run after 19 turns (182,283 tokens). Root cause was the refused-edit loop of F7: after its fix the same task needed 67,032 tokens in 10 turns, so the default stays and the loop is fixed instead (ADR-0137 records the measurement). Superseded by F15: the per-turn prompt growth of a longer task, not a loop, later ended T7a, and the default is now 2,000,000 tokens (owner decision of 2026-10-07, ADR-0137 D2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | #3873                                                                                                   |
| F9  | A budget-exhausted run is shown as "The model or a Workbench guard rejected this turn" followed by "The coding run ended with an internal error"; neither names the exhausted budget or a next step. Fixed in `b489d2532`: `coding-runtime.run.settled` carries a closed cause (`prompt-allowance-exhausted`, `envelope-duration-exhausted`, `output-exhausted-repeated`, `provider-unavailable`, `model-turn-failed`, `runtime-failed`) with `failureBasis`, the Workbench explains it in English and German, and the line carries the run's effort roll-up (turns, model time, prompt tokens, tool, read, edit, refusal, verification and operator counts and waits).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | #3873                                                                                                   |
| F10 | A gateway outage longer than about 90 seconds failed every running Workbench task: a coding turn stopped after three attempts, an open breaker refused further calls at once without a provider `Retry-After`, and the coding runtime gave up after about ten retries. Mitigated: `96dea626f` (outage window and breaker wait for coding turns) and `86b7fc2a8` (admission wait bounded by the window); the window is `codingOutageWindowMs` since `0cdfc3668`. The streamed coding path and the explicit `outagePolicy` signal landed in `cf36ebe8b` (window effective instead of clipped, `retryPolicy` on the retry lines); S3 is re-run on the final head with streaming on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | #3873                                                                                                   |
| F11 | While a run waits for an unavailable gateway the Workbench shows only "Working"; it does not say that the model gateway is unavailable and being retried. Partly addressed in `a24b3981c` (live text and reasoning instead of a blank Working); the status line with elapsed time and phase lands with the UI package. Fixed together with `b8ed267dc`: the status line names the phase (waiting for the model) and the elapsed time while the live stream shows the model's text and reasoning. The phase also names a model gateway that is unavailable and being retried ("Model gateway unavailable, retrying"), from the retry facts the sidecar route publishes (ADR-0137 D9, #3873 review). One gap stayed (review thread 6px-fR): the observer heard only a retried attempt, so a call that waited to be admitted behind the open breaker, a saturated half-open probe or a provider cooldown before its first attempt still read "Waiting for the model". Closed with the `admission-wait` notice: the wait is announced the moment it starts and settles like a retry, and the sidecar publishes it as the same retrying fact (`retry-surfaced` records `waitReason`). The next review round (threads 6pydFf, 6pydQZ) made the fact follow the newest frame of the replay: it is published again when a later frame hides it while the call keeps retrying, counted only when the replay took it, and a call the run cancelled while it was retried is closed with `model-gateway-retry-stopped` instead of leaving "retrying" standing; a retry observer that throws is absorbed in the call's announcer and recorded as `gateway.retry.observer-failed`.                                                                                                                                                                                                                                                                                                                                                                      | #3873                                                                                                   |
| F12 | A strict unified diff is a poor edit form for the model: two of three Gemma patches were refused (`INVALID_EDITS`) over hunk headers and context even after tool text reached the model verbatim (edit fidelity is Ollama-specific until a vLLM run confirms). `keiko_changeset_edit` now takes exact text replacements (`edits`: file, `oldString`, `newString`, `replaceAll`), the form coding agents are trained on; the server materializes them, against the hash-bound current file, into the unified-diff changeset the governed editor path already validates, reviews and applies. The replacement form landed in `0cdfc3668`. The managed-runtime dialect requires every declared argument, so the diff form is no longer model-visible. The materializer repairs from the review (bounded `replaceAll`, budget charged with the materialized diff, governed reads, owner digest, per-line endings, selection gaps, closed `replacementRefusal` class) and deletions/renames landed in `a24b3981c`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | #3873                                                                                                   |
| F13 | The keiko-tools patch engine dropped the `\ No newline at end of file` marker, so every governed edit silently appended a final line break to a file that had none. The parser now keeps the marker on the line it annotates and application honours it as Git does (ADR-0006 D4); a marker that contradicts the current file is a conflict. Fixed in `0cdfc3668`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #3873                                                                                                   |
| F14 | A targeted-test verification took 28.5 s in the live run, with no log line between `editor.verification.workspace state=acquired` and `released`; the same path measured 236 ms when called directly on the same repository. The cause cannot be reconstructed from the log: `editor.verification.execute state=completed` carries neither step durations nor the sandbox backend that ran the step. Fixed in `b8eddc342`: `editor.verification.execute state=completed` now carries `durationMs`, `maxStepDurationMs`, `outsideStepsMs`, `probeDurationMs`, the per-verifier status and duration, `isolationBackend`, `isolationAvailable`, `networkEnforcement` and `dependencyBootstrap`, so the 28.5 s is attributable to the step (container start on a cold daemon is the unverified suspect), the bootstrap or the probe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | #3873                                                                                                   |
| F15 | The cumulative prompt allowance of 200,000 tokens ended a legitimately progressing 13-finding lint task after 17 turns (T7a, `coding-sidecar.gateway.rejected reason=runtime-prompt-budget-denied`): the per-turn prompt grows with every tool result, so the sum grows quadratically with the turn count. ADR-0137's premise that only a refused-edit loop exhausts the allowance is disproved. Fixed in `cf36ebe8b`: default 2,000,000 (maximum 20,000,000) with the existing `KEIKO_CODING_RUNTIME_MAX_PROMPT_TOKENS` opt-down; ADR-0137 D2 records the evidence. The owner confirmed this default and the 120-minute envelope on 2026-10-07 (ADR-0137 D2, `0476fa926`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | #3873                                                                                                   |
| F16 | The run envelope expires 30 minutes after minting (`maxRuntimeMs`, `expiresAt`). T7a reached 27.5 minutes at the normal pace of a 31B model with reasoning (about 90 s per turn, Ollama-specific until a vLLM run confirms), so an ordinary multi-file task would hit that wall next. Fixed in `cf36ebe8b`: `KEIKO_CODING_RUNTIME_MAX_DURATION_MINUTES` (default 120, maximum 480), `maxRuntimeMs` on `coding-runtime.authority.minted`, the safe-activity projection TTL and the per-run OpenCode turn wait follow the configured duration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | #3873                                                                                                   |
| F17 | A reasoning turn can exhaust the per-turn output cap (`maxOutputTokens=8192`) without producing a tool call: T7b's fourth turn ran 406 s to `chat.response.streamed outcome=failed outputExhausted=True`, the gateway reported `gateway.retry.exhausted reason=terminal`, and `coding-sidecar.gateway.turn-failed failureCode=output-exhausted runtimeRetry=allowed` let the sidecar retry the identical turn, which ran away identically (396 s) and a third time. Nothing steers the model and every attempt costs about seven minutes. Fixed in `0becadce8`: one steered repair with a fixed correction (also after forwarded reasoning), `runtimeRetry=refused` after a second exhaustion, a coding-turn output reserve of at least 16,384 tokens (the 8,192 was a Keiko default, not the provider's limit), `repairAttempted`/`repairOutcome` on the sidecar lines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | #3873                                                                                                   |
| F18 | The original 64 KiB whole-file helper ceiling refused even a small line window from a larger file and omitted Keiko's own AGENTS.md. PR #3895 raises the pinned whole-file bound to 1 MiB, retains whole-file edit digests and native identity checks, keeps model windows at 64 KiB and initial instructions at 16 KiB / 800 lines, and allocates only the observed file size plus one growth-detection byte. Targeted protocol and window regressions cover admission, exact-boundary refusal, oversized model windows and body-free evidence. Global / walk-up instructions and files above 1 MiB remain capability gaps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | implemented for rebuilt helpers; legacy compatibility and final-head live qualification pending (#3873) |
| F19 | The Workbench timeline tells the user almost nothing about what the agent is doing: an expanded entry shows only the canonical tool name (`keiko_workspace_read`, `keiko_verification`); grouped reads ("Workspace read, 7 calls") list no file names, a failed verification shows no verifier kind, status or counts although the server records the kind, status, counts and the number of failure locations body-free (`coding-runtime.verification-summarized`; the locations themselves are workspace paths and stay out of the Activity Log, so a timeline that shows them reads them from the run's runtime events or the tool result), and no entry carries a duration. Observed in the UI review of T7c. Fix planned on the timeline after the streaming display lands: per-call rows with the workspace-relative path, verifier kind with pass/fail counts and the first failure locations, and the settled `durationMs`. A refused edit is shown as "Changeset Edit Failed" with no reason (T7c: two `INVALID_EDITS`); the closed refusal class and the affected file belong on that entry. Status: the log side landed in `a24b3981c` (the closed `replacementRefusal` class and `deletionCount`/`renameCount` on the refusal and mutation lines); the verifier-detail increment at `6f8f54584` forwards the actual verifier kind, status, step counts and measured duration through strict canonical/SSE validation and owned immutable replay into the expanded timeline. Counts name verifier steps, not assertions. Targeted contract/producer/hub/orchestrator/UI tests passed. The following canonical per-call increment adds completed-read paths, returned bytes/whole-file lines, discovery entry counts, closed edit refusal/known affected path and bridge service duration on the existing safe-activity stream. It passed 20 contract, 380 server and 105 UI/i18n tests; parent review reran 135 focused contract/server/discovery tests and 105 UI tests. Served-browser detail qualification remains pending. | #3874                                                                                                   |
| F20 | Composer and status UX, from the same review: the model and authority listbox options expose no accessible name; the selected model chip truncates to `gemma-4-…`; the run status line leads with technical readiness facts ("Subscription authentication not selected", "unverified evaluation runtime") instead of state, elapsed time and phase; after a reload a settled run shows only the previous conversation without its timeline or failure cause; the last-used model is not remembered (the composer falls back to the first provider). Fix in progress in keiko-ui (accessible names, full model id, user-facing status first with elapsed time, restored timeline and terminal cause, persisted model selection next to the persisted mode selection). Fixed in `b8ed267dc`, except the attempt counter of F21: accessible option names, full model id, status line with state, elapsed time and phase first and readiness facts in a disclosure, restored timeline row with the terminal cause, remembered model choice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | #3874                                                                                                   |
| F21 | During the sidecar's automatic retries of a failed model turn the Workbench shows only "Working": no attempt counter, no elapsed time, no phase (waiting for the model), while the per-turn "Failure reported" box tells the user to change the gateway's `max_output_tokens` or the model although the run is retrying by itself and cannot be reconfigured mid-run. Observed in the browser during T7c. Status: in part. The status line with state, elapsed time and phase landed in `b8ed267dc` (with F20). Open under #3874: the attempt counter, and a per-turn failure text that names the automatic retry and keeps the operator advice (`max_output_tokens`, another model) for the terminal failure; the `6f8f54584` timeline now keeps active turn failures factual, names automatic retry only when observed, and reserves operator repair advice for terminal failures. Recovered and historical-run controls pass; complete live retry/attempt-counter qualification remains pending. The gateway facts that name an unavailable gateway being retried (ADR-0137 D9) state the outage once per call, not per attempt; the `gateway.retry.scheduled` lines record every attempt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | #3874                                                                                                   |
| F22 | An unpaired Workbench window (a plain reload without the launcher's app session) shows a cascade of five overlapping notices at once: "Workbench is not paired" inside the status sentence, "The coding task could not be loaded or updated", "The approved skills could not be read", "Activity not connected", "Edits are paused: reconnecting the editor bridge", and an "INPUT NEEDED" card whose content it cannot show. The pairing requirement is right; the presentation should be one coherent state ("This window is not paired. Open Keiko from its launcher.") with the secondary surfaces quiet. Observed in the browser during T4p. Follow-up issue #3880, not in this pull request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | #3880                                                                                                   |
| F23 | With streaming on, a turn that ends after reasoning without a tool call or text (`empty-answer`) loops: T5v's turn 5 reasoned about 4,500 tokens, generated a tool call during a 76 s gap that the upstream never delivered (Ollama-specific until a vLLM run confirms; only finish and usage events followed; the request was identical to the successful turns, and a direct probe shows large tool calls normally arrive as one `delta.tool_calls` event), and seven identical sidecar retries followed. Two defects make it a loop: the steered repair of F17 covers `output-exhausted` only, so `empty-answer` keeps `runtimeRetry=allowed`; and the failed turn's forwarded reasoning stays in OpenCode's history and is resent, adding about 6,200 prompt tokens and two messages per attempt. Fixed in `d2841c761`: an empty answer after reasoning gets the same one steered repair (`gateway.retry.scheduled reason=empty-answer-repair`); a second empty answer is final (`repairOutcome=empty-again`, `runtimeRetry=refused`); reasoning-only assistant messages are dropped from the resent history (`droppedReasoningMessageCount` on `coding-sidecar.gateway.request-validated`); and reasoning is forwarded only on an explicit `reasoningDelivery=forward` that the coding sidecar route alone sets, so the commit draft no longer receives it. Confirmed live on `2e830ff7a` (T5, `run-1480…0040`): one steered repair, `repairOutcome=empty-again`, `runtimeRetry=refused`, the run settled `model-turn-failed` after two attempts and 534 s instead of seven attempts; `droppedReasoningMessageCount=0` on every request and a flat prompt estimate (5,230 to 7,471 tokens over six turns), so OpenCode did not resend reasoning inline either. The task itself still failed on this model: the empty answer is the model's, the bound only stops the loop.                                                                                                                                                           | #3873                                                                                                   |
| F24 | Historical T4 waited 12.6 minutes after its final answer for a large automatic compaction; no compaction evidence identified the delay. Pinned OpenCode 2.0.10 now projects running/completed/failed native compaction onto existing body-free lifecycle operations, with hashed IDs and explicit tail-presence facts. 134 unit tests and one actual native completion/failure case passed. Native compaction observation never settles a task or disables overflow recovery. The historical delay has not been reproduced on the current native version and remains open; final-answer text alone is not a safe settlement trigger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | #3873                                                                                                   |
| F25 | A run orphaned while `starting` blocks the repository: the dev watcher restarted the BFF 1 s after a Full-access run was accepted (`coding-runtime.run.started state=starting`, then `coding-runtime.run.shutdown stateBefore=starting reason=server-shutdown outcome=refused failureCode=invalid-intent`). On the next server the run was `recovery-required`, `hasLiveRun()` still counted it, and every repository selection answered 409 `LOCK_CONTENTION` ("A coding run is still active"), across two automatic restarts and one clean `dev:stop`/`dev:start` (`coding-runtime.run.shutdown stateBefore=recovery-required outcome=refused failureCode=recovery-required`); the operator's Stop answered 409 `CODING_RUNTIME_RECOVERY_REQUIRED`. The persisted workspace carried no lock (`lock_json` empty, `active`, `healthy`), so the workspace store was not the cause. The product's way out is the Workbench's recovery acknowledgement (`POST …/runs/{id}/recovery-ack`, `coding-runtime.run.recovery-acknowledged`), which the lab driver does not perform; after it the next start superseded the orphan, while the repository selection still answered 409 because `hasLiveRun()` counts an acknowledged `recovery-required` run until its replacement starts. The startup-abort path is repaired in PR #3895: shutdown/stop/takeover abort preparation, the manager refuses a post-cancellation spawn, and late results cannot dispatch or overwrite the proven settlement. Targeted regressions retain recovery for unproven containment. Repository activation now uses the existing host health and recovery acknowledgement: a stopped host with acknowledged recovery permits selection without hiding the retained row; unacknowledged or unreaped recovery still refuses. Both HTTP guard checks remain, including the body-arrival race regression. Final live restart qualification remains pending. Observed while starting the catalog's T5.                                                                  | #3873                                                                                                   |
| F26 | An escalated run loses its cause at the stop: `observeEditOutcome` queues the settlement `failed` with the escalation as the cause, `settleTask` stops the runtime, and `settleStoppedTask` then compares the stopped runtime's terminal result with the outcome; a runtime stopped mid-turn reports `cancelled`, so the comparison fails and the run transitions to `recovery-required` (`coding-runtime.run.settled state=recovery-required terminal=false`) with a lifecycle diagnostic `runtime-stopped-live`, instead of `failed` with `failureBasis=refusal-escalation` and `edit-retries-exhausted`. The Workbench shows "Recovery required" without the cause, the operator must acknowledge the recovery, and the repository stays blocked meanwhile (F25). Seen in T5's second attempt on `2e830ff7a`. Status: fixed in `b0831b37f`: `settleStoppedTask` settles an escalated run on its escalation whenever the runtime stopped, whatever terminal status the stopped runtime reports (ADR-0137 D3); pinned by `codingRuntimeOrchestrator.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | #3873                                                                                                   |
| F27 | A new file cannot be created through the replacement form: the governed read of a path that does not exist answers `denied`, never `not-found`, because the secure-read helper has no not-found status (a missing file is `access-denied`/`invalid-path`, mapped to `denied`) and nothing else produces the `not-found` the read-edit port expects before it creates the file. T5's second attempt tried six times to create the test file its task asked for (`coding-runtime.workspace-read state=failed purpose=edit-materialization reason=denied` x6 on one path) and the run ended. The unit tests did not catch it: their reader stubs answer `not-found` for a missing path, which the production port never does. Parity row T06 (`governed`) is wrong until this is fixed. Seen in T5's second attempt on `2e830ff7a`. Status: fixed: the governed read answers `not-found` for a missing path only after a no-follow walk under the live root proves every earlier component a real directory on the root's own device (`secureWorkspaceTextReadAbsence.ts`); the deny list is checked before the helper, and every other refusal (an existing or denied path, a link in the chain, a file used as a directory, another device, an unusable root) stays `denied`. End-to-end file creation through the replacement form is pinned by `codingToolFileCreation.test.ts`; A real Full-access task on `fb79f94fa` created one initially absent deep React test file through the production replacement form, then passed its exact verifier before succeeding (`run-136876840668165455691095236984259608915`, five accepted turns, no product-source edits). Parent inspection preserved meaningful keyboard assertions and confirmed existing-test hash stability. The complete final-head standalone parity matrix remains pending.                                                                                                                                                                                              | #3873                                                                                                   |

### Original Read parent with governed native file IO (ROOT qualification on 0b80)

The private original-Read lifetime now forwards the existing logged `readBytes`, `stat` and `list`
primitives without substituting the public text parser. ROOT independently verified 187 frozen
producer/evidence inputs, reproduced five genuine unchanged-producer failures for legal native
paths/root/zero pagination and exact handler capture, and integrated the incremental producer once.
The prior captured profile and accepted-initialization owners remain present.

The final nine-suite owning run passes 709 tests with one Linux-only invalid-UTF-8 filename control skipped on
macOS. The seventeen-owner strict check and forced affected graph pass. The original pinned
Node24.18/OpenCode2.0.10 driver uses current ROOT compiled producers and a controlled same workspace:
ten Read cases have identical serialized result, permission and instruction-event digests. The
comparison includes a 1,860,894-byte source page, directories/root, a 588-byte UTF-8 relative path,
zero-page facts, forty ordered ancestor instructions and original Read-level PNG/PDF output.
Ten actual catalog admissions/settlements retain their one-parent accounting through 61 actual
helper children, peak eight, all closed. A separate controlled real helper is held on stdin and
cancelled; its actual close precedes parent settlement and fresh bounded cleanup succeeds.

The proof uses a private fixture verifier and controlled instrumentation; it grants no release or
production authority. The pinned native SDK tree is unchanged. Current Keiko package aliases are
bound explicitly for the instrumented producer import; the initial old-contract import error and
incorrect proof working directory are retained as setup failures. Media snapshot normalization is stubbed in this comparison and model
media acceptance remains unqualified. Native host/HTTP/profile advertisement, global/external
instructions, contained symlinks and the full original Files surface remain acceptance work.

### Private npm service-host package (ROOT qualification on 4e6b)

ROOT independently verified the six frozen packaging owners and 45 input/evidence references,
then reproduced the unchanged npm builder's missing-host failure through its actual CLI candidate.
All six current source baselines matched the frozen baseline before the minimal source integration.
The final owning checks pass 61 builder/archive tests, 23 affected portable-staging controls,
four-script syntax/lint and six-file format. The new path produces a private unapproved candidate;
ordinary CLI packaging, public runtime pins and release selectors retain their existing behavior.

ROOT independently extracted the frozen 175,591,602-byte archive through the current production
archive owner and measured the complete payload with the existing stable tree attestor. Its digest
matches the frozen receipt. The retained host has 34,942 ordinary single-link files totaling
466,463,641 bytes, with the locked original dependencies and Node 24.18.0. The SBOM retains its
original root exactly once and includes Node; installed alias manifests and license files remain.
This independently qualifies the named frozen candidate, not a fresh final-head release build.

Three actual extracted-executable controls preserve original authenticated HTTP, SSE, session
Location, canonical database, stdin-EOF/socket closure and stale-state refusal in direct/Code Mode,
with no model requests. Thirty-six original host/entry/guard controls also pass against the actual
extracted dependency modules. The PTY upgrade control uses a fixture attachment and does not prove
real terminal execution. Production native IO authority, full tools and platform approval remain
open. The exact spdx-exceptions 2.5.0 CC-BY-3.0 policy disposition remains open; the private receipt
records its license refusal, without dropping that dependency or claiming approved distribution.
Package size, final source-build provenance and fresh payload performance remain qualification work.

### Background model inventory reconciliation (ROOT qualification on 24d072)

ROOT independently verified all nine frozen source owners and 77 source/evidence references, then
ran the new catalog suite against the unchanged production owners. Ten of its 24 controls failed
for actual inventory, complete-empty, incomplete-response and credential-rotation behavior. The
minimal integration records real discovery provenance and reuses the existing configuration holder
to retain the accepted connection source while replacing only its active inventory. New models,
removed models, disappearance of the final model, subsequent recovery, stale results and metadata
saves are covered through the actual producers. Explicit and unspecified legacy selections retain
their compatibility behavior; a listing is never treated as live serving proof.

Reload still returns the local model projection immediately and only triggers the shared background
worker. Complete runtime listings can reconcile automatically discovered rows; incomplete listings
cannot silently remove rows, and fresh onboarding retains its strict empty-catalog validation.
Credentials remain sealed against the accepted source even after its active inventory becomes empty.
The ROOT owning checks pass 260 model-configuration tests and 517 server tests, scoped strict types,
zero-warning lint, fourteen-file formatting and the forced affected package graph. The registered
log catalog's 97 controls and all twelve error-observability controls pass. An inadvertently invoked
aggregate also ran 143 log scenarios successfully, but its architecture stage reported stale
catalog performance evidence; that final-gate artifact is still pending and is not a green release
claim. An initial standalone diagnostics import used stale compiled output; the fresh graph and
rerun supersede that setup result. Positive serving-readiness expiry, stale LiteLLM key/team grants
and optional cached health remain separate acceptance work. The customer-version source audit is not a live customer-gateway test.

### Original initialization over the existing tool route (ROOT qualification on 2ba69)

ROOT independently matched the frozen transport's 3,430 source/input/evidence references and
merged only its eight incremental owners with the published original-Read IO changes. The single
append-only test conflict retains both test families. The unchanged actual bridge fails the new
initial-scope test because it returns no admitted scope. The integrated path uses the existing
authenticated tool route, accepted STARTING callback, one physical gate and canonical KSS3 codec.

The ROOT owning run passes 266 tests across the three affected suites, eight-owner strict types,
zero-warning lint, fourteen-file format, the fresh affected graph, 97 catalog controls and twelve
error-observability sites. The current inventory resolves 539 proofs and all thirty scenarios.
The ROOT actual pinned original graph compares forty ordered ancestor instructions in the same
controlled workspace through real HTTP and current compiled producers. Its output digest equals
the original graph; 87 actual helper children peak at eight and all close. Initial acquisition
consumes zero model tool calls; a subsequent actual Read consumes its one parent allowance. Binary,
zero/empty ranges, directories, negative timestamps and original technical-unavailable behavior
retain their meaning. A separately held real helper makes first disposal refuse and preserve state;
the same gate stays busy until actual reap, then a fresh disposal removes state. No Effect or socket
closure is accepted as physical drain.

The first local tests/proofs loaded the preceding compiled registry before the new operation was
generated; two registered-line controls failed and private diagnostics recorded registration
mismatch. Those intermediate logs remain separate. Generation followed by the fresh affected graph
and repeated controls qualifies the final current registry. The synthetic supplementary host-byte
fixture and controlled watcher stream prove this private transport only. Actual host ready lifecycle,
Read-parent HTTP integration, trusted advertisement/history and full native Files/configuration
functionality remain acceptance work; this change activates no production host or model tools.

### Original host initialization and fixed npm assets (ROOT qualification on ad7fa6)

ROOT independently matched nine source baselines and 174 frozen source/input/evidence references.
The unchanged actual original host fails the new callback control without entering initialization.
An earlier test-only builder run lacked the new asset helper; that setup failure is retained and is
not the native behavioral regression. Minimal integration passes 47 original host/entry/guard
controls and 87 artifact/package controls, scoped strict types, zero-warning lint, formatting,
the fresh affected package graph, 97 catalog controls and twelve error-observability sites.

The ROOT original-host proof uses the actual pinned 2.0.10 graph and current compiled producers.
Its single accepted-root instruction exactly matches the standalone graph through five actual
helper children, peak one, all closed. Initial acquisition consumes zero model tool calls; a
subsequent actual Read consumes its one allowance. A separate controlled Location/Project proof
matches forty ancestor instructions through 123 actual children, peak eight, all closed. This is
not genuine VCS discovery. A held actual helper makes disposal refuse and retain state; the same
physical gate remains busy until actual reap, after which fresh disposal removes state.

ROOT independently extracted the new 175,599,204-byte private archive with the production archive
owner and attested its complete 34,945-file, 466,508,541-byte payload. The frozen receipt matches
the measured tree. Twelve fixed source/generated assets match current ROOT producers byte for byte,
including the canonical codec, workspace deny policy and lock. The extracted original host also
matches the one root instruction over real HTTP and preserves technical-unavailable behavior,
with zero model requests. A second complete tree measurement after execution remains identical.
These controls qualify this private frozen artifact, not a production release or service readiness.

The controlled watcher, supplementary host-byte approval and helper verifier remain private proof
fixtures. Original Git metadata/process discovery, global/above-root instructions, watcher refresh,
full Files and tools, actual host ready lifecycle and platform qualification remain open. The exact
spdx-exceptions 2.5.0 CC-BY-3.0 license refusal is retained; public runtime pins and selectors remain
unchanged. Further parity work belongs to the open epic after the bounded customer-fix PR closes.

### Finite serving readiness and background renewal (ROOT qualification on e46b11)

ROOT independently matches ten source baselines and 38 frozen source/evidence references. Four
actual unchanged-holder controls fail for expiry, malformed/future timestamps and separately dated
chat freshness. Minimal integration passes 659 tests across six owning suites, ten-owner strict
types and zero-warning lint, fifteen-file formatting and the fresh affected package graph. All 97
catalog controls, twelve error-observability sites and 539 proofs/thirty scenarios resolve. The existing probe
owner records actual serving readiness for five minutes and renews success after four minutes,
through its existing two-slot queue and generation/model in-flight map. Reload returns the current
projection immediately, even while catalog discovery or renewal is held; selected requests join
that same work. Removed models and superseded credentials cannot receive late readiness results.

Chat-only renewal preserves feature `checkedAt` and records the real `conversationCheckedAt`.
Completed catalog reuse compares actual connection identity, so a producer-derived timeout-bounds
refinement does not repeat discovery; credential header/protocol rotation does. The original causal
correlation is preserved. Retained intermediate evidence includes the genuine eager circular-import
`NaN` timer regression and its runtime-calculation repair, the unchanged causal baseline failure,
and obsolete fixture timestamp/count corrections. A weaker initial queue transcript does not
replace the corrected settled-producer regression. No cached health API or inference-triggering
automatic health request is introduced. New-run Coding serving/picker admission is the remaining
bounded customer fix; this increment does not age-strand an already admitted coding session.

### Original Read parent over existing HTTP (ROOT qualification on 9c2f64)

ROOT independently matches 92 frozen source/input/evidence references and merges only the four
incremental owners. Three baselines match directly; the existing formatting-only test delta merges
without conflict and preserves both prior test families. The unchanged actual bridge fails one
new admitted-parent control because its public fallback supplies no native identity. Final ROOT
checks pass 212 tests across the two owning suites, four-owner strict types and zero-warning lint,
ten-file formatting, the fresh affected graph, 97 catalog controls, twelve error-observability
sites and all 539 proofs/thirty scenarios. The first owning run loaded the prior compiled refusal
vocabulary and failed one registered-line control; generation, fresh compilation and the final
repeated run supersede that retained intermediate result.

The ROOT actual pinned-original proof compares eleven same-workspace Read cases through the real
authenticated route, preserving output, permission and instruction-event digests. Large native
ranges, a 588-byte relative path, forty ancestor instructions, directories, binary/media-level
output and an original missing-file Tool.Error retain their semantics. Eleven canonical admissions
and settlements cover 63 actual helper children, peak six, all physically closed. One additional
actual helper is held on stdin and its HTTP caller disconnected; after twelve milliseconds the
child is closed and its canonical parent terminal. This is a measured private witness, not a
latency guarantee. The response is explicitly undelivered; actual child closure precedes terminal
settlement, and a foreign identity cannot cancel another admitted parent. Returned settlement also
joins actual physical work and the existing idempotent slot release before fresh admission.

The proof rebinds current ROOT producers and independently extracted pinned native modules. Media
normalization and helper verification remain fixtures; original model-media acceptance is open.
Genuine authority/Manager ready/session admission uses hermetic endpoint/supervisor readiness, not
an actually ready fixed original service host. The production host lifecycle refusal remains in
place; no native profile/tool advertisement or production activation is introduced. Further
service/configuration/native Files parity remains follow-up work in the open epic.

### New-run serving admission and truthful picker (ROOT qualification on 1ca5ecf)

ROOT independently qualified all seventeen current source baselines and 104 frozen references from
`frozen-gateway-serving17-9c2f/freeze.json` (SHA-256
`42326588e102536a9a90a010971997fcdf39d02863cfaf253130633928ac854d`). Test-only
integration against unchanged production reproduced fourteen failures: eight server admission/source
controls, four UI decoder/timer/selection controls, one shared eligibility control and one fresh
no-choice fallback control. The earlier input-manifest setup error is retained separately and is
not a product regression. The exact seventeen-owner source delta then passes **456 server/contracts
tests in three suites and 388 UI tests in four suites**, scoped strict server/contracts types, full
UI package strict types, and zero-warning owner lint.

New-run context mint and passive Coding readiness reuse the original selector over fresh positive
chat observations from the same current holder. Explicit negative results are unavailable; unknown,
expired, malformed or future successes are pending. The existing authenticated F73 route is exercised
successfully before and after crossing only the chat freshness boundary: the same captured request
continues through two delegate calls, while a new admission refuses as pending. Feature timestamp,
configuration and generation remain unchanged. This is a controlled route/delegate proof, not a
customer or model acceptance run. No new guard is inserted into already admitted requests.

The shared Coding eligibility helper excludes only explicit negatives. The existing picker retains
selected/saved unknown choices and disables Start honestly until recovery. Without a human choice,
it uses its existing first-offered ordering over fresh candidates. Failed models disappear and
recovered models return. Repeated verification-timer profile reads do not rediscover the catalog;
the existing projection poller and bus continue to deliver changes. No queue, poller, ranking formula
or logging subsystem is added. `conversation-not-ready` extends the owning readiness operation's
closed vocabulary and the EN/DE decoder/labels.

The first ROOT generator attempt retained two stale compiled-contract type diagnostics. Building
Contracts before generation, then rebuilding the affected server/editor graph, resolves them without
changing the frozen sources. Final canonical generation resolves **539 proofs/30 scenarios with zero
violations**. Final **97 catalog controls and 12 observability sites** pass against the fresh generated graph. Full local
quality, coverage, real Sonar analysis, fresh owner evidence, final-head live sandbox qualification
and formal review repair are the next phase. Feature scope is frozen after this increment; full
Standalone OpenCode parity and Epic #3871 remain open. No merge, auto-merge, native production
activation, public pin change or external publication is performed.

### Frozen-scope review closeout: readiness terminal and catalog refresh

ROOT independently matched all six source baselines and frozen handoff/evidence hashes, then
installed only the regression tests against the unchanged producers. Four server failures and two
UI failures reproduce the review findings: a valid tool call followed by unterminated EOF or an
original failure frame was admitted as a feature proof; an image-shaped cross-site GET could start
catalog refresh; the UI omitted the canonical refresh CSRF header and lost distinct caller
correlations when sharing an in-flight request.

The existing readiness reader now requires an original DONE/finish-reason terminal and rejects
original failure frames. The existing server CSRF owner protects only the explicit refresh GET;
ordinary projection reads remain passive. The existing UI request cache shares only the correlation
actually sent, and refresh requests carry the existing CSRF header. No additional worker, queue,
provider probe, logger or route is introduced. Existing failure/CSRF diagnostics remain the owners.

After integrating the coordinated server/UI producers, ROOT passed **237 server/model-gateway
tests across four suites and 222 API tests**, the fresh affected package graph, strict owning server
test types, full UI types, scoped lint and six-file formatting. These checks qualify this increment;
final global gates, required CI and live sandbox qualification remain pending. The immutable ROOT
input qualification is `root-closeout-first-review-inputs.json`; genuine baseline and final results
are retained separately as `root-closeout-first-review-{red,ui-red,green,ui-green}.log` in the private
scratchpad. Full Standalone OpenCode parity and Epic #3871 remain open; auto-merge remains off.

### Frozen-scope review closeout: exact file identities and cancellation

ROOT reproduced **ten unchanged-producer boundary failures, two Request-signal failures and the
old replacement-boundary fixture failure** before the repairs. The source-built C helper,
production Node process factory and secure port now retain leading U+FEFF in directory identities,
including collisions with plain names and BOM-only names; returned names can be read again. Rich
snapshots preserve BOM text so physical descriptor size remains consistent through the governed
read port. Ordinary text reads retain their prior BOM handling. Existing read lifecycle evidence
continues to be body-free.

The inactive fixed-host launch validator rejects inherited enumerable environment fields without
reading getters, while its existing forbidden-name and own-descriptor checks remain intact.
The inactive fixed POST seam validates and forwards a Request's effective abort signal and retains
an explicit init override. The existing replacement test derives its read boundary from the
production ceiling, uses short context lines, and keeps the independent rendered-patch cap proof.
Its accepted result is seven bytes below the read ceiling; this case qualifies materialization,
not the edit engine's separate source-file budget. ROOT retained intermediate fixture failures from
additional engine assertions separately; no production size limit or assertion requirement was
relaxed to make them pass.

Final ROOT verification passes **426 tests across five owning suites (one existing platform case
skipped), 20 native guard controls, owning strict types, the fresh server graph, scoped lint and
nine-file formatting**. The first unconfigured native full-test invocation refused the missing
qualified module root; the final run explicitly uses the previously qualified original dependency
tree. These are inactive prerequisite controls, not original fixed-host production activation,
new private-package qualification or customer/live-provider proof. Final combined dependency,
quality, coverage, Sonar and live qualification remain pending.

### Frozen-scope review closeout: gateway geometry and proof adoption

ROOT independently matched the three source baselines and all frozen evidence inputs, then
reproduced five catalog regressions and one capability-application regression against unchanged
producers. Declared input/output limits now retain their actual provenance independently, and
later metadata preserves smaller accepted or concurrent refinements. Model disappearance and
recovery retain the declared ceiling. Missing refinement support returns a retryable failure.
Capability adoption clears carried observations and restores only retained fields with the
original separate feature/chat timestamps; unrelated tool-only evidence cannot grant chat readiness.

ROOT passed **429 tests across two owning suites**, strict test types, a fresh affected server
graph, scoped lint and formatting. No new probe, operation, queue or logger is added. Genuine RED
and final GREEN receipts are retained as `root-closeout-geometry-{red,apply-red,green}.log`, with
source/evidence qualification in `root-closeout-geometry-inputs.json`. These scoped controls do
not replace final global gates, coverage, Sonar, live qualification or exact-head required CI.

### Frozen-scope review closeout: private dependency security

The inactive private host keeps original OpenCode core/server/util **2.0.10** and Effect rc112.
Its narrow overrides pair MCP client/core 2.2.0, replace only old provider-utils consumers with
4.0.33, and move OpenTelemetry core to 2.8.0. The two existing provider-utils 4.0.57 copies remain
unchanged. The js-yaml 3.15.2 library is retained while its argparse edge removes unpatched
sprintf-js. No public runtime pin, dependency root, vendor source or license policy changes.

ROOT freshly installed the exact private lock into an owned module root, checked its complete
dependency graph, and passed **all 50 current host/guard/entry controls** with pinned Node 24.18.0.
Seventeen actual-package old/fixed controls independently reproduce issuer-bound MCP refusal,
declared-size download rejection and baggage limits, while preserving original provider generate/
stream outputs and actual Effect span/log/metric export plus shutdown. An initial aggregate
expectation misclassified the old lifecycle invocation's final baggage-cap assertion; its actual
receipt proves the lifecycle passed while the old cap failed. Original logs and corrected
classification are both retained. Synthetic transports perform no real credential submissions.

Supported original frontmatter/YAML consumers pass. The unused upstream js-yaml CLI compatibility
comparison remains failed: help/version formatting and deprecation warnings differ with argparse 2. The supported private installation disables bin links and the original consumer uses the library;
this is a bounded compatibility limitation, not a green upstream CLI claim. Legacy issuerless and
static MCP credentials still require migration and an expected-issuer binding before activation.

ROOT matched all **434 actual package/version identities**, including alias targets, to the frozen
complete primary OSV input. Its remaining braces 3.0.3 advisory is unresolved with no patched
release: the actual watcher normalization exercised zero affected compile/expand calls, while direct
expansion still fails. This is not a vulnerability-free closure or waiver. Fresh installed SBOM
evaluation retains the existing **spdx-exceptions 2.5.0 / CC-BY-3.0** policy refusal. The host remains
`private-functional-unapproved` and unreleasable; no ignore, exclusion or approval override is added.
The earlier full private packed-tree proof does not qualify this changed dependency tree. A new
complete packed-runtime attestation and final global gates remain pending.

### Frozen-scope review closeout: credential sources and browser handoff

ROOT reproduced **nine credential regressions** against unchanged parser, vault and actual catalog
reconciliation producers. New aliases retain the accepted connection's private source binding,
resolve it after restart and key rotation, and never vault resolved environment bytes as an alias
credential. The actual source reference survives a transient override, and empty active inventory
does not destroy the accepted connection source. Unsafe or ambiguous source references refuse.
Safe frontend projections are unchanged. ROOT passed **735 tests across four owning suites**,
strict types, a fresh package/server graph, seven-file lint and formatting. ADR-0046 records this
existing parser/vault extension; no new secret store or credential-value-derived provenance exists.

ROOT also reproduced **five phase-one start failures**, followed by **74 green tests**. The actual
external opener exit and timeout now determine its existing outcome; a bounded desktop/profile
allowlist retains the environment needed to open the browser, excluding launcher/provider secrets.
Request-write failure preserves the healthy server and records the original failed outcome.
Collector and handoff use the same persisted install-layout correlation.

Phase two reproduces four behavioral failures plus five stale PID-format assertions. The current
channel advertises `browser-open-v1`; legacy PID/shutdown layouts remain accepted, and a legacy
process without that channel reports restart-required. The empty exclusive-publication window
remains pending, validated request parents and refusal classes deduplicate failures, and only verified
owner-private malformed or mismatched requests are removed. Unsafe artifacts remain refused and
retained. The separate intermediate safe-artifact regression and cold-import setup failure remain
in the frozen handoff evidence, with distinct classifications. ROOT passed **137 tests across four
owning suites**, strict types, seven-file lint and formatting. These controls establish successful
opener exit, not browser rendering, pairing-cookie delivery or native Windows execution.

ROOT regenerated the combined canonical catalog after a fresh Contracts build: **539/539 proofs,
30/30 scenarios and zero violations**; all **97 drift controls** pass after rebuilding the affected
graph. No new operation, browser transport, model queue or authority bypass is added. Final global
quality, coverage, Sonar, Linux owner evidence and live qualification remain pending.

### Frozen-scope review closeout: targeted verification and runtime admission

ROOT reproduced **12 functional failures** against the unchanged verifier and then passed
**239 owning tests across four suites**, including actual Vitest CLI invocation with the root
configuration and a nested project's own configuration. Nested test planning retains the admitted
repository execution root; failure locations resolve from the selected working directory and
remain contained in the original repository. Project `.npmrc` approval recognizes the same CR-only
line boundaries as the actual npm parser. Real directory/symlink refusal controls assert zero
spawns. Scoped strict types, fresh verification build, lint and formatting pass.

ROOT separately reproduced **four missing evidence/original-cause failures** at the existing
Workbench caller. With the repaired producer, **377 owning tests across seven suites plus 97
catalog drift controls pass**. Existing `editor.verification.execute` evidence carries bounded
project counts, selection digest and final refusal. The final project guard forwards its original
fault into the existing server diagnostic owner before producing a failed report. No new operation,
logger, public export or retired Editor agent surface is introduced. Existing ADR-0007 documents
actual project-configuration selection and the body-free evidence. ROOT's fresh Contracts build,
canonical generation and registry rebuild resolve **539/539 proofs and 30/30 scenarios with zero
violations**. These receipts are `root-closeout-verifier-events-{red,cause-red,green,generate}.log`;
source baselines and all 159 frozen references were checked independently.

Two actual runtime admission regressions also fail before the fix: a checked regular file replaced
by an unopened FIFO traps asynchronous attestation until a writer arrives, and write authority
revoked during the asynchronous bootstrap is still admitted to the handshake. Both existing
attestation owners now open descriptors nonblocking and retain descriptor-kind validation;
the manager checks its current write authority again after bootstrap and before handshake.
**198 owning tests across two suites pass**, with scoped strict types, lint and formatting.
The FIFO test creates a real owned FIFO and releases the unchanged blocking baseline during
cleanup; it is skipped on Windows and establishes no Windows FIFO behavior. Refusal uses the
existing cancellation/bootstrap failure evidence and existing child cleanup, without an authority
widening or premature physical-settlement claim.

The localized retry/status and embedding-report identity correction has **five unchanged-producer
failures followed by 76 owning UI tests**, full UI strict types, scoped lint and formatting.
Retry times follow the user's locale and clear on settlement; existing report identity/missing
identity labels use the existing English/German translations. This does not expand embedding or
Coding scope. The initial wrong-directory UI test invocation is retained as a setup error, not
product evidence. Final global gates, fresh Linux UI evidence and final-head live qualification
remain pending.

### Frozen-scope review closeout: catalog transport and readiness lifecycle

ROOT reproduced **seven unchanged-producer assertion failures** in the three catalog/body/renewal
suites, then passed **157 tests** with the frozen repair. The original HTTP body reader distinguishes
producer-typed malformed/oversized JSON from original transport failures; an actual transport
rejection remains retryable. Existing explicit or legacy deployments may obtain hidden management
metadata only for enrichment when their connection has no discovered-origin inventory rows.
Automatic inventory reconciliation still uses the caller-facing `/models` listing.

Background renewal now starts after two minutes within the unchanged five-minute serving lifetime.
The actual 119-second request control remains ready before expiry; both the provider's two-minute
floor and one minute of margin fit within that lifetime. Existing ADR-0171 documents the same rule.
No reload waits for this work and no new poller or queue is added.

ROOT separately reproduced **three Workbench queue/readiness failures and 17 stale HTTP-twin
fixture failures**, then passed their **40 owning tests**. The existing serial queue promotes an
already queued elected model without duplicating its Promise or active work. A successful but stale
observation stays pending and eligible for recovery; conclusive tool refusal cannot leave Coding
pending because another context probe was inconclusive. The twin derives its `/models` IDs from its
actual management fixture producer, without a second handwritten inventory.

The actual joined-startup disposal and startup retry-timer regressions both fail on the unchanged
applicable owners. With the repair, cancellation is initiated before joining startup work, reaches
actual request-owned I/O, and disposal still waits for original physical settlement. Recovery is
triggered by the existing production startup timer rather than a manual initializer call. The first
ROOT regex run omitted the new abort test and is retained as an incomplete selection, not RED proof;
`root-closeout-disposal-qualified-red.log` records both genuine failures.

ROOT's final combined slice passes **198 tests across five suites**, strict types over nine owners,
a fresh affected server/model graph, zero-warning lint, formatting and **97 canonical drift
controls**. Generation resolves **539/539 proofs and 30/30 scenarios without violations**. The JSON
classifier now explicitly rethrows each actual fault in its catch instead of hiding propagation
behind a returned never-helper. The existing static failure-path analyzer reports the new catch
before that correction and no finding for it afterward; all **103 owning HTTP tests** pass again.
No failure-path exemption, legacy-register addition, authority widening or feature activation is
introduced. Final global gates and final-head live/package qualification remain pending.

### Review closeout: actual edit-revision verification and follow-up ownership

ROOT independently qualifies diagnostic freeze `10ad424208b8e688c36b8dc8b981d9dcf04125ab41b9bbb90934467dd959b5d6`
and revision freeze `40bffdf54b6569bfc7e41f42f26cfc3acd83e5afedca30a3cf812158683424b1`
against published parent `3a1c5b12a492ce6ecf3306170e4fb63e98e07921`. The original
task-digest fixture correction is retained; frozen replacement tests do not restore its earlier
private state accessor.

The unchanged diagnostic owners reproduce **five genuine failures**, then pass **249 tests across
two suites**. Only applied edits establish a verification requirement; read-only diagnosis does not
invent a mutation obligation. Already admitted effects can settle during script-trust presentation
pauses without losing the run's effort accounting.

The revision test-only baseline records **25 failed and 607 passed assertions across six suites**.
This includes missing newly introduced observer methods and their prerequisite assertions, not 25
independent behavioral defects. The frozen genuine regression set covers two real pre-edit verifier
admissions, two unavailable-target controls and strict legacy-wire compatibility. The producer
captures the actual edit revision before verifier execution or script-trust waiting, and the existing
ledger checks that revision instead of wall-clock ordering. Skipped/unavailable checks cannot erase
a previously required failing target or a real fresh pass. The optional nonnegative wire fact and
body-free operation field use the existing contracts and logging owner.

After exact source integration, ROOT's first fresh-graph run passes 630/632 tests; two existing
formatter proofs refuse the stale generated operation registration. That failed run remains
recorded. Canonical regeneration and rebuilding its leaf resolve the mismatch; the final unchanged
six-suite selection passes **632/632**, and the two existing catalog/failure-surface suites pass
**111/111** (97 catalog and 14 failure-surface controls). Focused strict types, zero-warning lint and formatting pass. Generation resolves
**539/539 proofs and 30/30 scenarios with zero violations**. No registry exemption or new operation
is introduced. Continuation/denial-race repair, final global gates and final-head live qualification
remain separate pending work.

The owner-directed follow-up is now [epic #3897](https://github.com/oscharko-dev/Keiko/issues/3897),
attached as a native child of original epic #3871. Its ten native children #3898–#3907 cover every
current capability row exactly once plus payload security/license, original service/settings,
platform/process ownership, gateway health, large-repository performance and full live comparison.
Original #3871–#3875 remain open; required checks, introduced defects and review findings stay in
PR #3895. This checkpoint does not claim productive original-service activation or complete
standalone parity.

### Review closeout: bounded continuation, human refusal and private analysis ownership

ROOT independently integrates continuation freeze
`3006e8597c67beb5ae5cfbaf1c72d1d837f845d288a11a14e81094a72c8b94c8`, blocker freeze
`ea8a3eb9695859d6bad7a2b6aa6693ed60fe78ca5f5f4adc01cdfb8e8f99d4ad` and private analysis
freeze `6c5673cba52d47d3ae7324155abe8759d8f96836e3e5ed0b02cc7e469faaf022` against
published parent `81a3e5b0995b51f7f94ca9064085b936d1c4de74`. The shared failure contract is
merged only at the approved existing continuation cause-operation span, preserving the earlier
runner-refusal digest evidence.

Continuation reproduces **eight genuine failures**, then passes **249 tests across two suites**.
Original typed code, cause classes and frames remain body-free; dispatch refusal/faults are
unavailable, supersession is conflict and missing verification evidence is validation failure.
Actual attempted continuation ordinals survive refused or thrown dispatch. All five registered
emitted states are exercised. The first integrated run still used stale generated registration and
is retained as failed setup evidence; canonical regeneration and rebuilding its leaf produce the
qualified result, without a registry waiver.

Blocker controls reproduce **six genuine failures**: human verification refusal, an older admitted
verifier completing after that refusal and four actual typed impossible-verifier causes. The final
owning selection passes **509 tests across six suites**. The same target ledger distinguishes
executed failures from denied/cancelled/skipped checks without altering truthful wire counts.
Invocation-local callbacks retain ledger identity and decision ordinal; only an actually executed
check with current authority can reopen its applicable older blocker. A later denial cannot be
erased by an older completion. Unrelated unavailable lint does not block a selected target, and
unsupported verifier/trust/authority causes remain explicit. No new map owner, operation, planner
or permission system is introduced.

The private analysis slice matches **127 immutable references** and reproduces **four genuine
failures**, then passes **46 tests across the two existing owning suites**. Actual narrow Knip
analysis of the original-service owner reports zero issues. Node-test entries come from their
actual imports, and generated sibling dispositions are exact anchored paths checked against the
existing builder's produced files and hashes. The two actual original package imports become
direct private dependencies at their already locked versions; all 451 non-root private lock
members and the root package/lock remain unchanged. Existing private license refusal and inactive
host state remain binding. No external install, full packed attestation or global dead-code gate
is claimed by these bounded controls.

Focused strict types include the new continuation test, zero-warning lint covers every changed
TypeScript/MJS owner, and all changed files pass formatting. Fresh canonical generation resolves
539/539 proofs and 30/30 scenarios without violations; the original catalog/failure-surface selection
passes 111/111 controls. These are bounded owning checks, not the final complete quality matrix.

Upgradeability is now an explicit parity requirement in
[child #3908](https://github.com/oscharko-dev/Keiko/issues/3908), the eleventh native child of
follow-up epic #3897. It requires one supported-interface/version boundary, producer-derived
contracts and an actual upgrade/rollback comparison without distributed product rewrites or lost
native capabilities. Service activation and final comparison issues link that prerequisite.
Original acceptance remains open. Final global gates, remaining review repair and final-head
live/platform/package qualification remain pending.
