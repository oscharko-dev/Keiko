# Chat and Files campaign: incremental observations

This is an incomplete execution record for [the campaign](chat-files-quality-campaign.md),
issue #4038 and PR #4039. Results below do not establish a release qualification or superiority
over a no-skill control. Native requests used only local LiteLLM and `gemma-4-31b-it`.

## Reproducible input

[Orchard orders](../../scripts/testing/chat-skills-lab/fixtures/orchard-orders.json) contains the
exact ten synthetic source/configuration files used for the Java and React generation requests,
their prompts and three predeclared Java mutation operators. Each file value is an array of
lines including their original newline terminators; concatenate without adding separators.
Materialize it in a fresh ordinary folder, select that folder through Files, connect it to Chat,
select the model and explicitly activate the intended Markdown skill. No generated test belongs
in the source folder during retrieval. The source bytes were compared against the actual native
input after packing: ten files, 6,233 UTF-8 bytes, exact match.

The earlier six-file search used the same business requirements, but preceded the additional
build/test configuration. Its source snapshot was not retained separately; do not use this
ten-file package to claim exact reproduction of that earlier retrieval measurement.

Dependency preparation followed the campaign isolation policy. Java uses Spring Boot 4.1.1 and
Java 21; the frontend uses the exact direct versions in its package manifest. Linux dependencies
were installed in unprivileged bounded containers. Maven's `dependency:go-offline` did not fetch
the auto-detected Surefire JUnit provider. A separate trusted runner smoke test fetched it before
the generated code was executed offline. The first frontend mount also needed its `node_modules`
directory name preserved for normal dependency resolution. These setup failures were corrected
without changing generated code and are not model failures.

Execution images were pinned by digest:

- Java: `maven@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320`.
- Frontend: `node@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059`.

Generated files were extracted from exactly one language fence, unchanged, into disposable copies
of the fixture. Both executions used `--network none`, a read-only root, read-only input/dependency
mounts, an unprivileged user, dropped capabilities, no new privileges, 256 PIDs, two CPUs, 2 GiB
memory and bounded temporary storage. Java ran `mvn -o -B -ntp test` with the prepared local cache;
frontend ran `tsc --noEmit` before `vitest run --configLoader native --reporter=json`.
Transitive dependency-cache retention is private; portable locked-cache packaging remains open.

## Initial native tuning results, 2026-10-16

Both requests followed the initial search in the same conversation. They are tuning cases,
not independent repetitions. Skills were the candidates from `f68b8bdb0`, imported and selected
through the real browser UI. No output was manually repaired or fed back as a corrected answer.

| Measure                                    | Java                                      | React/MUI/Vitest         |
| ------------------------------------------ | ----------------------------------------- | ------------------------ |
| Retrieval duration                         | 146 ms                                    | 114 ms                   |
| Files sent to model                        | 8                                         | 9                        |
| Synthesis calls                            | 2                                         | 1                        |
| Model duration                             | 104.4 s + 101.7 s                         | 104.2 s                  |
| Measured prompt/completion tokens per call | 5,663/2,196; 6,610/2,171                  | 5,817/2,348              |
| Validated final citation ranges            | 0                                         | 4                        |
| Compilation/typecheck                      | Pass                                      | Pass                     |
| Unmodified test execution                  | 11 passed, 0 failed                       | 3 passed, 2 failed       |
| Seeded mutation exercise                   | All three detected after a green baseline | Not run: baseline failed |

Java detects the discount-boundary flip (two assertion failures), valid upper-limit rejection
(one application `IllegalArgumentException` in the boundary test), and changed rounding mode
(two assertion failures). The upper-limit result is an application defect, not a missing test
runner or class-loading error. All variants compiled and executed the same eleven tests.

The Java answer's detached numeric ranges did not form valid citations. A second synthesis tried
to repair them but changed content, so the production guard rejected that repair and retained the
original answer with its review warning. This is an observed quality failure, not permission to
weaken the guard. The answer also named JUnit 5 without version evidence in the supplied POM.

The React baseline failures are specific and reproducible: `userEvent.type(input, "")` throws
before testing blank validation; clicking a disabled MUI button throws because of
`pointer-events: none`. The remaining success, upper-limit/trimmed-input and error/retry tests pass.
The revised skill addresses these interaction mistakes, independent invalid-input cases and
controlled-promise settlement. Both skills now require actual citation syntax; the Java skill
explicitly avoids inferring a JUnit major version from a starter or package name. Fresh native
generation and repeated selected/no-skill comparison are still required.

Private original-answer SHA-256 digests:

- Java: `dd9021c688395886939fce3d2722382f709e08a150d4acaa59f5ef3e4e56b52f`.
- React: `1d7c3a7522b19d769a033a3de4f9ee6a51468a29babde7e7dde9d668b7c6f6d1`.

Canonical Activity Log closures were read before diagnosis. Java records two completed synthesis
calls and `citationRepairDisposition: rejected-content-changed`; React records one completed call
and no repair. Raw answers, screenshots, copied code, execution output and correlation closures
remain outside the checkout.

## Slow gateway and cancellation, 2026-10-16

The existing loopback chaos proxy delayed forwarding a real Chat completion to local LiteLLM
by 180 seconds. The actual Chat dispatch was correlated with that injection; the gateway recorded
one stream start and completion in 185,945 ms, with no retry. The browser remained usable and
retained an independently typed draft. This qualifies one delayed response-start case, not shared
production capacity, interrupted streams or all retry conditions.

Cancelling another delayed request exposed a product defect: if the user had already typed the
next draft, clicking **Cancel response** cancelled the current request and immediately submitted
that draft. The same DOM button changed from `type="button"` to `type="submit"` during the click.
The fix prevents default click activation before cancellation changes the render. It records the
closed `send-cancel-requested` activity through the existing Composer diagnostic path without
including either draft or response content.

