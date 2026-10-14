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
