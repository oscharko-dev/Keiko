# Coding Workbench Operator Runbook

Status: current operator and maintainer runbook. ADR-0125 supersedes the original Epic #1982
blanket-write semantics.

## Purpose

Use this runbook when reviewing or operating the Coding Workbench. The workbench is a governed coding
surface, not a background daemon. Browser UI, sidecar runtime, model routing, repository writes,
connector writes, and evidence stores remain separated by Keiko-owned contracts.

## Operating Modes

The machine values remain stable for wire compatibility. Operators use the three display labels
(semantics per
[ADR-0138](../adr/ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md)):

<!-- The first table row below is byte-pinned by codingAutonomyQaMatrix.test.ts; keep its exact
     single-space cell padding, so the table is excluded from Prettier's column alignment. -->
<!-- prettier-ignore -->
| Display mode | Machine value | Allowed without another prompt | Approval required |
| --- | --- | --- | --- |
| **Ask for approval** | `governed-assist` | Reads and planning | Workspace edits and commands, external files, internet, and delivery at every risk |
| **Supervised workspace** | `supervised-coding` | Low/medium-risk workspace-contained edits, vetted commands, and verification | High/critical-risk workspace-contained actions; external files, internet, and delivery at every risk |
| **Full access** | `autonomous-delivery` | Workspace, external-file, and internet actions inside the validated Authority Envelope | Delivery at every risk |

Mode selection never overrides the effective-mode deployment ceiling, Authority Envelope,
workspace and branch scope, deny lists, secret-exfiltration checks, platform restrictions, expiry,
or budgets. An unknown or missing mode falls back to **Ask for approval**; missing, invalid, or
expired required authority is denied.

Commit, push, pull-request creation, and merge are delivery actions. They use the governed delivery
gateways and require separate explicit human approval in all three modes. **Full access** does not
authorize force-push, branch escape, or connector mutation outside declared task references and
scopes.

## Runtime And Model Routing

- The bundled OpenCode-compatible path launches from Keiko-managed sidecar payloads under the
  portable-managed install root.
- Customer machines must not require a global OpenCode install for the bundled path.
- Managed provider and API-key traffic goes through the local Keiko Model Gateway endpoint.
- ChatGPT/Codex subscription traffic uses the separate Codex runtime/profile path and must never be
  projected into OpenCode as provider credentials.
- Browser code must not read provider endpoints, API keys, subscription tokens, raw auth files, sidecar
  executable paths, or customer repository paths.

## Authority Envelope Checklist

Before any governed coding run starts, verify:

- The task reference names the issue being worked.
- The base and head branches match the intended branch pair.
- Allowed prefixes cover only the intended issue branch family.
- The requested and effective mode match the intended display mode and deployment ceiling.
- The runtime source is appropriate for the task; delivery work uses `delivery-runner`.
- The model source is `keiko-model-gateway` for the managed sidecar path.
- Action classes include only the authorities needed for the run.
- Connector scopes include only the target source-control or issue-tracker scopes.
- The network policy is connector-scoped egress, not broad browser access.
- Gates include the human-confirmed envelope and every action-specific branch, verification, and
  policy gate required by the granted classes.
- The approval proof digest matches the operator-confirmed envelope.
- The expiry and budgets are short enough for the bounded run.

## Stop And Takeover

- The operator can stop a running sidecar from the workbench.
- A stopped run records content-free stop status and must not continue writing files, commands, git
  state, connector state, or PRs.
- Manual takeover means the operator continues outside the run's Authority Envelope; any later
  automation must start from a fresh envelope and fresh verification.
- If verification fails, automated delivery stops before PR handoff.
- If policy denies a scope, the correct recovery is to adjust the envelope or mode deliberately, not
  to retry through a lower-level tool.

## Evidence Rules

Evidence may contain:

- Schema version, run id, mode, runtime source, model source, artifact label, safe summary, digest,
  denial flag, counts, and content-free state labels.

Evidence must not contain:

- Raw prompts, raw model output, raw diffs, repository file contents, command stdout/stderr, issue
  bodies, PR bodies, provider endpoints, credentials, private URLs, token-bearing strings, or private
  filesystem paths.

## Context and cumulative prompt allowance