A regression test reproduced the unwanted `sendMessage` invocation before the fix and passed
afterwards. Its synchronous state transition models the browser's discrete-event commit before
default activation. In the rebuilt, fully reloaded native app, the repeated delayed request was
cancelled after 19,053 ms: one stream start, one cancellation, one Composer cancellation event,
and the second draft remained unsent. The canonical time-window query reported complete evidence,
no loss and no truncation. A preceding retest had retained the old frontend because reopening a
launcher fragment did not reload the document; it still reproduced the defect and is excluded
from passing evidence.

## Revised React skill: fresh attempts

Revision 2 was replaced and explicitly selected through the native skill UI in a fresh conversation.
The unchanged generated file failed strict TypeScript checking because its promise resolver could
be used before assignment (`TS2454`). Execution and mutation testing therefore did not proceed.
It also repeated the earlier empty-input typing and disabled-button interaction patterns. This
attempt does not establish an improvement. A second fresh selected-skill request also failed
strict checking with `TS2454`, before execution. It produced four validated citations, whereas
the first produced none after a rejected content-changing repair. A transient, bounded request
observer confirmed the complete revision-2 skill occurred exactly once in the second provider
request; only counts and digests were retained. Missing skill delivery does not explain that
failure. The third fresh selected-skill answer passed typechecking and four of five tests, but
still attempted to click a disabled MUI button. All three selected revision-2 attempts therefore
failed the unchanged-output acceptance bar; none qualified for mutation scoring.

Three completed no-skill controls also failed: the first passed typechecking but failed two of
five tests; the next completed output passed typechecking but failed two of four tests; the last
contained invalid TypeScript syntax and could not execute. The execution failures repeated empty
input typing and disabled-button interaction mistakes. A fourth control request disconnected
before producing an answer, shortly before the host entered idle sleep. It remains a separate
transport failure in the denominator, not a model-quality failure or an erased attempt. Its
replacement required 165.4 seconds for generation and another 230.9 seconds for a citation repair
that was rejected for changing content. The original answer remained uncited. Its canonical
closure was supported and complete, without loss/truncation, with one sequence anomaly.

The original answers and execution results remain private. These small tuning-set repetitions
show neither reliable generation nor comparative skill effectiveness. Held-out evaluation remains
required before any superiority claim.

Candidate 3 puts the interaction rules first and supplies an initialized, typed deferred-promise
example. Its changed title creates a separate native skill entry at version 1; campaign candidate
numbers are not the store's revision numbers. The complete candidate occurred once in the fresh
provider request. The unchanged output passed TypeScript and three of four tests, but again tried
to click a disabled MUI button. It adopted the deferred helper and fixed the blank-input action;
the remaining execution failure still disqualifies the candidate. Generation took 100.5 seconds,
followed by a 209.2-second rejected content-changing citation repair. The original uncited answer
was retained. Its canonical closure is complete without loss, truncation or sequence anomalies.

Candidate 4 adds an explicit one-click pending-submit example. In its first fresh native attempt
at `d72e022d6`, the complete skill digest occurs exactly once in the provider request. The request
uses the larger local Gemma profile, an 8,192-token output limit and nine source excerpts
(4,689 bytes), with no request-level sampling or reasoning override. Retrieval takes 133 ms;
generation takes 93.4 seconds and reports 998 reasoning tokens. The unchanged output passes strict
TypeScript and all four generated tests in the isolated offline container. Six independently
predeclared production mutations each trigger an appropriate assertion failure: upper boundary,
exponential notation, submitted quantity, pending submit state, missing result and stale retry
error. No test code is repaired for either baseline or mutation execution.

This first passing candidate still violates the separate-invalid-case instruction, leaves mocks
without explicit callback types and supplies shortened/malformed source markers. Citation
reconciliation attaches none (`dangling-only`, no repair); its canonical closure is complete without
loss, truncation or sequence anomalies. Repetitions and held-out qualification remain open. The
next candidate adds editable customer test conventions and exact monorepo path/range guidance;
its quality is not established by candidate 4's result.

The second unchanged candidate-4 attempt passes TypeScript but fails one of four tests because it
again calls `user.type` with an empty string. It fixes the disabled-button interaction but does not
reliably retain the blank-input rule. Generation takes 105.7 seconds, followed by a 112.7-second
citation repair rejected for changing content. The original answer remains uncited. This failure
stays in the denominator and is not eligible for mutation scoring. The next candidate adds a
blank-safe positive interaction example and explicitly parameterizes separate invalid cases.

The third fresh candidate-4 output passes strict TypeScript and all five generated tests unchanged,
with four attached citations. Candidate 4 therefore passes compilation and correct-fixture execution
in two of three attempts; it is not reliable acceptance or a controlled superiority result. The
second attempt's complete canonical closure confirms no loss, truncation or sequence anomalies.

## Customer convention profiles: frozen repeated comparison

Candidate 5 adds the editable customer profile and blank-safe interaction example. Two synthetic
profiles differ only in their title, required test-name pattern and AAA versus Given/When/Then
comments. Both are imported and selected through the native UI. Three alternating fresh-chat
attempts per profile ran with unchanged task, sources, model settings and skill bodies; failures
are retained. The runtime code is `d72e022d6`, with the Markdown changes at `d1d9dece2`.

| Attempt | Unchanged output                                               | Naming / structure | Independent mutations | Validated citations | Generation |
| ------- | -------------------------------------------------------------- | ------------------ | --------------------- | ------------------- | ---------- |
| GWT 1   | Strict TypeScript and 9/9 tests pass                           | Pass               | 5/6 detected          | 8                   | 109.6 s    |
| AAA 1   | Rejected: two complete TSX blocks instead of the requested one | Not scored         | Not eligible          | 1                   | 156.1 s    |
| GWT 2   | Strict TypeScript and 10/10 tests pass                         | Pass               | 6/6 detected          | 1                   | 102.8 s    |
| AAA 2   | Strict TypeScript and 9/9 tests pass                           | Pass               | 6/6 detected          | 5                   | 120.4 s    |
| GWT 3   | Strict TypeScript and 10/10 tests pass                         | Pass               | 6/6 detected          | 4                   | 63.2 s     |
| AAA 3   | Strict TypeScript passes; 5/10 tests fail                      | Pass               | Not eligible          | 4                   | 141.1 s    |

