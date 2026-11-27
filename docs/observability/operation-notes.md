# Activity Log operation notes

Detailed, per-surface notes on what individual Activity Log operations record and the product
behaviour they make reconstructable. These notes moved out of [`AGENTS.md`](../../AGENTS.md) §8 on
2026-11-23 without content changes. AGENTS.md states the rules every change must follow in short
form; this page keeps their long form (references such as "§7" point to AGENTS.md) and the
specifics of each surface.

The authoritative machine contract for every operation is its typed registration and the generated
[`op-catalog.generated.json`](op-catalog.generated.json); the design decisions are in
[ADR-0173](../adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md). When code and
this page disagree, the code and the catalog win: repair this page in the same change.

## Activity Log rules: long form

The full text of the AGENTS.md §8 introduction and the Rule 1 bullets it states in short form.

Keiko's activity log (the segments in `<stateDir>/logs/`, governed by
[ADR-0173](../adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md) and
described in [`docs/observability/`](README.md)) is a **machine-reconstruction
contract**: a customer's log file must let an agent rebuild a defect 1:1 without access to the
machine it happened on. That contract only holds if every change keeps it true, so the two rules
below apply to **every** change to product runtime behaviour — feature, enhancement, refactor,
fix, migration, connector, UI surface — in every autonomy mode, with no exceptions and no "too
small to log". (Repository tooling under `scripts/` is not product runtime; it keeps its
deterministic `PASS`/`FAIL` output. Everything that runs inside the product is in scope.)

Received support reports must pass the canonical offline validator before any renderer or agent
uses them. Export contains only the closed private incident and registered causal events, with
embedded integrity and explicit insufficiency; no raw logs, inclusion flags or sidecars. Use the
[controlled support workspace guide](support-workspace.md). Matching historical
registries are repository-owned, never report-supplied (ADR-0173 D8/D9).

The behaviour you add or change must leave body-free evidence in the activity log, built on the
system that exists, never beside it:

- **Emit through the owning layer's existing port.** On the server: `ServerLogSink` /
  `ServerLogEvent` ([`server-log.ts`](../../packages/keiko-activity-log/src/server-log.ts)) for
  activity, `emitServerDiagnostic` / `defaultServerDiagnosticSink`
  ([`diagnostics-log.ts`](../../packages/keiko-server/src/diagnostics-log.ts)) for diagnostics. In domain
  packages: the injected log port of that package — `SecurityLogSink`, `KnowledgeLogSink`,
  `MemoryVaultLogSink`, `ConsolidationLogSink`, `ModelGatewayLogSink`. In the browser:
  `reportClientDiagnostic` ([`client-diagnostics.ts`](../../packages/keiko-ui/src/lib/client-diagnostics.ts)).
  A new package that performs work receives a port of the same shape from the server. Not
  `console.*`, not a private logger, not a second log file, not a new format.
- **`op` is a typed registry value, never a free string.** Declare each production operation with
  `defineActivityLogOperation` and emit it with `activityLogEvent`. The registration owns the
  category, emitter, exact required/optional field set, primitive types, hard bounds, closed data
  classes and vocabularies, causal/lifecycle semantics, analyzer projection, failure classes,
  proof ids, and release impact. The generator resolves those canonical APIs through TypeScript
  symbols; same-shaped local helpers, unresolved dynamic calls, duplicate registrations,
  registrations without an emitter, unregistered emitters, and an emission outside the operation's
  owner package (a bypass of its owning port) fail closed. Run
  `npm run generate:op-catalog` and commit the regenerated
  [`op-catalog.generated.json`](op-catalog.generated.json);
  `npm run check:op-catalog` rejects drift or any authoritative registry violation. Never hand-edit
  the catalog. Its legacy literal scan is migration input only and authorizes nothing.
- **Failure-class coverage is generated, and exemptions are exact.** The registry publishes stable
  implementation-obligation categories and a failure-class matrix with product owners, lifecycle
  transitions, causal edges, safe context fields, loss signals, analyzer projections, and proof or
  replay references. Its release expectation is 100% complete. A genuinely unavoidable platform
  or durability boundary may use only the registry's reviewed exemption shape: one exact operation
  and failure class, the operation's owning package as owner, a technical reason, a linked issue,
  and an expiry at most 180 days ahead. Wildcards, expired or effectively permanent records, unknown
  operations, another owner, extra authorization fields, silent loss, and incomplete evidence fail
  closed.
- **Sufficiency is complete by default.** A supported failure class owns its start/state/end/failure
  and loss transitions, causal edges, safe context, frames/causes, analyzer projection, and replay
  proof. Exercise unavailable sinks, rejected writes, backpressure, disk and durability failures,
  interrupted publication, and degraded capability in focused fault-injection tests. A missing
  transition or proof is a contract failure, not an optional follow-up; this proof set is the
  fault-injection gate for the change.
- **Declare informational failure facts at their owner.** If a closed failure outcome or positive
  failure counter would otherwise be optional report context, declare its exact `diagnosticWhen`
  condition on the existing operation. Prove retention through the actual producer, registered
  writer and incident query with zero optional context; include healthy controls. Ordinary file
  eligibility exclusions and budget limits are not technical failures.
- **Thread the correlation.** Every line of one logical operation carries that operation's
  `correlationId`; a background job spawned by a request carries `parentCorrelationId` pointing
  back at it. The only sanctioned fallback is `UNKNOWN_CORRELATION_ID`
  ([`correlation.ts`](../../packages/keiko-server/src/correlation.ts)) — never an ad-hoc string, never a
  silently missing id.
  Adapters that rebind an event use `withActivityLogCorrelation` or
  `withActivityLogParentCorrelation`; a plain object spread drops its non-enumerable registration
  and rejection markers. Preserve producer-owned ids and prove forwarded events through the real
  registered formatter, not only a buffered event assertion.
  Repository-add dialogs mint that id before clone/register, validate it with the canonical Activity Log correlation guard, pass it to the request, and report
  the attempt and settlement even when dismissed; effect replay is not a human dismissal.

- **SSE streams are flow-controlled, never size-limited (2026-10-28).** Every server SSE write goes
  through `writeSseFrame` (`sse-write.ts`). A `false` from `res.write()` is Node's buffer accounting
  (Node 24 answers it for any single write of 64 KiB or more, even to an idle reader): the frame
  stays queued and the stream waits for `drain`. Only a reader that drains nothing within
  `SSE_STALLED_READER_TIMEOUT_MS` (30 s) is torn down as `backpressure-killed`; producers that pull
  from a model await `whenSseWritable` so a slow reader slows the provider instead of growing a
  backlog. `sse.stream.closed` records the `drainWaitCount`. Never reintroduce a destroy-on-false
  write or a frame-size limit on a stream.
- **Errors and loss take the structured path.** §7's no-silent-failures rule, made concrete for the
  log line: `errorKind`, completeness, loss, compatibility, and writer capability come from their
  closed versioned vocabularies; the dist-anchored Keiko-code stack (`extra.frames` /
  `extra.causeChain`) and a correlation id on every failure line. A `catch` that logs nothing, or
  logs free text, loses the defect for good; `check:error-observability` pins the named sites and
  checks every `catch` in the whole tree on every run. Failure paths that predate that full-tree
  check are listed in a register that may only shrink
  (`docs/observability/legacy-failure-path-register.json`): never add to it, and after fixing a
  listed path run `node scripts/check-error-observability.mjs --prune-register` and commit the
  smaller file.
- **The persisted identity is complete or the write fails closed.** Every persisted v2 record is
  stamped at the central sink with schema/registry versions and digests, product/build/release and
  safe platform classes, compatibility and writer-capability states, plus
  `(pid, instanceId, seq)`. Producers cannot set or spoof those fields. Registered events are
  revalidated immediately before serialization, so post-construction mutation, an unknown field,
  a wrong type or vocabulary value, or an invalid identity cannot reach JSON. Rejection evidence
  uses a closed body-free reason and never echoes the rejected operation or value.
- **Loss and degraded operation are explicit.** Backpressure, disk exhaustion, unsafe targets,
  failed durability, and an unavailable primary sink may never masquerade as an active complete
  writer. Persist the applicable closed completeness/loss/capability state when the primary path is
  available; otherwise use the existing independent body-free diagnostic fallbacks and state their
  loss ceiling honestly. Every lost event is counted in the closed loss ledger and persisted as
  `activity-log.loss`, and diagnostic readiness (`ready`, `degraded`, `unavailable`) is reported in
  `/api/health`, `keiko status` and the UI. The workspace shows a plain-language notice for
  degraded or unavailable readiness; closed technical reasons stay in health, logs and reports,
  and the footer keeps its installed-version display. An explicit `silent` log level suppresses ordinary events
  only: lifecycle, loss and readiness evidence is still written, and readiness reports `degraded`
  (`level-silent`) so a silent interval never passes for an active complete writer.
- **Body-free, always.** §7's redaction rule applies to every new field: counts, statuses, scopes,
  hashes, ids, route templates, byte sizes, durations — never prompts, responses, file contents,
  secrets, paths, endpoints or PII (ADR-0173 D4). New fields go into `extra` and through the
  existing redaction ([`log-redaction.ts`](../../packages/keiko-activity-log/src/log-redaction.ts));
  if a value cannot be made body-free, log its hash or its count, not the value.
- **The log is part of the definition of done.** A change is complete only when the new behaviour
  can be reconstructed from the log alone. Prove it the way you prove the fix: a test asserts the
  emitted line(s) — `op`, `correlationId`, `errorKind`, the fields that carry the evidence — and a
  change to a user-visible or failure-prone surface is checked against `keiko support analyze`
  showing the operation in its timeline. The pull-request template carries this as a checklist item.
- **Keep one logical, bounded Activity Log.** The storage contract remains one logical Activity Log
  in `<stateDir>/logs/`; it must not create a second logical stream or a path-based replacement
  shortcut. It is stored as immutable segments (ADR-0173 D14). Each process appends only to its own
  active segment, and a sealed segment is read-only and never rewritten. Retention bounds the whole
  directory by bytes and age, so total use stays within the byte budget plus the pin quota. Never
  remove or loosen a disk bound. Sealing, recovery and pruning operate only inside an
  owner-private, non-redirected directory, on the closed name grammar in `keiko-contracts`
  (`activity-log-files.ts`), and only on opened handles that prove regular, owner-matched files.
  Publication never replaces an existing name; rename is only the fallback on filesystems that
  report hard links unsupported. Readers enumerate and order the files only through that grammar
  (`orderActivityLogFileNames`), never through a hand-written pattern or a fixed file path. Segment
  and retention changes preserve ordering, compatibility classification, explicit truncation/loss,
  and support-export reconstruction.
- **Saved reports remain under human control.** A support export or replay fixture is written only
  through a user-initiated local export. CLI exports enforce owner-private directories and files;
  desktop exports use the browser's download destination and filesystem permissions, including its
  configured Downloads folder. A browser download does not promise CLI permission enforcement or
  a destination picker. This desktop behavior is the owner's accepted local export workflow.
  Keiko does not upload it, attach it to GitHub, open an
  issue, or otherwise disclose it automatically. Content-bearing optional sections require their
  existing explicit consent; adding a new destination or disclosure path is a separate authority
  and privacy decision, never an implied extension of logging.
- **Keep the contract converged in the same change.** When runtime behavior changes this contract,
  update the owning code, failure-first regression, emitted-line/analyzer or replay proof,
  ADR-0173, AGENTS.md §8, `CONTRIBUTING.md`, and directly affected operator documentation together.