The selected model's context allowance limits one model request. OpenCode compaction reduces
conversation history for subsequent requests; it does not erase the prompt tokens already consumed
by a run. The run's Authority Envelope independently accounts for cumulative prompt usage and for
elapsed time. Every turn re-sends the whole conversation, so cumulative usage grows with the square
of the turn count: in the live Gemma qualification (#3873) an ordinary six-file ESLint repair on a
slow self-hosted model reached 200,000 cumulative tokens in 17 turns and 27.5 minutes with no
refused edit.

Two operator settings bound every newly minted envelope. Set them before starting the server; both
are read once when the coding runtime is composed, before it activates, so a running Keiko keeps its
old value until it is restarted (the Workbench's limit messages say so, and name the maximum below).
An invalid value, or one above the maximum, stops that composition with a `RangeError` instead of
minting a silently defaulted envelope (fail closed):

| Setting                                     | Meaning                                            | Default   | Accepted values                       |
| ------------------------------------------- | -------------------------------------------------- | --------- | ------------------------------------- |
| `KEIKO_CODING_RUNTIME_MAX_PROMPT_TOKENS`    | Cumulative prompt-token allowance of one run       | 2,000,000 | decimal integer 1 through 20,000,000  |
| `KEIKO_CODING_RUNTIME_MAX_DURATION_MINUTES` | Envelope duration (`maxRuntimeMs` and `expiresAt`) | 120       | decimal integer 1 through 480 minutes |

Both are copied into each newly minted envelope and reported body-free as `maxPromptTokens` and
`maxRuntimeMs` on the existing `coding-runtime.authority.minted` activity event. Neither changes a
live or exhausted envelope, the tool/patch ceilings, or a configured Model Gateway spend limit. The
safe-activity feed is retained for the configured duration plus a margin, and one submitted task's
whole agent loop is bounded by the same duration; per-request provider deadlines are unchanged. A
run that exhausts either bound fails closed at its next delegation
(`coding-sidecar.gateway.rejected` with `runtime-prompt-budget-denied`, or an expired authority); it
requires a fresh accepted run and preserves its workspace through normal recovery. Lower a bound
deliberately for a constrained deployment; the former 200,000-token / 30-minute defaults ended
ordinary multi-file work on a slow self-hosted model.

A run that ends on one of its bounds settles `failed` with a cause of its own instead of an internal
error (#3873, ADR-0137 D3): `prompt-allowance-exhausted` when the allowance refused its last model
call, `envelope-duration-exhausted` when its envelope ran out of time (`coding-runtime.run.settled`
with `failureBasis` `prompt-allowance` or `envelope-duration`), and the Workbench names the bound and
the next step. The same settled line carries the run's effort roll-up (`wallDurationMs`,
`modelTurnCount`, `promptTokensTotal`, `toolInvocationCount`, `editRefusedCount`, `operatorWaitMs`
and the other counts and durations of ADR-0137 D3), so a bound a run used up can be read against the
model turns and tool calls that used it.

The output allowance of one model request (`maxOutputTokens` on
`coding-sidecar.gateway.request-validated`, and OpenCode's `limit.output`) is not an operator
setting; it is derived by this rule (#3873, F17): a coding turn reserves at least 16,384 output
tokens unless the provider-declared `max_output_tokens` (LiteLLM's `/model/info`, or the operator's
model configuration) or the prompt-admission arithmetic (`maxPromptTokens` minus the estimated
prompt minus the safety margin) is smaller, and never more than a quarter of the model's window.
Before this rule a coding turn was sent the shared chat profile's reserve (one sixteenth of the
window, 8,192 of 131,072 tokens), which a reasoning model spent before its first tool call; chat and
every other surface keep that chat reserve. A reasoning model that spends the whole
allowance without a tool call gets one steered repair from the gateway
(`gateway.retry.scheduled reason=output-exhausted-repair`); a second exhaustion ends the turn as
final (`coding-sidecar.gateway.turn-failed failureCode=output-exhausted runtimeRetry=refused
repairOutcome=exhausted-again`). See the LiteLLM troubleshooting entry "Coding Workbench turn
reasons until its output budget is exhausted". A turn that ends after reasoning with no tool call or
text gets the same one repair (`reason=empty-answer-repair`, a second empty answer is final with
`repairOutcome=empty-again`, and the sidecar never resends a failed turn's reasoning upstream), see
"Coding Workbench turn ends after reasoning without a tool call or text, again and again" (#3873, F23).

## Repository working instructions

A run's initial turn carries the task workspace's own `AGENTS.md` (workspace root only, exact name,
no symlink) as bounded, labelled, untrusted context beside the project memory: the window
`keiko_workspace_read` would answer for the first 800 lines, cut at a line boundary to 16,384 bytes
and to the turn's remaining prompt budget, with one explicit truncation line when cut, read through
the same secure read helper only while the run's own workspace is the active one (a workspace
switch while the run starts records `refused`, `workspace-unavailable`), and nonce-framed so it
grants no authority, cannot close its frame early, and cannot be forged by an issue body or memory
(ADR-0137 D1). It is on by default; an operator sets
`KEIKO_CODING_REPOSITORY_INSTRUCTIONS_ENABLED=false` before starting the server to disable it, and
any other explicit value fails closed at composition. The existing
`coding-runtime.repository-instructions.context` activity event records the outcome per run
(`attached`, `truncated`, `absent`, `disabled`, `refused`) with the attached byte and line counts,
the file's total counts when cut, and the whole-file digest the read tool reports, never the
content. The helper's content ceiling of 65,536 bytes is pinned in its wire protocol and native
binary: a larger `AGENTS.md` is refused as `too-large` (at `warn`, the run proceeds) until the
helper protocol gains a bounded window, so keep the file under 64 KiB for it to reach the model.

## Review Commands

Run focused closeout checks:

```sh
npx vitest run \
  packages/keiko-server/src/coding-runtime/codingAutonomyQaMatrix.test.ts \
  packages/keiko-server/src/gitDelivery/runBoundAuthority.test.ts \
  packages/keiko-server/src/gitDelivery/approvalStore.test.ts \
  packages/keiko-server/src/coding-runtime/codingRuntimeManager.test.ts \
  packages/keiko-server/src/coding-sidecar-gateway.test.ts \
  packages/keiko-server/src/coding-codex-subscription.test.ts
npm run test:e2e:coding-workbench-1994
```

Run the user-facing receipt command before child merge:

```sh
.keiko-scripts/ui-verify-receipt.sh 1994 -- npm run test:e2e:coding-workbench-1994
```

Run the final integrated user-facing receipt after #1994 is merged into the epic branch:

```sh
.keiko-scripts/ui-verify-receipt.sh 1982 -- npm run test:e2e:coding-workbench-1994
```

## Handoff Policy

- Keep #1982 open and In Progress until all child issues are closed and the draft epic PR exists.
- Close child #1994 only after its PR has merged into `epic/coding-workbench-opencode-codex` and
  closure evidence is posted.
- Open the final epic PR to `dev` as a draft. Do not mark it ready until the updater v2 epic is
  merged into `dev` and the operator explicitly approves the transition.
- Do not merge the epic PR to `dev` without explicit human authorization.
