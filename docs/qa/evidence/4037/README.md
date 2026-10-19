# Chat/Files qualification observations

## Checkpoint 37: positive owned-child retirement and a precise scanner disposition

The macOS supervisor previously ignored the result of waiting for its owned root after a monitor
zero-live reply. It could publish a reaped proof after ECHILD, an interruption or a nonterminal
status. The same cleanup path could wait without a bound. It now requires the exact child and a
terminal status before the original monotonic wait deadline, with no renewal on interruption.
Failure retains the existing protocol observation error; a monitor reply alone earns no proof.
The wait consumes the stored child identity before later deadline or response validation. Main
cleanup therefore never signals a reaped or unknown PID. Still-owned children retain cleanup.

Twelve initial actual-source controls reproduce eight failures/four healthy cases before repair
and twelve passes afterwards. Three additional real-kernel controls cover exit, signal termination
and an already-reaped child. The expanded retained-source replay has nine failures/six healthy
controls. Nine actual-main cleanup controls additionally reproduce five failures/four healthy
cases on the retained intermediate source and nine passes after the ownership repair. The POSIX
coordinator applies the same invariant at its stop, failed-start, reconciliation and monitor-probe
callers. Its probe reuses the shared bounded wait and cleanup rather than an unbounded second loop.
Twenty-one actual reconciliation/probe controls have eleven failures/ten healthy cases on the
original complete coordinator header and twenty-one passes after repair; eleven additional wait
controls pass. The full affected matrix passes all fifty-six cases on macOS ARM64 and Linux ARM64.
The Linux run
compiles the actual portable POSIX code and uses inert monitor responses; it does not qualify the
macOS Endpoint Security extension or Linux product-generation ownership. Three controls use real
kernel-owned children; the remaining external monitor/spawn/time/signal ports are inert. The native
macOS ARM64 compiler, analyzer and boundary checks also pass. The first Linux harness
attempt could not execute its binary on the default non-executable tmpfs; that attempt is retained.

The pinned secret scanner also reproduces one finding in published checkpoint 36. It mistakes the
verified public key-store source digest for an API key. The disposition requires the exact known
digest, complete field line, anchored evidence path and original rule together. No arbitrary hash,
credential, file or commit is exempt. The unchanged historical range then passes; nine actual-scanner
controls continue detecting other digests, fields, paths, additional credential-shaped content and
another rule. A first candidate missed the scanner's leading newline and remained red; the final
line grammar and its sensitivity control retain that failure. Detailed source and scope bindings
are in `native-owned-child-reap.json`.

These are bounded repairs. The native generation/real update, skill, full browser/search, source,
exact-head and integration requirements remain open.

## Checkpoint 36: explicit browser connection and honest persistent trust

The desktop now offers an explicit browser connection request. A connected browser compares its
code in Settings → Security and approves one session or an explicitly requested remembered
connection. Remembering defaults off. The same surface displays expiry and last use, revokes
server approvals and separately forgets this profile's remembered connection. Neither an
acknowledgement nor local key metadata establishes authentication: fresh protected inspection
checks usable access. A lost proof response can recover an existing session after the original
request deadline without issuing another challenge or grant, while persistence remains unconfirmed.

The existing fifteen-second confirmation signal also bounds optional restoration. Cancellation
prevents late proof dispatch and UI publication. Closed lifecycle evidence uses the existing
diagnostic transport and Activity Log. Three missing static route literals are added without
changing unknown-segment privacy or the exact declared-vocabulary tests.

Actual Chromium and WebKit on macOS ARM64 and Firefox in isolated Linux ARM64 each retain a
nonextractable key across browser process restart and independently verify its signature. A real
transaction aborted after put success refuses the save and never records a stored outcome. These
are storage-owner controls, not complete protected approval/draft/SSD journeys or native Safari
acceptance. Earlier fixture/browser-start failures remain retained. The five affected server and
contract suites pass 634 tests. The full UI follow-up passes 10774 tests with one existing skip,
including nineteen deterministic storage lifetime controls. The unchanged original updater
browser producer passes all nine cases and regenerates its existing evidence.
`browser-approval-client.json` binds sources, failure-first observations and these scope limits.

The first private storage harness read the wrong diagnostic metadata path. Its negative telemetry
assertion was vacuous. The original harness and receipts remain retained; the corrected actual
browser runs require a successful-commit positive control before the aborted-put negative. No
historical telemetry credit is reassigned. The corrected Windows CI owner suite also passes all
68 cases on head 35; native generation ownership and complete updater acceptance remain separate.

A real two-page race also reproduces a delayed completion recreating a locally forgotten key.
The same object store now commits a persistence intent before the public request and compares it
inside the key-write transaction; forgetting removes both atomically. The identical original
four-case browser harness changes from one failure/three healthy controls to four passes. The
expanded current-source matrix passes nine cases in each of Chromium, WebKit and Firefox, including
fresh/superseded intent and failed-forget rollback. A genuine engine structured-clone exception at
the storage port is contained rather than escaping its asynchronous callback; a retained compiled
owner has one failure/eight healthy controls, then the repaired owner has nine passes. The global
error listener is calibrated with an actual scheduled throw. These remain storage-owner proofs
with inert authority responses. Five separate Notice lifecycle tests preserve fresh protected
inspection after self-revoke, repair and focus without weakening the existing grounding assertions.

The frozen V7 Gemma feedback campaign also terminates unsuccessfully. Four cases were dispatched;
seven observed phases satisfy their measurement contracts, but none passes the correct application
and no mutation trial is eligible. The fourth case's feedback exhausts its output allocation;
the declared stop rule leaves two cases undispatched. All 35 physical records remain retained,
including the failed case's costs. The terminal archive and all frozen source/input identities
remain unchanged. `react-feedback-v7.json` records this failed result without repaired outputs,
recredit, held-out or skill-benefit claims. Both customer skills remain unaccepted. A separate prospective compatibility probe passes
its plain Gateway control, then the served model path rejects the first strict JSON-schema
request with HTTP 501. The third declared case is not dispatched under its stop rule. A
`response_format` metadata entry is insufficient to enable schema support; no capability, skill
or V7 input is changed. The failed local zero-dispatch harness attempt is retained separately.

Native updater generation ownership and packaged update journeys, full browser and Chat/search
criteria, the original source criteria, final required checks/reviews and authorized integration
remain open.

These are bounded body-free observations for #4037/#4040 and #4017–#4021. They do not close
those issues or replace exact-head CI, native browser qualification, semantic review or the
inherited 96-criterion ledger.

`acceptance-current.json` maps the 34 explicit criteria in the current ten issue bodies to their
remaining proof obligations. Every source-body digest is checked against GitHub. This dated
addendum preserves the original 96 IDs and exact original ledger bytes; historical supported
records are not reclassified as current acceptance. Bounded implementation proofs below do not
replace the native/browser, generated-test, final-head or integration obligations in that mapping.

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

## POSIX recovery registration bindings

The next updater increment reproduces 21 invalid POSIX registration acceptances with three healthy
controls across Linux x64 and both macOS targets. Current setup/launcher byte drift, hard links,
symlinks and a newly recorded wrong-target setup were not revalidated. Recovery now reuses the
existing bounded active-install binding owner for all targets. Healthy production/normal-startup
fixtures use the actual registration producer and synthetic, non-executed native bytes; no healthy
assertion is relaxed. The five owning suites pass 92 cases. A separate failure-first normal-startup
case previously settled an invalid launcher binding as normal; it now retains the WAL, avoids
native execution and emits the existing correlated registered recovery-required proof. This is
binding qualification, not installed native update or supervisor acceptance.

The auditor additionally reproduces FIFO hangs before descriptor validation. Nine causal
subprocess controls fail before repair across all three POSIX targets and registration/setup/launcher
positions, each with a reachable healthy child control and externally bounded cleanup. The owning
reader now opens nonblocking before its existing regular-file validation. The control on Windows
is explicitly skipped because it exercises POSIX FIFOs; no product or existing test timeout changes.

The complete immutable `6e8fcb191bf7d2c801134e756e231deede3593dc` Linux/arm64 WebKit smoke passes
all 110 unchanged cases in 9.9 minutes with exit zero. The earlier 6 GiB container attempt ends
with exit 137 and a Docker OOM event; that failed receipt remains retained. The successful run
uses 12 GiB, pinned Node 24.18.0/Playwright, an explicit container user identity and the exact Git
metadata. No test source, timeout or numerical product gate changes. This does not identify the
cause of the retained earlier CI tree-intake timeout or establish Safari OS integration.

One further private generic evidence-checklist skill diagnostic on the same published runtime
preserves the original task and fixture, both actual API-name witnesses and returned output bytes.
It removes the invented mock-factory call in that observation but still uses the obsolete MVC
import and fails baseline compilation. It earns no execution or mutation credit, and the
unsuccessful paragraph is not promoted into the customer skill. A separate local Gemma review
of the generic instruction failure is advisory only.

