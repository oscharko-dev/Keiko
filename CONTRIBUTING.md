# Contributing to Keiko

Keiko is built to a production-ready, enterprise quality bar: strict TypeScript (no `any`), tested behavior,
minimal runtime dependencies, and reviewable, evidence-backed changes. The architecture and release constraints
are recorded in the [Architecture Decision Records](docs/adr/); read the current decisions before opening a pull request.
Working, clean, secure, verified code is authoritative. ADRs are architectural guardrails and
memory, not executable truth: if a repair exposes outdated, contradictory, or unsafe ADR text, fix
the code and update the affected ADR sections together. Do not preserve a defect merely because an
ADR recorded it, and do not create a new ADR merely to correct existing text.

## Small, verifiable changes

Agree on the observable outcome and acceptance evidence before implementation. Keep each PR focused
on one independently reviewable result; split unrelated changes so a failed experiment can be
reverted without undoing unrelated work. Use the existing gates to verify the actual changed
behavior and report command, result, environment and limitations in the PR.

Consult [EXPERIENCE.md](EXPERIENCE.md) for relevant repository traps and maintain a lesson only
when evidence changes it. Review follows the existing
[review standards](docs/qa/review-standards.md) and
[settlement rules](docs/qa/review-settlement.md). Risk determines investigation depth, never
permission to skip required checks or the owner's integration authorization. Use deeper boundary
analysis for authorization, persistence, migrations, updater, supply-chain and workflow changes.

## Local development

```bash
npm install                # install all workspaces from the single root lockfile
npm run provision:usearch  # ONCE per checkout — see AGENTS.md §2
npm run provision:ripgrep  # coding-runtime search tool; needed by customer-shape, the nightly real-binary journey, portable staging + npm runtime package build — AGENTS.md §2
npm run build              # compile TypeScript outputs
npm run typecheck          # strict type-checking for src + tests
npm run lint               # ESLint, zero-warning policy
npm run format:check       # Prettier check
npm test                   # run the unit test suite
npm run arch:check         # dependency-cruiser + import-policy + contract-boundaries
npm run arch:check:negative
```

See [AGENTS.md §3](AGENTS.md) for the full local gate loop and the touched-area gate table.

### Portable update trust

Portable updates must work without an Apple Developer subscription (ADR-0121 D7). On macOS,
native handoff copies from an admitted managed installation are checked against the exact current
artifact digests in the validated plan. Keep the managed-registration, release-signature,
candidate, containment and process-ownership checks intact. Optional Apple signature evidence must
remain truthful and cannot become a hidden prerequisite for an unsigned update.

### Activity Log runtime changes

