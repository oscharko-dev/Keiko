# Coding Workbench Autonomy QA Matrix

Status: Issue #1994 closeout evidence for epic #1982.

This matrix proves the Coding Workbench can be reviewed as one regulated delivery surface after
children #1986, #1987, #1995, #1988, #1989, #1990, #1991, #1992, and #1993 have merged into
`epic/coding-workbench-opencode-codex`.

## Baseline And Integration State

| Area                     | Evidence                                                  | Result                                                                                                                        |
| ------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Epic branch              | `epic/coding-workbench-opencode-codex`                    | Long-lived integration branch for the final epic PR to `dev`; no agent merge to `dev` is authorized.                          |
| Current child branch     | `issue/1994-coding-autonomy-qa-matrix`                    | Cut from verified epic head `08acbd3af4cb19a8799440f7e2492deb05dbfaa2`.                                                       |
| Temporary portable base  | PR #2041 `epic/portable-product-delivery-v2`              | Earlier green portable baseline is already in the epic history; this is an intentional temporary baseline for #1982.          |
| Latest #2041 head policy | `68cd4de98bbf02033d6ab8def148ec57ee9c9c8e` at #1994 start | Not merged because checks were still in progress at inspection. Recheck and merge only after the full status rollup is green. |
| Final PR policy          | Epic PR targets `dev`                                     | Open as a draft even after green checks; user wants updater v2 merged first for clean history.                                |
| User-facing gate         | `tests/e2e/coding-workbench-1994.spec.ts`                 | Runnable Playwright coverage for Autonomous Delivery closeout states, redaction, responsive layout, and axe checks.           |

## Child Evidence Ledger

| Child | Integrated evidence                                                                                   | Closeout settlement                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| #1986 | Contracts, mode policy, Authority Envelope, runtime events, evidence types via PR #2051 / `41795f05`. | Product authority is explicit, schema-bound, and mode-resolved.                                           |
| #1987 | Coding-safe Model Gateway endpoint via PR #2061 / `d0e75c1a`.                                         | Sidecar model traffic routes through Keiko-owned gateway projection without exposing provider secrets.    |
| #1995 | ChatGPT/Codex subscription profile via PR #2064 / `79504d49`.                                         | Subscription path is separate from OpenCode and does not project credentials into browser or sidecar UI.  |
| #1988 | Runtime manager and OpenCode-compatible adapter lifecycle via PR #2069 / `e759272a`.                  | Runtime launch stays inside Keiko-managed sidecar paths and fails closed on unmanaged executables.        |
| #1989 | GitHub/Jira coding context intake with redacted evidence via PR #2078 / `e15df417`.                   | Connector reads and writes remain policy-scoped and content-free.                                         |
| #1990 | Coding Workbench shell, sidebar entry, mode selector, timeline via PR #2080 / `8af4e82c`.             | UI surface is first-class and does not gain direct runtime authority.                                     |
| #1991 | Governed Assist read/plan/diff proposal via PR #2082 / `ae380440`.                                    | Governed Assist cannot mutate files, shell, git, connector state, or delivery substrate.                  |
| #1992 | Supervised Coding scoped edits, verification, approval prompts via PR #2086 / `7921a21f`.             | Delivery and external writes require just-in-time approval, with stop/failure states visible.             |
| #1993 | Autonomous Delivery envelope execution, PR creation, conflict recovery via PR #2124 / `08acbd3a`.     | Issue-to-PR execution is bounded by confirmed Authority Envelope, branch scope, policy, and verification. |
| #1994 | This closeout matrix, runbook, UI evidence, and focused closeout tests.                               | Proves the integrated epic is shippable for regulated review before the draft epic PR to `dev`.           |

## Mode And Boundary Matrix

