# Chat, Files and test-generation quality campaign

Status: planned qualification, not a closeout or a passing-result claim. Started 2026-10-16 from
`dev` commit `11abea703`. The campaign uses branch `codex/chat-files-quality` and one incrementally
updated pull request against `dev`.

Tracking: [Epic #4037](https://github.com/oscharko-dev/Keiko/issues/4037),
[execution task #4038](https://github.com/oscharko-dev/Keiko/issues/4038).

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
checkout. Public evidence contains reviewed counts, timings, digests and outcomes. Generated code
runs in disposable unprivileged containers with no network and bounded resources after dependencies
have been prepared. UI journeys use normal controls; direct API setup is labelled separately.

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

## Iteration and verification

1. Exercise the UI and record the outcome; read canonical Activity Log evidence first on failure.
2. Reproduce the defect at its owning layer and demonstrate a failing regression before the repair.
3. Repair the class through existing owners, with registered body-free observations and aligned docs.
4. Run the affected minimum-loop checks, mandatory local Sonar and touched-area gates from AGENTS.md.
5. Retest the browser case and relevant controls; commit/push a small coherent increment.
6. Update the PR description with actual changes, tests, limitations and findings; settle reviews.

No fixed wall-clock push deadline overrides required checks. Avoid accumulating unrelated repairs
in one increment. Product fixes declare their actual release impact. Required CI is the final full
matrix; it is not the local test loop. Merging and enabling auto-merge require separate authorization.

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

## Completion criterion

Repeated declared and held-out cases pass, known material defects are repaired, applicable local
gates and current-head required CI pass, and actionable reviews are settled. Further changes need
measured benefit proportionate to their complexity. Record remaining limits and unexecuted cases;
neither this criterion nor any finite campaign proves universal error freedom.