The original published-head package coverage shard then finds three unchanged ring-decision
Activity Log failures. They reproduce locally as three failures with nine healthy controls: the
descriptor count raised source-details to 49 contextual fields against the unchanged 48-field cap.
The counter moves to a small typed, correlated evidence-details sibling on the existing Activity
Log. The original source row, formatter, cap and canonical-line assertions stay intact; no event
is silently truncated and no existing observation is discarded. The source-conventions controls
now prove the counter on that registered sibling with the same positive/negated expectations.
The complete prior-head `6e8fcb191bf7d2c801134e756e231deede3593dc` package-coverage run retains
55,701 passing tests, eleven failures and 63 declared skips. Failures belong to ring decisions,
metadata failure evidence and native HTTP log validation. Its UI/script/floor stages do not run
after that failed package stage; it is not a completed full-quality success. The new sibling is
also included in exact lifecycle ordering/count checks and real persisted-line validation;
all original completion/source/selection rows retain their previous relative order and fields.
Two further failure-first work controls reproduce repeated normalization of the same eligible
source line for several descriptors, in both case modes. Matching now normalizes each eligible
line once and declines an empty descriptor set immediately; Unicode, negation, coherent-line and
case semantics retain their original controls. This measures primitive work, not broad latency.

## Citation repair token boundaries

The auditor independently identifies literal and JSON citation insertions that split contractions
or compound operators despite reconstructing the original bytes after marker removal. Twenty-four
owning before-fix failures preserve ten healthy complete-claim controls. The existing boundary owner
now protects internal apostrophes and contiguous symbolic operators in both protocols; original
Unicode, code, evidence-range, assessment and budget guards remain binding. The real loopback HTTP
path also retains the original answer, uncited warning, exact persisted representation and existing
correlated repair-refusal evidence. These are controlled provider responses, not native Gemma
semantic acceptance.

Two additional private original-task Java diagnostics, using a generic literal-import example and
direct fully-qualified annotation instruction respectively, still produce the obsolete annotation
import and fail the unchanged offline baseline. Their exact outputs remain retained and earn no
execution or mutant credit. Neither unsuccessful instruction is promoted into the customer skill.

## Handoff reader and directory blocking

The existing digest reader separately reproduces one FIFO hang with six healthy controls. Twelve
further subprocess cases exercise native coordinator/supervisor copies for both POSIX layouts,
plan/receipt/verified-acknowledgement replacement at the actual open boundary, existing direct-FIFO
refusals and directory sync. After canonicalizing the fixture root, nine hang before correction
and three existing refusals remain healthy; an earlier fixture alias mismatch is retained without
product-failure credit. Every child first proves a reachable healthy producer/read path. Native
copy controls stop at the existing persistence callback and cannot spawn native code.

All six file-read opens now use nonblocking descriptors while retaining existing type/link/hash,
identity and byte checks. Native copy durability reuses the existing shared directory-sync owner;
its descriptor must be a real directory and cannot block on FIFO replacement. Exclusive writes
and the Windows unsupported-sync controls retain their existing behavior. Synthetic registration,
plan and copied-file controls are not a successful installed update or supervisor qualification.

The original-skill prefix/suffix diagnostic pair retains both failed baseline compilations. Actual
wire observations show the selected skill exactly once at user level and no request sampling
overrides; both calls report reasoning usage. The suffix also changes latest-task emphasis, so it
does not isolate evidence distance. A distinct temperature-zero diagnostic uses the original skill
and task but exhausts the unchanged 8,192-token physical-output grant, returning no complete product
answer. It is an output-exhaustion failure, not a compiler failure or an omitted case. No placement,
sampling or unsuccessful skill variation is promoted into the customer implementation.

The immutable `8f00034c9c7dfc13de17fa6a9cdf3503641dfe5c` full-quality attempt completes its package
stage with 55,746 passing tests, four failures and 61 declared skips. Three failures expose stale
five-event denial-owner expectations after the new evidence sibling. Their exact six-event
contract now also checks the registered sibling, original identities and unavailable zero-read
state; original root-admission and denial assertions remain intact. The fourth failure is a
qualification invocation error: the wrapper omitted the pinned PATH and used Node 24.22.0/npm
11.19.1. The exact toolchain gate rejects that pair and accepts pinned Node 24.18.0/npm 11.16.0.
This does not establish a debug-launch product defect. The failed receipt remains retained;
downstream UI/script/floor stages did not run, and a correctly pinned complete rerun is required.

## Current installation binding before handoff preparation

Ten failure-first controls reach a healthy copy/verification path and then demonstrate that changed,
missing or hard-linked setup files, or changed/missing registration files, were accepted during
preparation for both POSIX layouts. Fifteen original coordinator controls remain healthy before
the correction. The existing active-registration owner now revalidates the accepted plan's exact
registration digest, current target/version, real root, setup and launcher before copying current
native executables, verifying their OS identities or publishing prepared intent. Refusals use the
existing preparation failure path; no execution or signature exception is introduced.

POSIX and Windows coordinator fixtures obtain registration bytes from the existing production
producer. Windows capsule controls still require exact source-to-copy setup and registration bytes,
and retain their stale, replaced and hard-link refusals. This prerequisite does not authenticate a
supervisor from a self-observed hash, implement Linux process containment, admit unsigned native
copies or qualify a complete installed update/restart.

The checkpoint-16 UI coverage job retains one close-preview/root-refresh failure. Its unchanged
owning suite and complete UI coverage pass locally; those runs do not refute CI. A new controlled
read-order test separately proves that the refresh fixture could consume its hold flag for a read
already started before the flag was armed (one failure, fifteen healthy controls). The fixture now
captures ownership at request entry and explicitly awaits initial root-read readiness before the
selection-change case. All sixteen owning controls pass; the original stale-selection and exact
active-directory assertions remain intact. This is a fixture-ordering correction, not a new claim
of native browser or current-head CI completion.

## Unknown macOS monitor state is not an empty-tree proof

An independently compiled projection of the actual monitor refusal branch returns ZERO_LIVE for an
unknown handle, including state unavailable after monitor restart. The extracted production reply
owner preserves that behavior before the correction; its new compiled control fails while all
twenty-three existing manager/monitor contract controls remain healthy. Unknown and non-owner
handles now retain the same closed refusal, and an already live owner retains its separate reply.
No wire value changes and no new native trust or execution exception are introduced.

These are actual C reply-policy and source-join controls with inert ports. They do not establish
Endpoint Security service availability, durable process absence after daemon failure, safe live
generation transfer or a successful sequence of two installed updates. Those native proof and
implementation obligations remain open.

## Checkpoint 19: pairing clock safety and unaccepted Java skill comparison

The pairing port's bounded consumed-request cache must not make an expired claim reusable after
a wall-clock correction. An owning actual-channel/registry control reproduces a second session
after prune and rewind, and an invalid positive-infinite clock independently evicts replay state.
Both fail before the fix; fifteen controls remain healthy. The existing port now refuses invalid
or decreasing observed time before pruning. Equal/increasing time, inclusive freshness, finite
capacity recovery, HMAC authority and existing sessions retain their policies. New pairing can be
temporarily unavailable after a forward jump is corrected, until time catches up. Existing
count-only pairing-denial diagnostics cover this refusal without publishing claim or clock data.
All thirteen app-session suites pass 171 tests locally; this is not remembered-browser acceptance.

The observations JSON adds all twelve original reservation-service cases, independently joined
to exact returned outputs, unchanged test files and 78 actual Surefire reports. Correct-subject
execution is **selected skill 5/6 versus matched controls 6/6**. The failed selected GWT repetition2
contains a blank CSV record; selected AAA repetition1 violates all eleven camelCase method names.
The planned mutation denominators remain 36 per group: the five eligible selected outputs detect
30/30 executed mutants, while controls detect 35/36. The failed correct subject has no mutant
credit. These numbers do not establish skill superiority or full requirement/profile acceptance.
The six declared mutants contain no rounding-mode change, and independent rounding coverage is
not qualified. The last GWT control uses two physical calls within its original cumulative 8192
output grant; no actual compaction is observed. Missing historical replay remains missing.

A longer Java diagnostic variation added technical parameter-source and rounding instructions.
The owner clarified that the customer skills must remain compact method/convention profiles;
that variation was stopped with four terminal outputs, one cancelled in flight and seven undispatched
cases out of twelve planned. It is not a completed comparison or a customer-skill candidate.
The cancellation and missing final accounting remain explicit; the outputs are not rewritten.

Both current customer candidates retain the editable naming/structure/assertion/mock/mandatory-case
profile and general test-design/delivery checks. Detailed API recipes and executable helper snippets
were removed. This follows #4037's explicit two-compact-skills outcome and the owner's clarified
scope. The independent auditor reviewed the exact Java44-line and React46-line scope; that review
is not functional acceptance. The original and diagnostic outputs cannot qualify these changed
skill bytes. Matched native comparisons and untouched heldout execution remain required.

A separately predeclared exploratory HALF_UP-to-DOWN check leaves all eleven eligible original
model outputs green: none detects this required rounding error. The failed correct subject is
excluded, and the frozen six-mutant score is unchanged. A separate manual oracle extended with
one literal tie example passes 18 tests on the correct source and fails on DOWN. HALF_EVEN remains
indistinguishable within this fixture's accepted price/input domain; no out-of-domain example is
invented. This manually validated sensitivity is not model or skill credit.

The updater FIFO reader fixture now matches each actual refusal owner: exact plan/receipt/source
errors, registration refusal before coordinator copying, direct directory ENOTDIR/open, or the
existing copy-directory cleanup aggregate with ENOTDIR/lstat causes. Arbitrary errors and false
returns no longer count as successful FIFO refusals. Two injected unrelated-open controls fail
before this tightening while thirteen healthy/FIFO controls pass; all fifteen pass after it.
Native execution remains forbidden. The directory-race control additionally reaches the actual
open boundary; the copy cleanup aggregate is verified rather than mistaken for a direct error.