- **One command is the gate.** `npm run check:activity-log` is the Activity Log implementation
  gate, and required CI runs that exact command. Every run builds the packages and evaluates the
  complete registered inventory: `check:op-catalog` (typed registrations and emitters, closed fields
  and vocabularies, exemptions, failure-class coverage, the failure-surface inventory, and proof and
  scenario resolution), `test:activity-log-scenarios` (executes every curated end-to-end scenario
  the inventory resolves, each of which must reach a complete support-analyze report),
  `check:error-observability`, `arch:check` with `arch:check:negative`, and `check:release-impact`.
  It takes no changed-file input, so an unchanged emitter is proven again over the complete
  inventory rather than over a diff. On an integration commit whose tree is byte-identical to a
  pull-request head that already ran this exact gate, ADR-0178 reuses that verdict — which proves
  the same complete inventory on the same bytes, and is strictly stronger than a changed-file
  scope. Any other narrowing of the gate remains rejected. Each failure
  names its check, rule, site, and remediation. Run it before every pull request that changes
  product runtime behaviour.

## Debugging from the log: long form

The full text of AGENTS.md §8 Rule 2.

Before you read code, form a hypothesis, or ask a human for a screenshot, read what the product
already recorded:

1. **Get the artifact.** Use `keiko support export --incident <id>` or a correlation selector.
   Manual UI and CLI export must also work at retained incident capacity through the canonical
   transient descriptor, without stealing in-flight reservations or widening retention. At byte
   pressure, completed candidates may roll over; in-flight reservations remain protected.
   Exporting stored server evidence requires an authenticated app session; scoped-cookie refresh
   reuses its verified bearer and absolute expiry. An unpaired or offline browser can still create
   and download a limited report from validated body-free client failure facts. That fallback
   grants no access to stored server evidence.
   Received evidence is one canonical private report; raw logs, legacy open bundles and inclusion
   flags are not accepted at the support-report boundary. For local debugging, use
   `keiko support query --correlation-id <id> --json` on the existing Activity Log.
2. **Validate before reconstruction.** `keiko support analyze report.json --json` emits the
   versioned body-free machine view only after complete offline validation. Give agents that
   analyzed projection, never unvalidated report bytes. Human views, clusters, deterministic
   seeds and explicitly selected replay fixtures derive from the same validated evidence.
3. **Investigate from the validated timeline.**
   New exports replace local identifiers with artifact-local ordinal references. The UI Support ID
   selects local evidence on the originating installation; it cannot select a received report.
   Read the unfiltered analysis first, then use its `incident.correlation.rootCorrelationId` or a
   validated timeline's exported reference as `<exported-ref>` in
   `keiko support analyze report.json --correlation-id <exported-ref> --json > timeline.json`.
   This emits that validated timeline; `keiko investigate --from-timeline timeline.json` consumes it.
4. **Read sufficiency and integrity before trusting a seed.** Closed reasons, coverage and loss
   expose missing causal evidence, lifecycle transitions and unsupported identities. Authenticity
   stays unknown. The seed warnings name unavailable evidence classes; never replace them with
   invented reproduction text or assume a historical PID is locally running.
5. **Turn the seed into a red-then-green test** following
   [`docs/observability/reproduction-harness.md`](reproduction-harness.md), so the
   fix is proven against the customer's actual sequence rather than a guess.

The join keys — `(pid, instanceId, seq)` within a process lifetime, `correlationId` within an
operation, `parentCorrelationId` across a spawn — are stated once in ADR-0173's "How an agent reads
the log". If a defect cannot be located from the log, that gap is the first defect to fix: add the
missing evidence under Rule 1, then fix the behaviour.

## Connected-context retrieval and grounded answers