| Boundary              | Governed Assist                                        | Supervised Coding                                                | Autonomous Delivery                                                                                  | Primary automated evidence                                                                                                                |
| --------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| File/workspace writes | Denied except read and diff proposal.                  | Allowed only for scoped work.                                    | Allowed only inside confirmed envelope and branch constraints.                                       | `packages/keiko-contracts/src/coding-workbench.test.ts`; `packages/keiko-server/src/coding-runtime/codingAutonomyQaMatrix.test.ts`.       |
| Shell/commands        | Denied except verification projection.                 | Verification commands allowed; delivery commands approval-gated. | Governed command tasks allowed only with command authority and budget.                               | `codingRuntimeManager.test.ts`; `autonomousDeliveryPolicy.test.ts`; `codingAutonomyQaMatrix.test.ts`.                                     |
| Git delivery          | No commit, push, PR, merge, or force-push authority.   | Commit/push/PR require prompt approval; merge remains blocked.   | Commit/push/PR can be executed only through delivery substrate; merge and force-push remain blocked. | `packages/keiko-server/src/coding-runtime/autonomousDeliveryPolicy.test.ts`; `codingAutonomyQaMatrix.test.ts`.                            |
| Connector writes      | Write-capable scopes denied.                           | Write scopes are prompt-gated.                                   | Writes require connector scope, network scope, and task-ref binding.                                 | `packages/keiko-server/src/coding-runtime/autonomousDeliveryPolicy.test.ts`; `packages/keiko-server/src/code-context-connectors.test.ts`. |
| Model traffic         | Keiko Model Gateway only for OpenCode-compatible path. | Same gateway boundary; no provider credentials in UI evidence.   | Same gateway boundary for managed provider/API-key traffic; subscription traffic uses Codex adapter. | `packages/keiko-server/src/coding-sidecar-gateway.test.ts`; `packages/keiko-server/src/coding-codex-subscription.test.ts`.                |
| Portable sidecar      | Optional read-only runtime path.                       | Managed sidecar launch only; unmanaged executable denied.        | Managed sidecar launch only; portable update verifies sidecar payloads as whole-product assets.      | `packages/keiko-server/src/coding-runtime/codingRuntimeManager.test.ts`; `scripts/__tests__/portable-runtime.test.mjs`.                   |
| Evidence              | Content-free summaries only.                           | Content-free approval, verification, and failure evidence.       | Content-free permission, delivery, connector, and failure evidence.                                  | `validateCodingWorkbenchEvidenceRecord`; `coding-sidecar-gateway.test.ts`; `codingAutonomyQaMatrix.test.ts`; Playwright redaction checks. |
| Authority Envelope    | Not enough authority for mutation.                     | Prompt authority does not imply delivery autonomy.               | Required; unconfirmed, expired, over-budget, branch escape, scope drift, and policy rejection deny.  | `packages/keiko-server/src/coding-runtime/autonomousDeliveryPolicy.test.ts`; `codingAutonomyQaMatrix.test.ts`.                            |
| UI/a11y/visual states | Governed diff and blocked states covered.              | Approval, approved, denied, stopped, and failed states covered.  | Confirmed, policy hold, verification failure, completed handoff, and narrow viewport states covered. | `tests/e2e/coding-workbench-1991.spec.ts`; `coding-workbench-1992.spec.ts`; `coding-workbench-1994.spec.ts`.                              |

## Deterministic Verification Commands

Run the focused closeout gates:

```sh
npx vitest run \
  packages/keiko-server/src/coding-runtime/codingAutonomyQaMatrix.test.ts \
  packages/keiko-server/src/coding-runtime/autonomousDeliveryPolicy.test.ts \
  packages/keiko-server/src/coding-runtime/codingRuntimeManager.test.ts \
  packages/keiko-server/src/coding-sidecar-gateway.test.ts \
  packages/keiko-server/src/coding-codex-subscription.test.ts
npm --workspace @oscharko-dev/keiko-ui run test -- \
  src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.test.tsx
npm run test:e2e:coding-workbench-1994
```

Regenerate tracked user-facing evidence:

```sh
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:coding-workbench-1994
```

Run final child gates before opening the child PR:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run arch:check
npm run arch:check:negative
.keiko-scripts/verify-receipt.sh 1994
.keiko-scripts/ui-verify-receipt.sh 1994 -- npm run test:e2e:coding-workbench-1994
.keiko-scripts/audit-receipt.sh 1994 --findings 0 --user-facing true
```

Run final integrated epic gates after #1994 merges into the epic branch and after the latest green
#2041 baseline and latest `origin/dev` are integrated:

```sh
npm run test:e2e:coding-workbench-1990
npm run test:e2e:coding-workbench-1991
npm run test:e2e:coding-workbench-1992
npm run test:e2e:coding-workbench-1994
.keiko-scripts/verify-receipt.sh 1982
.keiko-scripts/ui-verify-receipt.sh 1982 -- npm run test:e2e:coding-workbench-1994
.keiko-scripts/audit-receipt.sh 1982 --findings 0 --user-facing true
```

## Known Limitations And Follow-Ups

- The final epic PR must remain draft until the updater v2 epic is merged into `dev`.
- The latest PR #2041 head must be rechecked and integrated only after its full status check rollup
  is green. Draft state does not block this baseline refresh, but pending or failed checks do.
- Autonomous Delivery still does not merge protected branches by default. Merge authority remains a
  future explicit policy decision.
- Confluence coding context remains intentionally deferred; #1989 closes GitHub and Jira context only.
- Human visual review remains required on the final draft epic PR for subjective design-system
  fidelity; the Playwright gate covers deterministic UI/a11y assertions.