## Checkpoint 20: monitor event continuity owns empty-tree proof authority

An independent audit and a whole-source owning control reproduce a false empty-tree proof after
a missed descendant event. The new fixture compiles the actual monitor against the installed
macOS SDK using compiler arguments obtained from the existing release builder. Its transport,
signal, logging and Endpoint Security initialization ports are inert; no real client, kernel event
loss or process teardown is exercised. The original owner has seven failing policy cases and two
healthy controls, including message-version-four/counter-zero and version-five/arbitrary-origin
streams. The counterexample includes exit, stop and disconnect, so fixing one reply site is
insufficient.

The existing monitor now establishes a baseline before ARM, checks version-gated global sequence
continuity, and irrevocably refuses empty-tree proofs after loss. A central reply guard covers all
zero-live sites; startup preserves an already observed failure. Existing count-only diagnostics
record the failure once, and unrelated exec requests remain allowed by the existing policy.
The owning fixture checks skipped, duplicate, backward and overflowing counters, unavailable fields,
missing initial baseline and startup failure. Healthy controls retain their zero-live proof and
all fixture signal counts remain zero. This repairs observation integrity only; signed native
execution, durable recovery, authenticated generation transfer and consecutive updates remain open.

## Checkpoint 21: pending lifecycle ownership and process-generation-safe signals

A whole-source fixture compiles the actual monitor with the existing production builder's compiler
arguments and unchanged protocol header. Its identical final bytes produce twenty failures and
eleven healthy controls on published checkpoint20, then pass all31 controls on the candidate.
Synthetic, ordered Endpoint Security events and inert external ports isolate the owning lifecycle;
these controls do not claim an entitled client, real kernel queue delivery or a complete update.

Stop before the first delivered fork no longer certifies an empty tree. Disconnect retains pending
ownership, late descendants remain tracked, and a closed session is retired only after the actual
matching supervisor exit and all observed descendants exit. A failed spawn with no child releases
its slot after the actual supervisor exit; seventeen successive cycles verify bounded capacity.
Process membership and all three signaling paths retain copied audit tokens. PID plus PID version
prevents a recycled numeric PID from inheriting ownership or receiving an old session's signal.
NOTIFY_EXEC updates the pre-exec identity to its actual post-exec target. A stale-token ESRCH never
counts as an exit; a queued exec notification can supply the current owned identity and retry stop.
Other signal refusals block proof and emit the existing native body-free diagnostic. The inventory
limit retains its refusal and token-bound fan-out. An already owned descendant cannot arm a second
session; authenticated generation transfer remains unimplemented.

One additional compatibility control actually forks its own child, receives that child's kernel
Mach task audit token, verifies correct-token SIGCONT success and wrong-version refusal, terminates
only that child through the token-bound SIGKILL, and awaits its actual signaled exit. A stale token
then refuses. This passes on macOS27.0.1/build26A434 with SDK27.0 and does not qualify older platforms.
The first private probe used unsupported signal0 and is retained as a fixture error, not a product
failure. libproc declares this signaling interface private/SPI; no public stability promise or
numeric fallback is inferred. LOCAL_PEERTOKEN is a current-PID lookup, not an immutable socket-owner
certificate. Full peer-lifetime authentication, native generation transfer, durable recovery, Linux
supervision and consecutive real updates remain open.

The compact-skill Java comparison on immutable published19 has finished all twelve predeclared
cases and 82 actual Surefire reports. Selected and control arms each pass five of six correct
applications; each detects all 30 executed original mutants of 36 planned. Each misses all five
executed DOWN rounding mutants of six planned. Selected GWT outputs and one control AAA output
also violate explicit naming conventions. All fourteen physical answer calls carry the canonical
complete service and all seven complete requirement spans, within the original cumulative grants.
Missing source context is therefore not an explanation for these failures. This known-fixture
regression is neither a new untouched heldout nor evidence of skill superiority or acceptance.

Fresh React manual-oracle source, type-check and actual JSON-report joins are retained. Independent
review found that the existing JSON-reporter/verifier path does not observe global unhandled errors
and can misclassify runtime-only failures as defect detection. The initial private classifier also
rejects legitimate Testing Library/jest-dom assertion failures. Those measurement defects remain
open in the existing verification owner; no model dispatch or clean-runtime qualification is
claimed from absent JSON fields. No additional customer prompt rules are added.

## Checkpoint 22: observe actual test failures before assigning qualification credit

The existing generated-test verifier defaulted an absent runtime-error counter to zero. The pinned
Vitest JSON reporter does not emit that field and omits its global unhandled-error argument. A
runtime-only failure, an assertion plus an unrelated global error, or inverted expected-failure
semantics could therefore receive defect-detection credit. The identical final entrypoint controls
run against the actual published parent and candidate with inert Docker ports: seventeen failures
and one healthy control before, then eighteen passes after. Source hashes and actual receipts are
recorded in `generated-test-verification.json`.

The existing JSON reporter is extended through the pinned public `vitest/node` API. Its actual
run-end and test-case observations supply error, collection, option and completion counts without
copying the runner's execution logic. Missing observations remain unknown. The verifier cross-checks
actual case inventory and totals, requires a completely clean correct-subject run, and accepts a
mutation only with recognized assertion failures and no runtime/global/collection/unclassified
failure. Plain Error is not automatically an assertion. Pinned matcher metadata handles both
positive and negated jest-dom assertions; Testing Library query failures retain their framework
origin. A mixed assertion/runtime failure remains a runtime failure. `allowOnly:false` refuses
focus before the runner normalizes it away. Skips, expected failures, configured retries, repeats,
missing diagnostics and interrupted runs cannot earn credit. An invalid baseline dispatches no
mutant. Existing offline, read-only, unprivileged container limits remain; future runs use the
already measured immutable Node image digest instead of the historical mutable tag.

Eighteen actual offline Vitest controls validate six legitimate clean/pass/assertion/query/matcher
cases and twelve refusal cases. The actual public verifier additionally executes a trusted manual
three-test control: correct application 3/3, declared mutant: 2 recognized assertion failures, strict
types and explicitly observed zero runtime/global errors. These measurements are independent of
model output and do not establish resistance to an intentionally malicious test runner.

Re-executing the unchanged React manual oracle with the new observer exposes one previously
unobserved global error on its fractional-input mutant. Its invalid-input reserve double returned
undefined despite its declared Promise contract. That replay receives no credit and remains
retained. A separate manual oracle version adds exactly the missing Promise implementation;
all 13 tests, eight predeclared mutations and model-supplied source bytes stay unchanged. The new
actual strict-type/container/JSON/lifecycle campaign passes 13/13 on the correct subject and detects
all eight independent defects with explicitly observed zero other errors. The independent auditor
joins every source, test and report digest. The original oracle and prior failed measurements are
not overwritten; no model answer is repaired or regraded.

This change is model-agnostic verification tooling. No provider, customer prompt or customer skill
is specialized for Gemma or this fixture. Known regressions remain separate from untouched heldout
model tasks. Native model dispatch and customer-skill acceptance remain outstanding.

## Checkpoint 23: omit empty deduplication frames from grounded prompts

The existing assembler legitimately retains distinct reference-edge observations as metadata aliases
when their source window already has a body. The shared single-source, multi-source and hybrid
renderer nevertheless repeated an evidence header, provenance line and empty fence for each alias.
The production reference counter already excluded those zero-length bodies. A two-line local
filter aligns presentation with that boundary without removing metadata or changing selection.
Nonempty whitespace lines and document labels/bodies remain intact.

The identical final seven controls produce five failures and two healthy controls on published checkpoint 22,
then seven passes after. The actual fresh React corpus is retrieved once and passed to both final
protected-skill fitters with the actual configured model-profile accounting: 19,298 to 14,170 UTF-8
prompt bytes, and 6,350 to 4,641 accounted input tokens. The input grant stays 118,784. All positive
bodies and retained packs are byte-identical; the complete component and eight complete accepted
requirements remain present, and the selected skill occurs exactly once. All 38 metadata aliases
remain in the pack. This is a measured serialization saving, not an inference-quality or latency
claim. Existing final-prompt and gateway cost/reference observations describe the result.

Source digests, causal runs and body-free final-fitting observations are recorded in
`empty-evidence-serialization.json`. The next native comparison freezes this revised pipeline;
its scores must not be pooled with the older immutable19 campaign as identical inputs. Customer
skills, prompt instructions, provider selection, source reads and cumulative grants are unchanged.
The broader platform, browser, model-quality, historical and exact-head acceptance holds remain.

The published checkpoint 22 Core quality run exposed an unlisted transitive test import of the actual Vitest
error serializer. The same `check:knip` failure is reproduced locally. The serializer is now an
explicit test-only dependency at its already resolved 4.1.11 version. No resolved package changes,
test assertions or dead-code exceptions are introduced; the dependency disposition is recorded in
the existing closeout table.

## Checkpoint 24: coherent native identity and bounded first-frame admission

The monitor checked a numeric PID's signing identity, then separately looked up an audit token for
session ownership. A changed generation could be allocated under an earlier signing decision. Its
five-second socket timeout was also an inactivity timer, not a total frame deadline: a peer could
keep a partial read alive by sending individual bytes.

