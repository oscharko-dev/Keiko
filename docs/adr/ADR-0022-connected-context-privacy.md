# ADR-0022: Connected Context Privacy Contract

## Status

Accepted

## Date

2026-06-04

## Version

1.1

## Context

Issue #185 ships grounded repository Q&A in the Conversation Center. The orchestrator
composes a `ConnectedContextPack` (defined in #178) carrying the connected scope, the
retrieval query, exploration usage/budget, evidence excerpts, omitted candidates, and
uncertainty markers. The pack is the in-process record of what Keiko looked at, on the
user's machine, to answer a single question.

Two pieces are missing as of `df3c336d` (dev, 2026-06-04):

1. **Visibility.** The browser surface (`GroundedAnswer`) renders the assistant content
   + citations, but tells the user nothing about scope shape, query kind, or budget
   consumption. Users cannot verify what was inspected without trusting the answer.
2. **Privacy contract.** The retention and cleanup semantics of the pack are implicit
   in the code (the pack is GC'd when the BFF route returns) but undocumented. The
   evidence ledger persists separately; users have no committed promise about which
   surface is ephemeral vs. durable, or what travels to the model provider.

Issue #187 closes both gaps with a thin wire surface, a metadata-only evidence record,
and this ADR. It is purposely a projection of work already done in #178/#185, not new
orchestration.

## Decision

### D1 — Packs are not persisted to disk

There is no `ConnectedContextPackStore`, no `packs` table, no pack ledger, and no file
containing full connected-context packs. The orchestrator builds the pack in
`src/grounded-orchestrator.ts`, and the route projects it through
`buildGroundedAnswerContextPackSummary` and `buildCitations`.

The pack can live beyond one BFF request only inside the process-local micro-index
described in D3.1. That cache stores assembled `ConnectedContextPack` objects, including
excerpt content, so its retention contract is explicit: bounded TTL, bounded size, no
disk persistence, and deterministic cleanup hooks on chat/project lifecycle changes.

Repository search may separately persist its bounded acceleration index. That store is not a
`ConnectedContextPack`: it contains discovery metadata, fingerprints, and lexical hashes rather than
queries or excerpts, and its complete snapshot is AES-256-GCM sealed before the atomic owner-only
write. The key uses an independent `KEIKO_WORKSPACE_INDEX_KEY` → OS keychain → hardened keyfile
namespace. Missing, legacy-plaintext, tampered, or wrong-key snapshots fail closed to a live rescan.

Why: the pack carries the full excerpt content (with the raw scope-relative paths and
file bytes). Persisting it to disk would create a second redaction surface co-equal
with the evidence ledger, with no offsetting benefit. The evidence ledger records the
audited subset as metadata and hashes, not as a full pack.

Connected folder answers reuse ADR-0144's operator-owned assessment policy, including ordinary
conversation and learned knowledge without Internet or matching excerpts. The policy instruction
is included before prompt fitting. Assessment text never authenticates source citations, missing
file declarations or entailment, and operator-disabled blocks are dropped. Source-only marker
repair preserves the assessment verbatim. General requests with no runnable retrieval anchors may
use the validated empty assembler under the same original token, spend, time and two-physical-
attempt envelope; they do not invent repository facts or bypass scope validation. An assessment-only
second pass does not resolve a source insufficiency, even when the declared file was sent; the
substantive uncited source-answer case retains its separate successful retrieval outcome. Existing
`search.answer.assessed` events distinguish early `candidate` from `accepted-final` observations
and bind final source-warning decisions to canonical scope/query digests. Unknown or candidate
observations cannot dismiss a retrieval miss. Explicit unavailable source targets remain closed
observations even when a separate labelled assessment is allowed.

### D1.1 — Changing sources cancels the current answer

A validated change to the canonical grounding identity cancels the current generation and any
already queued generation for that chat. This includes adding, removing, narrowing or widening
Files or Knowledge sources, and successfully connecting or refreshing a Git comparison. Identity
comparison excludes source timestamps, list order, duplicates and Git description metadata.
Malformed, inaccessible, conflicting, over-budget or effectively unchanged patches do not cancel
an answer. PATCH revalidates its precondition and access at the serialized write boundary.

Cancellation belongs to the existing per-chat turn serializer. It reaches grounded, buffered,
streaming and regeneration requests, including requests waiting for shared gateway readiness.
Cancelling one readiness waiter must not cancel the configuration-owned probe used by other chats.
The underlying turn retains its gate until it actually settles; an uncooperative provider cannot
publish a late assistant answer or admit a stale queued generation. A pending PATCH is not an
acknowledged source update. Successful Git comparison mutations keep their existing transactional
relationship compensation and notify the same cancellation owner only after success.

Completed messages and learned findings remain in the conversation and follow normal history
compaction. Connected Files excerpts are assembled separately for each question, not inserted as
a persistent document lane into history compaction. Historical answers, including quoted code,
remain historical conversation; they do not grant current filesystem authority. Existing
`chat.scope.update` evidence records cancellation requests with canonical identity digests and
counts only, never source bodies, user text or paths.

Connected Files windows follow their resolved visible selection independently: the displayed root,
subdirectory or open file. Existing acknowledgement ownership still determines the canonical
source label. Opening a file never preserves a former folder through a saved pin; retired
`keepFilesFolder` preferences are discarded on workspace restoration. Navigation requires neither
confirmation nor a folder-restoration action. Same-root background tree reads preserve the
currently displayed file; a delayed refresh cannot restore a closed preview or cross a root
change. A different resolved root clears the old preview and directory before either can supply
source authority. The header retains compact source labels,
disambiguating paths, disconnect controls and actual pending/error feedback. Generic explanation
is available only on demand in the missing-evidence action. The existing `client.scope.notice`
observer records body-free transitions without a duplicate live-region announcement.

An abandoned Files write whose compensation fails retains its admission hold. A subsequent
explicit, successfully acknowledged bind may retire detached failed edges only for the same chat,
mounted source window and canonical scope. Attribution uses the actual canonical PATCH reply,
including its submitted timestamp and selection geometry, before compensation runs. A requested
alias alone cannot identify the source: retargeting that alias to another canonical root must retain
the prior hold. Missing acknowledgement attribution, live edges, pending writes, other mounted
owners and other chats remain ineligible. This extends the existing intent registry and serialized
PATCH owner; it introduces neither a source cache nor a second persistence path. Retiring a failed
edge emits the existing correlated, body-free `client.files-scope.decision` release disposition.
Failed unbind holds use the same mounted edge/conversation ownership boundary. Removing an obsolete
edge may release its settled failed hold; an unfinished or blocked serialized write still retains
admission protection.

### D2 — Per-answer summary is wire-only

The wire response carries `contextPack: GroundedAnswerContextPackSummary` on every
`GroundedAnswer` (REQUIRED, non-optional). The summary is structurally
counts-only-plus-enums:

- `schemaVersion`, `scopeId` (deterministic display fingerprint, not the raw
  `SelectedScope.scopeId`), `scopeKind` (enum), `fileCount` (number; `-1` sentinel for
  `workspace-root`), `queryKind` (enum)
- `usage` (full ExplorationUsage — all numbers)
- `budget` (full `ExplorationBudget`; `filesReadMax` and `elapsedMsMax` are nullable, with
  `null` meaning no default file-count or elapsed-time cutoff; all usage counters remain numeric)
- `citationCount`, `omittedCount`, `uncertaintyCount`, `elapsedMs` (numbers)

Large context packs retain at most 4,096 omitted path details, independently of corpus size.
Before that projection, assembly validates every known omission and fingerprints the full
canonical omission set. Packs whose details are clipped carry exact closed per-reason
`omittedCounts`; legacy and smaller packs derive totals from their complete detail list.
Browser summaries, model disclosures, activity counters, and audit manifests use these exact
totals. The audit retains bounded redacted path details alongside the aggregate, without
persisting unread file content. Detail retention never implies unfinished source traversal.

There is no field that can carry raw scope ids, raw file paths, query text, excerpt
content, or credentials. The builder is a pure function with no IO and no redaction
step — the type itself is the redaction contract.

The spec for #187 originally named this `ConnectedContextPackSummary`. That name was
already taken by a dormant 13-field declaration in `connected-context.ts` shipped in
#178 (zero consumers). To avoid a breaking rename, the wire type is
`GroundedAnswerContextPackSummary`; the #178 type stays untouched. The two types serve
different audiences: the #178 type is the in-process UI-safe projection of the full
pack; the wire type is the grounded-answer-scoped projection that adds
`citationCount` and `elapsedMs` from the orchestrator output. The answer duration measures wall-clock
time through retrieval, model waiting, and entailment; concurrent source work is not summed into
that duration. Per-source exploration usage remains a separate work counter.

### D3 — Evidence runs survive chat deletion

Deleting a chat removes its messages but leaves any referenced evidence-run manifests
in place. This is a one-way reference: chats point at runs, runs do not point back at
chats. Removing a chat does not cascade into the evidence directory.

Why: evidence is for audit. A user who deletes a chat is signalling "I no longer want
to see this conversation," not "this run never happened." Cascading deletes would
let a user (or an attacker who took over a session) erase their audit trail by
deleting chats. Users who want to remove evidence remove the run manifest directly via
`KEIKO_EVIDENCE_DIR` until a first-class evidence deletion control exists.

### D3.1 — Micro-index state is process-local and explicitly cleared

The grounded-answer path may reuse a small `MicroIndex` per connected chat scope. This
index stores full `ConnectedContextPack` values in memory, including query metadata,
selected files, and excerpt content. The server registry is in-memory only and bounded:
entries use the workflow micro-index TTL, the server keeps at most 32 scoped indexes
with at most 8 cached packs per scope, expired entries are swept on an unref'd
background interval and before reuse, and evicted entries call `index.clear()`.
The orchestration read-bypass lookup and publication share the pre-read candidate identity even
when byte admission omits excerpts. Publication still revalidates every candidate's file state,
refuses cancelled or failed reads, and includes current uncertainty independently of file identity.

Chat/project lifecycle hooks clear this state deterministically: deleting a project
clears indexes for that workspace root, deleting or closing a chat clears indexes for
that conversation, and replacing or clearing a chat's connected scope also clears the
conversation indexes. This gives #187 explicit cleanup behavior without adding a
persistent context-pack or index store.

### D3.2 — Grounded answers write a metadata-only evidence record

Every successful grounded answer writes an `EvidenceManifest` with
`run.taskType = "connected-context"` and a `connectedContext` section. That section
records selected-scope shape, redacted scope-relative paths, query kind plus query text
hash/byte count, tools/provenance used, citation line ranges, omitted reasons,
uncertainty counts, budget/usage, excerpt byte counts, and hashes of redacted excerpt
content. The generic evidence `context.workspaceRoot` field stores a non-path local
fingerprint for connected-context runs, not the absolute workspace root.

It deliberately does not persist the absolute workspace root, query text, excerpt text,
model prompts, provider configuration, credentials, or full `ConnectedContextPack`
objects. The BFF returns the manifest run id on `GroundedAnswer.evidenceRunId`, and the
UI links to the local evidence detail route for reviewers who need the durable audit
record.

### D3.3 — Explicit connections support recursive orientation and search

The existing chat-store projection removes repeated explicit scope identities while preserving
distinct roots, scope kinds, selected paths and legacy rootless entries. It performs no filesystem
alias inference. Scope updates still validate the real root and selected paths before canonical
deduplication. A Files connection accepts canonicalization only from its attributable completed
PATCH response, with unrelated submitted scopes preserved; ambiguous acknowledgements fail closed.
The workspace adopts that canonical root only while the visible Files selection still belongs to
the submitted scope. Navigation or conversation replacement cannot inherit a stale acknowledgement.

#### Orientation and evidence admission

An explicitly connected repository or ordinary folder is sufficient scope for a meaningful
orientation or natural-language search request. A filename or symbol is useful for precision,
but is not a prerequisite to inspect the user's accepted root. Empty and punctuation-only
requests still require clarification, and implicit roots retain their narrowing guards.
The canonical planner also recognizes fully parsed acknowledgement or receipt requests for
supplied user context and normative questions that explicitly request a general method or advice.
These use the existing empty evidence pack when own assessment is allowed,
without recursive discovery or source reads; disabled own assessment retains clarification. An
independent source instruction, diagnostic, quoted target or path keeps source retrieval eligible.
The original user input and conversation history remain model context. On this positively parsed
conversation lane only, an untagged answer with no actually sent evidence is labelled by software
as own assessment before source validation. Existing citation, path, declaration and answer-kind
parsers and a conservative source-attribution guard exclude source references, selected-source
claims, missing-evidence statements and refusals from this fallback.
Unclassified, source and mixed requests retain their source projection; explicit assessment tags
keep their existing policy semantics. Ordinary "next steps"
are literal prose; a Next.js spelling or a bound framework/version/use request retains its technical
alias and metadata routing.
Repository orientation retains the user's lexical terms and repository semantic provider. Recursive
file discovery is a zero-evidence fallback after a complete term search, within the same search-call
budget, alongside metadata and overview documents; a source-only folder must produce actual source
evidence. A targeted module overview must not be replaced by an unrelated shallow file listing.
Natural-language questions without an independently selected source target may additionally use
the complete eligible folder text. Ordinary technical routing aliases (for example a requested
output framework or language) do not alone select a source symbol. Explicit paths, quoted or
typed identifiers, definition requests and literal-only queries retain their narrowing guards.
Relationship/history requests may receive the same supplemental file-listing context while their
requested retrieval rings continue unchanged; supplementation never certifies a definition,
historical event or complete answer. The same lexical traversal must prove that its actual
decoded/redacted bytes and transient evidence
metadata fit the accepted excerpt-byte capacity. Empty or whitespace-only files do not consume
contextual evidence capacity. A retained lexical
match limit does not invalidate complete scope observation; the separately reported match-cap
uncertainty remains intact. Context enrichment reports its admission outcome, observed and retained
file counts, charged descriptor-plus-content bytes, and capacity on the correlated completion-details
Activity Log event. Observed counts stop at irreversible overflow, rather than claiming the entire
later traversal was retained. A readable subset can survive individual I/O failures while the original
incomplete-coverage evidence remains visible. The model token capacity is checked separately
when fitting the actual gateway prompt; tokens are never treated as a source-byte ceiling. Only
successful safe reads enter this body-free context collector; overflow irreversibly discards the
enrichment, and interrupted traversal disables it. When traversal finishes with only read failures,
the bounded successfully decoded subset remains usable; coverage and its read-failure warnings stay
incomplete, and no claim is made about the unreadable documents. Actual full-file ranges use
file-listing provenance rather than synthetic lexical matches.
#### Source coordinates and prompt fitting

Folder excerpts sent to an answering model annotate each line with its original source-line offset;
these prompt annotations do not alter stored source text or citation ranges. Single-source,
multi-source and hybrid prompts also disclose canonical closed omission reason counts without
excluded paths or unread contents. Candidate file evidence unavailable for reading or retrieval
is identified by its canonical omission count, separately from unavailable tool uncertainty.
The current traversal's incomplete flag and closed reasons are also projected; these counts
do not imply the contents or specific encoding of an unread file. The existing prompt fitter charges this serialized metadata
and line-number overhead against the actual model input budget.
The single-source, multi-source and hybrid renderers place their existing redacted answer task
after the evidence and uncertainty metadata. Single-source and multi-source marker repair uses
that same ordering; hybrid repair already appends its task to the existing prompt. Task text
remains an opaque block, including any governed memory or continuity context; ordering does not
promote that context to source evidence. System authority, citation validation and the original
input/output grants remain unchanged. Existing final-prompt selection and gateway admission
events describe the actual fitted source counts and token costs; ordering is not proof that a
model answered correctly.
Marker repair asks for a bounded JSON insertion plan rather than a regenerated answer. Each of
at most 32 entries identifies unique original prose (at most 512 UTF-16 units) and a supported
citation marker. The existing repair owner inserts markers at original coordinates, then runs
the unchanged verbatim-content, code, assessment, token-boundary, sent-evidence and size guards.
Ambiguous anchors, duplicate coordinates, extra schema fields and unsupported ranges fail
closed. Existing literal marker-only responses remain compatible under those guards. This
changes neither the turn's physical-attempt ceiling nor its remaining input/output/time grants;
existing answer-details and reconciliation events record the actual disposition without bodies.
When that budget requires shrinking a located excerpt, a complete matching line that fits the
remaining UTF-8 byte grant takes priority over an unrelated leading prefix. Adjacent complete
lines may fill the remaining grant. The fitted excerpt retains its physical source offsets and
rebinds its line range and stable identity; only that final sent range can authorize citations.
If no matching complete line fits, the existing UTF-8-safe prefix fallback remains bounded.
Fresh reads reserve each qualified file's observed byte requirement within the aggregate source
budget, and only those qualified paths may exceed the ordinary 8 KiB excerpt window. The pack
cache fingerprints these per-path limits. Once the collector overflows, later files perform no
collector byte-counting or line-counting work. Gateway fitting still enforces the model input
budget independently. Named targets, exact absence checks and diagnostic questions retain their existing routes.
The existing connected-context Activity Log owner separates completion evidence into correlated
state events to retain the registry's 48-context-field bound. `completion-details` records the
read, workspace-index, structural and known-fit observations; `source-details` records actual
semantic-provider decisions, metadata inspection/retention counts and omission totals. The latter
reports each closed omission reason's exact aggregate count, the number of retained omission
details and whether details were clipped. These are omission entries, not distinct files or confirmed
errors; a path may have more than one reason. Legacy packs derive totals from their complete detail
list. These events carry the same request correlation and scope/query digests and precede the
single `completed` terminal event. They contain no paths or source bodies.
The planner records the direct-lookup decision that actually controls ring composition; source
details carry that decision rather than reconstructing it from the final ring count. A plan that
requests clarification settles with `search.connected-context.clarification-needed`, an information
event carrying the closed clarification reason, retrieval intent, anchor/ring counts and request
digests. It does not emit a retrieval failure. The existing user-facing clarification response is
unchanged; unexpected planning errors still emit the correlated failure event.
Pre-graph definition discovery can reuse certified lexical atoms, but merges them by stable identity
before ranking: the same evidence is counted once, while distinct declaration provenance remains.
The ranking boundary also removes stable-identity duplicates from later augmentation. The existing
source-details event records the actual total reused-evidence atom count without paths, query text
or source bodies.

#### Traversal and explicit caller budgets

Recursive lexical search and file discovery visit the accepted scope without a default file-count
or elapsed-time cutoff. Final source reads likewise have no default file-count cutoff: `filesReadMax: null`
retains eligible requested facts under the actual excerpt-byte and model-input budgets. Explicit finite
caller read budgets remain independently enforced. Source reads use at most eight concurrent descriptor
reads, so a broad answer cannot materialize all 2 MiB buffers at once. `null` limits express that policy on the wire; internal execution controls
still honor an explicit caller deadline or cancellation. Directory entries stream in bounded batches,
source bytes are processed with bounded concurrency, and only bounded best matches and diagnostic
summaries survive the scan. These shared defaults also apply to manual Editor find-in-files, replace
preview and symbol lookup, coding context lookups, and grounded symbol trace; explicit finite callers retain their
bounds.

Structural AST, import, symbol, endpoint and source/test intake likewise honor the actual caller
file-scan ceiling. A null ceiling uses all eligible entries in the finite admitted candidate
inventory. Resolver metadata reservation follows that same ceiling. The request-local AST reader
fixes its current-source metadata capacity once from the admitted inventory and caller ceiling;
guarded reading, currentness, cancellation and partial-source uncertainty still apply. Complete-text
reuse retains the independent bounds stated below, and optional enrichment retains its finite grants.

An unlimited default lookup uses fresh live traversal rather than treating a finite workspace
index as complete coverage. It may reuse completed matching metadata from that same bounded index
after fresh canonical-path, hard-link, file-identity and high-resolution modification/change-time
validation. Each file retains at most one full-query-identity record containing physical line ranges,
scores and definition status; bodies and previews are absent. The full identity reuses the diagnostic
fingerprint producer and includes matching interpretation, effective result/line limits and policy
intent. Snapshot identity additionally binds scope, ignore/candidate policy, byte grant and algorithm
version. Partial, cancelled, timed-out, corrupt or incompatible records require live matching.
Changes to decoding or matching semantics invalidate the existing snapshot version, including
completed negative records whose source bytes and file metadata have not changed. The markup
declaration correction uses snapshot version 9; prior snapshots require fresh live matching.
Sixteen lazily loaded query shards retain the existing encrypted store's snapshot and entry bounds,
an 8 KiB record bound and a 64 MiB aggregate request-record bound. They are partial acceleration
metadata, never discovery authority. Capacity refusals remain visible as dropped records; retained
and reused counts describe actual guarded index records, independently of source coverage counts.
An active request may evict unseen advisory records even when capacity refused every new record.
This releases bounded reuse capacity without claiming source-file deletion or complete enumeration;
the next uncached lookup still requires live matching under the existing guards.
Positive evidence excerpts are still freshly read. Active known-fit observers, semantic/document
inspection and Editor lanes retain their live content behavior; an observer may release this need
only after it irrevocably stops. Thus a warm workspace search with no body reads does not imply that
a grounded answer performs no known-fit or evidence reads. Text files up to and including 2 MiB are eligible regardless of extension;
images, binary content, unsafe aliases, and larger files are excluded. Ordinary-folder recursive content searches do not inherit Git-oriented generated-directory
exclusions merely from names such as `build` or `dist`. Query-named ordinary-folder documents use
that same eligibility distinction; repository generated code remains excluded before unconditional
read admission. Hard denials, containment, ignore, binary, size and budget checks still apply.
Leading `./` in a query reference denotes the same scope-relative target and is removed before
strict canonical validation. Parent traversal and interior dot segments are not normalized away;
canonical sensitive names still pass through the existing hard-denial policy.
Complete extracted file paths are target data, so their `reference`, `history` or `caller`
directory segments cannot request relationship/history rings. Actual relationship/history words
outside the path retain their routing; requested tests and integrations use the same canonical
relationship guard. A factual lookup with freshly admitted query-named file paths, in Git or
ordinary folders, focuses discovery on those paths only when every source request clause
binds a named file and its canonical planner decision contains no independent non-path target.
A separately requested, positively parsed general recommendation without a source constraint
does not add source work; unknown or source-constrained independent clauses remain broad.
The existing target decision supplies a positive, completely parsed `namedFileOnly` result;
finding a path somewhere in an otherwise unknown clause is insufficient. Closed file-list,
file-contained fact and file-subject explanation forms retain canonical quote and presentation
projection. An explanatory predicate attached to one named file, including an explicit singular
anaphor and its coordinated objects, retains that binding. Commas are classified before word
projection so a separate command or subject cannot become part of that file's predicate.
A positively parsed return/open/read orientation to one exact query-named path may
bind subsequent local function, method, section or value questions in the same request. Those
questions cannot precede the orientation or choose among multiple distinct paths. Actual quoted
targets, nonlocal locations, other source constraints, relationship/history requests and unknown
meaningful continuations remain broad; this does not infer a source from prior conversation.
The existing structural request context binds to that narrower search scope; the human's source
scope and budgets remain unchanged. Independent clauses after commas, additional paths omitted
by the bounded reference projection, definitions, diagnostics, relationships and history retain
their existing discovery flow. Mixed document/implementation lookups retain discovery of the
independent target.
Ordinary document eligibility reuses the shared web/text-document extension groups, including
XHTML and Markdown, alongside XML and existing bounded document extraction. It does not enumerate
navigation neighbours or widen the human's scope.
Quoted file targets match their extracted reference identity rather than their anchor kind.
If all complete file targets have closed admission rejections, the existing ring and
augmentation decision events record `explicit-target-unavailable` and retain those rejection
facts. They do not substitute another same-basename file or enumerate its contents. An independent
source target or a requested relationship retains its existing retrieval flow.
Existing correlated admission, skipped-ring, read and budget observations describe this path;
non-Git folders cannot dispatch the Git-history ring, even when history was requested.
An intentional index bypass is reported as `live-scan`, with its own count of completed
text-search calls. It is not an index failure or evidence of index reuse. If no indexed result,
snapshot load, or snapshot save was observed, both completion projections report the provider as
`not-evaluated`, even when an index was injected. Both finite searches and compatible unlimited
matching reuse retain their actual cold, warm, reconciliation and load/save-failure observations.
Index failures preserve live source retrieval and its coverage; the observed adapter still records
the failure. A failed load or save with zero retained, indexed and reused records reports
`live-fallback`; a save failure after actual index work preserves its observed cold or warm mode.
The bypass counter counts logical searches, not physical directory walks. Request
abort/deadline controls race delayed index operations and fence every later snapshot chunk, write,
sync and publication step. Owned descriptor closure and temporary-file cleanup remain permitted.
Both server wrappers forward the request-active guard alongside the existing generation fence;
late operations cannot publish or populate a reusable cache after request cancellation. Reported
elapsed time includes finalization, and a deadline consumed there remains visible as incomplete
coverage rather than disappearing from the request's time accounting.
Raw directory entries must also satisfy the shared portable scope-path contract before resolution;
unsupported names are never normalized into a different file or traversed. Unlike a sensitive-path
policy denial, this exclusion means the requested tree could not be fully examined. Search reports
`unrepresentable-path` incomplete coverage and a separate `unrepresentablePathsByDiscovery` count.
The count measures observed rejected entries, not the unknown files below a rejected directory.
It survives finite index reuse and is refreshed with live membership; overview and multi-source
summaries add search-work counts, so overlapping passes can count the same entry more than once.
The existing scope-incomplete warning and correlated completion/source-details Activity Log events
preserve this uncertainty even when valid siblings match or no eligible file matches.
The unchanged admission contract rejects relative paths over 4096 UTF-8 bytes, backslashes, NUL,
absolute or drive-prefixed paths, an initial `~`, and empty, `.` or `..` segments. The initial-tilde
rule is positional: root `~notes.md` is excluded, while `src/~notes.md` is eligible.
Optional structural and Git-history enrichment are separate from lexical coverage. Their planner
requests Git history for explicit history/relationship questions and repository-wide diagnostics,
including diagnostic follow-ups. A workspace-root selection alone does not request history: current
policy and other factual questions must not acquire unrelated commit recency/churn evidence merely
because the same files live in Git. Existing source-details/completion events retain the planned,
executed and skipped-ring observations; diagnostic candidate scoping remains in force. Their planner
slices retain finite scan counts (currently 614 and 307 files respectively) and finite returned
matches; they do not cap the recursive lexical scan. An explicitly finite elapsed budget is sliced
across rings, while the default `null` deadline remains uncapped. Retained lexical matches are
bounded by accepted context capacity independently of corpus traversal.

The existing structural request context can retain complete, physical-line-preserving evidence
from its code-index reader for the endpoint graph only. This new retention is explicitly bounded
by the first 512 eligible files, 64 KiB per complete source and 32 MiB of encoded text in aggregate;
its existing ranking-preview Map is not claimed to have those aggregate bounds. Endpoint binary
probes remain live. Every reuse rechecks current eligibility, canonical root/path, strong file
identity, nanosecond modification/change times and single-link membership before and after lookup,
plus the reader's byte grant and request abort/deadline. Changed, weak, unavailable, partial or
unretained sources take the established live reader. Request-bound complete and oversized-prefix
reads recheck active eligibility after their own fresh metadata resolution and before descriptor
I/O; standalone builders without that optional guard retain their existing behavior. Scope,
policy, filesystem and limits remain bound to the same request context; no text crosses requests
or supplies final evidence reads.
Physical Activity Log I/O counters continue to count the actual underlying calls rather than
charging a second body read for reused text. This bounded work reduction does not establish an
actual model-response latency improvement.
Import discovery likewise classifies and parses one complete, size-admitted source buffer through
the existing guarded text-inspection reader. It does not read the same file again solely for
binary classification. Supported decoding and line-preserving secret redaction still precede
parsing; incomplete, binary, unsupported, changed, unsafe or oversized sources cannot produce
import edges. This buffer belongs to that read and does not add cross-request source retention.

Explicit endpoint implementation questions reuse these existing graph and source readers.
Current lexical source candidates may order endpoint intake before its existing structural file
cap. A configured registration admits only a literal method and path with a direct handler in the
same record; ambiguous, computed or spread declarations do not certify a handler. Handler
admission retains the registration path and exact observed identifier span, then uses the
existing lexical reference index to identify its current target. A global same-name lookup cannot
certify that relationship. Definition traversal requires the existing TypeScript AST index, a
current guarded source snapshot, an unambiguous lexical call binding and the complete call span
inside an actually read excerpt. Calls belong to their nearest exact indexed callable declaration;
uninvoked nested functions and unsupported anonymous owners cannot inherit the outer handler's
identity. Known targets reuse their actual indexed definition spans and ranges rather than a
name-only global lookup. Exact declaration identities distinguish same-line declarations.
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
Imported targets retain the exact runtime module-export declaration through the existing
re-export resolver; a same-named method or nested declaration cannot replace that identity.
Runtime re-export declarations retain uncertainty when their source is unreadable, only partially
observed or unresolved. A missing indexed export in such a branch is not proof of export absence
and cannot certify a unique target from another branch. These checks retain existing read caps.
Type-only imports and exports, ambiguous bindings and unavailable source projections do not
certify runtime references. Package output-to-source mapping uses explicit `rootDir` and `outDir`
from already guarded compiler metadata, an unambiguous configuration owned by the package, and
only sources already admitted inside that package. It adds no read or candidate grant and does
not admit generated output. Explicit unsupported package entries do not grant a root fallback.
An unowned inline callable may supply a definition-location witness only when its fully observed
lexical call and reference agree on the exact identifier and target declaration spans. Its target
body uses the same guarded reader and finite target capacity. The existing definition evidence
retains a resolved reference edge with the observed source and exact target coordinates, including
that edge in its stable identity. Ranking and excerpt selection reuse declaration priority without
changing lexical relevance, weights or floors. Continuation preserves the reference relationship
and `source-graph-incomplete` uncertainty; generic structural targets receive no declaration
promotion. This does not establish callback invocation or an outer-owner call edge.
Precisely referenced definitions use their complete AST declaration ranges without appended
context lines, preventing neighbouring definitions from consuming each other's excerpt grant.
Existing own-return and direct-await annotations order certified calls with fair sibling traversal.
Exact structural endpoint-registration ranges and their existing surrounding-context boundaries
split broader ordinary windows. Uncovered surrounding evidence retains its relevance and priority;
these spans do not certify handler invocation. Ordinary query-facet scheduling cannot repartition
those exact structural registration queues.
Binding certification does not replace relevance with a constant score. Declaration promotion
preserves its admitted score; a further definition reuses the original-query matcher on its actually
read, redacted source, followed by the existing relationship attenuation. Explicit selected-file
priority remains intact.
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
Ordinary natural-language document excerpts and canonical build manifests recognized by the existing
ecosystem registry include the complete decoded, redacted source when it fits both the existing
window grant and remaining total bytes. This uses the canonical reader's
current snapshot and actual full-file range. Explicit selected-file or line-range requests,
coverage-certified windows and source-code excerpts retain their requested geometry; a larger
document retains the existing bounded anchor windows.
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
Physical excerpt allocation preserves connected parent chains across already selected route files.
Explicit human file selections remain first. The request-local traversal supplies only current,
certified definition identities, observed parent relationships and actual body-byte requirements.
Admission funds the selected target definition window and each current observed parent caller span,
using their unique physical-line and separator costs. A compact span is bound to the original
current parent, exact child and accepted source coordinates; it does not narrow or copy a definition
certificate. Unobserved, anchored or partially clipped caller spans receive no compact priority.
Independent route roots and their file queues receive bounded initial byte portions from the
existing connected share. Existing certified traversal sets file order; existing query relevance
orders targets within each file, with stable ties. Roots and their file queues take turns within
those portions. After that bounded pass, shared opportunities combine the existing root-local
relevance nominations with the existing root/file turns. Each relevance nomination considers its
file's higher-scored and tied whole targets in stable certified traversal order. Existing admission
checks retain the longest prospective prefix that fits jointly with the nominated file turn.
If no joint proposal fits, the feasible relevance proposal is retained. This bounded tradeoff
applies to new targets; previously funded targets remain intact. Whole targets that fail admission
remain separately retryable, including later targets in served files.
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
Shared ancestors reserve bytes once; upgrades retain funded target windows, later
same-file targets remain eligible, and oversized branches receive no partial reservation.
Aggregate same-file unions must fit the remaining connected share; each physical excerpt retains
its existing per-window byte limit. Reservations do not add selected paths or change relevance
scores or invocation uncertainty. Ordinary ranked evidence retains its share of the remaining byte
grant. Existing human and endpoint selection
priorities survive path ordering. Reserved windows precede ordinary extras, with explicit human
windows first. When current coverage windows apply, independent search windows and unfunded
discovered-definition windows share the residual byte grant through bounded queues after explicit
human and funded current windows.
Unused portions return to their shared grant.
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
funded definition windows, exact structural endpoint-registration queues and trace priorities retain
their existing behavior. File-pattern, regular-expression
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
Direct batched reads retain the original requested-range index on every returned window before
flattening. An omitted range leaves that index absent; duplicate and overlapping requests retain
their distinct indices. Discovery joins observations by that producer index, keeping current
witnesses when another old lexical range is unavailable and recording the unavailable atom through
the existing uncertainty owner. All-unavailable contextual batches remain incomplete. Actual
snapshot changes retain their fail-closed I/O error. Lazy asynchronous iteration schedules each
next discovery or frontier read only after the prior result has settled and updated its remaining
capacity; no concurrent promise batch bypasses deadline, cancellation or currentness checks.

The governed request's existing document collector checks the original remaining file and
excerpt-byte grant before each extraction. It bounds the redacted logical projection, including
UTF-8 separator bytes, within that capacity and discloses exhausted or truncated evidence. All positive returned document
projections reserve their bytes and distinct paths before code reads. Final usage preserves any
larger assembler usage and retains original initial usage plus actual consumed code bytes and
distinct positive-consumption paths plus all actually returned positive document projection bytes
and paths, even when later invalidation or assembly drops their published views. The reservation
does not enter assembler initial usage, so those contributions are not charged twice. Raw document
input, parser work and all filesystem I/O are outside these excerpt charges.
Each batch uses one classified, redacted source snapshot. A later expansion uses a fresh guarded read and must match
the first complete redacted-source fingerprint; a mismatch invalidates all views for that path
without refunding consumed bytes. Subsequent passes exclude processed ranges and retain actual
partial-view identities rather than claiming complete bodies from clipped reads.
The existing selection-details operation records planned ordinary ranges on attempted
reader paths, ordinary ranges intersected by nonempty returned views, and deferred definition
ranges.
An intersection count does not certify complete source content; truncation and omission counts
remain authoritative. Separately identified actual returned partial views retain their own ranges,
content and physical-view digests through assembly, without inferred continuity or uncharged
separators.
Multiple unidentified uncovered views remain fail-closed, and conflicting views retain uncertainty.
Bounded observations do not establish that an arbitrarily large function was fully read; actual
truncation and omissions remain authoritative.
The existing guarded reader batches each file's ranges, charges
actual returned bytes and reports omitted windows. A definition that loses currentness cannot
retain its reserved priority; bytes already read from a subsequently stale definition are charged
and its windows omitted.
Certified targets, including certified seeds, consume a finite request capacity bounded by the
validated query's metadata capacity and the actual admitted compiler-AST definition count.
Unique target identities terminate cycles; continuation ends when that capacity or the reachable
graph is exhausted. Observation frontiers retain the validated query's per-level capacity, while
seed discovery and symbol-search bounds remain separate. These implementation bounds remain
inside the original search, read, excerpt, token and caller deadline grants. Closed omission
reasons remain explicit in pack uncertainty; the existing Activity Log records uncertainty counts
and actual read/final-prompt counts. Fragment and polyglot discoveries without that AST certification
remain uncertified. This is source attribution, not proof that a conditional branch executed.

The inclusive file-byte ceiling is owned once by `MAX_RECURSIVE_TEXT_FILE_BYTES` in the pure
workspace contract primitives. Recursive matching, planner limits, document input admission and
the grounded prompt use that same value. The prompt distinguishes supported document text
extraction from excluded binary formats and describes omission metadata conditionally. Proposed
tests follow the connected repository's framework rather than assuming Vitest.

Text preview's optional `sourceTextBytesRead` records the raw source buffer supplied to decoding
before redaction, not the stat size or decoded UTF-8 size. It excludes duplicated classifier reads
and descriptor lookahead. A legacy response without that observation does not fabricate a count.

#### Filesystem consistency and redaction

Streaming directory enumeration distinguishes membership changes from directory identity changes.
Concurrent additions or disappeared entries retain safely observed evidence and sibling traversal,
with `io-error` incomplete coverage; they never certify a stable snapshot. Local child-directory
`ENOENT`, `ENOTDIR`, `EACCES`, `EPERM`, `EIO`, and `ESTALE` failures at opening, iteration or closing
are recoverable only after the connected root is freshly revalidated. Root failures, process-wide
descriptor exhaustion, programming errors, replaced inode/device identity, unsafe aliases, and
root containment changes still fail closed. A transient connected-root filesystem or server-resource
outage is classified separately from an invalid or missing folder selection: the remaining healthy
sources continue with an explicit skipped-source notice. If every source is unavailable, transient
outages return 503 (taking precedence over permanent selection errors); permanent unavailable
selections retain 400 and authority denials retain their existing status. The existing root-denial
Activity Log records the closed failure kind and request correlation without exposing paths.
Terminal retrieval failures do not wait for physical directory cleanup behind an outstanding
operating-system read. The failure event
records the number of pending iterator closures; owned observers retain the original correlation
and report any later cleanup failure without replacing the primary error or consuming late entries.
Symbol definition scans yield between uncached file reads and observe cancellation before starting
the next file. Expected read failures retain healthy sibling evidence and emit
`search.symbol-line.unavailable` through the existing Activity Log, with a path digest, closed
failure reason and cause metadata. Unexpected programming failures retain their original exception
and reach the terminal retrieval diagnostic. Secret redaction uses
one private-key boundary scan and scheme-start guards, including conservative redaction of an
unterminated private-key body, so eligible large text does not trigger repeated suffix scans.
Workspace search and excerpt projection preserve each masked secret span's original LF/CRLF
delimiters without retaining its body or columns. Facts between separate secret blocks therefore
keep their physical source lines in lexical matches, numbered model context, and source navigation.
The general-purpose redactor's default output remains unchanged. Persisted lexical snapshots from
before this coordinate policy are invalidated by the existing index version fence.
Auxiliary symbol and document filename discovery follows the same complete streaming traversal
policy. Each requested filename pattern retains a bounded independent result bucket within one
shared traversal for the symbol and document batches together. Each logical query keeps its own
fingerprint, coverage, independent retention limit, and search-call charge. The owning workspace
request context admits only a common scope, policy, byte ceiling, signal, and elapsed control;
it does not cache a complete corpus inventory. If declaration discovery precedes graph rings,
requested document references join that traversal and their evidence is reused during assembly.
Every admitted collector settles before a failure propagates; the shared iterator retains the
existing cancellation and physical-cleanup ownership. The existing request Activity Log reports
logical search counts separately from observed physical directory I/O.
Actual source-line inspection and final candidate ordering preserve
distinct requested targets before the accepted read and context budgets select answer evidence;
a popular first target must not displace every result for another explicitly requested target.
Definition-line lookup inspects every retained symbol candidate sequentially with the existing
2 MiB descriptor bound and cancellation/deadline checks, without a second read-count cutoff.
Located symbol lines use the existing definition priority for atom and excerpt-window selection;
requested definitions consume their per-file byte share before unrelated file headers. File-level
matches without a located line retain ordinary priority and the existing header fallback.
For requested definitions, a located definition replaces its same-query, same-path generic
filename-discovery header before source reads, including contextual requests. Overview headers,
independently matched ranges, and discovery from other queries remain eligible; actual excerpt
truncation remains reported. Mandatory named-definition discovery runs once before optional graph
work and reuses its result during assembly. Verification scans retained lexical candidate paths
and filename candidates with one guarded source decode per file, sharing the existing structural
source lexer across requested targets. Comments, string data, and unsupported source syntax cannot
certify declarations. Canonical requested targets cover the full bounded query independently of
the planner's eight ranking hints. Explicit anchor intake limits remain honored; omitted original
technical or quoted targets prevent declaration certification. Optional graph work may be skipped
only when every requested technical target has a verified declaration and the primary traversal is complete, or its sole limitation
is retained-match clipping. Related semantic context remains eligible; this choice never asserts
answer completeness or removes actual clipping, unreadable-source, or interrupted-scan evidence.
Default Chat queries share the lexical ring's finite retained-result capacity, derived from the
accepted excerpt-byte and model-input-token budgets rather than a fixed independent file count.
Retention uses a worst-first heap, preserving deterministic ordering without linear insertion
movement for every matching file. Each matching file's strongest range precedes secondary ranges
so repeated hits in one file cannot consume every retained slot before another relevant file.
Omission samples use the same bounded heap, ordered by path independently of read-completion timing.
Uncapped text scans and direct coding reads first inspect the existing UTF-aware 4 KiB binary head
through the same guarded byte reader. A complete small file reuses those bytes. A larger eligible
text file incurs one additional bounded head read, then full decoding; a binary tail is still
rejected. Both guarded reads must identify the same file snapshot. A changed snapshot records
unavailable-file coverage rather than accepting mixed observations. Binary exclusions remain
policy exclusions, without a fabricated incomplete-search flag or extension-based denial of text.
A configured embedding endpoint alone does not enable repository semantic sampling. The configured
provider factory first resolves a usable repository pod; an absent or unreadable pod returns the
existing unavailable-provider result before traversal, immediately reports its observed pod mode,
and leaves lexical matching and coverage unchanged. Source-decision activity evidence records that
no semantic provider was used. Healthy pods retain the existing bounded sampling and index-only
retrieval path.
An explicitly finite traversal passes its collected documents through without computing an unused
semantic sampling score; that session does not select by score. The streamed semantic lane retains
the best 32 score/path-ranked documents within its existing
128 KiB text pool. Each document receives a bounded equal share; existing anchored byte windows
retain relevant late content and its actual source-line origin. Admission encodes an anchored
source once; an unanchored fallback encodes only a prefix bounded by that document’s byte grant.
Retained excerpts are not re-encoded to maintain an unused byte total. The small retained list
continues to use the same score/path sort and provider-payload limit. Neither document selection nor
omission sampling depends on which concurrent read finishes first. Explicit finite query limits remain authoritative. Excerpts
are read in bounded concurrent waves; unused byte grants are recycled after a wave settles, while
the actual accepted byte/token budgets determine which evidence fits. A large matching set therefore
does not force every excerpt to a one-byte allocation. Unread budget tails remain budget omissions.
Distant anchor windows share disjoint byte regions. If oversized anchor ranges overlap, their
shared boundary never advances beyond the later anchor's source start; a tight grant may retain
only part of either anchor, but midpoint clipping must not discard that later start. Unequal grants
preserve complete anchors when their combined required bytes fit, and zero-byte grants emit no view.
Selected files retain every distinct, already-admitted evidence range rather than independent
per-file atom or window quotas. Priority-based overlap deduplication subtracts only already covered
lines, preserving uncovered head, tail and bridge segments. Each remaining segment retains the
strength of its overlapping evidence atoms; higher-priority anchor segments remain first under
tight grants. The existing safe excerpt reader batches those ranges from one
freshly classified, decoded and redacted file snapshot, preserves original line coordinates, and
charges every returned fragment against the accepted cumulative byte grant. A stale location beyond
physical EOF is an omitted range and cannot discard another valid requested window from that same
snapshot. The ordinary default-window fallback applies only when every requested location is invalid.
Remaining ranges are
reported when that grant is spent; cancellation or a changed source prevents publication. Global
retained-result and model-context budgets remain authoritative.
Successful primary literal-content matches survive incidental filename/output-count relevance
boosts; vague, diagnostic, relational, and semantic evidence retains ordinary relevance filtering.
Positive user-requested source descriptions can also supply primary lexical relevance when all
descriptor words occur in order on one completely observed coherent source span. Bounded ordinary
modifiers may intervene; whole-word matching, explicit negation, case sensitivity and physical read
completeness remain binding. HTML uses the existing quote-aware tag and entity owners: inline
formatting preserves text, while block boundaries separate descriptor spans without changing
physical source-line coordinates. A file containing raw text, comments or ambiguous/multiline tags
conservatively declines this optional witness and its score boost; ordinary HTML source matching
remains available. The body-free
`sourceDescriptorMatch` observation is bound to the actual lexical atom and query identity; it
never verifies organizational approval or gives repository text instruction or permission authority.
The typed `search.connected-context.evidence-details` sibling records the certified descriptor-path
count on the existing Activity Log and correlation, separately from aggregate primary content.
The source-details event already occupies its 48 contextual fields; its existing fields and
single-row semantics remain unchanged. The small evidence sibling preserves the same field cap
without recording descriptor words or paths.
The existing source admission, freshness, excerpt reads, selection floors and cumulative grants
still apply. Same-query validated match records may preserve the observation; token-hash inventories
alone cannot manufacture it. The existing runner prepares that pure query derivation once per scan.
Source-subject normalization and the planner share the existing presentation and complete-path
grammar. Formatting numbers and path components cannot become unrelated content terms; complete
path identity remains a separate bounded ranking signal. Changed matching semantics invalidate
prior query-match identities, including prior positive formatting-only matches.
Query-named paths (relative, contained absolute, or local file URLs) are case-preserving explicit
selections. A single admission seam applies selected-scope membership, canonical containment, deny
and ignore rules, safe regular-file checks, and the existing binary/size classifier before injection.
Its closed rejection vocabulary is `outside-scope`, `denied`, `missing`, `ignored`, `generated`,
`binary`, `size-exceeded`, and `unsupported-format`. Human Files selections retain their existing
safe ignored-file exemption; pasted paths cannot acquire it. All primary references are classified
before diagnostic pairing builds content graphs. The existing request-local structural context
checks their rejected-path eligibility again when consuming a retained candidate inventory, so a
rejected explicit source cannot be read through a helper graph or its prefix/probe lane. This does
not disable bounded structural prefix reads for other eligible, unaddressed sources. Exact rejected
paths also flow into the existing
lexical and filename candidate policy before content reads, including finite discovery and rescue.
Literal exclusions do not interpret filename metacharacters, and the existing persistent-index and
request-local session identities bind that policy. Human Files exemptions do not create exclusions.
Basename admission uses the existing path-only discovery with exact final-segment matching before
bounded retention. This metadata-only enumeration observes ignored names so original admission can
record their rejection before later search lanes; it grants no source authority. Canonically
eligible code paths then use the existing single bounded classification batch under the original
basename-search reservation. The discovery cap, safe Files exemption, and live content checks remain
unchanged.
Its match counter counts eligible discovery/classification results independently of later admission
deduplication; raw ignored or binary metadata names do not become classified matches.
Admitted paths reuse `repo.selectedFile`
evidence, survive both relevance floors, and receive read-budget priority without widening byte or
token grants. A valid line hint selects the existing located-source window; a hint beyond the file
falls back to the default window and never claims an anchored read. Known dotted basenames use
bounded shared filename discovery, retaining every eligible match independently.
Admission counters and the closed reason list are projected on the existing
`search.connected-context.source-details` sibling because the completed operation already occupies
its bounded field contract. Its correlation joins the unchanged completion/read-budget evidence;
the field cap and existing completed fields remain authoritative. Diagnostic traces reuse the
bounded failure parser and an independent six-reference channel, leaving eight user-term anchors
available. Within that unchanged cap, the primary local diagnostic frame precedes explicit
question paths and supplied query references; secondary frames and conversation referents follow.
A long trace therefore cannot consume every slot before the user's separately named file.
The six-reference planning channel is not a cap on explicit source admission. Admission retains
the primary diagnostic frame first, then every unique path explicitly named in the independent
question, followed by the remaining planned references. It uses the existing extraction metadata
bound, selected-scope policy, classification/search reservations, deadline and file/byte/token
grants. It does not admit additional diagnostic frames or conversation referents beyond the planned
channel. A seventh requested file must not silently lose explicit-file priority merely because
the planning preview is full. The existing source-detail counters distinguish the bounded
`referenceChannelCount` from actual admitted/rejected paths; exhausted grants remain visible as
budget omissions/uncertainty rather than an assertion that the requested source is absent.
External runtime/generated frames are removed before the reference cap. Original path
casing and numeric source locations survive admission; the primary frame and its existing
structural test/source pair receive the same eligibility and read-budget checks. Ordinary lexical
search uses the independent question channel; the original trace remains model context and query
identity, while external runtime frames cannot introduce ordinary search terms. Tool names inside
trace bodies never request project metadata. A diagnostic paste without an independent question
searches only its freshly admitted references; when none are admitted, its lexical ring performs no
search rather than forwarding an invalid empty query or restoring raw frames. For a diagnostic question with admitted or discovered
source candidates, optional Git history is restricted to those candidates and their discovered
dependencies within the original selected scope. Advisory atoms cannot enlarge directory or file
membership. Sharing a commit cannot independently nominate unrelated source or metadata files;
explicit relationship/history requests retain their existing broader lane. Metadata injection follows the independent user
question and the effective retrieval intent. Manifest inventory routing requires a complete
enumeration request; mentioning manifests while asking about validation, loading, or combined
inventory and behavior retains source-code search. Only an anaphoric follow-up with a previous targeted
or diagnostic intent may inherit that intent; independently named targets and new traces classify
on their own. The closed `retrievalIntent` vocabulary is `project-metadata`, `repository-overview`,
`targeted-code-search`, `diagnostic-search`, `conversational-follow-up` and `clarification-needed`.
Completed and clarification operations retain the actual turn classification; an eligible
`conversational-follow-up` can retain the previous targeted or diagnostic intent for planning.
Supplied reference paths, lines, origins, and inherited effective intent participate
in plan identity without changing the historical no-reference identity.
The final six source-detail slots hold detected/in-scope/admitted-frame, test/source-pair,
reference-channel, and closed metadata-injection observations. Total/external frame counts use the
registered `search.connected-context.selection-details` sibling on the same log port and
correlation. This companion accommodates later selection observations without dropping existing
fields or expanding the formatter's contextual-field cap.
Optional augmentation skip reason and metadata retention capacity reside on completion-details.
Completed and source-details each retain their full emitted observations within 48 context fields;
the strict writer and reader caps remain unchanged, including metadata-evaluated follow-up cases.
The registered `search.connected-context.answer-details` companion uses the same canonical
scope/query digests and correlation to reconstruct answer kind, observed citation behaviour,
actual final-prompt file count, bounded declared/unread counts, citation-repair disposition, and
follow-up trigger, pass/admission counts, outcome, and configuration disposition. No declaration
path or answer body enters this log. Technical failures retain the existing closed error header,
body-free frames, and causes. Normalized synthesis output is buffered before publication; unsafe,
unknown, or excess declaration lines are removed before client delivery and history persistence.
Intentional request cancellation retains the existing cancelled chat-turn state across reloads.
An aborted native selected-file reader is translated at admission into the existing cancellation
error, preserving its cause. The registered retrieval line remains WARN/cancelled and does not
create a registered-failure support incident; actual read failures and timeouts remain distinct.
Only final sent packs and excerpt ranges authorize citations. Assembled reads retain their physical
read/byte accounting and audit meaning even when prompt fitting removes their evidence.
Prompt rendering omits zero-length metadata-alias bodies instead of emitting empty evidence fences.
Nonempty whitespace source lines, document labels, positive body bytes and ranges remain unchanged.
The retained packs preserve alias identities, provenance, usage, confidence and citation authority;
existing final-prompt token and sent-reference observations measure the serialized result.
An explicitly empty sent-pack inventory grants no source support; only absent legacy metadata may
fall back to assembled evidence. Zero sent files retain physical read usage without producing a
grounded source manifest.
After governed memory attachment, final publication records optional memory observations on the
existing `chat.response.message` operation: the actual structured
`uncitedMemoryContextMarkerCount` and closed `memoryContextDisposition`
(included/excluded/not-requested). Its assistant/request causal relationship remains unchanged.
This distinguishes actual included memory from budget exclusion across single, multiple, and hybrid
sources; neither retrieval candidate counts nor model-authored marker prose proves inclusion.
The observation carries no memory content or answer text.
Citation repair is decided from the current answer: a substantive source answer without markers
may use the single bounded repair even if earlier answers from the same model cited reliably.
Historical citation observations remain descriptive and cannot waive current source validation.
The repair dispatcher and validator share the same 131,072 UTF-16-code-unit text limit. An
original answer above that supported size skips the extra model call as `skipped-capability`;
it retains its original content, usage and uncited uncertainty. File and numeric citation paths
use the same eligibility check, and the bound is not an additional token grant.
Both literal repair and locally constructed annotations preserve complete substantive tokens:
markers cannot split contractions, contiguous symbolic operators or existing guarded graphemes,
identifiers, decimal values and paths. Refusal preserves the original answer and uncited warning,
while charging the actual completed repair attempt within the unchanged shared grants.
The existing Activity Log records the actual repair disposition and final citation behaviour;
clarifications and already cited answers do not acquire an extra model call.
Initial synthesis and either marker-only repair or an admitted insufficiency follow-up share a
maximum of two physical synthesis attempts and the original remaining search/read/token/spend/time grants.
Declared unread targets receive priority during final prompt fitting;
the actual sent pack must retain each admitted target before a second gateway dispatch. A rejected
fit preserves the first insufficiency and all physical-read usage. Injected answerers are also checked
against their actual sent packs; an unusable attempted answer retains its charged synthesis usage.
Follow-up pass count observes a completed retrieval pass even if its additional synthesis is refused;
admitted-path count records targets retained by follow-up retrieval, independently of physical
read/byte accounting and final sent membership.
A file already physically read does not acquire another read through an unread-in-prompt declaration.
The existing allocator's high/exceeded context pressure refuses follow-up; refusal, clarification,
or assessment-only content from a second answer remains still-insufficient. Permitted learned
knowledge may still be returned, but it cannot claim that the unresolved source question was answered.
A substantive second source answer can resolve retrieval
while retaining an honest uncited warning, and never obtains a third synthesis slot. Gateway and context-window retries consume the same physical attempt slots. Separately
bounded entailment verification cannot grant another synthesis attempt.
`KEIKO_CONNECTED_FOLLOW_UP_PASSES_MAX` is default-enabled with one follow-up pass: absent means `1`,
explicit `1` enables, explicit `0` disables, and every other explicit value fails closed to zero
passes with a body-free invalid configuration observation (ADR-0180).
Working-tree recency uses one scope-bound request-local snapshot from the existing observed Git
runner, capped at 64 admitted paths and a shared 1.5-second ceiling further bounded by the remaining
request deadline. A directly connected repository subfolder checks ancestor metadata through the
filesystem root under the original request deadline and abort guard, without an arbitrary depth
cutoff. This remains only the Git-discovery hint; hardened Git membership executes in that selected cwd, and
the selected evidence root never expands to the repository parent. Ordinary folders spawn no process;
exhausted grants and elapsed deadlines refuse
observation. Allowed paths feed the existing recent-path search policy and a small targeted/diagnostic
ranking signal without changing provenance, admission, or floor exemptions. Selection-details
records only the closed status disposition, measured duration, observed/deleted counts and hint/hit
counts. Private scope/status cache identity and path values never enter activity evidence. Status
dependency failures retain the existing structured diagnostics and degrade to ordinary retrieval.
Supported document basenames use the existing bounded path-only discovery port, then the same
admission and document-extraction boundaries; ZIP containers never require text classification.
Only extraction-owned files are removed from ordinary code evidence. An ordinary text file with
a legacy document suffix remains text evidence unless explicitly selected for document handling.
Expected file disappearance/access races record closed missing/denied rejections and preserve
other candidates; cancellation and unexpected dependency failures remain observable failures.
A completed eligible scan with only a retained-match limit reports omitted matching evidence,
not unchecked source files. I/O failures, traversal pruning, cancellation, and elapsed limits
continue to report incomplete scope coverage; omitted evidence never proves a fact absent.
Language source inspection is an explicit trusted grounded-caller hint, rather than an automatic
reinterpretation inside shared lexical search. Coding tool and context-provider lexical requests
retain content-match semantics and cannot receive synthetic nonmatching inspection windows.
Direct named implementation and ADR/RFC fact questions use lexical evidence plus the required
filename batches; they do not schedule unrelated graph or history traversal. Named-file focus in
Git and ordinary folders additionally requires every source request clause to stay bound to a
named file. Canonical quotation parsing preserves possessives and contractions while retaining
actual quoted search targets. Closed attached citation instructions, including current implementation
lines, and word-limit instructions do not create
source targets; separately parsed general advice does not authorize additional source discovery. The canonical anchor producer retains quoted/path targets before removing presentation-only
prose, and removes that prose before definition patterns or ordinary symbols can treat citation
instructions as requested source content. Target-shape, definition and relationship classification
use the same presentation projection; the original question and model prompt remain unchanged.
Canonical reference wrapping and raw file-token masking preserve sentence boundaries so a following
output clause remains separate. An independent prose
topic, even without a quoted or typed identifier, retains recursive discovery. A rejected named
file cannot stop discovery for that independent topic. Sole named-file requests retain
focused excerpts, unchanged source eligibility, and the existing budgets. Explicit relationship,
caller, import, test, integration, history, and diagnostic questions retain their structural routing.
Structural import suffix resolution indexes each immutable, admitted source-path inventory once.
Reversed, case-folded paths support binary prefix lookup while preserving the existing shortest-path
and original-case lexical tie break, including partial-segment suffixes. Results and misses stay
inside a weakly held inventory cache; another workspace or rebuild receives its own inventory.
No source eligibility, retained-file budget, or resolved/heuristic classification changes. Existing
retrieval completion timing and structural-build counters remain the body-free operational evidence.
DTO contract pairing excludes same-language candidates before pair traversal, with one candidate
projection per encountered language. It preserves original source/target order, same-scope exclusion,
name/field confidence rules and shared execution-control checks for eligible pairs.
Import and re-export binding projection groups resolved edges once per immutable edge inventory,
then visits only the current source file's edges. Original edge order, kind filtering and final
specifier precedence remain unchanged; a new inventory cannot inherit targets or misses.
The request-local code index retains one shared promise and drains the same build steps as the
synchronous compatibility entry point, yielding to the event loop after at most 32 source visits
and between graph stages. Descriptor reads, root containment, source admission, shared cancellation
and the absolute deadline remain the owners. Expiration after the final stage is checked before
reporting coverage or caching an index. Existing completion/truncation diagnostics describe the
actual outcome; yielding does not widen intake or claim complete corpus coverage.
Advisory project metadata also streams every admitted directory entry and supported workspace
pattern; unrelated file or service counts cannot hide manifests. Retained manifest evidence follows
the accepted file-read budget or retained query-result allowance, preserving primary root manifests
before nested services. A bounded worst-first heap makes retention logarithmic per observation;
overlapping declared patterns do not count the same directory twice. Dropped manifest candidates
produce an exact retention count and bounded representative budget-omission paths; they do not
make complete corpus traversal incomplete. The completion Activity Log records metadata candidates
observed, retained, discarded, and retained omission details separately, so a representative detail
cap cannot masquerade as the number of discarded candidates. These metadata-stage totals are not
added to canonical pack omissions, which can deduplicate files and replace omissions with later reads.
The same completion records actual unreturned excerpt ranges, clipped windows, unread selected files,
and file-grant, byte-grant, or deadline stops from the excerpt reader. Cancellation produces a failed
terminal event, never a successful completion with an invented stop reason. Workspace
manifests share the inclusive 2 MiB eligibility ceiling. Explicit deadlines, cancellation, unavailable
streaming ports, and failed enumeration remain visible; iterators close on interruption.
A failed wildcard-parent listing is not cached as successful coverage: directly readable explicitly
declared manifests are still probed. Recoverable availability failures in optional structural discovery
do not discard those retained manifests. Recovery is limited to admitted descendants and known local
filesystem failures after fresh root validation; unavailable roots, cancellation, containment
violations and unexpected failures still propagate. The existing metadata-unavailable diagnostic and
scope-incomplete uncertainty remain visible.
The shared size-admitted decoder accepts UTF-8, BOM or recognizable-pattern UTF-16LE/BE, and declared
legacy HTML charsets supported by the platform's fatal `TextDecoder`, including Shift-JIS, Big5,
and ISO-2022-JP. Declarations are inspected within the first 1,024 bytes. An initial XHTML XML
encoding declaration precedes HTML metadata; byte-order marks and recognizable UTF-16 patterns
retain precedence over either declaration. The existing quote-aware attribute cursor consumes
complete tags and skips comments and raw-text bodies, so script strings or quoted attribute
examples cannot declare a codec. `http-equiv` charset parameters are case-insensitive, and standard
aliases such as `iso_8859-1` resolve through the platform decoder. Empty charset values are absent
hints, allowing a later supported declaration; nonempty
unsupported declarations still refuse decoding. HTML metadata labels resolving to UTF-16LE/BE map
to UTF-8, while actual BOM or recognizable-pattern detection retains precedence. A UTF-8 BOM does
not bypass the bounded decoded NUL/control probe. No undeclared legacy encoding is guessed. Unknown or
unavailable declared codecs remain unreadable eligible text: source search records `tool-unavailable`
with `io-error` incomplete coverage, and source reads refuse as unreadable rather than claiming binary
absence. Whole-file NUL/control checks still apply after decoding, including files with a BOM. A
bounded prefix uses a fresh fatal streaming decoder to hold incomplete multibyte or stateful sequences
without inserting replacement characters; complete-file decoding still rejects incomplete tails.
The existing Files source preview uses this same decoder and eligibility ceiling so a cited legacy
HTML or large text source remains inspectable. Preview reads retain the same descriptor identity,
containment, and redaction checks. Legacy encodings and text above the manual Editor's 1,000,000-byte
ceiling open as read-only previews; Editor editing, saving, sessions, and dirty-buffer ownership keep
their existing UTF-8 admission rules. A cited late line starts a bounded preview window at that range.
The existing client stage lifecycle records preview kind, admitted text bytes, and edit capability
without source content or paths. Denied, stale, or mismatched targets never fall back to cached content.
Files above the 2 MiB eligibility ceiling remain visible as excluded candidates and skipped counts;
they do not make an otherwise complete eligible-text scan incomplete. An explicitly narrower
caller byte cap still reports incomplete coverage when it excludes otherwise eligible text.
An eligible file that becomes unreadable or disappears during inspection remains uncertainty:
`io-error` makes coverage incomplete even when other files produce valid matches. The existing
scope-incomplete marker and body-free coverage/skipped counters carry this failure; unreadability
must never prove that an exact target is absent. Intentional eligibility exclusions remain distinct.
Generated-source rescue runs only for supported targeted queries after a complete no-hit scan
actually observed low-value exclusions. It does not repeat a Git traversal for an overview,
project-metadata request, regex, or a scope with no skipped low-value evidence.
Policy-admitted, certified exact-content matches from that rescue remain eligible for ranking even
when their directory has a generated-source hint. This exemption cannot override binary, denied,
or other explicit eligibility exclusions. Symbol-line inspection yields between physical file
scans so cancellation can run without imposing a separate candidate-count limit.
Validated, policy-allowed, redacted relative paths and `size-exceeded` reasons are projected into
the existing model prompt within its input budget and a separate 4 KiB per-source path-list budget.
This is a prompt metadata limit, not a search or file-count limit. Listed paths remain untrusted
data, never instructions. This metadata proves eligibility exclusions
only: it contains no unread body and cannot establish file-content citations or line references.
Exact exclusion counts remain when the remaining prompt budget cannot hold every path name.

An explicit identifier or quoted target starts an independent retrieval question even when the
question contains an anaphoric word such as "there"; named CamelCase targets remain independent
even when a request also says "for that". Primary typed identifiers in factual lookups, including
CamelCase and snake-case identifiers, and quoted targets match whole terms without stemming them
into generic fragments. A named literal fact with no actual content match cannot be replaced by
semantic-only evidence. Diagnostic requests retain the original question and semantic provider,
including questions with quoted errors or snake-case identifiers; they cannot take ordinary-document
or literal-absence augmentation shortcuts. Relationship lookup and augmentation of actual primary
evidence remain available. The planner owns one request-level target decision shared by definition
narrowing and the server's provider, absence and augmentation choices. It reuses anchor quotation
parsing so quoted contents are data. Only typed exact queries and fully parsed, small positive
literal-search or direct-fact command shapes authorize narrowing; unknown or trailing prose retains
the complete contextual question and semantic provider. Actual identifier content remains protected
independently of this routing choice. After that full retrieval pass, one certified present target
may avoid optional graph/history work only when those dimensions, diagnostics, definitions and
document-reference discovery are not requested and traversal is complete. The body-free
`verified-target-context` choice does not certify answer or contextual completeness. Semantic
excerpt provenance remains in all folder prompt renderers as related context, not verified exact
literal presence; it cannot by itself establish either presence or absence. Explicit typed literal
queries and genuine literal-only requests retain strict absence semantics.
Multiple targets share the same
recursive scan. Their literal interpretation participates in the query fingerprint and uses live
matching rather than fuzzy hashed lexical records; approximate semantic evidence cannot substitute
for a requested exact occurrence. Anchor extraction inspects the complete admitted question, including
long specifications and stack traces. The 4,096-character bound applies to individual literal
targets and their aggregate selected metadata (including separators), not to the surrounding
question. Oversized targets are omitted whole rather than sliced; valid shorter targets remain
available. If target selection is clipped, natural-language routing remains contextual rather than
certifying a literal-only request. Explicit literal terms are deduplicated and validated before
needle allocation, fingerprinting, or filesystem access. This target bound does not limit the
recursive corpus.
Before line classification, literal searches reuse the prepared case-aware, any-alternative
matcher to reject files with no literal occurrence. Those decoded files still count as scanned;
matched files retain the same line selection and evidence limits.
General natural-language and orientation requests retain their
existing broader retrieval behavior. Literal lookup prioritizes actual lexical
content matches ahead of incidental natural-language path overlap. Files with the same basename
remain independent evidence candidates: their names alone cannot establish duplicate content or
facts. Explicit duplicate hints remain supported, and existing output/context budgets bound retained
evidence. Exact and suffix path evidence and directory-segment affinity contribute named weighted
composite signals; positive path evidence neutralizes the ordinary depth penalty. Scan ranking
emits the existing exact-path bucket for explicit multi-segment exact/suffix query matches,
while generated candidates retain their eligibility policy. Score ties compare exact-path and
segment signals, depth, then codepoint path spelling. All addressed/selected same-basename
candidates precede unaddressed alternatives; only unaddressed candidates use basename diversity.
Their score ties use shared-parent proximity, segment affinity, then path spelling. Collision,
diversity-demotion, signal, and proximity observations are count-only fields on the same
correlated selection-details Activity Log operation.
Request-local semantic leases open only for an admitted semantic lookup. Existing index fingerprint
verification is part of that bounded logical search, while optional new live refresh consumes the
same exploration governor's remaining file, excerpt-byte, and model-input grants. Each new read
reserves the validated observed file size; each embedding reserves a conservative UTF-8-byte input
token bound and uses the existing gateway spend reservation with exactly-once settlement. Rejected
grants do not charge an attempt or start new refresh I/O. `KEIKO_REPO_SEMANTIC_REFRESH_FILES_MAX`
defaults to zero, invalid explicit values remain zero, and enabled integer values are capped at
eight across the entire logical ask. One request-local document permit counter is shared by every
root lease, semantic lookup and follow-up; failed or cancelled refresh attempts do not reopen it.
Refresh shares the original request signal and remaining deadline, capped again at five
seconds; it never mutates the persisted pod. Selection-details records actual embedding/read
attempt counts separately from byte/input-token upper reservations. Refreshed-file counts include
only usable files retained in the assembled pack; stale retained files receive the canonical
`stale-evidence` marker with a `stale-semantic:` count-only claim and keep current lexical evidence.
Mixed fresh and stale candidates reuse a successful query vector only within the current request,
with the same adapter, query, and validated pod embedding identity. The existing scoped query cache
and identity preflight remain authoritative; a copied request-private observation cannot mutate
their cached vectors. Live document refresh still requires its own read, token, deadline, and spend
admission. Reused query work is not charged as another embedding attempt, and query vectors are
never persisted or logged.
Addressed-file demotion is recorded separately from legitimate unaddressed basename diversity;
an unaddressed collision cannot by itself diagnose a missed explicit target.
The active-intent absolute floor derives from the scoring weight table: ninety percent of a
normalized full lexical hit's provenance and lexical signal contribution. Depth contributes only
above that baseline. The relative floor remains 550 permille of the interpolated 75th percentile
of ordinary candidates, excluding selected/priority/protected paths and flat definition or
canonical-metadata bonuses. Explicit Files scopes retain their no-floor behavior.
Optional reranking receives at most 64 eligible pre-floor candidates and metadata only, before
either relevance cut or excerpt reads. It shares the existing call/time budget and Activity Log;
the assembler does not invoke it again. Provider failure preserves identity ordering and is
recorded as failed, rather than applied. Attempted calls still consume the call grant. An elapsed
deadline stops subsequent reads, including when a late reranker result would otherwise arrive;
identity fallback is pinned on the preselection producer, and orchestration pins enforce no
post-deadline work. For contextual natural-language requests without semantic evidence or an
applied reranker, the ordinary below-floor fallback preserves the first lexical producer's ordering
among eligible content candidates. Each retained position must still match the actual atom's
stable identity, path and query fingerprint. This changes neither relevance scores nor floors,
exclusions, read grants or source authority. Successful reranking retains its own score order.
The first eligible fallback may retain at most two additional eligible sources whose current
same-query content atoms carry the same matched-query-group key. This optional, body-free
peer identity is captured from retained lexical content even when a peer falls outside the
25-entry ranking diagnostic preview. Reported seeds retain their producer priority; supplemental
peers retain their search-result order. Missing/malformed group keys, a different captured query,
absent/replaced atoms and semantic results cannot extend that preview. The diagnostic display
limit is not an evidence-admission limit, and the existing final peer/file/byte grants still apply.
The canonical hexadecimal bitset identifies at least two query groups observed in the admitted lexical range; it does not
certify source authority, factual agreement or answer completeness. Equal numeric scores alone do
not establish group identity. The validated captured atoms must share one query fingerprint before
their positional group keys can grant peers; mixed-query captures retain only the ordinary fallback.
Missing/invalid metadata, a changed atom/query identity, semantic
evidence or successful reranking cannot grant peers. The persistent match identity advances, and
both live and cached lexical producers preserve the bounded key. Exclusions, the absolute and
relative scoring floors, and read/byte/time grants remain unchanged; peers share the existing
below-floor fallback and remain low confidence. A higher-confidence ordinary selection does not
admit them. The existing selected-file count records actual retained size, while
`keepOneFallbackApplied` is true only for a single retained fallback source.
The existing selection-details event records the closed fallback ranking source. Ordinary fallback
records low selection confidence and the
`low-confidence-selection` prompt caveat; high/low is the same closed vocabulary on pack, wire,
and log. Selection-details carries the calibrated floor, confidence, disposition, failed-call,
and safe platform failure evidence. Wire semantic/scope dispositions are actual observations,
including known-fit overflow, and absent observations remain absent. Existing latency ceilings
are unchanged; the only new stage cost is a bounded metadata batch moved before the cut.
When distinct explicit anchors identify different candidate paths, bounded selection
prioritizes coverage of those paths before additional alternatives for an already covered anchor.
Ordinary-folder factual
HTML/text lookups and complete literal absences avoid unrelated code-graph augmentation;
complete typed `exact-symbol` lookups and explicit literal search commands also avoid optional
graph/history work in Git folders, including facts stored in source-code files. Words such as
"exactly" in an explanatory or diagnostic question do not establish that the lookup is complete.
Incomplete lexical evidence and explicitly requested
definitions, relationships, and history retain their existing retrieval and uncertainty behavior.
The existing connected-context completion event partitions planned rings into executed, deliberately
skipped, and stopped-before-execution kinds, including an initially blocked budget. Closed skip
reasons explain policy decisions; augmentation separately records `not-reached`, `used`, or `skipped`.
An overview's additional file listing records `used`, `not-needed`, `skipped-budget`, or
`skipped-stopped` on the same request's source-details event (`not-evaluated` before lexical search).
It reserves and charges its own search call. A refused reservation retains a budget marker; a
deadline or cancellation cannot start another listing. Recoverable term-search incompleteness does
not prevent listing readable siblings. Combined diagnostics preserve both operations' exclusions,
coverage reasons and search-work counts, so an earlier read failure cannot become complete coverage.
These counts describe work across the two searches, not unique files: a path examined by each is
counted twice. Planned rings are never presented as executed work in the diagnostic audit.
Git-history discovery is not dispatched for a folder without Git. Requested definition,
relationship, and history evidence retains its
existing retrieval path and reports genuine unavailability.
Existing path denials, explicit ignore policy, output/model budgets and redaction remain enforced.
Filesystem resource exhaustion remains a technical failure: for example, an installation's
descriptor allowance can constrain deeply nested directory traversal. Directory iterators close on
failure or cancellation; an I/O failure never becomes a complete-search claim or a silent scope cap.

The search match identifies where to read; it is not the entire context for the answer.
Connected-context assembly retains each bounded, actually read surrounding window once,
including function bodies and neighboring calls, and binds its evidence atom to the exact
source lines present in that excerpt. Metadata and listing atoms receive source ranges only
after a real read. Compaction narrows ranges to the lines sent. The default match-only
assembler mode remains available to consumers that require exact match slices. Window mode
participates in the micro-index key, so the two modes cannot reuse incompatible packs.

Assembly compares requested ranges against the compacted bytes actually retained. It reports
missing ranges, truncated windows and incompatible overlapping source views with aggregate counts,
without one prompt marker per file. A clipped trailing newline does not authorize the next unsent
line. Structural edges retain independent identities while a shared source body is compacted and
charged once. The highest-scoring contributing located atom carries that body, so downstream prompt
ranking retains its actual relevance even when a weaker edge arrived first. Unlocated discovery
metadata cannot lend its path score to a separately located source window. The excerpt reader also
orders windows by their actual located owners before spending the accepted byte grant; an unlocated
path score remains the fallback only for a window without a located owner. Definition trace
priority, independently admitted ranges and sole-listing header fallback remain intact.
Metadata-only siblings keep their original scores.
Different view identities merge only when their overlapping source lines agree;
non-overlapping partial views never establish continuity by themselves.

When relevant ordinary sources are available, final context selection omits incidental dependency
lockfiles with the existing `low-relevance` reason instead of appending their bodies after source
files. A shared directory name is not explicit lockfile intent. Named or selected lockfiles,
dependency/version questions, and a relevant lockfile-only fallback remain eligible within their
existing policy and budgets. When concrete sources are addressed, incidental lockfiles must belong
to an ancestor module; explicitly selected lockfiles remain eligible. Dependency/version intent
reuses canonical planner terms, including German. Validated query-origin source selections and
canonical metadata already observed by the current lexical text search can seed ancestor metadata
roots through the existing discovery path, but each added root must pass the
selected-scope and denial predicate before directory IO. All roots share the existing traversal,
deadline and retention controls. Assistant or diagnostic references do not seed those roots.
Filename-discovery atoms, arbitrary JSON bodies and unrelated structural references do not establish
a metadata root. Already observed canonical metadata therefore works in arbitrary nested modules
without a directory-name convention or a missing output test file becoming a source authority.
Classification reuses the workspace ecosystem registry. This selection
rule applies to Git repositories and ordinary folders without applying Git-specific directory
exclusions to ordinary documents. The existing connected-context completion records actual selected
and omitted counts and charged usage; no path or body enters that evidence.

Dependency intent excludes preservation constraints and source data in quoted text, code, paths or
diagnostic frames. A separate affirmative dependency question remains eligible alongside a
constraint, while a negated reporting request does not promote metadata. The planner owns this
predicate and reuses its existing request-command grammar. Explicit canonical dotted metadata and
lockfile basenames are references through the ecosystem registry, not a general JSON-file rule;
existing extensionless selectors retain their meaning. Basename discovery still obeys selected
scope, exclusions, its finite match grant and the shared search/read budgets before source IO.

An affirmative dependency request also remains eligible when the same question primarily routes
as diagnostic search. The existing planner predicate independently signals metadata demand after
question-channel extraction; diagnostic routing keeps its priority. Preservation constraints and
quoted/source data still cannot establish that demand. This reuses the same metadata discovery,
scope, currentness and byte/read grants, with the existing source-details event reporting the
closed metadata-injection reason. It adds no prompt instruction, source hint or model-specific rule.

Canonical omission order and cache identity are independent of caller ordering. A successful
selected-file read replaces an earlier omission for that exact file; invalid parent/child overlaps
still fail validation. Read refusals retain their existing closed policy or budget reason.
Invalid assembly metadata raises a bounded typed validation failure: ordinary Chat fails closed,
while multi-source and hybrid retrieval can retain healthy independent sources and register the
failed source through the existing pack-validation diagnostic. That diagnostic records closed
`validationReasons`, `violationCount`, `validatorThrew`, the sanitized `originalCode`, optional
`sourceIndex`, and `diagnosticOutcome`. A recovered independent source is `source-skipped` at warn;
a failed request is `request-failed` with its HTTP failure status. These fields contain no pack
body, source path, or unbounded validator message. The compatibility match-only mode
remains opt-in; connected-folder production uses surrounding windows. Empty-evidence abstention
retains a single `no-evidence` marker, and budget clipping remains `budget-clipped`.

### D4 — The summary is structurally redaction-free, and we prove it

The wire boundary is asserted by `grounded-qa.redaction.test.ts`: an attacker-controlled
pack with secret-shaped strings (`sk-…`, `ghp_…`, `AKIA…`, `xoxb-…`, `Bearer …`, PEM
blocks) in every string field flows through `runAsk`, and the test asserts:

1. The `contextPack` summary contains none of those shapes (structural — every key is a
   count, enum, or display fingerprint).
2. The `answer.content` and `citations` carry none of those shapes (citations have no
   `content` field; assistant content is sourced from the user's own prompt and the
   orchestrator's content-production rules, not raw pack strings).
3. The one wire-visible string sourced from the pack today — `uncertainty[].claim` — is
   redacted at the BFF boundary before it reaches the wire.

The same route also redacts the user question before constructing the model prompt,
redacts citation path metadata before returning it to the browser, and redacts
assistant content before persisting/displaying it. The context-pack summary remains a
structural redaction contract; the rest of the grounded-answer wire surface is protected
by the BFF redactor as defense in depth. The evidence manifest is deep-redacted before
write, and the connected-context audit section stores hashes instead of raw query/excerpt
text.

If a future change adds a new field to `GroundedAnswer` or
`GroundedAnswerContextPackSummary` that can carry a string sourced from the pack, this
test will catch it.

## Consequences

**Positive**

- Users see observed search/read counts, selected excerpt bytes and actual elapsed time.
  For example: "Searched 3× · Read 5 files · 12,400 / 131,072 B · 1,812 ms".
  Default `null` file/time caps are not rendered as invented numeric denominators;
  explicitly finite caller limits remain visible. These counters describe retrieval
  and selected context, not proof that the entire workspace was sent to the model.
- The wire shape is small (well under 600 bytes serialised — pinned in test).
- The summary's privacy contract is enforced by the type system; string-bearing
  grounded-answer fields are additionally scrubbed by the BFF redactor.
- No new persistent context-pack or micro-index surface, no new redaction family, no
  new DB migration. The new persistent surface is metadata-only evidence in the existing
  ledger.

**Negative**

- The `GroundedAnswerContextPackSummary` name is one character longer than the spec's
  `ConnectedContextPackSummary`. We accept the verbosity in exchange for keeping the
  #178 contract surface stable.
- The BFF redactor only covers known credential-shaped patterns and explicit path/string
  metadata at the grounded-answer boundary. It is not a semantic privacy classifier for
  arbitrary private prose, so users must still avoid putting customer data or credentials
  in chat text.

## References

- Issue #187 — connected context privacy retention & audit controls
- Issue #185 — grounded repository Q&A (introduces `GroundedAnswer`)
- Issue #178 — connected repository context surface (introduces
  `ConnectedContextPack`, `ExplorationUsage`, `ExplorationBudget`)
- Issue #154 — evidence cleanup (future: cascade-delete UX)
- ADR-0010 — evidence ledger schema versioning (the `evidenceSchemaVersion` precedent)
- ADR-0013 — UI persistence (separate concern: chat history)
- ADR-0019 — modular package architecture (the leaf-package rules this contract follows)
- `packages/keiko-contracts/src/bff-wire.ts` — `GroundedAnswerContextPackSummary` +
  `buildGroundedAnswerContextPackSummary` (D2)
- `packages/keiko-server/src/grounded-qa.ts` — `runAsk` wires the summary (D1, D2)
- `packages/keiko-evidence/src/connected-context-evidence.ts` — metadata-only evidence
  manifest builder/persistence (D3.2)
- `packages/keiko-server/src/grounded-context-index.ts` — process-local micro-index
  registry and cleanup helpers (D3.1)
- `packages/keiko-server/src/store-handlers.ts` — chat/project lifecycle cleanup hooks
  (D3.1)
- `packages/keiko-server/src/grounded-qa.redaction.test.ts` — D4 enforcement
- `packages/keiko-ui/src/app/components/desktop/GroundedAnswer.tsx` — `ContextPackSummary`
  presentation
- `docs/connected-context-privacy.md` — user-facing privacy contract

Synthesis accounting refines the two-call rule at the actual attempt boundary: initial answers,
marker repair, follow-up, and context/provider retries share the same turn-owned allowance. The
answer-details sibling records optional `synthesisCallCount`, `completedSynthesisCallCount` and
`synthesisReservedOutputTokens`. Physical synthesis attempts remain separate from completed
responses: overflow, transient and compatibility failures consume attempt and token/spend grants
without incrementing completed-response count. A completed marker repair increments that count
even when its content is rejected; a completed follow-up does likewise. The common grounded
evidence producer receives the completed count for `usageTotals.requestCount` and the human report
(ADR-0010 D7); unchanged callers retain the existing one-request default. The existing factory
ledger owns the lifetime completed counter, per-result deltas and caught-repair recovery.
Input charges use the canonical sent-prompt estimate as a floor and retain larger reported counts.
Reported partial output is charged; an uncertain interrupted stream retains its requested output
upper reservation. A definitive HTTP rejection before generation leaves the spare output grant
available for bounded recovery. These admission charges do not claim exact measured consumption.

OpenAI-compatible adapters invoke the same optional caller admission and durable spend lifecycle
for each physical synthesis HTTP POST, including stream-shape and output-token-field compatibility
fallbacks. This avoids double-reserving the first request at both gateway and adapter boundaries.
Other adapters retain the gateway-owned attempt boundary. Each reservation settles once.
Terminal caller attempt/cap refusals are classified independently of prior compatibility
dispatches and cannot increment the shared provider breaker. Genuine provider errors retain
their existing resilience classification. Caller attempt/cap refusals use the nonretryable
`GATEWAY_ATTEMPT_ADMISSION_DENIED` code and HTTP 403, also preserved in streamed error notices.
The localized request-limit notice does not diagnose context-window overflow or claim exact
unknown output consumption; genuine context-window refusals retain `GATEWAY_CONTEXT_OVERFLOW`.
Prompt fitting retains separate model and remaining caller input caps. Mandatory overhead that
fits the model but exceeds the caller allowance uses the caller refusal; overhead that exceeds
the model retains context-overflow handling. Best-effort citation repair keeps the completed
answer when its remaining input allowance cannot fund the repair. Early
iterator close and aborted reads without terminal usage retain uncertain output exposure.
An acquired caller reservation is also settled when local cap validation or HTTP preparation fails
before fetch; that failure does not claim a provider dispatch or token consumption. Canonical token
preflight rejects cyclic schemas before acquisition. Log-sink exceptions remain isolated by the
existing observability port and do not interrupt healthy dispatch. Durable spend-settlement failure
remains fatal, while a `finally` settles caller usage and output exposure exactly once and releases
transport timers. A dispatched attempt never restores its grants merely because accounting failed.


### Symbol discovery read waves

Current callable discovery, seed observation and target certification reuse the workspace's
existing multi-range excerpt read. A wave groups ranges by source, retains each original
4,096-byte window grant and the same aggregate sum, then revalidates every definition's current
snapshot and existing call/parent certificates before promotion. Range order and evidence bytes
remain unchanged for stable sources. Mutation/cancellation and unavailable sources fail closed.
There is no cross-wave or persistent content cache and no added synthesis attempt or authority.
Physical read-port diagnostics remain separate from unique-file, excerpt-byte and model-token
accounting. Discovery completeness does not establish necessary implementation-window recall.
