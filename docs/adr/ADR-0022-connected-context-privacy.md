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

#### Orientation and evidence admission

An explicitly connected repository or ordinary folder is sufficient scope for a meaningful
orientation or natural-language search request. A filename or symbol is useful for precision,
but is not a prerequisite to inspect the user's accepted root. Empty and punctuation-only
requests still require clarification, and implicit roots retain their narrowing guards.
Repository orientation retains the user's lexical terms and repository semantic provider. Recursive
file discovery is a zero-evidence fallback after a complete term search, within the same search-call
budget, alongside metadata and overview documents; a source-only folder must produce actual source
evidence. A targeted module overview must not be replaced by an unrelated shallow file listing.
Unanchored natural-language questions may additionally use the complete eligible folder text when
the same lexical traversal proves that its actual decoded/redacted bytes and transient evidence
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
Fresh reads reserve each qualified file's observed byte requirement within the aggregate source
budget, and only those qualified paths may exceed the ordinary 8 KiB excerpt window. The pack
cache fingerprints these per-path limits. Once the collector overflows, later files perform no
collector byte-counting or line-counting work. Gateway fitting still enforces the model input
budget independently. Named targets, exact absence checks, diagnostic questions, and relationship/history requests retain their existing routes.
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
bounds. An unlimited default lookup uses the live traversal rather than treating a finite workspace
index as complete coverage. Text files up to and including 2 MiB are eligible regardless of extension;
images, binary content, unsafe aliases, and larger files are excluded. Ordinary folders do not inherit
Git-oriented generated-directory exclusions merely from names such as `build` or `dist`.
Optional structural and Git-history enrichment are separate from lexical coverage. Their planner
slices retain finite scan counts (currently 614 and 307 files respectively) and finite returned
matches; they do not cap the recursive lexical scan. An explicitly finite elapsed budget is sliced
across rings, while the default `null` deadline remains uncapped. Retained lexical matches are
bounded by accepted context capacity independently of corpus traversal.

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
with `io-error` incomplete coverage; they never certify a stable snapshot. Replaced inode/device
identity, unsafe aliases, and root containment changes still fail closed. Secret redaction uses
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
The streamed semantic lane retains the best 32 score/path-ranked documents within its existing
128 KiB text pool. Each document receives a bounded equal share; existing anchored byte windows
retain relevant late content and its actual source-line origin. Neither document selection nor
omission sampling depends on which concurrent read finishes first. Explicit finite query limits remain authoritative. Excerpts
are read in bounded concurrent waves; unused byte grants are recycled after a wave settles, while
the actual accepted byte/token budgets determine which evidence fits. A large matching set therefore
does not force every excerpt to a one-byte allocation. Unread budget tails remain budget omissions.
Selected files retain every distinct, already-admitted evidence range rather than independent
per-file atom or window quotas. The existing safe excerpt reader batches those ranges from one
freshly classified, decoded and redacted file snapshot, preserves original line coordinates, and
charges every returned fragment against the accepted cumulative byte grant. Remaining ranges are
reported when that grant is spent; cancellation or a changed source prevents publication. Global
retained-result and model-context budgets remain authoritative.
Successful primary literal-content matches survive incidental filename/output-count relevance
boosts; vague, diagnostic, relational, and semantic evidence retains ordinary relevance filtering.
A completed eligible scan with only a retained-match limit reports omitted matching evidence,
not unchecked source files. I/O failures, traversal pruning, cancellation, and elapsed limits
continue to report incomplete scope coverage; omitted evidence never proves a fact absent.
Language source inspection is an explicit trusted grounded-caller hint, rather than an automatic
reinterpretation inside shared lexical search. Coding tool and context-provider lexical requests
retain content-match semantics and cannot receive synthetic nonmatching inspection windows.
Direct named implementation and ADR/RFC fact questions use lexical evidence plus the required
filename batches; they do not schedule unrelated graph or history traversal. Explicit relationship,
caller, import, test, integration, history, and diagnostic questions retain their structural routing.
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
The shared size-admitted decoder accepts UTF-8, BOM or recognizable-pattern UTF-16LE/BE, and declared
legacy HTML charsets supported by the platform's fatal `TextDecoder`, including Shift-JIS, Big5,
and ISO-2022-JP. HTML declarations are inspected within the first 1,024 bytes; `http-equiv` charset
parameters are case-insensitive, and standard aliases such as `iso_8859-1` resolve through the platform
decoder. Empty charset values are absent hints, allowing a later supported declaration; nonempty
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
Validated, policy-allowed, redacted relative paths and `size-exceeded` reasons are projected into
the existing model prompt within its input budget. This metadata proves eligibility exclusions
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
for a requested exact occurrence. Internal literal query text and aggregate unique target characters
(including separators) remain within the planner's 4,096-character input envelope; identical targets
are deduplicated before that aggregate check. Invalid input is rejected before needle allocation,
fingerprinting, or filesystem access. This input bound does not limit the recursive corpus.
General natural-language and orientation requests retain their
existing broader retrieval behavior. Literal lookup prioritizes actual lexical
content matches ahead of incidental natural-language path overlap. Files with the same basename
remain independent evidence candidates: their names alone cannot establish duplicate content or
facts. Explicit duplicate hints remain supported, and existing output/context budgets bound retained
evidence. When distinct explicit anchors identify different candidate paths, bounded selection
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
Git-history discovery is not attempted for a folder without Git unless the question requests
history or relationships. Requested definition, relationship, and history evidence retains its
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
charged once. Different view identities merge only when their overlapping source lines agree;
non-overlapping partial views never establish continuity by themselves.

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