The final whole-source fixture executes actual admission, code checks, deadline and allocation with
only external framework/socket/clock/log ports made inert. The same final 15 controls produce seven
failures and eight healthy controls on published checkpoint 23, then 15 passes after. The counts include mechanism
and new clock-failure refusal checks; they are not distinct bug counts. A one-byte/every-four-second
virtual stream completes after 176 simulated seconds before and refuses at five simulated seconds
after. No live resource exhaustion or wall-clock performance claim is inferred. The original 31
lifecycle/signaling controls retain their assertions through the internal allocation argument update.

Independent review rejected an initial unpublished candidate because it moved all code verification
after the first blocking read. Its sources, tests, successful local gates and Sonar receipt remain
retained as that withdrawn candidate, and do not qualify the corrected source. The strengthened final
controls also fail that candidate. No affected candidate was pushed.

Final admission captures one credential-checked token and uses its exact 32-byte CFData with the
public Security guest API. The code/team preflight rejects invalid peers before any frame wait;
that decision cannot grant allocation. After the complete bounded frame, the same captured token
is checked again and passed to allocation without another token or numeric code lookup. A monotonic
absolute deadline plus poll and nonblocking receives bound the first frame, including fragments,
interruptions and would-block retries. Existing connection limits, ownership/event-continuity gates,
long-lived post-handshake control reads and body-free rejection diagnostics remain authoritative.
All fixture connections release their slot.

One actual own-process Mach audit-token control calls the original Security framework API: correct
token locates code, changed PID version refuses, and the correct token still locates code. It passes
on the recorded host/SDK; it does not certify the complete signed ES path or older OS versions.
`native-code-identity.json` records source identities and all three body-free causal runs.

This fixes coherent identity admission and total first-frame waiting. LOCAL_PEERTOKEN still does not
prove the immutable original socket writer. Full peer lifetime, functional generation transfer,
durable monitor-loss recovery, Linux support and consecutive actual updates remain separate open
requirements. No native wire layout, signing requirement or runtime authority is widened.

## Checkpoint 25: verify each voice/composer turn against its actual provider wire

The exact published-23 UI failure compared input costs from two different prompts. Retrieval timing
is serialized into those prompts, so equal source results do not imply equal canonical input cost.
The existing semantic, source, citation-range and resource-grant equality checks remain. Each turn
now independently joins its persisted estimate, measured provider usage and charged input/output to
its one actual grounded provider request. Actual model identity and the single request output cap
are bound to the fixture profile. The existing gateway counter and synthesis-usage producer own the
calculations; no production accounting formula, prompt or authority changes.

The bounded provider witness and successful browser attachments retain counts, hashes and grants.
The witness explicitly refuses richer message/tool/schema shapes and uses the existing uncalibrated
text-only fixture. Eight owning helper controls pass. The actual unchanged spec helpers additionally
pass 26 isolated controls: two observed healthy turns and 24 corruptions of cost, measurement,
output, call count, wire shape, model identity, cap, window or budget. HTTP and attachment ports are
inert in those isolated controls; their original observations come from the real browser run.

The first full macOS smoke exposed a separate fixture-root mismatch: 104 passed and six failed.
The fixture kept the temporary-directory alias while product navigation and five actual hot-exit
writes used the canonical root. The fixture now canonicalizes its newly created root once. Every
exact path, content, pane and window assertion remains. All six failing journeys plus voice parity
pass targeted, then the complete final Chromium smoke passes 110/110 with no retries, skips or flaky
cases. The initial failed run and a rejected extra cross-request source-share assertion are retained.
`voice-parity-accounting.json` binds final sources, actual count observations and proof boundaries.

The untouched native React comparison is also complete: all twelve original generations and
executions remain. Both skill and no-skill groups have zero of six eligible correct-subject outputs.
Eight outputs fail strict typing; four compile but fail their correct-subject tests. No seeded
mutation is dispatched or credited. All 23 case requests retain the full component, all eight rules
and the exact selected-skill presence within the original cumulative output grants; 15 other
physical records remain separately classified. These failures do not establish a useful skill.
Further cause diagnostics and any candidate method changes remain separate, without rewriting or
recrediting the original campaign. The broader functional/platform/model acceptance holds remain.

## Checkpoint 26: observe necessary toolchain spans before the next skill comparison

The existing qualification proxy records hashes and presence flags for source spans on actual model
requests. Eight slots cover the current eight rules but cannot also witness the thirteen dependency
versions and ten compiler options needed by the next comparison. Its bounded inventory now accepts
32 spans; 33 spans, malformed values and individual markers above 4,096 characters still refuse.
Missing array slots are now rejected too: the old sparse-array iteration silently skipped them,
which could serialize absent observations. Its separate negative control fails before and passes
after materializing the bounded list for validation.
The same new 32-span control fails before and passes after. Existing observation, redaction and
verification controls remain in place. This extends test observability without adding model prompt
instructions, exposing bodies or changing product authority, retrieval or generation budgets.

`react-native-credit-hold-v1.json` preserves the failed original twelve-case comparison and the
separate thirteen-test isolation diagnosis. Seven assertions pass individually with zero runtime
errors; six still fail. Filtered cases stay ineligible and receive no mutation credit. Independent
source inspection finds shared describe-scope mocks without lifecycle hooks in all three affected
compiled outputs. This supports a focused method experiment; it does not prove a wording change,
blanket reset or repaired application. The candidate React clarification remains private and Java
is unchanged. New model calls require a separately frozen paired plan and actual necessary-source
observations; original scores and untouched-task requirements remain unchanged.

## Checkpoint 27: admit restoration under its existing phase grant

The POSIX launcher checked `startAt` for both the new version and a restored previous version.
The transaction engine already passes `cleanupAt` to restoration. A verification failure after
the start deadline therefore prevented a still-authorized restored start. Resume now selects the
same existing phase deadline as the engine. Forward start expiry, cleanup expiry, capsule and image
verification, and the plan-bound start gate retain their original checks and values.

The permanent fixture compiles the whole production launcher and executes its actual resume path,
KHP parser, deadline conversion, path/image verification and FD5 gate read against real private
files. Whole-engine controls additionally execute the actual transaction engine with controlled
process, receipt and verification ports. Both Linux and macOS plan layouts are exercised with their
own compile-time target. With identical final fixtures, the published parent has six failures and
20 healthy controls; the repair passes all 26. Tampered images/gates and restoration at or after
cleanup expiry still refuse. The first expanded fixture run used one target for both layouts and
failed seven macOS-layout controls; that setup error and its correction remain recorded.

The 26 controls also pass on Linux ARM64 with the checkout mounted read-only and networking and
capabilities disabled. The macOS native compiler/analyzer/boundary gate passes on the measured
ARM64 host. `portable-resume-deadlines.json` binds sources and causal records. These are admission
and transaction-policy proofs, with a file-backed FD5 gate; they do not run a real BFF rollback,
prove signed Endpoint Security integration, qualify Windows, or satisfy two successive packaged
updates. Existing native receipts remain the production evidence path. The broader updater and
model-skill acceptance holds remain open.

## Checkpoint 28: preserve Windows resume phase expiry

The separate Windows resume path used a fresh fifteen-minute interval after process scheduling,
without selecting the loaded plan's phase deadline. A buffered valid gate could admit a forward
start after `startAt` or a restored start after `cleanupAt`. A withheld gate also received the full
fresh interval. Windows now selects the existing start/cleanup grant immediately after plan load,
before image, parent, volume, phase and gate checks. The existing deadline conversion additionally
refuses equality at expiry, matching the positive remaining authority required by POSIX. No phase
timestamp is extended, and all existing identity, hash and classification checks remain.

The permanent policy fixture compiles the unchanged actual Windows resume, deadline-conversion and
pipe-read functions and actual context declarations. Its Win32/CRT, filesystem, identity and
validated-plan-loader ports are inert. The same final fixture has eight failures and twelve healthy
controls against the parent, then twenty passes with the repair. A separately retained intermediate
phase-only change leaves two exact-expiry failures; the final conversion repair closes those. The
withheld-gate control changes from 900,010 to 30 virtual milliseconds with twenty milliseconds of
remaining cleanup authority. Unavailable wall time, monotonic overflow, wrong image/parent/gate,
wrong phase, different volume and failed plan loading retain refusals. An initial fixture clock
parser error was corrected before the final causal comparison; its failed attempt remains separate.

`windows-resume-deadlines.json` binds the owning sources and causal records. These controls execute
on macOS and Linux with inert Windows ports. They are not real Win32, signed-parent, Job Object,
assembled updater or restart evidence. The actual Windows native quality command requires a Windows
host and is not locally executable on this macOS host; its exact-head CI result remains required.
The POSIX controls remain intact. Native ownership transfer, genuine packaged update/rollback,
consecutive updates and SSD/state qualification remain open.

## Checkpoint 29: retain expiry through native I/O

The phase-selector repairs did not cover time advancing inside the final pipe operation. Both
native exact-read helpers could accept a valid gate observed at expiry; POSIX poll or either
platform's read could also finish after the last clock check. The shared owners now enforce the
same strict absolute deadline at loop entry, after readiness and after the complete read. They
never establish a new relative grant. This protects their existing parent-control, supervisor
launch/reap/reconcile and resumed-start consumers without changing frame layouts or receipts.

The final permanent fixtures add before/at/after-expiry readiness and read delays for forward and
restored launches, partial frames, interrupted POSIX polling and clock failure after the last read.
The unchanged original controls remain. Against the identical final fixtures the delivered parent
has forty failures and 82 healthy controls; the repair passes all 122. This includes 78 actual
POSIX launcher/engine controls with real KHP, private files and FD5, and 44 actual Windows policy
controls with inert OS/identity/filesystem ports. Only clocks and readiness/read timing are
controlled in the new POSIX I/O cases. One intermediate fixture put two Windows tests outside
their parameter scope; its two failures are retained and corrected before the final causal run.

