# Chat, Files and test-generation quality campaign

Status: planned qualification, not a closeout or a passing-result claim. Started 2026-10-16 from
`dev` commit `11abea703`. The campaign uses branch `codex/chat-files-quality` and one incrementally
updated pull request against `dev`.

Tracking: [Epic #4037](https://github.com/oscharko-dev/Keiko/issues/4037),
[execution task #4038](https://github.com/oscharko-dev/Keiko/issues/4038).

## Resumed acceptance plan — 2026-10-18

The owner scheduled the complete remaining campaign, including all substantive acceptance
criteria, with simple extensions of existing owners. The clean starting checkout and remote
`dev` both identify `babee4b4cf5ede0d4eb8a7cec3ddf96493fee652` (1.2.4).
PR #4039 is merged and #4038 is closed. Their bounded delivery does not qualify the deferred
criteria. This continuation uses `codex/chat-native-qualification`, with one serial implementation
owner. Current open PRs #4030 and #4041 update dependencies; #4013 targets a separate quality
branch. Recheck overlap before delivery.

| Tracker                 | Current disposition                                                                                                            | Remaining acceptance and evidence                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #4037                   | Open; #4038 delivered                                                                                                          | Complete the declared browser/model matrix, executable defect-detecting tests, causal repairs, current-head gates and review settlement. Retain every failed attempt and explicit limit.                                                                                                 |
| #4040: sources          | Server cancellation, source identity, compact controls and refresh preservation delivered; immediate client intent unqualified | Cancel before ACK; reject late answers; block stale sends during pending/failed changes; independent N+1 sources, deduplication, provenance, reordered/failed ACKs, navigation, disconnect/reconnect and Chat lifecycle recovery.                                                        |
| #4040: history          | Existing separate history/source lanes; native multi-source acceptance open                                                    | Actual Gemma/browser compaction preserves completed findings, retrieves current evidence each turn and never restores removed-source authority.                                                                                                                                          |
| #4040: refresh          | Alias/root reset regression exists; held-child variant open                                                                    | Hold an old child response across an unchanged alias resolving to a new real root; release it and prove tree and authority remain current.                                                                                                                                               |
| #4040: skills and scale | Candidate skills and isolated runs exist; complete comparison open                                                             | Three matched skill/control repetitions per core task, untouched Java/Spring and React/MUI/Vitest held-out tasks; execute unchanged tests on correct fixtures and independent defects in restricted containers; complete scale, freshness, pressure, injection and shared-gateway cases. |
| #4042                   | Open, newly discovered native child of #4037                                                                                   | Closed/merged metadata edits must not admit the live candidate matrix; open edits/base retargets and existing code-head, queue, protected-push and dispatch checks remain strict.                                                                                                        |
| #4017 / #4018           | AC1 open; earlier real answers failed                                                                                          | Original question under original history/corpus/grants: correct distinction between physical read/bytes and cumulative model tokens, remaining grants and absolute deadline, under 200 words, supported by evidence actually sent.                                                       |
| #4017 / #4019           | AC2 open; faithful rejection already enforced                                                                                  | Valid canonical citations; bounded marker repair preserves meaning, rejects content changes and retains single/plural/hybrid answer-kind and physical-attempt controls.                                                                                                                  |
| #4017 / #4020           | AC3 open                                                                                                                       | Repeated native candidate and delivered-head replays, positive sent-range joins, returned/persisted equality, 3 × 5 retrieval controls, denial/zero-grant, cumulative accounting and cleanup. Retain original latency limits.                                                            |
| #4017 / #4021           | AC4 open                                                                                                                       | Reconcile all 96 original criterion identities without relabeling fixture/historical evidence; inherited exact-head local matrix, app-bound CI, reviewed integration and final connected-chat closeout.                                                                                  |

Execution order:

1. Revalidate every criterion against existing code, receipts and native behavior. Locate the
   private original-history fixture; preserve it and all original grants. Verify local Gemma
   availability and ask it to challenge the plan. Its suggestions are hypotheses, not evidence.
2. Add failure-first proofs and repair source-intent admission and held-child ownership through
   the existing mutation serializer, Chat runtime registry and Files read generations. Keep
   canonical identities, independently owned edges and original authority intact.
3. Diagnose the original native answer from Activity Log evidence; repair generic grounded
   evidence/prompt/citation owners only when a causal regression proves the defect. No question,
   filename or model-specific answer substitution.
4. Execute the complete predeclared browser/model and skill/control matrix, including actual
   compaction, freshness, scale and correlated 60/120/180-second gateway delays. Keep raw
   artifacts private and publish only reviewed body-free results with denominators.
5. Repair #4042 through existing workflow admission, with failing-first lifecycle controls and
   all affected consumers. Never relax the strict merge-candidate verifier.
6. Run applicable minimum, coverage, Activity Log, retrieval/context, UI/evidence, local Linux,
   Sonar and inherited closeout gates. Run assembled-package verification last. Settle exact-head
   CI and reviews; formal completion additionally requires verified authorized integration and
   the post-integration native results required by #4020/#4021.

Initial environment observations: the local Docker daemon was stopped and is now running;
LiteLLM discovery exposes `gemma-4-31b-it` with a 131,072-token context and a 16,384-token output
ceiling. These catalog values do not widen any qualification grant. The original private replay
fixture has not yet been located. GitHub sub-issue relationships were read directly. The eight
open epic/task cards (#4037, #4040, #4017–#4021 and #4042) are now on the public delivery
project with classification, priority, workflow, owner and branch; PR linkage follows creation. No acceptance criterion is marked passed
by this planning inventory.

The owner clarified on 2026-10-18 that unavailable test environments, repositories, projects and
fixtures must be recreated rather than block the campaign. The supplied archive contains an old
checkout and a four-message/two-chat database, but no exact original-budget question. Newly
authored histories and corpora will therefore be declared fresh baselines and qualified with the
original question and unchanged grants wherever retained. They cannot be represented as byte-exact
historical replays. Historical receipts and the original 96 identities retain their attribution;
original-fixture repeatability stays explicitly unavailable unless that fixture is recovered.
The two customer deliverables remain the existing Java/Spring Boot unit-test and
TypeScript/React/MUI/Vitest skills, optimized from actual local Gemma execution comparisons.

## Purpose and boundaries

Exercise Keiko through the actual In-App Browser with local LiteLLM and Gemma 4. Qualify recursive
source discovery, relevant evidence selection, truthful citations, context continuity and reusable
test-generation skills in Java/Spring Boot and TypeScript/React/MUI/Vitest monorepos. Additional
local open-weight models may be compared only to answer a recorded quality question.

Reuse the existing [Chat skills lab](../../scripts/testing/chat-skills-lab/), production Model
Gateway, Files scope binding, connected-context retrieval, private Markdown skills and Activity Log.
The existing [skill qualification](private-chat-skills-qualification.md) and
[handoff](private-chat-skills-handoff-4035.md) are historical inputs, not current acceptance.
The native-answer obligations in issue #4017 remain separate and retain their original inputs.

Only synthetic fixtures and suitable public repositories are campaign inputs. Store local
credentials, pairing links, raw prompts/answers and private diagnostic artifacts outside the
checkout. Public evidence contains reviewed counts, timings, digests and outcomes. For both Java
and frontend fixtures, dependency installation and package/build hooks run in disposable,
unprivileged, resource-bounded containers or use a trusted prebuilt image; never prepare them on the
host. Dependency preparation may access the official registries. Generated code runs separately in
disposable unprivileged containers with no network and bounded resources, using those prepared
dependencies. UI journeys use normal controls; direct API setup is labelled separately.

## Predeclared test matrix

| Axis            | Cases                                                                                                    | Required observation                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Scale           | Small, 1,000, 10,000 and 100,000 source/document files, subject to recorded machine capacity             | Actual counts/bytes, cold/warm timing, memory and explicit limits; no silent completeness claim |
| Scope           | Git root, deep Git subfolder, ordinary folder, multiple connected roots                                  | Displayed and searched roots agree; no evidence escapes the selected scope                      |
| Discovery       | Nested modules, duplicate basenames, spaces/Unicode, ignored/generated files, binary and oversized files | Expected eligible source found; exclusions and omissions remain truthful                        |
| Freshness       | Added, edited, renamed and deleted files; dirty worktree; index reuse                                    | Current source and cited ranges agree; stale evidence is rejected or clearly qualified          |
| Query           | Exact path/symbol/literal, natural-language behavior, cross-module relationship, absent/ambiguous target | Relevant expected sources, supported answer and appropriate uncertainty                         |
| Context         | Fresh and long chats, follow-up references, scope changes, manual/automatic compaction, restart          | Critical requirements, immutable skill selection and source identity survive correctly          |
| Reliability     | Cancel/retry, gateway failure, deadline/budget exhaustion, stale tab and unavailable skill               | Settled lifecycle, useful recovery, retained drafts and no silent fallback or duplicate effect  |
| Hardening       | Symlink escape, denied sensitive paths and repository prompt injection                                   | Authority and redaction hold; source text cannot grant instructions or widen scope              |
| Generated tests | Java service and Spring slice; React logic, MUI form, asynchronous component                             | Compile, pass the correct fixture and detect independently authored defects                     |

Scale is file-count and byte-count evidence, not an inferred repository label. Large distractor
corpora retain independent relevance oracles and multiple directory positions. Synthetic scale
does not establish realism; public monorepo cases supplement it. Any unavailable scale remains open.

## Measurements and comparison rules

### Live connected Files acceptance clarification

The owner confirmed these requirements on 2026-10-16; implementation and qualification remain open:

- Each explicitly connected Files window follows its displayed resolved root, subdirectory or single
  file immediately, including widening on navigation back. Remove the dismiss/keep-folder notice
  and legacy folder pin behavior. The normal Chat header identifies the actual connected sources
  concisely, retaining accessible disconnect and truthful pending/refused states.
- Multiple connected windows contribute independent scopes. Qualify file-plus-repository,
  repository comparisons, same-name files in different roots, overlapping sources and independent
  navigation/addition/removal. Unconnected windows grant no scope; overlapping evidence must not be
  needlessly duplicated. Scope changes retain the original authority and read/budget boundaries.
- Changing connected sources cancels the active answer. Old in-flight results must not publish into
  the new scope. Test delayed and out-of-order acknowledgements, failed updates, repeated navigation,
  close/reconnect and chat switching through the real cancellation and update routes.
- Completed messages and learned findings remain ordinary conversation history and continue normal
  compaction. Fresh retrieved Files excerpts remain separate from that history lane. Historical
  findings never restore current filesystem authority. Repeat comparisons and scope transitions
  after actual compaction; distinguish current evidence from historical conversation references.

These are acceptance requirements, not evidence that the present implementation passes them.

The owner clarified the customer gateway requirement on 2026-10-16: shared remote LiteLLM servers
can take one to three minutes to respond during peak use. Local inference speed does not qualify
that deployment. Use the existing lab fault proxy to exercise 60/120/180-second response-start
delays, slow/interrupted streams, transient 429/503 responses and bounded recovery. Record physical
dispatch counts, Retry-After handling where supported, progress/wait presentation, cancellation,
draft recovery and final settlement. Separate controlled transport evidence from real-model quality.
Waiting must not create parallel duplicate submissions or a retry storm. Exhausted deadlines and
budgets must settle honestly; the campaign does not authorize unlimited retries or wider grants.

Before running a case, record its task, expected relevant paths/behaviors, permitted scope, model,
source revision, context limits and resource grants. Distinguish discovered candidates, physically
read sources, final model-sent excerpts and validated answer citations. These are different counts.
Assess source recall and precision against the declared oracle, source-specific factual correctness,
unsupported claims, citation accuracy, end-to-end latency, available token usage and resource costs.

Compare skill-selected and matched no-skill fresh chats, initially three independent repetitions
per core task. Preserve every attempt and report the denominator. Separate model nondeterminism
from deterministic retrieval failures. Keep tuning tasks distinct from held-out acceptance tasks;
never change expected behavior merely to accept an observed answer.

Generated test output is extracted and executed unchanged. Compilation/infrastructure failures,
empty suites and tests that already fail the correct implementation are not defect detection.
Run independent boundary, validation, state and asynchronous defects where applicable; inspect the
assertions as well as pass counts. A passing suite alone does not establish useful coverage.

## Skill design

Both skills are ordinary private Chat Markdown skills imported and explicitly selected through the
existing UI. They inspect supplied project evidence, preserve its versions and conventions, request
missing interfaces rather than invent them, and separate evidence from assumptions.

- Java/Spring Boot: focused JUnit/Mockito unit tests by default; Spring slices only for framework
  behavior, deterministic time/data, meaningful boundaries and exceptional paths, minimal mocks.
- TypeScript/React/MUI/Vitest: user-visible behavior with Testing Library and user-event, accessible
  queries, realistic providers/portals, asynchronous states, form validation and proper cleanup.

Optimize instructions using measured failures, not length. Skills must not claim execution tools
that Chat does not have, fabricate passing results or override Keiko authority and source boundaries.

Initial candidates (effectiveness is not yet qualified):

- [Java/Spring Boot skill](../../scripts/testing/chat-skills-lab/skills/java-spring-unit-tests.md).
- [React/MUI/Vitest skill](../../scripts/testing/chat-skills-lab/skills/react-mui-vitest-tests.md).

Both were imported through the actual Chat file picker and rendered in Preview without activation.
They retain project-version checks, observable assertions, explicit missing evidence and honest
execution reporting. Compare them against no-skill controls before claiming an improvement.

## Initial observations — incomplete campaign

The first native Gemma question used six synthetic files in one ordinary folder: Java service,
React component, quantity parser, dependency metadata, accepted requirements and a rejected proposal.
The UI selected the requested folder, connected it to Chat and displayed Live Files context.
All six files were recursively checked and sent; five distinct citation ranges were validated.
Canonical Activity Log correlation closure reported complete diagnostic sufficiency, no loss and
no truncation. Retrieval took 94.057 ms; one model call took 57,272.624 ms, with 3,779 reported prompt
tokens and 1,417 completion tokens. No citation repair or follow-up synthesis was needed.

Four of five predeclared answer facts were stated correctly. The answer did not explicitly explain
that the frontend delegates monetary calculation. Retain that omission; this single result is not
full semantic acceptance, scale evidence, a skill comparison or proof of test-generation quality.
Raw browser/answer artifacts remain private; reproducible corpus packaging is still pending.

Subsequent native generation runs and the packed ten-file monorepo are recorded in the
[incremental observations](chat-files-quality-observations.md). These are tuning observations,
not the predeclared repeated comparison or a campaign closeout.

## Iteration and verification

1. Exercise the UI and record the outcome; read canonical Activity Log evidence first on failure.
2. Reproduce the defect at its owning layer and demonstrate a failing regression before the repair.
3. Repair the class through existing owners, with registered body-free observations and aligned docs.
4. Run the affected minimum-loop checks, mandatory local Sonar and touched-area gates from AGENTS.md.
5. Retest the browser case and relevant controls; commit/push a small coherent increment.
6. Update the PR description with actual changes, tests, limitations and findings; settle reviews.

No fixed wall-clock push deadline overrides required checks. Avoid accumulating unrelated repairs
in one increment. Product fixes declare their actual release impact. Required CI is the final full
matrix; it is not the local test loop. Only `oscharko` may authorize and execute integration into
`dev`, including enabling native auto-merge. An agent acting under that account still requires the
owner's explicit authorization. On 2026-10-17 the owner authorized bounded closeout of PR #4039,
protected integration into `dev`, a post-merge smoke and release 1.2.4, conditional on green checks
and settled review conversations. The durable authorization is recorded in
[the PR](https://github.com/oscharko-dev/Keiko/pull/4039#issuecomment-6229375703).
[Follow-up #4040](https://github.com/oscharko-dev/Keiko/issues/4040) retains immediate client-side
scope cancellation, pending/failed-scope handling, complete N+1 compaction qualification and
remaining generated-test comparisons. The campaign and its parent epic are not fully qualified
or closed by this bounded release.

## Research inputs

These primary sources inform hypotheses, not automatic architecture changes:

- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  motivates selective context, progressive retrieval and retention checks during compaction.
- [Lost in the Middle](https://arxiv.org/abs/2307.03172) motivates varying the position of relevant
  information instead of testing only the beginning of long input.
- [ripgrep user guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md) informs explicit
  expectations for recursive traversal, ignore rules, hidden files and symbolic links.

Read on 2026-10-16. The campaign must verify whether each hypothesis helps the actual local model
and Keiko implementation within unchanged authority and resource limits.

### Gemma 4 investigation and customer-authored test conventions

The owner emphasized model-specific optimization and customer control of test conventions on
2026-10-16. These additions extend the existing comparison matrix; they are not qualified results.

- Google's [31B instruction-tuned model card](https://huggingface.co/google/gemma-4-31B-it#best-practices)
  recommends temperature 1.0, top-p 0.95 and top-k 64. Preserve this as the reference configuration;
  compare alternatives only with identical tasks, source context, skill revisions and repetitions.
- Google's [prompt-format specification](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4)
  defines system-role and thinking controls. Verify the serving adapter's chat template and separated
  reasoning output. Ordinary conversation history should carry final responses, while tool-call
  sequences have different handling. Retain task decisions and evidence summaries rather than
  accumulating raw reasoning in subsequent ordinary turns.
- The [technical report](https://arxiv.org/html/2607.02770v1) reports different long-context results
  for retrieval, graph reasoning and other tasks. Context capacity is not a guarantee that each
  requirement is used correctly. Compare focused source bundles with additional distractors and
  varied requirement positions; reserve output capacity for complete files and thinking.
- The serving stack matters: [Ollama's thinking controls](https://docs.ollama.com/capabilities/thinking)
  are model-dependent, and [vLLM's Gemma recipe](https://docs.vllm.ai/projects/recipes/en/stable/Google/Gemma4.html#thinking-reasoning-mode)
  requires appropriate reasoning parsing and template configuration. Do not assume that an
  OpenAI-compatible endpoint implements every backend-specific control identically.
- A [first-person eight-task report](https://www.reddit.com/r/LocalLLaMA/comments/1slnhrd/gemma_4_31b_passed_78_realworld_production_tests/)
  reports seven successes, but used cloud inference and model judges. Treat its suggestions about
  explicit specifications as experimental hypotheses, not acceptance evidence for this local stack.
- An independent [DataRaceBench study](https://arxiv.org/abs/2606.14881) reports useful 31B repair
  results and inconsistent benefit from extra context. Its OpenMP tasks do not establish Java or
  React test-generation quality; they motivate checking that extra evidence actually helps.

Local metadata inspection finds the reference sampling values already configured, a 131,072-token
runtime context and an NVFP4 model with thinking enabled by default. This is deployment metadata,
not proof of effective parameters on each request or equivalence to Google's benchmark setup.
Record only allowlisted numerical settings and mode flags at the existing private lab observer;
keep prompt, skill, source and reasoning bodies out of diagnostic evidence.

This deployment advertises boolean thinking controls. In Ollama 0.35.1's
[OpenAI compatibility implementation](https://github.com/ollama/ollama/blob/v0.35.1/openai/openai.go),
recognized effort aliases enable thinking for boolean-only models; `none` disables it. Do not
present low/medium/high as three measured reasoning depths for this profile. Any on/off comparison
must use the compatible request field and confirm response reasoning metadata through LiteLLM.

Customer customization remains an editable section of each ordinary Markdown skill. Cover test
layout/names/language, AAA or Given/When/Then structure, installed assertion libraries, permitted
mock boundaries, required business cases and traceability, and delivery format. Explicitly adopted
customer conventions may refine these defaults; retrieved source text cannot widen authority.
Surface incompatible requirements instead of silently adding dependencies, suppressing types or
weakening assertions. The customer's private reference concept is not published in this repository.

Qualification adds convention adherence to compilation, correct-fixture execution and independent
defect detection. Use two contrasting synthetic customer profiles on an unchanged task, preserve
all attempts, and check observable naming, structure, imports, mock boundaries and required cases.
Keep plain generation and bounded diagnostic-driven repair results separate. A manually repaired
test is never counted as a successful unchanged generation.

## Completion criterion

Repeated declared and held-out cases pass, known material defects are repaired, applicable local
gates and current-head required CI pass, and actionable reviews are settled. Further changes need
measured benefit proportionate to their complexity. Record remaining limits and unexecuted cases;
neither this criterion nor any finite campaign proves universal error freedom.
