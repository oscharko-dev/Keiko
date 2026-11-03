# Chat and Files campaign: incremental observations

This is an incomplete execution record for [the campaign](chat-files-quality-campaign.md),
issue #4038 and PR #4039, continued under #4040 and #4017. Results below do not establish a release qualification or superiority
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
and runner configuration are omitted for low relevance. Its single physical generation reports
31,939 input and 5,344 completion tokens; no
automatic citation repair is needed. The model picker temporarily loses its label during the wait.
Canonical evidence is complete with no reported loss or truncation and retains one sequence
anomaly for investigation. Brief focused local test runs overlapped generation, so these durations
are operational observations, not isolated provider benchmarks.

The dependency-preservation issue now has failure-first final-pack regressions. Its correction
excludes negative constraints and quoted/code/path evidence from metadata intent, preserves separate
affirmative questions, and shares the planner's request-command grammar. Reviewer cases exposed
additional mixed-request and negated-reporting failures before publication; these now pass alongside
the original controls. A separate canonical-basename gap also failed before correction. It now uses
the ecosystem registry without broadening arbitrary JSON references or extensionless selectors.
The 656 planner tests and 74 final-pack/security tests pass. Canonical basename controls include
multiple matches, the finite discovery grant, restricted-directory reads and a one-file read budget.
The broader Grounding suite passes 2,651 tests with one existing skip across 158 files. A paired
retrieval-only replay retains all seven requested synthetic sources in 7,176 bytes for both the
original request and dependency-preservation variants. A separate affirmative version question
still selects lockfile evidence. Native model confirmation of this increment remains pending.

## Connected-source cancellation

A real HTTP regression first reproduces a source PATCH waiting behind a held provider response.
Source changes now interrupt active and queued generation through the existing per-chat serializer.
Canonical validation precedes interruption; unchanged, inaccessible, invalid or conflicting patches
leave the active answer intact. Buffered, streamed and regenerated requests also register before
waiting on shared gateway readiness. Three deferred-readiness cases fail before that correction
and pass afterward without aborting the shared probe. Git connect and changed-comparison refresh
have separate failure-first route proofs; unchanged refresh does not cancel.

The focused set passes 651 tests. A separate, overlapping 13-suite transport/history run passes
572 tests; the serializer and scope-log coverage reports 96.42% statements, 95.55% branches,
100% functions and 97.29% lines. Real fixture-owned HTTP tests verify upstream connection closure,
cancelled request/stream disposition, persisted turn state, retained completed history and no new
answer evidence. The next request's captured provider body contains the new selected-file excerpt
and excludes the old excerpt, with the preceding request as a positive control. This uses a local
synthetic provider, not a Gemma quality or remote-gateway latency benchmark.

The complete Activity Log gate passes its seven checks. The separate browser source-transition,
N+1 comparison/compaction matrix and simplified header remain open. This server increment alone
does not qualify immediate UI cancellation, pending-state send blocking or removal of legacy pins.

## Automatic Files views and compact header

Four failure-first cases reproduce the obsolete confirmation UI, verbose connected-source header,
and folder-pin behavior for canonical and symlink roots. The replacement follows an open file even
when the restored workspace contained a former folder pin. The native fixture-owned HTTP tests
retain canonical root attribution and deny sibling content; the seven-suite UI/session set passes
518 tests. Completed chat history and post-answer refresh ownership remain intact; the former
folder-restoration ACK race is now exercised through the same canonical mutation helper as Files
navigation. A review regression proves that an unchanged same-root file must not misclassify
another window's directory narrowing as widening; both list orders fail before and pass afterward.
The full UI lane passes 550 suites / 10,624 tests with one existing skip, reporting 91.48%
statements, 84.74% branches, 92.94% functions and 94.17% lines. The eight-test updater evidence
producer and freshness check pass; the existing editor bundle measurement is checked with the
CI-pinned Node 24.18.0 runtime. Native browser navigation verifies independent file-plus-root
labels and absence of confirmation controls. Full pending-intent cancellation, delayed/failed
ACK send-blocking and native N+1 model comparison/compaction remain separate qualifications.

## Preview selection during background root refresh

A native browser/session-repair observation exposed a mismatch: Files kept the file preview open,
while a background root read reported a null active file and widened its connected scope to the
containing directory. Two native-HTTP canonical/symlink controls reproduce the wrong callback;
a mounted two-source AppShell control reproduces the erased active file with the other root still
connected. The owning root-read callback now reports the current displayed selection only for the
same resolved root. Held reads cannot revive a closed preview or cross an actual root switch.
An unchanged configured path resolving to a different root also clears the previous directory and
cached tree; its failure-first control catches the stale-directory callback independently. The
focused Files, accessibility and scope-sync set passes 138 tests after both corrections.
The existing Files navigation/read lifecycle and scope-decision Activity Log retain body-free
observations; source contents are never diagnostic payloads.

## Open work

Fresh skill/control repetitions, held-out tasks, larger Git/non-Git corpora, source freshness,
context pressure, prompt-injection cases, and the remaining shared-gateway failure matrix are open.
An initial one-shot proxy delay was consumed by a background model request and cancelled during
test-instance restart; it is not evidence of a three-minute Chat wait. Subsequent latency cases
must correlate the actual Chat dispatch with the injected delay before claiming a result.

## Bounded 1.2.4 closeout

On 2026-10-17 the owner authorized the verified repair increment, protected `dev` integration,
a post-merge smoke and release 1.2.4. Follow-up #4040 retains the incomplete immediate client-intent
cancellation, pending/failed scope handling, N+1 source/compaction and generated-test qualification.
Epic #4037 remains open; these deferred criteria are not marked passed.