Connected-context explicit path admission emits anchor/admitted/rejected/line-hint and bounded
basename discovery counts, a closed rejection-reason list, and selected atom counts on the existing
`search.connected-context.source-details` operation; the shared correlation joins its completed
read-window and budget evidence without exceeding the operation field cap. Extensionless document
admission uses a shared case-insensitive `README`/`CONTRIBUTING` shorthand allowlist, separate
from overview ranking. Ordinary prose cannot gain explicit-file authority from its ranking bucket;
explicit filenames, selected scope and the existing discovery/read grants remain authoritative.
Existing source-details counts distinguish actual explicit admission from ordinary ranking.
Diagnostic-reference selection uses the final six available source-detail fields. Additional
selection observations
use the typed `search.connected-context.selection-details` sibling on the same Activity Log and
correlation; existing completed fields and the contextual-field cap remain unchanged.
Contextual below-floor fallback logs its closed ranking source and remains low confidence. Its
lexical producer order requires matching live content identities and excludes semantic or
successfully reranked selections. At most two additional eligible content peers may share the
first retained source's same-query matched-group key; equal numeric scores alone do not
qualify. Existing read/byte grants remain binding. `keepOneFallbackApplied` describes exactly
one retained fallback source, and the existing completion count records the actual size.
Short ordinary documents may use the existing canonical
reader's complete current redacted source only within both existing byte grants; explicit
selections and certified/source-code ranges retain their geometry (ADR-0022).
The six-reference intake preserves the primary local trace frame and explicitly named question
paths before secondary frames or conversation referents. Prompt fitting preserves a complete
matching line when it fits the remaining UTF-8 byte grant, rebinding source ranges and stable
identities before citation reconciliation. Physical reads remain actual I/O counts: import
classification and parsing share one complete guarded source read rather than charging another
classification read. Existing final-prompt, range and read observations describe these decisions
without recording source text or paths.
Grounded single-source, multi-source and hybrid prompts place the existing redacted answer
task after supplied evidence and uncertainty. The same ordering applies to single-source and
multi-source marker repair; hybrid repair already appends its task. Governed memory and
continuity remain untrusted context inside that unchanged task block. Existing final-prompt
selection and gateway admission record fitted counts and costs; citation validation and
original input/output grants remain authoritative.
Marker repair requests at most 32 unique-prose insertion annotations instead of regenerating
the answer. The existing repair owner constructs the candidate locally, then applies the
unchanged verbatim-content, code, assessment, sent-range and cumulative-budget guards.
Literal marker-only responses remain subject to those same guards. Citation repair uses the same
admitted, turn-metered model port without a tool catalog or tool loop. Unexpected tool-call
output is refused and charged; current readiness, authority, cancellation and cumulative
synthesis/spend grants remain binding. Existing answer-details evidence records the disposition.
Symbol discovery batches the existing bounded excerpt ranges per source and observation wave.
Each definition retains current-source, call/parent and range certificates; no persistent source
cache, read grant, synthesis attempt or source authority is added by batching.
Endpoint definition traversal binds a registration's observed handler reference to its current
lexical AST target. Further calls retain their exact callable owner and complete observed spans;
same-named declarations and uninvoked nested functions do not certify that relationship.
Contextual natural-language code questions can seed the same bounded definition traversal from
current AST callable owners of actual lexical source hits without requiring an HTTP route or a
user-supplied identifier. Lexical overlap does not certify invocation or an unrelated declaration;
continuation retains the existing exact ownership, currentness and read-budget guards. The existing
selection-details Activity Log records the admitted contextual definition seed count only.
Productive string literals can identify a callable; comment-only matches cannot. Contextual roots
reuse their observed exact declarations and original-query relevance instead of repeating a global
symbol-name search. Only sources with indexed outgoing relationships require contextual excerpt
reads. Unavailable source reads retain explicit uncertainty; cancellation and scope denials propagate.
Contextual traversal shares the plan's structural request context and exact limit binding. Fully
verified definition lookups retain the existing decision to skip redundant optional traversal.
Imported targets retain exact runtime module-export identities. Explicit compiler output mappings
reuse already guarded metadata and can address only admitted sources in the owning package.
Structural AST, import, symbol, endpoint and source/test intake honor the actual caller file
ceiling. A null ceiling uses the finite admitted candidate inventory, including resolver metadata
reservation and request-local current-source metadata capacity. The code intelligence build also
bounds the source text it parses (32 MiB) and reports the bound as a candidate limit, counted on
`evidence-details`, instead of exhausting the heap (#4456). Finite enrichment grants and
bounded complete-text reuse retain their separate limits.
A question naming a subfolder of the admitted inventory (`commands-Ordner`, `the X folder`,
`components/PromptInput`) reads that subtree once more, entry files first, as whole-file listing
evidence within the known-fit capacity plus at most eight of its documents; ordinary evidence,
floors and grants are unchanged. `evidence-details` records `namedDirectoryFocusState` and counts,
never a folder name (#4429, ADR-0022).
Unreadable or partially observed re-export branches retain uncertainty; missing indexed exports
cannot certify a unique runtime target when a competing branch is unobserved.
A guarded current definition reached through an observed inline-callable reference retains its
definition evidence and a resolved reference edge. Declaration priority does not certify callback
invocation; continuation retains that reference relationship and `source-graph-incomplete`.
Partially overlapping excerpt windows retain uncovered lines and their originating strength;
deduplication removes only lines already covered by a higher-priority window.
Exact structural endpoint-registration ranges and their existing surrounding-context boundaries
split broader ordinary windows. Uncovered surrounding evidence retains its relevance and priority;
these spans do not certify handler invocation.
Natural-language matching separates standalone citation-format clauses from the search subject.
The conservative citation vocabulary leaves quoted text and unrecognized identifiers, paths and
routes intact. Definition intent and content groups use that same subject while the original query
and diagnostic identity remain unchanged. Persistent natural-language match identities carry a
normalization revision. The existing completion-details Activity Log records only the aggregate
removed-clause count across actual searches; literal, regex and exact-symbol matching retain their existing semantics.
Numbered, letter-led compounds retain their full spelling as contextual lexical hints before
camel-case fragments are extracted. Their shape alone never grants exact-target or code-symbol
authority: a complete spelling receives literal lexical relevance only at a lexical boundary.
Unicode letters, combining marks, numbers, underscores and hyphens continue the same compound;
punctuation and filename separators can delimit it. Matching and excerpt confidence use the same
case-sensitive or case-insensitive rule. An absent complete spelling preserves full-question
matching, including technical aliases and ordinary context.
The existing persistent natural-language matching revision invalidates older scores. After actual
excerpt assembly and final prompt fitting, an unobserved compound hint lowers selection confidence
without removing evidence or claiming a keep-one fallback; fresh and cached packs share this rule.
Returned and persisted answers use the confidence of their actual sent source; another source cannot
supply its missing spelling. Existing completion events record the target decision/count, selection
confidence and actual read counts. The existing `chat.context.selected` event records available
fitted selection confidence without source bodies.
Evidence manifest hashes and ranges enumerate final sent excerpts; retrieval candidate counts, usage and omissions
retain the actual earlier work. Existing prompt sent/available counts distinguish fitting removals
without inventing retrieval omissions.
Lexical relevance establishes neither an answer fact nor precedence between conflicting sources.
An observed admitted callable may retain an imported constant declaration only when its current
TypeScript lexical binding, nearest callable owner, declaration identity and physical identifier
span agree. Calls retain their existing priority; value references use the remaining bounded
frontier, carry reference uncertainty and an exact source witness, and never certify invocation or
a call cycle. Shadowed, uninvoked, dynamic, ambiguous or stale references remain unsupported;
missing owner metadata reports source-graph-incomplete. Retaining a declaration does not evaluate
a computed runtime value.
An explicit natural-language request for recursion can retain observed static call cycles as
coherent source evidence. The request-local trace records exact nearest-owned call edges before
repeated targets are suppressed, derives finite strongly connected groups from selected declaration
identities, and leaves the acyclic parent tree and reference uncertainty unchanged. References alone
never certify a call cycle. Every member must remain selected and current at allocation time.
The existing allocation runs first and remains unchanged when it already retains all requested
cycles. If a cycle is missing, one alternative starts from the same bounded initial allocations,
admits each complete cycle atomically through the existing whole-target and parent-caller guards,
then continues the existing shared order. It is used only if it retains every cycle already complete
in the original allocation and adds at least one missing complete cycle; otherwise the original
allocation remains. This adds no source reads, relevance bonus, reserved bytes, file quota or budget
increase. Ordinary evidence retains its existing separate share. The existing selection-details
Activity Log records only requested and planned static-call-cycle counts; those counts do not claim
that a call executed or that a final answer covered the cycle.
Physical excerpt allocation funds selected, current target definition windows and their observed
parent caller spans inside the existing connected share and each physical excerpt's byte limit. A
compact caller span remains bound to its original current parent, exact child and observed source
coordinates; it does not acquire a new definition certificate. Independent roots and files within
each root receive bounded initial byte portions. Existing certified traversal sets file order;
existing query relevance orders targets within each file, with stable ties. Roots and their file
queues take turns within those portions. After that bounded pass, shared opportunities combine
the existing root-local relevance nominations with the existing root/file turns. Each relevance
nomination considers its file's higher-scored and tied whole targets in stable certified traversal
order. Existing admission checks retain the longest prospective prefix that fits jointly with
the nominated file turn. If no joint proposal fits, the feasible relevance proposal is retained.
This bounded tradeoff applies to new targets; previously funded targets remain intact. Whole
targets that fail admission remain separately retryable, including later targets in served files.
A shared file turn advances only after a newly funded whole relevance prefix makes progress.
Pending file nominations first consider existing queue heads below the current relevance
nomination's score. Nominations from files with higher or tied heads remain fallback candidates
when no target from the first group fits jointly.
Each group uses its existing relevance-ordered queue head's score, highest first. At equal head
scores, an unfunded physical file precedes continuation in a file whose head is already fully
funded in committed state. Among unfunded files, a selected definition that reaches its actual
physical head score and owns a certified selected child precedes terminal-only nominees. This
uses the existing owned-continuation eligibility check; a weaker descendant cannot become an
independent head-level source seed. Remaining ties retain their existing stable order. The first jointly feasible target in a different
physical file whose queue head is not fully funded receives the shared file turn.
When the relevance file's head was already fully funded in committed state before the turn,
its pending whole targets at or above the first nominated file's queue-head score also
participate in the joint proposal. While the extra opportunity remains eligible, each guarded
relevance-file and first-file checkpoint probes the existing owned opportunity, then same-file
targets tied to that actual head score within the ranked entry's certified owned-call family.
The family includes its selected owned children and its selected parent's owned children only
when the ranked entry is itself a certified owned child of that parent. Existing stable order
and whole-target guards apply. Only an actually selected guarded owned continuation establishes
owned progress. A global competing return retains its guarded state and any prior owned-progress
fact; it does not establish that fact merely by returning a different state. Mere file equality
also does not establish family membership.
Actual owned progress or a newly guarded tied family target in these eligibility probes closes
the extra second-file opportunity for the entire outer shared turn and clears any earlier
uncommitted second-file checkpoint. Later callbacks cannot reopen it. These eligibility probes may remain unpublished;
a refused tie is not guaranteed funding. Zero-score ties participate under the same rule.
While eligible, the existing fair order may guard a second body in a physical file distinct
from both, whose nominee meets the same first-file head score. Its head must not be fully funded
in the joint proposal, except for a committed parent with a pending owned continuation as
described below. Every retained joint preserves committed whole targets, the guarded
relevance proposal at that checkpoint and the first nominated body. The relevance-only proposal
grows separately; explicit successful second-file results retain the latest such joint through
both prefix loops, so a later first-file-only result cannot replace it while eligibility holds.
The second nominee may change under existing order. This bounded physical-file turn takes
precedence over later uncommitted higher-scored prefix additions in the already-served file
when they cannot fit together; when they fit, the latest guarded joint includes them.
A disqualified turn instead maximizes the original guarded single-fair prefix, then applies
one final owned opportunity. A prior owned result is reused only for the identical raw joint;
classification does not publish its probed tied targets. If no second joint is retained, the
feasible first-file joint remains the fallback. Funding the relevance head only inside a
provisional proposal does not enable this extension. Scores, ownership, currentness, authority,
byte caps and deferred retries remain unchanged.
A shared joint proposal may also fund one finite chain of selected definitions connected by
certified nearest-owned source calls. The exact parent/child witness carries this ownership;
a reference edge alone does not qualify. The first new child must itself own a selected child.
It must meet the nominated physical file-head score unless a fully funded owned connector on
that same lineage has already met that comparison and owns a selected child. A starting parent
can discharge the comparison when it is fully funded in the continuation's actual input state,
meets that comparison and owns a selected child. That input may be committed state or an
already guarded joint proposal; other branches retain their own floors.
This gives a multi-body source continuation one bounded opportunity while standalone terminal
leaves keep their existing ranked and deferred turns. Already funded connectors can be
traversed without counting as progress; after the first new target, lower-relevance descendants
and terminal leaves may complete that chain.
A newly guarded first-file definition that owns selected children retains its finite source
continuation at that physical file's own head score. An already FULL first-file parent resumes
at the same own-head comparison. This source turn retains its guarded joint through both
ranked-prefix loops, growing compatible whole targets from that same state. It does not add
terminal fair-file loans or reopen global competing nomination. Failed descendants retain the
feasible source joint; their complete bodies still require the existing admission guards.
Outside a retained source turn, a continuation below the nominated head yields when an unfunded
selected body at or above that head still fits the existing whole-target guards from the same
pre-child state. The canonical nominee follows the already-computed shared target order:
relevance and stable ties within each source root, interleaved between roots. Its complete body
must pass the existing guards first. Pending same-file targets at or above the nominee's score
may then join in stable file order through the same guards. While retaining this guarded
canonical proposal, the existing pending fair-file order may admit a distinct physical file
whose head is not FULL in the proposal or resume its committed FULL parent. This joint addition
first uses the canonical nominee's score, then the borrowed floor if no such addition fits; it retains the canonical body
and its guarded same-file prefix. If no joint addition fits and the canonical physical file head
is already FULL in committed state, the existing pending fair-file order may instead nominate
an alternative from the original pre-child state. That alternative must meet the borrowed floor
and pass the same whole-target guards. Each selected nominee's pending same-file targets at or
above its own score may join through the same guards. A failed extension retains the previously
feasible proposal, and the guarded canonical proposal remains the fallback. Failed proposals
are neither reserved nor read. Deferred final retries retain their existing admission rules.
In global competing nomination, an offered FULL parent can resume its pending owned continuation.
It must have been FULL in committed state, lie outside the canonical file, and meet the existing
nomination score floor. Its finite certified owned continuation uses its actual physical
file-head score and adds at least one newly guarded whole target before it can be retained.
This resumed branch preserves the input joint and does not reopen global competing nomination;
the existing fair-file order and fresh-target admission remain unchanged.
Existing source order selects one branch, and
identity tracking bounds recursive cycles. Every target still passes the existing currentness,
whole-definition, physical-window and connected-share checks; a failed extension retains the
original feasible joint proposal.
A file whose relevance-ordered head is fully funded is eligible for another file turn only
through an already fully funded parent with a pending owned multi-body continuation.
Availability uses the lowest score among pending unfunded physical file heads and the current
relevance file head to find possible nominations. Actual admission uses the current
nomination's physical file-head score. A feasible external joint
proposal may also extend individually fully funded parents in the relevance file at that
external file's actual head score. Those parents must have been fully funded in committed
state before the turn; funding them only inside the proposal does not enable this extension.
The admitted proposal retains the external file body and the original joint fallback. Other
pending targets in a funded file do not acquire a new file turn. Assigned, statement, returned
and awaited calls qualify equally; return and await remain relevance hints, and source
ownership does not certify handler invocation.
Infeasible nominations remain eligible without blocking feasible nominations in other files.
A weaker target or compact caller window does not complete that head's file opportunity.
Higher and tied file heads retain their existing relevance turns and guarded deferred retries.
A nomination that adds no prefix target cannot donate fresh fair-only bytes; deferred file turns
remain eligible for a final guarded retry in their existing order.
Aggregate same-file unions consume the connected share; each physical excerpt retains its existing
per-window limit. Shared physical lines and separators are charged once;
upgrades retain already funded targets, later same-file targets remain eligible, and an oversized
branch spends no partial reservation. Explicit human selections remain first, and ordinary ranked
evidence retains its share of the existing grant. Reserved windows precede ordinary extras.
When current coverage windows apply, independent search windows and unfunded discovered-definition
windows share the residual byte grant through bounded queues after explicit human and funded
current windows. Unused portions return to their shared grant.
Bounded initial opportunities protect portions for every already selected, file-capped readable
path, including definition-only evidence, before expansion consumes the remainder. Paths without a
retained nonempty initial view retry shared bytes before already served paths expand, preserving
the existing order within each group. When no current coverage windows apply, manual selections
come first, followed by existing definition context windows overlapping an original ordinary atom
range, the independent ordinary remainder and the existing fallback. These opportunities do not
certify declaration ownership or invocation.
Natural-language ordinary reads reuse the canonical query term groups on the current guarded,
redacted source. Only already proposed ranges can receive separate bounded opportunities for
those groups; repeated stronger matches cannot consume every opportunity before another requested
aspect is considered. Existing order within each group, full-range admission, deduplication,
source currentness and every byte, file and deadline grant still apply. Explicit selected line windows,
funded definition windows and trace priorities retain their existing behavior. File-pattern, regular-expression
and exact-symbol queries do not use this scheduling. A matched term group is lexical
coverage, not proof of a complete implementation or a supported answer.
The existing completion-details event records served canonical query-group counts
for these ordinary reads. Counts are summed per path and describe actual reader coverage before
final prompt fitting; no source or query text enters the Activity Log.
Already admitted named source files are prioritized before the shared code index applies its
existing source-file ceiling; resolver metadata remains reserved within that same ceiling. The
request fixes that preference before its first index build and reuses the same canonical index.
For contextual whole-file questions, fresh callable evidence is observed through the existing
batched reader within the existing aggregate discovery-byte capacity. The reader derives window
capacity from finite requested ranges and remaining bytes, with the existing deadline and cancellation
guards. Current callable ownership and actual code matches precede root selection; contextual roots
use the existing query and certified-definition capacity. Explicit selected lines, non-addressed
discovery and route tracing keep their own rules.
Lexical query-group coverage alone never certifies the requested implementation or an answer.
The governed request's existing document collector checks the original remaining file and
excerpt-byte grant before each extraction. It bounds the redacted logical projection, including
UTF-8 separator bytes, within that capacity and discloses exhausted or truncated evidence. All positive returned document
projections reserve their bytes and distinct paths before code reads. Final usage preserves any
larger assembler usage and retains original initial usage plus actual consumed code bytes and
distinct positive-consumption paths plus all actually returned positive document projection bytes
and paths, even when later invalidation or assembly drops their published views. The reservation
does not enter assembler initial usage, so those contributions are not charged twice. Raw document
input, parser work and all filesystem I/O are outside these excerpt charges.
Each batch uses one classified, redacted source snapshot. A later expansion uses a fresh guarded
read and must match the first
complete redacted-source fingerprint; a mismatch invalidates all views for that path without
refunding consumed bytes. Subsequent passes exclude processed ranges and retain actual partial-view
identities rather than claiming complete bodies from clipped reads.
The existing selection-details operation records planned ordinary ranges on attempted reader paths,
ordinary ranges intersected by nonempty returned views, and deferred definition ranges. An
intersection count does not certify complete source content; truncation and omission counts remain
authoritative.
Separately identified returned partial views retain their actual ranges, contents and physical-view
identities through assembly, without inventing continuity or uncharged separators. Unidentified
multiple uncovered views remain fail-closed; conflicting views retain uncertainty. Bounded
observations do not establish that an arbitrarily large function was fully read. File and deadline
grants, current-source checks, invocation uncertainty and actual truncation/omission reporting
remain authoritative.
Existing query evidence orders endpoint intake; bounded delegation traversal keeps the original
workspace authority and budgets. Pack uncertainty retains closed omission reasons; existing
Activity Log uncertainty, physical-read and final-prompt counts describe the observed result.
Optional augmentation skip detail and metadata retention capacity use completion-details;
the completed and source-details emitters each retain at most 48 registered context fields.
Selection-details records calibrated absolute/ordinary relative floors, the low-confidence
keep-one state, and pre-cut reranker disposition/failed-call counts. Addressed-file demotion
remains separate from healthy unaddressed basename diversity; safe reranker failure frames and
causes use the existing failure-class contract. Pack, prompt, wire, and log share the same
high/low selection vocabulary and actual observed scope/semantic dispositions.
Workspace-index failures with no retained, indexed or reused records report live fallback;
actual cold or warm request work remains visible even when saving its snapshot fails.
Conversation continuity records only its closed referent source and source/admitted/rejected
counts on selection-details; assistant path text never enters activity evidence.
A previous-answer path stays a continuity hint: it never replaces the current question's own
keep-one fallback, which remains low confidence beside it within the same grants (#4458).
The closed `retrievalIntent` vocabulary is `project-metadata`, `repository-overview`,
`targeted-code-search`, `diagnostic-search`, `conversational-follow-up` and `clarification-needed`.
An eligible `conversational-follow-up` retains the previous targeted or diagnostic intent for
planning; concrete new targets and new traces classify independently. The registered completed
and clarification operations retain the actual turn classification.
Leading `./` reference spellings are canonicalized before strict path admission; parent and
interior dot segments remain subject to the existing validator and every sensitive-path denial.
Complete document path references are data when classifying relationship/history requests;
directory names such as `reference` cannot request graph or Git enrichment. An ordinary-folder
factual lookup focuses discovery on canonically admitted named documents with a scope-bound
request context only when every meaningful request clause stays bound to a named document.
Independent prose topics retain recursive discovery even without a strong planner target.
Its source/read/ring
observations reuse the same registered retrieval siblings. Supported ordinary formats reuse the
canonical web/text-document extension groups, alongside XML and bounded document extraction.
Quoted targets use the same canonical reference identity. When every complete factual document
target is rejected, `explicit-target-unavailable` records skipped rings and augmentation; other
same-basename files cannot substitute for the unavailable target.
Ordinary-folder documents under `build` and `dist` follow document discovery policy; repository
generated-code exclusions, sensitive-path denials, containment and all read grants remain intact.
Request-local worktree observation reuses the observed Git runner, feeds allowed recent paths
into search policy and targeted/diagnostic ranking, and records its closed disposition, duration,
observed/deleted counts, and recent-path hint/hit counts on selection-details. Paths and the
private status digest stay outside logs; observation cannot admit evidence or bypass a floor.
Directly connected deep Git subfolders check ancestor metadata until the filesystem root under
the original deadline and abort guard; this hint never expands the selected evidence root.
Optional semantic live refresh reuses the original exploration governor and gateway spend ledger.
Each new read reserves a file and its observed byte upper bound; each embedding attempt reserves
a UTF-8 input-token upper bound before dispatch. Selection-details distinguishes actual read/call
attempts from reserved byte/token bounds and counts only retained refreshed files. Baseline index
fingerprint verification remains part of the existing logical semantic lookup. Live document
refresh defaults off; `KEIKO_REPO_SEMANTIC_REFRESH_FILES_MAX` explicitly enables at most eight
files, within the original remaining deadline and a five-second ceiling. Missing or denied
remaining grants perform no new refresh I/O, and stale vectors retain honest lexical fallback.
The typed `search.connected-context.answer-details` sibling joins the same scope/query digests
and correlation. It records actual final-prompt file counts, answer kind, observed citation
behaviour, bounded declaration counts, citation-repair disposition, and follow-up trigger,
pass/admission counts, outcome, and configuration disposition.
Pass count records a completed follow-up retrieval even when fitting refuses its synthesis;
admission count records targets retained by follow-up retrieval, independently of physical
read/byte accounting and final sent membership.
Technical failures use the existing closed error header, body-free frames and causes;
declaration paths remain outside logs.
Connected synthesis buffers normalized output before publication so rejected declaration lines
cannot escape through streamed chunks. Initial synthesis plus either marker repair or an
insufficiency follow-up shares two physical synthesis attempt slots and the original remaining budgets, including gateway and context-window retries.
The separately bounded entailment stage cannot grant another synthesis attempt. The existing
context allocator's high/exceeded pressure refuses follow-up. `KEIKO_CONNECTED_FOLLOW_UP_PASSES_MAX`
defaults to `1`; only explicit `1` enables and `0` disables it, and other explicit values fail
closed to zero passes with an invalid configuration observation. Final sent packs and ranges
authenticate citations; assembled reads remain separate physical-usage and audit evidence.
The same answer-details line optionally records `synthesisCallCount` and
`completedSynthesisCallCount`; the former counts physical attempts and the latter completed
responses. Grounded evidence reports use completed responses for `usageTotals.requestCount`,
including completed marker repairs and follow-up answers; failed retries do not become completed
requests. Legacy evidence callers retain their one-request default.
It also records
`synthesisReservedOutputTokens`. Synthesis input usage records the greater of the canonical sent
prompt estimate and reported provider usage. These totals include discarded attempts but never
reduce a later request's input capacity (owner decision 2026-11-11, ADR-0137 D2).
Reported discarded output is retained; an interrupted
stream without output measurement retains its requested output reservation instead of granting an
unknown output amount as zero. These output charges are conservative admission bounds, not claims of exact
provider consumption. The optional local gateway attempt hook preserves transient recovery within
the two-attempt allowance and does not change unrelated callers' retry policy.
OpenAI-compatible HTTP dispatches, including shape/stream/output-field fallbacks, settle the same
caller and durable spend admission for each actual POST; adapters without that transport hook
retain the existing gateway boundary. No nested compatibility path grants another attempt.
A terminal caller attempt/cap refusal remains a local fault even after an earlier compatibility
dispatch; it cannot open the shared provider breaker. Genuine provider failures retain the
existing breaker and retry classification. Caller attempt/cap refusals use the nonretryable
`GATEWAY_ATTEMPT_ADMISSION_DENIED` code and HTTP 403; streamed notices retain that same code.
Their localized request-limit notice does not claim a model context overflow or exact unknown
output consumption. Genuine context-window refusals retain `GATEWAY_CONTEXT_OVERFLOW`.
Prompt fitting retains separate model and caller input caps for each request; earlier prompt usage
consumes neither cap. Mandatory overhead that
fits the model but exceeds the caller allowance uses the caller refusal; overhead that exceeds
the model retains context-overflow handling. Best-effort citation repair keeps the completed
answer when its current prompt does not fit, its cumulative output grant is exhausted, or no
synthesis attempt slot remains.
Final grounded publication reuses `chat.response.message` after governed memory attachment. Its
optional `uncitedMemoryContextMarkerCount` counts the final structured marker, and
`memoryContextDisposition` is closed to included/excluded/not-requested. The assistant identity
and originating request retain the existing causal link. Candidate counts and model-authored
marker prose cannot stand in for actual memory inclusion; no memory or answer body enters logs.
`client.scope.notice` records scope narrowing, widening and adding missing
evidence under the notice's client correlation. Its closed `reason` is `narrowed-to-file`,
`narrowed-to-directory`, `widened`, `pinned-folder`, `missing-evidence-added`, or, for the
plain-language AppData sensitive-data notice that informs without blocking (#4437),
`app-data-contained` (the folder holds an `AppData` folder) and `app-data-selected` (the folder
is part of one). `scopeKind` is
`workspace-root`, `directory` or `files`; `pathCount` counts selected scope-relative entries.
`pinned-folder` is retained only for historical evidence; current Files navigation never pins a
folder or asks for confirmation. The existing timeline carries these dispositions and counts
without scope paths or notice text.
Files directory responses identify the guarded canonical root, including for symbolic aliases.
Every directory response retains its canonical identity and latest per-path read ownership;
child-discovered replacements and unmounted windows cannot publish older roots or listings.
Root normalization/replacement and superseded child reads use the existing Files scope-decision
Activity Log under their directory-read correlation, without paths or contents.
Explicitly forgetting a failed Files edge releases only its own failed admission hold;
pending work and independent source holds remain protected.
An unchanged privacy-elided Files edge may restore its local representation from the same
conversation/connection's canonical acknowledgement only when its persisted fingerprint and
visible scope both match. This does not start a new source intent or cancel a response. Missing
or changed proof and failed transitions retain normal recovery; other source holds remain intact.
The existing `automatic-suppressed` scope decision joins the original acknowledgement.
A mounted Chat may establish its conversation through the existing runtime before its id is
persisted in window cfg; refresh admission and failed-edge recovery use that same live identity.
Initial Files bindings hold admission before an edge exists, using stable window ownership.
Returning to an acknowledged root after failure requires fresh canonical reconciliation.
Retired owners release settled failed holds only; timeout-blocked work and failed compensation
retain their holds until the existing recovery path proves settlement.
Connected Files intent cancels its bound Chat before acknowledgement. The existing Chat runtime
retains per-source pending/failed admission holds and releases only the current accepted token;
drafts survive refused sends. Intent lifecycle and send refusals use that same scope-decision
operation and the serialized mutation correlation.
`client.evidence.inspected` records `summary-expanded`, `file-table-opened` or
`manifest-fetch-failed` under the inspection's client correlation. Optional `readFileCount` and
`omittedFileCount` describe manifest records and do not certify model-sent files. A manifest fetch
failure emits WARN with the existing closed `errorKind` header and bounded `errorClass`, `frames`
and `causeChain`; the other reasons emit INFO. Inspection evidence remains body-free.

## Bounded git reads

`git.status.bounded` records a git read the byte cap ended or that stopped early, with counts and a closed `surface` only: `shownRecordCount`, `partialRecordDropped` and `maxBytes`. The `history` surface (the Git window History tab) writes a line only when a page ends early, either because the cap cut its last record (dropped, never counted short) or because a record could not be read; the optional `unreadableRecordCount` then holds the records left unread, and the page is reported `truncated` so the UI continuation stays exact. A whole, readable page writes nothing.

## Commit drafts and stream recovery

**Draft and stream recovery stay reconstructable.** Commit drafts record model-context bounds, compaction, generation count and reuse as counts and
flags on `git.commit.draft.completed`. The same event carries body-free normalization version/rule and bullet, trailer, continuation and marker counts for generated and reused drafts. Each attempted generation also records its own result and normalization on `git.commit.draft.attempt.completed`, so a later repair cannot erase earlier evidence; stream startup retries use the existing `gateway.retry.*`
events. Refused prompts retain measured bounds, and generated/reused drafts share a body-free key digest. Browser delivery-loss counts are recorded once after rate admission and before routine diversion. Refused loss-bearing reports return 429 so the browser retains the counts for later delivery; the server alone counts that dropped report, avoiding a second client-post-failed count. Final pagehide loss reports use an independent bounded admission budget, so ordinary report storms cannot discard the closing tab's counters. Stream resources, circuit admissions, spend reservations and completion evidence settle before the terminal done packet reaches a consumer. Neither path records customer diffs or generated text.

## Memory diagnostics and CLI lifecycle

Expected Memory capability states and salience extraction/capture summaries use the registered
`server.diagnostic.observation` timeline at info, without an error kind or automatic failure incident
(#4247). Producers explicitly declare `diagnosticOutcome: "routine"`; unclassified diagnostics and
real model, vault or vector-index failures retain the failure channel. Shutdown start is info even
with work in flight; faulted cleanup retains its warning and failure evidence.

`cli.lifecycle.provisioned-config` records what `keiko start --provisioned-config` did with an
administrator's gateway configuration (ADR-0121 D9), under the start's correlation: `adopted` (new
or changed since the last adoption; it replaces the configuration as a whole), `unchanged`,
`deferred-running` (a running Keiko is never written under), `overridden` (an explicit
`KEIKO_CONFIG_FILE` or `KEIKO_UI_DATA_DIR` wins), `absent`, or at warn `invalid`, `too-large`,
`refused-link`, `read-failed`, `write-failed` and `marker-failed` (the configuration is in force,
its record is not) with the error class. A candidate must load through the gateway's own config
loader before it replaces anything. Never the path, a digest of the content or the content. `portable launch` hands its sink to `keiko start` on every platform,
so a macOS or Linux launch records its health, browser handoff, failure and adoption lines like a
Windows one.

## Chat citations

`client.citation.activated` records a citation click and its source selection under the
activation correlation. `reason` describes the source fingerprint: `matched` (one root),
`unmatched`, `absent`, `malformed`, or `ambiguous` (several matches). `outcome` records
`opened`, `open-refused`, `picker-opened`, `picker-dismissed`, or `refused`; an opened picker
is not a successfully opened file. `rootCount` and `matchCount` explain the choice without
recording the fingerprint, file path, source label or citation text. The registered server
projection retains these closed fields on the existing Activity Log timeline.

## Coding Workbench and coding runtime

`client.coding-run.restored` records, once per distinct restoration, how the Workbench rebuilt a
settled coding run's conversation from Coding History after a reload, under the run's own id (the
correlation its `coding-runtime.history` lines carry). The timeline carries the newest messages the
safe-activity contract's bounds admit (`timelineCount`, `turnCount`, `feedBytes`); every older
message the feed cannot carry stays in the transcript, whole (`transcriptCount`,
`transcriptChars`), so no message of the run is shown in neither place. The restoration reads the
run's messages from the newest end and only as far as the feed can still hold them; everything
older is named for the transcript by position and never examined. `cutCount` counts timeline
messages cut to the per-message bound and `historyTruncated` says Coding History itself cut the
task's messages: only those two leave text shown nowhere, so only they make the page say "Activity
truncated.". Counts only — never a message, path or run name. A run that ends keeps its live tool rows, as OpenCode does: `coding-runtime.safe-activity` records
`event=interrupted` with the closed `reason` (`stop`, `takeover`, or `run-ended` for every other
terminal state: failed, succeeded, budget or time exhausted) and the number of open calls it settled
as `cancelled` (#3907, #4491).

A model's answer is never cut to fit the bounded safe-activity feed (owner decision "Work-ending
limits"). The projection keeps the complete text of every assistant answer the feed lists beside the
feed, under a per-run memory bound, and the feed message names the answer's whole length
(`fullAnswer`) when its segments carry less. `coding-runtime.safe-activity` records
`event=answer-retained reason=feed-bound` the first time an answer outgrows the feed, and
`event=answer-clipped reason=retention-bound` at `warn` when the memory bound cut one, which the
message then shows as cut; `occurrenceCount` is the run's running count of each. The live history's
part bound (a text part up to 64 KiB, a reasoning part up to 16 KiB of UTF-8) is the one bound
before the projection: a longer part reaches the timeline as its prefix and is shown as cut, recorded
once per part as `event=answer-clipped reason=source-bound` (`reasoning-clipped` for reasoning) at
`warn`, while Coding History keeps the part whole for the restored run. The Workbench reads
the rest of a named answer page by page through the authenticated app-session channel:
pages of at most 256 Ki characters. `coding-app-session.answer-page.read` writes one summary line
per answer read, under the run's id: `outcome=served` once the page that reaches the answer's end
is served, with its `offset`, `pageChars` and `answerChars`, `complete`, whether the memory bound
cut the answer (`answerTruncated`) and the message id only as `messageIdSha256`. A refused read
(`outcome=unavailable`: no such run, message, offset or session, or an id that is not a safe
identifier) is written at its 1st, 2nd, 4th, 8th … occurrence on that server, with that running
`occurrenceCount`, so a client retrying a gone answer cannot flood the log. The
browser reports a failed read of the rest under the run's correlation (`errorKind=unavailable`) and
keeps the carried part marked as cut. Restored runs join Coding History's stored chunks of one
answer back into one message and show it whole. Copying an answer as Markdown is offered only for a whole answer,
never a cut, failed or loading one, and is recorded as the closed `answerCopy` outcome, never the
copied text. The model's reasoning is kept the same way:
`event=reasoning-retained reason=feed-bound` the first time it outgrows the feed,
`event=reasoning-clipped reason=retention-bound` at `warn` on a memory-bound cut, and page reads of
it carry `textPart=reasoning` (an answer page `textPart=answer`). Reasoning may hold at most half
of the run's retention bound, so a long chain of thought never pushes an answer out. A live
update's append-only `textDeltas` (at most 32 Ki characters each; a larger growth is read as pages)
are never logged: they carry model text.

A tool update the projection refuses (`event=dropped reason=projection-rejected
rejection=tool-transition-refused`) names the transition it refused: `refusedFromState` (the call's
state in the feed, `absent` when the call is not listed), `refusedToState` (the state the update
asked for), `refusedSignalSource` (`opencode` for OpenCode's part update, `keiko` for Keiko's own
settlement) and the call as `callIdSha256`. That tells an update the feed lost from a genuine
regression without the call id or any tool content.

`coding-repository-handler.settled` counts the hits a repository search left out after the scan:
`staleHitsSkipped` for a file that no longer held the match, `misplacedHitsSkipped` for one that
held it only outside the reported lines (or a hit without lines), `unreadableHitsSkipped` for one
that could no longer be read. A `misplacedHitsSkipped` above zero on a file nobody changed is a
defect in the scan. Such a hit is never shown and no longer fails the search: its other hits are
returned with the `io-error` truncation reason. A path the workspace boundary refuses after the
scan still fails the search (`scope-denied`). The projection reads, redacts and indexes each file
once, however many hits it holds and however the ranked hits of several files interleave, and holds
one file at a time.

`coding-runtime.tool.failed` records one line per tool call that failed, under the run's id, also
for a call the bounded feed had no room for; a call an explicit Stop or takeover cancelled is not a
failure and writes no line (the `interrupted` event above counts those). The line carries the closed `failureOrigin` (`keiko-refused`, `command-failed`, `tool-error`, `timed-out`,
`invalid-arguments`, `cancelled` only as a display state, never logged), the tool's closed class (a native tool's name, `keiko` for Keiko's governed tools,
`other`), a shell's `exitCodeClass` (`none`, `0`, `1`, `2`, `126`, `127`, `signal` for an exit status of
128+n, `other`; a command a signal killed outright reports no exit status, so it is
`command-failed` with `none`, never a stop), how often
that command has failed in the run (`commandFailureCount`) and the run's running totals of failed
calls and of repeated failures. The origin comes from the runtime's own status facts — Keiko's
permission decision, the shell's timeout, kill signal or exit status, the runtime's closed error
type for arguments it could not read (`invalid-arguments`), or the tool's structured error — never
from parsing a message. The command, its output, the tool's error message and the call
id never reach the log; the Workbench row shows them, after the credential floor, and commands are
told apart by a digest held in memory only. A verification or Git step keeps its own outcome
operations and has no failure origin. `keiko support analyze` therefore shows a run's pattern, for
example twelve command failures and no Keiko refusal.

`coding-runtime.history` also records a refused history request as `event=refused` under the
request's correlation id, with the closed `errorKind` `unavailable` (404), `conflict` (409) or
`invalid-request` (400). A status or title update checks that the task exists without reading its
messages, so completing a task records `updated` alone. A run that moved onto a task branch of its
own (`keiko_git_branch`) moves its task with it, recorded as `updated` with `branchChanged` under the
run's correlation id and never the branch name; a failure there records `failed` and leaves the
branch move standing (#4491). Removing a project that still holds Coding
tasks is refused with `PROJECT_HAS_CODING_TASKS` and deletes nothing, because a removed project
would take its Coding tasks with it. A scheduled wake continues only a task that is still active;
for a completed task it keeps waiting (#4491).

`coding-runtime.reap.stage` records each step by which the runtime manager ends a run's process
tree, under the run's correlation id: the closed `stage` (`graceful-timed-out`, `graceful-failed`,
`forced`, `force-failed`, `recovery-required`, `recovery-mark-failed`), the closed `outcome`
(`escalated`, `reaped`, `unproven`, `failed`) and `durationMs`; a failing step adds `frames` and
`causeChain`. A run that needs recovery therefore names the step that left its tree unproven
(#4491).

`coding-runtime.history.export` records the human's local export of a Coding History task (Export
JSON or Export Markdown; the browser saves the file, nothing is uploaded): `requested`, then
`completed` or `refused` under the request's correlation. A refusal carries one closed reason
(`unauthenticated`, `unavailable`, `invalid-format`, `too-large`, `failed`; a failure also its error
class, frames and cause chain), a completion the format, message, omitted and redacted-message
counts and the byte size. Message text is stored as the runtime produced it, so the export redacts
every string again with the evidence redactor and masks absolute host paths; no text, title, branch
or path ever enters the line (ADR-0137 D4).

`coding-runtime.history.import` records the human's local import of a saved task (Import task: a
Keiko task export or an OpenCode session transcript the person picks; nothing is fetched or
uploaded): `requested`, then `completed` or `refused` under the request's correlation. A refusal
carries one closed reason (`unauthenticated`, `unavailable`, `no-workspace`, `invalid-document`,
`unsupported-version`, `too-large`, `empty`, `failed`; a failure also its error class, frames and
cause chain), a completion the source, message, omitted, skipped and redacted-message counts and the
byte size. The file's text is untrusted, so it is redacted again before it is stored; no text,
title or path ever enters the line (ADR-0137 D4).

`coding-runtime.repository-relay` records Keiko's repository credential relay (#4522, ADR-0184): a
native run reads the Maven and npm repositories the person configured through a per-run, read-only
capability on the attested loopback origin and never holds a credential Keiko read from a file. A
credential Keiko takes from its own environment stays readable to a macOS shell (ADR-0184 D2). The
line records `bind`
(`bound` or `refused` with a closed `reason`), a refused or `failed` request, and one `settled`
summary per binding when its run is released (request, relayed, refused, failed, cancelled,
upstream client and server error and redirect counts, bytes, duration), under the run's
correlation. The admission line `coding-runtime.native-build-settings.admitted` adds
`relayMavenBoundCount`, `relayNpmBoundCount`, `relayRefusedCount`, the closed
`relayRefusalReasons` (including `id-ambiguous`, `rewrite-missed` and the informational
`profile-inactive`) and the closed `relayNpmTarballRouting`: how the run's npm reaches its
registries' tarballs. npm moves them onto the relay itself when the default registry is bound and
every bound registry is that URL (`always` below Full access, `registry-host` at Full access,
`npm-default` for the public registry or when no npm registry is bound); otherwise the relay
rewrites each packument's tarball URLs (`relay-url`). The closed `relayNpmRegistryEnvironment` says
how the run's environment names npm's registry: `relay` when an inherited `npm_config_registry` is
replaced by the relay of the bound default registry, `inherited` when an inherited name passes
unchanged because the default registry is not bound, and `none` when the run inherits no name. Never a URL, host, path, artifact coordinate, user name or credential; a
credential in a response is refused (`credential-in-response`), never rewritten. A repository URL is
never interpolated, a resolver never reads a `KEIKO_*` or provider variable, and only the person's
user-level files are read.

`coding-runtime.schedule.wake`, `coding-runtime.schedule.control` and `coding-runtime.schedule.lease`
record scheduled continuations (#4271, ADR-0137): a schedule a native run's model created wakes its
task at the due time while Keiko runs. The wake line records `started`, `waiting` (closed `wait`:
`run-active`, `workspace-inactive`, `retrying`), `refused`, `fired`, `missed`, `auto-paused`,
`removed`, `retain-lost` or `failed`, with the task and schedule digests, the wake run's id and mode,
counts and the due lag; the control line records a human's pause, resume, delete or list, or the
pause after three missed wakes (`initiator` `missed-wakes`); the lease line records Keiko's hold on
the runtime's scheduler, its release in the wake run and the re-hold once the schedule fired. Lines
of one wake run carry its run id as correlation; lines that belong to no run carry a correlation
derived from the schedule's digest. Never a schedule id, name, cadence or prompt.

`client.coding-workbench.interaction` records, at info and on the routine budget, what the human
did on the Coding Workbench page (#3897): a disclosure opened or closed (`section`, `expanded`), the
progress state (`progressState`), the agent picked (`build`, `plan` or `custom`, never a custom
agent's name), a start the human gave up before it had a run (`start-cancelled`), a jump to a pending decision, a repository bound for trust (its two body-free ids)
and a changeset received for review (`fileCount`). It also records a history task of another
repository or workspace that was not activated (`history-repository-switched`,
`history-workspace-switched`; #4118), a window that kept the task picked from Coding History or
a new task instead of following a settled run of another task (`history-run-held`, once per pick;
#4271), a run that needed recovery left with New task (`recovery-left`, once per departure; F30), the starting repository of a window without a stored one, decided only after the
task-workspace state answered (`repository-seeded` from the shell's project or
`repository-seed-skipped` for an active task binding, once per window; #4271; `repository-returned` when the Git window hands a just-added folder back to the window that asked for it, #4371), a workspace activation the Workbench requests on its own
(`workspace-activation-requested` with the closed `activationTrigger` `window-selection`, `window-pinned`, `shell-seed` or `active-follow`, under the request's correlation; U-3. A Workbench window that only followed the active workspace and itself started or continued a run pins the repository that run works in (`repositoryPinned` in its persisted configuration, kept across a reload; layouts saved without it still load), so after the run it stays on that repository instead of following the active workspace again until an explicit selection replaces it. A pin is not a selection: it holds only while it is the active repository or none is active, and once another window moves the active workspace elsewhere the window follows it instead of binding its pin back. A window never pins the run of another window; a window never binds anything while its run state is unread, and the shell's seed never overrides an active workspace. A server selection of the workspace that is already active logs `task-workspace.lifecycle` `activate` with the outcome `unchanged` and ends no undo window) and a refused editor
bridge registration
(`bridge-registration-refused` with the closed `refusal` `root-boundary` or `lease`, under the
refused request's correlation and the run as parent; #4117) and a diff that switched to the
windowed review (`diff-windowed` with the closed `surface` `changeset-review`, `run-changes` or
`answer-diff`, and `fileCount`, `totalLineCount`, `totalByteCount`; once per diff, not per page turn;
never a path or diff text; #4108). An unpaired window names the missing pairing once, in the
run status sentence, and holds its secondary notices until it is paired; each hold is recorded as
`notice-held` with the closed `notice` (`task-session`, `skills`, `mcp`, `activity`, `questions`,
`editor-bridge`; #3880). `run-identity-observed` records once per live run whether the server
reported the run's model and agent (`modelReported`, `agentReported`) and its closed `toolProfile`
(`native`, `mapped`, `unreported`); `coding-runtime.run.started` carries the started run's closed
`primaryAgent` and `modelIdDigest`, never a model or custom agent name (#4068 W12). A run that changed code and
ended without a passing check after its last change records why, on `coding-runtime.run.settled` as the closed
`verificationGap` (`no-check-run`, `check-failed`, `check-not-started`, `budget-exhausted`; #4491) with
`errorKind=validation-failed` unless a check was blocked, and why no
continuation ran on `coding-runtime.run.verification-continuation` as `state: skipped` with the closed `skipReason`
(`docs-only`, `no-failed-check`, `blocked`, `budget-exhausted`, `already-continued`); the one continuation that does
run records `state: continued` with the failed `check` and its `failedCount`, never a path or output. What a delivery card showed is `delivery-step-shown` with the closed
`deliveryStep` (`delivery-review`, `stage-review`, `unstage-review`, `commit-review`,
`commit-result`, `draft-delivery`, `ci-readiness`, `journey`) and only that step's closed
`deliveryState` (a review's load state, a commit status, a delivery phase, a CI or journey state;
never a head or tree digest; #4271). Once per mounted window, `repository-resolved` records where
its repository came from with the closed `repositorySource`: `window` (its own saved selection,
which the layout retains with its branch and location), `shell` (the folder the shell held) or
`none` (an active task binding met it first); never the path (#4068). These were warn/unknown
`client.diagnostic` notes before and buried the rare real browser failures. The server side of
that bridge records each registration on `editor.agent.bridge-registration` (`registered`,
`refreshed`, `rotated`, or `refused` at warn with the closed root-boundary reason or
`capability-held`). A root-boundary refusal holds until the run or its root changes; only a held
lease is retried with backoff. The editor action queue is bounded by count, by serialized bytes per
session (64 MiB) and by serialized bytes for the process (256 MiB); every `QUEUE_FULL` refusal is
recorded on `editor.agent.action-queue` with the closed `reason` (`queue-count`, `session-bytes`,
`process-bytes`) and the action, session and process counts and bytes (#4107). `gateway.setup.target.accepted` records,
at info, that Gateway Setup accepted a loopback target (KEIKO-0884), with the request correlation
and the closed `targetClass`; it is no longer an error-level `server.diagnostic.failure`.

A confined Windows run (#4068, #4495; ADR-0043 D21) records what its supervisor reports about the
tree, as counts and numbers only. `runtime.confinement.stale-grants-swept` carries the launch's two
sweeps: stale tree entries (`removedEntryCount`, `failedCount`) and the profiles of runs whose
supervisor is gone (`removedProfileCount`, `failedProfileCount`); it is written only when a sweep
removed or failed to remove something, and a failed count is a diagnostic.
`runtime.confinement.tree-reaped` carries the tree root's exit code (`rootExitCode`) for every
reaped tree; `0xE04B0001` (3763011585) and `0xE04B0002` (3763011586) are the relay root's own
failures (its routes could not be set up, the runtime could not be created). A refused start names
its step on the `coding-runtime.exit` diagnostic, for example `supervisor-no-desktop` (started from
an SSH or service session); the refusal words are one per supervisor error code and
`nativeRuntimeProcessTree.refusal-codes.test.ts` fails when a code lacks its own.

A runtime Git `status` reads the repository once: its facts and its answer come from the same raw
scan. `git.raw-status.conversion-settled` (and `.conversion-failed`) additionally carry `listingMs`,
`scanMs`, `settleMs` and `gitSpawnCount`: where the scan's time went and how many Git processes the
operation had started by the settlement. The promisor probe that guards every read runs once per
operation (a read session), not once per read. `git.runtime-action` names a read that ended under the
run as `deadline-exceeded` (the tool's own budget), `signal-aborted` (a Stop while authority held) or
`authority-revoked` (authority lapsed); the model-facing refusal stays `authority-revoked`.

## Coding Workbench request deadlines, Editor and window binding

`client.coding-workbench.request-timed-out` records, at warn on the failure budget, a runtime
request the Coding Workbench gave up on at its own client-side deadline (#4109): the closed `call`
(`status`, `snapshot`, `start`, `approval`, `stop`, `takeover`, `retry`, `recovery-ack`, `pause`,
`resume`, `follow-up`, `revert`, `inbox`, `research-revoke`, `question-answer`,
`question-reject`) and `deadlineMs`, under the failed request's correlation id; a mutation that
Stop preempted is not a timeout and is not reported. The deadlines come from measurements: 10 s for
status and snapshot reads, 15 s for Stop, 180 s for start (a cold start is unmeasured) and 60 s for
every other, unmeasured, mutation. A start that hit its deadline re-reads the run, because the
server may have started it; when the client hung up before a run existed, the server creates none
and records `coding-runtime.operation.refused` with the route-level reason `start-abandoned`, a
reason never stored or sent as a failure code. Stop is never queued behind another mutation: it ends the client
wait of the one in flight (no alert, no failure) and drops those still waiting, and stays enabled
while another mutation is pending. Closed values and one duration only.

`client.editor.line-ending.adopted` records, at info and on the routine budget, that the Editor's
Monaco model adopted the line ending of text Keiko wrote into it (#4123): `lineEnding` (`lf`,
`crlf`) and `source` (`buffer-sync` for a controlled sync such as a reload from disk, `host-edit`).
Monaco gives a model created without a line break the platform default, so a Windows browser would
otherwise normalize a reloaded LF file to CRLF and report the unchanged buffer as an unsaved human
edit. The adoption shares the write's undo step. `client.binding.resolved` carries the optional
`projectOpenAttemptCount` when a Chat's project open had to be repeated because a competing
workspace update overtook it; the repeat is bounded to three attempts per routing episode, and an
episode that ends (the project held, the window no longer needs one, or the open failed) frees the
budget for the next one. When every attempt was overtaken, the window stops waiting, shows that the
Chat could not be opened and records `client.binding.project-open-exhausted` at warn (`conflict`,
failure budget) with the required `projectOpenAttemptCount`. Closed values and counts only, never
text or paths.

## Editor debugging start

`dap.debug-session.startup-attempt-failed` records, at warn, each failed attempt of a debug
session start (#4103): the attempt number, the step that was running (`capsule-launch`,
`capsule-attach`, `endpoint-connect`, `initialize`, `initialized-event`, `configure`,
`configuration-done`, `launch-response`, `mark-running`), the closed `DebugProcessErrorCode` as
`failureCode` (or `unclassified`), whether another attempt follows (`retry`) and the attempt's
`durationMs`, under the start request's correlation id. A start ended `STARTUP_THROTTLED` names
the two attempts the throttle stopped, so the bound that fired is visible. The registry still
allows two attempts per session in a rolling 60 s window.

`dap.debug-session.start-refused` records, at warn, the closed `reason` a start route answered
with instead of an opaque 500: `STARTUP_THROTTLED` (503), `CAPACITY` (429), a previous session
still ending, a session gone while starting or an invalid target (409), an unavailable adapter or a
shutting-down service (503), and any other closed adapter failure (502). The response carries the
same code and the request's correlation id; an unclassified error still reaches the top-level
catch with its frames. Closed values, one count and one duration only.

## Confined Windows verification steps and the step Node.js

`editor.verification.windows-step-supervisor` records, once per resolution of a verification run's
Windows step backend (#4496, #4492; ADR-0043 D21), the supervisor's closed `outcome`, the count of
read roots, whether a Maven step may read the person's repository (`mavenRepository`) and, new with
#4492, the runtime's patched Node.js as the closed `stepNode`: `patched` (the folder is a real
folder that holds exactly the pinned `node.exe`), `absent` (the runtime carries none, this server
has no pin, or there is no supervisor to find the runtime from) or `mismatch` (the folder, its
contents or the bytes are not the pinned build; it is never offered). With `absent` or `mismatch`
the steps run exactly as they did before, so a project that needs no Node.js is unaffected and the
log names why a Node.js step may hang. A file that could not be read to verify it also answers
`mismatch` and carries the diagnostic `editor.verification.windows-step-supervisor.step-node-unreadable`
with a correlation id. `stepNodeMismatch` names the check a `mismatch` missed (`not-real-folder`,
`extra-entries`, `not-ordinary-file`, `size`, `hash` or `unreadable`; `none` otherwise), so a log
tells a stale package from a rewritten file. #4496 adds, as counts per reason and never as paths,
the named toolchain homes left out, once per real folder however many homes name it (a home that
is unset or does not resolve to a drive folder is not counted): `readRootRefusedDriveRootCount` (the
home is a drive root), `readRootRefusedM2Count` (the home holds or sits in the profile's `.m2`,
named or relocated), `readRootRefusedCredentialCount` (it holds or sits in one of the profile's
credential stores, named or relocated, or holds a credential-named entry) and
`readRootRefusedUnlistableCount` (it cannot be listed), and `profileKnown`: without a known profile
folder every step is refused with "the user profile folder is unknown".

`editor.verification.windows-step-node` records, at the start of each step that holds a verified
step Node.js, what the step does with it, on the run's correlation id: `image` (`step-node` when the
step starts the step Node.js directly, for a command named `node` or an npm or npx started through
it, `resolved` otherwise), `npmLaunch` (`step-node`, `install-cmd` or `not-npm`), `npmFallback`
(`none`, `cli-missing` when the install has no `npm-cli.js` or `npx-cli.js`, `cli-outside-grant`
when it resolves outside the install's folder), `pathPrefixed` and `placement` (`applied`, or
`inside-execution-root` for a folder the step may modify, which is never used). Closed values only:
never a path.

## Gateway readiness, model activation and the tool-calling check

`gateway.conversation.admission` records the closed decision before a conversation model call,
with admitted and current configuration generations and the request correlation. A successful startup
observation remains usable for the same configuration generation; its age is diagnostic only
(`allowed-fresh` or `allowed-cached`). Conversation requests, page loads, model-list reads and
Workbench choices never initiate another readiness probe. Configuration replacement invalidates the
observation; a failed or missing result requires explicit verification in Settings > Models.
A definitive authentication or missing-model failure on a real model call withdraws that exact
current observation (`provider-rejected`); a late failure cannot overwrite a replacement generation
or a newer verification. Rate limits, timeouts and transient provider errors do not erase a proved
capability. Refusals distinguish model or generation replacement, absent observations, failed probes
and invalid timestamps without recording model names, requests or answers. An uninvoked model port
consumes no physical synthesis attempt or uncertain output reservation; actual interrupted provider
calls retain conservative accounting.

Keiko lists every model a gateway offers through metadata requests, which cost nothing, and sends
an inference request only to a model a person activated (#4351, owner decision 2026-11-13; manual
activation, product decision 2026-11-16): a check loads the model, which on a shared gateway evicts
a model somebody else is using. Startup checks no chat model and starts no tool-calling proof; every
chat model is inactive in each server process until the person activates it in Settings > Models
(per model or "Activate all"), and that activation is its readiness check. Replacing a connection
deactivates it, and the person can deactivate an activated model there again (Deactivate,
`POST /api/gateway/readiness/deactivation`): that sends nothing to the provider, the model leaves the
Chat picker and is refused until it is activated anew, and a deactivation while that model's check
still runs is refused (`gateway.readiness.deactivation` records the closed outcome). Only activated models are offered by the Chat picker and elected as an automatic
default (Chat create and the Workbench prefer activated models over a better-ranked inactive one);
a pick or a Send in Chat and a pick or Start in the Coding Workbench never start a basic-chat check.
The Workbench proves tool calling and context only for an activated model. Startup still probes the
embedding model in use, and Gateway Setup verifies the model that becomes the default (which
activates it) and the embedding model in use: the other listed models are configured as listed and
inactive. Gateway Setup keeps the full verification round for explicitly named deployments;
for a discovered listing, a candidate the walk reaches and the gateway rejects is dropped, a wildcard
route pattern is dropped by its shape without a request (a listing of nothing else fails with its own
reason), a default that got no verdict from a gateway that answers (a timeout of its completion, a rate
limit, an overloaded status) is kept unverified and the walk stops, a failure to reach the gateway at
all (refused connection, unknown host, TLS or proxy fault) is no verdict and takes the existing
base-URL fallback and deferred admission without saving anything, and the listed models no request
reached are configured and reported as unverified. A model kept without a verdict is saved only
because the answer names it as not verified (the dialog tells the person to activate it in
Settings > Models), its tool-calling record is `unverified`, and no successful observation is
recorded for it. A request for a model with no current positive observation is refused and starts
no check: Chat send and regeneration answer 400 `CONVERSATION_MODEL_NOT_READY`, a coding run start
is refused as model-unavailable (`conversation-not-ready`), and the Voice queue retries a bounded
number of times and then suspends with the transcript kept. Opening an empty local Chat requires a
configured chat model and works while readiness is unknown or failed; `chat.creation.opened`
records the closed readiness observation without starting a check. A window opening or restored
selection reads the Workbench profile with `check=use`, which may join a check that already runs and
report the state but never dispatches one; a pick or Start sends `check=1`, and a Start belongs to the
model it was pressed for (a model adopted or picked meanwhile ends its wait with a plain message and
starts no run). When no activated model can start a run only because its tool calling was never
confirmed (the state after Gateway Setup) or its proof aged out, the Workbench lists those activated,
not refuted models and offers one explicit "Check tool calling" action that sends `check=1` for the
selected model (`client.coding-workbench.interaction` `tool-check-requested`); with an eligible model
present the picker lists eligible models only, and nothing starts a check by opening a window
(ADR-0171). `gateway.readiness.scope` records how many models were listed and checked and why,
only for a check that actually sent a request; `gateway.readiness.selection` remains the record of
the server's selection route, which the Chat picker no longer calls; and
`gateway.readiness.automatic.started` carries the closed `checkReason` (`startup`, `fallback`,
`selection`). Nothing renews or recovers a model on a timer or passive read. Activation may retry an
unsuccessful check. Startup-owned catalog work can be observed with a bounded, cancellable metadata
wait; disconnecting a browser does not cancel shared discovery or start another provider call. The
Workbench profile describes the model chosen in its picker (`modelId`) and its own observed
verification, rather than the gateway-wide state. `model-verification-pending` means that a check of
that model is already running; a tracked model nobody activated is `conversation-not-ready`;
`tool-calling-unverified` records an unknown tool capability without dispatching a probe.
See [ADR-0171](../adr/ADR-0171-gateway-readiness-capability-reconciliation.md).

The tool-calling check runs in two steps (#4351, owner decision 2026-11-13): first as production works, the
tool offered and no forced `tool_choice`; only a model that called no tool is asked once more with the
forced named call. It ends in one of six closed outcomes (`called-unforced`, `called-only-forced`,
`forced-refused`, `no-call`, `tools-refused`, `inconclusive`), recorded as `toolCallingOutcome` on the
existing readiness completion lines and told in plain words in the tool-calling evidence of
Settings > Models. A forced call the provider refuses (a thinking mode answers HTTP 400 to
`tool_choice`) is never a verdict that the model cannot call tools, and writes no "unsupported"
record, but it confirms nothing either: the conversation stays admitted and tool turns stay
`unverified` until a check passes. `called-only-forced` is admitted. Settings > Models words every closed outcome in one plain
sentence per language (`settings.models.toolOutcome.<outcome>`, informal German), saying what it was
and what to do next, in place of the server's English evidence; a new outcome without a sentence
fails a test. A check a
person starts in Settings waits at least the interactive silence floor for a slow model when the stored
configuration does not name a provider timeout (a timeout a person named, whatever its value, stays as
configured; a person's value is stored with `timeoutNamed: true`, and Setup's own 30 s default is
stored bare, as are the 30 s and 120 s defaults of installations written before the marker, so those
read as defaults); it is bounded, cancelled when
the request closes, shown on the start line as `chatProbeTimeoutMs` and announced as still running; no
conversation turn is affected. Every tool definition leaves the gateway as a plain object schema (no
`oneOf`, `anyOf`, `allOf`, `enum`, `const` or `not` at the top level; the alternatives are named in the
description), and Keiko's own validation keeps using the original schema; a hermetic walk over every
registered tool definition fails on any other construct at the root; alternatives nested below the root
pass unchanged (the captured provider 400 and rule name the top level; a live pass is the evidence for
nested ones). A meter read that withholds the window probe for an unused model records
`gateway.context-window.probe` state `skipped-unused` once per deployment and generation. The meter read of a Chat's context window
sends its probe only for a model a person has used: an actual model call completed through the
current configuration generation, or an explicit Settings check passed (a startup observation is not
use). Operator procedure:
[`docs/troubleshooting/model-does-not-call-tools.md`](../troubleshooting/model-does-not-call-tools.md).

## Chat scope, context selection and gateway admission

`chat.scope.update` records a serialized source update as `applied` or `conflict` under the
request correlation, with optional `expectedScopeDigest`, required `actualScopeDigest` and
`resultScopeDigest`, and connected/local-knowledge/Git-change source counts. Send and PATCH
validate a supplied `expectedGroundingScopeIdentity` against the current server-issued identity;
a stale identity returns 409 `GROUNDING_SCOPE_CHANGED`. Git-change description authority is
checked separately, and ordinary regeneration refuses connected folder, knowledge and Git-change
scopes with 409 `NOT_APPLIABLE`. See ADR-0057 for the identity and admission boundaries.

A Chat connected to exactly one folder and to nothing else offers its model the read-only tool
`folder.files` (list a directory, search, read a line window) for repeated use within one turn; the
automatic first retrieval stays (owner proposal 2026-11-21, ADR-0181). `folder.files.turn-selected`
records once per turn whether the tool turn ran (`tool-turn`) or the single retrieval was kept
(`one-shot-model-not-tool-ready`, `one-shot-scope-unavailable`, `one-shot-catalog-unavailable`).
`folder.files.operation` records each call under the request correlation: the `view`, `outcome`
(`cancelled` or `timed-out` for a call the turn's stop or deadline ended, which returns nothing),
the closed `reason` of a refusal, returned count, result and payload bytes, scanned files,
unavailable hits, whether more exists, and the turn's cumulative calls, search time and result
bytes. Never a path, a query or file text. Lines the tool returned are merged into the sent pack and
may be cited; any other line stays an unsupported citation. The tool runs on the search scope of
the request's own retrieval, under the `connected-folder` authority subject with `folder.read`
only. Never give it a regular-expression mode, a write, or a scope the retrieval does not have.

Chat context selection emits `chat.context.selected` before the provider call for buffered,
streaming and regenerated turns. Its request correlation joins the compacted/retained history
counts, estimated removed-prefix and summary costs, savings, final estimated prompt cost,
effective input budget and image reserve. This evidence survives generation timeout or
cancellation; the successful-turn compaction manifest remains separate. These are local estimates,
not provider-measured usage, and no conversation or image content is recorded. With memory on it and
the grounded `chat.response.message` also count the standing profile and recall (#4228):
`profileEntryCount`, `profileTokens`, `profileDroppedCount`, `profileRetrievedCount` (profile
facts the question was about, sent once with recall), `retrievedMemoryCount`,
`belowFloorMemoryCount` and `semanticFloor` (the cosine floor in force, only with semantic scores),
never a fact
([MemoriaViva standing profile](../memory/memoria-viva-standing-profile.md)).

Gateway admission additionally records `imageCount`, optional `documentCount`, the selected
`imageAccounting` rule, `imageReserveTokens`, `localPromptTokens`, `fallbackPromptTokens`, and,
when present, `reportedPromptTokens` plus schema-adjusted `providerPromptTokens`. PDF document
parts take the same per-part media reserve as images. A positive reported count
replaces the image reserve even when the local text/tool/schema floor determines the final total;
a zero count retains the reserve. The recorded candidates make those decisions distinguishable.

Circuit admission that cannot fit a caller's remaining budget emits `gateway.circuit.wait` with
`budget-refused`, `remainingMs` and `delayMs`; it does not fabricate a provider attempt or retry.
Parallel retryable responses may extend the recovery minimum of the same open outage, while probe
ownership and later circuit generations remain protected. Unchanged admission state does not wake
every waiting caller.
For a saturated probe, `delayMs` records the remaining request budget (zero at expiry), not a
fabricated cooldown. A stream records its start before admission waiting and its zero-chunk failure
if admission is refused or cancelled. Late sibling probes cannot extend a reopened outage.

On retries, `reportedPromptTokens` always describes only the current counter response and is
absent when that response has no count. `providerPromptTokens` adds the current response-schema
cost to that raw count; `retainedPromptTokens` separately records the carried measurement floor
plus schema cost. Admission preserves the maximum of local, current-provider and retained
candidates. `counterSource` identifies a winning retained floor as `retained-measurement`, and
`imageAccounting` uses that disposition when only the retained positive measurement replaces the
image reserve. Neither retained value is presented as a new provider observation.

## Context window, citations, entailment and assessment

A chat model whose window nobody declared is planned as `contextWindowAssumed` until the provider
states it. `gateway.context-window.probe` records the one-per-deployment window probe (`reported`,
`not-reported`, `failed`, `skipped-spend-budget`) under its own correlation joined by
`parentCorrelationId` to the reading that spawned it. `gateway.context-window.adoption` records the
adopted window with its source (`window-probe`, `provider-overflow`), the previous window and
whether it was assumed, or `stale-deployment` when the stating deployment was replaced.
`gateway.context-window.retry` records the single re-planned retry of an admitted turn, with its
surface and the planned and adopted windows. All three carry a correlation id and a model digest,
never provider text.
`search.prompt.window-fitted` records a Knowledge Pod answer prompt that dropped trailing references
to fit the model (`trimmed`) or could not fit a single one (`refused`), with the reference counts,
the prompt size and the input budget.
`client.knowledge-catalog.unavailable` records the six counts of a Knowledge Pod picker that offered
no usable pod (pods, ready pods, sets, bound, missing, not ready), never a name, path or id.
`search.citations.reconciled` records numeric-reference and file-location reconciliation for
Knowledge Pod, connected-folder, multi-source and hybrid answers under the request correlation.
`citationKind` distinguishes `numeric` from `file`; hybrid answers may emit one line of each kind.
The closed outcome (`cited`, `cited-with-dangling`, `dangling-only`, `uncited`, `refusal`,
`assessment-only`) and reference, attached and dangling counts describe the actual reconciliation. File lines also carry
ambiguous-marker and dropped-implicit counts. Weak-overlap and grouped-marker counts are optional:
absence means they were not measured on that path, not zero. `gateway.discovery.alias-intersection` carries
the `role` discovery gave each alias (`chat`, `embedding`, `voice`, `rerank`, `unsupported`), and
`gateway.reranker.setup.resolved` records once per committed setup whether a discovered reranker was
`wired`, `kept-existing` or `probe-failed` (at `warn`, with a diagnostic), with candidate and probe
counts. The `inspected` `chat.context.management` line also carries the meter reading's optional
counts: stored and projected history, knowledge-source tokens, the sent and available reference
counts, the last knowledge request (measured and estimated), the system, summary and message shares,
the automatic-compaction trigger, and the assumed-window and pending-probe flags. Grounded
readings also carry the conversation lane budget and unused source capacity separately; a
conversation checkpoint is validated against that lane, not against the entire model window.
`search.entailment.judged` records, per grounded answer the judge read, the judged, unsupported and
undecided claim counts, so the displayed "N unsupported claims" is reconstructable, and
`hiddenProseClaimCount` counts the claims it could not judge because bracketed prose was stripped.
`search.citations.support-settled` records the settled caveat of a Knowledge Pod answer (`none`,
`judge-undecided`, `no-judge`, `unjudged-citation`) with its weak-citation and hidden-claim counts. The multi-source
prompt reports a trim or refusal on `search.prompt.window-fitted` like the Knowledge Pod and hybrid
prompts. `client.answer.copied` records each chat answer copy (`copied` or `failed` at `warn` with
its error kind and frames), whether the answer was grounded, and how many marker groups the copy
removed and kept, never the copied text. `client.answer.speech-prepared` records the same counts
for an answer read aloud in the voice dialogue, under the correlation its synthesis request carries.
`search.answer.assessed` records whether a connected answer carried Keiko's own, labelled
assessment (`none`, `assessment`, `assessment-only`, `neutralized`), under the existing operator
policy (`allowed`, `disabled`), with character sizes only. This learned knowledge is available
without Internet or matching evidence; source-specific claims still require actual sent evidence.
Disabled assessment text is dropped, never promoted into source-backed claims. Source-linked
observations carry the canonical scope/query digests and `phase` (`candidate`, `accepted-final`);
only the final accepted phase can explain delivered source-warning eligibility. Candidate or legacy
unbound observations cannot suppress retrieval-miss findings. The citation sibling records
`assessment-only` with zero source-marker counts, and repair never changes the assessment block.
A no-anchor general request can use the same validated empty pack and cumulative synthesis grants
when the policy allows assessment; scope validation and disabled-policy clarification still apply.

## Reasoning, tool arguments and answer repair

A model turn's reasoning share is counts only (#3878): `chat.response.streamed` records the
provider events that carried `reasoning_content` and their bytes (`reasoningEvents`,
`reasoningBytes`); `gateway.chat.completed` and `gateway.stream.completed` record `reasoningBytes`,
the provider-reported `reasoningTokens` (absent when not reported, never estimated) and
`reasoningDisposition` (`none`, `forwarded`, `discarded`); `coding-sidecar.gateway.usage-settled`
records `contentBytes`, `reasoningBytes` and `reasoningTokens` beside `outputBytes`;
`coding-sidecar.gateway.outcome` records the `reasoningFrames` and `forwardedReasoningBytes`
forwarded to the coding runtime, `reasoningWithheld` for a buffered answer delivered without its
oversized reasoning, and on an `output-limit` turn the bound that ended it (`limit`: `answer`,
`reasoning`); and `coding-runtime.history-projection` the `reasoningSignalCount` a history read
prepared for the timeline. OpenCode persists a streamed text or reasoning part only empty and then
complete, so the timeline grows from the runtime's delta events: the same line counts, since its
previous line, the deltas that grew a live part (`liveDeltaCount`), the ones that extended nothing
(`liveDroppedCount`), the parts whose complete text did not extend what was shown
(`liveDivergedCount`) and the events folded into earlier history reads (`mergedEventCount`). It also
counts the native tool calls of the pass that ended in an error (`toolErrorCount`) and, of those, the
calls the runtime refused for their arguments before the tool ran and asked the model to repeat
(`toolArgumentErrorCount`, matched on the runtime's own message and pinned on the real binary, #4546);
never the message itself. A sync
reads and projects only a bounded tail of the newest messages once the earlier pass is committed and
caught up (#4104): the projection plans an anchor message, the read ends there, and the older messages
are carried over unchanged. The runtime completes a streamed part in place, so every message from the
anchor on is projected again; a complete read replaces the tail when the anchor is gone (a revert or
compaction), every 256 tail reads, after a pass cut at the event cap, and while an older message still
holds live text. The same line records how: `readMode` (`tail`, `full`, `verify`, `anchor-lost`),
`readMessageCount` (messages handed to the projection) and `retainedMessageCount` (older messages
carried over). The continuation's complete read stays strict (`history-oversized`). The
reasoning text never enters the Activity Log, a support export, run evidence or Coding History.
Arguments of the governed exact-content tools (`edit`, `write`, `patch`, `execute`, `shell`;
#4009) reach the tool byte for byte: the gateway removes only the configured provider literals
from them, never a heuristic secret shape; every other tool's arguments keep the full redaction. When a literal was removed,
`gateway.tool-arguments.redacted` records the tool-call and changed-string counts at `warn`.
A model answer that exhausted its output budget, or ended after reasoning, without a tool call or a
final answer gets one steered repair from the gateway on a call that asks for it with the explicit
`answerRepair: "steered"` (the coding sidecar route and every round of a Chat tool turn; #3873, F17,
F23, S09 of epic #4173), and the log records it
in closed words only: `gateway.retry.scheduled` names it with `reason=output-exhausted-repair` or
`reason=empty-answer-repair` (`retryable-error` on every ordinary retry), and
`coding-sidecar.gateway.outcome` and `coding-sidecar.gateway.turn-failed` record `repairAttempted`
and, when a repair ran, `repairOutcome` (`recovered`, `exhausted-again`, `empty-again`, `failed`,
naming how the repaired attempt ended) — a line written before the gateway call settled (a byte cut,
a cancellation) omits both, because it cannot know; a repaired turn that failed the same way again
is final for the coding runtime (`runtimeRetry=refused`). The provider usage of the attempts a call
discarded (a repair's first answer, a rejected tool call) remains in the run's cumulative usage
roll-up without a prompt-token allowance, and `coding-sidecar.gateway.usage-settled` names it (`discardedAttemptCount`,
`discardedPromptTokens`, `discardedCompletionTokens`). A turn whose model wrote its tool call as text
(finish `stop`, no native call, markup naming an advertised tool) is re-requested by the gateway at
most twice with one fixed hint (ADR-0137, live defect M-1); `coding-sidecar.gateway.outcome` then
carries `textualToolCallRecovery` (`retried-native`, `retry-exhausted`, `retry-skipped`, `retry-interrupted`) and `textualToolCallRetries`,
never the markup. The correction the model receives is one fixed
sentence, and the failed answer's reasoning is never recorded. For default and shared-history profiles, runtime reasoning fields are
never forwarded directly: the coding sidecar drops echoed reasoning fields and reasoning-only assistant
messages, and `coding-sidecar.gateway.request-validated` counts the dropped messages. By default
prior reasoning is omitted. A qualified provider can explicitly select `reasoningHistory`:
`required-with-tools` restores all previous assistant reasoning when tools are advertised;
`current-turn` restores only assistants after the latest user message. The gateway restores only
completed responses from bounded, session- and provider-bound transient state, independently of
`codingReasoningDisplay`; `reasoningHistoryField` selects `reasoning_content` (default) or `reasoning`.
Missing, expired or ambiguous required state fails closed. Same-generation context refinements
share state; a configuration generation change starts independent state. Full-history providers use a fresh
native Coding session and the existing history replay instead of resuming/forking incomplete
protocol state. `gateway.reasoning-history` records only closed state and counts; reasoning never
enters evidence, logs, history exports or repository files. Identifying echoed reasoning requires
the runtime to preserve part types: reasoning already relabelled as ordinary text cannot be identified from
the wire body. ADR-0137 D8 records the pinned runtime's interrupted-reasoning qualification limit.
A deployment with no such setting is detected, not configured (#4351): an unattributed HTTP 400 on a
tool-turn continuation is answered once with the current turn's retained reasoning restored (the closed
retry reason `reasoning-restore-repair`; the model request only, never a re-run tool, never a replayed
write; a stream only before its first chunk); only a successful retry marks the deployment as wanting
its reasoning back, held in memory for the gateway instance (gone with a generation change, never
persisted or logged beyond the closed states `learned` and `unlearned`) and shown in Settings > Models;
a second rejection surfaces the original error; an explicit setting always wins; the current turn's
reasoning is kept in memory for this purpose only and dropped when the turn ends (a final answer, a
failure or a cancellation of a gateway call; a turn that ends outside the gateway waits for the next
turn of the session or the 30-minute idle TTL). A learned deployment that rejects a continuation which carried its
reasoning is answered once without it (the closed retry reason `reasoning-withhold-repair`, still one
retry per call); when that succeeds the deployment is unlearned, and a second rejection surfaces the
original error and changes nothing.

For the authenticated native Coding path, the separate explicit provider policy
`reasoningContinuation: "required-with-tools"` uses the existing native session as the sole
continuation owner (#4059). It is mutually exclusive with `reasoningHistory` and
`reasoningHistoryField`; its qualified wire field remains `reasoning_content`. The native context
hook reads canonical session context and removes excluded rounds from lowered context before
provider serialization, excluding aborted, unfinished
and foreign-model assistant rounds and orphaned tool results. Existing run and retained-session
route bindings prevent continuation under changed or unproven routes. This native path retains exact
completed reasoning independently of live display, checks the current credential floor, and applies
full byte, context and spend limits. Missing, conflicting, secret-bearing or oversized state fails
closed. It bypasses the shared transient history cache and preserves native resume/fork ownership;
no additional reasoning store is introduced. Activity evidence contains counts and closed outcomes
only.

The text a model wrote beside its tool calls is resent as written, like a standalone OpenCode run
(#3907); only a tool-calling turn without
text goes upstream as `content: null`, and the same line counts the others as
`toolCallTextMessageCount`. The gateway hands reasoning only to a call that asks for it with the
explicit `reasoningDelivery: "forward"` (the coding sidecar route alone); the `coding-workbench`
latency profile selects timeout floors only.

## Speech and drafts

For dictation, `speech.stt.request.dispatch` records the sent container class and byte count,
and `speech.stt.request.completed` records a received provider HTTP status. An absent status
means no response was observed. When a provider's `text` is exactly its verbose segments joined
by line breaks (whisper.cpp), the adapter joins the segments as they are and the same line counts
the removed separators (`segmentSeparatorsRemoved`); any other line break is the provider's own
and stays. Browser clips are normalized in memory to mono PCM16 WAV;
normalization failures use the existing body-free client diagnostic sink (ADR-0100 D8).

Chat draft persistence uses `chat.draft.operation` for read/save lifecycle and status only; the
Coding Workbench composer reuses that store per Workbench window (`surface: "coding-workbench"`).
Draft text belongs to the authenticated, chat-bound private UiStore and never enters logs or
browser persistence; stale revisions fail closed (ADR-0114 D1).
