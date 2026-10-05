export const EN_MESSAGES = {
  "editor.taskWorkspaceAccess.checking": "Connecting to the task workspace…",
  "editor.taskWorkspaceAccess.checkingDescription":
    "Keiko is checking this browser's local workspace access.",
  "editor.taskWorkspaceAccess.unpairedTitle": "Browser session not paired",
  "editor.taskWorkspaceAccess.unpairedDescription":
    "The selected project is available, but this browser has no launcher permission for private task-workspace content. Restart Keiko through its launcher.",
  "editor.taskWorkspaceAccess.title": "Task workspace unavailable in this browser",
  "editor.taskWorkspaceAccess.description":
    "Restart Keiko through the launcher, or choose a folder or repository from the workspace context above.",
  "editor.taskWorkspaceAccess.retry": "Check again",
  "editor.multiRoot.label": "Multi-root editor",
  "editor.multiRoot.switcher": "Editor workspace roots",
  "editor.multiRoot.error": "Unable to update the focused workspace root.",
  "app.skipToContent": "Skip to content",
  "app.workspaceHeading": "Keiko workspace",
  "header.tileAll": "Tile all windows",
  "header.lockLayout": "Lock layout",
  "header.unlockLayout": "Unlock layout",
  "header.splitFront": "Split front windows",
  "header.cascade": "Cascade windows",
  "rail.primaryNavigation": "Primary workspace navigation",
  "rail.newChat": "New chat",
  "rail.codingHistory": "Coding History",
  "window.type.codingHistory.title": "Coding History",
  "window.type.codingHistory.desc": "Resume coding tasks",
  "rail.chatHistory": "Chat History",
  "rail.memoria": "MemoriaViva",
  "rail.quality": "Quality Intelligence",
  "rail.promptEnhancer": "Prompt Enhancer",
  "rail.coding": "Coding Workbench",
  "rail.localKnowledge": "Local Knowledge",
  "rail.editor": "Editor",
  "editor.empty.opening": "Opening…",
  "supportReport.globalFailure": "Keiko encountered an error.",
  "supportReport.readinessUnavailable": "Error reports may currently be incomplete.",
  "supportReport.create": "Create error report",
  "supportReport.creating": "Creating report…",
  "supportReport.download": "Download report",
  "supportReport.expired": "Download link expired. Regenerate this report.",
  "supportReport.regenerate": "Regenerate report",
  "supportReport.limitedReady": "Limited report ready (server diagnostics unavailable).",
  "supportReport.saved": "Report ready. Download it and send it to support.",
  "supportReport.failed": "Report unavailable. Try again.",
  "supportReport.sessionDenied": "Report unavailable in this browser. Try creating it again.",
  "supportReport.serviceUnavailable":
    "Report unavailable. Check that Keiko is running locally, then retry.",
  "supportReport.rateLimited": "Please wait a minute, then retry this report.",
  "editor.projectRestricted": "Workspace scripts are unavailable.",
  "editor.runtime.loadFailed": "File could not be opened.",
  "editor.runtime.retry": "Retry",

  "editor.command.openProblems": "Open Problems",
  "editor.command.openFileHistory": "Open File History",
  "editor.command.runFileTests": "Run Tests for File",
  "editor.command.runTypecheck": "Run Typecheck",
  "editor.command.runLint": "Run Lint",
  "editor.command.runBuild": "Run Build",
  "editor.command.cancelVerification": "Cancel Verification",
  "editor.command.trustWorkspaceScripts": "Trust Workspace Scripts",
  "editor.command.revokeWorkspaceScriptTrust": "Revoke Workspace Script Trust",
  "settings.profiles.reset": "Reset to Default",
  "settings.profiles.portabilityTitle": "Profile portability",
  "settings.profiles.portabilityDescription":
    "Export a server-redacted profile or preview every setting before importing it as a new profile.",
  "settings.profiles.export": "Export selected profile",
  "settings.profiles.importFile": "Import profile file",
  "settings.profiles.switchAfterImport": "Switch after import",
  "settings.profiles.proposedName": "New profile: {name}",
  "settings.profiles.setting": "Setting",
  "settings.profiles.disposition": "Change",
  "settings.profiles.value": "Value or reason",
  "settings.profiles.disposition.add": "Add",
  "settings.profiles.disposition.change": "Change",
  "settings.profiles.disposition.noOp": "No change",
  "settings.profiles.disposition.rejected": "Rejected",
  "settings.profiles.applyImport": "Apply import",
  "settings.profiles.exported": "Profile exported.",
  "settings.profiles.exportedRedacted": "Profile exported with {count} unsafe value(s) removed.",
  "settings.profiles.imported": "Profile imported as a new profile.",
  "settings.profiles.fileTooLarge": "The profile file exceeds the 64 KiB import limit.",
  "settings.profiles.invalid": "The profile import could not be validated or applied.",
  "settings.profiles.stale": "Profiles changed after the preview. Preview the file again.",
  "boundRoot.pickerLabel": "{surface} root",
  "boundRoot.surface.problems": "Problems",
  "boundRoot.surface.debug": "Debug",
  "boundRoot.surface.terminal": "Terminal",
  "boundRoot.surface.commands": "Commands",
  "boundRoot.surface.runtime": "Runtime",
  "boundRoot.surface.governedGit": "Git",
  "boundRoot.surface.governedPullRequest": "Pull request",
  "boundRoot.surface.governedMerge": "Merge",
  "boundRoot.surface.containerStatus": "Containers",
  "boundRoot.denied.title": "Choose a workspace root",
  "boundRoot.denied.rootBindingRequired":
    "This window acts on one workspace root and none was chosen. The focused root is never used automatically, so choose a root above to continue.",
  "boundRoot.denied.placeholder": "No root chosen",
  "workspaceTrust.title": "Workspace Trust",
  "workspaceTrust.restrictedMode": "Restricted Mode",
  "workspaceTrust.trustedMode": "Trusted workspace",
  "workspaceTrust.unavailable": "Workspace Trust unavailable",
  "workspaceTrust.manage": "Manage Workspace Trust",
  "workspaceTrust.loading": "Loading server-owned trust state…",
  "workspaceTrust.retry": "Retry",
  "workspaceTrust.loadFailed":
    "Workspace Trust could not be read safely. Execution capabilities remain unavailable.",
  "workspaceTrust.updateFailed":
    "The server did not confirm the trust change. This workspace remains restricted.",
  "workspaceTrust.updateFailedTrusted":
    "The server did not confirm the trust change. This workspace remains trusted.",
  "workspaceTrust.errorCode": "Error code: {code}",
  "workspaceTrust.supportId": "Support ID: {correlationId}",
  "workspaceTrust.banner.editor":
    "Workspace scripts, language servers, and agent execution remain unavailable for this root.",
  "workspaceTrust.banner.commands":
    "Repository-authored commands remain disabled until this root is trusted.",
  "workspaceTrust.banner.languages":
    "Managed language servers remain disabled until this root is trusted.",
  "workspaceTrust.reason.humanGrant": "Trust was granted explicitly for the current workspace.",
  "workspaceTrust.reason.derivedFromTrustedRoot": "Derived from the trusted repository.",
  "workspaceTrust.reason.humanRevocation": "Trust was revoked explicitly for this workspace.",
  "workspaceTrust.reason.identityChanged": "Trust expired because the workspace identity changed.",
  "workspaceTrust.reason.manifestChanged": "Trust expired because the workspace manifest changed.",
  "workspaceTrust.reason.trustBasisChanged":
    "Trust expired because the workspace manifest changed.",
  "workspaceTrust.reason.policy": "Deployment policy requires this workspace to stay restricted.",
  "workspaceTrust.reason.stateUnavailable":
    "No current server-validated trust grant is available for this workspace.",
  "workspaceTrust.dialog.grantTitle": "Trust this workspace?",
  "workspaceTrust.dialog.grantBody":
    "Trusting allows workspace scripts, language servers, and agent execution for this root. Repository-authored code may run with the authority allowed by policy.",
  "workspaceTrust.dialog.revokeTitle": "Revoke trust for this workspace?",
  "workspaceTrust.dialog.revokeBody":
    "Revoking trust stops or disables workspace scripts, language servers, and agent execution for this root.",
  "workspaceTrust.dialog.serverConfirmed":
    "Keiko changes capabilities only after the server confirms the decision.",
  "workspaceTrust.dialog.cancel": "Cancel",
  "workspaceTrust.dialog.trust": "Trust workspace",
  "workspaceTrust.dialog.revoke": "Revoke trust",
  "workspaceTrust.dialog.waiting": "Waiting for server…",
  "workspaceTrust.action.trust": "Trust",
  "workspaceTrust.action.revoke": "Revoke",
  "workspaceTrust.management.description":
    "Review every registered root and make an explicit trust decision. Trust decisions are stored and enforced by the local server.",
  "workspaceTrust.management.digestHelp":
    "A grant is bound to the current workspace identity and manifest. Keiko returns to Restricted Mode when either changes.",
  "workspaceTrust.management.empty": "No registered workspace roots are available.",
  "workspaceTrust.settings.description":
    "Review or revoke the execution trust assigned to registered workspace roots.",
  "workspaceTrust.settings.open": "Open Workspace Trust",
  "rail.figma": "Figma Snapshot",
  "rail.lightMode": "Light mode",
  "rail.darkMode": "Dark mode",
  "rail.settings": "Settings",
  "common.optional": "optional",
  "common.loading": "Loading...",
  "window.chunkStalled": "This window did not finish loading.",
  "common.cancel": "Cancel",
  "common.retry": "Retry",
  "common.dismissError": "Dismiss error",
  "common.status": "Status",
  "common.duration": "Duration",
  "common.confidence": "Confidence",
  "common.save": "Save",
  "common.saving": "Saving…",
  "common.delete": "Delete",
  "common.continue": "Continue",
  "common.browse": "Browse",
  "common.working": "Working…",
  "common.tryAgain": "Try again",
  "common.dismiss": "Dismiss",
  "common.on": "on",
  "common.off": "off",
  "common.close": "Close",
  "common.advanced": "advanced",
  "gatewaySetup.loading.title": "Preparing model gateway setup",
  "gatewaySetup.loading.description":
    "Loading the local setup controls. No provider request has been started.",
  "gatewaySetup.loading.error": "The setup controls could not be loaded.",
  "gatewaySetup.workflowEligibleModels": "Coding-safe workflow models",
  "gatewaySetup.workflowEligibleModelsPlaceholder":
    "Paste explicitly approved coding model names, one per line",
  "gatewaySetup.unusable.unsupported": " Not used (mode declared by the gateway): {models}.",
  "gatewaySetup.unusable.dropped": " Embedding verification failed, not stored: {models}.",
  "gatewaySetup.unusable.unverified": " Kept but unverified as embedding models: {models}.",
  "gatewaySetup.unusable.unverifiedChat": " Kept but unverified as chat models: {models}.",
  // The shell undo stack records panel toggles only — no window move/resize/maximize/close reaches
  // it — so the empty-stack labels name that scope instead of promising window changes.
  "shell.command.undo.target": "Undo: {target}",
  "shell.command.undo.panelOnly": "Undo (panel changes only)",
  "shell.command.redo.target": "Redo: {target}",
  "shell.command.redo.panelOnly": "Redo (panel changes only)",
  "workspace.selection.none": "No workspace windows selected",
  "workspace.binding.restoreVerificationFailed":
    "The active task workspace failed re-verification. Re-bind it before starting a coding run.",
  "workspace.binding.provisionFailed":
    "The task workspace could not be verified and activated. Review the repository and try again.",
  "workspace.binding.repairOperatorRequired":
    "This recovery needs an operator first. Inspect the managed worktree, then retry the repair.",
  "workspace.selection.one": "1 workspace window selected",
  "workspace.selection.many": "{count} workspace windows selected",
  "workspace.clipboard.copied.one": "1 window copied",
  "workspace.clipboard.copied.many": "{count} windows copied",
  "workspace.clipboard.cut.one": "1 window cut",
  "workspace.clipboard.cut.many": "{count} windows cut",
  "workspace.clipboard.pasted.one": "1 window pasted",
  "workspace.clipboard.pasted.many": "{count} windows pasted",
  "workspace.clipboard.skipped.one": "1 selected window skipped (not duplicable)",
  "workspace.clipboard.skipped.many": "{count} selected windows skipped (not duplicable)",
  "workspace.clipboard.overflow.one": "1 more window did not fit this copy",
  "workspace.clipboard.overflow.many": "{count} more windows did not fit this copy",
  "workspace.clipboard.noSelection": "Select one or more windows first",
  "workspace.clipboard.nothingToPaste": "Nothing to paste — copy or cut windows first",
  "workspace.clipboard.workspaceFull": "The workspace has no room for more windows",
  "workspace.clipboard.noneEligible":
    "The selected windows can't be duplicated — chat and single-instance windows are excluded",
  "workspace.window.selectedLabel": "{label} — selected",
  "workspace.surface": "Workspace surface",
  "workspace.connectHint": "Click a highlighted window to connect. Esc cancels.",
  "workspace.zoomOut": "Zoom out",
  "workspace.zoomIn": "Zoom in",
  "workspace.fitToWindows": "Fit workspace to windows",
  "workspace.zoomReset": "{percent}% - reset",
  "workspace.reset": "Reset",
  "workspace.newWindow": "New window",
  "shell.error.title": "Keiko could not open the workspace",
  "shell.error.body":
    "The desktop failed while rendering, so nothing could be shown. Your projects, chats and files are untouched.",
  "shell.error.hint":
    "A saved keyboard shortcut override is the usual cause, and it is reapplied on every start. Reset the saved shortcuts to clear it, or reload if you think the failure was one-off.",
  "shell.error.resetShortcuts": "Reset saved shortcuts and reload",
  "shell.error.reload": "Reload Keiko",
  "shell.error.resetFailed":
    "The saved shortcuts could not be reset. Reload to try again, or edit the saved settings outside Keiko.",
  "window.error.title": "This window hit an error",
  "window.error.body": "Please try again.",
  "window.tooSmall.title": "Too small to show {label}",
  "window.tooSmall.body": "Enlarge the window or zoom its content out",
  "window.connectPort.title": "Click to connect to another window",
  "window.connectPort.aria": "Connect {title} from {edge} edge",
  "window.edge.top": "top",
  "window.edge.right": "right",
  "window.edge.bottom": "bottom",
  "window.edge.left": "left",
  // Issue: German locale coverage. Window-type display copy lives HERE, not as literals in
  // WindowsRegistry.ts — the launcher grid, the New Window dialog, the workspace command list
  // and the window chrome all resolve it through `localizedWindowTitle`/`localizedWindowDesc`, so
  // one locale switch moves every surface instead of leaving an English name behind.
  "window.type.chat.title": "Chat",
  "window.type.chat.desc": "Talk to Keiko",
  "window.type.chatHistory.title": "Chat History",
  "window.type.chatHistory.desc": "Manage conversations",
  "window.type.memoria.title": "MemoriaViva",
  "window.type.memoria.desc": "Review governed memory",
  "window.type.files.title": "Files",
  "window.type.files.desc": "Browse a folder",
  "window.type.editor.title": "Editor",
  "window.type.editor.desc": "Open a folder or file",
  "window.type.browser.title": "Browser",
  "window.type.browser.desc": "Open a URL",
  "window.type.docbrowser.title": "Documentation Browser",
  "window.type.docbrowser.desc": "Inspect a local or intranet HTML manual",
  "window.type.terminal.title": "Terminal",
  "window.type.terminal.desc": "Run commands",
  "window.type.commands.title": "Tasks",
  "window.type.commands.desc": "Run test/build/run tasks",
  "window.type.runtime.title": "Runtime",
  "window.type.runtime.desc": "Runtime, Git, tasks, and audit",
  "window.type.coding.title": "Coding Workbench",
  "window.type.coding.desc": "Govern coding agents",
  "window.type.containerStatus.title": "Containers",
  "window.type.containerStatus.desc": "Container engine status & diagnostics",
  "window.type.review.title": "Review",
  "window.type.review.desc": "Review a proposed diff",
  "window.type.agents.title": "Agents",
  "window.type.agents.desc": "Choose a coding agent",
  "window.type.integ.title": "Connector Management",
  "window.type.integ.desc": "Manage server-owned connectors, scopes, sync, and approvals",
  "window.type.settings.title": "Settings",
  "window.type.settings.desc": "Preferences",
  "window.type.workspaceTrust.title": "Workspace Trust",
  "window.type.workspaceTrust.desc": "Manage Restricted Mode per workspace",
  "window.type.updates.title": "Updates",
  "window.type.updates.desc": "Review available updates",
  "window.type.project.title": "Project",
  "window.type.project.desc": "Project tree",
  "window.type.search.title": "Search",
  "window.type.search.desc": "Search the workspace",
  "window.type.plugins.title": "Plugins",
  "window.type.plugins.desc": "Plugins & tools",
  "window.type.automations.title": "Automations",
  "window.type.automations.desc": "Workflow automations",
  "window.type.mobile.title": "Keiko Mobile",
  "window.type.mobile.desc": "Mobile companion",
  "mobile.previewNotice": "Preview — no pairing is wired yet",
  "mobile.subtitle": "Mobile companion — not yet available.",

  "window.type.inspector.title": "Inspector",
  "window.type.inspector.desc": "Inspect the workspace",
  "window.type.activity.title": "Activity",
  "window.type.activity.desc": "Activity timeline",
  "activity.timeline.label": "Activity timeline",
  "activity.empty.title": "No activity yet.",
  "activity.empty.description": "Start a code task to see its runtime events here.",
  "activity.actor.workspace": "Workspace",
  "activity.event.unknown": "Runtime activity",
  "activity.event.runtimeStarted": "Runtime started",
  "activity.event.runtimeStopped": "Runtime stopped",
  "activity.event.runtimeHealth": "Runtime health changed",
  "activity.event.taskSubmitted": "Task submitted",
  "activity.event.observationStreamed": "Runtime observation received",
  "activity.event.permissionRequested": "Approval requested",
  "activity.event.diffSummarized": "Diff summary recorded",
  "activity.event.verificationSummarized": "Verification summary recorded",
  "activity.event.artifactProduced": "Delivery artifact produced",
  "activity.event.researchPerformed": "Governed research completed",
  "activity.event.skillInvoked": "Skill invocation completed",
  "activity.event.childRunStarted": "Child run started",
  "activity.event.childRunCompleted": "Child run completed",
  "activity.event.operatorDecision": "Your decision needed",
  "activity.event.operatorDecisionAccepted": "Your decision was applied",
  "activity.event.operatorDecisionDenied": "Your decision declined the request",
  "activity.event.operatorDecisionUnavailable": "The decision could not be taken",
  "activity.event.operatorDecisionExpired": "The decision window closed",
  "activity.event.operatorDecisionStopped": "The decision ended with the run",
  "activity.event.failureRedacted": "Runtime failure recorded",
  "activity.kind.step": "Step",
  "activity.kind.approval": "Approval requested",
  "activity.kind.approved": "Approved",
  "activity.kind.rejected": "Rejected",
  "activity.kind.stopped": "Stopped",
  "activity.kind.open": "Opened",
  "activity.kind.run": "Run",
  "activity.kind.delivery": "Delivery",
  "window.type.notifications.title": "Notifications",
  "window.type.notifications.desc": "Review alerts & updates",
  "notifications.empty": "No notifications yet.",
  "notifications.previewNotice": "Preview — no notification source is wired yet",
  "automations.status.preview": "Preview",
  "plugins.mcp.previewHeader": "Preview — no server wired",
  "plugins.mcp.rowStatusPreview": "Preview",
  "voiceDialog.interrupt.action": "Interrupt",
  "voiceDialog.interrupt.ariaLabel": "Interrupt the assistant",
  "voiceDialog.interrupt.unavailableHint": "Available only while the assistant is speaking",

  // #2906 round 3: terse, title-free labels for the SAME actions' visible button text (the
  // aria-labels above stay title-bearing for KEIKO-0452 per-row uniqueness). Visible text must be
  // localized too, or a German-locale screen-reader user gets a German accessible name with no
  // German text printed anywhere on the button (WCAG 2.5.3 Label in Name).

  "window.type.resources.title": "Resources",
  "window.type.resources.desc": "Shared assets & references — coming soon.",
  "window.type.connector.title": "Knowledge Pod",
  "window.type.connector.desc": "Pick a Knowledge Pod source",
  "window.type.localKnowledge.title": "Local Knowledge",
  "window.type.localKnowledge.desc": "Manage Knowledge Pods",
  "window.type.problems.title": "Problems",
  "window.type.problems.desc": "Diagnostics and verification failures",
  "window.type.debug.title": "Debug",
  "window.type.debug.desc": "Governed debug session state",
  "window.type.quality.title": "Quality Intelligence",
  "window.type.quality.desc": "Design & review test cases",
  "window.type.promptEnhancer.title": "Prompt Enhancer",
  "window.type.promptEnhancer.desc":
    "Turn a raw prompt into a governed, reviewable Enhanced Prompt",
  "window.type.qiRun.title": "QI Run",
  "window.type.qiRun.desc": "Generated test cases",
  "window.type.relationships.title": "Relationships",
  "window.type.relationships.desc": "Inspect the relationship graph",
  "window.type.figma.title": "Figma Snapshot",
  "window.type.figma.desc": "Manage Figma snapshots",
  "window.type.figmaView.title": "Figma View",
  "window.type.figmaView.desc": "Inspect a scoped Figma screen view",
  "window.type.figmaJson.title": "Figma JSON",
  "window.type.figmaJson.desc": "Inspect scoped Figma Screen-IR JSON",
  "window.type.figmaImage.title": "Figma Image",
  "window.type.figmaImage.desc": "Inspect a scoped Figma screen render",
  "window.type.pdfCitationPreview.title": "PDF Preview",
  "window.type.pdfCitationPreview.desc": "Read a verified PDF preview in Keiko",
  "window.type.governedGit.title": "Git",
  "window.type.governedGit.desc": "Branch, stage, commit, and publish",
  "window.type.governedPullRequest.title": "Pull Request",
  "window.type.governedPullRequest.desc": "Open a review-ready PR under policy",
  "window.type.governedMerge.title": "Merge",
  "window.type.governedMerge.desc": "Merge a review-ready PR under policy",
  "window.type.agents.cta": "Start agent",
  "window.field.title": "Title",
  "window.field.folder": "Folder",
  "window.field.filePath": "File path",
  "window.field.url": "URL",
  "window.field.documentationAddress": "Documentation address",
  "window.field.projectPath": "Project path",
  "window.field.workingDirectory": "Working directory",
  "window.field.previewState": "Preview state",
  "window.field.runId": "Run ID",
  "window.field.provider": "Provider",
  "window.field.headBranch": "Head branch",
  "window.placeholder.chatTitle": "Name this conversation",
  "window.placeholder.folderPath": "/absolute/folder/path",
  "window.placeholder.relativeFilePath": "optional relative file path",
  "window.placeholder.url": "https://…",
  "window.placeholder.documentationAddress": "https://intranet/handbook or file:///…",
  "window.placeholder.runId": "e.g. r-2026-06-01-…",
  "window.default.chatTitle": "New chat",
  "window.zoomOut": "Zoom {label} content out",
  "window.zoomReset": "{percent}% — reset {label} content zoom",
  "window.zoomIn": "Zoom {label} content in",
  "window.controls": "{label} window controls",
  "window.minimize": "Minimize {label} window",
  "window.restore": "Restore {label} window",
  "window.fullscreen": "Full screen {label} window",
  "window.close": "Close {label} window",
  "workspace.connect.fallbackTitle": "window",
  "workspace.connect.start":
    "Connecting from {title}. Tab to a highlighted window and press Enter on it or one of its connection ports to connect. Press Escape to cancel.",
  "workspace.connect.cancelled": "Connection cancelled",
  "workspace.connect.notConnected": "Could not connect.",
  "workspace.connect.connected": "Connected",
  "workspace.connect.connectedWith": "Connected: {label}",
  "palette.description": "Pick a card to add to your workspace",
  "palette.placeholder": "Preview",
  "palette.placeholderLabel": "Preview surface — not a working feature yet",
  "newWindow.title": "New {label} window",
  "newWindow.open": "Open {label}",
  "newWindow.empty": "Add a new {label} window to your workspace.",
  "newWindow.unexpectedError": "Something went wrong.",
  "nativeDialog.busy": "A native dialog is already open. Close it first.",
  "nativeDialog.unsupported":
    "Native dialogs are unavailable on this platform. Enter the path manually.",
  "nativeDialog.selectFolder": "Select folder",
  "nativeDialog.selectRepository": "Select repository folder",
  "nativeDialog.selectSourceFile": "Select source file",
  "command.group.create": "Create",
  "command.group.tools": "Tools",
  "command.group.layout": "Layout",
  "command.group.view": "View",
  "command.group.edit": "Edit",
  "command.group.commands": "Commands",
  "command.group.editor": "Editor",
  "command.new": "New {label}",
  "command.open": "Open {label}",
  "command.openEditorSettings": "Open Editor settings",
  "command.toggleTheme": "Toggle light / dark theme",
  "command.undo": "Undo (window and panel changes only)",
  "command.undoLabelled": "Undo: {label}",
  "command.redo": "Redo (window and panel changes only)",
  "command.redoLabelled": "Redo: {label}",

  // #3591: gateway failures on the desktop chat surfaces (format-error.ts). A slow gateway is not a
  // broken gateway, and neither text blames the size of the request.
  "chat.error.scopeChanged.title": "Connected sources changed",
  "chat.error.scopeChanged.message":
    "The connected sources changed in the meantime. The request was not run with an outdated source list.",
  "chat.error.scopeChanged.remediation":
    "Check the Chat's current sources, then send your request again.",
  "chat.error.gatewayTimeout.title": "Model gateway did not answer in time",
  "chat.error.gatewayTimeout.message":
    "The model gateway did not complete the request within Keiko's wait limit. Keiko keeps waiting for minutes on a slow gateway, so this usually means the gateway or the model stalled — not that the request was too large.",
  "chat.error.gatewayTimeout.remediation":
    "Retry, or check gateway URL, proxy, and deployment in Settings if it keeps happening.",
  "chat.error.gatewayOutputExhausted.title": "Model ran out of output budget",
  "chat.error.gatewayOutputExhausted.message":
    "The model used its whole output budget before producing an answer, usually on reasoning. Have the gateway declare a larger max_output_tokens for this model, or choose a model with a smaller reasoning share, then retry.",
  "chat.error.gatewayOutputExhausted.remediation":
    "Raise the model's max output tokens in Settings, or switch to a model with a smaller reasoning share, then retry.",
  "chat.error.streamStalled.title": "Connection to the answer interrupted",
  "chat.error.streamStalled.message":
    "The connection to Keiko delivered nothing for a minute. The answer was stopped.",
  "chat.error.streamStalled.remediation":
    "Send the message again. If it keeps happening, check the network, the proxy, or whether Keiko restarted.",
  "chat.error.contextOverflow.title": "Request larger than the context window",
  "chat.error.contextOverflow.message":
    "The request exceeds the model's context window. If the provider reports its window, Keiko adopts it.",
  "chat.error.contextOverflow.remediation":
    "Shorten the message or choose a model with a larger context window.",
  "chat.error.attachmentOversized.message": "Attached content is too large. Shorten or remove it.",

  // Editor-agent surface messages live in the lazy `editor-agent-i18n.ts` namespace so opening the
  // workspace shell does not preload editor-only translations. Issue #2120 added the localized
  // agent-presence-indicator labels to that lazy namespace (EN/DE) rather than this shell catalog.
  // M7 editor personalization messages likewise live in the lazy `settings-i18n.ts` namespace;
  // this catalog touch records the required English-copy review without preloading editor settings.
  // The Epic #2092 audit follow-up (verification-target scoping in EditorRuntimeWidget.tsx, tab-
  // eviction correctness in ProblemsPanel.tsx) is purely behavioral and introduces no new strings;
  // Problems-panel text lives in the lazy `problems-i18n.ts` namespace, also unaffected.
  // Governed-debug panel, gutter, prompt, command, status, and accessibility text lives in the
  // existing lazy `debugging-i18n.ts` EN/DE catalog so dormant debugging stays out of the shell.
  // The Epic #2096 audit follow-up added the accessible breakpoint-text dialog, the keyboard-
  // reachable breakpoint inventory, the current-execution-line gutter marker, the exception-pause
  // announcement, and the setVariable side-effect disclosure to that same lazy `debugging-i18n.ts`
  // namespace, so no new shell-catalog keys are introduced here either.
  // The Epic #2093 audit follow-up (unavailable-repository contract-shape fix in gitRoutes.ts,
  // wiring the previously-dead EditorAgentSessionSnapshot.gitContextSummary producer in
  // EditorRuntimeWidget.tsx) is likewise purely behavioral and introduces no new strings; the
  // source-control labels it touches live in the lazy `editor-source-control-i18n.ts` namespace.
  // The Epic #2095 audit follow-up added the AI-assist activation confirm dialog's
  // confirmTitle/confirmAccept/confirmDecline keys to the lazy `settings-i18n.ts` namespace
  // (replacing a window.confirm() call) rather than this shell catalog.

  "chat.hero.title": "What should we build?",
  "chat.hero.loadingWorkspace": "Loading local workspace...",
  "chat.hero.placeholder": "Describe a task, paste a link, or ask anything...",
  "chat.workLocally": "Work locally",

  "chat.composer.loading": "Loading...",

  "chat.model.title": "Model",

  "chat.model.noneConfiguredTitle":
    "No conversation-eligible model is configured - connect a gateway in Settings",

  "chat.voice": "Voice",
  "chat.voice.interrupt": "Interrupt the assistant",
  "chat.voice.interruptShort": "Interrupt",
  "chat.voice.interruptAvailable": "Available while Keiko is speaking.",

  "chat.error.load": "Could not load chat.",

  "chat.error.supportId": "Support ID: {correlationId}",

  "chat.grounding.sourceLimit":
    "Source limit reached — this chat already has {connectedCount} of {cap} connected sources. Disconnect a source before connecting another.",
  "chat.grounding.readyChatRequired": "Open a ready chat window before connecting a source.",
  "chat.grounding.localFolderRequired": "Choose a local folder before connecting it to chat.",
  "chat.grounding.scopeOwnershipMissing":
    "This source connection cannot be restored uniquely. You can remove the connection while keeping the chat’s sources.",
  "chat.grounding.forgetConnection": "Remove connection only; keep chat sources",
  "chat.grounding.recoveryRequired":
    "Chat grounding recovery failed. Reload the chat before connecting another source.",
  "chat.grounding.timeoutBlocked":
    "Chat grounding is blocked after a timeout. Reload the chat before trying again.",
  "chat.grounding.connectSourceFailed":
    "Keiko could not connect that source. Check that it is still available and try again.",
  "chat.grounding.connectKnowledgeFailed":
    "Keiko could not connect that knowledge source. Check that it is still available and try again.",
  "chat.grounding.connectGitChangeFailed":
    "Keiko could not connect that Git change. Check that the repository and branches are still available and try again.",

  "memoria.memoryLabel": "Memory",

  "memoria.settings.enabled": "Enabled for chat",
  "memoria.settings.disabled": "Disabled for chat",
  "memoria.settings.useInChat": "Use in chat",
  "memoria.settings.useInChatHelp": "Attach relevant memories when the next request is sent.",
  "memoria.settings.useInChatLabel": "Use MemoriaViva in chat requests",

  "memoria.settings.mode.hydrateError":
    "The memory autonomy mode could not be loaded. Ask for approval remains active.",
  "memoria.settings.mode.persistError":
    "The memory autonomy mode could not be saved. The previous mode remains active.",

  "attachment.notSupported": "Attachments not supported",

  "footer.status": "Workspace status",
  "footer.version": "Keiko version {version}",
  "footer.versionLoading": "version loading",
  "footer.versionUnavailable": "version unavailable",
  "footer.windowSingular": "{count} window",
  "footer.windowPlural": "{count} windows",
  "footer.openWindows": "Open windows",
  "footer.minimized": "Minimized",
  "footer.fullscreen": "Fullscreen",
  "footer.visible": "Visible",
  "footer.restore": "Restore",
  "footer.focus": "Focus",
  "footer.windowAction": "{action} {title} window{suffix}",
  "scope.pressure.low": "Low",
  "scope.pressure.moderate": "Moderate",
  "scope.pressure.high": "High",
  "scope.pressure.exceeded": "Exceeded",
  "scope.connectedFolder": "Connected folder",
  "scope.folder": "Folder: {name}",
  "scope.repository": "Repository scope",
  "scope.connectedFile": "Connected file",
  "scope.file": "File: {name}",
  "scope.filesConnected": "{count} files connected",
  "scope.boundary.repository":
    "Keiko may inspect only the connected repository; safe-read exclusions and context budget limits apply before each answer.",
  "scope.boundary.folder":
    "Keiko may inspect only the connected folder; safe-read exclusions and context budget limits apply before each answer.",
  "scope.boundary.file":
    "Keiko may inspect only the connected file scope; safe-read exclusions and context budget limits apply before each answer.",
  "scope.disconnectError": "Unable to disconnect scope.",
  "settings.title": "Settings",
  "settings.language.compactLabel": "Language",
  "updates.notice.aria": "Keiko update notification",
  "updates.notice.title": "Update available",
  "updates.notice.criticalTitle": "Critical update available",
  "updates.notice.releaseUnavailableTitle": "Update check unavailable",
  "updates.notice.body":
    "Version {version} is ready to review. Keiko will not install it automatically.",
  "updates.notice.releaseUnavailableBody":
    "Keiko could not verify update download information right now. It will not install anything.",
  "updates.notice.portableBody":
    "Version {version} is ready. Open updates, then click Update when you are ready.",
  "updates.notice.portableSetupBody":
    "Portable setup is required before Keiko can use in-app updates.",
  "updates.notice.portableExternallyManagedBody":
    "This Keiko install is managed outside the app. Open updates for details.",
  "updates.notice.review": "Review update",
  "updates.notice.notNow": "Not now",
  "updates.versionUnknown": "unknown",

  "updates.status.current": "Keiko is up to date",
  "updates.status.available": "Update available",
  "updates.status.critical": "Critical update available",
  "updates.status.degraded": "Update status degraded",
  "updates.status.unavailable": "Update status unavailable",
  "updates.status.releaseUnavailable": "Update check unavailable",
  "updates.status.installing": "Installing update",
  "updates.status.restart": "Restart required",
  "updates.status.success": "Update installed",
  "updates.status.failed": "Update failed",

  "updates.impact.required": "Required action: {remediation}",

  "updates.remediation.none": "No action required",
  "updates.remediation.restart": "Restart required",
  "updates.remediation.repair": "Local state repair",
  "updates.remediation.reindex": "Local Knowledge Reindex",
  "updates.remediation.migration": "Migration required",
  "updates.remediation.manualReview": "Review required",

  "updates.manual.copySelected": "Text selected. Use your system copy shortcut.",

  "updates.manual.copyFailed": "Copy failed. Select the text and copy it manually.",

  "updates.actionStatus.notNeeded": "Not needed",
  "updates.actionStatus.pending": "Pending",
  "updates.actionStatus.running": "Running",
  "updates.actionStatus.completed": "Completed",
  "updates.actionStatus.failed": "Failed",
  "updates.actionStatus.deferred": "Deferred",
  "updates.actionStatus.manualReview": "Review required",
  "updates.featureState.ready": "Ready",
  "updates.featureState.degraded": "Degraded",
  "updates.featureState.unavailable": "Unavailable",
  "updates.featureState.manualReview": "Review required",
  "updates.phase.preparing": "Preparing update",
  "updates.phase.running": "Installing update",
  "updates.phase.restartRequired": "Restart required",
  "updates.phase.succeeded": "Update installed",
  "updates.phase.failed": "Update failed",
  "updates.phase.cancelled": "Update cancelled",
  "select.placeholder": "Select an option",
  "workspace.empty.openWindow": "Open a new window",
  "workspace.notice.dismiss": "Dismiss workspace notice",
  "workspace.windowLimitReached":
    "The workspace already has {limit} open windows. Close a window and try again.",
  "workspace.empty.description": "Empty workspace. Open a window to start working.",
  "workspace.empty.title": "Empty workspace",
  "workspace.empty.subtitle": "Open a window to start working",
  "scope.pill.connectedFolder": "Connected folder",
  "scope.pill.folder": "Folder: {name}",
  "scope.pill.repositoryScope": "Connected root folder",
  "scope.pill.connectedFile": "Connected file",
  "scope.pill.file": "File: {name}",
  "scope.pill.filesConnected": "{count} files connected",
  "scope.pill.accessibleWithPath": "{label} ({path})",
  "scope.boundary.noun.repository": "the connected root folder",
  "scope.boundary.noun.folder": "the connected folder",
  "scope.boundary.noun.fileScope": "the connected file scope",
  "scope.boundary.description":
    "Keiko may inspect only {noun}; safe-read exclusions and context budget limits apply before each answer.",
  "scope.disconnect.error": "Unable to disconnect scope.",
  "scope.disconnect.aria": "Disconnect {label} from chat",
  "scope.disconnect.title": "Disconnect {label} from chat",
  "scope.disconnect.titleWithPath": "Disconnect {label} from chat ({path})",
  "scope.announcement.removed": "Connected scope removed.",
  "scope.announcement.updated.one": "Connected scope updated: 1 source.",
  "scope.announcement.updated.many": "Connected scope updated: {count} sources.",
  // Issue #3400 (epic #3384) — git-change scope pill (GitChangeScopePill.tsx).

  "scope.budget.pressure.low": "Low",
  "scope.budget.pressure.moderate": "Moderate",
  "scope.budget.pressure.high": "High",
  "scope.budget.pressure.exceeded": "Exceeded",
  "scope.budget.summary": "Last grounded run: {tokens} tokens, {files} files",
  "scope.connect.update": "Update connected scope",
  "scope.connect.repository": "Connect repository",
  "scope.connect.folder": "Connect folder",
  "scope.connect.chat": "Connect to chat",
  "scope.connect.error": "Unable to connect scope.",
  "scope.connect.limitReached":
    "Source limit reached ({connected}/{cap}). Disconnect a source first.",
  "scope.connect.targetAria": "{label}: {target}",
  "scope.connect.selectFirst": "Select a folder or file first",
  "scope.connect.selectFirstSentence": "Select a folder or file first.",
  "scope.connect.noSelectionAria": "Connect to chat (no selection)",
  "scope.connect.connecting": "Connecting…",

  "taskWorkspace.lifecycleState": "Lifecycle state",
  "taskWorkspace.health": "Workspace health",
  "taskWorkspace.dirty.uncommitted": "uncommitted",
  "taskWorkspace.dirty.uncommittedTitle": "The worktree has uncommitted changes",
  "taskWorkspace.dirty.clean": "clean",
  "taskWorkspace.dirty.cleanTitle": "The worktree is clean",

  "taskWorkspace.locked": "locked: {reason}",
  "taskWorkspace.lockedTitle": "Held by {owner}",
  "taskWorkspace.updatedAt": "Updated {value}",
  "taskWorkspace.recoveryHints": "Recovery hints ({count})",
  "taskWorkspace.operatorActionRequired": " (operator action required)",
  "taskWorkspace.marker.worktree-missing": "Worktree missing",
  "taskWorkspace.marker.gitdir-mismatch": "Git pointer mismatch",
  "taskWorkspace.marker.pointer-stale": "Git pointer missing",
  "taskWorkspace.marker.identity-schema-retired": "Identity rule retired",
  "taskWorkspace.marker.identity-unsupported": "Creation time unsupported",
  "taskWorkspace.marker.head-moved": "HEAD moved",
  "taskWorkspace.marker.branch-deleted": "Branch deleted",
  "taskWorkspace.marker.uncommitted-changes": "Uncommitted changes",
  "taskWorkspace.marker.lock-stale": "Stale lock",
  "taskWorkspace.marker.path-escape": "Path escapes managed root",

  "taskWorkspace.noWorkspaceBound": "No workspace bound",

  "taskWorkspace.empty.title": "No active task workspace",
  "taskWorkspace.empty.openProject": "Open a project before creating a managed task workspace.",
  "taskWorkspace.empty.switchOrCreate":
    "Switch to an existing workspace or create one for this repository.",
  "taskWorkspace.available": "Available workspaces",

  "taskWorkspace.create.title": "Create workspace",
  "taskWorkspace.create.taskId": "Task id",
  "taskWorkspace.create.taskIdPlaceholder": "e.g. 446-binding",
  "taskWorkspace.create.baseBranch": "Base branch",
  "taskWorkspace.create.baseBranchPlaceholder": "e.g. dev",
  "taskWorkspace.create.submit": "Create task workspace",
  "workspaceContext.trigger.aria": "Workspace context: {name}",
  "workspaceContext.trigger.choose": "choose a folder",
  "workspaceContext.status.none": "No folder or repository selected",
  "workspaceContext.status.project": "Workspace context: {name}",
  "workspaceContext.folder.title": "Folder or repository",
  "workspaceContext.choose": "Choose a folder",
  "workspaceContext.chooseDialogTitle": "Choose a folder or repository",
  "workspaceContext.dialogBusy": "Another file dialog is already open.",
  "workspaceContext.dialogUnsupported":
    "The native folder dialog is unavailable. Enter the path below.",
  "workspaceContext.selectionFailed":
    "The folder could not be selected. Check the path and try again.",
  "workspaceContext.overrideClearFailed":
    "The active task workspace could not be released, so the folder was not changed. Review the task workspace, then try again.",
  "workspaceContext.supportId": "Support ID: {correlationId}",
  "workspaceContext.selecting": "Selecting…",
  "workspaceContext.manual.label": "Or enter a local path",
  "workspaceContext.manual.placeholder": "/path/to/folder",
  "workspaceContext.open": "Open",

  // Graph health panel (#542). A BOUNDED scan may never certify a clean graph, so the copy
  // separates "healthy" from "partial — inconclusive", and every count that came out of a
  // truncated category is worded as a lower bound.

  // Relationship list recovery (error-and-denial-ux.md §"Bounded-query-exceeded UX": the
  // rejected-query banner offers a reset, so a poisoned view state is never a dead end).

  // Bounded impact walk (#542): a failed walk must say so instead of showing an em dash and a
  // permanent "Loading…", and the impacted set excludes the origin relationship itself.

  "relationships.impact.forward": "Forward dependencies",
  "relationships.impact.reverse": "Reverse dependencies",
  // Epic #2093 source-control copy is intentionally feature-local so the editor remains lazy.
  // Issue #2150: Workspace.tsx/WindowFrame.tsx changed but added no new
  // user-facing strings — check:ui-i18n flags any edit to a file that uses
  // useTranslate() regardless of the diff, so this file is touched to
  // satisfy that fail-closed gate with no new keys.

  // Issue #2245 (Epic #2238) — Atlassian connector setup, sync, and write-approval surfaces.

  "atlassianConnectors.add.title": "Add connector",

  "atlassianConnectors.scope.title": "Scope",

  "atlassianConnectors.sync.title": "Sync",

  // The voice-dialogue composer motion update adds no user-facing copy; this
  // catalog touch records the required English-copy review for ChatWindow.tsx.
  // The SonarCloud cognitive-complexity refactor (S3776) reflows JSX in
  // ChatWindow.tsx, GatewaySetupDialog.tsx, UpdateWindow.tsx, EditorDiffSurface.tsx,
  // GitClientWindow.tsx, FigmaSnapshotWindow.tsx, QiRunCard.tsx, RunLauncher.tsx, and
  // HealthScanFindings.tsx without changing any user-facing copy; this catalog touch
  // records the required English-copy review.
  // New i18n keys for the quality-widgets retrofit: AgentRunWidget, FilePreview,
  // FilesWidget, PdfCitationPreviewWindow, ReviewWidget, FigmaSnapshotWindow.
  "filePreview.showSource": "Show source preview",
  "filePreview.linesAdded": "{count} lines added.",
  "filePreview.revealedLine": "Source line {line}.",
  "filePreview.revealedPartialRange":
    "Source lines {start}–{end} shown. More referenced lines are outside this view.",
  "filePreview.revealedRange": "Source lines {start}–{end}.",
  "filePreview.revealOutsideContent":
    "The referenced line {line} is outside this file ({count} lines).",
  "filePreview.deniedMessage":
    "This file is excluded from the read surface for safety (matches a deny pattern such as .env, *.pem, node_modules, .git, …).",
  "filePreview.searchableDocument":
    "{format} files up to 2 MB are searchable in Repository Search via bounded text extraction when explicitly connected to a chat. Encrypted, scanned, or larger documents are not extracted — use Local Knowledge for those. No inline preview is available for this format here.",
  "filePreview.error.loadFailed": "The file could not be loaded. Try again.",
  "filePreview.error.unreadable": "Unable to read this file.",
  "filePreview.binary.tooLarge": "Preview disabled because this file exceeds {maxBytes}.",
  "filePreview.binary.unsupported":
    "No safe text or image preview is available for this file type.",
  "filePreview.metadata.type": "Type",
  "filePreview.metadata.size": "Size",
  "filePreview.metadata.modified": "Modified",
  "filePreview.metadata.extension": "Extension",
  "filePreview.metadata.extensionNone": "none",
  "filePreview.backToFiles": "Back to files",
  "filePreview.copyFileName": "Copy file name",
  "filePreview.copyFilePath": "Copy file path",
  "filePreview.copyStatus.nameCopied": "File name copied",
  "filePreview.copyStatus.pathCopied": "File path copied",
  "filePreview.copyStatus.clipboardFailed": "Clipboard access failed.",
  "filePreview.refresh": "Refresh preview",
  "filePreview.refreshing": "Refreshing preview",
  "filePreview.refreshStatus.refreshing": "Refreshing...",
  "filePreview.refreshStatus.reloaded": "Reloaded",
  "filePreview.refreshStatus.failed": "Refresh failed",
  "filePreview.openInEditor": "Open in editor",
  "filePreview.closePreview": "Close preview",
  "filePreview.loadingState": "Loading preview…",
  "filePreview.retry": "Retry",
  "filePreview.truncatedBanner":
    "Preview truncated at {maxBytes}. Larger files can't be shown in full here.",
  "filePreview.syntaxHighlightDisabled": "Syntax highlighting disabled for large previews.",
  "filePreview.previewRegionLabel": "File preview: {name}",
  "filePreview.showMoreLines": "Show {count} more lines",
  "filePreview.showPreviousLines": "Show {count} previous lines",
  "filePreview.readOnlyBanner": "Read-only source preview. This file cannot be edited here.",
  "filePreview.hiddenFile": "Hidden file",
  "filePreview.previewUnavailable": "Preview unavailable",
  "filePreview.headerLoading": "Loading preview",
  "filePreview.lang.denied": "denied",
  "filePreview.lang.error": "error",
  "filePreview.lang.loading": "loading",
  "filePreview.lang.text": "text",
  "filePreview.lang.binary": "binary",

  // Settled fetch/pull and push results. Sentence fragments: they are substituted into
  // "gitClientWindow.sync.operationStatus" as {status}. A failed result is ALSO styled and announced
  // as a failure — see git-client/sync-outcome.ts, which owns the severity of every member.

  // Accessible names for the named <section> landmarks the #2721 wave introduced. They were
  // hardcoded English on the role="region" elements these sections replace; a screen reader
  // announces them, so they belong in the catalog like any other user-facing string.
  "runtimeHubWidget.auditMetadataAria": "Runtime audit metadata",
  "installBanner.regionAria": "Install Keiko",
  "markdown.codeBlock.regionAria": "{language} code block",
  "markdown.codeBlock.languageText": "text",
  "connectorPicker.sets.notReadyNotice":
    "{count} Knowledge Pod Sets are not ready to ground answers and are not listed.",
  // "fetched", not "indexed": this count is what the crawler accepted, which is not what landed in
  // the index — `manualPod.progress.index` owns that (0.3.0 audit).
  "manualPod.progress.crawl": "{accepted} pages fetched, {denied} links skipped",
  "manualPod.progress.index": "{processed} of {total} pages indexed",
  "manualPod.progress.gaps": "{failed} pages failed, {skipped} pages skipped",
  "manualPod.progress.gapsTitle": "What was left out",
  "manualPodCreate.button": "Add HTML manual",
  "manualPodCreate.form.title": "Add an HTML manual",
  "manualPodCreate.form.nameLabel": "Display name",
  "manualPodCreate.form.namePlaceholder": "Vendor product manual",
  "manualPodCreate.form.originLabel": "Manual site origin",
  "manualPodCreate.form.originPlaceholder": "https://docs.example.com",
  "manualPodCreate.form.prefixLabel": "Path prefix (optional)",
  "manualPodCreate.form.prefixPlaceholder": "/guide",
  "manualPodCreate.form.submit": "Create manual pod",
  "manualPodCreate.form.cancel": "Cancel",
  "manualPodCreate.form.validation": "Enter a display name and an http(s) site origin.",
  "manualPodCreate.progress.running": "Creating manual pod…",
  "manualPodCreate.state.succeeded": "Manual pod created",
  "manualPodCreate.state.partial": "Manual pod created with gaps; some pages are missing",
  "manualPodCreate.state.failed": "Create failed; no manual pod was added",
  "manualPodRefresh.button": "Refresh manual",
  "manualPodRefresh.confirm.body": "Re-crawl and re-index this HTML manual?",
  "manualPodRefresh.confirm.cancel": "Cancel",
  "manualPodRefresh.confirm.confirm": "Refresh manual",
  "manualPodRefresh.progress.running": "Refreshing manual…",
  "manualPodRefresh.state.succeeded": "Manual refreshed",
  "manualPodRefresh.state.partial": "Manual refreshed with gaps; some pages are missing",
  "manualPodRefresh.state.failed": "Refresh failed; the previous manual is unchanged",
  // GovernedPullRequestCard's Description panel (preview -> approve -> apply, epic #3384 #3399).

  "repositoryBranchSwitcher.setUpGit": "Set up Git",
  "repositoryBranchSwitcher.initializeDescription":
    "Initialize the selected project as a local Git repository with the initial branch main.",
  "repositoryBranchSwitcher.cancel": "Cancel",
  "repositoryBranchSwitcher.initializing": "Initializing…",
  "repositoryBranchSwitcher.initializeRepository": "Initialize repository",
  "attachment.notice.readFailed":
    'Couldn\'t read "{name}" — it will be skipped. Your message will be sent without it.',
  "attachment.notice.budgetExhausted":
    '"{name}" won\'t be sent — the {limit} attachment limit was already used by earlier files.',
  "attachment.notice.countExceeded":
    '"{name}" won\'t be sent — only the first {max} documents are included.',
  "attachment.notice.nonTextDocument":
    "Couldn't extract text from \"{name}\" — your message will be sent without document text and the model won't receive the file itself.",
  "attachment.notice.imageUndeliverable":
    '"{name}" won\'t be sent — the model does not receive image attachments in this conversation. Describe what matters about it in your message instead.',
} as const;

export type MessageKey = keyof typeof EN_MESSAGES;
export type MessageCatalog = Readonly<Record<MessageKey, string>>;