The first GWT output misses the stale-error defect after a successful retry and leaves two
controlled promises unsettled. All three GWT outputs use mocks without explicit callback types
despite the selected profile. Passing test names/comments therefore does not mean full convention
compliance. AAA 1 emits a faulty draft followed by a self-correction; selecting the second block
afterward would change the acceptance procedure, so neither block is scored as an unchanged
delivered file. Its first block also contains an `any` cast and unfinished retry verification.

AAA 2 also uses explicitly typed callback mocks and settles its controlled pending promise. One
successful attempt does not establish repeatability. The body-free provider observer confirms the
selected skill exactly once, with no other profile, in all six actual requests.

GWT 3 omits the pending input-state assertion even though it detects all six fixed mutations;
those operators do not cover every requirement. AAA 3 incorrectly treats MUI's `error` prop as a
DOM `error="true"` attribute, failing all five invalid-input cases, and also omits their non-dispatch
assertion. Both AAA 2 and GWT 3 list verification commands without the required explicit
not-executed label, but neither claims that execution occurred.

All six completed canonical closures are supported and complete, without loss, truncation or
sequence anomalies. No citation repair was needed. Four of six attempts yield unchanged executable
files. This small tuning-fixture sample establishes neither reliability nor superiority over a
matched no-skill control; the independent React Hook Form/Zod fixture is next. The measured inputs
are 4,778–4,794 tokens, far below the configured context capacity; this comparison does not qualify
long-context behavior. GWT 3 reports zero reasoning tokens/bytes, while the other requests report
reasoning output. No request-level thinking override was applied; default capability metadata must
not be mistaken for proof of reasoning output on every request.

The next skill revision addresses a separately reviewed output-contract conflict in both languages:
supplemental path labels, maps, source notes and verification commands are permitted only when the
requested format allows that specific item. A single code fence plus open decisions does not permit
additional sections. This is a new candidate; the six comparison attempts and subsequent held-out
first attempts retain the frozen candidate-5 profiles. No measured improvement is attributed to
wording that those requests did not use.

### First independent form attempt and retrieval confound

The unchanged candidate-5 AAA profile generates nine passing tests for a separate React Hook
Form/Zod/MUI reservation form, with strict TypeScript passing and eight of nine predeclared defects
detected. Disabling the email input while pending survives; the output omits required enabled-field
assertions, the valid upper seat boundary and blank seat input. Naming/comments and explicit mock
types pass. The independent reference tests pass 8/8 and detect all nine defects; neither reference
code nor mutation operators were visible to the model. A private runner setup failure was corrected
by excluding installed dependencies from fixture copies before mounting the frozen Linux cache;
that exit-127 attempt is infrastructure evidence, not a model failure.

Generation takes 369.0 seconds, with 15,597 prompt tokens, 5,756 completion tokens and 3,595 reported
reasoning tokens. It completes in one synthesis call with five citations and no citation repair.
The canonical closure reports complete diagnostic sufficiency, no loss/truncation and one sequence
anomaly; that integrity limitation is retained. This demonstrates one completed long request, not
universal gateway resilience.

A retrieval-only reproduction matches the native seven files / 23,057 excerpt bytes. Six requested
frontend files are present, plus 18,724 bytes from the lockfile; the explicitly requested root
`README.md` is omitted as low relevance. This is a context-selection defect independent of model
output. The planned GWT/no-skill first attempts are deferred until that defect is repaired; the
first answer remains retained, and later context-corrected runs must not be pooled with it as an
unchanged comparison. The fixture has eight source/configuration files including its lockfile;
installed dependencies and the independent reference tests are outside selected source evidence.

The omission is reproduced with a root README and a nested requirements document, each named
after six other files: both regressions fail before the repair. The owning admission layer now
uses all bounded, explicitly named question paths while retaining the six-reference planning
preview and primary diagnostic priority. It reuses the existing scope/classification checks and
search/file/byte/token grants. No extra diagnostic frames or conversation references are admitted.
The existing body-free source-details event records seven admissions alongside six planning
references. Controls cover different file orders, cold/warm cache results, denied/escaped/ignored/
generated paths and exhausted grants, including basename discovery. The focused ten-file suite
passes 145 tests; root typecheck and scoped strict lint pass.
The broader Grounding run passes 2,580 tests with one existing skip across 156 files; its two
Local Knowledge consumers pass another 94 tests. Architecture positive/negative, retrieval,
grounded retrieval, faithfulness, context quality, ADR index, the full registered Activity Log
gate and real local Sonar also pass. No timeout, coverage floor or planning-reference regression
pin is relaxed.

Retrieval-only verification against the same reservation source now retains the requested README
and all six frontend files. The pack contains eight files / 21,734 excerpt bytes, with no omissions.
It still includes 16,384 lockfile bytes, so source precision remains a separate open issue.
This is retrieval evidence; a native answer under the repaired context is still pending.

## Readiness under shared gateway load

Two concurrent native generation requests exposed another defect. A background readiness probe
expired after 120 seconds while the actual answer completed after 208.5 seconds. Native Node HTTP
wrapped the timeout reason in an `AbortError` with `ABORT_ERR`, which readiness treated as a
conclusive failure. This also blocked the answer's citation-repair continuation. A new Chat window
then showed model-unavailable guidance without a retry control. The subsequent UI repair below
addresses that recovery gap.

