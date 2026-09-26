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
by a run. The run's Authority Envelope independently accounts for cumulative prompt usage.

A deployment operator may set `KEIKO_CODING_RUNTIME_MAX_PROMPT_TOKENS` before starting the server.
The default remains 200,000; an explicit decimal integer from 1 through 2,000,000 is accepted.
Invalid values fail closed. This setting is copied into each newly minted envelope and reported as
`maxPromptTokens` on the existing `coding-runtime.authority.minted` activity event. It does not
change a live or exhausted envelope, the 30-minute duration, the tool/patch ceilings, or a configured
Model Gateway spend limit. A larger accepted task can start with a deliberately configured allowance;
an exhausted run requires a fresh accepted run and preserves its workspace through normal recovery.

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
