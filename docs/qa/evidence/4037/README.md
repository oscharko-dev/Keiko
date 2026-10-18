# Chat/Files qualification observations

These are bounded body-free observations for #4037/#4040 and #4017–#4021. They do not close
those issues or replace exact-head CI, native browser qualification, semantic review or the
inherited 96-criterion ledger.

- `native-skill-observations-2026-10-18.json` contains 36 case-level records from four declared
  native Gemma batches, including the failed six-case generation batch. Runtime/fixture/skill
  digests, physical-attempt counts, accounting/persistence checks, unchanged generated-test
  hashes and restricted execution outcomes retain their original identities. Later skill
  revisions are not qualified by earlier outputs. A correct-subject failure earns no mutation
  credit. Semantic and customer-profile review is separately pending.
  The original `status` is frozen at generation return; `executionStatus` and the variant records
  describe subsequent execution. The six failed React v4 cases each have zero case-bound answer
  attempts. Their separately recorded setup readiness probe returned HTTP 500; setup waiting is
  not an answer attempt. Failed setup and generation remain in the denominator.
- `symbol-discovery-read-batching.json` compares the actual production retrieval path on the
  same one-file corpus and original question/grants, with no model call. Ordered ranges, byte
  lengths and content hashes agree. Read amplification is corrected. The original mechanical joins retain their
  observed presence/absence; equivalent current implementation ranges may establish the same budget
  facts. Named-function probes alone do not establish semantic recall success or failure. Timing
  under concurrent local work is an observation, not latency qualification.

Raw source/prompt/answer content, provider locations and credentials stay outside the checkout.

`github-pr-lifecycle.json` records a separate native GitHub fixture with the three product job
name/admission expressions copied verbatim. Open and reopened runs publish canonical required
names; closed metadata edits and a rerun of that closed payload skip the jobs without those names.
GitHub labels skipped jobs with their unexpanded name expressions. The initial expectation of
literal inactive labels failed and is retained. These results qualify name/admission semantics,
not the complete product matrix or strict merge-candidate verification. The isolated fixture PR
is closed without merging; product delivery remains governed by PR #4046.

The existing Chat skills lab owns runtime pairing, selected-skill import/accounting, real product
requests and offline execution. Private run receipts preserve failed setup, transport, interrupted
and unavailable-history attempts. Fresh recreated environments never establish a byte-exact
historical replay. Independent reviewer measurements are reported separately in PR #4046.

## Portable update eligibility (#4047)

The customer screenshots establish misleading setup-only update wording. They do not establish
that a newer release exists or identify the customer's installation failure. The startup notice
and update panel now derive update headings from actual availability; setup eligibility remains
a separate state. Native package replacement, restart, browser trust and SSD continuity remain
open acceptance work.

A separate isolated Linux/amd64 container ran the actual published v1.2.3 portable setup and
launcher, using the downloaded archive whose SHA-256 matches the published checksum
(`a3c1220469cfbe934b163063f93479832e64699b53e959a901576e832d11e253`). Its actual BFF reported
package-manager/local-install rather than the managed portable installation. Its existing Activity
Log contained no update classification observation. A bundled candidate detector, run against
those unchanged installed files, recognizes `portable-managed`, target `linux-x64`, version
`1.2.3`, with matching setup/root/launcher identities. This is candidate-engine recognition of a
real released installation, not an updated release or a successful N−1 → N replacement. The
sandbox is emulated Linux/amd64, not native macOS or Windows evidence.

Failure-first owner tests separately establish the missing Linux target/layout and incorrect
macOS system-root classification (5 failures, 35 healthy controls), four missing POSIX identity
refusals after the layout-only correction (4 failures, 40 healthy controls), and two unresolved
system-root aliases after the first classifier correction (2 failures, 39 healthy controls).
The original forbidden alias resolving to the canonical macOS root remains denied. The launcher
and server now share the pure existing-policy classifier, while staging and automatic Coding
discovery reuse the corrected portable layout. Windows bounded-read exceptions and zero-unsafe-read
checks retain their existing semantics. Preflight and session-status owners emit body-free mode,
reason, target and elapsed-time evidence on the existing Activity Log with request correlation.