`inflight-handoff-deadlines.json` binds sources and observed results. Linux executes the same final
122 controls offline with root sources read-only. The macOS native compiler/analyzer/boundary gate
passes. These checks do not establish real Windows APIs, signed ES containment, the missing
generation-ownership transition or genuine packaged update/restart/rollback/SSD acceptance. The
broader native and model acceptance holds remain open.

## Checkpoint 30: explicit browser-approval server owner and retained React failure

The existing app-session channel now exposes a bounded request/approve/challenge/prove/inspect/revoke
path. An already approved local session must approve the exact requester key and comparison code;
completion and renewal require fresh P-256 proof over installation, server instance, exact origin,
purpose, subject, nonce and lifetime. Optional remembering requires both human choices and has an
immutable thirty-day deadline. The existing private UI SQLite owner stores only public identity and
bounded approval metadata through additive schema V45; no new bearer or credential store is added.
The original registry owns every new session, lifetime, rotation, cookie repair and revocation.

The auditor found two defects before publication. A known expiry could become renewal-eligible after
restart and clock rollback; the existing UI store now persists the observation floor. Operation
release could observe approval expiry without removing the record, allowing rollback to revive it;
release now removes the identical expired registry record. Final identical causal suites reproduce
one failure and fourteen healthy controls, then fifteen passes, and one failure and ten healthy
controls, then eleven passes respectively. Earlier causal attempts remain retained. Independent
actual-owner checks pass seven and four controls for these scoped repairs.

`browser-approval-server-core.json` binds sources and proofs. All 43 owning suites pass 858 tests,
including nine mounted-BFF HTTP controls. A newly approved cookie saves and reads a protected chat
draft; revocation makes that same access fail. The real Node WebCrypto interoperability control is
not native-browser evidence. Service recomposition over SQLite is not an OS restart; closing, moving
and reopening a temporary store is not an SSD journey. UI, IndexedDB, boot/recovery and real
Chrome/Safari/Firefox/profile/restart/SSD qualification remain open. Schema V45 is forward-only;
packaged rollback and state compatibility remain unqualified. No release version is assigned and no
installed working instance is changed. Cookie port scope, hostile same-origin code/local origin
takeover and privileged clock/state restoration are explicit threat-model limits.

`react-feedback-v5.json` preserves the failed six-case paired known-fixture experiment: twelve
phases, 52 physical calls, 23 task/citation attempts and 29 separately counted noncase calls. No
first-pass output is baseline-eligible. One raw post-feedback control output passes the correct
subject and dispatches eight mutant trials, detecting four; these are zero credited workflow results.
Every feedback phase violates the frozen observation contract, and the intended smaller input cap
was not applied to the authoritative top-level configuration. Actual cumulative usage stays within
the original grants, which does not establish the missing enforcement. A pure retrieval replay
explains the fragile contiguous marker without demonstrating material loss in the original request.
The separately found extractor-refusal feedback defect was not exercised in these generated phases.
All attempts and original results remain unchanged; both customer skills remain unaccepted.

The published parent also has a failed macOS-x64 cold-refusal CI control. Its real log records
expiry at 5,003 ms without readiness or process exit. The unchanged targeted ARM64 case passes in
1.89 seconds, which does not qualify x64 or diagnose its cause. Its cold import/refusal versus EOF
phase ordering remains under investigation. Full native updater, model benefit, historical96,
exact-head CI/review and authorized merge holds remain open.

## Checkpoint 31: distinguish cold initialization from refusal without process exit

The failed x64 job's old timeout cause records only no readiness and a still-live process. It does
not establish whether the constant refusal had already been emitted. The existing test collector
now reports refusal observation, stderr byte count and relative first-stderr/refusal times in that
same body-free timeout cause; successful cold-refusal controls emit these observations too. Packet,
config, endpoint and native stderr bodies are not added. The original ten-second cold-ready and
five-second exit limits and all semantic assertions stay unchanged.

Three fixture-owned real Node children exercise the actual collector and timeout producer for no
stderr, constant refusal while alive and unrelated stderr while alive. Identical diagnostic cases
fail three times before the change and pass three times afterward, without publishing their text.
The actual fragmented-packet/old-database owner also passes: refusal appears at 553 ms in the
targeted run. All 59 affected native owner tests pass on ARM64, with no skip; the full-run refusal
appears at 547 ms. `native-cold-refusal-observation.json` binds those exact observations and logs.
This is measurement repair, not an explanation or fix of the x64 failure. Native generation
ownership and packaged update/restart/rollback/SSD acceptance remain open.

## Checkpoint 32: share known expiry across the existing owners

Independent review found that a grant already refused by BrowserApprovalService could leave its
previously issued cookie valid after a clock correction. Investigation also reproduced the reverse:
a private read could observe grant expiry while the remembered key remained eligible for fresh
renewal after correction. The actual mounted BFF reproduced that second path before the repair.

Both directions now use the existing registry and UiStore. A service time observation asks the
registry to retire reached approval deadlines. Registry inspection, rotation, operation release,
capacity cleanup and the final cookie-repair clock observation invalidate associated sessions and
synchronously persist positive grant expiry through the existing store observation port. Valid
other approvals and launcher sessions remain independent. Idle and absolute boundaries now reject
equality; active operations still protect inactivity only. The registry logs counts and closed
reason on the existing Activity Log, without identities or bearers. No clock or session store is added.

The identical final 53-test controls against the published parent owners/composition have eighteen
failures and 35 healthy controls; the repair passes all 53. All 45 owning suites pass 908 tests. An
independent actual production-composition replay has seventeen failures/23 healthy controls then
forty passes; fourteen ordinary-boundary controls have seven failures/seven healthy then fourteen
passes. These 54 independent controls do not run a BFF, native process or browser. Root HTTP coverage
separately proves private draft access, deadline refusal and no fresh cookie after clock correction.
`browser-expiry-coordination.json` binds the exact sources, preserved failures and scoped outcomes.

The source-witness review now has direct null/boolean/number/string/array-like controls plus optional
absence. The existing runtime already refuses those malformed values; its logic and model prompts
are unchanged. No inference was used for this coverage repair.

The later head 31 macOS-x64 CI owner job passes all59 tests and observes refusal at3150 ms; its two-
process case takes6555 ms. This is subsequent successful evidence, not a reconstruction or diagnosis
of head29's failed attempt. Its observation is retained with the original native diagnostic evidence.
Browser UI/native journeys, genuine updater ownership/version/rollback/state/SSD, both skills,
original 96, final required checks and authorized integration remain open.

The head 31 coverage shard exposed two omitted derived inventories. Both exact local tests fail
before repair (two failures/75 healthy). The existing support-code producer adds exactly the four
new runtime modules. The existing count-only coverage refresh changes contracts 241→242 and
server 824→827; every coverage percentage, line measurement, floor/ratchet and reference-environment
field is unchanged. All 77 controls then pass. No fresh Linux measurement or lowered threshold is
claimed. The first local expiry-registry gate also rejected unsorted obligation lists; sorting the
existing requirements and regenerating repairs the metadata without removing an obligation.

A separate same-head 31 x64 job fails cold refusal with age5004 ms, no readiness, no exit,
refusalObserved=false and stderrByteCount=0. The successful x64 job's 3150 ms refusal does not explain
that failed attempt. The new evidence rules out already-emitted refusal for that particular timeout;
cold initialization/acquisition remains under investigation before any phase-bound change.

## Checkpoint 33: preserve failure while observing the remaining cold horizon

The same-head 31 x64 failure now has a retained precise observation: at 5004 ms there was no
readiness, process exit, parent-observed stderr or constant refusal. A successful x64 attempt is
kept separately; it does not reconstruct this failure.

Only an already failed cold-refusal control now observes the same owned exit promise through the
remaining original monotonic spawn-relative ten-second cold horizon. It always rethrows the same
five-second error, preserving its original snapshot separately from late observations. There is no
second finish/stdin operation, new retry or acceptance extension. Exit 1 is labelled exit-1 rather
than refusal; the exact constant-line observation remains separate. Timers/rejections and an already
expired horizon have explicit controls. Cleanup allows one second of TERM grace before KILL and
reaping of that same owned fixture child.

Eight actual-helper promise-port controls pass. An actual TERM-ignoring Node fixture fails against
the existing parent cleanup owner and passes against the repair; either result forcibly reaps its
same child in finally. All 68 affected native owner tests pass on ARM64 with no skip. A private
controlled six-second pre-main delay runs the actual unchanged host graph: its original failure at
5003 ms has no stderr/refusal/exit; constant refusal is then observed at 6581 ms and exit 1 at 6589 ms. The
original error is still thrown. This proves diagnostic separation under an explicit altered launch
condition, not the actual x64 cause or native updater acceptance. Earlier observations and failed
attempts remain retained in `native-cold-refusal-observation.json`.

Actual x64 follow-up, Linux/macOS generation ownership, packaged updates/restart/recovery/state/SSD,
browser journeys, both skill matrices, original 96 and final required checks/integration remain open.

## Checkpoint 34: manage the actual lifetime of session-only browser approval