Automatic and on-demand readiness probes now use the interactive gateway's five-minute silence
floor and preserve larger configured deadlines. Native cancellation errors retain their actual
deadline/cancellation reason and count as inconclusive in the existing body-free completion event.
Freshness remains five minutes, and background renewal remains two minutes. Renewal cadence is
independent of the longer provider deadline, preventing continuous re-probes from a negative
freshness-minus-deadline interval. Expired readiness still cannot authorize an unverified dispatch.

Native cancellation and short-deadline regressions failed before the classification fix; two
three-minute probe cases failed before the deadline-floor fix. All 95 targeted readiness and
conversation-admission tests passed afterwards, including existing renewal and single-flight
coverage. The first rebuilt browser exercise completed both delayed readiness probes in about
183 seconds. Its retained time-window query is degraded because the
running process and rebuilt query reader used different unreleased operation-catalog digests;
that attempt is not counted as complete canonical evidence.

A second exercise with matching runtime/reader catalogs retained complete canonical evidence,
without loss or truncation. It also exposed a separate admission limit: a new Chat joined the
existing probe but stopped waiting after 45 seconds and reported failed readiness while that probe
was still pending. Increasing the probe deadline alone therefore does not qualify slow Chat
creation. Two more failing-before tests cover explicit/default model admission; the corrected
aggregate wait shares the five-minute interactive floor, with all 97 targeted tests passing.

The native admission retest completed its shared probe in 181.3 seconds and a waiting creation in
165.1 seconds. It exposed a further UI defect: repeated catalog updates during the wait caused five
Chat-creation requests to complete together, instead of one. Other browser requests queued behind
those held requests, temporarily showing unavailable version/diagnostics status. This is not a
passing end-to-end latency result. The single shared provider probe itself did not duplicate. The canonical query
was supported, complete, without loss/truncation, and reported two sequence anomalies, retained
as an explicit evidence limitation.

## Chat creation ownership and recovery

The initial unbound-window request identity previously changed whenever a model-catalog refresh
replaced its creation callback. The existing creation owner now retains that identity throughout
a pending attempt. A callback change can still retry a settled failure, preserving capability
recovery behavior. The regression reproduces duplicate creation before this change and checks
both restored windows and explicit creation requests afterwards.

A failed unbound window now offers the existing translated Retry control. It clears the old error
and gives the existing owner a new request identity; the control is absent during a pending
attempt and from bound chats. Failed creation also ends the opening placeholder, allowing the
next attempt to record its own existing body-free chat-bind lifecycle. Regression cases cover
both a structured model-unavailable error and a failure without a session error.

In the rebuilt native app, an injected HTTP 503 produced the error and Retry control. A click
before the UI catalog recovered remained a visible failure. After background readiness and the
catalog recovered, another click opened the same window without reloading the page. Exactly one
successful `POST /api/desktop/chats` was recorded; the failed attempts did not dispatch a creation.

The restored-window retest held both configured-model probes for 180 seconds before forwarding.
The selected shared probe completed after 182.6 seconds; its joining Chat creation returned 201
after 174.1 seconds. Exactly one creation request completed, compared with five before the fix.
The Skills dialog opened and loaded during the wait, and the version indicator stayed available.
The creation's canonical closure is supported, complete, without loss, truncation or sequence
anomalies. The wider time-window query includes two sequence anomalies across process restarts;
that wider evidence limitation remains recorded separately.

All 93 workspace-host tests pass. Full UI coverage passes 551 files with 10,629 passing tests and
one existing skip. Strict typechecking, UI lint, formatting, architecture checks, Activity Log
inventory, i18n, pinned-runtime editor bundle evidence and the real local Sonar analyzer pass.

Additional fake-clock checks pin the aggregate admission deadline immediately before and at expiry.
Selected and default-model admission also prove that one expiring waiter leaves a shared probe
alive for a later waiter, which receives its eventual successful observation. The two affected
readiness suites pass 39 tests. Existing coverage separately bounds eight configured models to two
active probes and prevents queued old-generation dispatch after configuration replacement.

## First recursive-search scale failure

A native German question over a synthetic ordinary folder with 1,000 regular files missed both
required current refund sources. Only an unrelated pricing-service file reached the model. The
answer correctly declined to invent refund values, but the retrieval result failed the independent
source oracle. Retrieval took 699 ms; generation took 207.7 seconds while another local answer was
also pending. The UI reported partial coverage. The canonical closure is complete without loss,
truncation or sequence anomalies.

A direct diagnostic through the existing search facade isolates a wording sensitivity: a hyphenated
partner name yields backend/frontend target ranks 2/absent in the first 20 results, whereas the
same question with a space yields ranks 1/2. An English wording yields ranks 1/3. Common fragments
of a compound currently receive the same query-group match as its full subject. This is an open
retrieval defect; the corpus also contains rejected-policy, ignored, oversized, binary, denied-path,
external-symlink and source-instruction distractors. Their presence does not constitute a passed
hardening test.

The fresh native space-separated control retrieved in 677 ms and answered in 21.7 seconds. It
reported the correct backend values with two citations, but still lacked frontend and rejected-policy
evidence: only one file reached the model. Direct retrieval-pack diagnostics reproduce this second
failure separately from initial ranking. Both forms fall below the final absolute relevance floor
and trigger a single-file low-confidence fallback. Fixing initial ordering alone is insufficient;
the next regression must assert retained final source evidence as well as top-k ranking.

The first repair separates alphabetic hyphen-compound words into independent query groups while
preserving known domain aliases, numbered identifiers and explicit literal/exact-symbol behavior.
The two generic-fragment regressions fail before the repair and pass afterward. Both bounded and
uncapped facade traversals retain the backend and frontend sources with a two-result cap amid forty
generic distractors. Persistent natural-language match identity advances so old cached scores cannot
survive the change. The second, final-context regression remains failing and is retained privately
for the next repair; this increment does not claim that native multi-source retrieval is fixed.
The existing registered completion proof now checks selected-source/read/byte counts and body
redaction on a real compound-source retrieval. Repeating the direct facade diagnostic over the
1,000-file corpus ranks both current sources 1/2 for both spellings (996 scanned files, 20 retained
atoms; 384/282 ms). This is an API diagnostic, not a completed native Chat retest.

