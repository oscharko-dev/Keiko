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
failure. The first fresh no-skill control passed typechecking but failed the same two interaction
cases as initial tuning (three passed, two failed). The original answers and execution results
remain private. These incomplete repetitions do not establish comparative effectiveness.

## Readiness under shared gateway load

Two concurrent native generation requests exposed another defect. A background readiness probe
expired after 120 seconds while the actual answer completed after 208.5 seconds. Native Node HTTP
wrapped the timeout reason in an `AbortError` with `ABORT_ERR`, which readiness treated as a
conclusive failure. This also blocked the answer's citation-repair continuation. A new Chat window
then showed model-unavailable guidance without a retry control; that recovery gap remains open.

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
passing end-to-end latency result. Creation ownership across catalog updates and manual retry after
failure remain open; the single shared provider probe itself did not duplicate. The canonical query
was supported, complete, without loss/truncation, and reported two sequence anomalies, retained
as an explicit evidence limitation.

## CI feedback on the cancellation increment

The bundle evidence measured locally under Node 24.21 did not match CI's pinned Node 24.18.0.
Running the exact checker against the same built assets in the pinned developer container reproduced
CI's fingerprint exactly; compression measurements differ between these runtimes. The evidence was
regenerated and checked with Node 24.18.0. A separate macOS-x64 fixed-host EOF timeout did not
reproduce on this arm64 host after installing the declared host dependencies: both its targeted
regression and the complete 56-test host suite passed. This does not replace exact-platform CI.

## Open work

Fresh skill/control repetitions, held-out tasks, larger Git/non-Git corpora, source freshness,
context pressure, prompt-injection cases, and the remaining shared-gateway failure matrix are open.
An initial one-shot proxy delay was consumed by a background model request and cancelled during
test-instance restart; it is not evidence of a three-minute Chat wait. Subsequent latency cases
must correlate the actual Chat dispatch with the injected delay before claiming a result.