The first increment's optional translation move was also caught by the existing startup import
boundary in both CI coverage jobs. The exact control reproduced locally before repair. Its
assertions remain unchanged: the existing thin startup controller now loads the view/catalog only
for an admitted visible notice. The original four boundary controls, seven source-freshness
controls, 75 updater presentation tests and complete UI coverage (10,692 passing, one existing
skip) pass on that revision. The original nine-scenario browser producer was repeated with fresh
tracked evidence. An initial local Sonar analysis was invalidated by editing a source while it
ran; it receives no pass credit and is repeated on frozen inputs. Setup/root/launcher attestation I/O errors
propagate through the existing request error/logging path. Explicit missing/symlinked POSIX roots
and missing launcher files produce a closed refusal; the existing Windows bounded-read exceptions
remain unchanged.

The added lazy-view failure control also reproduced a desktop-wide error before local containment
(1 failure, 1 healthy suppressed-current control) using the installed App Router loader. After the
fix the workspace remains mounted, diagnostics contain no raw import error, and the existing
Updates action works. The final owning presentation count is 77 and complete UI coverage is
10,694 passing with one existing skip. Earlier partial/superseded runs remain separate receipts.

## Existing browser-session rotation owner (#4043)

The read-only auditor identified that the existing registry renewed `issuedAtMs` when changing a
secret for the same approved session. Controlled snapshots, cookie repair and a real live-source
subscription reproduced extension beyond the original absolute deadline (3 failures, 21 healthy
channel controls). Direct registry calls also revived idle/absolute-expired authority (2 failures).
An exact copy of the old published HTTP route, isolated with the already-corrected registry,
separately returned a 43,200-second cookie despite only 50 seconds remaining (one clean failure).
An earlier cookie control had a fixture-scoped helper error and receives no product-defect credit.

The registry now preserves original issuance, refuses expired direct rotation, replaces the secret
and operation owner, and limits rotated cookie projections to the original remaining lifetime.
The existing rotation Activity Log event records only that actual duration. Original bearer,
revocation, inactivity, stream and old-operation-release protections remain authoritative. These
owning controls do not qualify remembered browser grants, approval after restart, cross-browser
Draft saving or the complete #4043 acceptance criteria.

The final existing-session folder passes all 163 controls. Independent historical-registry
controls use synthetic records bound to the frozen released registry, not recovered customer logs:
old identified records retain their original field obligations, while a current rotation record
without its required duration is incomplete. The new duration remains required.

## Immediate updater dismissal and source inventories

Four failure-first presentation controls establish that the current button action previously
persisted a dismissal without emitting its transition. The shared dismissal owner now records
the existing body-free `dismissed` presentation immediately, including the local import-failure
fallback. The three owning UI suites pass 80 cases; complete UI coverage passes 10,697 cases with
one existing skip. The original nine-case Chromium producer passes in 1.4 minutes and regenerates
all 17 tracked artifacts. These remain UI and declared BFF recovery-fixture observations.

The immutable `f7c007c8a4b4bf0a2ddf8501894020ec1218bfd4` full quality run retains two failing
source-inventory assertions alongside 55,599 passing and 63 skipped package tests. The chained
UI, scripts and floor stages therefore did not execute in that run. Both failures reproduce
locally before repair. The existing generators add the two new current product modules and
refresh only source-file counts (security 32 → 33; UI 536 → 537); coverage metrics, package floors,
file floors and historical registry bytes are unchanged. Both owning script suites then pass
all 77 controls. Four separately targeted CI timeout-owner files pass 109 controls with 26
explicit skips locally, without changing their bounds. Missing PowerShell remains a platform
limitation, not native Windows acceptance or a reason to discard the earlier CI failures.

