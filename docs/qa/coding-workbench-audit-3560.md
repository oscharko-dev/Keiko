# Coding Workbench audit — #3560

Date: 2026-09-19. Delivery: draft PR #3561. This is an incremental audit record, not a
production-readiness sign-off. Product changes are developed in an isolated Keiko worktree;
live coding exercises target the owner's disposable `oscharko/Wegwerf-Repo-Final` repository.

## Runtime and upstream boundary

The approved runtime is OpenCode 1.18.30 (`scripts/portable-runtime-approvals.mjs` and
`packages/keiko-tool-catalog/src/dialect.ts`). Upstream
[1.18.31](https://github.com/anomalyco/opencode/releases/tag/v1.18.31) includes ACP session-option
restoration and startup error reporting fixes. These release notes alone do not qualify a
replacement of Keiko's pinned, verified sidecar.

The supplied [V2 migration guide](https://opencode.ai/v2/docs/migrate-v1/) explicitly changes the
server and plugin APIs. V2 also accepts LSP configuration without running language servers or
producing their diagnostics. Treat V2 as an integration migration with contract and confinement
qualification, not an interchangeable binary upgrade.

## Capability comparison

The [V1 server reference](https://opencode.ai/docs/server/) documents session/message persistence,
abort, todo lists, compaction, forks, reversions, commands, file lookup, and event streams.
Keiko's product authority remains the owner of all effects.

| Capability                                         | Keiko implementation / audit disposition                                                                                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation continuity                            | This PR adds local Coding History using the existing chat/message store, a separate rail window, rename, completion, reopening, and default continuation. Each turn still starts a fresh runtime with bounded historical context; this is not native OpenCode session resumption. |
| Planning and questions                             | Native todo/question activity is already projected into the governed Workbench. The new status bar distinguishes active work from a pending decision and can focus that decision.                                                                                                 |
| Workspace reads, search, edits and verification    | Existing governed tools replace native direct filesystem/shell access. Preserve that boundary; enabling native tools is not a safe feature shortcut.                                                                                                                              |
| Git and delivery                                   | Existing proposal/execution tools and review surfaces own stage, commit, push and draft PR operations. The audit still needs a complete successful live edit/build/delivery journey.                                                                                              |
| Context compaction                                 | The fixed launch profile supplies an explicit compaction policy and task-preservation prompt. Cross-turn History context is bounded separately to 24,000 characters. Long-history qualification remains open.                                                                     |
| Optional research, skills and child agents         | The production resolver filters the outgoing model tool catalog against current availability. Do not infer missing filtering solely from the optional launch-profile argument.                                                                                                    |
| File references, attachments and command shortcuts | Candidates for subsequent UI improvements; their contents, model capabilities and workspace scope need validation through existing Keiko paths. No native endpoint is exposed by this PR.                                                                                         |
| Fork and undo                                      | Native snapshots are disabled in the fixed profile. A future product action must preserve Keiko's workspace/change-review ownership and cannot simply call native revert.                                                                                                         |

## Reproduced and repaired

- First coding task in an accepted repository failed if the ordinary project catalog had no entry.
  History now registers that accepted repository before creating its first conversation.
- A manually bound repository lost its finished transcript when the desktop project differed.
  Session visibility now uses the active workspace's repository identity.
- Reload after creating a new task could restore the previous task. History selection is consumed,
  and automatic history restoration checks the active workspace identity.
- A deterministic task branch could collide with an existing branch from a previous installation.
  Setup retries once with a distinct task identity through the same verified binding workflow.
- Branch submission could race inventory loading. Both the button and form submission now require
  an available selection; lookup failures expose retry.
- A narrow Workbench could collapse the timeline beneath the composer, intercepting approval
  clicks. Its layout now preserves a scrollable timeline area.
- Branch error feedback failed the existing forced-colors contrast test. It now uses system colors
  in that mode; the same dark/light browser regression passes without an allowlist.
- Schema-35 migration fixtures and the store fingerprint inventory omitted the new relation
  tables. Both now include them; forbidden-field assertions pin their body-free schemas.

## Observed live results

An actual model run read the disposable repository's package and README files. A follow-up in the
same task correctly recalled the test label and build command without another read. Rename,
completion, reopening, New task, and reload were exercised through the browser. After New task
and reload the prior conversation remained in Completed history without appearing in the new task.

A separate earlier multi-file edit produced a malformed review preview and was rejected before
application. This remains an open audit finding; no successful application is claimed for it.

## Remaining qualification

- Repeated selection of the same history task, concurrent refreshes, and title synchronization.
- Paired-channel authentication and complete generic-chat isolation integration tests.
- Restart, interrupted capture, unavailable storage, and visible transcript completeness.
- Canonical multi-file patch review, effective autonomy presentation, and a real edit/build/PR run.
- Full affected release checks and review resolution. Per-run outcomes belong in the PR verification
  section; a passing local Sonar rule scan does not replace hosted coverage or required CI.