The updated browser proof exposed an additional restore race: Files showed a directory and the
server acknowledged that scope, but the Chat pill still named the previously selected file. A
bootstrap snapshot captured before the mutation could land after it. A unit regression fails before
the correction; the existing shared bootstrap version now reloads an invalidated snapshot through
its original owner. The complete Chat-session suite passes 201 tests. All eight source-navigation
browser cases pass, followed by the complete 110-case Chromium smoke suite. The cases retain
canonical root/directory/file assertions, restored-pin removal, full paths, accessible announcements
and narrow English/German layouts after retiring the obsolete confirmation controls.

The Sonar S9382 repair preserves sequential 32-source batches and stage yields through bounded
`setImmediate` continuations. Error propagation uses the same explicitly typed Promise rejection
port already used by the structural request context. The 194 code-intelligence/request-context
cases and the complete Activity Log gate pass. Default local Sonar analysis exhausted its 4.5 GiB
heap; the documented 12 GiB configuration completes without unresolved findings. No analyzer rule,
coverage floor, timeout or read boundary was weakened.

A final review identified a render-phase selection leak. A suspended preview could update the
selection ref before React committed that preview, allowing a pending root read to report that
uncommitted file. A native-root fixture with a suspended preview reproduces the wrong callback
before the repair. The ref now updates in a layout effect, before passive reads begin; all 124
Files, MultiRoot and accessibility tests pass. The existing navigation/read and scope-decision
Activity Log remains the observation path. This correction does not establish the deferred
immediate client-intent or N+1 compaction guarantees.

The fixed native host passes all 56 tests locally under CI-pinned Node 24.18.0. The prior Windows
success and EOF timeout ran on the same merge candidate. Neither local success nor static review
establishes that failure's cause; the host and its timeouts remain unchanged, and current-head
native CI is still required. Release metadata covers #4036 plus #4039, preserves existing manual
update eligibility and does not claim complete model or skill qualification. Final release-package,
coverage and exact-head CI results must be recorded before integration/publication.

The subsequent Intel macOS native-host run failed one readiness wait and one EOF-labelled wait
(54/56 passed). The latter could include a second process's cold stale-database refusal; the
original error did not identify which wait failed. Both cases pass locally on arm64, which does
not establish their Intel cause. The required native-host command now runs its same four isolated
test files sequentially, avoiding file-level startup contention without changing the 10-second
readiness or 5-second EOF deadlines. Timeout diagnostics retain only phase, age and readiness/exit
booleans. The two affected tests retain every success/refusal assertion and always dispose their
owned children without a second cleanup timeout hiding the primary failure. All 56 host cases and
111 wiring/reuse checks pass locally. This is a bounded test-scheduling mitigation, not evidence
that a product lifecycle defect was fixed; final native Intel CI remains required.

## Resumed repair increment, 2026-10-18

Starting source: `babee4b4cf5ede0d4eb8a7cec3ddf96493fee652`; implementation branch:
`codex/chat-native-qualification`. This increment is partial acceptance work, not epic closure.

Failure-first controls exposed two ownership defects. The Files tree returned an unchanged
symlink alias rather than its guarded canonical root for registered and unregistered selections.
Both server controls failed before the one-line response correction. A real HTTP tree test now
holds an old child response while the alias changes targets and proves that releasing it cannot
replace the new tree or its published root. Canonicalization, root replacement and stale reads
join the existing body-free Files diagnostic operation with the read's correlation ID.

A connected Files change also waited for its PATCH acknowledgment before cancelling Chat work.
The existing runtime registry now cancels affected sessions at intent admission. Per-source
leases hold sending while changes are pending or failed; a stale acknowledgment cannot clear a
newer lease or an independent source's failure. Chat drafts survive refused send/regenerate
requests. The existing mutation serializer and server canonical identity remain authoritative.
Tests first reproduced the missing immediate cancellation and stale-send admission. A full UI
run caught a Chat-switch ordering regression during the repair; layout-effect ordering was
corrected and the targeted control and complete UI run were repeated.

Local results before the first PR:

- Root typecheck, root/UI lint and the targeted server/contracts suites passed (738 tests).
- Complete UI coverage: 550 suites, 10,640 passing tests and one existing skip; statements 91.49%,
  branches 84.77%, functions 92.94%, lines 94.18%.
- The complete Activity Log gate passed all seven checks, including architecture and negative
  architecture controls. No unregistered operation was introduced.
- All eight updater Chromium cases passed after installing the missing browser. The original
  producer refreshed its tracked source bindings; the evidence freshness gate passed.
- A real static export on Node 24.18.0 regenerated Editor bundle evidence; its gate passed.
- The first two local Sonar attempts exhausted the original 8 GiB Docker VM (4.5 and 6 GiB
  analyzer heaps). These are failed infrastructure attempts, not clean scans. The VM was raised
  to 24 GiB for a fresh documented 12 GiB analyzer run. That scan found one introduced
  cognitive-complexity violation in send admission. Separating source admission from the send
  lifecycle removed it; the fresh analyzer rerun passed with no unresolved changed-file finding.
  The complete UI and Activity Log runs were repeated successfully after this correction.

### Exploratory paired generation, not final qualification

Four fresh native Chat answers were retained: Java and React, each with the existing candidate
skill and without a skill. They used the unchanged ten-file Orchard fixture, the local Gemma
profile and new independent conversations. Returned and persisted answers agreed in all four
cases. Validated citation counts were Java 3/0 and React 5/0 (skill/control). Three repetitions
were declared, but the batch was deliberately quiesced after the first pair per language before
resizing Docker. The remaining repetitions are incomplete, not successes. Concurrent repository
checks make these timings unsuitable for a latency comparison. This is not an original-history
replay for #4017.