## Further bounded regression controls

The actual Linux activation entry and subsequent native-copy preparation independently assumed
macOS paths. Current/candidate files produced through the existing launcher layout expose the first
failure (one Linux failure, one healthy macOS control); real safe native-copy fixtures expose the
second (one Linux failure, fourteen healthy controls). Both now reuse the existing canonical POSIX
activation layout. Four owning suites pass 37 controls. No native child was spawned by these
controls; OS verification, real coordinator acknowledgement, package promotion and restart remain
separate requirements.

A delayed React acknowledgement can leave sent text in the Composer when an admitted clear has
the same empty string as the last rendered snapshot. A controlled parent reproduces this class
before repair (one failure, 58 healthy controls). The existing local mutation revision now binds
local publications and external snapshots. Exact older local acknowledgements preserve new native
input; a new external clear cannot be mistaken for an old empty acknowledgement. An additional
reordered-acknowledgement control found a candidate defect (one failure, 62 healthy controls), which
is corrected by monotonic revision admission. These component controls do not alone identify the
complete historical Firefox CI cause. The existing diagnostic records external resynchronization
without text or revision bodies.

The subsecond session-rotation review case reproduces separately before repair: two failures and
25 healthy controls. The channel now checks the existing full-second cookie bound before replacing
a secret and after minting, revoking an unusable replacement. Exactly one full second and the
ordinary remaining-lifetime controls remain allowed. Session and preflight-activity owners pass
177 controls. The preflight activity declarations share one closed literal target projection,
with executable schema parity controls against the existing canonical target enum.

On immutable `a640886829c66ebe89f297637def3b970fb7db72`, isolated Linux/arm64 with pinned Node
24.18.0, npm 11.16.0 and Playwright 1.63.0 passes the original Firefox Enter case once and twelve
repetitions, and the original WebKit read-metadata case once and six repetitions. The initial
container attempt lacked a package prebuild and receives no product credit; two macOS Firefox
launches failed before test execution at the browser profile. These declared browser/platform
observations do not refute the original Linux CI failures or qualify remembered browser access.

The next candidate passes the complete original `chat-send.smoke.spec.ts` file on isolated
Linux/arm64: Firefox 17/17 and WebKit 17/17, with both process exits zero. The 24 candidate
files are byte-joined before execution; the provider remains the existing synthetic fixture.
Complete UI coverage passes 10,703 cases with one existing skip. Strict root/UI typechecks,
root/UI lint, formatting, architecture checks including negative controls, the Activity Log
implementation gate, ADR/e2e wiring, updater evidence freshness and the real local Sonar analyzer
pass. The final macOS production export measures 348,590 gzip bytes across 22 initial scripts
against the unchanged 349,184-byte ceiling, with no initial Editor/Monaco runtime. This is a
macOS bundle observation, not the authoritative Linux measurement or native update qualification.

## Requested source conventions and native model diagnostics

The unchanged checked-in Spring slice task independently reproduces a missing requested conventions
document. The server owner regression fails before repair and then retains that document and its
actual API names in gateway messages. Positive ordered whole-word source descriptions now supply
observed lexical relevance through the existing matcher, atom provenance and selection owners.
This does not verify organizational approval or turn source prose into authority. Ordinary floors,
scope/deny/freshness rules, physical read completeness and model grants remain unchanged. HTML
inline formatting preserves coherent descriptor text; block boundaries separate spans while
physical source-line coordinates stay intact. Hash-only records cannot certify this witness;
validated same-query match records preserve it after current-file checks.
Three failure-first multiline controls prevent Script/comment/quoted-attribute interiors from
being mistaken for document text. The optional HTML witness and its boost conservatively decline
for such file context; ordinary source search stays available. This is a scoped relevance rule,
not a full HTML rendering claim or a new instruction-authority boundary.