Session-only grants now remain visible and revocable while their actual sessions remain valid.
The existing bounded request metadata carries that management state without persisting transient
authority. Non-touching registry inspection observes the original idle, absolute and grant bounds;
management polling cannot keep another session alive. Revoked, expired or evicted sessions release
their metadata and request capacity immediately, including before the original five-minute window.
That window still limits completion challenge issuance and proof at equality. Retaining management
metadata does not extend permission to issue or rotate a cookie.

Descriptors identify remembered versus session-only decisions. Revocation acknowledges actual
authority removal and retires its matching outstanding challenges. The existing Activity Log state
operation records bounded pending, transient and remembered counts. No new persistent store, clock,
credential or authority is introduced.

Identical final unit controls have fifteen failures and fifteen healthy results against the
published parent owners, then thirty passes after the repair. Targeted actual mounted HTTP controls
have one failure and one healthy result, then two passes; the other nine HTTP controls are filtered
only in this causal comparison. The full affected run passes all 924 tests across 45 suites, including
all eleven HTTP controls. The independent auditor's eighteen actual service/registry/store/P256
controls have ten failures/eight healthy results against published 32 and eighteen passes against
the candidate. `browser-session-management.json` binds current sources, observations and retained
failures. None of these controls establishes native browser, OS restart, profile or SSD acceptance.

Head 33 also introduced a cross-platform test-assumption error: both Windows owner jobs pass 67 of 68
controls but the new cleanup fixture incorrectly expects ignored POSIX TERM behavior. Node terminates
Windows children unconditionally for TERM. The same real fixture and bounded awaited cleanup now
require TERM on Windows and actual KILL escalation on POSIX, checking the owned child's signalCode
as well. All 68 owner controls pass locally on ARM64 without skips; actual corrected Windows CI is
still required. `native-cleanup-platform-control.json` retains the original failed job and scope.
The separate Node 26 timed-writer and development proxy CI failures remain under investigation.

The independently reviewed frozen Gemma V6 experiment has started. It remains known-fixture
feedback characterization, with unchanged customer skills and all physical calls retained; it is
not untouched held-out evidence or skill acceptance. Native generation ownership, packaged update
journeys, browser UI and real browsers, both skill matrices, Chat/search/source 96, final exact-head
required checks, review settlement and authorized integration remain open.

## Checkpoint 35: observe the intended runtime stage and bound readiness requests

The Node 26 CI timed-writer test did not establish that an owned child or packet write existed
before expecting unreaped-process recovery. Its harness now forwards the existing manager clock;
the original 20 ms write timer remains unchanged. The post-spawn control requires a captured child
and writer entry before recovery-required. A separate exact pre-spawn deadline refuses without
spawn, bytes or readiness and leaves the manager stopped. Identical stage controls have one failure
and one healthy result before the harness correction, then two passes. All 165 owning tests pass on
both macOS and actual offline Linux ARM64 under Node 26.8.1. Product runtime deadlines are unchanged.

The existing development readiness observer could wait indefinitely on stalled response headers
or body, keeping an old-target observation in flight after the child port changed. Its existing
API/UI request path now applies one five-second signal spanning both phases. Two actual HTTP
controls fail before the change and pass afterward. A private replay of the actual readiness owner
declarations with real HTTP endpoints observes a stalled old port, then changes the target while
that observation is in flight: the parent remains unready; the repair reaches readiness after the
old request expires. Exact-source timings are bound in the JSON record. These are
controlled fixture observations, not a reconstruction of the historical CI proxy failure.

The auditor's actual owner-function controls have four failures/four healthy results before the
change and eight passes afterward, with inert fetch/clock delivery. Both complete owning suites
pass 125 tests on macOS and Linux, including actual Next/BFF warmup and actual child-port reselection
and public proxy recovery. An initial Linux fixture cleanup failed because the source was read-only;
the final run uses an exact 1231-file UI copy in a writable isolated tmpfs, preserving main sources.
`readiness-and-runtime-stage.json` binds the exact controls, original CI logs and scope limits.

The frozen Gemma V6 campaign stopped at its first initial measurement failure: one dispatched case,
zero feedback, zero further cases and zero generated-test execution. All five physical calls remain
retained: two task/citation attempts and three separately classified readiness calls. Actual task
usage is 12396 input/4096 output; gateway admission and material source/skill observations pass, but
the original saved-answer join refuses. It receives no execution, benefit or skill acceptance credit.

Two measurement-schema mistakes were diagnosed offline: the stored evidence ID lives under
groundedAnswer, and the public scope ID is the contracts producer's path-free projection rather
than the raw scope ID. Actual stored/returned answer metadata agree completely, and correcting
only those accessors lets the retained physical/raw-scope/source joins agree. That replay does not
change V6's frozen failed verdict. `react-feedback-v6.json` binds the immutable terminal archive and
original observations. A prospective V7 protocol commissions actual canonical store/projection
shapes and returns nonzero on terminal measurement failures. Customer skills, task/profile,
prompts, grants, scoring and all frozen qualification product sources remain unchanged.

Full exact-head CI, native generation ownership and packaged update/restart/recovery/state/SSD,
browser UI and real browsers, both skill benefit/convention/held-out matrices, Chat/search/source 96,
review settlement and authorized integration remain open.

## Checkpoint 38: one durable conversation per shared creation intent

Two independently mounted browser coordinators could submit the same shared-window creation
without a server-owned intent, allocating two conversations. The actual mounted HTTP regression
fails before the repair. The existing private UiStore now commits the bounded creation identity
and chat atomically, scoped to the project. A delivery retry preserves the identity, while an
explicit new conversation remains independent. Existing A→B→A navigation and late-result pins
remain intact. Deleted or closed conversations cannot be resurrected by replay. The additive
schema46 migration preserves existing chats and private drafts; it does not prove updater rollback.

The frozen v1 actual native Safari private-window run joins pre-grant denial, explicit session
approval, acknowledged draft save, page reload and revocation to the same existing resource and
the real Activity Log by request correlation. An explicitly remembered key then reconnects after
a real BFF process replacement at the identical allocated origin, preserving the same38-byte
draft at revision1. Subsequent remembered revocation denies renewal and protected reads. Exactly
one conversation remains. All6299 compiled workspace artifacts and301 served assets match the
pre-start witness through shutdown. Three physical provider calls remain accounted for; this is
not a zero-inference claim. Owned test windows and BFFs were closed.

`chat-creation-idempotency.json` binds these scoped observations and the retained failed controls.
The v2 candidate only decomposes the creation effect to meet the existing UI function-size limit;
v1 native evidence is not relabelled as v2 or final-head acceptance. Full cross-browser/profile/SSD,
installed updater, source-answer, skill and exact-head integration obligations remain open.

## Checkpoint 39: retain actual private test-runner diagnostics

The pinned Vitest JSON reporter omits its global unhandled-error argument from its serialized
report. Qualification counters correctly rejected affected executions, but the private feedback
path could not recover the actual cause. The custom reporter now retains global, module and suite
errors privately within the existing 8192-byte UTF-8 grant. Unknown observations and truncation stay
explicit. Public verifier results remain body-free, and scoring is unchanged.

The actual superclass regression fails before the repair with one failure and six healthy
controls. All 31 final unit controls pass. Twelve actual offline Linux Node 24.18.0/Vitest4.1.11
runs retain identical qualification observations across six before/after pairs: only the two
healthy runs remain eligible, and all ten faulty runs remain excluded. Five diagnostic positive
controls now retain their actual cause. The multibyte control retains 8191 valid UTF-8 bytes
without a replacement character.

A prospective private feedback selector passes 30 offline controls, including all twelve actual
reports, compiler precedence, actual ordinary test failures, runtime-before-assertion priority and
refusal of missing or interrupted observations. Exact archived-report hashes bind feedback to the
canonical verifier result; schema and error counts refuse booleans. The auditor's four failing
negative probes and initial commissioning failures remain retained. Four additional actual offline
Linux runs establish the ordinary/combined positives with unchanged qualification pairs.
This is offline selector commissioning; no model campaign has used it. Raw errors remain private.
No prompt, skill, grading rule, mutant feedback or model budget changes. The original failed V7
reports and logs cannot supply their missing cause. A separately predeclared fresh diagnostic-only
execution of the exact retained generated bytes again observes 7/7 assertions and one unhandled
error, now with 1166 private diagnostic bytes. The strict baseline remains ineligible, zero mutants
are dispatched and zero model calls occur. The historical V7 verdict receives no new credit.

`private-verification-diagnostics.json` binds sources and observations. Both skill benefit and
convention matrices, fresh tasks and all broader product acceptance obligations remain open.

## Checkpoint 40: preserve the desktop and recover concurrent creation

The browser approval controller now distinguishes its own cancelled work from a transport failure.
Unmounting or superseding its request cannot emit a false global failure or publish stale state.
Genuine request/poll failures and an unowned error named AbortError retain their diagnostics.
Failed browser/update startup chunks now report their closed module identity without removing an
already mounted desktop. Healthy notices retain their original props and actions. The existing
support-context owner reads the same closed module vocabulary lazily, preserving incident context
without an eager read through the existing contract import cycle.

The final nine actual React/Next App Router/provider-frame controls have four failures and five
healthy results on the parent owners, then nine passes. Only two original internal dynamic
components are exported for the parent control; this is not a complete native desktop journey.
Four actual mounted HTTP/initialized-readiness controls have two failures and two healthy results
on the exact parent handler, then four passes after its two-line durable replay recheck.
Concurrent acceptance uses the actual UiStore while the real readiness owner is awaiting a
controlled provider response. A retired explicit model no longer masks an accepted creation or
its parameter conflict; fresh model admission remains unchanged. Existing creation Activity Log
evidence records those decisions. ADR-0114 documents the recheck after the asynchronous join.

