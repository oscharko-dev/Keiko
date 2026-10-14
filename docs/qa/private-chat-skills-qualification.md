# Private Chat skills qualification (#4028)

This campaign qualifies the Chat implementation in #4022. OpenCode/Coding Workbench integration
belongs to #4025 under #3897. Use only the independently authored garden sensor fixtures in
`scripts/testing/chat-skills-lab/cases.mjs`; customer material is not a qualification input.

## Reuse and execution boundary

The small lab driver starts the actual BFF with an isolated SQLite store and existing launcher
pairing. It uses the production Model Gateway and the configured local LiteLLM service. The existing
lab forwarding proxy observes the serialized provider request; it retains only digests, counts,
completion states, timing and usage. The existing validated Activity Log reader and canonical
checkpoint reader supply context observations. No model port, response, compactor, token estimator
or permission decision is replaced.

The driver imports a synthetic skill and creates fresh chats. Manual/automatic compaction cases
include a real initial model turn and explicitly authored synthetic history through normal message
APIs. Those history messages are test setup, not claimed model output. The final response comes
from the real model. The automatic case uses a deliberately smaller configured context window of
8,192 tokens, below the deployment's verified native 131,072-token limit; other cases use the native
window. Record both limits. No capacity is widened to make a case pass.

Raw answers needed for private semantic review and test execution remain in a new owner-only
output directory outside the checkout. Do not publish that directory, its SQLite store, private
logs, config, prompts or responses. Published evidence consists only of reviewed body-free results.

## Predeclared cases

Each case runs three independent selected-skill chats and three matched no-skill controls. Controls
receive the same source concept and task; a correct control is a valid result, not a test failure.

| Case                            | Required observation                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `concept-plan`                  | Missing/invalid readings, both exact category boundaries, source basis and unresolved decisions                                 |
| `normative-status`              | Neither calibration proposal is approved; their conflict and owner remain open; barrel capacity is an example                   |
| `manual-compaction`             | Persisted checkpoint after the normal compaction API; complete identical skill once before and after                            |
| `automatic-compaction`          | Threshold-triggered persisted checkpoint; complete identical skill once before and after                                        |
| `restart-reselection`           | New BFF process restores the same immutable selection; explicit deselection/reselection remains consistent                      |
| `executable-tests`              | Generated test file typechecks, passes against the correct React application and detects an independent lower-boundary mutation |
| `grounded-manual-compaction`    | The same manual checkpoint and protected instruction checks through connected-file Chat, with authentic source citations        |
| `grounded-automatic-compaction` | The same automatic checkpoint and protected instruction checks through connected-file Chat, with authentic source citations     |

The separate `author` campaign runs document-to-skill generation three times. Check all confirmed
rules, both conflicting proposals, the non-binding example, both pending decisions, and source
references. Generation must finish normally with no saved enhancement evidence. Record every
attempt, including failed earlier candidates. HTTP success alone leaves `semantic-review-pending`;
only inspection of the actual answer can complete semantic acceptance.

## Run locally

Prerequisites: repository-supported Node, `npm install`, `npm run build:packages`, the existing local
LiteLLM/Gemma deployment, and credentials supplied privately through the environment. Do not print
or commit gateway configuration. Reserve the machine; do not overlap reference performance runs.

Set `KEIKO_SKILL_LAB_BASE_URL` to the loopback LiteLLM origin and `KEIKO_SKILL_LAB_API_KEY` from the
existing private credential. The driver verifies the served `gemma-4-31b-it` limits through model
metadata before dispatch. It does not modify the LiteLLM deployment or download another model.

```bash
mkdir -p "$HOME/keiko-skill-qualification"
export KEIKO_QUALIFICATION_OUTPUT="$HOME/keiko-skill-qualification/concept-plan-$(date +%s)"
node scripts/testing/chat-skills-lab/run.mjs concept-plan
```

Repeat with a fresh output directory for each case above and `author`. `setup` checks real BFF
startup, pairing, project registration and import; its ordinary automatic model-readiness probe may
call the model. It is not a dry-run mode. Source revisions and all physical attempts, including
readiness probes, must remain attributable in the qualification record.