Three source-facet controls fail before correction: output-length and formatting terms pollute
content matching, and complete file paths produce unrelated component terms. The planner and
workspace now share the existing presentation/path grammar. Complete paths retain a separate
bounded ranking signal. A frozen revision-six compiled producer's formatting-only positive also
reproduces a stale-cache failure when its query identity is reused. The new matching revision
forces a reread and then permits unchanged warm reuse. Earlier private candidate path-ranking and
named-file continuation regressions remain recorded; their unchanged owning controls pass after
repair. Independent adversarial checks additionally find and verify repairs for repeated
attribution and long-whitespace parser costs. These are specific bounded work observations, not
a general performance qualification or acceptance of all language variants.
The existing correlated source-details event now records a bounded certified-descriptor path count.
Two failure-first emitted-event controls assert the positive/negated counts and registered persisted
line shape, without source text or paths. No additional diagnostic stream is introduced.

A separately frozen 22-file private candidate runs the original question through native Gemma with
the unchanged 118,784 input and 8,192 physical-output grants. The selected Java skill returns eight
citations in one attempt; the unselected control returns zero citations in two attempts. Both
observe the required MockitoBean API identifier in the actual provider payload, preserve exact
published answer bytes and satisfy the declared context/accounting observations. This witness is
one identifier, not a whole-document completeness claim. The controls have no matched customer
profile, so these observations do not establish profile superiority.
Provider/transport limits for this diagnostic are 300,000/900,000 ms with one provider retry;
this is not a replay of the longer historical provider/transport configuration.

Both unchanged returned Java files fail baseline compilation in the existing isolated offline
verifier. The selected answer still uses an obsolete WebMvcTest import and an unavailable JSON
mapper; the control invents a different WebMvcTest package. All six execution fixture files agree
with the supplied fixture, and output hashes/sizes are verified before extraction. Neither run
earns executed-test or mutant credit. The generic Java skill now explicitly requires copying
documented fully qualified API names and avoiding unnecessary mapper dependencies; its new native
diagnostic remains separate from final qualification. No version-specific answer is inserted into
the skill or the original task.
Its next single selected diagnostic removes the unnecessary mapper but still fails compilation on
the obsolete WebMvcTest import. The first witness established only MockitoBean arrival. A bounded
per-marker digest/presence observer now checks both documented API names separately without
retaining provider text; the earlier one-marker observations remain unchanged. Its next diagnostic
confirms both names on the single actual provider request, but the unchanged returned file still
fails compilation on the old MVC import and an invented Mockito method. No executed-test or
mutant credit follows from those source-presence observations.

The full quality run on immutable prior head `a640886829c66ebe89f297637def3b970fb7db72` completes
with 73,658 passing tests and 91 declared skips across package/UI/script stages. All 27 package
metric floors, 73 governed file floors and both release targets pass. This is historical evidence
for that head, not a full-quality verdict for subsequent candidates.

The final source-conventions candidate passes all 2,714 workspace cases, 1,448 workflow cases,
32 source-selection/logging cases and complete UI coverage (10,703 passing, one existing skip).
The full Activity Log aggregate and real local Sonar pass. The assembled public package surface
passes with 6,352 files after its producer records the eight shared grammar exports; dependencies
are restored afterwards and the lockfile stays unchanged. Editor isolation, release evidence,
updater evidence freshness, ADR index and e2e wiring also pass. Earlier relative-timing failures
in the unchanged line-selection benchmark remain recorded; its targeted owner and final complete
workspace run pass without changing the bound.

The prior published head's CI remains distinct: SonarCloud flags a positive presence assertion
using `queryByText`; the candidate uses `getByText` and its owning control passes. One macOS Intel
native-service readiness run exceeds its unchanged ten-second bound while a separate run on the
same head passes. A WebKit smoke run also fails the Files root-navigation case. These observations
are retained as unresolved platform/journey evidence, not erased by healthy runs on other engines
or platforms. Native package replacement and both customer skill qualifications remain open.