The full affected server/contract run passes 443 tests. The corrected diagnostic/support contract
run passes 404 tests, and all 33 owning UI diagnostic controls pass. The final full UI run passes
all 562 suites and 10787 tests, with one existing skipped test. The initial full-run context-loss
failures and the rejected eager-cycle candidate remain retained. No failure is reclassified as
a pass. `browser-recovery-and-readiness.json` binds the actual sources and scoped observations.

Issue 4043's source-body provenance is refreshed; its six unchanged criteria remain unchecked.
Native browser/profile/SSD journeys, the separate footer-interception reproduction, installed
updates, both skill matrices, original 96 source qualification and final integration remain open.

## Checkpoint 41: retain bounded complete build manifests

The first simple, matched native Gemma calibration retains four complete React attempts. Three
fail the actual disabled-control interaction (AAA selected/control and GWT control). GWT selected
collects zero tests with one collection error because the Vitest describe import is missing.
The first Java attempt observes its complete service/interface and actual build dependency versions, but the
physical build excerpt omits two opening project/namespace lines. The frozen all-material-lines
contract refuses that answer before execution and stops the campaign with nineteen cases undispatched.
The terminal archive retains all attempts. These results establish neither skill benefit nor a
model capability boundary.

The existing complete-document predicate now includes canonical manifests recognized by the existing
ecosystem registry. The canonical guarded reader returns the complete current redacted snapshot only
when it fits both unchanged byte grants. Explicit selections, certified windows and ordinary source
windows retain their geometry. Six ecosystem controls have five failures and one healthy result
before the repair. All 119 tests in six affected suites pass afterward, including the byte ceiling
and existing body-free completion-log usage. No file-specific rule, prompt or model knob is added.
ADR-0022 records the same bounded behavior.

The auditor also reproduced a prospective measurement admission gap: a syntactically valid but
incomplete React report could be labelled observed. A separate caller version uses the existing
private disposition owner and the existing terminal-end-reason boundary. Eleven controls pass,
including incomplete-report refusal, completed compiler failure, actual complete failed runs,
healthy/mutation reports and inconsistent status/hash/end-reason negatives. The initial additional
end-reason failure remains retained. Java compiler completion is separately measured before strict
Surefire verification. No historical campaign receives new credit.

`complete-manifests-and-basic-skills.json` binds these scoped observations. The compact published
skills remain unchanged and unqualified. A new frozen native campaign must prove the repaired
source path; all broader acceptance and merge obligations remain open.

## Checkpoint 42: preserve registered project identity through aliases

Chat creation/replay and transactional project registration now share one read-only resolver in
the existing workspace identity module. It retains the original registered project path only while
both an existing requested path and its mapped stored path match the recorded root reference.
Retargeted aliases fail closed through canonical and alias requests, including registered and
unregistered replacement roots. Missing stored aliases fail closed through the still-existing
canonical root. The fixed `PROJECT_IDENTITY_CHANGED` response precedes project/manifest mutation.
Accepted creation preserves the configured name; recovery and parameter conflicts precede current
model admission at both readiness boundaries. Existing creation-intent and workspace-root denial
logging carry closed reasons and correlation without paths. No new store, identity formula, browser
authority or admission bypass is introduced.

Ordinary Chat also preserves the exact existing identity of older projects intentionally left
pre-manifest by the actual V15 single-most-recent migration. This includes an old alias sharing
a directory with another registered M11 project: its existing conversation must not move to the
other project's history. This compatibility branch adds no membership, trust or bulk migration.
Explicit project registration and reconnect retain their distinct existing behavior.

The identical final 33 mounted controls produce 22 failures and 11 healthy controls with the three
logic owners restored to exact parent 41 bytes. The intermediate unpublished v3 incorrectly rejects
six legitimate legacy cases, with 27 healthy controls. Final v4 passes all 33. Nine added legacy
controls were healthy in the parent; their failures are retained as an intermediary regression,
not reclassified as unsafe parent admissions. ADR-0114 and ADR-0147 are updated in place.

All 397 tests in eight affected suites pass after the final strict typecheck and package build.
The auditor separately reproduced an existing stored-alias explicit reconnect defect: ordinary
canonical legacy reconnect controls do not qualify that aliased path. It remains open and requires
its own owning-layer repair and causal controls; no global alias denial or trust gate is relaxed.

The terminal known basic v2 workflow retains five dispatched cases and nineteen undispatched.
All four Java correct-subject baselines pass their four tests. The frozen executed-assertion score
remains three of four mutants per output. Independent review of all four outputs confirms that
the additional changed-argument mutant produces a precise strict-Mockito contract mismatch. That
is observed contract-fault detection, not an infrastructure failure or evidence of a missed defect;
it does not rewrite the predeclared assertion-only score or establish skill benefit. Both known
AAA outputs conform lexically. Both known GWT outputs violate lower snake_case inside their method
name segments, so their present Given/When/Then sections do not establish convention compliance.

The first React control compiles but fails the actual disabled-pointer interaction. Its one genuine
feedback phase stays inside the original cumulative grant. Current component, Vitest configuration
and setup remain complete, but the package manifest is absent, so dependent execution is refused.
Actual activity evidence shows diagnostic routing with no metadata injection; discovery completes
without byte/read/deadline omission. This is a current-source selection failure, not a measured
model repair failure. All attempts remain retained, and all 12,099 frozen input files are separately archived and hash-verified. No prompt hint or source-gate
relaxation is used; deterministic selection controls precede any further model dispatch.

`alias-replay-and-basic-workflow.json` binds the scoped observations. Both skills and all broader
acceptance, installed updater and final integration obligations remain open.

## Checkpoint 43: retain dependency evidence during diagnostic search

A diagnostic question can also require installed dependencies. The existing planner predicate
now establishes that independent demand without changing diagnostic routing. Metadata root intake
also reuses canonical metadata already observed by current lexical text search. Current contained
regular-file, scope, ancestor, ignore, retention and byte/read guards remain binding. Arbitrary JSON,
unselected filename-discovery atoms and structural/diagnostic/assistant references do not establish those roots. No folder
name convention, score exemption, prompt rule, model setting or additional grant is introduced.

Two generic root-demand controls fail before the first repair, with five healthy controls; all seven
pass after. That small repair still fails the actual nested source contract. Two added arbitrary
nested-root controls then fail, with eight healthy controls; final intake passes all ten. All 161
tests in six affected suites pass. The identical final ten controls produce four failures and six
healthy results on exact published parent42logic, then ten passes on the candidate. ADR-0022 is
amended in place and catalogs are regenerated.

The actual noninstrumented retriever uses the retained initial/feedback query hashes and original
exploration grants against an exact private-source mirror. Both phases now retain five files without
omissions, including all 26 material build-manifest lines. Before, feedback retained three files and
omitted two for low relevance. No model or network call occurs. The incomplete intermediate repair
and private probe commissioning errors remain retained; no original generation is regraded.

`diagnostic-metadata-intake.json` binds the scoped observations. Native follow-up, skill benefit,
full search/browser/updater acceptance and final integration remain open.

## Checkpoint 44: reconnect an explicitly selected stored alias

Explicit single-root reconnect now resolves a stored alias once to the canonical anchor used
by both identity inspection and descriptor refresh. A healthy root preserves manifest revision
and trust. A different available root retains the lexical project and conversation history,
revokes only former-root trust and remains restricted. A target already held by another workspace
returns `PROJECT_EXISTS` before identity writes; the existing transaction also rolls back project
metadata and timestamps. Global strict alias denial, multi-root semantics and legacy explicit
backfill remain unchanged. ADR-0147 describes the corrected existing behavior in place.

The identical five actual store/trust/HTTP controls fail on exact published parent 43 and pass
on the candidate. All 387 tests in eight affected suites pass, alongside strict typecheck and
zero-warning scoped lint. The complete Activity Log gate passes seven of seven checks. Mounted
HTTP controls exercise the existing registered reconnect lifecycle producer and verify body-free
outcomes. The auditor independently observes two failures and seven healthy controls before,
then nine passes after, including collision/broken/file rollback and unrelated trust preservation.
Its source and actual built-owner hashes join the immutable candidate snapshot.

`explicit-alias-reconnect.json` binds this scoped repair. Two classification strings in the older
checkpoint42 receipt receive spacing corrections only; measured counts, hashes, scores and
classifications remain unchanged. Native skill measurements continue independently; this repair
changes none of their frozen inputs. Broader search, browser, skill and installed updater acceptance,
required final checks and successful integration remain open.

## Checkpoint 45: keep new window controls inside the available work area

Generic add, tool toggle and explicit Editor open now share current viewport sizing and existing
registry minima. Fresh local frames remain automatically adaptable until their geometry or ownership
changes. Actual persisted, sibling and server snapshot application retires that transient provenance,
including equal geometry with different ordering. Local focus/configuration, own server PUT
acknowledgements and ignored storage echoes preserve it. Saved/manual floating recovery, maximized
restore geometry, persistence shape and source authority stay unchanged. ADR-0123 is amended in place.

