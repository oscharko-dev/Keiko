# Coding Workbench Operator Runbook

Status: operator and maintainer runbook for epic #1982 closeout.

## Purpose

Use this runbook when reviewing or operating the Coding Workbench. The workbench is a governed coding
surface, not a background daemon. Browser UI, sidecar runtime, model routing, repository writes,
connector writes, and evidence stores remain separated by Keiko-owned contracts.

## Operating Modes

| Mode                | Use when                                                         | Authority                                                                                  | Stop condition                                                                                 |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Governed Assist     | The operator wants plans, repository reads, and diff proposals.  | Read, verification projection, and read-only connector context.                            | Any file write, shell mutation, connector write, delivery, merge, or force-push.               |
| Supervised Coding   | The operator wants scoped edits with explicit delivery approval. | Scoped file edits and verification; commit, push, PR, external writes require approval.    | Delivery action without prompt approval, raw evidence, or missing stop control.                |
| Autonomous Delivery | The operator wants bounded issue-to-PR execution.                | Confirmed Authority Envelope, branch allowlist, connector scope, verification, PR gateway. | Missing/expired envelope, branch escape, missing scope, failed verification, or operator stop. |

Autonomous Delivery can create or update a PR only through the governed gateway. It must not merge
to `dev`, push outside the envelope branch, force-push, or mutate connector objects outside the
declared task references.

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

Before an Autonomous Delivery run starts, verify:

- The task reference names the issue being worked.
- The base and head branches match the intended branch pair.
- Allowed prefixes cover only the intended issue branch family.
- The effective mode is `autonomous-delivery`.
- The runtime source is `delivery-runner`.
- The model source is `keiko-model-gateway` for the managed sidecar path.
- Action classes include only the authorities needed for the run.
- Connector scopes include only the target source-control or issue-tracker scopes.
- The network policy is connector-scoped egress, not broad browser access.
- Gates include human approval, branch allowlist, verification-green, and policy review.
- The approval proof digest matches the operator-confirmed envelope.
- The expiry and budgets are short enough for the bounded run.

## Stop And Takeover

- The operator can stop a running sidecar from the workbench.
- A stopped run records content-free stop status and must not continue writing files, commands, git
  state, connector state, or PRs.
- Manual takeover means the operator continues outside Autonomous Delivery authority; any later
  automation must start from a fresh envelope and fresh verification.
- If verification fails, Autonomous Delivery stops before PR handoff.
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

## Review Commands

Run focused closeout checks:

```sh
npx vitest run \
  packages/keiko-server/src/coding-runtime/codingAutonomyQaMatrix.test.ts \
  packages/keiko-server/src/coding-runtime/autonomousDeliveryPolicy.test.ts \
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