For generated tests, prepare a separate Linux dependency tree with this checkout's lockfile using
`npm ci` in `node:24.18.0-bookworm`. Do not use macOS native dependencies in the Linux execution
container. Run the verifier for each selected and control answer:

```bash
node scripts/testing/chat-skills-lab/verify-tests.mjs \
  /private/qualification/response.private.md \
  /private/qualification/new-verification-directory \
  /private/linux-checkout/node_modules
```

The verifier extracts one TypeScript test fence without repairing its code. It runs TypeScript and
Vitest in a disposable unprivileged container with no network, a read-only root and dependency tree,
resource limits, and only synthetic inputs mounted. The independent mutant changes `< 20` to
`<= 20`. A compiler error, infrastructure failure or empty test suite is not mutation detection.

## Acceptance boundary

Browser regressions cover upload/select/send/compact/reload/deselect and document-to-skill
review/save/export/import, including existing keyboard and focus behavior. The live campaign must
also observe the real UI with the configured gateway, plain and grounded dispatch, protected
context accounting, overflow refusal before model dispatch, stale/deleted revisions, cancellation
and provider failure. Deterministic fault controls are reported separately from real-model successes.

The current implementation is a candidate until these observations, applicable complete local
gates and exact-head required CI are green. Issues remain open until an owner-authorized merge;
this qualification grants no merge or auto-merge authority.

## Acceptance map

Use the current complete local and CI results together with the real-model ledger. A test path
below identifies the behavior owner; listing it alone is not a passing result or issue closeout.

| Issue / criteria | Owning proof                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #4023 AC1, AC3   | `store/markdownSkills.test.ts`, `store/markdownSkillSelections.test.ts`: normalized round trip, restart, immutable revisions, duplicates and transaction conflicts                             |
| #4023 AC2, AC4   | `markdown-skill-routes.test.ts`, `store/forbidden-fields.test.ts`: bounded upload/encoding, paired-session enforcement, content-free metadata and no import-time dispatch                      |
| #4023 AC5, AC6   | Store failure regressions, registered Activity Log gate, existing built-in skill/catalog and workflow suites                                                                                   |
| #4024 AC1–AC3    | `markdown-skill-prompt.test.ts`, `chat-gateway-assembly.test.ts`, `chat-context-breakdown.test.ts`, `chat-context-status.test.ts`; actual manual/automatic plain and grounded compaction cases |
| #4024 AC4        | Plain/stream/regenerate handler suites and grounded single-folder, multi-folder, hybrid and Knowledge handler suites, including paired and no-skill controls                                   |
| #4024 AC5–AC7    | `markdown-skill-selection-admission.test.ts`, immutable turn-binding/dispatch guards and live fault controls; existing authority, egress and evidence checks                                   |
| #4026 AC1–AC4    | `MarkdownSkillControl.test.tsx`, chat session/streaming/context meter/API tests and `chat-send.smoke.spec.ts`; actual upload, send, compaction, reload and deselection                         |
| #4026 AC5, AC6   | Native file-chooser and long-preview keyboard/axe browser checks; German/English light/dark/narrow visual inspection; synthetic-only fixtures and body-free diagnostics                        |
| #4027 AC1–AC4    | `MarkdownSkillAuthor.test.tsx`, prompt-enhancer workflow/routes/contracts suites and browser author/review/save/export/reimport journey                                                        |
| #4027 AC5, AC6   | Gateway-only, no-evidence-body authoring regressions and three independently reviewed real document-to-skill generations; proposals/examples/open decisions checked separately                 |
| #4028 AC1–AC6    | The predeclared live campaign, real UI journey, matched controls, offline generated-test execution against correct and independently mutated applications, and fault controls                  |
| #4028 AC7, AC8   | Complete local release gates, exact-head app-bound CI, settled reviews, verified owner-authorized integration and public-artifact privacy review                                               |

Server test paths above are relative to `packages/keiko-server/src/`; UI tests live under
`packages/keiko-ui/src/`; the browser suite is under `tests/e2e/`. OpenCode remains outside this
acceptance map and is owned by #4025 under #3897.