The unchanged real Chromium dictation flow first fails because the footer intercepts its control.
The initial add-only repair passes 222 unit tests but still fails the actual flow; two added tool/editor
controls then expose the bypasses. The shared three-route repair passes that flow. A controlled late
inventory case subsequently exposes a 77-pixel overflow. Twelve identical allocation/hook controls
produce six failures and six healthy controls on exact published parent 44, then twelve passes on
candidate v2. The independent reviewer then finds a candidate regression at equal-geometry remote
snapshot adoption. Two storage/server controls fail with ten healthy controls, including a healthy
own-PUT-acknowledgement control; the explicit provenance repair passes all twelve. An unpublished
hook-scope integration error was rejected by local UI typing, lint and tests before correction; its
source and failed output remain retained.

Final affected verification passes 1,478 tests in 63 hook suites, 250 actual diagnostic-HTTP tests
and the complete UI coverage run: 10,802 passes and one existing skip in 562 suites. Six actual
Chromium journeys pass together, including both notice timings and the original coding/dictation
failures. The saved-layout grounding-parity fixture uses the visible Full screen/Restore controls
and additionally proves exact restoration of its original geometry; its original source, citation,
persistence and provider assertions remain intact. Fitting and actual provenance retirement use the
existing registered body-free client activity port.

The independent reviewer passes eleven unchanged controls and thirteen extended controls, including
own storage echo and own PUT acknowledgement followed by a real higher-revision server adoption.
The complete affected workspace browser gate passes all seven cases. Two fixture corrections retain
its actual preconditions: private chat reads use the existing validated launcher pairing path, and
the tooltip case uses a genuinely overlong synthetic model id with an explicit measured-overflow
assertion. The previous id was fully visible. Authorization and tooltip guards remain unchanged.
The complete Activity Log gate passes seven of seven checks.

`window-allocation-and-provenance.json` binds this scoped change. It does not qualify native browser
approval, installed updates, skill benefit, all search journeys or final integration. Both native
updater findings and all broader acceptance obligations remain open.

## Checkpoint 46 — shared log writer identity

A different live PID is now foreign even when its short instance id collides with the local id.
The `same-process` orphan reason requires both identifiers. Same-PID reuse, confirmed exits and
ordinary stale/current-segment handling retain their existing rules. ADR-0173 D14 is clarified
in place; the existing policy-conflict and segment-recovery Activity Log operations remain the
body-free evidence owners. No log grammar or authority is widened.

The same six actual producer/parser/store controls show three failures and three healthy controls
before the correction, then six passes. All 1,323 tests in the 36 affected Activity Log suites pass.
`activity-log-writer-identity.json` binds the exact source and scoped evidence. This correction
does not qualify native updater ownership, model/skill benefit or broader customer journeys.

## Checkpoint 47 — Linux generation kernel backend

The unshipped Linux KRP1 implementation atomically holds a user/PID-namespace init and retains
a separate outer owner. Its trusted init verifies non-root ids, dropped capabilities, no-new-privileges
and non-dumpability, then polls its private lease while reaping. Credentials bind startup identities;
an on-time owned terminal init wait supports the kernel zero-live result. The POSIX codec and
existing correct argument/environment marshalling are shared inside the already attested macOS
source tree, preserving installed candidate-validator compatibility.

On the declared ARM64 namespace-enabled fixture, all eight actual kernel cases pass with five
independently held process references. Normal completion requires immediate terminal observation
after KRS; the stopped-init case refuses early proof. A private producer with its wait disabled
fails that same control. Six decoder refusals and nine actual-function deadline controls pass.
The identical deadline controls retain five failures/four healthy cases before the repair. Full
macOS compiler/analyzer/boundary checks pass. The x64 translated kernel attempt returns ENOSYS
and remains unqualified. No stage, CLI/BFF handoff or native update admission is enabled here.

`linux-generation-kernel-backend.json` binds these scoped controls and their limits. Initial and
successor ownership, host PID consumers, real installed updates and broader platform acceptance
remain open. No skill or epic acceptance changes.

## Checkpoint 48 — shared lab process and failure ownership

The existing lab runtime now owns readiness and stop error events, releases the original readiness
deadline/listeners, recognizes a child already terminated by a signal and preserves startup plus
cleanup failures. Proxy close and connection cleanup are attempted even when child stop refuses.
The same 15 direct-owner controls retain 11 failures/four healthy before and all pass after; the
expanded 20 controls and four affected suites pass 68 tests. Independent same-seven owner controls
retain two healthy/five failures before and seven passes after. Two further late-error cases fail
before their repair; the final independent nine error and four signal-state controls all pass.
Unreported lifetime errors survive normal stop without duplicating already delivered errors. Two actual isolated BFF child/proxy
controls pass, counting their contained synthetic startup probes without a real provider dispatch.

The prepared future observer removes its copied lifecycle owners and imports this shared owner
from the actual measurement checkout, supplying its unchanged configuration producer. It remains
unexecuted until the fresh BFF/source baseline is assembled and frozen. Original model campaigns,
skills, scoring, provider/transport and token grants are unchanged. Initial clock/probe fixture
commissioning failures remain retained. `lab-runtime-lifecycle.json` binds the scoped evidence;
no skill, native shipping or epic acceptance is granted.

## Checkpoint 49 — retain failed lab finalization and build the native oracle

The public lab CLI now always attempts its existing private evidence save after drain or close
refuses, retains combined operation/save errors and saves failed cleanup with exitCode1. Its
caller-owned physical recorder survives a constructor refusal. The same actual caller controls
retain two failures/two healthy before and four passes after; two actual contained HTTP
constructor controls lose observations before and retain them after. Seven affected suites
pass 82 tests, including synchronous/save-error boundaries and unchanged lifecycle controls.

`npm run check:native:linux` now performs the existing package build before native qualification;
`npm run check:native:linux -- --kernel` forwards the requested kernel scope. Direct Bash runs
in a read-only qualification container require an explicitly prebuilt checkout. Two actual
entry-command ordering/failure controls fail before and pass after; the unchanged real compiled
server encoder is used in the separately retained full native compiler/analyzer/kernel run.

The fresh source48 environment also passes a separate predeclared readiness-only setup and single
restart: two complete successful physical readiness calls, no failures, stable source hashes and
zero test-generation tasks. This is not a skill benefit or held-out result.
`lab-finalization-and-native-prerequisite.json` binds these scoped proofs; no acceptance
disposition or issue checkbox changes.

## Checkpoint 50 — bind the native Linux helper throughout packaging

The existing Linux x64 builder now produces a hardened ELF supervisor. Staging, closed helper
metadata, SBOM, qualification receipt and runtime discovery bind that actual native path and the
complete source tree containing its shared codec. Historical exact JavaScript/none-protocol
identities remain readable; new artifacts cannot use them, and mixed identities fail closed.
Linux Coding keeps its existing namespace/egress gateway. A body-free existing Activity Log
port records the admitted native binding and digest with a persisted-line proof.

Three builder controls fail before and all eight builder tests pass after. The same final two
binding and three manifest/actual-stage controls fail on published49; eight affected suites pass
818 tests on candidatev1. Sonar then required a source-path helper extraction in one script;
all other 19 inputs remain identical. The final three actual manifest/stage controls and an
unchanged 57-case replay pass on v2. Independent v1 pure tuple controls retain 53 passes/four
failures before and 57 passes after. The actual retained x64 ELF passes protection checks, independently parsed
by the auditor; translated userland does not qualify the x64 kernel. All seven Activity Log gate
steps and the actual assembled package surface pass. Initial fixture-setup failures remain retained.

`linux-native-package-binding.json` binds these observations. Initial/successor outer ownership,
Linux native-copy admission, installed-version transitions and both original native P1 findings
remain open. The separate frozen skill campaign is unchanged; neither skill is accepted here.

## Frozen basic v5 comparison — bounded terminal failure

The fresh 24-case known-calibration comparison on clean source48 stopped at case8 under its
original rule: seven completed workflows, one failed React control and sixteen undispatched
cases. Its 12,203 declared input files remain unchanged. Thirty-nine physical requests are
retained (14 task and 25 readiness). The failed case has complete, valid terminal observations
and no failed/unjoined/incomplete transport record. Its feedback exhausts the unchanged remaining
1,872 output-token grant; the Activity Log independently records outputExhausted. That failure
remains in the ledger, and the campaign is not a completed balanced comparison.

`basic-skill-v5-terminal.json` joins the input and credential-excluding terminal archives. No
case is repeated or regraded and no budget is enlarged. No skill benefit, higher capability
level, held-out acceptance or global model limit is inferred from this incomplete comparison.

## Checkpoint 51 — own proxy startup and lifetime failures

The existing lab proxy startup now rejects original asynchronous and synchronous listen errors
before constructing a BFF. Its own startup error and ready listeners are removed on either outcome, preserving Node's
pre-existing internal listener. Lifetime server
errors retain a body-free current-case indicator on the existing physical recorder. A late
listening callback cannot revive a failed construction.

The same five public constructor controls retain three failures/two healthy before and five
passes after. Eight expanded startup/lifetime controls include an actual ephemeral bind and an
actual EADDRINUSE refusal preserving its healthy blocker. The auditor found a retained ready
callback in the first candidate; the same baseline-relative actual HTTP controls retain one
failure/one healthy before and two passes after correction. All seven lab suites pass 88 tests.
`lab-proxy-startup.json` binds the scope. Frozen v5 inputs and failed outcomes remain unchanged;
no new live-generation, skill-benefit or updater acceptance is claimed.