Two review corrections to the current React skill make control states conditional on the actual
component contract and use the resolved callback result type for deferred promises. The recorded
candidate-three digest and failed native output remain immutable evidence of that earlier candidate;
the corrected current file is not qualified by those results.

## Bounded multi-source fallback repair

When every ordinary candidate falls below the existing relevance floor, the lexical fallback can
retain its first source and at most two eligible peers with the same current matched-query-group
identity. A peer must retain the captured content atom's stable identity, path and query fingerprint;
equal numeric relevance alone is insufficient. Semantic evidence or an applied reranker disables
this lexical peer grant. Existing exclusions, read/byte/time budgets and low-confidence warnings
remain in force. Final-context and filter regressions fail before the repair and pass afterwards;
existing UTF-8/UTF-16 and hash-algorithm distractor controls remain green.

The optional metadata uses a canonical hexadecimal bitset of at least two and at most 128 query
groups, with no source text. Cold and warm producers preserve it, malformed persisted identities
fail closed, and the match-cache revision advances. An intermediate digest representation exceeded
the existing 8 KiB record limit for dense matching files. The compact representation restores the
existing cache-save and cancellation regressions without raising that limit. Capacity, encrypted
persistence, invalid identities, duplicate groups and the highest admitted group are covered.

A fresh native Chat on the rebuilt compact implementation, using the unchanged German question and
local Gemma 4, retained both current sources from the same 1,000-file ordinary folder. Retrieval took
842 ms (996 scanned files, two excerpt reads, 384 excerpt bytes); the model call took 23.2 seconds.
The unchanged answer correctly cited both backend and frontend for the current 21-calendar-day,
EUR 7,500 inclusive policy. Three distinct citations were displayed; citation repair was unnecessary.
The existing selection evidence records two sources, low confidence and no single-source fallback.
The canonical closure is supported and complete without loss, truncation or sequence anomalies.
An earlier prototype also retained both sources (780 ms retrieval, 20.8-second model call); only the
fresh compact implementation is the final runtime retest.

The rejected-policy archive still fails its separate source oracle. The answer explicitly states
that the supplied sources do not establish rejected proposals, and the UI retains partial-coverage
and low-confidence indicators. This repairs current backend/frontend retention; it does not qualify
archive comparison, larger corpora or general retrieval completeness.

Validation passes 11,698 domain tests across 403 files and 2,557 grounded tests across 156 files
(one existing skip), plus strict typechecking/lint, formatting, architecture/negative checks,
retrieval/grounded/faithfulness/context gates, clean assembled-package verification and local Sonar.
The Activity Log catalog is regenerated for shifted emitter locations; no operation or field is
added. The first post-assembly Activity Log build reported TS5055; an unchanged retry built
successfully. Catalog drift was separately reproduced and corrected with the repository generator.
The complete Activity Log gate then passed all seven checks over the registered inventory.

## Scale and Git comparison checkpoint

The same unchanged native question over the paired 10,000-file ordinary folder retains both
current sources. The answer cites the correct 21-day and EUR 7,500 inclusive rules from backend
and frontend. Retrieval scans 9,996 files, discovers 9,997 and reports no depth/file-count pruning;
it takes 6.7 seconds, followed by a 29.9-second model call. Two excerpt reads contribute 384 bytes
and three distinct citations; citation repair is unnecessary. The canonical closure is supported
and complete without loss, truncation or sequence anomalies. Archive comparison remains missing.

A targeted follow-up in the 1,000-file ordinary-folder conversation asks for the rejected archive
proposal and its difference from the current values. It instead selects 76 files / 11,813 excerpt
bytes, sending a 53,754-byte provider request. Retrieval takes 1.1 seconds and the model call
completes normally after 230.4 seconds. The app remains usable and allows opening another Files
window during the wait. The answer correctly refuses to invent the missing proposal, but fails
the archive oracle. Its selection is marked high confidence despite the missing requested source.
This is a context-precision failure, not a successful archive search. Canonical evidence is complete
with no loss, truncation or sequence anomalies. These are observed timings during qualification
work, including concurrent local gate execution, not isolated performance benchmarks.

The matched 1,000-file Git corpus contains identical source bytes but produces a different failure:
36 files / 9,059 excerpt bytes are selected. The current backend/frontend sources disappear while
the rejected archive is admitted. The unchanged answer correctly labels the archive's 14-day /
EUR 9,000 proposal as rejected, but cannot establish the current rule. Retrieval takes 832 ms and
the model call 92.2 seconds; canonical evidence is complete with no loss, truncation or sequence
anomalies. A retrieval-only reproduction confirms two current sources without Git versus 36
sources with Git and only the archived policy among the target files. The strongest ordinary score
rises from 24 to 165 permille and selection confidence changes from low to high. The existing
Git-history augmentation and its relevance contribution require correction before larger Git
corpora can qualify; this checkpoint does not claim that fix.