## Observed candidate results

The body-free [live execution ledger](private-chat-skills-live-evidence.json) retains every
recorded campaign and physical attempt, including readiness probes, failed candidates and controls.
Source heads, working-diff and harness digests identify what each run actually exercised. An earlier
runtime proof is retained only when later changes did not alter that behavior; final deterministic
and browser gates cover the complete candidate. This is local live-provider evidence, not an
all-platform certification or a guarantee of model correctness.

| Scenario                                  | Selected skill                 | Matched controls                                                 | Qualification campaign                       |
| ----------------------------------------- | ------------------------------ | ---------------------------------------------------------------- | -------------------------------------------- |
| Concept-only test planning                | 3/3 required assertions        | 3 observed; one overstates a proposed implementation task        | `concept-plan-candidate-01`                  |
| Confirmed rules versus proposals/examples | 3/3                            | 3/3 preserve normative status                                    | `normative-status-candidate-03`              |
| Manual compaction, plain Chat             | 3/3                            | 3/3 core facts preserved                                         | `manual-compaction-candidate-02`             |
| Automatic compaction, plain Chat          | 3/3                            | 3/3 core facts preserved                                         | `automatic-compaction-candidate-03`          |
| Process restart, deselection/reselection  | 3/3                            | 3/3 core facts preserved                                         | `restart-reselection-candidate-04`           |
| Generated tests, unedited execution       | 3/3                            | 1/3 execution; one passing control loses open-decision semantics | `executable-tests-candidate-05`              |
| Manual compaction, connected-file Chat    | 3/3                            | 3/3 core facts preserved                                         | `grounded-manual-compaction-candidate-05`    |
| Automatic compaction, connected-file Chat | 3/3                            | 3/3 core facts preserved                                         | `grounded-automatic-compaction-candidate-04` |
| Complete-document skill drafting          | 3/3 required source assertions | Not a selected-skill comparison                                  | `author-candidate-04`                        |

The generated selected-skill tests passed 14, 17 and 15 tests respectively against the correct
application, with both compiler and runtime checks. Each rejected an independently introduced
boundary defect with two failed assertions and no runtime error. Generated code was not repaired.
The controls remain part of the result: two fail because multiple component renders in one test
leave ambiguous status elements. This small sample supports the usefulness of explicit testing
instructions, not a statistically established general advantage.

Protected-context cases observed actual persisted history checkpoints, unchanged complete skill
content exactly once in the final model requests, reconciled token contribution and no skill body
in the summary. Some optional model-summary attempts exceeded their existing 15-second budget; the
product retained its deterministic checkpoint and recorded the failed refinement. These interrupted
physical calls are not counted as model successes, and absent token usage remains unknown.
The original synthetic method contributes 697 estimated context tokens; a later
revision adds explicit React test-isolation guidance and contributes 813. Request/harness digests
separate those inputs. Automatic cases deliberately use an 8,192-token configured window within the
verified native 131,072-token capacity; this is not a model-capacity increase.

Draft review remains necessary. All three final authoring results retain the required confirmed
rules, conflicting proposals, example and open decisions. One draft's output-format paragraph lists
only valid-reading categories while earlier steps retain missing/invalid handling; this editorial
ambiguity is recorded for human clarification. Structural validity alone is not semantic approval.

### First-use experience

The built 1.2.2 UI passed the complete live journey (`ui-complete-candidate-04`): native file
chooser, upload, preview, explicit selection, two real streamed answers around manual compaction,
reload, deselection, source-file upload, model-generated draft, manual edit, explicit save, exact
Markdown download, deletion and reimport. Neither upload nor save activates a skill. Both answers
and the generated draft were inspected for the actual source rules and open decisions. The named
preview supports keyboard scrolling; light/dark axe checks found no violations. German/English
and 390 px layout inspection found no horizontal overflow or escaped modal focus. The complete
affected browser lane passed 109 tests.