Unchanged Java output compiled and ran offline in the pinned restricted container: the skill
answer had 14 passing tests; its control had 12. Both detected all three independent mutations
(threshold, upper limit, rounding), with the same generated bytes used on correct and mutated
subjects. The skill answer still asserted an unverified JUnit major version in prose, despite
its instructions; this is a tuning defect. No superiority claim follows from these samples.
The first React execution had an incorrectly named dependency mount and did not reach tests.
After correcting only that mount, the unchanged skill output compiled and passed all ten tests
and detected four of five independent mutations. Appending text to the returned quote survived
because its string `toHaveTextContent` assertion accepted a substring. The unchanged control
compiled but passed only three of five tests on the correct subject: it typed an empty string
and clicked a disabled MUI button. Mutants were not executed for this invalid control baseline.
The setup failure and both actual generation defects remain recorded; no output was repaired.

Raw answers, histories, provider observations, dependency caches and execution logs stay private.
Only synthetic inputs and body-free aggregate observations belong in this repository. The native
N+1/browser compaction, scale, pressure, held-out tasks, repeated skill comparison and original
96-criterion ledger remain open.

## Workflow lifecycle and candidate skill revision, 2026-10-18

The initial repair is signed commit `7825e78c04c91fc7d04e7aa0f4221f9b2ea5e6f8`, published in
regular [PR #4046](https://github.com/oscharko-dev/Keiko/pull/4046) against `dev`, with native
auto-merge absent. GitHub verified the signature. The assembled-package gate passed last
(6,338 files); committed-diff i18n and formatting checks passed. CodeRabbit approved that head
without actionable comments; this does not replace exact-head required CI or native acceptance.

For #4042, nine behavior controls first failed because closed PR events could enter candidate
jobs. The workflow now requires an open PR for PR events before every candidate job and the
aggregate; its existing push-only provenance job already excludes them. Open metadata/code
triggers and non-PR entry paths retain positive controls. The merge-candidate verifier, signed
delivery and aggregation bodies are unchanged. The e2e wiring classifier explicitly models live
PR state rather than treating the new predicate as unknown. Existing reuse/coverage/Activity Log
condition pins were extended with the exact lifecycle constraint, not relaxed. Five Zizmor cache
anchors were re-pinned by the existing producer after their reviewed steps moved.
The affected 32 root consumer suites passed 1,233 tests; the UI workflow consumer passed
98 tests. E2e wiring, branch parity, required-workflow names, dependency currency, scoped ESLint,
the complete Activity Log gate and fresh local Sonar passed. The exact CI actionlint 1.7.12
archive was SHA-256-verified and ran successfully in Linux; digest-verified zizmor 1.26.1
reported no findings under the unchanged reviewed configuration (eight ignored, 43 suppressed).

Gemma reviewed the measured skill defects and proposed minimal generic refinements. The revision
adds exact business-output comparisons, callable types on mocks, independently controlled async
outcomes where the contract needs them, and a final version-claim check. Existing blank-safe input,
real MUI, disabled-control, smallest-test and authority rules remain. A blanket ban on text
matchers and a requirement to use one particular type expression were rejected: the requirement
determines the assertion, and actual exported signatures determine the type. The documented
[jest-dom text matcher semantics](https://github.com/testing-library/jest-dom#tohavetextcontent)
explain the substring mutant observed above.

The revised skills are candidates, not qualified customer acceptance. Three paired repetitions
per language are being run against an independent, clean checkout of the signed runtime head,
with skill bytes captured and hashed before the first request. The existing lab observes actual
serialized skill occurrences, canonical protected-context accounting, Activity Log evidence and
returned/persisted agreement. This isolates model attempts from ongoing workflow repairs. Results
will be recorded after unchanged-output execution and semantic inspection; no pending run counts
as a pass.

## Directory response ownership increment, 2026-10-18

Further actual HTTP Files controls found five related response-ownership gaps: a child could
discover a new real root without updating the displayed root; an initial child could establish
canonical identity before a held old root arrived; a replacement could reuse a held old shared
root read; an older same-root listing could replace a newer navigation result; and a root reply
could publish a selection after unmount. These are controlled transport/fixture results, not
Gemma or full browser qualification.

Each control failed before its owning correction. The same-root control's first fixture lacked
its assumed README and receives no causal credit. After creating that input explicitly, the
unchanged committed widget from `0f168fb0355f6f94fce2da421be60b9cf77b1570` failed the actual
post-refresh assertion; the working candidate was restored byte-for-byte. The other failures
were retained at their actual preceding implementation states. The complete owning suite now
passes 15 controls, including the previous normalization and held-child cases.

The repair extends the existing Files reader: canonical observations admit responses by their
request-time and current root identity; a child-discovered replacement resets and rereads the
root independently of old in-flight work. Initial normalization preserves directory selection.
Transient per-directory owners prevent older replies from replacing newer ones and release
their entries after settlement. Unmount invalidates their generation. No new directory cache,
authority store or persistent schema is introduced. Root decisions and superseded reads retain
the existing body-free diagnostic and actual read correlation. Full UI and touched-area gates
are being repeated before delivery.

## Repeated native skill comparison, 2026-10-18

All twelve predeclared fresh Chat generations completed: three independent skill/control pairs
per language on the clean held runtime `7825e78c04c91fc7d04e7aa0f4221f9b2ea5e6f8`.
The selected revision occurred exactly once in each actual skill request and zero times in
controls. Protected-context accounting, unchanged input/output grants, source-hold checks and
returned/persisted equality passed for all twelve. These infrastructure observations do not
establish semantic acceptance.

Unchanged Java skill outputs passed 14, 15 and 14 tests on the correct subject; controls passed
13, 10 and 11. All six suites detected all three predeclared independent mutations. This small
shared fixture does not establish superiority or cover held-out Spring behaviors.

React skill repetitions one and two passed nine tests each and detected four/five and five/five
mutations respectively. The first still accepted an appended result digit through a substring
assertion. The third failed three of eight tests on the correct subject because asynchronous
query results reached matchers without being awaited. All three control suites failed their
correct baselines (two/five, one/five and two/four failures); mutants receive no credit for an
invalid baseline. The second skill answer also had zero validated citations: Activity Log first
inspection showed two physical synthesis calls and `rejected-content-changed` marker repair.
The faithful-content guard correctly refused that rewrite. Neither skill is declared finally
qualified; failed output bytes and private execution logs remain intact.

## Current-head CI diagnosis and initial-load repair, 2026-10-18

Required CI on `0f168fb0355f6f94fce2da421be60b9cf77b1570` exposed an actual initial-load
regression: 350,176 gzip bytes exceeded the unchanged 349,184-byte ceiling. The directory-response
candidate reproduced it locally at 349,652 bytes. The existing PDF preview registry was eagerly
imported solely for workspace membership bookkeeping. Workspace now loads that same registry
asynchronously, retaining only a copied membership snapshot and canceling superseded effects.
The registry and its authority/session ownership remain shared with actual preview consumers.
Current load failures use existing body-free diagnostics. Five loader controls and all existing
preview/session/performance controls passed (43 tests); the geometry-only negative assertion and
exact membership-change call count remain enforced across asynchronous loading.

A real Node 24.18.0 static export now measures 347,299 gzip bytes across 22 initial scripts,
below the original 349,184-byte ceiling. Monaco isolation also passes. No performance threshold
or suppression was increased. Editor evidence was regenerated through its original producer;
the producer and freshness check pass on the pinned Node version. A check on Node 24.22.0
reported a gzip fingerprint mismatch and is not counted as passing pinned evidence.

The same CI run also reported a Linux OpenCode functional verification-event timeout and a
macOS-x64 native-host cold-refusal timeout. The exact targeted functional coverage reproduction
passed locally (four tests, two existing platform skips); the native-host control passed locally
as well. An independent required macOS-x64 run of the identical head passed. These outcomes
are retained with their platform attribution; no timeout, test, check or authority boundary was
weakened, and the failed CI runs are not relabeled green. Exact-current-head CI remains required.

The completed increment passed root typecheck, UI ESLint with zero warnings, formatting, positive
and negative architecture checks, all seven Activity Log inventory checks and the mandatory
real local Sonar analyzer. Full UI coverage passed 551 suites and 10,650 tests with one existing
skip (91.51% statements, 84.79% branches, 92.94% functions, 94.19% lines). Updater evidence
freshness passed without regenerating unchanged bindings. Assembled-package verification ran
last and passed. These local outcomes do not substitute for current-head CI or native acceptance.

## Failed-edge recovery and React candidate refinement, 2026-10-18

A further control reproduced a failed admission hold surviving the user's explicit action to
forget an ambiguous connection while retaining all canonical Chat sources. It failed against
`bd3bc32bfaf1776308b6f0a8a0a6bc115471fb6e` before repair. The existing Chat runtime registry
now releases only that edge's failed hold through this recovery action. It refuses a pending
mutation, preserves other sources and chats, and emits body-free release evidence using the
original intent correlation. No source PATCH or authority widening accompanies this action.
The owning workspace and admission suites pass all 39 controls.

The React candidate now puts awaited-query and exact-result requirements in its mandatory
interaction rules and final audit. This is a generic response to observed unawaited matchers
and substring assertions, not a task-specific answer or edited generated output. A new complete
paired repetition remains required; previous failed generations keep their original outcomes.

The first explicitly fresh original-question run used a clean 8,129-file repository corpus at
`0f168fb0355f6f94fce2da421be60b9cf77b1570` and held runtime `7825e78c0`. It did not return an
answer. Activity Log diagnosis recorded 131,072 physical excerpt bytes, one file, 193 read
windows, 283 selected excerpts and 68,695 estimated admitted prompt tokens. The single actual
case request retained its 8,192-token output grant but was interrupted after 300 seconds. The
existing retry then failed authority admission after expiry (HTTP 403); no second physical case
request was sent. Shutdown canceled the outstanding automatic readiness probe. This is a failed
fresh baseline, not historical replay or budget/citation acceptance. Subsequent diagnosis will
retain the original limits and inspect actual prompt composition before proposing a correction.

## Bounded citation annotation candidate and new independent inputs, 2026-10-18

The observed long-code citation repair failure motivated a generic candidate: request only
bounded marker insertion annotations instead of asking the model to reproduce its entire
answer. The owning regression first rejected a valid annotation while retaining the uncited
answer; after correction the existing repair owner constructs the candidate locally and still
runs its original faithful-content and sent-evidence validation. The initial 71 repair controls
pass, including code/assessment and token-splitting denials, ambiguous anchors, malformed plans,
unsupported ranges, raw/constructed size ceilings, numeric authority and the 32-marker cap.
Existing literal marker-only responses retain their original acceptance path. This is controlled
handler evidence, not yet a native-model acceptance claim. Physical call, cumulative token and
absolute deadline admission remain owned by the existing repair path.

The new fulfillment held-out fixture has ten synthetic files (7,456 source bytes), a fixed-clock
Java reservation service and a React replacement-request/abort component. Customer profile B
requires Given/When/Then structure and names. Independently authored reference oracles passed
on correct inputs (two Java, three React controls) and detected all five Java and six React
mutations offline with unchanged test bytes. These reference tests validate the new inputs;
they are not generated-model results and are excluded from skill effectiveness counts.
A separate newly generated ordinary-folder corpus has exactly 100,000 files, three authoritative
manuals, no Git metadata and a 72-level target. Its private witness binds the actual census and
content-tree digest. Neither new input is represented as the missing historical fixture.

After the large native prompt, the local MLX runner remained in `Stopping...` and failed the
next readiness probe. All six planned React revision-four generations were refused before any
answer returned (HTTP 400); zero suites ran or passed. Their watcher was stopped once every
case was terminal. The local Ollama service was restarted through its existing service manager
without configuration changes, and a fresh fully declared batch was started. Its first skill
answer returned with five validated citations; unchanged output passed all nine tests and
all five mutations. The remaining repetitions are pending and receive no passing credit.

### Original-provider attribution correction

A renewed direct read of #4017 established a setup mismatch in the first fresh source-budget
trial: it used this lab's 300,000 ms provider timeout, whereas the historical issue records
1,365,000 ms and a 2,760,000 ms transport request budget, with one retry. The actual failed
receipt remains intact, with an explicit correction receipt beside it. Its token grants match,
but it is not an original-provider-configuration qualification. References to an unchanged
300-second limit mean the lab's configured limit only and do not establish #4017 acceptance.
A subsequent fresh baseline must use the documented historical provider/transport values and
still disclose the unavailable original history/corpus. No chronology or failure is overwritten.

## Review-driven ownership refinement and gate corrections, 2026-10-18

Four current-head review findings were checked against the implementation. The CI aggregate
comment now describes only admitted runs, preserving the unchanged condition and all eight
Zizmor anchors. The unnecessary zero-delay test timer was removed. An independently injected
geometry-dependency regression still fails the existing performance control; Workspace was
restored byte-for-byte afterward. The directory reader's status/publication helpers reduce its
function size below the enforced limit, and the existing FilesWidget suppression count shrank
from eight to seven. No new suppression was added.

A valid runtime-only Chat control found a fresh-lookup guard that required a persisted cfg id
instead of the mounted runtime identity. Once that earlier defect was corrected, the same
control failed at the review's exact recovery assertion: the edge disappeared but its actual
conversation's hold remained. Recovery and refresh now share the mounted identity resolver.
The first draft of this fixture omitted runtime registration and is excluded from causal credit.
The valid control and prior owning suites pass (279 controls across nine UI suites).

The first expanded citation-repair prompt exhausted a small positive control's remaining
input grant. It was shortened without increasing that grant; all 458 then-existing single,
plural, hybrid and repair controls passed again. A new malformed-JSON control additionally
proves that completed repair token spend and response count survive format failure. Invalid
JSON propagates to the existing repair owner, which records its body-free failure; it is not
silently swallowed or added to the observability exception register.

A Sonar run was invalidated by source edits made during analysis (the server reported 221
source lines against 227 analyzed). That was an execution error, not a clean scan. The fresh
frozen-source rerun passed. An initial full quality run overlapped source corrections and was
explicitly interrupted without a final quality claim; the final run must follow the frozen
review repairs. The full Activity Log rerun passed all seven checks after propagating parse
failure through its existing owner. Each earlier failed gate remains retained.

The next core React sample passed TypeScript but failed three of nine tests on the correct
subject by inventing an `output` ARIA role. It also retained zero validated citations after
legacy content-changing repair. The candidate now explicitly requires actual accessible
semantics and label queries instead of deriving roles from HTML tag names. This generic
refinement is a new candidate; earlier outputs remain untouched. Held-out skill bytes and
customer-profile revisions are captured before their separate native requests.

Controlled retrieval-only runs on the new 100,000-file corpus selected the authoritative
content-only manual and the exact 72-level manual. They read one file each (115/73 excerpt
bytes) and took 17,567/22,673 ms while other checks were active. These are measured developer
machine observations, not a latency-floor pass, browser/model answer or historical-corpus replay.

### Independent audit and frozen review increment

The independent read-only auditor reproduced three additional source lifecycle gaps at
`c4c0ec757c0973dcf5ccc2ce5c9ce38582c35569`. All three also fail in a separate developer-owned
snapshot of the current candidate: first Files bind lacks a pending admission hold; returning to
the acknowledged root after a failed navigation skips fresh reconciliation; switching away and
back can leave a failed hold without its connection's recovery path. These findings remain open
for the next causal repair increment. Pending operations, independent sources and canonical
server authority must remain protected throughout those repairs.

The current frozen implementation passes separate root typecheck, lint and format checks,
all seven Activity Log checks, architecture checks, the existing retrieval/grounded/faithfulness/
context gates, and the real local Sonar analyzer. The pinned Node 24.18.0 production UI export
contains 22 first-load scripts totaling 347,980 gzip bytes against the unchanged 349,184-byte
ceiling. Editor isolation, runtime/worker evidence, updater evidence and E2E wiring checks pass.
The full quality coverage chain is running; it is not yet a completed quality result.

Exact-head CI exposed two stale generated inventories introduced with the lazy PDF helper:
the support code inventory omitted its module and the UI source count remained 535 instead of 536. Both owning inventory controls failed locally before repair. The governed generator and
source-inventory-only refresh restore 77 passing controls without lowering coverage floors,
changing measured coverage values or adding exceptions. These failures and their logs are retained.

The completed React v5 batch has three matched pairs. Two skill outputs pass all nine tests on
the correct subject and detect all five independent mutants; the other skill output fails three
of nine tests on the correct subject (invented accessible role) and receives no mutation credit.
All three controls fail the correct subject (2/5, 2/4 and 3/5 failed tests). These unchanged native
outputs remain separate from the newer accessible-semantics instruction candidate.

The first held-out fulfillment driver resolved its fixture from the held runtime checkout and
failed before any model request. That setup attempt is retained as not started. Corrected v2
uses the authoring fixture while retaining the clean runtime source hold and captures all skill
and customer-profile bytes before requests. Its first Java skill answer passes 15 tests on the
correct subject and detects four of five independent mutants; the upper-quantity boundary mutant
survives. This is an explicit defect-detection gap, not full skill qualification. Further paired
runs and semantic/citation inspection remain pending.

### Lifecycle, native context names and bounded read waves

The three independent scope findings now have an owning candidate correction. The initial Files
bind acquires its admission hold before edge creation with stable Files/Chat window ownership;
failed retry reuses that owner. Equal-root recovery performs fresh canonical reconciliation.
A retired owner releases only a settled failed intent, preserving independent sources. Additional
controls retain a timeout hold through the underlying compensation and retain a hold on compensation
failure. Both safety controls failed against the intermediate prototype without those guards.
Current owning UI controls pass 368 tests, including runtime-only initial Chat identity. Old mutation
error/queue assertions remain separate from the newly observed admission lifecycle.

The auditor identified that GitHub attaches closed-event checks to the feature head and accepts
skipped required checks. Product skipped-check classification was healthy but did not refute native
owner-delivery semantics. The candidate therefore uses distinct inactive names for `ci`, `ui` and
`Build, scan, SBOM, smoke` on closed/unknown PR states. Four owning configuration/name controls failed
first. Open and non-PR names and strict candidate verification remain unchanged; the existing static
inventory recognizes only the exact reviewed lifecycle conditional. Initial coupled inventory tests
needed the same narrow normalization while retaining existing matrix expansion; their failures are
retained. Final focused lifecycle/name/reuse controls pass 225 tests; the UI workflow consumer passes 98. The complete inventoried consumers and fresh built E2E wiring remain final checks.

A real same-file 24-callable fanout initially performed 124 physical byte-read operations. Grouping
the existing per-window excerpt grants by source within discovery, seed and target observation waves
restores the non-vacuous bound of at most 12 reads with at least 24 distinct observed callable ranges.
All 118 owning symbol controls pass, including source mutation during the actual read. This is not a
persistent cache: source/call/parent certificates and original window/aggregate grants remain binding.

A production-cap A/B uses the identical 467,450-byte one-file corpus, unchanged original question,
118,784/8,192 model grants and 131,072 excerpt bytes. Read-port calls fall from 2,159 to 59 and returned
read bytes from 509,265,584 to 14,142,284. All 287 ordered excerpt ranges, lengths and content hashes
agree exactly. The auditor independently reproduced both counts and byte/hash equality. Mixed-load
wall times (36,716/26,755 ms in the repeated developer observation) are not latency acceptance. The
originally probed deadline constructor/caller and physical excerpt-charge windows remain absent.
Those exact function names are not exclusive acceptance witnesses: the auditor identified other
current ranges carrying the same absolute-deadline behavior. These probes alone establish neither
complete semantic recall nor its failure. Source census completeness does not certify required
facts. Body-free records retain their mechanical observations in `evidence/4037/`.

Exact-head CI found three task-order controls still anchored to the retired full-answer repair phrase.
Those exact single/plural/hybrid failures reproduced locally. The controls now derive the actual JSON
repair task, return actual insertion JSON and retain full prose/citation/source/system/hybrid checks.
All three pass. Moving the actual hybrid repair task before evidence fails the positional assertion;
production is restored byte-for-byte and all three pass again. This is fixture/protocol convergence,
not an additional native answer success.

The full quality run under Node 24.22.0 failed an unchanged exact-toolchain control. The targeted
reproduction fails there; Node 24.18.0 with the pinned npm passes. The broad run was interrupted once
that configuration error was established and carries no full-quality PASS. The next full run uses
the verified pinned runtime. The fresh original-question native baseline now uses the documented
1,365,000 ms provider and 2,760,000 ms transport budgets with one retry; it remains a fresh recreation,
not the unavailable historical conversation.

The completed fulfillment held-out batch retains all three Java skill/control pairs at 4/5 detected
mutants and the React execution/stale-state gaps. After analysis it is regression material, not an
untouched acceptance fixture. New generic skill checks cover valid interval endpoints and independent
stale success, rejection and pending-state behavior. A separate Spring MVC fixture is prepared before
model exposure; its hand-authored oracle passes 10 tests on correct code and detects six independent
mutants offline. These are fixture checks only. The current Spring test APIs follow the pinned build
and [Spring Boot's focused testing documentation](https://docs.spring.io/spring-boot/reference/testing/spring-boot-applications.html).

The current-source local Sonar scan found one nested-conditional maintainability issue in the
scope settlement helper. Its existing decision is now computed separately; behavior and all
admission dispositions remain unchanged. The scan is retained as a failure and must pass again
before delivery. UI build/coverage starts were stopped before applying that correction and will
be rerun on frozen source. An earlier UI build overlapped package emission and observed a partial
compiled module; the completed build exports the expected function. Build-producing steps are
now sequenced, with no product export or gate change.

The fresh original-question run with the documented provider/transport values returned after
1,131,641 ms: 128 words, two physical attempts, zero validated citations and exact returned/stored
agreement. Its answer uses detached numeric ranges and does not establish the required cumulative
physical-attempt accounting explanation. This remains a failed native quality baseline, despite
successful transport and persistence; the recreated corpus/history boundary is unchanged.

### Canonical detached-source recovery and verifier correction

The next recovery increment addresses the auditor's abandoned-write/failed-compensation sequence.
A fresh explicit bind releases only detached failed holds attributable to the same mounted source
and actually acknowledged canonical scope. A changed canonical root behind the same requested alias
retains the old hold. Valid late-ACK fixtures derive geometry and timestamps from the actual submitted
PATCH. Substituting only the two original implementation files from `86d6c674d` produces two failures
for same-source recovery and same-canonical alias recovery, while the different-canonical-root safety
control passes. Restoring the candidate passes all three and the complete 529-test owning/send-guard
selection. Independent auditor controls reproduce the two-failure/one-pass boundary. These results
precede publication and do not claim final-head CI or full browser qualification.

The complete pinned quality run did not finish: a synchronous test fixture inherited the developer's
global `tag.gpgsign=true` and opened an interactive editor while creating a same-named tag. The owned
blocked processes were terminated, with no full-quality PASS recorded. A bounded reproduction with
`GIT_EDITOR=false` fails at that exact command. Configuring commit and tag signing off only inside
the temporary fixture repository passes all 31 local-checkout controls. Repository delivery signing
and the developer's global configuration are unchanged. The complete quality chain must run again.

The private offline Java verifier now validates all actual Surefire XML reports and joins output
bytes and hashes only after terminal generation-ledger publication. Ten parser controls pass. A
real offline Maven control returns 14 tests with one skipped test across two reports and is correctly
ineligible for baseline success despite Maven exit zero. Generated output remains unchanged. This
corrects verification, not model performance; the frozen profile campaign retains its compilation
failures. No mutation credit is awarded to a failing correct-subject suite. Its no-skill condition
does not receive the profile instructions, so comparisons describe whole-skill outcomes rather than
an isolated method or naming-style effect.

Issue #4043 is accepted additional work. Existing ADR-0141 authentication owns the implementation:
explicit local approval, optional remembered-browser access, bounded renewal and revocation must
preserve protected-data access checks across browsers, restart and removable-SSD use. Inspection
confirms current process-scoped sessions intentionally expire on restart; remembered access is not
implemented by relaxing that verification. Its implementation and native browser evidence remain
open. Acceptance checkboxes are updated only when linked implementation and verification exist;
issues and epics stay open until their completed work is verified as merged into `dev`.

The current-head CodeRabbit review also exposed a failed-unbind hold whose default ownership
predicate survived removal of its edge. A new mounted regression fails specifically at clearing
that obsolete failed hold. The unbind owner now checks the mounted edge and conversation while
retaining protection for a blocked serialized write.

Real lexical producers independently reproduce a partial discovery-batch failure: an old range
beyond the shortened source discards a still-current callable witness from the same file. The
existing direct-range reader now stamps original request indices before flattening its compact
window list. Discovery preserves available observations and marks missing positions unavailable,
without range-value matching, extra source reads or a new reader. Workspace controls cover omitted
and duplicate positions and multibyte clipping; the real-producer control retains its healthy-prefix
comparison and separately checks all-unavailable input. A deliberately reversed index mapping fails
the strengthened fanout certification assertion; source restoration is verified byte-for-byte.

SonarCloud on `86d6c674d` reports three `S9382` findings in the new discovery loops. The pinned local
analyzer passes but does not contain this cloud rule, a documented tool boundary. Local ESLint's
equivalent `no-await-in-loop` identifies the same three locations alongside four unchanged older
loops. Lazy asynchronous generators now yield each operation only when the preceding one settles,
preserving capacity-dependent scheduling and stop checks. Final-head analysis remains required.

The frozen 12-case Spring profile campaign has completed. The corrected verifier rejects all 12
unchanged correct-subject outputs at compilation, with no XML reports or mutation credit. Source
selection omitted the approved conventions document; this remains a retrieval defect to repair
before another native qualification. It cannot be cured by adding fixture-specific APIs to the
customer skill or by reclassifying compilation failures as successful tests.

### Unicode repair boundaries and native workflow lifecycle

The auditor reproduced annotations that split a UTF-16 surrogate pair or a supplementary-plane
word. The same weakness affects legacy marker-only responses. Eleven negative controls fail
before the repair, including emoji joiner/skin-tone/flag boundaries; three healthy controls pass.
The existing shared validator now checks bounded grapheme boundaries using the standard runtime
segmenter and checks adjacent complete code points for its unchanged word/separator restrictions.
All 68 owning controls pass. Code, assessment, sent-evidence, insertion-count, text-size and
cumulative physical-attempt usage guards retain their existing owners. Existing repair rejection
and completion evidence records the changed verdict without recording response text.

A separate native GitHub fixture copies the three product job-name/admission expressions exactly.
Open and reopened runs on the same signed head publish all three canonical required names. Closed
metadata edits and rerunning the retained closed payload skip those jobs and publish none of those
names. GitHub's actual skipped-job name is the unexpanded expression; the initial literal inactive
label expectation failed and is retained. `evidence/4037/github-pr-lifecycle.json` binds the source,
fixture hashes, attempts, native run IDs, names and conclusions. Independent audit confirms the
deployed fixture bytes and observed check names. The fixture PR is closed without merge. This is
native lifecycle/name evidence, not a replacement for the product's full matrix or strict candidate
identity checks.

The owner also accepted the customer updater regression as #4047, a child of #4037. Screenshots
show a setup-only portable state labelled as an available update. The existing UI test explicitly
expects that misleading title; changing its expectation reproduces the failure. Investigation and
implementation use an isolated checkout while the Chat delivery head is measured. Browser/Draft
work remains under #4043. All additional update/version/cache/setup/packaged-restart/SSD acceptance
criteria remain open; no customer installation is replaced during isolated qualification.

### Initial source-cap refusal

An actual Files-to-Chat gesture at the existing source ceiling produced no PATCH, changed no
canonical source and created no edge, but left a failed send-admission hold. Its new regression
fails on the delivered implementation. The existing intent owner now releases only a previously
clean, new edge-less request refused before entering persistence, with no recovery requirement or
blocked mutation queue. The existing registry emits `released`, never a fabricated acceptance.
A second real-gesture control first establishes late canonical acknowledgement plus failed
compensation, then retries the identical bind key with an unavailable canonical lookup: that
uncertainty still blocks sends. All 55 initial owning controls pass in the isolated candidate. Four additional controls preserve
unrelated pending/failed holds, a prior same-key pending hold and a newer same-key token. The final
59 AppShell and ten registry controls pass together. Independent audit passes its 282-control
AppShell/session/registry selection. Final exact-head CI and native qualification remain required.

A captured canonical Voice request for conversation A survives navigation to B as ADR-0154
requires. The auditor also found that a later A source intent reaches only runtimes currently
displaying A. Real server handler controls reject changed source identities and prevent stale
persistence; terminal captured-Voice controls do not retry into new authority. These safe outcomes
do not establish the immediate client cancellation required by #4040. At that earlier checkpoint, the request-ownership
boundary still required repair; the following increment supplies the navigation-survival countercontrol.

### Request ownership and truthful updater notices

The current request-ownership increment moves source-intent cancellation from published window
runtimes into each existing session's controller owner, using the existing Activity Log/store
listener set. A controller records its actual conversation for both sends and regeneration.
Navigation still preserves captured Voice work; a later intent reaches that actual conversation
including the unpublished root fallback, and cannot cancel another conversation's request.
Existing controller equality guards retain ownership across late settlements and replacements.
The new closed `intent-send-cancelled` decision shares the admitted intent correlation.

The original pair of captured-Voice controls reproduces both the missed-A and wrong-B cancellation
on the delivered runtime. An initial window-only candidate passed those controls but independently
missed the root fallback. The final passing root fixture proves its first missing-user unmount and subsequent
root election, then provides the actual durable user row only after the second fallback request
is admitted, allowing the cancellation to settle. The delivered exact named case was independently
re-executed on the published sources; this request-owner boundary is repaired, while the broader
qualification ledger remains open.
A cleanup timeout with no such row is retained as a fixture failure, not a product outcome or
permission to alter persistence/retry policy. No timeout ceiling was increased.

The updater's existing setup-only assertion reproduced the misleading available-update heading.
Presentation now derives availability only from the server's version decision. Setup, external
management, unavailable checks and other required actions have distinct headings and a details
action; critical styling alone cannot claim a newer release. The new routine closed presentation
operation records the classification, visibility, availability and actual blocker count. Hostile
text, contradictory availability, extra fields and missing correlations are refused by contracts.
Notice-only translations move with the already-lazy owning widget into the existing optional
catalog; no catalog subsystem, bundle allowance or update authority is added. Native package
replacement/restart/SSD, final browser evidence and broader campaign acceptance remain open.

The auditor also reproduced critical severity falsely labelling a current/degraded non-update
in the actual Update window while the startup notice was already correct. Both negative cases
fail before the shared status owner requires `updateAvailable`; the genuine newer critical
positive remains valid. All 75 Startup/Update-window controls pass. The final nine-case Chromium
producer passes after this correction and retains the original fourteen captures/three records.

The frozen f020 full quality chain completed successfully: 55,519 package tests, 10,675 UI tests
and 7,349 script tests pass, with 91 declared skips in total. All package, release and 73 governed
file coverage floors pass. These are ancestor results; the final source head still requires its
own complete chain. A required macOS-x64 fixed-entry cold-refusal CI attempt on delivered 02f187
fails at the unchanged five-second bound. The exact local pinned ARM64 target passes, as do all
21 entry controls. A local x64 execution probe reports unsupported CPU type. The failed native
CI receipt remains open; no timeout/gate is widened and ARM64 does not substitute for x64.

An isolated real released Linux-x64 1.2.3 package passes archive checksum verification, managed
setup and startup, and its health endpoint reports 1.2.3. Its update session reports a local
package-manager installation and its preflight takes the npm path. Current server inspection
finds Linux missing from portable detection's target inventory, with non-Windows layouts routed
to macOS geometry. This is a new bounded native observation under #4047, not the customer's
confirmed incident cause or a successful replacement proof. Detection and complete native
update/restart/SSD qualification remain open.

A supplemental bundle probe accidentally used gzip's default compression instead of the
repository producer's level-nine calculation. Its earlier numbers are retained privately as
noncanonical probes and are not budget results. Calling the unchanged production
`evaluateInitialPageChunkBudget` on the final static exports yields 348,537/349,184 bytes
across 22 initial scripts on both pinned macOS-arm64 and isolated Linux-arm64 builds. The
actual original budget gate passed throughout; no ceiling or calculation changed.
