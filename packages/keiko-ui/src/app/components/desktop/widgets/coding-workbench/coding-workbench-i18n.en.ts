export const EN_CODING_WORKBENCH_MESSAGES = {
  "codingWorkbench.journey.title": "Issue handoff",
  "codingWorkbench.journey.state.awaiting-ready-approval": "Ready-for-review approval required",
  "codingWorkbench.journey.state.keiko-technical-ready": "Keiko technical work ready",
  "codingWorkbench.journey.state.ready-for-human-review": "Ready for human review",
  "codingWorkbench.journey.state.awaiting-human-requirements": "Human review requirements remain",
  "codingWorkbench.journey.state.merged-awaiting-issue-closure": "Merged; issue closure pending",
  "codingWorkbench.journey.state.completed": "Issue journey completed",
  "codingWorkbench.journey.state.blocked": "Handoff blocked",
  "codingWorkbench.journey.state.cancelled": "Handoff cancelled",
  "codingWorkbench.journey.state.recovery-required": "Handoff reconciliation required",
  "codingWorkbench.journey.state.stale": "Handoff observation is stale",
  "codingWorkbench.journey.staleHelp":
    "These are dated observations. Refresh the status before relying on current readiness or issue closure.",
  "codingWorkbench.journey.refresh": "Refresh observed status",
  "codingWorkbench.journey.proposeReady": "Review ready-for-review request",
  "codingWorkbench.journey.readyHelp":
    "Review the change from draft to ready for review before approving it once.",
  "codingWorkbench.journey.proposeReadyPending":
    "The ready-for-review approval path is not available yet.",
  "codingWorkbench.journey.changedFiles": "{count} changed files",
  "codingWorkbench.journey.changedFilesTruncated": "(list truncated)",
  "codingWorkbench.journey.busy": "Updating handoff status…",
  "codingWorkbench.journey.actionError.refresh":
    "Status refresh failed ({reason}). The saved observations remain visible.",
  "codingWorkbench.journey.actionError.propose-ready":
    "The ready-for-review request failed ({reason}). Refresh the observed status before trying again.",
  "codingWorkbench.journey.issueLink": "Issue #{number}",
  "codingWorkbench.journey.prLink": "Pull request #{number}",
  "codingWorkbench.journey.ci": "Technical checks",
  "codingWorkbench.journey.checkCounts":
    "{passed} of {total} required checks passed · {failed} advisory failures",
  "codingWorkbench.journey.description": "Keiko PR description",
  "codingWorkbench.journey.description.current": "Description is current",
  "codingWorkbench.journey.description.partial": "Partial description applied",
  "codingWorkbench.journey.description.fallback": "Fallback description applied",
  "codingWorkbench.journey.description.stale": "Description confirmation is stale",
  "codingWorkbench.journey.description.blocked": "Description application blocked",
  "codingWorkbench.journey.description.failed": "Description application failed",
  "codingWorkbench.journey.description.unavailable": "Description status unavailable",
  "codingWorkbench.journey.descriptionApplied": "Description applied to the observed PR",
  "codingWorkbench.journey.descriptionUnconfirmed":
    "Current description application is not confirmed",
  "codingWorkbench.journey.completeness.complete": "Completeness: complete",
  "codingWorkbench.journey.completeness.partial":
    "Completeness: partial. Some change details could not be described.",
  "codingWorkbench.journey.completeness.fallback":
    "Completeness: fallback. The description uses a limited fallback summary.",
  "codingWorkbench.journey.remoteUnknown":
    "Current PR, review and issue facts could not be observed.",
  "codingWorkbench.journey.review.approved": "Human review approved",
  "codingWorkbench.journey.review.changes-requested": "Reviewers requested changes",
  "codingWorkbench.journey.review.review-required": "Human review required",
  "codingWorkbench.journey.review.unknown": "Human review status unknown",
  "codingWorkbench.journey.conversations": "Review conversations",
  "codingWorkbench.journey.conversationCounts":
    "{unresolved} unresolved · {resolved} resolved · {total} total",
  "codingWorkbench.journey.merge": "Observed merge time",
  "codingWorkbench.journey.notMerged": "Merge not observed",
  "codingWorkbench.journey.issueState": "Observed issue state",
  "codingWorkbench.journey.issue.open": "Issue open",
  "codingWorkbench.journey.issue.closed": "Issue closed",
  "codingWorkbench.journey.closedAt": "Observed issue closure time",
  "codingWorkbench.journey.reason.ready-approval-required":
    "The observed revision can be proposed for a one-time ready-for-review approval.",
  "codingWorkbench.journey.reason.technical-ready":
    "Technical work is ready; review and merge requirements remain separate.",
  "codingWorkbench.journey.reason.human-review-ready": "The observed PR is ready for human review.",
  "codingWorkbench.journey.reason.required-reviews-missing":
    "Required human approvals are still missing.",
  "codingWorkbench.journey.reason.changes-requested":
    "Requested review changes remain outstanding.",
  "codingWorkbench.journey.reason.unresolved-conversations":
    "Resolve the remaining review conversations.",
  "codingWorkbench.journey.reason.review-visibility-unknown":
    "Review visibility is incomplete, so review readiness is unknown.",
  "codingWorkbench.journey.reason.issue-closure-pending":
    "The merge was observed, but the bound issue remains open.",
  "codingWorkbench.journey.reason.merge-and-closure-observed":
    "Both the PR merge and the bound issue closure were observed.",
  "codingWorkbench.journey.reason.closed-unmerged": "The PR was closed without an observed merge.",
  "codingWorkbench.journey.reason.issue-closed-without-merge":
    "The issue was closed without an observed PR merge.",
  "codingWorkbench.journey.reason.retargeted":
    "The PR target no longer matches the accepted default branch.",
  "codingWorkbench.journey.reason.head-changed": "The PR head changed since the accepted delivery.",
  "codingWorkbench.journey.reason.readiness-unavailable": "CI readiness has not been confirmed.",
  "codingWorkbench.journey.reason.readiness-stale": "Refresh the dated CI observation.",
  "codingWorkbench.journey.reason.checks-not-ready": "Required technical checks are not ready.",
  "codingWorkbench.journey.reason.description-unavailable":
    "The applied PR description has not been observed.",
  "codingWorkbench.journey.reason.description-stale":
    "The description no longer has a current revision confirmation.",
  "codingWorkbench.journey.reason.description-not-applied":
    "The selected description has not been confirmed in the PR body.",
  "codingWorkbench.journey.reason.provider-unavailable": "Provider facts could not be confirmed.",
  "codingWorkbench.journey.reason.authority-denied":
    "The current authority does not permit this handoff operation.",
  "codingWorkbench.journey.reason.observation-superseded":
    "A newer observation replaced this status read.",
  "codingWorkbench.journey.reason.cancelled": "The handoff operation was cancelled.",
  "codingWorkbench.journey.reason.ready-effect-uncertain":
    "The ready transition could not be confirmed. Refresh to reconcile the actual PR state.",
  "codingWorkbench.ci.title": "CI readiness",
  "codingWorkbench.ci.state.technical-ready": "Technical checks ready",
  "codingWorkbench.ci.state.pending": "CI checks pending",
  "codingWorkbench.ci.state.failed": "CI checks failed",
  "codingWorkbench.ci.state.blocked": "CI observation blocked",
  "codingWorkbench.ci.state.unknown": "CI readiness unknown",
  "codingWorkbench.ci.state.stale": "CI observation is stale",
  "codingWorkbench.ci.state.unobserved": "No CI observation yet",
  "codingWorkbench.ci.help":
    "Technical checks, draft status and human review are separate. This observation does not authorize a merge.",
  "codingWorkbench.ci.staleHelp":
    "Historical observation. A fresh observation in an active run is needed to confirm the current checks.",
  "codingWorkbench.ci.required": "Required checks",
  "codingWorkbench.ci.advisory": "Advisory checks",
  "codingWorkbench.ci.count.total": "Total",
  "codingWorkbench.ci.count.passed": "Passed",
  "codingWorkbench.ci.count.failed": "Failed",
  "codingWorkbench.ci.count.pending": "Pending",
  "codingWorkbench.ci.count.blocked": "Blocked",
  "codingWorkbench.ci.count.unknown": "Unknown",
  "codingWorkbench.ci.head": "Observed commit",
  "codingWorkbench.ci.observedAt": "Observed at",
  "codingWorkbench.ci.expiresAt": "Valid until",
  "codingWorkbench.ci.completeness": "Observation coverage",
  "codingWorkbench.ci.complete": "Complete",
  "codingWorkbench.ci.incomplete": "Incomplete — readiness cannot be confirmed",
  "codingWorkbench.ci.pullRequest": "Pull request",
  "codingWorkbench.ci.draft": "Draft status",
  "codingWorkbench.ci.isDraft": "Draft pull request",
  "codingWorkbench.ci.notDraft": "Not a draft",
  "codingWorkbench.ci.humanReview": "Human review",
  "codingWorkbench.ci.reviewUnknown": "Review visibility is unknown",
  "codingWorkbench.ci.reviewCounts":
    "{approved} approved · {required} required · {changes} changes requested",
  "codingWorkbench.ci.pr.open": "Open",
  "codingWorkbench.ci.pr.closed": "Closed",
  "codingWorkbench.ci.pr.merged": "Merged",
  "codingWorkbench.ci.conflict": "Merge conflicts",
  "codingWorkbench.ci.conflict.clear": "No observed conflict",
  "codingWorkbench.ci.conflict.conflicting": "Conflicts require resolution",
  "codingWorkbench.ci.conflict.unknown": "Conflict state unknown",
  "codingWorkbench.ci.baseCurrency": "Base revision",
  "codingWorkbench.ci.base.current": "Current",
  "codingWorkbench.ci.base.behind": "Behind the base branch",
  "codingWorkbench.ci.base.unknown": "Base currency unknown",
  "codingWorkbench.ci.reason.required-checks-passed": "The observed required checks passed.",
  "codingWorkbench.ci.reason.required-checks-pending": "Required checks have not finished.",
  "codingWorkbench.ci.reason.required-checks-failed": "Required checks reported failures.",
  "codingWorkbench.ci.reason.required-checks-blocked": "Required checks cannot proceed.",
  "codingWorkbench.ci.reason.required-checks-unknown":
    "Required check results are incomplete or unknown.",
  "codingWorkbench.ci.reason.pull-request-closed": "The pull request is no longer open.",
  "codingWorkbench.ci.reason.merge-conflict": "The observed revision has merge conflicts.",
  "codingWorkbench.ci.reason.base-outdated": "The base branch has changed.",
  "codingWorkbench.ci.reason.merge-context-unknown":
    "The current merge context could not be confirmed.",
  "codingWorkbench.ci.reason.repair-budget-exhausted": "The CI repair budget is exhausted.",
  "codingWorkbench.ci.reason.authority-denied":
    "The current authority does not permit this observation.",
  "codingWorkbench.ci.reason.auth-required": "GitHub authentication is required.",
  "codingWorkbench.ci.reason.invalid-binding":
    "The accepted pull request binding could not be confirmed.",
  "codingWorkbench.ci.reason.cancelled": "The observation was cancelled.",
  "codingWorkbench.ci.reason.provider-forbidden":
    "The provider did not allow these checks to be read.",
  "codingWorkbench.ci.reason.provider-not-found":
    "The provider could not expose the requested check context.",
  "codingWorkbench.ci.reason.rate-limited": "The provider has temporarily limited requests.",
  "codingWorkbench.ci.reason.provider-unavailable": "The provider is temporarily unavailable.",
  "codingWorkbench.ci.reason.timeout": "The observation timed out.",
  "codingWorkbench.ci.reason.pagination-exhausted": "The observation reached its page limit.",
  "codingWorkbench.ci.reason.output-truncated": "The observation reached its output limit.",
  "codingWorkbench.ci.reason.malformed-response": "The provider response could not be validated.",
  "codingWorkbench.ci.reason.visibility-unknown":
    "Required check visibility could not be confirmed.",
  "codingWorkbench.ci.reason.requirements-ambiguous":
    "The required checks could not be determined unambiguously.",
  "codingWorkbench.ci.reason.revision-changed":
    "The pull request revision changed during observation.",

  "codingWorkbench.status.checking": "Checking",
  "codingWorkbench.header.eyebrow": "Coding",
  "codingWorkbench.header.summary":
    "Start and supervise one governed coding run. Authority and outcomes remain server-owned.",
  "codingWorkbench.mode.eyebrow": "Autonomy",
  "codingWorkbench.mode.unconfirmed": "Awaiting server confirmation",
  "codingWorkbench.mode.governed-assist.label": "Ask for approval",
  "codingWorkbench.mode.governed-assist.description":
    "Reads and planning proceed; workspace edits, commands, external-file access, and internet use require approval. Delivery remains separately human-approved.",
  "codingWorkbench.mode.supervised-coding.label": "Supervised workspace",
  "codingWorkbench.mode.supervised-coding.description":
    "Routine low- and medium-risk workspace edits, vetted commands, and verification proceed; external-file access and internet use require approval. Delivery remains separately human-approved.",
  "codingWorkbench.mode.autonomous-delivery.label": "Full access",
  "codingWorkbench.mode.autonomous-delivery.description":
    "File and internet operations within the validated Authority Envelope proceed without per-action approval. Delivery remains separately human-approved.",
  "codingWorkbench.task.eyebrow": "Task",
  "codingWorkbench.task.title": "Describe the bounded coding task",
  "codingWorkbench.task.instructions": "Task instructions",
  "codingWorkbench.task.placeholder":
    "Ask Keiko to inspect, explain, implement, test, or repair something in this repository…",
  "codingWorkbench.task.help":
    "Task text is transient intent. Start unlocks only after every readiness check is confirmed.",
  "codingWorkbench.task.starting": "Starting…",
  "codingWorkbench.task.start": "Start coding run",
  "codingWorkbench.composer.pause": "Pause run",
  "codingWorkbench.composer.resume": "Resume run",
  "codingWorkbench.composer.send": "Send follow-up",
  "codingWorkbench.composer.model.label": "Coding model",
  "codingWorkbench.composer.model.menu": "Choose coding model",
  "codingWorkbench.composer.model.none": "No coding model available",
  "codingWorkbench.composer.source.label": "Model source",
  "codingWorkbench.composer.source.menu": "Choose model source",
  "codingWorkbench.composer.effort.label": "Reasoning effort",
  "codingWorkbench.composer.effort.menu": "Choose reasoning effort",
  "codingWorkbench.composer.effort.minimal": "Minimal",
  "codingWorkbench.composer.effort.low": "Low",
  "codingWorkbench.composer.effort.medium": "Medium",
  "codingWorkbench.composer.effort.high": "High",
  "codingWorkbench.composer.effort.xhigh": "Extra high",
  "codingWorkbench.composer.authority.label": "Run authority",
  "codingWorkbench.composer.authority.menu": "Choose authority",
  "codingWorkbench.composer.authority.error.hydrate":
    "Run authority could not be loaded. Ask for approval remains selected.",
  "codingWorkbench.composer.authority.error.persist":
    "Run authority could not be saved. The previous authority remains active.",
  "codingWorkbench.composer.context.label": "Coding context",
  "codingWorkbench.composer.repository.open": "Manage repository {repository}",
  "codingWorkbench.composer.branch.open": "Manage branch {branch}",
  "codingWorkbench.composer.projectMemory.label": "MemoriaViva",
  "codingWorkbench.composer.projectMemory.help":
    "MemoriaViva uses only the active project memory in Coding Workbench.",
  "codingWorkbench.composer.help":
    "Pause the active run to send a follow-up. A drafted follow-up is admitted only while paused and is never queued.",
  "codingWorkbench.composer.workspaceMismatch":
    "This run keeps the authority of the workspace it started in, which is no longer the active one. The chips, Git and the run's changes stay on the run's workspace; switch back to it to review or edit those files.",
  "codingWorkbench.editorBridge.reconnecting": "Edits are paused: reconnecting the editor bridge.",
  "codingWorkbench.questions.sectionLabel": "Runtime questions",
  "codingWorkbench.questions.eyebrow": "Input needed",
  "codingWorkbench.questions.title": "Runtime questions",
  "codingWorkbench.questions.help":
    "The run stays paused until you answer or reject. Question text is transient and never stored.",
  "codingWorkbench.questions.ready": "{count} question set awaiting your input.",
  "codingWorkbench.questions.loading": "Checking for runtime questions…",
  "codingWorkbench.questions.empty": "No pending runtime questions.",
  "codingWorkbench.questions.offline": "Question service is offline.",
  "codingWorkbench.questions.error": "Questions could not be refreshed.",
  "codingWorkbench.questions.stale": "Question state changed. Check again to continue.",
  "codingWorkbench.questions.submitting": "Submitting your response…",
  "codingWorkbench.questions.terminal": "The coding run has ended.",
  "codingWorkbench.questions.unpaired":
    "This window is not paired for question content. Restart Keiko from its launcher to pair a new app session.",
  "codingWorkbench.pairing.unpaired": "Workbench is not paired. Open Keiko from the launcher.",
  "codingWorkbench.questions.answerFailed":
    "Your answer was not accepted ({code}). The question is still open — send it again.",
  "codingWorkbench.questions.answerRejected":
    "Choose from the listed options for every question. Enter free text only when a Custom option is available. The question is still open ({code}).",
  "codingWorkbench.questions.rejectFailed":
    "Rejecting the question was not accepted ({code}). The question is still open — try again.",
  "codingWorkbench.questions.retry": "Check again",
  "codingWorkbench.questions.requestTitle": "Runtime needs your input",
  "codingWorkbench.questions.required": "Answer every question before sending.",
  "codingWorkbench.questions.answer": "Send answer",
  "codingWorkbench.questions.reject": "Reject question",
  "codingWorkbench.questions.multipleHint": "Select all that apply.",
  "codingWorkbench.questions.customLabel": "Custom answer for {header}",
  "codingWorkbench.setup.eyebrow": "Workspace",
  "codingWorkbench.setup.title": "Code setup",
  "codingWorkbench.setup.help":
    "Bind an existing local Git checkout so the coding run starts inside a governed task workspace.",
  "codingWorkbench.setup.repositoryPath": "Repository path",
  "codingWorkbench.setup.repositoryPathPlaceholder": "/absolute/path/to/repository",
  "codingWorkbench.setup.targetBranch": "Target branch",
  "codingWorkbench.setup.targetBranchPlaceholder": "main",
  "codingWorkbench.setup.submit": "Bind workspace",
  "codingWorkbench.setup.binding": "Binding…",
  "codingWorkbench.setup.verifying": "Verifying…",
  "codingWorkbench.setup.reconcileFailed":
    "The workspace could not be verified. Reconciliation did not confirm a clean, matching checkout, so the run stays unavailable. Review the repository and try again.",
  "codingWorkbench.setup.branchConflict":
    "The task branch for this coding run already exists. Remove the previous branch or its managed workspace. Alternatively, choose a different target branch.",
  "codingWorkbench.setup.invalidBaseBranch":
    "The target branch does not exist in this repository. Enter a branch that resolves locally, for example the checked-out branch.",
  "codingWorkbench.setup.missingRepository":
    "The repository path is not inside a local Git repository. Enter the path of an existing checkout.",
  "codingWorkbench.setup.unsafePath":
    "The repository path is outside the folders this installation may bind. Choose a folder inside an allowed workspace root.",
  "codingWorkbench.setup.lockContention":
    "Another action currently holds this task workspace. Wait a moment, then try again.",
  "codingWorkbench.setup.provisioningUnavailable":
    "Managed task workspaces are not configured on this installation, so no workspace can be bound.",
  "codingWorkbench.setup.repairRequired":
    "A managed workspace for this repository and branch already exists, but Keiko could not re-verify it: {finding}. Repairing {effect}. Keiko cannot tell the original worktree from a replacement at the same path, so approving re-registers whatever is on disk there — inspect the tree in Task workspaces first if its provenance is in doubt.",
  "codingWorkbench.setup.repairEffect.reconcilePointer":
    "re-registers the existing worktree in place; nothing is deleted",
  "codingWorkbench.setup.repairEffect.recreateWorktree":
    "prunes the stale worktree registration and rebuilds the worktree from its task branch; committed work on the branch is kept",
  "codingWorkbench.setup.repairEffect.releaseStaleLock":
    "releases the stale lock an interrupted action left behind; the worktree is not touched",
  "codingWorkbench.setup.repairEffect.acceptMovedHead":
    "accepts the worktree's current commit as its verified head; HEAD moved outside Keiko, and nothing in the repository or on disk is changed",
  "codingWorkbench.setup.repairEffect.generic":
    "applies the recovery strategy Keiko recommended for this finding",
  "codingWorkbench.setup.boundRefreshFailed":
    "The workspace was bound, but this view could not refresh. Open Task workspaces and use Refresh.",
  "codingWorkbench.setup.operatorRequired":
    "A managed workspace for this repository and branch already exists, but Keiko cannot repair it automatically: {finding}. Inspect it in the Task workspaces panel, then try again.",
  "codingWorkbench.setup.repairFailed":
    "The repair did not complete. Refresh the task workspaces, then try again.",
  "codingWorkbench.setup.findingUnknown": "its state could not be re-verified",
  "codingWorkbench.setup.repairAndBind": "Repair and bind",
  "codingWorkbench.setup.repairing": "Repairing…",
  "codingWorkbench.setup.runtimeUnavailable":
    "Starting a coding run is unavailable on this installation until the coding runtime is active. You can bind a workspace now; the run becomes startable once the runtime is confirmed.",
  "codingWorkbench.setup.runtimeEvaluation":
    "This installation runs an unverified evaluation runtime. It carries no Apple or Microsoft code signature, and on macOS it runs without the Endpoint Security containment a release build uses. Its payload integrity is still checked byte for byte on every start.",
  "codingWorkbench.readiness.modelSource.label": "Model source",
  "codingWorkbench.readiness.modelSource.select": "Select an available source",
  "codingWorkbench.readiness.workspace.label": "Task workspace",
  "codingWorkbench.readiness.workspace.none": "No active task workspace",
  "codingWorkbench.readiness.eventStream.label": "Event stream",
  "codingWorkbench.readiness.runtime.label": "Coding runtime",
  "codingWorkbench.readiness.runtime.pending": "Checking coding runtime…",
  "codingWorkbench.readiness.runtime.verified": "Platform-verified — signed and notarized runtime",
  "codingWorkbench.readiness.runtime.evaluation":
    "Unverified evaluation runtime — no platform signature",
  "codingWorkbench.readiness.runtime.unavailable": "Coding runtime unavailable",
  "codingWorkbench.timeline.eyebrow": "Timeline",
  "codingWorkbench.timeline.title": "Activity",
  "codingWorkbench.timeline.empty": "No activity yet.",
  "codingWorkbench.timeline.instructions":
    "Focus the timeline, then use Arrow or Page Up and Page Down keys to scroll.",
  "codingWorkbench.timeline.listLabel": "Coding run event timeline",
  "codingWorkbench.changes.eyebrow": "Files",
  "codingWorkbench.changes.title": "Changes",
  "codingWorkbench.changes.help": "Changed files appear here.",
  "codingWorkbench.changes.idle": "Start a run to inspect its workspace changes.",
  "codingWorkbench.changes.loading": "Loading the latest bounded changes…",
  "codingWorkbench.changes.bindingLost":
    "The run's task-workspace binding is no longer available. No diff is shown.",
  "codingWorkbench.changes.unavailable":
    "Changes are unavailable. The app session may need to be paired again; no stale diff is shown.",
  "codingWorkbench.changes.unpaired":
    "Browser window not paired — open Keiko through the launcher to read this run's task workspace. No diff is shown.",
  "codingWorkbench.changes.error": "Changes could not be refreshed. No stale diff is shown.",
  "codingWorkbench.changes.retry": "Refresh changes",
  "codingWorkbench.changes.asOf": "As of {head}",
  "codingWorkbench.changes.empty": "This run has no workspace changes at this revision.",
  "codingWorkbench.changes.changedFiles": "Changed files ({count})",
  "codingWorkbench.changes.virtualInstructions":
    "Focus the changed-file list, then use Arrow or Page Up and Page Down keys to scroll.",
  "codingWorkbench.changes.filesTruncated":
    "The changed-file list reached its server limit. Only the bounded prefix is shown.",
  "codingWorkbench.changes.fileState.conflicted": "Conflicted",
  "codingWorkbench.changes.fileState.untracked": "Untracked",
  "codingWorkbench.changes.fileState.stagedAndUnstaged": "Staged and unstaged",
  "codingWorkbench.changes.fileState.staged": "Staged",
  "codingWorkbench.changes.fileState.unstaged": "Unstaged",
  "codingWorkbench.changes.diff.title": "Selected file diff",
  "codingWorkbench.changes.diff.region": "Run-scoped file diff",
  "codingWorkbench.changes.diff.loading": "Loading the selected file diff…",
  "codingWorkbench.changes.diff.empty": "No text diff is available for this changed file.",
  "codingWorkbench.changes.diff.error":
    "The selected file diff is unavailable. No stale diff is shown.",
  "codingWorkbench.changes.diff.truncated":
    "This bounded file diff is incomplete because it reached the server limit.",
  "codingWorkbench.changes.diff.addedLine": "Added line",
  "codingWorkbench.changes.diff.deletedLine": "Deleted line",
  "codingWorkbench.changes.diff.contextLine": "Context line",
  "codingWorkbench.changes.diff.metadataLine": "Diff metadata",
  "codingWorkbench.changes.diff.hunkHeader": "Hunk header",
  "codingWorkbench.changes.diff.hunkTruncated":
    "This hunk is incomplete because the bounded diff was truncated.",
  "codingWorkbench.changes.diff.fileTruncated":
    "This file diff is incomplete because the bounded diff was truncated.",
  "codingWorkbench.changes.diff.binaryFile": "Binary file — no text diff to display.",
  "codingWorkbench.changes.diff.previousPath": " (previously {path})",
  "codingWorkbench.changes.diff.elevatedReview": "Elevated review",
  "codingWorkbench.activity.reasoningBoundary":
    "This timeline shows observable conversation and work activity. It never exposes private reasoning.",
  "codingWorkbench.activity.status.idle": "No run yet.",
  "codingWorkbench.activity.status.loading": "Connecting activity…",
  "codingWorkbench.activity.status.live": "Live.",
  "codingWorkbench.activity.status.paused": "Paused.",
  "codingWorkbench.activity.status.recovery": "Needs attention.",
  "codingWorkbench.activity.status.ended": "Run ended.",
  "codingWorkbench.activity.status.unavailable": "Activity not connected.",
  "codingWorkbench.activity.status.disconnected": "Disconnected.",
  "codingWorkbench.activity.status.offline": "Activity offline.",
  "codingWorkbench.activity.status.error": "Activity unavailable.",
  "codingWorkbench.activity.retry": "Reconnect activity",
  "codingWorkbench.activity.truncated": "Activity truncated.",
  "codingWorkbench.activity.dropped": "{count} update(s) omitted.",
  "codingWorkbench.activity.truncationMark": "Output truncated",
  "codingWorkbench.activity.role.user": "You",
  "codingWorkbench.activity.role.assistant": "Coding agent",
  "codingWorkbench.activity.tool": "Tool activity: {tool}",
  "codingWorkbench.activity.toolState.pending": "Pending",
  "codingWorkbench.activity.toolState.running": "Running",
  "codingWorkbench.activity.toolState.succeeded": "Succeeded",
  "codingWorkbench.activity.toolState.failed": "Failed",
  "codingWorkbench.activity.toolState.denied": "Denied",
  "codingWorkbench.activity.toolState.cancelled": "Cancelled",
  "codingWorkbench.activity.plan.title": "Current plan",
  "codingWorkbench.activity.plan.truncated": "Part of this plan was omitted.",
  "codingWorkbench.activity.planState.pending": "Pending",
  "codingWorkbench.activity.planState.active": "In progress",
  "codingWorkbench.activity.planState.completed": "Completed",
  "codingWorkbench.activity.planState.cancelled": "Cancelled",
  "codingWorkbench.source.gateway.label": "Keiko Gateway",
  "codingWorkbench.source.codex.label": "ChatGPT/Codex subscription",
  "codingWorkbench.source.unavailableReason.missing-config":
    "No gateway is configured. Configure the Keiko Gateway in Settings → Models.",
  "codingWorkbench.source.unavailableReason.missing-provider":
    "The gateway configuration names no model provider. Add one in Settings → Models.",
  "codingWorkbench.source.unavailableReason.missing-credentials":
    "The configured provider has no credentials. Update them in Settings → Models.",
  "codingWorkbench.source.unavailableReason.non-chat":
    "No configured model is a chat model. Add a chat-capable model in Settings → Models.",
  "codingWorkbench.source.unavailableReason.no-tool-calling":
    "No chat model has verified tool calling. Run the readiness check in Settings → Models and apply the verified values.",
  "codingWorkbench.source.unavailableReason.non-workflow-eligible":
    "The tool-calling chat model is not workflow-eligible. Enable workflow eligibility in Settings → Models.",
  "codingWorkbench.source.unavailableReason.non-coding-capable":
    "The configured chat model is not coding-capable.",
  "codingWorkbench.source.unavailableReason.deployment-policy-disabled":
    "The deployment policy disables the coding runtime's gateway source.",
  "codingWorkbench.source.unavailableReason.subscription-source":
    "The subscription source is selected; the gateway is not in use.",
  "codingWorkbench.source.unavailableReason.model-context-window-insufficient":
    "The configured model's context window is too small for a coding run (minimum 32,000 tokens). Increase the model's context window or choose a larger model in Settings → Models.",
  "codingWorkbench.modelSource.gateway": "Keiko Gateway",
  "codingWorkbench.modelSource.openaiGateway": "OpenAI through Gateway",
  "codingWorkbench.modelSource.codexSubscription": "ChatGPT/Codex subscription",
  "codingWorkbench.auth.label": "Subscription authentication",
  "codingWorkbench.auth.cardTitle": "Sign in to the Codex subscription",
  "codingWorkbench.auth.cardHelp":
    "A coding run over the ChatGPT/Codex subscription can start only once this installation is signed in. Refresh the status after signing in, or prepare a server-approved setup method below.",
  "codingWorkbench.auth.refresh": "Refresh authentication",
  "codingWorkbench.auth.setupMethods": "Server-approved setup methods",
  "codingWorkbench.auth.setupMethodsGroup": "Codex authentication setup methods",
  "codingWorkbench.auth.preparing": "Preparing…",
  "codingWorkbench.auth.prepare": "Prepare {method}",
  "codingWorkbench.auth.noMethod": "No setup method is approved for this environment.",
  "codingWorkbench.auth.setupUnavailable":
    "The setup plan is unavailable. Choose an approved method to retry.",
  "codingWorkbench.auth.planReady": "Setup plan ready",
  "codingWorkbench.auth.planDetail": "{method} · Command: {command} · Secret input: {secretInput}.",
  "codingWorkbench.auth.secretRequired": "required through managed stdin",
  "codingWorkbench.auth.secretNotRequired": "not required",
  "codingWorkbench.auth.planHelp":
    "Managed runtime login capability is not available in this build. This browser only prepares the content-free setup plan and never starts the command.",
  "codingWorkbench.auth.method.browser": "browser login",
  "codingWorkbench.auth.method.deviceCode": "device-code login",
  "codingWorkbench.auth.method.accessToken": "access-token login",
  "codingWorkbench.auth.status.connected": "Connected",
  "codingWorkbench.auth.status.required": "Sign-in required",
  "codingWorkbench.auth.status.expired": "Session expired",
  "codingWorkbench.auth.status.revoked": "Session revoked",
  "codingWorkbench.auth.status.failedLogin": "Previous login failed",
  "codingWorkbench.auth.status.disabledDeployment": "Disabled by deployment",
  "codingWorkbench.auth.status.unavailableEnvironment": "Unavailable in this environment",
  "codingWorkbench.auth.status.unavailableRelease": "Unavailable in this release",
  "codingWorkbench.auth.status.unavailable": "Authentication unavailable",
  "codingWorkbench.controls.eyebrow": "Operator control",
  "codingWorkbench.controls.title": "Stop or take over",
  "codingWorkbench.controls.stop": "Stop run",
  "codingWorkbench.controls.takeover": "Take over manually",
  "codingWorkbench.controls.help": "Delivery actions remain separately human-approved.",
  "codingWorkbench.controls.resumeMode.label": "Resume autonomy",
  "codingWorkbench.controls.resumeMode.help":
    "Resume with the server-confirmed current mode or a stricter mode. Widening is unavailable.",
  "codingWorkbench.approval.eyebrow": "Approval required",
  "codingWorkbench.approval.title": "Review the bounded action",
  "codingWorkbench.approval.facts": "Approval facts",
  "codingWorkbench.approval.permissionKind": "Permission kind",
  "codingWorkbench.approval.actionClass": "Action class",
  "codingWorkbench.approval.action": "Action",
  "codingWorkbench.approval.scope": "Scope",
  "codingWorkbench.approval.commandClass": "Command class",
  "codingWorkbench.approval.connectorScopes": "Connector scopes",
  "codingWorkbench.approval.risk": "Risk",
  "codingWorkbench.approval.policyReason": "Policy reason",
  "codingWorkbench.approval.reasonCode": "Reason code",
  "codingWorkbench.approval.expires": "Expires",
  "codingWorkbench.approval.notSpecified": "Not specified",
  "codingWorkbench.approval.notApplicable": "Not applicable",
  "codingWorkbench.approval.noneRequested": "None requested",
  "codingWorkbench.approval.unspecified": "Unspecified",
  "codingWorkbench.approval.kind.workspace-write": "Workspace write",
  "codingWorkbench.approval.kind.command-execution": "Command execution",
  "codingWorkbench.approval.kind.network-egress": "Network egress",
  "codingWorkbench.approval.kind.connector-access": "Connector access",
  "codingWorkbench.approval.kind.delivery-substrate": "Delivery",
  "codingWorkbench.approval.actionClass.workspace-read": "Workspace read",
  "codingWorkbench.approval.actionClass.workspace-write": "Workspace write",
  "codingWorkbench.approval.actionClass.command-execution": "Command execution",
  "codingWorkbench.approval.actionClass.verification": "Verification",
  "codingWorkbench.approval.actionClass.connector-access": "Connector access",
  "codingWorkbench.approval.actionClass.network-egress": "Network egress",
  "codingWorkbench.approval.actionClass.delivery-substrate": "Delivery",
  "codingWorkbench.approval.risk.low": "Low",
  "codingWorkbench.approval.risk.medium": "Medium",
  "codingWorkbench.approval.risk.high": "High",
  "codingWorkbench.approval.risk.critical": "Critical",
  "codingWorkbench.approval.actionKind.file-edit": "File edit",
  "codingWorkbench.approval.actionKind.git-stage": "Stage changes",
  "codingWorkbench.approval.actionKind.verification-command": "Verification command",
  "codingWorkbench.approval.actionKind.ci-observe": "CI status check",
  "codingWorkbench.approval.actionKind.connector-read": "Connector read",
  "codingWorkbench.approval.actionKind.research": "Research",
  "codingWorkbench.approval.actionKind.commit": "Commit",
  "codingWorkbench.approval.actionKind.push": "Push",
  "codingWorkbench.approval.actionKind.pull-request": "Pull request",
  "codingWorkbench.approval.actionKind.merge": "Merge",
  "codingWorkbench.approval.actionKind.connector-write": "Connector write",
  "codingWorkbench.approval.actionKind.external-write": "External write",
  "codingWorkbench.approval.actionKind.system-mutation": "System mutation",
  "codingWorkbench.approval.policyReason.scoped-file-edit": "File edit inside the task scope",
  "codingWorkbench.approval.policyReason.out-of-scope-file-edit":
    "File edit outside the task scope",
  "codingWorkbench.approval.policyReason.allowlisted-verification-command":
    "Allowlisted verification command",
  "codingWorkbench.approval.policyReason.unknown-command-denied": "Unknown command denied",
  "codingWorkbench.approval.policyReason.mutating-command-denied": "Mutating command denied",
  "codingWorkbench.approval.policyReason.approval-required": "Approval required",
  "codingWorkbench.approval.policyReason.approval-proof-missing": "Approval proof missing",
  "codingWorkbench.approval.policyReason.approval-proof-stale": "Approval proof stale",
  "codingWorkbench.approval.policyReason.approval-proof-accepted": "Approval proof accepted",
  "codingWorkbench.approval.policyReason.operator-denied": "Denied by the operator",
  "codingWorkbench.approval.policyReason.operator-stopped": "Stopped by the operator",
  "codingWorkbench.approval.policyReason.redacted-failure": "Failure (details redacted)",
  "codingWorkbench.approval.connectorScope.source-control.read": "Source control (read)",
  "codingWorkbench.approval.connectorScope.source-control.write": "Source control (write)",
  "codingWorkbench.approval.connectorScope.issue-tracker.read": "Issue tracker (read)",
  "codingWorkbench.approval.connectorScope.issue-tracker.write": "Issue tracker (write)",
  "codingWorkbench.approval.connectorScope.knowledge-base.read": "Knowledge base (read)",
  "codingWorkbench.approval.connectorScope.knowledge-base.write": "Knowledge base (write)",
  "codingWorkbench.approval.research.title": "Research destination",
  "codingWorkbench.approval.research.host": "Public domain",
  "codingWorkbench.approval.research.requestLine": "Requested path and query",
  "codingWorkbench.approval.research.loading": "Loading the destination…",
  "codingWorkbench.approval.research.unavailable":
    "Destination unavailable. Re-pair this window to see it before deciding.",
  "codingWorkbench.approval.research.retry": "Retry loading the destination",
  "codingWorkbench.draftDelivery.title": "Repository delivery",
  "codingWorkbench.draftDelivery.phase.push-proposed": "Push awaits approval",
  "codingWorkbench.draftDelivery.phase.pushing": "Push in progress",
  "codingWorkbench.draftDelivery.phase.pushed": "Commit pushed",
  "codingWorkbench.draftDelivery.phase.pr-proposed": "Draft pull request awaits approval",
  "codingWorkbench.draftDelivery.phase.creating-pr": "Creating draft pull request",
  "codingWorkbench.draftDelivery.phase.draft-created": "Draft pull request created",
  "codingWorkbench.draftDelivery.phase.recovery-required": "Delivery needs reconciliation",
  "codingWorkbench.draftDelivery.reason.approval-required":
    "The saved proposal requires its matching approval before delivery.",
  "codingWorkbench.draftDelivery.reason.in-flight":
    "The operation was started. Its remote outcome is not yet confirmed.",
  "codingWorkbench.draftDelivery.reason.completed":
    "The remote result was confirmed for this saved delivery step.",
  "codingWorkbench.draftDelivery.reason.authority-denied":
    "The accepted authority no longer permits this delivery.",
  "codingWorkbench.draftDelivery.reason.remote-drift":
    "The remote state differs from the approved target and must be checked.",
  "codingWorkbench.draftDelivery.reason.issue-drift":
    "The accepted issue binding changed. Delivery needs review.",
  "codingWorkbench.draftDelivery.reason.provider-failed":
    "The provider did not confirm the operation. Check remote state before retrying.",
  "codingWorkbench.draftDelivery.reason.ambiguous-remote":
    "The remote result could not be matched unambiguously to this task.",
  "codingWorkbench.draftDelivery.reason.approval-invalid":
    "The approval is missing, expired or does not match this proposal.",
  "codingWorkbench.draftDelivery.reason.payload-changed":
    "The proposed delivery changed after review.",
  "codingWorkbench.draftDelivery.reason.restart-reconciliation":
    "Delivery was interrupted. Remote state must be checked before continuing.",
  "codingWorkbench.draftDelivery.reason.preflight-failed":
    "Delivery prerequisites were not satisfied.",
  "codingWorkbench.draftDelivery.pendingApprovalHint":
    "Respond to the pending permission request to approve or deny this delivery.",
  "codingWorkbench.draftDelivery.pullRequest": "Pull request #{number}",
  "codingWorkbench.draftDelivery.remoteState": "Last observed PR state",
  "codingWorkbench.draftDelivery.remoteHead": "Last observed PR commit",
  "codingWorkbench.draftDelivery.remoteBase": "Last observed PR base commit",
  "codingWorkbench.draftDelivery.remote.open": "Open",
  "codingWorkbench.draftDelivery.remote.closed": "Closed",
  "codingWorkbench.draftDelivery.remote.draft": "Draft",
  "codingWorkbench.draftDelivery.remote.notDraft": "Not a draft",
  "codingWorkbench.draftDelivery.details": "Saved delivery target",
  "codingWorkbench.draftDelivery.repository": "Repository",
  "codingWorkbench.draftDelivery.issue": "Accepted issue",
  "codingWorkbench.draftDelivery.headRef": "Feature branch",
  "codingWorkbench.draftDelivery.headSha": "Approved commit",
  "codingWorkbench.draftDelivery.baseRef": "Target branch",
  "codingWorkbench.draftDelivery.baseSha": "Approved base commit",
  "codingWorkbench.draftDelivery.proposal": "Proposal",
  "codingWorkbench.draftDelivery.recordedAt": "Recorded at",
  "codingWorkbench.descriptionStatus.title": "Pull request description draft",
  "codingWorkbench.descriptionStatus.state.current": "Draft ready",
  "codingWorkbench.descriptionStatus.state.stale": "Draft is stale",
  "codingWorkbench.descriptionStatus.state.partial": "Draft partially generated",
  "codingWorkbench.descriptionStatus.state.fallback": "Draft generated without the model",
  "codingWorkbench.descriptionStatus.state.blocked": "Draft blocked",
  "codingWorkbench.descriptionStatus.state.failed": "Draft generation failed",
  "codingWorkbench.descriptionStatus.reason.generated":
    "Generated from the latest verified commit.",
  "codingWorkbench.descriptionStatus.reason.partial-generated":
    "Generated with some evidence omitted.",
  "codingWorkbench.descriptionStatus.reason.fallback-generated":
    "Generated deterministically; the model was unavailable.",
  "codingWorkbench.descriptionStatus.reason.stale-snapshot":
    "The change moved since this draft was generated.",
  "codingWorkbench.descriptionStatus.reason.authority-expired":
    "Authority expired before generation could start.",
  "codingWorkbench.descriptionStatus.reason.model-egress-denied":
    "The model was not authorized for this attempt.",
  "codingWorkbench.descriptionStatus.reason.budget-exhausted":
    "Too many description drafts are in progress right now.",
  "codingWorkbench.descriptionStatus.reason.generation-unavailable":
    "Automatic draft generation is not available yet.",
  "codingWorkbench.descriptionStatus.reason.interrupted":
    "Generation was interrupted and must be retried on the next change.",
  "codingWorkbench.descriptionStatus.reason.provider-failed":
    "The description provider failed while generating this draft.",
  "codingWorkbench.descriptionStatus.head": "Head commit",
  "codingWorkbench.descriptionStatus.generation": "Generation",
  "codingWorkbench.descriptionStatus.review": "Review exact draft",
  "codingWorkbench.descriptionStatus.unavailable":
    "This retained draft is no longer available. Refresh the run status to continue.",
  "codingWorkbench.commitResult.title": "Commit result",
  "codingWorkbench.commitResult.head": "Created commit",
  "codingWorkbench.commitResult.findings": "Git checks",
  "codingWorkbench.commitResult.status.succeeded": "Commit created",
  "codingWorkbench.commitResult.status.approval-required": "Commit awaits approval",
  "codingWorkbench.commitResult.status.blocked": "Commit blocked",
  "codingWorkbench.commitResult.status.failed": "Commit failed",
  "codingWorkbench.commitResult.status.recovery-required": "Commit needs recovery",
  "codingWorkbench.commitResult.status.verification-failed": "Commit verification failed",
  "codingWorkbench.commitResult.status.drift": "Commit proposal changed",
  "codingWorkbench.commitResult.reason.approval-required":
    "Review the proposed commit before deciding.",
  "codingWorkbench.commitResult.reason.approval-invalid":
    "The approval no longer matches this proposal. Request a fresh review.",
  "codingWorkbench.commitResult.reason.authority-denied":
    "Current authority does not permit this commit.",
  "codingWorkbench.commitResult.reason.verification-missing":
    "Run the required verification before proposing this commit.",
  "codingWorkbench.commitResult.reason.verification-failed":
    "The required verification did not pass.",
  "codingWorkbench.commitResult.reason.verification-stale":
    "The verification no longer matches the staged change. Verify it again.",
  "codingWorkbench.commitResult.reason.candidate-drift":
    "The staged change no longer matches this proposal. Request a fresh review.",
  "codingWorkbench.commitResult.reason.repository-drift":
    "The repository changed after review. Check its current state.",
  "codingWorkbench.commitResult.reason.message-policy":
    "The commit message does not satisfy the message policy.",
  "codingWorkbench.commitResult.reason.review-incomplete":
    "The staged change could not be reviewed completely.",
  "codingWorkbench.commitResult.reason.issue-directive":
    "The commit message contains an unsupported issue-closing directive.",
  "codingWorkbench.commitResult.reason.conflict-markers":
    "The staged change contains unresolved conflict markers.",
  "codingWorkbench.commitResult.reason.policy-block":
    "Git policy prevented this commit. Review the finding below.",
  "codingWorkbench.commitResult.reason.preflight-block":
    "A Git check prevented this commit. Review the findings below.",
  "codingWorkbench.commitResult.reason.execution-failed": "Git could not create this commit.",
  "codingWorkbench.commitResult.reason.execution-uncertain":
    "The commit outcome is uncertain. Reconcile repository state before another attempt.",
  "codingWorkbench.commitResult.reason.restart-reconciliation":
    "This commit needs reconciliation after a restart.",
  "codingWorkbench.commitResult.reason.completed":
    "The created commit matches the reviewed staged tree.",
  "codingWorkbench.commitResult.preflight.detached-head": "No branch is checked out",
  "codingWorkbench.commitResult.preflight.branch-already-exists": "The branch already exists",
  "codingWorkbench.commitResult.preflight.base-branch-missing": "The base branch is missing",
  "codingWorkbench.commitResult.preflight.switch-target-missing": "The target branch is missing",
  "codingWorkbench.commitResult.preflight.no-changes-to-stage": "No changes are available to stage",
  "codingWorkbench.commitResult.preflight.nothing-staged-to-unstage":
    "No staged changes are available to unstage",
  "codingWorkbench.commitResult.preflight.nothing-staged-to-commit":
    "No changes are staged for this commit",
  "codingWorkbench.commitResult.preflight.untracked-files-impacted":
    "Untracked files would be affected",
  "codingWorkbench.commitResult.preflight.no-upstream-configured":
    "No upstream branch is configured",
  "codingWorkbench.commitResult.preflight.nothing-to-push": "No commits are available to push",
  "codingWorkbench.commitResult.preflight.non-fast-forward": "The remote history has diverged",
  "codingWorkbench.commitResult.preflight.remote-alias-missing": "The remote alias is missing",
  "codingWorkbench.commitResult.preflight.remote-unreachable": "The remote is unreachable",
  "codingWorkbench.commitResult.preflight.operation-in-progress":
    "A Git operation is already in progress",
  "codingWorkbench.commitResult.preflight.no-operation-to-abort": "No Git operation can be aborted",
  "codingWorkbench.commitResult.preflight.recovery-target-unset": "No recovery target is set",
  "codingWorkbench.commitResult.preflight.dirty-worktree-impacts-recovery":
    "Workspace changes prevent safe recovery",
  "codingWorkbench.commitResult.messageViolation.empty-subject": "The commit subject is empty",
  "codingWorkbench.commitResult.messageViolation.missing-conventional-prefix":
    'The subject is missing a conventional-commit prefix (for example "feat: ")',
  "codingWorkbench.commitResult.messageViolation.disallowed-type":
    "The conventional-commit type is not one of the allowed types",
  "codingWorkbench.commitResult.messageViolation.subject-too-long":
    "The subject line exceeds the maximum length",
  "codingWorkbench.commitResult.messageViolation.missing-issue-key":
    "The message is missing a required issue key",
  "codingWorkbench.commitResult.messageViolation.missing-signoff":
    "The message is missing a required Signed-off-by trailer",
  "codingWorkbench.approval.commit.message": "Reviewed commit message",
  "codingWorkbench.approval.commit.binding": "Exact commit binding",
  "codingWorkbench.approval.commit.proposal": "Proposal",
  "codingWorkbench.approval.commit.verification": "Verification evidence",
  "codingWorkbench.approval.commit.base": "Base commit",
  "codingWorkbench.approval.commit.parent": "Parent commit",
  "codingWorkbench.approval.commit.tree": "Staged tree digest",
  "codingWorkbench.approval.commit.messageDigest": "Message digest",
  "codingWorkbench.approval.commit.files": "Staged files for this commit",
  "codingWorkbench.approval.delivery.target": "Reviewed delivery target",
  "codingWorkbench.approval.delivery.loading": "Loading delivery review…",
  "codingWorkbench.approval.delivery.unavailable":
    "The delivery review is unavailable. Retry or deny this request.",
  "codingWorkbench.approval.delivery.retry": "Retry delivery review",
  "codingWorkbench.approval.delivery.title": "Reviewed pull request title",
  "codingWorkbench.approval.delivery.body": "Reviewed pull request description",
  "codingWorkbench.approval.delivery.pushHelp":
    "Approve this exact commit and branch for one push to the displayed repository. Creating a pull request requires a separate approval.",
  "codingWorkbench.approval.delivery.prHelp":
    "Approve creation of one draft pull request with this exact title, description and target. This does not merge the pull request.",
  "codingWorkbench.approval.commit.help":
    "Approval applies once to this reviewed message and staged change. A changed proposal requires a new review.",
  "codingWorkbench.approval.changes.title": "Files this change would write",
  "codingWorkbench.approval.changes.files": "Files",
  "codingWorkbench.approval.changes.lines": "Lines",
  "codingWorkbench.approval.changes.lineCounts": "+{added} / -{deleted}",
  "codingWorkbench.approval.changes.truncated":
    "Only the first {shown} of {total} files are listed.",
  "codingWorkbench.approval.changes.loading": "Loading the changed files…",
  "codingWorkbench.approval.changes.unavailable":
    "Changed files unavailable. Re-pair this window to see them before deciding.",
  "codingWorkbench.approval.changes.retry": "Retry loading the changed files",
  "codingWorkbench.approval.help": "Raw commands, prompts, diffs, and file contents remain hidden.",
  "codingWorkbench.approval.evidenceRequired":
    "Approval stays unavailable until what this request would touch has loaded. Retry that read, or deny the request.",
  "codingWorkbench.approval.approve": "Approve once",
  "codingWorkbench.approval.deny": "Deny",
  "codingWorkbench.changesetReview.eyebrow": "Change review",
  "codingWorkbench.changesetReview.title": "Review the proposed file change",
  "codingWorkbench.changesetReview.help":
    "The task paused so you can confirm this exact change before it is written.",
  "codingWorkbench.changesetReview.empty": "No reviewable change was produced.",
  "codingWorkbench.changesetReview.approve": "Apply change",
  "codingWorkbench.changesetReview.deny": "Reject change",
  "codingWorkbench.changesetReview.retry": "Try again",
  "codingWorkbench.changesetReview.deliveryFailed":
    "Could not confirm this decision with the run. Try again.",
  "codingWorkbench.changesetReview.deliveryFailedCode":
    "Could not confirm this decision with the run ({code}). The change was not written — try again.",
  "codingWorkbench.recovery.eyebrow": "Recovery required",
  "codingWorkbench.recovery.title": "Reconcile before retrying",
  "codingWorkbench.recovery.summary":
    "Keiko will start a fresh run. It will not replay prior mutations.",
  "codingWorkbench.recovery.retry": "Retry as a fresh run",
  "codingWorkbench.recovery.acknowledge": "Acknowledge recovery",
  "codingWorkbench.header.notReady": "Not ready to start",
  "codingWorkbench.header.readyEvaluation": "Start — unverified evaluation runtime",
  "codingWorkbench.runState.idle": "Ready to start",
  "codingWorkbench.runState.unavailable": "Runtime unavailable",
  "codingWorkbench.runState.starting": "Starting",
  "codingWorkbench.runState.ready": "Runtime ready",
  "codingWorkbench.runState.running": "Running",
  "codingWorkbench.runState.paused": "Paused",
  "codingWorkbench.runState.awaiting-approval": "Approval required",
  "codingWorkbench.runState.stopping": "Stopping",
  "codingWorkbench.runState.succeeded": "Succeeded",
  "codingWorkbench.runState.failed": "Failed",
  "codingWorkbench.runState.cancelled": "Stopped",
  "codingWorkbench.runState.taken-over": "Taken over",
  "codingWorkbench.runState.recovery-required": "Recovery required",
  "codingWorkbench.resourceStatus.unavailable": "Unavailable",
  "codingWorkbench.announcement.runChecking": "Run status checking.",
  "codingWorkbench.announcement.noActiveRun": "No active coding run.",
  "codingWorkbench.announcement.runRevision": "{state}. Revision {revision}.",
  "codingWorkbench.announcement.recoveryComplete": "Recovery acknowledgement complete.",
  "codingWorkbench.announcement.setupReady": "Authentication setup plan ready.",
  "codingWorkbench.announcement.setupChecking": "Authentication setup plan checking.",
  "codingWorkbench.announcement.setupUnavailable": "Authentication setup plan unavailable.",
  "codingWorkbench.announcement.modelSource.checking": "Model source checking.",
  "codingWorkbench.announcement.modelSource.refreshFailed": "Model source refresh failed.",
  "codingWorkbench.announcement.modelSource.unavailable": "Model source unavailable.",
  "codingWorkbench.announcement.modelSource.ready": "Model source ready.",
  "codingWorkbench.announcement.modelSource.notSelected": "Model source not selected.",
  "codingWorkbench.announcement.modelSource.notChecked": "Model source not checked.",
  "codingWorkbench.announcement.workspace.checking": "Workspace checking.",
  "codingWorkbench.announcement.workspace.refreshFailed": "Workspace refresh failed.",
  "codingWorkbench.announcement.workspace.unavailable": "Workspace unavailable.",
  "codingWorkbench.announcement.workspace.ready": "Workspace ready.",
  "codingWorkbench.announcement.workspace.notSelected": "Workspace not selected.",
  "codingWorkbench.announcement.workspace.notChecked": "Workspace not checked.",
  "codingWorkbench.announcement.runtime.checking": "Runtime checking.",
  "codingWorkbench.announcement.runtime.refreshFailed": "Runtime refresh failed.",
  "codingWorkbench.announcement.runtime.unavailable": "Runtime unavailable.",
  "codingWorkbench.announcement.runtime.ready": "Runtime ready.",
  "codingWorkbench.announcement.runtime.notSelected": "Runtime not selected.",
  "codingWorkbench.announcement.runtime.notChecked": "Runtime not checked.",
  "codingWorkbench.announcement.runtime.evaluation":
    "Runtime available as an unverified evaluation runtime. It carries no platform signature.",
  "codingWorkbench.announcement.authenticationNotSelected":
    "Subscription authentication not selected.",
  "codingWorkbench.announcement.authenticationChecking": "Authentication checking.",
  "codingWorkbench.announcement.authenticationUnavailable": "Authentication unavailable.",
  "codingWorkbench.announcement.authenticationReady": "Authentication ready.",
  "codingWorkbench.announcement.authenticationRequired": "Authentication required.",
  "codingWorkbench.announcement.authenticationNotChecked": "Authentication not checked.",
  "codingWorkbench.event.runtime-started": "Runtime started",
  "codingWorkbench.event.runtime-stopped": "Runtime stopped",
  "codingWorkbench.event.runtime-health": "Runtime health changed",
  "codingWorkbench.event.task-submitted": "Task submitted",
  "codingWorkbench.event.observation-streamed": "Runtime observation",
  "codingWorkbench.event.permission-requested": "Permission requested",
  "codingWorkbench.event.diff-summarized": "Diff summarized",
  "codingWorkbench.event.verification-summarized": "Verification summarized",
  "codingWorkbench.event.artifact-produced": "Artifact produced",
  "codingWorkbench.event.research-performed": "Research performed",
  "codingWorkbench.event.skill-invoked": "Skill invoked",
  "codingWorkbench.event.child-run-started": "Child agent started",
  "codingWorkbench.event.child-run-completed": "Child agent completed",
  "codingWorkbench.event.failure-redacted": "Failure reported",
  "codingWorkbench.event.detail": "Sequence {sequence}. Revision {revision}.",
  "codingWorkbench.event.detailFailure":
    "Sequence {sequence}. Revision {revision}. Failure: {failure}.",
  "codingWorkbench.event.detailOutcome": "Outcome: {outcome}.",
  "codingWorkbench.event.detailUntrustedContent":
    "Untrusted content: the fetched page was quarantined as data, not instructions.",
  "codingWorkbench.outcomeLabel.accepted": "Accepted",
  "codingWorkbench.outcomeLabel.denied": "Denied",
  "codingWorkbench.outcomeLabel.unavailable": "Unavailable",
  "codingWorkbench.outcomeLabel.limit-reached": "Limit reached",
  "codingWorkbench.outcomeLabel.stopped": "Stopped",
  "codingWorkbench.research.chipLabel": "Internet · Research only",
  "codingWorkbench.research.facts": "Research grant facts",
  "codingWorkbench.research.scope": "Scope",
  "codingWorkbench.research.scopeValue": "Public research only",
  "codingWorkbench.research.domains": "Allowed domains",
  "codingWorkbench.research.expiry": "Expires",
  "codingWorkbench.research.revoke": "Revoke",
  "codingWorkbench.research.revoking": "Revoking…",
  "codingWorkbench.research.revokeLabel":
    "Revoke the internet research grant for this run and its child agents",
  "codingWorkbench.announcement.researchActive": "Internet research grant active.",
  "codingWorkbench.alert.actionFailedCode":
    "The requested runtime action failed ({code}). Review the live state and retry.",
  "codingWorkbench.alert.actionFailedSupportId": "Support id: {correlationId}.",
  "codingWorkbench.alert.authenticationRefreshFailed": "Authentication could not be refreshed.",
  "codingWorkbench.alert.authenticationSetupRefreshFailed":
    "Authentication setup could not be refreshed.",
  "codingWorkbench.alert.modelSourceRefreshFailed": "Model source could not be refreshed.",
  "codingWorkbench.alert.runtimeRefreshFailed": "Runtime could not be refreshed.",
  "codingWorkbench.alert.runtimeUnqualified":
    "Starting a coding run stays unavailable until this installation's coding runtime is confirmed active.",
  "codingWorkbench.alert.workspaceRefreshFailed": "Workspace could not be refreshed.",
  "codingWorkbench.alert.workspaceBindFailed":
    "The workspace could not be bound. Review the repository path and target branch.",
  "codingWorkbench.alert.runRefreshFailed": "Run could not be refreshed.",
  "codingWorkbench.alert.eventStreamRefreshFailed": "Event stream could not be refreshed.",
  "codingWorkbench.issue.eyebrow": "GitHub issue",
  "codingWorkbench.issue.title": "Start from a GitHub issue",
  "codingWorkbench.issue.help":
    "Optional. Paste an issue URL or #number from this repository. Keiko previews the issue as untrusted text and binds the run to the server-resolved issue, repository, remote and default branch.",
  "codingWorkbench.issue.reference": "Issue URL or #number",
  "codingWorkbench.issue.referencePlaceholder": "https://github.com/owner/repo/issues/123 or #123",
  "codingWorkbench.issue.preview": "Preview issue",
  "codingWorkbench.issue.previewing": "Previewing…",
  "codingWorkbench.issue.cancel": "Cancel",
  "codingWorkbench.issue.confirm": "Use this issue",
  "codingWorkbench.issue.discard": "Discard preview",
  "codingWorkbench.issue.remove": "Remove issue",
  "codingWorkbench.issue.retry": "Try again",
  "codingWorkbench.issue.changeRepository": "Change repository path",
  "codingWorkbench.issue.openGit": "Open Git client to clone or switch",
  "codingWorkbench.issue.previewRegion": "Issue preview",
  "codingWorkbench.issue.untrustedNote":
    "Issue text is shown as plain text and is never treated as instructions or approval.",
  "codingWorkbench.issue.commentLabel": "Comment {index}",
  "codingWorkbench.issue.commentsLabel": "Issue comment excerpts",
  "codingWorkbench.issue.commentsTruncated":
    "Additional comments or text were omitted from this bounded preview.",
  "codingWorkbench.issue.bodyTruncated": "The issue body is truncated in this preview.",
  "codingWorkbench.issue.fact.state": "State",
  "codingWorkbench.issue.fact.comments": "Comments",
  "codingWorkbench.issue.fact.provenance": "Source",
  "codingWorkbench.issue.fact.url": "URL",
  "codingWorkbench.issue.fact.baseRef": "Base branch",
  "codingWorkbench.issue.state.open": "Open",
  "codingWorkbench.issue.state.closed": "Closed",
  "codingWorkbench.issue.commentCount": "{count} bounded comment(s) included",
  "codingWorkbench.issue.excerptLabel": "Issue body excerpt",
  "codingWorkbench.issue.excerptEmpty": "The issue has no body.",
  "codingWorkbench.issue.baseRefServerChosen":
    "The base branch is the repository's server-resolved default branch. It cannot be changed for an issue-bound run.",
  "codingWorkbench.issue.accepted": "Issue {issue} · base {baseRef}",
  "codingWorkbench.issue.acceptedHelp":
    "The workspace binds from {baseRef} and the run starts bound to this issue. Remove the issue to start a generic run instead.",
  "codingWorkbench.issue.status.loading": "Loading the issue preview…",
  "codingWorkbench.issue.status.ready": "Issue preview ready.",
  "codingWorkbench.issue.status.cancelled": "Issue preview cancelled. No run was started.",
  "codingWorkbench.issue.status.failed": "The issue could not be loaded.",
  "codingWorkbench.issue.status.empty": "Enter an issue URL or #number to preview it.",
  "codingWorkbench.issue.error.invalid-reference":
    "That is not a GitHub issue reference. Enter an issue URL or #number from this repository; pull request URLs and other hosts are rejected.",
  "codingWorkbench.issue.error.repository-mismatch":
    "The issue belongs to a different repository than the one at this path. Change the repository path, or open the Git client to switch to or clone that repository. Keiko never redirects silently.",
  "codingWorkbench.issue.error.auth-required":
    "GitHub issue access is not enabled for this repository. Enable it under Settings → Security → GitHub issue access, then preview again.",
  "codingWorkbench.issue.error.issue-unavailable":
    "The issue could not be read. It may be closed, transferred, deleted, a pull request, or outside the access this installation has.",
  "codingWorkbench.issue.error.read-transient-failure":
    "GitHub could not be reached just now (a rate limit or a temporary error). This is not about the issue itself — try again in a moment.",
  "codingWorkbench.issue.error.clone-failed":
    "The repository could not be cloned. No run was started and no destination was overwritten. Review the Git client and try again.",
  "codingWorkbench.issue.error.authority-denied":
    "The current authority does not allow binding a run to this issue. Review the autonomy mode and try again.",
  "codingWorkbench.issue.error.cancelled": "The issue intake was cancelled. No run was started.",
  "codingWorkbench.issue.error.unavailable-runtime":
    "The coding runtime is unavailable on this installation, so an issue-bound run cannot start. The preview stays for reference; confirm once the runtime is active.",
  "codingWorkbench.issue.error.unknown":
    "The issue preview failed. Review the live state and try again.",
  "codingWorkbench.issue.supportId": "Support id: {correlationId}.",
  "codingWorkbench.composer.issue.label": "Issue {issue}",
  "codingWorkbench.composer.issue.remove": "Remove issue {issue} from this run",
  "codingWorkbench.githubAccess.title": "GitHub issue access",
  "codingWorkbench.githubAccess.description":
    "Lets the Coding Workbench read GitHub issues and comments for the selected repository through the local gh CLI. The grant is stored per local checkout; credentials never enter Keiko.",
  "codingWorkbench.githubAccess.toggle": "Allow reading GitHub issues for this repository",
  "codingWorkbench.githubAccess.repositoryId": "Repository id",
  "codingWorkbench.githubAccess.noRepository":
    "Open a repository as a project to manage its GitHub issue access.",
  "codingWorkbench.githubAccess.loading": "Loading GitHub issue access…",
  "codingWorkbench.githubAccess.enabled": "Enabled",
  "codingWorkbench.githubAccess.disabled": "Disabled",
  "codingWorkbench.githubAccess.error.hydrate":
    "GitHub issue access could not be loaded. Reading stays disabled until it is confirmed.",
  "codingWorkbench.githubAccess.error.persist":
    "GitHub issue access could not be saved. The previous server-confirmed setting remains active.",
  "codingWorkbench.githubAccess.error.conflict":
    "GitHub issue access changed elsewhere. The current server state was reloaded; review it and try again.",
  "codingWorkbench.githubAccess.error.unknown-repository":
    "This path is not an opened project. Open the repository as a project before changing its GitHub issue access.",
  "codingWorkbench.trust.restrictedNotice":
    "Verification needs to run this repository's package scripts, and they are not yet trusted.",
  "codingWorkbench.trust.allow": "Allow package scripts for verification",
  "codingWorkbench.trust.allowing": "Allowing…",
} as const;

export type CodingWorkbenchMessageKey = keyof typeof EN_CODING_WORKBENCH_MESSAGES;
export type CodingWorkbenchMessageCatalog = Readonly<Record<CodingWorkbenchMessageKey, string>>;