The deployment operator can set `KEIKO_CONTENT_REDACTION=off` before startup so Chat preserves
authorized document context, answers and private chat history (#4098). The server resolves the
setting once at startup and records `chat.content-policy.resolved` (`policy`, `setting`; `warn` for
an unrecognized value, which keeps redaction). Only Chat model ports and the Chat connected-context
workspace receive the preserving policy explicitly; the gateway, workspace and store never read the
environment, and the Coding Workbench keeps the default projection. Preserved content still loses
configured infrastructure-secret literals, private keys, URL credentials, credential-shaped
Bearer/Basic values and known token shapes. Diagnostics, audit evidence, support exports and
tool-argument protections remain unconditional. The setting applies to every configured provider;
it does not infer trust from a provider hostname. `chat.request.dispatch` records the per-call
`contentRedactionEnabled` without source text. See
[the operator procedure](docs/troubleshooting/chat-content-redaction.md).

Source redaction uses the shared security owner to preserve language syntax while masking credential
values under the default content policy, including escaped JSON/JSONC and YAML scalars. An unsafe or
ambiguous projection, or an existing source-size limit, produces a body-free refusal; connected retrieval treats that source as
unavailable. EOF-only JSON prefixes and public, unquoted Java fragments retain their safe text
projection under the documented guards (ADR-0022). Gateway
and BFF streaming retain incomplete source/credential context and discard pending text on cancellation.
The existing Activity Log records projection revision, region/refusal counts and pending-buffer
counts; it never records source, credentials or parser diagnostics containing source text.

Chat draft recovery reuses the private UiStore and authenticated chat-bound revision checks.
The `chat.draft.operation` Activity Log records lifecycle and status without draft text;
concurrent stale writes must preserve the local draft and require explicit conflict resolution.

An unchanged privacy-elided Files connection may reuse its conversation-bound canonical
acknowledgement only when the persisted fingerprint and visible scope both match. Restore the
existing local edge without starting another source intent or cancelling its response. Missing or
changed ownership and genuine navigation retain the normal guards; unrelated source holds remain
intact. The existing `automatic-suppressed` Files scope decision joins the original acknowledgement.

Production runtime behavior extends the existing Activity Log; it never creates a second logger,
event store, analyzer, or incident subsystem. Register every operation through the canonical typed
APIs in `keiko-contracts` and emit only the registration-derived event shape. The checked-in
`docs/observability/op-catalog.generated.json` is generated from those canonical declarations and
emitters. Its typed registry is authoritative; the legacy literal scan is migration input only.
Adapters rebind events with `withActivityLogCorrelation` or `withActivityLogParentCorrelation`,
preserving producer-owned ids and the non-enumerable registration/rejection markers. Test the
forwarded event through the real registered formatter: a buffer alone cannot detect a marker
lost by an object spread.

Each registration owns exact fields, bounds, data classes and vocabularies, causal and lifecycle
semantics, analyzer projection, failure classes, proof ids, and release impact. Unknown or dynamic
operations, arbitrary metadata, nested objects, missing required fields, unbounded strings, and
unknown error/loss states fail closed. Persisted v2 records also require the sink-owned version and
digest dimensions, compatibility/writer state, and complete `(pid, instanceId, seq)` identity.
STT dispatch evidence includes the sent container class and audio byte count; completion evidence
includes the provider HTTP status only when a response was received. Browser dictation converts
completed recordings to PCM16 WAV locally and reports normalization failures through the existing
client diagnostic sink, without retaining audio or provider error bodies (ADR-0100 D8).
Tests for changed behavior assert the emitted line and the support-analyzer projection. Regenerate
the catalog with `npm run generate:op-catalog`, then run `npm run check:activity-log`, the Activity
Log implementation gate, which required CI runs unchanged. Every run builds the packages and
evaluates the complete registered inventory by composing `check:op-catalog`,
`test:activity-log-scenarios` (the curated end-to-end scenario matrix), `check:error-observability`,
`arch:check`, `arch:check:negative`, and `check:release-impact`; it takes no changed-file input, so
a narrower change set never narrows what it proves.

`client.citation.activated` records a citation click and its source selection under the
activation correlation. `reason` describes the source fingerprint: `matched` (one root),
`unmatched`, `absent`, `malformed`, or `ambiguous` (several matches). `outcome` records
`opened`, `open-refused`, `picker-opened`, `picker-dismissed`, or `refused`; an opened picker
is not a successfully opened file. `rootCount` and `matchCount` explain the choice without
recording the fingerprint, file path, source label or citation text. The registered server
projection retains these closed fields on the existing Activity Log timeline.

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
truncated.". Counts only — never a message, path or run name.

`client.coding-workbench.interaction` records, at info and on the routine budget, what the human
did on the Coding Workbench page (#3897): a disclosure opened or closed (`section`, `expanded`), the
progress state (`progressState`), the agent picked (`build`, `plan` or `custom`, never a custom
agent's name), a jump to a pending decision, a repository bound for trust (its two body-free ids)
and a changeset received for review (`fileCount`). These were warn/unknown `client.diagnostic`
notes before and buried the rare real browser failures. `gateway.setup.target.accepted` records,
at info, that Gateway Setup accepted a loopback target (KEIKO-0884), with the request correlation
and the closed `targetClass`; it is no longer an error-level `server.diagnostic.failure`.

`gateway.conversation.admission` records the closed decision before a conversation model call,
with admitted and current configuration generations and the request correlation. A fresh probe
and a turn-local successful-call continuation remain distinct; failed, cancelled or filtered terminal
responses cannot establish that continuation. Refusals distinguish model or
generation replacement, absent observations, failed probes, invalid timestamps and expiry without
recording model names, requests or answers. An uninvoked model port consumes no physical synthesis
attempt or uncertain output reservation; actual interrupted provider calls retain conservative
accounting. See [ADR-0171](docs/adr/ADR-0171-gateway-readiness-capability-reconciliation.md).

`chat.scope.update` records a serialized source update as `applied` or `conflict` under the
request correlation, with optional `expectedScopeDigest`, required `actualScopeDigest` and
`resultScopeDigest`, and connected/local-knowledge/Git-change source counts. Send and PATCH
validate a supplied `expectedGroundingScopeIdentity` against the current server-issued identity;
a stale identity returns 409 `GROUNDING_SCOPE_CHANGED`. Git-change description authority is
checked separately, and ordinary regeneration refuses connected folder, knowledge and Git-change
scopes with 409 `NOT_APPLIABLE`. See ADR-0057 for the identity and admission boundaries.

Connected-folder retrieval joins `search.connected-context.source-details`, `selection-details`,
`completion-details`, and `answer-details` with the completed operation under the same request
correlation, process, and source/query digests. These typed siblings retain the existing contextual
field cap. Source details describe actual path/reference admission and eligibility. Extensionless
document admission uses one shared case-insensitive `README`/`CONTRIBUTING` shorthand allowlist
independently of overview ranking. Ordinary prose cannot become an explicit file merely through its ranking bucket;
explicit filenames and every existing scope/read grant remain authoritative. Selection
details describe calibrated floors, high/low confidence, addressed-file demotion, reranker
disposition, continuity counts, and worktree/semantic freshness observations. Assembled reads and
final sent evidence are distinct: `answer-details.filesInPrompt` describes what reached synthesis.
The correlated `search.connected-context.evidence-details` sibling carries certified descriptor
counts within the same unchanged contextual-field cap. Existing source-detail rows retain all
their fields. Only counts, closed dispositions and digests enter the log, never paths, declarations
or answers.
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
Marker repair requests bounded insertion annotations anchored by unique original prose, so
models need not copy generated code. The existing owner constructs the candidate and reuses
all unchanged marker-only, code/assessment, fitted-evidence and cumulative-budget validation.
Literal marker-only responses remain compatible under the same checks.
Symbol discovery groups the existing bounded excerpt reads by source within each observation
wave. Current source snapshots, definition/call/parent certificates and original per-window grants
remain binding; this introduces no persistent source cache or additional synthesis attempt.
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
reservation and request-local current-source metadata capacity. Finite enrichment grants and
bounded complete-text reuse retain their separate limits.
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
Contextual natural-language keep-one fallback retains the first lexical producer's order only for
the same live content identities, without semantic evidence or successful reranking. It remains
low confidence and changes no floor, exclusion or grant. Ordinary document excerpts include the
complete current redacted source when it fits the existing window and total budgets; explicit
selections, certified ranges and source-code excerpts keep their requested geometry (ADR-0022).
Returned and persisted answers use the confidence of their actual sent source; another source cannot
supply its missing spelling. Existing completion events record the target decision/count, selection
confidence and actual read counts. The existing `chat.context.selected` event records available
fitted selection confidence without source bodies.
Evidence manifest hashes and ranges enumerate final sent excerpts; retrieval candidate counts, usage and omissions
retain the actual earlier work. Existing prompt sent/available counts distinguish fitting removals
without inventing retrieval omissions.
Zero-length deduplicated metadata aliases remain in retained packs but add no empty prompt evidence
fences. Positive bodies, whitespace source lines, document labels and citation authority remain
unchanged; existing final-prompt counts and costs describe the serialization.
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
retained nonempty initial view retry shared bytes before already served paths expand, preserving the
existing order within each group. When no current coverage windows apply, manual selections come
first, followed by existing definition context windows overlapping an original ordinary atom range,
the independent ordinary remainder and the existing fallback. These opportunities do not certify
declaration ownership or invocation.

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

The closed `retrievalIntent` vocabulary is `project-metadata`, `repository-overview`,
`targeted-code-search`, `diagnostic-search`, `conversational-follow-up` and `clarification-needed`.
An eligible `conversational-follow-up` retains the previous targeted or diagnostic intent for
planning; concrete new targets and new traces classify independently. The registered completed
and clarification operations retain the actual turn classification.

Final grounded publication reuses `chat.response.message` after governed memory attachment. Its
optional `uncitedMemoryContextMarkerCount` counts the final structured marker, and
`memoryContextDisposition` is closed to included/excluded/not-requested. The assistant identity
and originating request retain the existing causal link. Candidate counts and model-authored
marker prose cannot stand in for actual memory inclusion; no memory or answer body enters logs.

`client.scope.notice` records scope narrowing, widening, folder pinning and adding missing evidence
under the notice's client correlation. Its closed `reason` is `narrowed-to-file`,
`narrowed-to-directory`, `widened`, `pinned-folder` or `missing-evidence-added`. `scopeKind` is
`workspace-root`, `directory` or `files`; `pathCount` counts selected scope-relative entries.
The existing timeline carries these dispositions and counts without scope paths or notice text.

`client.evidence.inspected` records `summary-expanded`, `file-table-opened` or `manifest-fetch-failed`
under the inspection's client correlation. Optional `readFileCount` and `omittedFileCount` describe
manifest records and do not certify model-sent files. A manifest fetch failure emits WARN with the
existing closed `errorKind` header and bounded `errorClass`, `frames` and `causeChain`; the other
reasons emit INFO. Inspection evidence remains body-free.

`search.connected-context.answer-details` records answer kind, observed citation behaviour,
declaration counts, repair disposition, and actual follow-up trigger, pass/admission counts,
outcome and configuration disposition. Technical failures retain the existing closed error header,
reduced frames and causes. Initial synthesis, marker repair, follow-up and their gateway transport or
context-window retries share at most two physical adapter attempts and the original cumulative
input/output and remaining elapsed grants. Admission occurs before each actual dispatch and spend
reservation. Charged input retains the greater of the canonical sent prompt estimate and reported
usage; measured partial output survives a discarded attempt, while uncertain failed stream output
retains its requested cap. These conservative charges are distinct from provider-measured usage.
Caller attempt/cap refusals use nonretryable `GATEWAY_ATTEMPT_ADMISSION_DENIED` and HTTP 403;
streamed notices retain the same code. The localized request-limit notice distinguishes those
refusals from `GATEWAY_CONTEXT_OVERFLOW` without asserting exact unknown output consumption.
Prompt fitting retains separate model and remaining caller input caps. Mandatory overhead that
fits the model but exceeds the caller allowance uses the caller refusal; overhead that exceeds
the model retains context-overflow handling. Best-effort citation repair keeps the completed
answer when its remaining input allowance cannot fund the repair.
Unrelated gateway retries and separately bounded entailment/embedding stages retain their existing
contracts without supplying another synthesis attempt. Normalized output is buffered before
publication; rejected declarations cannot escape through streamed chunks. The existing allocator's
high/exceeded pressure refuses follow-up. `KEIKO_CONNECTED_FOLLOW_UP_PASSES_MAX` defaults to `1`;
explicit `0` disables it, and other explicit values fail closed to zero passes with an invalid
configuration observation. See [ADR-0180](docs/adr/ADR-0180-bounded-connected-folder-follow-up.md).

Support analysis joins these siblings rather than assuming every metric appears on the completed
line. An answered follow-up disposes the initial unread declaration for its original source and
logical turn even if the selection fingerprint changes. Missing historical fields remain unknown.
Healthy lexical answers do not become retrieval misses because semantic search is unconfigured.
Optional live semantic refresh separately requires `KEIKO_REPO_SEMANTIC_REFRESH_FILES_MAX`; its
default is `0`, its enabled cap is eight safe fragments, and it never mutates a persisted pod.

Chat context selection emits `chat.context.selected` before the provider call for buffered,
streaming and regenerated turns. Its request correlation joins the compacted/retained history
counts, estimated removed-prefix and summary costs, savings, final estimated prompt cost,
effective input budget and image reserve. This evidence survives generation timeout or
cancellation; the successful-turn compaction manifest remains separate. These are local estimates,
not provider-measured usage, and no conversation or image content is recorded.

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

On retries, `reportedPromptTokens` always describes only the current counter response and is
absent when that response has no count. `providerPromptTokens` adds the current response-schema
cost to that raw count; `retainedPromptTokens` separately records the carried measurement floor
plus schema cost. Admission preserves the maximum of local, current-provider and retained
candidates. `counterSource` identifies a winning retained floor as `retained-measurement`, and
`imageAccounting` uses that disposition when only the retained positive measurement replaces the
image reserve. Neither retained value is presented as a new provider observation.

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
`assessment-only`) and reference, attached and dangling counts describe the actual reconciliation.
Assessment-only reconciliation records zero source-marker counts; citation repair leaves the
assessment block unchanged. File lines also carry
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
assessment (`none`, `assessment`, `assessment-only`, `neutralized`), under which operator policy
(`allowed`, `disabled`), and the character sizes of the source-backed part and the assessment.
Source-linked observations carry canonical scope/query digests and `phase` (`candidate`,
`accepted-final`); only accepted-final observations describe the delivered answer. Candidate or
unbound historical observations cannot suppress retrieval-miss findings.
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
(`liveDivergedCount`) and the events folded into earlier history reads (`mergedEventCount`). The
reasoning text never enters the Activity Log, a support export, run evidence or Coding History.
Changeset-edit arguments reach the governed edit tool byte for byte (#4009): the gateway removes
only the configured provider literals from them, never a heuristic secret shape; every other
tool's arguments keep the full redaction. When a literal was removed,
`gateway.tool-arguments.redacted` records the tool-call and changed-string counts at `warn`.
A model answer that exhausted its output budget, or ended after reasoning, without a tool call or a
final answer gets one steered repair from the gateway on a call that asks for it with the explicit
`answerRepair: "steered"` (the coding sidecar route alone; #3873, F17, F23), and the log records it
in closed words only: `gateway.retry.scheduled` names it with `reason=output-exhausted-repair` or
`reason=empty-answer-repair` (`retryable-error` on every ordinary retry), and
`coding-sidecar.gateway.outcome` and `coding-sidecar.gateway.turn-failed` record `repairAttempted`
and, when a repair ran, `repairOutcome` (`recovered`, `exhausted-again`, `empty-again`, `failed`,
naming how the repaired attempt ended) — a line written before the gateway call settled (a byte cut,
a cancellation) omits both, because it cannot know; a repaired turn that failed the same way again
is final for the coding runtime (`runtimeRetry=refused`). The provider usage of the attempts a call
discarded (a repair's first answer, a rejected tool call) counts against the run's prompt
allowance, and `coding-sidecar.gateway.usage-settled` names it (`discardedAttemptCount`,
`discardedPromptTokens`, `discardedCompletionTokens`). The correction the model receives is one fixed
sentence, and the failed answer's reasoning is never recorded. Prior reasoning is never resent
upstream: the coding sidecar drops the reasoning fields of prior assistant messages and every
assistant message that carries nothing but reasoning, and `coding-sidecar.gateway.request-validated`
records the number dropped as `droppedReasoningMessageCount`. The gateway hands reasoning only to a
call that asks for it with the explicit `reasoningDelivery: "forward"` (the coding sidecar route
alone); the `coding-workbench` latency profile selects timeout floors only.

Commit drafts record model-context bounds, compaction, generation count and reuse as counts and
flags on `git.commit.draft.completed`. The same event carries body-free normalization version/rule and bullet, trailer, continuation and marker counts for generated and reused drafts. Each attempted generation also records its own result and normalization on `git.commit.draft.attempt.completed`, so a later repair cannot erase earlier evidence; stream startup retries use the existing `gateway.retry.*`
events. Neither path records customer diffs or generated text.

Closed failure outcomes and positive failure counters that would otherwise be optional context must
be declared with the owning operation's exact `diagnosticWhen` condition. Regression proofs exercise
the actual producer, registered writer and incident query with zero optional context, alongside
healthy controls; ordinary file eligibility exclusions and budget limits are not failures.

All repository-add lifecycle join ids, including discarded settlements, must pass the canonical Activity Log correlation guard. Browser delivery-loss counts enter the shared ledger once after rate admission and before routine diversion. Rate-limited reports carrying loss return 429 so the browser restores their counters for later admission; their server-owned drop must not be counted again as a failed POST. Final pagehide loss reports have their own bounded server budget, independent of routine/failure traffic. Gateway streams settle circuit/spend state, close provider iterators and emit completion before yielding done, since production consumers need not advance again. Commit-draft refusals retain measured prompt bounds and generated/reused outcomes share a body-free key digest.
Repository-add dialogs report the attempt and its live or discarded settlement using the request's
correlation id. Test effect replay under React StrictMode separately from an actual dismissal:
only the latter may discard a response.

The generated registry also publishes the stable implementation-obligation categories and the
failure-class coverage matrix consumed by permanent quality gates. Its release expectation is
100% complete. Exemptions are not comments or wildcards: the sole registry exemption contract is
limited to one registered operation/failure-class pair and requires the operation's owning package
as owner, a technical reason, a linked tracking issue, an unavoidable platform or durability
boundary, and an expiry at most 180 days ahead. It cannot permit unknown fields, prohibited data,
silent loss, or incomplete evidence.

Keep this contract converged in one change. The writer, segmented store, and reader engine belong to
`@oscharko-dev/keiko-activity-log`, which depends only on contracts and security; server and CLI
compose it while domain packages continue to use injected ports (ADR-0179). A runtime change that
affects Activity Log behavior updates the owning implementation, its failure-first regression,
emitted-line and analyzer/replay proof, ADR-0173, ADR-0179, AGENTS.md, this contributor contract,
and directly affected operator documentation as applicable. Saved support reports remain local artifacts
created by an explicit user action. CLI exports enforce owner-private file permissions. Desktop
exports use the browser's configured download destination and filesystem permissions; the browser
may save directly to Downloads without showing a destination picker. This owner-approved desktop
workflow does not claim the CLI's permission guarantees.
publishing or attaching one to GitHub or another external system requires separate explicit user
authority and is never part of logging or export.

Activity Log storage must remain bounded on every intermediate change. The Activity Log is stored as
immutable segments in `<stateDir>/logs/` (ADR-0173 D14). Each process appends only to its own active
segment, sealed segments are read-only, and retention bounds every segment and legacy file by bytes
and age, so total use stays within the byte budget plus the pin quota. Filesystem mutation is
limited to verified owner-private, non-redirected directories and opened regular owner-matched
targets, and only on names in the closed grammar of `keiko-contracts` `activity-log-files.ts`.
Publication never replaces an existing name; rename is permitted only when the filesystem reports
hard links unsupported. Any successor storage design must replace this bound atomically rather than
remove it first.

## Pull requests

All required status checks must pass on the current pull-request head before a change can merge into
`dev`. The stable app-bound set is the ten checks below:

1. `ci`
2. `workflow hygiene`
3. `Analyze (actions)`
4. `Analyze (javascript-typescript)`
5. `Build, scan, SBOM, smoke`
6. `Review dependency diff (dev/main)`
7. `ui`
8. `SonarCloud Code Analysis`
9. `Socket Security: Project Report`
10. `Socket Security: Pull Request Alerts`

`workflow hygiene` runs actionlint, the pinned-SHA verification, zizmor and the OSV lockfile scan as
one context (ADR-0159); the tools, pinned versions and rule sets are unchanged. It also runs the
repository-owned `check:zizmor-anchors` ahead of zizmor, so a line anchor that drifted out of
`.github/zizmor.yml` reports as itself rather than as the finding it silently stopped suppressing. The hosted contexts
and their bounded zero-cost eligibility are recorded in
[`docs/qa/external-quality-gates.md`](docs/qa/external-quality-gates.md).

The required matrix measures a change once. `dev` is protected with linear history and signed
squash merges of up-to-date heads, so the integration commit carries a new sha and the identical
tree sha as the pull-request head the matrix already proved green. The `dev` run resolves that
before any gate starts and reuses that verdict rather than re-measuring identical bytes
([ADR-0178](docs/adr/ADR-0178-reuse-proven-tree-evidence-on-integration-runs.md)). Reuse requires
the merge commit to be that pull request's exact `merge_commit_sha`, the trees to match, a completed
successful `pull_request` run on that head, and that run to have executed every skipped job; any
other outcome runs the full matrix, and the `ci` aggregate still fails closed. The coverage suites
and the SonarCloud analysis are never reused on `dev`: they run on every push to `dev` so that
SonarCloud's branch history stays current (ADR-0178 D1, amended 2026-09-25). Editing a workflow
changes the tree, so CI changes always measure themselves.

The candidate matrix admits PR events only while their payload state is `open`. Open metadata
edits and base retargets retain fresh strict verdicts. Closed/merged metadata edits are rejected
before candidate checkout, including by the aggregate; they do not judge the signed squash commit
using the obsolete PR base/head. Merge groups, protected pushes and manual dispatch retain their
existing paths (ADR-0139 D4).

Only the repository owner account `oscharko` may authorize and execute a merge into `dev`, including
enabling GitHub native auto-merge. Agents acting under that account operate within the owner's
explicit authorization. Contributors may prepare PRs and repair findings, but accepting their task
does not grant integration authority. No additional approving review is required, so owner-authored
PRs remain possible. Required checks must succeed on the exact current head and every review
conversation must be resolved before integration. Only `oscharko` may dismiss blocking reviews;
approvals become stale when the reviewed changes change. These restrictions are scoped to `dev`.
CodeRabbit reviews every pull request targeting `dev` and every subsequent push with no
auto-pause. Its status is not required because quota can omit a current-head review. When CodeRabbit
does emit an inline finding, GitHub's required conversation-resolution rule blocks merge until its
conversation is resolved. Policy additionally requires the underlying defect to be repaired; the
quota-tolerant interim topology cannot infer code repair merely from GitHub's resolved bit.

`.github/CODEOWNERS` intentionally stays a single flat `* @oscharko` rule while Keiko has one
maintainer. Required code-owner reviews remain disabled to avoid blocking owner-authored PRs;
the owner-only branch restriction controls who may integrate into `dev`. Revisit
path-scoped rows if/when a second maintainer joins.

The hosted performance dashboard and quota-paced reviewer evaluated in ADR-0169 are retired.
Neither has repository configuration, an installed App, a workflow, or a protected context.
Deterministic bundle, latency, retrieval, and performance gates inside `ci` retain merge authority.
No payment method, finding dismissal, or gate bypass is an accepted repair path.

Keiko for Quality is retired by
[ADR-0176](docs/adr/ADR-0176-retire-keiko-for-quality.md). It has no workflow, review profile,
repository variable, credential consumer, or protected context in this repository. Its product is
being rebuilt inside Keiko itself; until that ships, no model-backed reviewer runs on a pull
request here.

Qodo is retired by
[ADR-0167](docs/adr/ADR-0167-zero-cost-autonomous-quality-gates.md); it is not Sonar evidence.
Sonar remains independently enforced by its native required check and the exact-head validator
inside `ci`. Full mutation runs daily/on demand and reference-machine performance evidence runs
outside the pull-request critical path. Fast semantic-duplication, secret, coverage, static-analysis,
and deterministic performance proxies run in parallel on pull requests. Thresholds and operational details are
in [`docs/qa/autonomous-quality-gates.md`](docs/qa/autonomous-quality-gates.md) and
[`docs/qa/external-quality-gates.md`](docs/qa/external-quality-gates.md).

The rationale for the package architecture, workspace gate, bundled publish model, and 0.2.0 baseline is recorded in
[ADR-0019](docs/adr/ADR-0019-modular-package-architecture.md),
[ADR-0020](docs/adr/ADR-0020-workspace-tooling-and-architecture-gate.md),
[ADR-0021](docs/adr/ADR-0021-publish-strategy-bundled-monorepo-product.md), and
[ADR-0025](docs/adr/ADR-0025-forward-only-0-2-0-modular-baseline.md).

UI-facing features must use the existing i18n API instead of hard-coded user-visible strings, and every UI change
must update both `packages/keiko-ui/src/lib/i18n-messages.en.ts` and
`packages/keiko-ui/src/lib/i18n-messages.de.ts` with matching keys. Pull request CI runs
`npm run check:ui-i18n` to enforce this guard before review and merge.

Published release notes live in GitHub Releases. This repository intentionally does not maintain a root `CHANGELOG.md`.

## Troubleshooting documentation

Operator-facing failure modes live in [`docs/troubleshooting/README.md`](docs/troubleshooting/README.md).
When adding a new entry, copy [`docs/troubleshooting/_template.md`](docs/troubleshooting/_template.md)
and follow the **Symptom**, **Root Cause**, **Diagnostic Steps**, and
**Resolution** structure. Do not include API keys, customer data,
internal endpoints, or unredacted log lines in examples.

## Coding mode availability

The owner decision of 2026-09-27 exposes all three Coding Workbench modes on a normal installation
without extra configuration (ADR-0124 D2, ADR-0163 D7). The default selected mode remains Ask for
approval. Explicit narrower deployment ceilings and every mode-independent denial remain enforced.
Do not propagate Coding's availability default to Memory: its absent-configuration ceiling stays
`governed-assist` for capture, policy projection and maintenance. Regression coverage must exercise
both production composition and these consumers when changing this wiring.

## Support reports

For local defect evidence, use `keiko support export --incident <id>` or a correlation selector.
Manual UI and CLI export remain available when all retained incident slots are occupied: the
canonical exporter can use a transient descriptor without stealing in-flight reservations or
widening retention. Completed candidates may roll over at byte pressure; in-flight reservations
remain protected. Exporting stored server evidence requires an authenticated app session.
Confirming a valid session refreshes its scoped cookies using the same bearer; it neither mints
authority nor extends registry expiry. An unpaired or offline browser can still create and download
a limited report from validated body-free client failure facts, without accessing stored server
evidence.
The canonical owner-private report has embedded integrity, a 10 MiB hard ceiling (`--max-bytes`
may only lower it) and explicit sufficiency. `--out` names a private directory, never a file; the
filename always uses the fixed product/schema/incident/date class. Inclusion flags and raw-log or
legacy bundle input are refused. Validate a manually received file offline with
`keiko support analyze FILE --json` before agents use its machine view. New reports use artifact-local
ordinal references: the UI Support ID is only a local export/query selector. For a received report,
select `incident.correlation.rootCorrelationId` or an exported timeline reference from the unfiltered
analysis before using `--correlation-id`; no original-to-exported mapping is included. Follow
[the support workspace guide](docs/observability/support-workspace.md). Nothing is sent by these
commands. `npm run set-version` regenerates the historical registry snapshots the analyzer selects
from, so a release needs no extra step.

## Files and Editor navigation

Explicit folder selections in the New Window dialog and Editor root picker preserve
the selected root through the existing `coding-repository` presentation binding.
The same behavior applies to Git repositories and ordinary folders. Task-bound
windows retain the active workspace projection and allow navigation within it;
explicit repository Files windows also allow path changes. Back/Forward history is
bounded and clears on task-bound root switches. Files titles reflect their resolved
root; an empty Editor names its project. Navigation and directory reads record
body-free client stage lifecycle evidence on the existing Activity Log.

Files directory responses identify the actual guarded canonical root. Child responses can
establish that identity before a root response; old root responses cannot reverse it. Per-path
read ownership also rejects older same-root listings and replies after unmount, while ordinary
identical reads remain shared. When an unchanged alias
resolves elsewhere, outstanding child reads cannot restore its previous tree or selection.
Explicitly forgetting an ambiguous failed connection while retaining canonical Chat sources
releases that edge's failed admission hold only. Pending source work cannot be forgotten through
this recovery action; unrelated source holds remain in force.
A mounted Chat's runtime conversation identity remains valid before its window cfg id persists;
refresh admission and failed-edge recovery resolve that same identity.
Initial binds hold admission before edge creation. Failed equal-root navigation reconciles with
fresh canonical state. Retired owners release settled failed holds only; timeout-blocked work
and failed compensation retain their existing settlement/recovery boundary.

The existing Files scope-decision Activity Log records `root-normalized`, `root-replaced` and
`request-superseded`, joined to directory-read correlations without paths or source bodies.
Connected Files navigation additionally cancels the bound response before a delayed scope ACK.
Per-source admission holds in the existing Chat runtime preserve drafts and block sends and
regeneration until the current intent succeeds. Pending, applied, failed and send-refused intent
decisions share the serialized mutation's body-free Activity Log correlation.

The ordinary Editor is human-operated. The owner decision of 2026-10-03 retires its agent
presence/history, incoming actions, selection-to-chat handoff and Chat **Apply to editor** command.
Keep the existing manual edit/save/format/history flow and content-free dirty-buffer protection.
Safety-state publication does not grant an agent a live bridge or an executable Editor session.
Chat repository search and the separate Coding Workbench keep their own existing behavior; shared
runtime code still used by those consumers is not part of this retirement. See
[ADR-0061](docs/adr/ADR-0061-browser-editor-agent-bridge.md).