A public Spring Framework checkout supplements synthetic scale at commit
`5208d3ba1c417be6390c3f9400b13db699d638fd` (11,459 tracked files). Its independently inspected
RestClient oracle covers default status-handler registration, 4xx/5xx exception mapping and the
existing 404/500 integration tests. The native run scans 11,341 files and retains 537 files / 131,072 excerpt bytes in 35.9 seconds.
Its provider request contains 332,929 bytes (82,227 provider-counted prompt tokens; 107,594 under
Keiko's conservative admission accounting). The model attempt times out after 300 seconds.
The existing synthesis usage reservation refuses a second physical answer request because the
first attempt's output usage is unknown. The UI preserves the draft and shows the attempt-limit
error. No answer is produced, so semantic acceptance fails. Two subsequent readiness probes for
the large-context profile also time out; the local 8k profile continues responding. The profile
and upstream have not been restarted to manufacture a successful recovery.

The native 100,000-file ordinary-folder question uses that available `gemma-4-31b-it-8k` profile,
explicitly separate from the earlier large-context-profile runs. It scans 99,996 files, discovers
99,997 and retains the two current sources / 384 excerpt bytes. Retrieval takes 182.0 seconds
and the model call 125.4 seconds. The unchanged answer cites the correct current backend/frontend
values, has three distinct citations and requires no citation repair. The rejected archive remains
missing. The UI marks the answer for review with partial coverage and low confidence. Canonical
closure is supported and complete without loss or truncation; two tolerated segment-leading
sequence gaps are reported. These measurements overlap local gate execution and a separate
retrieval diagnostic, so they are not isolated performance benchmarks.

During that large search, another newly opened Chat window times out and shows `signal timed out`
without a Retry control. The global version/status requests also temporarily become unavailable;
the original search later completes. This is a responsiveness/recovery defect requiring a focused
reproduction, not evidence that a slow search is harmless. A retrieval-only comparison over the
paired 100,000-file corpora retains the current pair in both cases. Git history is output-bounded
and cannot be assumed available at this size, so this result does not cancel the reproduced
1,000-file Git ranking failure.

## Mixed-query fallback defense

The matched-query-group key is positional, so equal keys from different query fingerprints cannot
establish peer identity. A regression supplies two individually valid captured atoms from different
queries and fails before the guard (two peer identities instead of zero). The mapper now requires
one fingerprint across the surviving captured atoms before exposing peer groups; the existing
single fallback order remains available. Same-query positive controls and stale-identity controls
remain intact. This closes a defensive internal invariant; no reachable mixed-query production
capture has been demonstrated. The existing selected-count/confidence Activity Log events cover
the selection result without new operations or raw query data.

## Structural import scaling

A separate retrieval-only run on the ordinary 100,000-file corpus observes a 47.4-second event-loop
stall; a CPU-profiled repeat observes 47.9 seconds. The profile identifies repeated whole-inventory
suffix scans among the principal costs, alongside other structural indexing stages. Each unresolved
import previously copied, lowercased and scanned every indexed source path. The owning resolver now
builds one reversed-path index per immutable inventory and locates suffix ranges by binary search.
Shortest-path selection, case-insensitive matching and original-case lexical ties are preserved.
Positive and negative resolutions cannot cross inventory identities.

The deterministic regression exercises 100 distinct missing imports over 1,000 source paths. Before
the fix it observes 100,000 path visits instead of the expected 1,000. Existing polyglot resolver
tests and explicit suffix/tie-break controls protect behavior. This is one structural hotspot fix,
not a claim that all large-search event-loop blocking is resolved. The existing retrieval completion
event records elapsed time and structural work without source content.

The profiled candidate repeat retains the same two current sources and 384 excerpt bytes, with
56.2 seconds of retrieval and a 25.9-second maximum event-loop stall. Gate execution still overlaps
this run, so the timing is comparative diagnostic evidence rather than an isolated benchmark.
DTO pairing and per-file import binding scans remain visible hotspots; responsiveness is not yet
qualified. The focused resolver, structural-context and Activity Log suites pass 255 tests.

The next profile attributes 8.7 seconds to DTO pairing, dominated by checks of same-language pairs
that cannot produce contracts under the existing rule. A deterministic regression over 1,000
TypeScript shapes fails before the fix with 500,500 work-control checks. Candidate projection now
excludes that language before pair traversal and is reused for subsequent symbols of the same
language. Mixed Java/Kotlin/TypeScript controls preserve unordered-pair order, confidence and
same-scope exclusion; exhausted deadlines and cancellation still stop pairing. The focused index,
structural-context and Activity Log suites pass 247 tests. Large-search responsiveness still requires
further measurement and native browser verification.

The combined suffix/DTO candidate repeat retains the same two sources / 384 bytes in 47.3 seconds,
with a 15.9-second maximum event-loop stall. The profile no longer shows DTO pairing as a principal
cost; source decoding and repeated import-binding scans remain. The same overlapping-gate caveat
applies. The embedded test browser temporarily becomes unavailable through its control interface,
so this result remains retrieval-only evidence until native verification can resume.

A third deterministic regression exercises import binding projection for 100 files over 1,000
resolved edges. The previous implementation reads 100,000 importer paths. A weakly held projection
now groups resolved edges once per immutable inventory and preserves per-file import/export order,
specifier precedence and unresolved-target exclusion. Independent inventories cannot reuse stale
targets. The index, suffix/DTO regressions, structural-context and Activity Log suites pass 258 tests.
The combined candidate repeat retains the same two sources / 384 bytes in 34.8 seconds, with a
9.7-second maximum event-loop stall. Source reads dominate the remaining profile. Another 32
public-surface, source-reuse and source-admission tests pass. Cooperative scheduling of the remaining
synchronous work is still open; reduced elapsed time alone does not qualify responsiveness.

The request-local builder now yields after at most 32 source visits and between graph stages, using
the same build steps as the synchronous compatibility path and the existing shared execution control.
Failure-first tests show that the previous implementation completes all 512 source reads before an
event-loop cancellation can execute, and prevents unrelated event-loop work until completion. Both
tests pass with cooperative intake. A separate deadline sweep exposes expiration after the final
stage; the final coverage/cache decision now checks that boundary too. Existing semantic equivalence,
source reuse/admission and Activity Log suites pass 277 tests; typecheck and scoped lint pass.

With no concurrent campaign gate or native model request, the ordinary 100,000-file retrieval-only
repeat retains the same two sources / 384 bytes in 27.3 seconds. Its maximum event-loop delay is
2.34 seconds (timer drift 2.32 seconds), with 22.8 ms at the 99th percentile. This still leaves a
material residual stall requiring investigation; it is not native-browser responsiveness acceptance.

The native browser repeat at `2235137f4` retrieves the same current backend/frontend pair in
24.2 seconds and completes the local 8k Gemma answer in another 22.1 seconds. All five citations
resolve without repair. The current 21-day / EUR 7,500 answer passes; the rejected archive proposal
is still absent, and the answer retains its incomplete-evidence/low-confidence warning. While
retrieval is active, a second Chat is created exactly once (HTTP 201, 3 ms server duration). Its
draft remains editable and its Skills library opens during the subsequent model wait. The answer's
canonical closure is supported and complete, without loss, truncation or sequence anomalies.
This is a bounded concurrency probe, not full responsiveness acceptance. A separate timed profile
still finds a 2.54-second event-loop delay, dominated by synchronous candidate discovery before
the cooperative code-index builder. Source intake itself now yields.

The current-policy Git discrepancy is reproduced at the planner and full retrieval boundaries:
three planner assertions fail because a workspace-root selection implicitly adds Git history,
and the paired ordinary/Git retrieval test observes an unrequested history-provider call. The
planner now reserves implicit repository-wide history for diagnostic intent and keeps explicitly
requested relationships/history. Ordinary current-policy questions retain source retrieval without
unrelated commit metadata. All 608 planner and 247 orchestration/Activity Log tests pass. Two
timeout tests now fake only timeout scheduling, allowing the deliberately cooperative index work
to run before the deadline probe starts. Native paired verification and archive-ranking correction
remain open.

CI at `2235137f4` identifies two stale generated inventories after the suffix helper was added. Both
failures reproduce locally; the existing support-code generator and source-inventory refresh repair
them, with all 77 targeted tests passing. Coverage percentages and governed floors are unchanged;
refreshing the source count is not a new coverage measurement.

At `d2ba1955d`, the native ordinary/Git 1,000-file comparison selects the same two current sources
and 384 excerpt bytes. Retrieval takes 715 ms / 686 ms, and the local 8k Gemma answers take
19.3 seconds / 21.1 seconds. Both answers state the correct current values and have five citations
without repair. The backend citation opens the correct file and values in the selected Git root.
Both canonical closures are supported and complete without loss, truncation or sequence anomalies.
Both still declare the rejected proposal unavailable; that archive oracle remains failing here.

The archive omission reproduces in both multilingual regression variants and a direct identity
test: its retained content atom matches the same subject groups, but its path falls outside the
25-entry ranking diagnostic preview used to capture fallback candidates. Capture now preserves
same-query content peers from the already retained lexical result, after the reported producer
seeds. Other groups/queries, malformed keys, semantic evidence and absent/replaced identities cannot
gain peer status. The final three-source limit, admission checks, relevance floors, byte grants,
reranker precedence and low-confidence warning remain unchanged. Retrieval-only repeats now retain
the current backend/frontend plus rejected archive in both 1,000-file corpora. This does not claim
general ranking quality or a native model distinction until those probes complete.

The complete grounded suite passes 2,659 tests, with one existing skip, across 158 files using
two workers. An earlier unrestricted-worker run exposed five stale implicit-history expectations
and two timeouts with a subsequent fixture-cleanup collision. The expectations now reflect the
intent-based Git policy and retain explicit-history/no-Git skip coverage. All 81 tests in the four
affected files pass with one worker before the complete repeat. No timeout or product limit was
relaxed; these runs do not establish the cause of the initial timeouts.

A review also identifies redundant visits to earlier cross-language DTO targets. Grouped and
interleaved 200-symbol regressions both fail before the correction with 20,200 deadline checks.
Binary search now starts at the first later target while preserving eligible pair order and
cancellation checks. All 137 code-intelligence tests pass, including the existing ordering and
same-scope exclusions. Eligible cross-language pairing can still be quadratic; this correction
removes the redundant prefix, not the inherent eligible-pair work.

Native fresh-chat verification at `d72e022d6` passes the current-versus-rejected oracle in both the
Git and ordinary 1,000-file corpora. Both answers correctly distinguish the current 21-day /
EUR 7,500 rule from the rejected 14-day / EUR 9,000 proposal. They include three source files and
five validated citations without repair; the Git archive citation opens the correct root and
rejected source text. Retrieval takes 592 ms / 438 ms and generation 22.6 seconds / 22.5 seconds
(Git / ordinary). Both canonical closures are supported and complete, without loss, truncation or
sequence anomalies. Larger archive corpora remain unqualified, and partial-coverage/low-confidence
warnings remain visible.

The broad package coverage run at `1dc875bff` completes with 55,241 passing tests, 61 skipped and
one failure: the debug-launch policy test requires an exact approved Node/npm pair. A targeted
rerun reproduces that failure under the host's newer Node patch. UI coverage at `1cd9659b1` passes
10,629 tests with one skip. The debug-launch suite passes all 44 tests under the approved Node
24.18.0 / npm 11.16.0 pair. Script coverage under that approved pair passes 7,303 tests with 27
skipped. These are separate lane results; the aggregate quality command has not passed.
The coverage ratchet over those lane reports passes all 27 package floors, both strict release
targets and all 73 governed file floors. It does not replace a fresh aggregate run after the
subsequent structural performance changes.

## CI feedback on the cancellation increment

The bundle evidence measured locally under Node 24.21 did not match CI's pinned Node 24.18.0.
Running the exact checker against the same built assets in the pinned developer container reproduced
CI's fingerprint exactly; compression measurements differ between these runtimes. The evidence was
regenerated and checked with Node 24.18.0. A separate macOS-x64 fixed-host EOF timeout did not
reproduce on this arm64 host after installing the declared host dependencies: both its targeted
regression and the complete 56-test host suite passed. This does not replace exact-platform CI.

## Explicit-source confirmation and lockfile precision

The rebuilt native app at `8a2a0c46e` admitted all seven requested reservation sources, including
`README.md`, beyond the six-reference planning preview. The answer's README citation opened the
correct root and accepted requirements in the Editor. The source-admission repair does not establish
generated-test correctness: strict TypeScript passed, but unchanged execution passed 12 of 13 tests.
The blank numeric-input test expected an integer-refinement message that was not present. A separately
labelled first repair round fixed mock typing and isolated invalid-input cases, but repeated that
same failed assertion: again 12 of 13 passed. No mutation score is reported for either failing
baseline. The repair's claim to have verified the blank-input explanation is unsupported.

The repair took 416.9 seconds, including 154.2 seconds before response headers. Its stream completed
without cancellation. During that request, the full-context model disappeared from the picker after
an automatic readiness probe timed out inconclusively at 300 seconds. A bounded second probe
completed successfully two seconds after the chat answer, and the selected model reappeared without
human reselection. These observations do not establish that stale readiness may authorize a new
request. Catalog presentation, admission, generation binding and recovery require separate tests.
Canonical request and readiness queries report supported, complete evidence without loss or
truncation and a sequence-anomaly count of one. Canonical manifests classify that count as the
second segment's tolerated initial gap: the same process lifetime continues from sequence 1,160
to 1,161 without a physical gap, duplicate, decrease or reset. The counter is retained, not zeroed.

The source pack still contained a large incidental lockfile. A minimal regression reproduced this
for an ordinary folder: all seven requested sources were retained, but a shared frontend directory
and common test-library terms admitted unrelated lockfile content. The corresponding Git case
already excluded it. Final candidate selection now omits incidental lockfiles when ordinary evidence
is available, retains selected/named and dependency-version evidence, and preserves a relevant
lockfile-only fallback. It reuses the ecosystem registry and existing low-relevance omissions;
ordinary documents and the original read/token/output limits remain intact. Reviewer feedback
reproduced a German intent regression before push; canonical planner terms preserve that intent.
A separate mixed source/version query also failed on the unchanged previous head. Existing bounded
metadata discovery now inspects ancestor module roots of validated query-origin sources, checking
selected scope before directory IO. Relevance thresholds remain unchanged. Paired Git/ordinary
fixtures verify final files, actual excerpt-byte accounting, body-free completion counts, explicit
selection, sibling-module exclusion, finite budgets, restricted-directory IO and warm cache reuse.
The final 19 focused cases and the broader 2,599-test Grounding suite pass, with one existing skip.
A retrieval-only replay of the unchanged reservation request retains all seven requested sources
in 5,350 excerpt bytes, down from 21,734 bytes including the incidental lockfile. That lockfile has
the existing low-relevance omission; no requested source was removed.

Native confirmation at `d9ef42bea` retains those seven complete sources, verified against their
whole-file hashes. One physical model call completes in 133.3 seconds with three recognized
citations and no repair. Canonical evidence is complete without loss, truncation or sequence
anomalies. Its unchanged test output fails strict TypeScript on a malformed generic annotation;
runtime and mutation scoring therefore remain unavailable. This confirms source delivery, not
test-generation quality or a matched skill comparison.

The macOS-x64 CI failure at `8a2a0c46e` is a readiness timeout before the fixed host's auth/routes/SSE
assertions. At `d9ef42bea`, the fragmented-packet case fails at EOF instead. A targeted local run
passes on arm64 with the qualified installed host dependencies. The earlier local attempt lacking
that dependency root exited before readiness. Neither local platform result clears the x64 failure.

## Repair eligibility and further synthetic React qualification

A reviewer identified a deterministic wasted-call case: the citation validator rejects text above
131,072 UTF-16 code units, but dispatch previously invoked repair anyway. Five regression cases
fail before the correction. The dispatcher now reuses the validator's size predicate and records
the existing `skipped-capability` disposition, retaining original content, charged usage and uncited
uncertainty. The 52 focused tests and 365 affected shared-consumer tests pass. Boundary cases include
astral Unicode, file and numeric citations, unchanged earlier not-needed decisions, call/token/time
limits, cancellation and the real body-free Activity Log formatter. Exactly-at-limit dispatch
retains its prior behavior; this is not a claim that every impossible repair is precluded.

An independent synthetic form reference passes 17 tests and detects all nine predeclared mutations.
The first native generation using a private local profile completes in 232.7 seconds, with all
seven requested source files complete and five recognized citations. Strict typing passes, but
unchanged execution passes only 6/10 tests. Failures involve a non-native combobox value matcher,
empty keyboard input and shared callback state. A separate feedback repair completes in 521.5
seconds and passes strict typing plus 8/10 tests. It retains an invalid no-call assertion on a valid
input and introduces an over-escaped error-message regex. Neither failing baseline receives a
mutation score; the repair does not replace the first-attempt result or establish profile readiness.
The reference, private profile, prompts and raw outputs remain local.

The feedback request also exposes a context-precision issue: a constraint to leave dependencies
unchanged admits 34,197 lockfile excerpt bytes out of 39,039 total, while requirements, test setup
and runner configuration are omitted for low relevance. This remains open pending a focused
regression. Its single physical generation reports 31,939 input and 5,344 completion tokens; no
automatic citation repair is needed. The model picker temporarily loses its label during the wait.
Canonical evidence is complete with no reported loss or truncation and retains one sequence
anomaly for investigation. Brief focused local test runs overlapped generation, so these durations
are operational observations, not isolated provider benchmarks.

## Open work

Fresh skill/control repetitions, held-out tasks, larger Git/non-Git corpora, source freshness,
context pressure, prompt-injection cases, and the remaining shared-gateway failure matrix are open.
An initial one-shot proxy delay was consumed by a background model request and cancelled during
test-instance restart; it is not evidence of a three-minute Chat wait. Subsequent latency cases
must correlate the actual Chat dispatch with the injected delay before claiming a result.