The live fault campaign (`fault-controls-candidate-03`) passed all 14 controls: malformed base64,
invalid UTF-8, oversized upload, stale selection, three unpaired revision forms, protected overflow
with its exact error, revoked selection with its exact error, cancellation without a persisted
assistant answer, and a visible 503 after the two injected provider interruptions. Refused requests
made no model dispatch. Both interruption attempts retained the complete selected skill.

### Earlier failures and corrections

- The first document-to-skill candidate omitted one non-binding example in one of three runs.
  Complete-source instructions were strengthened and all three repeated drafts were inspected.
- The first manual-compaction classifier incorrectly counted a historical task inside the summary
  as another final answer request. Actual request classification was corrected; the rejected
  campaign remains recorded.
- Five candidate-03 campaigns stopped before runtime startup because synchronous Git diff capture
  exceeded its buffer. Provenance now streams directly into a digest, and the regression failed
  before and passed after that repair. Those attempts made no model call.
- The first executable-test campaign passed only two of three selected outputs. One generated test
  repeatedly mounted components within one test without cleanup. The synthetic skill now states
  the isolation rule explicitly; all three new outputs pass without editing their code.
- One grounded manual campaign was interrupted by confirmed host sleep. It also exposed a macOS
  temporary-directory alias in the lab's state path; the existing vault correctly refused that
  unsafe target. The lab now canonicalizes its own directory, preserving the vault guard, and
  the campaign was repeated. Interrupted cases are not credited as passes.
- Real long-preview accessibility testing found a scroll pane without keyboard focus. It is now a
  named, focusable region with visible focus styling. The regression failed before and passed
  after; the actual built UI passed keyboard scrolling and axe. A subsequent harness attempt
  closed the dialog before checking focus and is retained separately.
- The first complete UI driver waited indefinitely for Playwright's SSE `response.finished()` after
  the server had completed. It now observes the actual terminal UI and physical request completion.
- A second UI attempt correctly completed both answers but its exact question matcher did not
  account for the existing rich-text composer normalizing paragraph breaks. The corrected driver
  matches the unique task sentence, separately checks source text modulo paragraph spacing, and
  still checks the skill body byte-for-byte. Another driver iteration read a generic correlation
  header instead of the existing `x-keiko-correlation-id`; using the canonical header restored
  validated checkpoint correlation. Original failed attempts remain recorded.
- The deleted-selection fault control initially expected a not-found status. The established store
  contract uses HTTP 409 with `INVALID_REQUEST` for a revoked selected revision. The driver now
  checks that exact contract and still requires no model dispatch.
- The first unpaired fault-control request lacked the normal CSRF header, testing the earlier CSRF
  rejection instead of skill admission. The corrected control supplies only that non-authorizing
  header and still omits pairing.
- CI exposed stale historical support inventory, a relative documentation URL in the published
  README, missing explicit lab entry points in unused-code analysis, and an ambiguous browser
  selection after a fixture left another library item. Each was reproduced locally and repaired.
  Infrastructure-only runner network failures remain distinct from product regressions.

### Gate boundary

The final command results, complete coverage counts and exact-head CI links are recorded in
[PR #4029](https://github.com/oscharko-dev/Keiko/pull/4029). This document records observed behavior;
it is not a substitute for the required checks or a claim that a pending release has shipped.

The full host coverage run also exposed the debug-launch test's exact toolchain requirement:
Node 24.21 fails that existing check, while the already available, approved Node 24.18/npm 11.16
pair passes all 44 tests. The runtime archive checksum matches the repository approval. The full
release-quality chain is repeated with that exact pair; the host failure is not a product pass.

The local host's Node 24.21 gzip fingerprint differs from the pinned Node 24.18 reference runtime.
The unchanged static export passes the actual reference-container bundle gate (fingerprint
`941f375e53084f5fa48874e97e1ce2c4fdec7510de52972b9e1bc0c0b134c2ca`); a host fingerprint is not
substituted for that evidence. The six-run D12 reference measurement and its regression explanation
are retained in the existing performance evidence and PR.

Protected integration and release are separate observations: required app-bound checks must pass
on the exact final PR head and all review conversations must be resolved. Only then may the already
authorized owner integration proceed. The delivered-head verification and publication result are
recorded on the governing issues after they actually occur.
