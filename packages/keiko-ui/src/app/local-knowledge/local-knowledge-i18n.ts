"use client";

import { useMemo } from "react";
import { UNSUPPORTED_DOCUMENT_GUIDANCE_CODES } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-records";
import type {
  KnowledgePodReadiness,
  KnowledgePodSetReadinessReasonCode,
  ManualRefreshReasonCode,
  UnsupportedDocumentGuidanceCode,
} from "@oscharko-dev/keiko-contracts";
import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";
import type { KnowledgePodGuidanceCode, KnowledgePodUiGuidance } from "@/lib/local-knowledge-api";

const LOCAL_KNOWLEDGE_EN_MESSAGES = {
  "common.cancel": "Cancel",
  "common.retry": "Retry",
  "common.dismissError": "Dismiss error",
  "common.status": "Status",
  "common.save": "Save",
  "common.saving": "Saving…",
  "common.delete": "Delete",
  "common.continue": "Continue",
  "common.browse": "Browse",
  "common.working": "Working…",
  "common.dismiss": "Dismiss",
  "localKnowledge.disconnect.title": "Disconnect Knowledge Pod",
  "localKnowledge.disconnect.description":
    'Disconnect "{name}"? Its index remains; only the source link is removed.',
  "localKnowledge.disconnect.confirm": "Disconnect",
  "localKnowledge.row.addToWorkspace": "Add to workspace",
  "localKnowledge.row.actionsLabel": "Actions for Knowledge Pod {name}",
  "localKnowledge.row.addToWorkspaceLabel": "Add Knowledge Pod {name} to workspace",
  "localKnowledge.row.details": "Details",
  "localKnowledge.row.detailsLabel": "Open details for Knowledge Pod {name}",
  "localKnowledge.row.disconnectLabel": "Disconnect Knowledge Pod {name}",
  "localKnowledge.row.disconnecting": "Disconnecting…",
  "localKnowledge.picker.loading": "Loading Knowledge Pods…",
  "localKnowledge.picker.loadFailed": "Failed to load Knowledge Pods.",
  "localKnowledge.picker.retry": "Try again",
  "localKnowledge.picker.create": "Create a Knowledge Pod",
  "localKnowledge.picker.label": "Select Knowledge Pod source",
  "localKnowledge.picker.placeholder": "— choose a Knowledge Pod source —",
  "localKnowledge.picker.menuTitle": "Available Knowledge Pod sources",
  "localKnowledge.picker.setOption": "{name} ({count} pods)",
  "localKnowledge.picker.setsFailed": "Knowledge Pod Sets could not be loaded.",
  "localKnowledge.picker.manage": "Create or manage Knowledge Pods",
  "localKnowledge.picker.state.ready": "Ready",
  "localKnowledge.picker.state.indexing": "Indexing…",
  "localKnowledge.picker.state.error": "Failed",
  "localKnowledge.node.unselected": "Local Knowledge",
  "localKnowledge.node.meta": "Local Knowledge Pod",
  "localKnowledge.node.manage": "Manage",
  "localKnowledge.state.draft": "Draft",
  "localKnowledge.state.indexing": "Indexing",
  "localKnowledge.state.ready": "Indexed",
  "localKnowledge.state.stale": "Stale",
  "localKnowledge.state.deleting": "Deleting",
  "localKnowledge.state.error": "Failed",
  "localKnowledge.row.cancelIndexingLabel": "Cancel indexing for Knowledge Pod {name}",
  "localKnowledge.row.cancelling": "Cancelling…",
  "localKnowledge.row.startIndexingLabel": "Start indexing Knowledge Pod {name}",
  "localKnowledge.row.attachSourceTitle": "Attach a source before indexing this Knowledge Pod.",
  "localKnowledge.row.attachSourceHint": "Attach a source before indexing.",
  "localKnowledge.row.index": "Index",
  "localKnowledge.row.indexing": "Indexing…",
  "localKnowledge.readiness.ready": "Ready",
  "localKnowledge.readiness.indexing": "Indexing",
  "localKnowledge.readiness.stale": "Stale",
  "localKnowledge.readiness.degraded": "Degraded",
  "localKnowledge.readiness.unavailable": "Unavailable",
  "localKnowledge.readiness.error": "Failed",
  "localKnowledge.readiness.draft": "Draft",
  "localKnowledge.readiness.unknown": "Unknown",
  "localKnowledge.set.article": "Knowledge Pod Set: {name}",
  "localKnowledge.set.podCountBadge": "{count} Pods",
  "localKnowledge.set.podCountText": "{count} Knowledge Pods",
  "localKnowledge.set.readinessSummary": "Knowledge Pod Set readiness: {readiness}.",
  "localKnowledge.set.reasonsSummary": "reasons: {reasons}",
  "localKnowledge.set.count.pods": "pods",
  "localKnowledge.set.count.sources": "sources",
  "localKnowledge.set.count.docs": "docs",
  "localKnowledge.set.count.chunks": "chunks",
  "localKnowledge.set.count.vectors": "vectors",
  "localKnowledge.set.count.ready": "ready",
  "localKnowledge.set.count.degraded": "degraded",
  "localKnowledge.set.count.unavailable": "unavailable",
  "localKnowledge.set.count.policyDenied": "policy denied",
  "localKnowledge.set.count.indexing": "indexing",
  "localKnowledge.set.count.stale": "stale",
  "localKnowledge.set.count.error": "error",
  "localKnowledge.set.count.missing": "missing",
  "localKnowledge.set.reason.memberDraft": "draft",
  "localKnowledge.set.reason.memberIndexing": "indexing",
  "localKnowledge.set.reason.memberStale": "stale",
  "localKnowledge.set.reason.memberError": "error",
  "localKnowledge.set.reason.memberUnavailable": "unavailable",
  "localKnowledge.set.reason.memberDegraded": "degraded",
  "localKnowledge.set.reason.missingMember": "missing",
  "localKnowledge.set.reason.policyDenied": "policy denied",
  "localKnowledge.set.reason.embeddingUnknown": "embedding unknown",
  "localKnowledge.set.reason.embeddingIncompatible": "embedding mismatch",
  "localKnowledge.set.reason.embeddingUnavailable": "embedding unavailable",
  "localKnowledge.set.reason.embeddingOpaque": "embedding opaque",
  "localKnowledge.set.reason.noSources": "no sources",
  "localKnowledge.set.reason.noVectors": "no vectors",
  "localKnowledge.set.reason.futureRemoteMember": "remote placeholder",
  "localKnowledge.set.reason.futureFederatedMember": "federated placeholder",
  "localKnowledge.set.reason.futureEphemeralMember": "ephemeral placeholder",
  "localKnowledge.guidance.summary": "Knowledge Pod guidance: {label}. {description}",
  "localKnowledge.guidance.label.embeddingMismatch": "Embedding mismatch",
  "localKnowledge.guidance.label.embeddingUnavailable": "Embedding unavailable",
  "localKnowledge.guidance.label.reindexRecommended": "Reindex recommended",
  "localKnowledge.guidance.label.embeddingOpaque": "Embedding opaque",
  "localKnowledge.guidance.label.manualReady": "HTML manual",
  "localKnowledge.guidance.label.manualDegraded": "Manual degraded",
  "localKnowledge.guidance.label.manualIndexing": "Manual indexing",
  "localKnowledge.guidance.label.manualUnavailable": "Manual unavailable",
  "localKnowledge.guidance.label.futureMember": "Future member placeholder",
  "localKnowledge.guidance.label.membersUnavailable": "Members unavailable",
  "localKnowledge.guidance.label.membersNotReady": "Members not ready",
  "localKnowledge.guidance.label.retrievalDegraded": "Retrieval degraded",
  "localKnowledge.guidance.label.embeddingReadinessWarning": "Embedding readiness warning",
  "localKnowledge.guidance.label.policyDenied": "Policy denied",
  "localKnowledge.guidance.label.sealedLocalPolicy": "Sealed local policy",
  "localKnowledge.guidance.description.embeddingMismatch.pod":
    "Semantic retrieval is disabled for this pod until it is reindexed locally.",
  "localKnowledge.guidance.description.embeddingMismatch.set":
    "Semantic retrieval is disabled for affected set members until they are reindexed locally.",
  "localKnowledge.guidance.description.embeddingUnavailable.pod":
    "Semantic retrieval cannot run under the current local policy.",
  "localKnowledge.guidance.description.embeddingUnavailable.set":
    "Semantic retrieval cannot run for affected set members under the current local policy.",
  "localKnowledge.guidance.description.reindexRecommended.pod":
    "Compatibility is unverified; lexical fallback remains available.",
  "localKnowledge.guidance.description.reindexRecommended.set":
    "Compatibility is unverified for affected set members; lexical fallback remains available.",
  "localKnowledge.guidance.description.embeddingOpaque.pod":
    "Semantic compatibility cannot be verified for this retrieval space.",
  "localKnowledge.guidance.description.embeddingOpaque.set":
    "Semantic compatibility cannot be verified for this Knowledge Pod Set.",
  "localKnowledge.guidance.description.policyDenied.pod":
    "This Knowledge Pod blocks grounded answer synthesis or raw-content release; Keiko will return a policy-denied state instead of sending excerpts to a model.",
  "localKnowledge.guidance.description.policyDenied.set":
    "This Knowledge Pod Set blocks grounded answer synthesis or raw-content release for affected members; Keiko will return a policy-denied state instead of sending excerpts to a model.",
  "localKnowledge.guidance.description.sealedLocalPolicy.pod":
    "External embedding or reranking calls are disabled for this Knowledge Pod; retrieval may use lexical or local fallback.",
  "localKnowledge.guidance.description.sealedLocalPolicy.set":
    "External embedding or reranking calls are disabled for affected set members; retrieval may use lexical or local fallback.",
  "localKnowledge.guidance.description.futureMember":
    "This Knowledge Pod Set includes future remote, federated, or ephemeral placeholders; those members are not active retrieval sources yet.",
  "localKnowledge.guidance.description.membersUnavailable":
    "Some set members are missing, failed, or unavailable; retrieval will use only available members.",
  "localKnowledge.guidance.description.membersNotReady":
    "Some set members are indexing, stale, or draft; refresh or index them before relying on this set.",
  "localKnowledge.guidance.description.retrievalDegraded":
    "Some set members have no sources, no vectors, or degraded indexing; lexical fallback may be the only available path.",
  "localKnowledge.guidance.description.embeddingReadinessWarning":
    "Some set members need embedding review; Keiko does not compare raw vector scores across embedding spaces.",
  "localKnowledge.guidance.description.manualReady":
    "Ready for chat retrieval through Local Knowledge. {counts}.",
  "localKnowledge.guidance.description.manualDegraded":
    "Manual retrieval is degraded; answers may use only available evidence. {counts}.",
  "localKnowledge.guidance.description.manualIndexing":
    "Manual retrieval is {state}; it is not yet ready to contribute evidence.",
  "localKnowledge.guidance.description.manualUnavailable":
    "Manual retrieval is {state}; it cannot contribute silently as empty evidence.",
  "localKnowledge.guidance.manualCounts": "{docs} docs · {chunks} chunks · {vectors} vectors",
  "localKnowledge.guidance.manualState.ready": "ready",
  "localKnowledge.guidance.manualState.indexing": "indexing",
  "localKnowledge.guidance.manualState.stale": "stale",
  "localKnowledge.guidance.manualState.degraded": "degraded",
  "localKnowledge.guidance.manualState.unavailable": "unavailable",
  "localKnowledge.guidance.manualState.error": "error",
  "localKnowledge.guidance.manualState.draft": "draft",
  "localKnowledge.picker.sectionPods": "Knowledge Pods",
  "localKnowledge.picker.sectionSets": "Knowledge Pod Sets",
  "localKnowledge.picker.unavailablePod": "Knowledge Pod (unavailable)",
  "localKnowledge.picker.unavailableSet": "Knowledge Pod Set (unavailable)",
  "localKnowledge.picker.selectedWithState": "{name} ({state})",
  "localKnowledge.node.unavailable": "Unavailable",
  "localKnowledge.node.defaultLabel": "Knowledge Pod",
  "localKnowledge.manualRefresh.title": "Last refresh",
  "localKnowledge.manualRefresh.removalNote":
    "Removed pages could not be detected this run (the crawl reached its page limit).",
  "localKnowledge.manualRefresh.outcome.unchanged": "Unchanged",
  "localKnowledge.manualRefresh.outcome.updated": "Updated",
  "localKnowledge.manualRefresh.outcome.partial": "Partial",
  "localKnowledge.manualRefresh.outcome.failed": "Failed",
  "localKnowledge.manualRefresh.outcome.cancelled": "Cancelled",
  "localKnowledge.manualRefresh.count.addedPages": "Added",
  "localKnowledge.manualRefresh.count.changedPages": "Changed",
  "localKnowledge.manualRefresh.count.removedPages": "Removed",
  "localKnowledge.manualRefresh.count.movedPages": "Moved",
  "localKnowledge.manualRefresh.count.unchangedPages": "Unchanged",
  "localKnowledge.manualRefresh.count.failedPages": "Failed",
  "localKnowledge.manualRefresh.count.deniedLinks": "Denied links",
  "localKnowledge.manualRefresh.reason.scopePreserved":
    "Refresh reused the originally approved manual scope and limits.",
  "localKnowledge.manualRefresh.reason.scopeLimitReached":
    "The refresh reached a crawl limit; some pages were not visited.",
  "localKnowledge.manualRefresh.reason.removalDetectionSkipped":
    "The crawl reached its page limit, so removed pages could not be detected this run.",
  "localKnowledge.manualRefresh.reason.pagesAdded": "New pages were discovered and indexed.",
  "localKnowledge.manualRefresh.reason.pagesChanged": "Existing pages changed and were re-indexed.",
  "localKnowledge.manualRefresh.reason.pagesRemoved":
    "Pages that are no longer reachable were removed from the pod.",
  "localKnowledge.manualRefresh.reason.pagesMoved":
    "Pages moved to a new location; their content was unchanged.",
  "localKnowledge.manualRefresh.reason.pagesFailed":
    "Some pages could not be re-indexed and may be temporarily unsearchable; a future successful refresh will retry them.",
  "localKnowledge.manualRefresh.reason.linksDenied":
    "Some links were skipped because they fell outside the approved scope.",
  "localKnowledge.manualRefresh.reason.embeddingIncompatible":
    "The embedding model changed; re-index the manual to refresh its vectors.",
  "localKnowledge.manualRefresh.reason.crawlEmpty": "The refresh crawl found no indexable pages.",
  "localKnowledge.manualRefresh.reason.crawlCancelled":
    "The refresh was cancelled. Pages not yet reached are unaffected; a page already being re-indexed at that moment may be temporarily unsearchable until a future successful refresh.",
  "localKnowledge.manualRefresh.reason.indexFailed":
    "Indexing failed during refresh. Pages that were being re-indexed at the time of failure may be temporarily unsearchable until a future successful refresh repairs them.",
  "localKnowledge.create.title": "Create Knowledge Pod",
  "localKnowledge.create.description":
    "Name this Knowledge Pod, then connect a source and start indexing from its page.",
  "localKnowledge.create.nameLabel": "Knowledge Pod display name",
  "localKnowledge.create.validation.nameRequired": "Pod display name is required.",
  "localKnowledge.create.access.legend": "Access",
  "localKnowledge.create.access.hint": "Choose who may use this Knowledge Pod.",
  "localKnowledge.create.access.helpLabel": "Explain Knowledge Pod access",
  "localKnowledge.create.access.help":
    "Access controls where this Knowledge Pod can be used. Local keeps it private to this Keiko instance. Shareable will allow trusted sharing later.",
  "localKnowledge.create.access.local": "Local",
  "localKnowledge.create.access.localDescription":
    "Only this Keiko instance can use this Knowledge Pod; it is not shared or synchronized.",
  "localKnowledge.create.access.shareable": "Shareable",
  "localKnowledge.create.access.shareableDescription":
    "Planned for sharing with selected Keiko users or other Keiko instances.",
  "localKnowledge.create.access.shareableTooltip":
    "Coming later: share Knowledge Pods with trusted Keiko users or Keiko instances. Until then, new Knowledge Pods remain local and private here.",
  "localKnowledge.create.access.comingSoon": "Coming soon",
  "localKnowledge.create.creating": "Creating...",
  "localKnowledge.create.submit": "Create Knowledge Pod",
  "localKnowledge.overview.backToWorkspace": "Back to Workspace",
  "localKnowledge.overview.backToPods": "Back to Knowledge Pods",
  "localKnowledge.overview.sectionLabel": "Knowledge Pods",
  "localKnowledge.overview.emptyTitle": "No Knowledge Pods yet",
  "localKnowledge.overview.emptyBody": "Create a Knowledge Pod to index governed local sources.",
  "localKnowledge.overview.createFirst": "Create your first Knowledge Pod",
  "localKnowledge.overview.loadingPods": "Loading Knowledge Pods...",
  "localKnowledge.overview.podList": "Knowledge Pod list",
  "localKnowledge.overview.combineDisabledHint":
    "Create Knowledge Pods before combining them into a set.",
  "localKnowledge.overview.retryLoadingPods": "Retry loading Knowledge Pods",
  "localKnowledge.set.createTitle": "Create Knowledge Pod Set",
  "localKnowledge.set.nameLabel": "Knowledge Pod Set name",
  "localKnowledge.set.membersLegend": "Knowledge Pods ({selected}/{max})",
  "localKnowledge.set.emptyMembers": "No Knowledge Pods available to combine.",
  "localKnowledge.set.selectableMembers": "Selectable Knowledge Pods",
  "localKnowledge.set.validation.nameRequired": "Knowledge Pod Set name is required.",
  "localKnowledge.set.validation.selectionRequired":
    "Select at least one Knowledge Pod to combine.",
  "localKnowledge.set.validation.tooMany":
    "A Knowledge Pod Set can hold at most {count} Knowledge Pods.",
  "localKnowledge.set.submit": "Create Knowledge Pod Set",
  "localKnowledge.set.deleteTitle": "Delete Knowledge Pod Set",
  "localKnowledge.set.deleteDescription":
    'Delete "{name}"? Member Knowledge Pods keep their indexes; only this set is removed.',
  "localKnowledge.set.deleteConfirm": "Delete",
  "localKnowledge.set.deleting": "Deleting…",
  "localKnowledge.set.sectionTitle": "Knowledge Pod Sets",
  "localKnowledge.set.list": "Knowledge Pod Set list",
  "localKnowledge.set.dragSet": "Drag Knowledge Pod Set {name} to the workspace",
  "localKnowledge.set.dragSetTitle": "Drag to the workspace to create a Knowledge Pod Set card",
  "localKnowledge.set.addToWorkspace": "Add Knowledge Pod Set {name} to workspace",
  "localKnowledge.set.deleteAria": "Delete Knowledge Pod Set {name}",
  "localKnowledge.row.article": "Knowledge Pod: {name}",
  "localKnowledge.row.dragPod": "Drag Knowledge Pod {name} to the workspace",
  "localKnowledge.row.dragPodTitle": "Drag to the workspace to create a Knowledge Pod card",
  "localKnowledge.error.api": "Something went wrong. Try again. ({code})",
  "localKnowledge.error.unexpected": "An unexpected error occurred.",
  "localKnowledge.nativeDialog.busy": "A native dialog is already open. Close it first.",
  "localKnowledge.nativeDialog.unavailable":
    "Native dialogs are unavailable on this platform. Enter the path manually.",
  // #2906 round 3: "{count} selected item(s)" was wrong for count === 1 ("1 selected item(s)
  // ... were skipped" -- wrong article and wrong verb number). Branch on count like the
  // established commandPalette.result.singular/.plural pair instead of a fake plural marker.
  "localKnowledge.nativeDialog.partialSelection.singular":
    "{count} selected item could not be added and was skipped.",
  "localKnowledge.nativeDialog.partialSelection.plural":
    "{count} selected items could not be added and were skipped.",
  "localKnowledge.detail.loading": "Loading Knowledge Pod…",
  "localKnowledge.detail.pageLabel": "Knowledge Pod detail",
  "localKnowledge.detail.noSelection":
    "No Knowledge Pod selected. Open one from the Local Knowledge overview.",
  "localKnowledge.detail.notFound":
    "This Knowledge Pod no longer exists. Return to the Local Knowledge overview.",
  "localKnowledge.detail.loadFailed": "Failed to load Knowledge Pod.",
  "localKnowledge.detail.retryLoad": "Retry loading Knowledge Pod detail",
  "localKnowledge.detail.routeError.title": "This Knowledge Pod page hit an error",
  "localKnowledge.detail.routeError.body":
    "The page failed to render. Your Knowledge Pod and its data are unaffected.",
  "localKnowledge.detail.routeError.retry": "Try again",
  "localKnowledge.detail.backToLocalKnowledge": "Back to Local Knowledge",
  "localKnowledge.detail.tools": "Knowledge Pod tools",
  "localKnowledge.detail.advanced.summary": "Status, sources, and diagnostics",
  "localKnowledge.detail.advanced.hint": "Embedding, retrieval, source, and job details",
  "localKnowledge.detail.documentCounts": "Document counts",
  "localKnowledge.detail.rows.showMore": "Show {count} more {noun}",
  "localKnowledge.detail.rows.showFewer": "Show fewer {noun}",
  "localKnowledge.detail.rows.diagnostics": "diagnostics",
  "localKnowledge.detail.rows.jobs": "jobs",
  "localKnowledge.detail.rename.formLabel": "Rename Knowledge Pod",
  "localKnowledge.detail.rename.displayName": "Display name",
  "localKnowledge.detail.rename.description": "Description",
  "localKnowledge.detail.rename.nameRequired": "Display name is required.",
  "localKnowledge.detail.rename.button": "Rename",
  "localKnowledge.detail.rename.buttonFor": "Rename Knowledge Pod {name}",
  "localKnowledge.detail.rebind.button": "Rebind",
  "localKnowledge.detail.rebind.repositoryRoot": "Replacement repository root",
  "localKnowledge.detail.rebind.sharedRoot": "Replacement shared root",
  "localKnowledge.detail.rebind.folderRoot": "Replacement folder root",
  "localKnowledge.detail.rebind.chooseRoot": "Choose replacement root",
  "localKnowledge.detail.rebind.save": "Save root",
  "localKnowledge.detail.rebind.saving": "Rebinding…",
  "localKnowledge.detail.connect.region": "Connect a source",
  "localKnowledge.detail.connect.title": "Connect source",
  "localKnowledge.detail.connect.description":
    "Select a Knowledge source, then connect it to this Knowledge Pod.",
  "localKnowledge.detail.connect.sourcePickerTitle": "Knowledge source",
  "localKnowledge.detail.connect.sourcePickerDescription":
    "Use folders for full collections or documents for targeted additions. You can connect more sources later.",
  "localKnowledge.detail.connect.supportedFormats":
    "Supports PDF, Word, Excel, text, Markdown, CSV, JSON, HTML, and common source and configuration files. Up to {size} per file.",
  "localKnowledge.detail.connect.chooseFiles": "Choose documents for this Knowledge Pod",
  "localKnowledge.detail.connect.chooseFolder": "Choose a folder for this Knowledge Pod",
  "localKnowledge.detail.connect.pickFolderSource": "Select folder",
  "localKnowledge.detail.connect.pickDocumentSource": "Select documents",
  "localKnowledge.detail.connect.filter.documents": "PDF, Word and Excel",
  "localKnowledge.detail.connect.filter.structuredData": "Tables and structured data",
  "localKnowledge.detail.connect.filter.textDocuments": "Text and Markdown",
  "localKnowledge.detail.connect.filter.webDocuments": "Web documents",
  "localKnowledge.detail.connect.filter.scripts": "Scripts",
  "localKnowledge.detail.connect.filter.sourceCode": "Source code",
  "localKnowledge.detail.connect.filter.configuration": "Configuration files",
  "localKnowledge.detail.connect.sourcePath": "Source path",
  "localKnowledge.detail.connect.displayName": "Display name (optional)",
  "localKnowledge.detail.connect.displayNamePlaceholder": "Derived safely from the selected source",
  "localKnowledge.detail.connect.specificFiles": "Index only specific documents",
  "localKnowledge.detail.connect.relativeFiles": "Relative document paths",
  "localKnowledge.detail.connect.selectedSource": "Selected source: {path}",
  "localKnowledge.detail.connect.selectedDocuments": "Selected documents: {count} from {root}",
  "localKnowledge.detail.connect.repositoryMode": "Connect as a code repository",
  "localKnowledge.detail.connect.selectedRepository": "Selected repository: {path}",
  "localKnowledge.detail.connect.repositoryFilesDisabledNote":
    "Specific-file selection is unavailable in repository mode. The whole repository is connected as one code source.",
  "localKnowledge.detail.connect.connect": "Connect",
  "localKnowledge.detail.connect.connecting": "Connecting…",
  "localKnowledge.detail.connect.limitSummary":
    "Maximum single file size: {size}. Parser budget: {objects} objects, {duration} per document.",
  "localKnowledge.detail.help.sourceSetup":
    "A Knowledge source is the material Keiko may search for this Knowledge Pod. Connect a folder for a collection or documents for targeted additions.",
  "localKnowledge.detail.help.sourcePath":
    "This path tells Keiko where the selected source is stored on this device. Keiko indexes only the connected source.",
  "localKnowledge.detail.help.sourceDisplayName":
    "Optionally choose a name shown for this source. If left empty, Keiko derives a safe name from the selected source.",
  "localKnowledge.detail.help.specificFiles":
    "Use this when only certain documents inside a folder should belong to the Knowledge Pod. Each line is one document below the source path.",
  "localKnowledge.detail.help.repositoryMode":
    "Connects this source as a code repository instead of a document folder. Keiko then uses code-aware chunking, citations with file and line numbers, and a fast incremental refresh based on what changed in git. Not available together with specific-file selection.",
  "localKnowledge.detail.help.indexNow":
    "Starts indexing. Keiko reads the source, extracts text, and prepares it for later answers.",
  "localKnowledge.detail.help.maintenance":
    "These actions are for maintenance and repair. You can refresh changes, retry problems, rebuild the index, or delete the Knowledge Pod.",
  "localKnowledge.detail.help.maintenanceLimits":
    "These limits protect the app from files that are too large or too complex to process reliably.",
  "localKnowledge.detail.help.actionReembed":
    "Recreates the search fingerprints with the current embedding model. Use this after the embedding model changed.",
  "localKnowledge.detail.help.actionRebuild":
    "Processes all sources from the beginning. Use this when indexing settings changed or results look incomplete.",
  "localKnowledge.detail.help.actionRefresh":
    "Looks for changed or removed files and updates only what is needed. This is the normal maintenance path for existing sources.",
  "localKnowledge.detail.help.actionRepair":
    "Retries documents that failed during indexing. Documents that already worked stay in place.",
  "localKnowledge.detail.help.actionDelete":
    "Deletes this Knowledge Pod's local index. The files on your device are not deleted.",
  "localKnowledge.detail.help.actionProgress":
    "This panel shows the live progress of the current action. It updates while Keiko processes documents and vectors.",
  "localKnowledge.detail.help.actionDocuments":
    "Shows how many documents this action has already processed compared with the expected total.",
  "localKnowledge.detail.help.actionVectors":
    "Shows how many searchable text fingerprints have been created during this action.",
  "localKnowledge.detail.help.indexStatus":
    "Index status shows whether Keiko has processed the connected sources and whether this Knowledge Pod is ready for search.",
  "localKnowledge.detail.help.indexedDocuments":
    "Shows how many documents Keiko could read and add to the index. Failed documents need attention.",
  "localKnowledge.detail.help.vectors":
    "Vectors are search fingerprints for text passages. They help Keiko find relevant content by meaning, not only exact words.",
  "localKnowledge.detail.help.latestJob":
    "The latest job is the most recent indexing run. It shows whether Keiko is still working, finished, or stopped with an error.",
  "localKnowledge.detail.help.discoveryProgress":
    "Discovery means Keiko is finding and checking documents in the source. It is the step before content becomes searchable.",
  "localKnowledge.detail.help.retrievalCoverage":
    "Retrieval coverage shows how much indexed content is ready for semantic search. Low coverage can lead to incomplete results.",
  "localKnowledge.detail.help.indexMessage":
    "This message summarizes whether the index and search data match the current source set.",
  "localKnowledge.detail.help.advanced":
    "Opens technical details about sources, embeddings, retrieval, and job history. Use it when answers miss expected content.",
  "localKnowledge.detail.help.embeddingSection":
    "Embeddings turn text into search fingerprints. This section checks whether older and newer fingerprints still fit together.",
  "localKnowledge.detail.help.pinnedModel":
    "The pinned model created the existing search fingerprints. Keeping it visible helps explain older index data.",
  "localKnowledge.detail.help.currentModel":
    "The current model is what Keiko would use now for new or rebuilt search data.",
  "localKnowledge.detail.help.compatibility":
    "Compatible means old and new search fingerprints can be compared safely. If not, rebuild the vectors before relying on semantic search.",
  "localKnowledge.detail.help.embeddingMessage":
    "This message explains whether the embedding setup is ready or needs attention.",
  "localKnowledge.detail.help.contextualRetrieval":
    "Contextual retrieval can add a short explanation to each text passage during indexing. This can improve later answers but needs extra model calls.",
  "localKnowledge.detail.help.contextStatus":
    "Shows whether contextual retrieval is ready, disabled, or needs a rebuild.",
  "localKnowledge.detail.help.contextModel":
    "Shows which chat model creates the extra context. If no model is set, Keiko uses the configured gateway default.",
  "localKnowledge.detail.help.contextStale":
    "Stale context chunks are passages whose extra context no longer matches the current settings. Rebuild to update them.",
  "localKnowledge.detail.help.contextEnable":
    "Turns contextual retrieval on for future indexing runs. Existing data changes only after a rebuild.",
  "localKnowledge.detail.help.contextModelInput":
    "Optional model ID for context generation. Leave it empty to use the gateway default.",
  "localKnowledge.detail.help.contextStrict":
    "Strict mode stops indexing if context generation fails. Leave it off when indexing should continue with a fallback.",
  "localKnowledge.detail.help.contextGeneratedLimit":
    "Limits the length of the generated context per text passage so the index stays compact.",
  "localKnowledge.detail.help.contextDocumentLimit":
    "Limits how much document text may be used to generate context for one passage.",
  "localKnowledge.detail.help.contextSave":
    "Saves these retrieval settings. Rebuild the Knowledge Pod afterward so existing passages use the new settings.",
  "localKnowledge.detail.help.sources":
    "Sources are the folders or documents connected to this Knowledge Pod. One pod can combine several sources.",
  "localKnowledge.detail.help.sourceCard":
    "This card shows one connected source and how many documents from it were indexed, failed, or skipped.",
  "localKnowledge.detail.help.sourceCoverage":
    "The bar summarizes the result for this source: indexed, failed, and skipped documents.",
  "localKnowledge.detail.help.rebind":
    "Use this when a source was moved on disk. Keiko keeps the source record and points it to the new location.",
  "localKnowledge.detail.help.overview":
    "The overview lists basic settings and health information for this Knowledge Pod.",
  "localKnowledge.detail.help.overviewStatus":
    "Shows the lifecycle state of the Knowledge Pod, for example draft, indexing, or ready.",
  "localKnowledge.detail.help.overviewEmbeddingModel":
    "Shows which embedding model is tied to this Knowledge Pod's search data.",
  "localKnowledge.detail.help.overviewStorage":
    "Shows how much local storage the index data currently uses.",
  "localKnowledge.detail.help.overviewUnsupported":
    "Lists documents Keiko could not process with the available parsers.",
  "localKnowledge.detail.help.overviewLastIndexed":
    "Shows when Keiko last finished processing this Knowledge Pod.",
  "localKnowledge.detail.help.overviewVectorCompatible":
    "Shows whether the existing search fingerprints still match the current embedding setup.",
  "localKnowledge.detail.help.overviewStaleReasons":
    "Lists reasons why this Knowledge Pod may need a refresh, rebuild, or re-embed.",
  "localKnowledge.detail.help.overviewNextSteps":
    "Shows practical next steps when some documents could not be indexed.",
  "localKnowledge.detail.help.privacy":
    "These notes explain what stays local and when Keiko may use the configured Model Gateway.",
  "localKnowledge.detail.help.diagnostics":
    "Diagnostics show processing issues without exposing raw document text. They help explain why some documents need attention.",
  "localKnowledge.detail.help.diagnosticRow":
    "One diagnostic describes a repeated processing issue, such as an unreadable page or unsupported format.",
  "localKnowledge.detail.help.jobs":
    "The job history lists previous indexing runs. It helps explain when data was processed and whether a run failed.",
  "localKnowledge.detail.help.jobRow":
    "A job row shows one indexing run with status, time, duration, and document counts.",
  "localKnowledge.detail.help.largeDocuments":
    "Large documents are processed in stages so Keiko can resume work instead of starting from scratch.",
  "localKnowledge.detail.help.largeDocumentRow":
    "This row shows the current phase and coverage for one large document.",
  "localKnowledge.detail.help.largeResume":
    "Continues large-document indexing where Keiko can safely resume it.",
  "localKnowledge.detail.actions.group": "Actions for Knowledge Pod {name}",
  "localKnowledge.detail.actions.maintenance": "Maintenance and deletion",
  "localKnowledge.detail.actions.maintenanceHint": "Refresh, repair, rebuild, or remove this pod",
  "localKnowledge.detail.actions.index.button": "Index now",
  "localKnowledge.detail.actions.index.busy": "Indexing…",
  "localKnowledge.detail.actions.index.aria": "Index this Knowledge Pod now",
  "localKnowledge.detail.actions.delete.title": "Delete Knowledge Pod",
  "localKnowledge.detail.actions.delete.description":
    'This permanently deletes the pod index. Source files on disk are not deleted. Type "{name}" to confirm.',
  "localKnowledge.detail.actions.delete.confirmName": "Type the pod name to confirm",
  "localKnowledge.detail.actions.delete.aria": "Delete Knowledge Pod {name}",
  "localKnowledge.detail.actions.reembed.title": "Full re-embed for current model",
  "localKnowledge.detail.actions.reembed.description":
    "Rebuilds every vector for the current embedding model. Use it after changing the configured embedding model or gateway.",
  "localKnowledge.detail.actions.reembed.confirm": "Re-embed",
  "localKnowledge.detail.actions.reembed.button": "Full re-embed current model",
  "localKnowledge.detail.actions.reembed.aria":
    "Full re-embed Knowledge Pod {name} for current embedding model",
  "localKnowledge.detail.actions.rebuild.title": "Full rebuild / rechunk",
  "localKnowledge.detail.actions.rebuild.description":
    "Reprocesses every source, rebuilds chunks and retrieval text, and embeds with the current model. Use it after tokenizer, analyzer, or contextual retrieval changes.",
  "localKnowledge.detail.actions.rebuild.confirm": "Rebuild",
  "localKnowledge.detail.actions.rebuild.button": "Full rebuild / rechunk",
  "localKnowledge.detail.actions.rebuild.aria": "Full rebuild Knowledge Pod {name}",
  "localKnowledge.detail.actions.refresh.title": "Refresh changed files",
  "localKnowledge.detail.actions.refresh.description":
    "Runs an incremental refresh. Unchanged files stay in place, changed files are re-indexed, and removed files are cleaned up.",
  "localKnowledge.detail.actions.refresh.confirm": "Refresh",
  "localKnowledge.detail.actions.refresh.button": "Refresh changed files",
  "localKnowledge.detail.actions.refresh.aria": "Refresh changed files for Knowledge Pod {name}",
  "localKnowledge.detail.actions.repair.title": "Repair failed files",
  "localKnowledge.detail.actions.repair.description":
    "Retries files that previously failed indexing and also picks up newly changed files in the same incremental pass.",
  "localKnowledge.detail.actions.repair.confirm": "Repair",
  "localKnowledge.detail.actions.repair.button": "Repair failed files",
  "localKnowledge.detail.actions.repair.aria": "Repair failed files for Knowledge Pod {name}",
  "localKnowledge.detail.progress.indexing": "Indexing documents",
  "localKnowledge.detail.progress.reembedding": "Re-indexing for current embedding model",
  "localKnowledge.detail.progress.refreshing": "Refreshing changed files",
  "localKnowledge.detail.progress.repairing": "Repairing failed files",
  "localKnowledge.detail.progress.remaining": "Estimated remaining {duration}",
  "localKnowledge.detail.progress.estimating": "Estimating remaining time",
  "localKnowledge.detail.progress.elapsed": "Still working. Elapsed {duration}. {eta}.",
  "localKnowledge.detail.progress.documents": "Documents",
  "localKnowledge.detail.progress.vectors": "Vectors",
  "localKnowledge.detail.progress.documentProgress": "Action document progress",
  "localKnowledge.detail.progress.vectorProgress": "Action vector progress",
  "localKnowledge.detail.progress.delayed": "Progress refresh is delayed: {error}",
  "localKnowledge.detail.deleteAffectedSets.title": "Knowledge Pod Set membership changed",
  "localKnowledge.detail.deleteAffectedSets.description.one":
    "This Knowledge Pod was removed from 1 Knowledge Pod Set it belonged to.",
  "localKnowledge.detail.deleteAffectedSets.description.many":
    "This Knowledge Pod was removed from {count} Knowledge Pod Sets it belonged to.",
  "localKnowledge.detail.index.title": "Index status",
  "localKnowledge.detail.index.noJobRecorded": "No job recorded",
  "localKnowledge.detail.index.runFailed": "Indexing failed: {message}",
  "localKnowledge.detail.index.eta": "ETA {duration}",
  "localKnowledge.detail.index.updating": "Updating every 2s",
  "localKnowledge.detail.index.latestRun": "Latest run",
  "localKnowledge.detail.index.indexedDocuments": "Indexed documents",
  "localKnowledge.detail.index.failedSkipped": "{failed} failed, {skipped} skipped",
  "localKnowledge.detail.index.vectors": "Vectors",
  "localKnowledge.detail.index.chunksMissingVectors": "{count} chunks missing vectors",
  "localKnowledge.detail.index.allChunksEmbedded": "All chunks embedded",
  "localKnowledge.detail.index.latestJob": "Latest job",
  "localKnowledge.detail.index.notIndexed": "Not indexed",
  "localKnowledge.detail.index.discoveryProgress": "Discovery progress",
  "localKnowledge.detail.index.retrievalCoverage": "Retrieval coverage",
  "localKnowledge.detail.index.embeddingStopped":
    "Embedding stopped early: {message}. {count} chunks still need vectors.",
  "localKnowledge.detail.index.missingVectors":
    "{count} chunks still need vectors before retrieval can cover the full source.",
  "localKnowledge.detail.index.unsupportedDocuments":
    "{count} documents need a different extraction path before they can be indexed.",
  "localKnowledge.detail.index.aligned":
    "Index and vectors are aligned for the current source set.",
  "localKnowledge.detail.compatibility.title": "Embedding compatibility",
  "localKnowledge.detail.compatibility.compatible": "Compatible",
  "localKnowledge.detail.compatibility.unknown": "Unknown",
  "localKnowledge.detail.compatibility.incompatible": "Incompatible",
  "localKnowledge.detail.compatibility.notConfigured": "Not configured",
  "localKnowledge.detail.compatibility.noProvider": "No embedding provider",
  "localKnowledge.detail.compatibility.readyMessage":
    "The pinned embedding model is configured for embeddings.",
  "localKnowledge.detail.compatibility.fixGatewayMessage":
    "Embedding compatibility could not be confirmed. Run full re-embed after fixing the Gateway configuration.",
  "localKnowledge.detail.compatibility.pinnedModel": "Pinned model",
  "localKnowledge.detail.compatibility.currentModel": "Current embedding model",
  "localKnowledge.detail.compatibility.metric": "Compatibility",
  "localKnowledge.detail.compatibility.legacyHealth": "legacy-health",
  "localKnowledge.detail.overview.title": "Overview",
  "localKnowledge.detail.overview.name": "Name",
  "localKnowledge.detail.overview.description": "Description",
  "localKnowledge.detail.overview.tags": "Knowledge Pod tags",
  "localKnowledge.detail.overview.statusAria": "Status: {status}",
  "localKnowledge.detail.overview.embeddingModel": "Embedding model",
  "localKnowledge.detail.overview.storageSize": "Storage size",
  "localKnowledge.detail.overview.unsupportedDocuments": "Unsupported documents",
  "localKnowledge.detail.overview.lastIndexed": "Last indexed",
  "localKnowledge.detail.overview.vectorCompatible": "Vector compatible",
  "localKnowledge.detail.overview.vectorUnknown": "Unknown — check Gateway configuration",
  "localKnowledge.detail.overview.vectorIncompatible": "Incompatible — full re-embed required",
  "localKnowledge.detail.overview.staleReasons": "Stale reasons",
  "localKnowledge.detail.overview.nextSteps": "Next steps",
  "localKnowledge.detail.overview.unsupportedGuidance": "Unsupported document guidance",
  // 0.3.0 release audit — the operator-facing remediation for a document this build cannot
  // extract. The server sends the reason CODE only (UNSUPPORTED_DOCUMENT_GUIDANCE_CODES); the
  // wording lives here so it follows the operator's locale like every other label around it.
  "localKnowledge.detail.overview.unsupported.pdfNeedsOcr":
    "Scanned PDFs need an OCR-capable extraction path. Configure a verified OCR or vision adapter, or provide a text-layer PDF.",
  "localKnowledge.detail.overview.unsupported.imageNeedsOcr":
    "Image-only documents need an OCR-capable extraction path before they can be indexed.",
  "localKnowledge.detail.overview.unsupported.ocrFailed":
    "OCR extraction failed for at least one document. Review the OCR adapter configuration and retry indexing.",
  "localKnowledge.detail.overview.unsupported.unsupportedFormat":
    "Some documents are unsupported in this build. Review the health diagnostics for the affected formats and next steps.",
  "localKnowledge.detail.context.title": "Contextual retrieval",
  "localKnowledge.detail.context.description":
    "Adds a context-generation chat call per chunk during indexing. Run Full rebuild / rechunk after saving.",
  "localKnowledge.detail.context.status.ready": "Ready",
  "localKnowledge.detail.context.status.rebuild": "Rebuild required",
  "localKnowledge.detail.context.status.degraded": "Degraded",
  "localKnowledge.detail.context.status.unavailable": "Unavailable",
  "localKnowledge.detail.context.status.disabled": "Disabled",
  "localKnowledge.detail.context.saved":
    "Saved. Full rebuild / rechunk this pod to apply retrieval text changes.",
  "localKnowledge.detail.context.saveFailed": "Failed to save contextual retrieval.",
  "localKnowledge.detail.context.retrievalContext": "Retrieval context",
  "localKnowledge.detail.context.settingsSource": "settings: {source}",
  "localKnowledge.detail.context.model": "Context model",
  "localKnowledge.detail.context.gatewayDefault": "Gateway default",
  "localKnowledge.detail.context.strict": "strict",
  "localKnowledge.detail.context.nonStrict": "non-strict fallback",
  "localKnowledge.detail.context.staleChunks": "Stale context chunks",
  "localKnowledge.detail.context.degradedChunks": "{count} degraded",
  "localKnowledge.detail.context.generateAtIndex": "Generate retrieval context at index time",
  "localKnowledge.detail.context.modelId": "Context model ID",
  "localKnowledge.detail.context.defaultModelPlaceholder": "Use gateway default chat model",
  "localKnowledge.detail.context.failOnError": "Fail indexing if context generation fails",
  "localKnowledge.detail.context.generatedLimit": "Generated context character limit",
  "localKnowledge.detail.context.documentLimit": "Document context character limit",
  "localKnowledge.detail.context.save": "Save retrieval settings",
  "localKnowledge.detail.sources.title": "Sources",
  "localKnowledge.detail.sources.empty": "No sources attached to this pod.",
  "localKnowledge.detail.sources.list": "Knowledge Pod sources",
  "localKnowledge.detail.sources.selectedFiles.one": "{root} (1 selected file)",
  "localKnowledge.detail.sources.selectedFiles.many": "{root} ({count} selected files)",
  "localKnowledge.detail.sources.coverage":
    "Source document coverage: {indexed} indexed, {failed} failed, {skipped} skipped",
  "localKnowledge.detail.counts.indexed": "{count} indexed",
  "localKnowledge.detail.counts.failed": "{count} failed",
  "localKnowledge.detail.counts.skipped": "{count} skipped",
  "localKnowledge.detail.counts.processed": "{count} processed",
  "localKnowledge.detail.privacy.title": "Privacy and deletion",
  "localKnowledge.detail.privacy.details": "Privacy and deletion details",
  "localKnowledge.detail.privacy.localState":
    "Indexed text, vectors, diagnostics, and job history stay in Keiko's local runtime state on this machine.",
  "localKnowledge.detail.privacy.modelGateway":
    "Selected chunks may be sent through the configured Model Gateway for embeddings during indexing and for grounded answers when you ask questions against this Knowledge Pod.",
  "localKnowledge.detail.privacy.deletion":
    "Deleting a Knowledge Pod removes its local index data and Knowledge Pod Set memberships. Source files on disk are not deleted.",
  "localKnowledge.detail.diagnostics.title": "Health Diagnostics",
  "localKnowledge.detail.diagnostics.empty":
    "No parser diagnostics — all documents processed cleanly.",
  "localKnowledge.detail.diagnostics.groupedList": "Grouped parser diagnostics",
  "localKnowledge.detail.diagnostics.list": "Parser diagnostics",
  "localKnowledge.detail.diagnostics.severity.info": "Info",
  "localKnowledge.detail.diagnostics.severity.warning": "Warning",
  "localKnowledge.detail.diagnostics.severity.error": "Error",
  "localKnowledge.detail.diagnostics.groupAria": "{severity}: {code} ({count}x)",
  "localKnowledge.detail.diagnostics.rowAria": "{severity}: {code}",
  "localKnowledge.detail.jobs.title": "Indexing Job History",
  "localKnowledge.detail.jobs.empty": "No indexing jobs recorded yet.",
  "localKnowledge.detail.jobs.list": "Indexing job history",
  "localKnowledge.detail.jobs.inProgress": "In progress",
  "localKnowledge.detail.jobs.rowAria": "Job {id}: {status}",
  "localKnowledge.detail.jobs.status.queued": "Queued",
  "localKnowledge.detail.jobs.status.running": "Running",
  "localKnowledge.detail.jobs.status.succeeded": "Succeeded",
  "localKnowledge.detail.jobs.status.failed": "Failed",
  "localKnowledge.detail.jobs.status.cancelled": "Cancelled",
  "localKnowledge.detail.large.title": "Large documents",
  "localKnowledge.detail.large.list": "Large-document progress",
  "localKnowledge.detail.large.qualityWarnings": "Retrieval quality warnings",
  "localKnowledge.detail.large.inProgress": "In progress: {phases}",
  "localKnowledge.detail.large.idle": "Idle",
  "localKnowledge.detail.large.coverage": "{coverage} coverage",
  "localKnowledge.detail.large.pages": "{count} pages",
  "localKnowledge.detail.large.chunksEmbedded": "{embedded}/{chunks} chunks embedded",
  "localKnowledge.detail.large.resumable": "resumable",
  "localKnowledge.detail.large.resumeFailed": "Resume failed.",
  "localKnowledge.detail.large.partialCoverage.one":
    "1 document indexed with partial coverage. The pipeline is stable; retrieval quality is limited for this document.",
  "localKnowledge.detail.large.partialCoverage.many":
    "{count} documents indexed with partial coverage. The pipeline is stable; retrieval quality is limited for these documents.",
  "localKnowledge.detail.large.resumeAria": "Resume interrupted large-document indexing",
  "localKnowledge.detail.large.resuming": "Resuming…",
  "localKnowledge.detail.large.resume.one": "Resume 1 document",
  "localKnowledge.detail.large.resume.many": "Resume {count} documents",
  "localKnowledge.detail.recovery.title": "Interrupted indexing",
  "localKnowledge.detail.recovery.active":
    "Indexing is still active ({processed} processed across {sources} sources).",
  "localKnowledge.detail.recovery.resumable":
    "An interrupted run can resume ({processed} processed across {sources} sources).",
  "localKnowledge.detail.recovery.resume": "Resume indexing",
  "localKnowledge.detail.recovery.resuming": "Resuming…",
  "localKnowledge.detail.recovery.resumeAria": "Resume interrupted indexing",
  "localKnowledge.detail.recovery.failed": "Resume failed.",
  "localKnowledge.detail.large.phase.preflight": "Preflight",
  "localKnowledge.detail.large.phase.extracting": "Extracting",
  "localKnowledge.detail.large.phase.extracted": "Extracted",
  "localKnowledge.detail.large.phase.chunking": "Chunking",
  "localKnowledge.detail.large.phase.chunked": "Chunked",
  "localKnowledge.detail.large.phase.embedding": "Embedding",
  "localKnowledge.detail.large.phase.embedded": "Embedded",
  "localKnowledge.detail.large.phase.complete": "Complete",
  "localKnowledge.detail.large.phase.cancelled": "Cancelled",
  "localKnowledge.detail.large.phase.failed": "Failed",
} as const;

const LOCAL_KNOWLEDGE_DE_MESSAGES: LocalKnowledgeMessageCatalog = {
  "common.cancel": "Abbrechen",
  "common.retry": "Erneut versuchen",
  "common.dismissError": "Fehler ausblenden",
  "common.status": "Status",
  "common.save": "Speichern",
  "common.saving": "Speichere…",
  "common.delete": "Löschen",
  "common.continue": "Weiter",
  "common.browse": "Durchsuchen",
  "common.working": "Wird ausgeführt…",
  "common.dismiss": "Ausblenden",
  "localKnowledge.disconnect.title": "Knowledge Pod trennen",
  "localKnowledge.disconnect.description":
    '"{name}" trennen? Der Index bleibt erhalten; nur die Verknüpfung zur Quelle wird entfernt.',
  "localKnowledge.disconnect.confirm": "Trennen",
  "localKnowledge.row.addToWorkspace": "Zum Arbeitsbereich hinzufügen",
  "localKnowledge.row.actionsLabel": "Aktionen für Knowledge Pod {name}",
  "localKnowledge.row.addToWorkspaceLabel": "Knowledge Pod {name} zum Arbeitsbereich hinzufügen",
  "localKnowledge.row.details": "Details",
  "localKnowledge.row.detailsLabel": "Details zu Knowledge Pod {name} öffnen",
  "localKnowledge.row.disconnectLabel": "Knowledge Pod {name} trennen",
  "localKnowledge.row.disconnecting": "Wird getrennt…",
  "localKnowledge.picker.loading": "Knowledge Pods werden geladen…",
  "localKnowledge.picker.loadFailed": "Knowledge Pods konnten nicht geladen werden.",
  "localKnowledge.picker.retry": "Erneut versuchen",
  "localKnowledge.picker.create": "Knowledge Pod erstellen",
  "localKnowledge.picker.label": "Knowledge-Pod-Quelle auswählen",
  "localKnowledge.picker.placeholder": "— Knowledge-Pod-Quelle wählen —",
  "localKnowledge.picker.menuTitle": "Verfügbare Knowledge-Pod-Quellen",
  "localKnowledge.picker.setOption": "{name} ({count} Pods)",
  "localKnowledge.picker.setsFailed": "Knowledge Pod Sets konnten nicht geladen werden.",
  "localKnowledge.picker.manage": "Knowledge Pods erstellen oder verwalten",
  "localKnowledge.picker.state.ready": "Bereit",
  "localKnowledge.picker.state.indexing": "Wird indexiert…",
  "localKnowledge.picker.state.error": "Fehlgeschlagen",
  "localKnowledge.node.unselected": "Lokales Wissen",
  "localKnowledge.node.meta": "Lokaler Knowledge Pod",
  "localKnowledge.node.manage": "Verwalten",
  "localKnowledge.state.draft": "Entwurf",
  "localKnowledge.state.indexing": "Wird indexiert",
  "localKnowledge.state.ready": "Indexiert",
  "localKnowledge.state.stale": "Veraltet",
  "localKnowledge.state.deleting": "Wird gelöscht",
  "localKnowledge.state.error": "Fehlgeschlagen",
  "localKnowledge.row.cancelIndexingLabel": "Indexierung für Knowledge Pod {name} abbrechen",
  "localKnowledge.row.cancelling": "Wird abgebrochen…",
  "localKnowledge.row.startIndexingLabel": "Indexierung für Knowledge Pod {name} starten",
  "localKnowledge.row.attachSourceTitle":
    "Verbinde eine Quelle, bevor du diesen Knowledge Pod indexierst.",
  "localKnowledge.row.attachSourceHint": "Verbinde eine Quelle vor dem Indexieren.",
  "localKnowledge.row.index": "Indexieren",
  "localKnowledge.row.indexing": "Wird indexiert…",
  "localKnowledge.readiness.ready": "Bereit",
  "localKnowledge.readiness.indexing": "Wird indexiert",
  "localKnowledge.readiness.stale": "Veraltet",
  "localKnowledge.readiness.degraded": "Eingeschränkt",
  "localKnowledge.readiness.unavailable": "Nicht verfügbar",
  "localKnowledge.readiness.error": "Fehlgeschlagen",
  "localKnowledge.readiness.draft": "Entwurf",
  "localKnowledge.readiness.unknown": "Unbekannt",
  "localKnowledge.set.article": "Knowledge Pod Set: {name}",
  "localKnowledge.set.podCountBadge": "{count} Pods",
  "localKnowledge.set.podCountText": "{count} Knowledge Pods",
  "localKnowledge.set.readinessSummary": "Bereitschaft des Knowledge Pod Sets: {readiness}.",
  "localKnowledge.set.reasonsSummary": "Gründe: {reasons}",
  "localKnowledge.set.count.pods": "Pods",
  "localKnowledge.set.count.sources": "Quellen",
  "localKnowledge.set.count.docs": "Dokumente",
  "localKnowledge.set.count.chunks": "Chunks",
  "localKnowledge.set.count.vectors": "Vektoren",
  "localKnowledge.set.count.ready": "bereit",
  "localKnowledge.set.count.degraded": "eingeschränkt",
  "localKnowledge.set.count.unavailable": "nicht verfügbar",
  "localKnowledge.set.count.policyDenied": "durch Richtlinie gesperrt",
  "localKnowledge.set.count.indexing": "wird indexiert",
  "localKnowledge.set.count.stale": "veraltet",
  "localKnowledge.set.count.error": "fehlgeschlagen",
  "localKnowledge.set.count.missing": "fehlend",
  "localKnowledge.set.reason.memberDraft": "Entwurf",
  "localKnowledge.set.reason.memberIndexing": "wird indexiert",
  "localKnowledge.set.reason.memberStale": "veraltet",
  "localKnowledge.set.reason.memberError": "fehlgeschlagen",
  "localKnowledge.set.reason.memberUnavailable": "nicht verfügbar",
  "localKnowledge.set.reason.memberDegraded": "eingeschränkt",
  "localKnowledge.set.reason.missingMember": "fehlend",
  "localKnowledge.set.reason.policyDenied": "durch Richtlinie gesperrt",
  "localKnowledge.set.reason.embeddingUnknown": "Embedding unbekannt",
  "localKnowledge.set.reason.embeddingIncompatible": "Embedding-Abweichung",
  "localKnowledge.set.reason.embeddingUnavailable": "Embedding nicht verfügbar",
  "localKnowledge.set.reason.embeddingOpaque": "Embedding nicht prüfbar",
  "localKnowledge.set.reason.noSources": "keine Quellen",
  "localKnowledge.set.reason.noVectors": "keine Vektoren",
  "localKnowledge.set.reason.futureRemoteMember": "Remote-Platzhalter",
  "localKnowledge.set.reason.futureFederatedMember": "Föderations-Platzhalter",
  "localKnowledge.set.reason.futureEphemeralMember": "Platzhalter (ephemer)",
  "localKnowledge.guidance.summary": "Hinweis zum Knowledge Pod: {label}. {description}",
  "localKnowledge.guidance.label.embeddingMismatch": "Embedding-Abweichung",
  "localKnowledge.guidance.label.embeddingUnavailable": "Embedding nicht verfügbar",
  "localKnowledge.guidance.label.reindexRecommended": "Neuindexierung empfohlen",
  "localKnowledge.guidance.label.embeddingOpaque": "Embedding nicht prüfbar",
  "localKnowledge.guidance.label.manualReady": "HTML-Handbuch",
  "localKnowledge.guidance.label.manualDegraded": "Handbuch eingeschränkt",
  "localKnowledge.guidance.label.manualIndexing": "Handbuch wird indexiert",
  "localKnowledge.guidance.label.manualUnavailable": "Handbuch nicht verfügbar",
  "localKnowledge.guidance.label.futureMember": "Platzhalter für künftige Mitglieder",
  "localKnowledge.guidance.label.membersUnavailable": "Mitglieder nicht verfügbar",
  "localKnowledge.guidance.label.membersNotReady": "Mitglieder nicht bereit",
  "localKnowledge.guidance.label.retrievalDegraded": "Retrieval eingeschränkt",
  "localKnowledge.guidance.label.embeddingReadinessWarning": "Warnung zur Embedding-Bereitschaft",
  "localKnowledge.guidance.label.policyDenied": "Durch Richtlinie gesperrt",
  "localKnowledge.guidance.label.sealedLocalPolicy": "Versiegelte lokale Richtlinie",
  "localKnowledge.guidance.description.embeddingMismatch.pod":
    "Die semantische Suche ist für diesen Pod deaktiviert, bis er lokal neu indexiert wird.",
  "localKnowledge.guidance.description.embeddingMismatch.set":
    "Die semantische Suche ist für betroffene Set-Mitglieder deaktiviert, bis sie lokal neu indexiert werden.",
  "localKnowledge.guidance.description.embeddingUnavailable.pod":
    "Die semantische Suche kann unter der aktuellen lokalen Richtlinie nicht ausgeführt werden.",
  "localKnowledge.guidance.description.embeddingUnavailable.set":
    "Die semantische Suche kann für betroffene Set-Mitglieder unter der aktuellen lokalen Richtlinie nicht ausgeführt werden.",
  "localKnowledge.guidance.description.reindexRecommended.pod":
    "Die Kompatibilität ist ungeprüft; der lexikalische Fallback bleibt verfügbar.",
  "localKnowledge.guidance.description.reindexRecommended.set":
    "Die Kompatibilität ist für betroffene Set-Mitglieder ungeprüft; der lexikalische Fallback bleibt verfügbar.",
  "localKnowledge.guidance.description.embeddingOpaque.pod":
    "Die semantische Kompatibilität kann für diesen Retrieval-Raum nicht geprüft werden.",
  "localKnowledge.guidance.description.embeddingOpaque.set":
    "Die semantische Kompatibilität kann für dieses Knowledge Pod Set nicht geprüft werden.",
  "localKnowledge.guidance.description.policyDenied.pod":
    "Dieser Knowledge Pod blockiert geerdete Antwortsynthese oder die Freigabe von Rohinhalten; Keiko meldet den Zustand „durch Richtlinie gesperrt“, statt Auszüge an ein Modell zu senden.",
  "localKnowledge.guidance.description.policyDenied.set":
    "Dieses Knowledge Pod Set blockiert für betroffene Mitglieder geerdete Antwortsynthese oder die Freigabe von Rohinhalten; Keiko meldet den Zustand „durch Richtlinie gesperrt“, statt Auszüge an ein Modell zu senden.",
  "localKnowledge.guidance.description.sealedLocalPolicy.pod":
    "Externe Embedding- oder Reranking-Aufrufe sind für diesen Knowledge Pod deaktiviert; das Retrieval kann lexikalischen oder lokalen Fallback nutzen.",
  "localKnowledge.guidance.description.sealedLocalPolicy.set":
    "Externe Embedding- oder Reranking-Aufrufe sind für betroffene Set-Mitglieder deaktiviert; das Retrieval kann lexikalischen oder lokalen Fallback nutzen.",
  "localKnowledge.guidance.description.futureMember":
    "Dieses Knowledge Pod Set enthält Platzhalter für künftige Remote-, föderierte oder ephemere Mitglieder; diese sind noch keine aktiven Retrieval-Quellen.",
  "localKnowledge.guidance.description.membersUnavailable":
    "Einige Set-Mitglieder fehlen, sind fehlgeschlagen oder nicht verfügbar; das Retrieval nutzt nur verfügbare Mitglieder.",
  "localKnowledge.guidance.description.membersNotReady":
    "Einige Set-Mitglieder werden indexiert, sind veraltet oder Entwürfe; aktualisiere oder indexiere sie, bevor du dich auf dieses Set verlässt.",
  "localKnowledge.guidance.description.retrievalDegraded":
    "Einige Set-Mitglieder haben keine Quellen, keine Vektoren oder eine eingeschränkte Indexierung; womöglich ist nur der lexikalische Fallback verfügbar.",
  "localKnowledge.guidance.description.embeddingReadinessWarning":
    "Bei einigen Set-Mitgliedern muss das Embedding geprüft werden; Keiko vergleicht keine rohen Vektor-Scores über Embedding-Räume hinweg.",
  "localKnowledge.guidance.description.manualReady":
    "Bereit für die Chat-Suche über Lokales Wissen. {counts}.",
  "localKnowledge.guidance.description.manualDegraded":
    "Der Handbuch-Abruf ist eingeschränkt; Antworten nutzen womöglich nur verfügbare Belege. {counts}.",
  "localKnowledge.guidance.description.manualIndexing":
    "Handbuch-Abruf (Status: {state}); noch nicht bereit, Belege beizusteuern.",
  "localKnowledge.guidance.description.manualUnavailable":
    "Handbuch-Abruf (Status: {state}); er darf nicht stillschweigend als leere Belegmenge gelten.",
  "localKnowledge.guidance.manualCounts": "{docs} Dok. · {chunks} Chunks · {vectors} Vektoren",
  "localKnowledge.guidance.manualState.ready": "bereit",
  "localKnowledge.guidance.manualState.indexing": "wird indexiert",
  "localKnowledge.guidance.manualState.stale": "veraltet",
  "localKnowledge.guidance.manualState.degraded": "eingeschränkt",
  "localKnowledge.guidance.manualState.unavailable": "nicht verfügbar",
  "localKnowledge.guidance.manualState.error": "fehlgeschlagen",
  "localKnowledge.guidance.manualState.draft": "Entwurf",
  "localKnowledge.picker.sectionPods": "Knowledge Pods",
  "localKnowledge.picker.sectionSets": "Knowledge Pod Sets",
  "localKnowledge.picker.unavailablePod": "Knowledge Pod (nicht verfügbar)",
  "localKnowledge.picker.unavailableSet": "Knowledge Pod Set (nicht verfügbar)",
  "localKnowledge.picker.selectedWithState": "{name} ({state})",
  "localKnowledge.node.unavailable": "Nicht verfügbar",
  "localKnowledge.node.defaultLabel": "Knowledge Pod",
  "localKnowledge.manualRefresh.title": "Letzte Aktualisierung",
  "localKnowledge.manualRefresh.removalNote":
    "Entfernte Seiten konnten in diesem Lauf nicht erkannt werden (der Crawl hat sein Seitenlimit erreicht).",
  "localKnowledge.manualRefresh.outcome.unchanged": "Unverändert",
  "localKnowledge.manualRefresh.outcome.updated": "Aktualisiert",
  "localKnowledge.manualRefresh.outcome.partial": "Teilweise",
  "localKnowledge.manualRefresh.outcome.failed": "Fehlgeschlagen",
  "localKnowledge.manualRefresh.outcome.cancelled": "Abgebrochen",
  "localKnowledge.manualRefresh.count.addedPages": "Hinzugefügt",
  "localKnowledge.manualRefresh.count.changedPages": "Geändert",
  "localKnowledge.manualRefresh.count.removedPages": "Entfernt",
  "localKnowledge.manualRefresh.count.movedPages": "Verschoben",
  "localKnowledge.manualRefresh.count.unchangedPages": "Unverändert",
  "localKnowledge.manualRefresh.count.failedPages": "Fehlgeschlagen",
  "localKnowledge.manualRefresh.count.deniedLinks": "Abgelehnte Links",
  "localKnowledge.manualRefresh.reason.scopePreserved":
    "Die Aktualisierung hat den ursprünglich freigegebenen Handbuch-Umfang samt Limits wiederverwendet.",
  "localKnowledge.manualRefresh.reason.scopeLimitReached":
    "Die Aktualisierung hat ein Crawl-Limit erreicht; einige Seiten wurden nicht besucht.",
  "localKnowledge.manualRefresh.reason.removalDetectionSkipped":
    "Der Crawl hat sein Seitenlimit erreicht, daher konnten entfernte Seiten in diesem Lauf nicht erkannt werden.",
  "localKnowledge.manualRefresh.reason.pagesAdded": "Neue Seiten wurden entdeckt und indexiert.",
  "localKnowledge.manualRefresh.reason.pagesChanged":
    "Vorhandene Seiten haben sich geändert und wurden neu indexiert.",
  "localKnowledge.manualRefresh.reason.pagesRemoved":
    "Seiten, die nicht mehr erreichbar sind, wurden aus dem Pod entfernt.",
  "localKnowledge.manualRefresh.reason.pagesMoved":
    "Seiten wurden an einen neuen Ort verschoben; ihr Inhalt blieb unverändert.",
  "localKnowledge.manualRefresh.reason.pagesFailed":
    "Einige Seiten konnten nicht neu indexiert werden und sind möglicherweise vorübergehend nicht durchsuchbar; eine spätere erfolgreiche Aktualisierung versucht es erneut.",
  "localKnowledge.manualRefresh.reason.linksDenied":
    "Einige Links wurden übersprungen, weil sie außerhalb des freigegebenen Umfangs lagen.",
  "localKnowledge.manualRefresh.reason.embeddingIncompatible":
    "Das Embedding-Modell hat sich geändert; indexiere das Handbuch neu, um seine Vektoren zu aktualisieren.",
  "localKnowledge.manualRefresh.reason.crawlEmpty":
    "Der Aktualisierungs-Crawl hat keine indexierbaren Seiten gefunden.",
  "localKnowledge.manualRefresh.reason.crawlCancelled":
    "Die Aktualisierung wurde abgebrochen. Noch nicht erreichte Seiten sind nicht betroffen; eine Seite, die in diesem Moment bereits neu indexiert wurde, ist möglicherweise bis zu einer späteren erfolgreichen Aktualisierung vorübergehend nicht durchsuchbar.",
  "localKnowledge.manualRefresh.reason.indexFailed":
    "Die Indexierung ist bei der Aktualisierung fehlgeschlagen. Seiten, die zum Zeitpunkt des Fehlers neu indexiert wurden, sind möglicherweise vorübergehend nicht durchsuchbar, bis eine spätere erfolgreiche Aktualisierung sie repariert.",
  "localKnowledge.create.title": "Knowledge Pod erstellen",
  "localKnowledge.create.description":
    "Benenne diesen Knowledge Pod, verbinde eine Quelle und starte die Indexierung auf seiner Seite.",
  "localKnowledge.create.nameLabel": "Anzeigename des Knowledge Pod",
  "localKnowledge.create.validation.nameRequired":
    "Der Anzeigename des Knowledge Pod ist erforderlich.",
  "localKnowledge.create.access.legend": "Zugriff",
  "localKnowledge.create.access.hint": "Lege fest, wo dieser Knowledge Pod genutzt werden darf.",
  "localKnowledge.create.access.helpLabel": "Zugriff auf Knowledge Pods erläutern",
  "localKnowledge.create.access.help":
    "Der Zugriff legt fest, wo dieser Knowledge Pod genutzt werden darf. Lokal bleibt er privat auf dieser Keiko-Instanz. Teilbar wird später eine gezielte Freigabe ermöglichen.",
  "localKnowledge.create.access.local": "Lokal",
  "localKnowledge.create.access.localDescription":
    "Nur diese Keiko-Instanz kann diesen Knowledge Pod nutzen. Er wird nicht geteilt oder synchronisiert.",
  "localKnowledge.create.access.shareable": "Teilbar",
  "localKnowledge.create.access.shareableDescription":
    "Geplant für die Freigabe an ausgewählte Keiko-Nutzer oder andere Keiko-Instanzen.",
  "localKnowledge.create.access.shareableTooltip":
    "Kommt später: Knowledge Pods gezielt mit vertrauenswürdigen Keiko-Nutzern oder Keiko-Instanzen teilen. Bis dahin bleiben neue Knowledge Pods hier lokal und privat.",
  "localKnowledge.create.access.comingSoon": "Bald verfügbar",
  "localKnowledge.create.creating": "Wird erstellt…",
  "localKnowledge.create.submit": "Knowledge Pod erstellen",
  "localKnowledge.overview.backToWorkspace": "Zurück zum Arbeitsbereich",
  "localKnowledge.overview.backToPods": "Zurück zu Knowledge Pods",
  "localKnowledge.overview.sectionLabel": "Knowledge Pods",
  "localKnowledge.overview.emptyTitle": "Noch keine Knowledge Pods",
  "localKnowledge.overview.emptyBody":
    "Erstelle einen Knowledge Pod, um gesteuerte lokale Quellen zu indexieren.",
  "localKnowledge.overview.createFirst": "Ersten Knowledge Pod erstellen",
  "localKnowledge.overview.loadingPods": "Knowledge Pods werden geladen…",
  "localKnowledge.overview.podList": "Knowledge Pod-Liste",
  "localKnowledge.overview.combineDisabledHint":
    "Erstelle Knowledge Pods, bevor du sie zu einem Set kombinierst.",
  "localKnowledge.overview.retryLoadingPods": "Knowledge Pods erneut laden",
  "localKnowledge.set.createTitle": "Knowledge Pod Set erstellen",
  "localKnowledge.set.nameLabel": "Name des Knowledge Pod Set",
  "localKnowledge.set.membersLegend": "Knowledge Pods ({selected}/{max})",
  "localKnowledge.set.emptyMembers": "Keine Knowledge Pods zum Kombinieren verfügbar.",
  "localKnowledge.set.selectableMembers": "Auswählbare Knowledge Pods",
  "localKnowledge.set.validation.nameRequired": "Der Name des Knowledge Pod Set ist erforderlich.",
  "localKnowledge.set.validation.selectionRequired":
    "Wähle mindestens einen Knowledge Pod zum Kombinieren aus.",
  "localKnowledge.set.validation.tooMany":
    "Ein Knowledge Pod Set kann höchstens {count} Knowledge Pods enthalten.",
  "localKnowledge.set.submit": "Knowledge Pod Set erstellen",
  "localKnowledge.set.deleteTitle": "Knowledge Pod Set löschen",
  "localKnowledge.set.deleteDescription":
    '"{name}" löschen? Enthaltene Knowledge Pods behalten ihre Indizes; nur dieses Set wird entfernt.',
  "localKnowledge.set.deleteConfirm": "Löschen",
  "localKnowledge.set.deleting": "Lösche…",
  "localKnowledge.set.sectionTitle": "Knowledge Pod Sets",
  "localKnowledge.set.list": "Knowledge Pod Set-Liste",
  "localKnowledge.set.dragSet": "Knowledge Pod Set {name} in den Arbeitsbereich ziehen",
  "localKnowledge.set.dragSetTitle":
    "In den Arbeitsbereich ziehen, um eine Knowledge Pod Set-Karte zu erstellen",
  "localKnowledge.set.addToWorkspace": "Knowledge Pod Set {name} zum Arbeitsbereich hinzufügen",
  "localKnowledge.set.deleteAria": "Knowledge Pod Set {name} löschen",
  "localKnowledge.row.article": "Knowledge Pod: {name}",
  "localKnowledge.row.dragPod": "Knowledge Pod {name} in den Arbeitsbereich ziehen",
  "localKnowledge.row.dragPodTitle":
    "In den Arbeitsbereich ziehen, um eine Knowledge Pod-Karte zu erstellen",
  "localKnowledge.error.api": "Etwas ist schiefgelaufen. Versuche es erneut. ({code})",
  "localKnowledge.error.unexpected": "Ein unerwarteter Fehler ist aufgetreten.",
  "localKnowledge.nativeDialog.busy":
    "Es ist bereits ein nativer Dialog geöffnet. Schließe ihn zuerst.",
  "localKnowledge.nativeDialog.unavailable":
    "Native Dialoge sind auf dieser Plattform nicht verfügbar. Gib den Pfad manuell ein.",
  "localKnowledge.nativeDialog.partialSelection.singular":
    "{count} ausgewähltes Element konnte nicht hinzugefügt werden und wurde übersprungen.",
  "localKnowledge.nativeDialog.partialSelection.plural":
    "{count} ausgewählte Elemente konnten nicht hinzugefügt werden und wurden übersprungen.",
  "localKnowledge.detail.loading": "Knowledge Pod wird geladen…",
  "localKnowledge.detail.pageLabel": "Knowledge Pod-Detailansicht",
  "localKnowledge.detail.noSelection":
    "Kein Knowledge Pod ausgewählt. Öffne einen Knowledge Pod aus der Übersicht für lokales Wissen.",
  "localKnowledge.detail.notFound":
    "Dieser Knowledge Pod existiert nicht mehr. Kehre zur Übersicht für lokales Wissen zurück.",
  "localKnowledge.detail.loadFailed": "Knowledge Pod konnte nicht geladen werden.",
  "localKnowledge.detail.retryLoad": "Knowledge Pod erneut laden",
  "localKnowledge.detail.routeError.title":
    "Bei dieser Knowledge-Pod-Seite ist ein Fehler aufgetreten",
  "localKnowledge.detail.routeError.body":
    "Die Seite konnte nicht dargestellt werden. Ihr Knowledge Pod und dessen Daten sind davon nicht betroffen.",
  "localKnowledge.detail.routeError.retry": "Erneut versuchen",
  "localKnowledge.detail.backToLocalKnowledge": "Zurück zu lokalem Wissen",
  "localKnowledge.detail.tools": "Werkzeuge für diesen Knowledge Pod",
  "localKnowledge.detail.advanced.summary": "Status, Quellen und Diagnose",
  "localKnowledge.detail.advanced.hint": "Embeddings, Retrieval, Quellen und Job-Verlauf",
  "localKnowledge.detail.documentCounts": "Dokumentzählung",
  "localKnowledge.detail.rows.showMore": "{count} weitere {noun} anzeigen",
  "localKnowledge.detail.rows.showFewer": "Weniger {noun} anzeigen",
  "localKnowledge.detail.rows.diagnostics": "Diagnosen",
  "localKnowledge.detail.rows.jobs": "Jobs",
  "localKnowledge.detail.rename.formLabel": "Knowledge Pod umbenennen",
  "localKnowledge.detail.rename.displayName": "Anzeigename",
  "localKnowledge.detail.rename.description": "Beschreibung",
  "localKnowledge.detail.rename.nameRequired": "Der Anzeigename ist erforderlich.",
  "localKnowledge.detail.rename.button": "Umbenennen",
  "localKnowledge.detail.rename.buttonFor": "Knowledge Pod {name} umbenennen",
  "localKnowledge.detail.rebind.button": "Quelle neu verbinden",
  "localKnowledge.detail.rebind.repositoryRoot": "Neuer Repository-Stamm",
  "localKnowledge.detail.rebind.sharedRoot": "Neuer gemeinsamer Stammordner",
  "localKnowledge.detail.rebind.folderRoot": "Neuer Ordnerstamm",
  "localKnowledge.detail.rebind.chooseRoot": "Neuen Stammordner auswählen",
  "localKnowledge.detail.rebind.save": "Stamm speichern",
  "localKnowledge.detail.rebind.saving": "Verbinde neu…",
  "localKnowledge.detail.connect.region": "Quelle verbinden",
  "localKnowledge.detail.connect.title": "Knowledgequelle verbinden",
  "localKnowledge.detail.connect.description":
    "Wähle eine Knowledgequelle aus und verbinde sie mit diesem Knowledge Pod.",
  "localKnowledge.detail.connect.sourcePickerTitle": "Knowledgequelle",
  "localKnowledge.detail.connect.sourcePickerDescription":
    "Nutze Ordner für ganze Sammlungen oder Dokumente für gezielte Ergänzungen. Weitere Quellen kannst du später hinzufügen.",
  "localKnowledge.detail.connect.supportedFormats":
    "Unterstützt PDF-, Word- und Excel-Dateien sowie Text, Markdown, CSV, JSON, HTML und gängige Quell- und Konfigurationsdateien. Bis zu {size} pro Datei.",
  "localKnowledge.detail.connect.chooseFiles": "Dokumente für diesen Knowledge Pod auswählen",
  "localKnowledge.detail.connect.chooseFolder": "Ordner für diesen Knowledge Pod auswählen",
  "localKnowledge.detail.connect.pickFolderSource": "Ordner auswählen",
  "localKnowledge.detail.connect.pickDocumentSource": "Dokumente auswählen",
  "localKnowledge.detail.connect.filter.documents": "PDF-, Word- und Excel-Dateien",
  "localKnowledge.detail.connect.filter.structuredData": "Tabellen und strukturierte Daten",
  "localKnowledge.detail.connect.filter.textDocuments": "Text und Markdown",
  "localKnowledge.detail.connect.filter.webDocuments": "Webdokumente",
  "localKnowledge.detail.connect.filter.scripts": "Skripte",
  "localKnowledge.detail.connect.filter.sourceCode": "Quellcode",
  "localKnowledge.detail.connect.filter.configuration": "Konfigurationsdateien",
  "localKnowledge.detail.connect.sourcePath": "Quellpfad",
  "localKnowledge.detail.connect.displayName": "Anzeigename (optional)",
  "localKnowledge.detail.connect.displayNamePlaceholder":
    "Wird sicher aus der ausgewählten Quelle abgeleitet",
  "localKnowledge.detail.connect.specificFiles": "Nur bestimmte Dokumente indexieren",
  "localKnowledge.detail.connect.relativeFiles": "Relative Dokumentpfade",
  "localKnowledge.detail.connect.selectedSource": "Ausgewählte Knowledgequelle: {path}",
  "localKnowledge.detail.connect.selectedDocuments": "Ausgewählte Dokumente: {count} aus {root}",
  "localKnowledge.detail.connect.repositoryMode": "Als Code-Repository verbinden",
  "localKnowledge.detail.connect.selectedRepository": "Ausgewähltes Repository: {path}",
  "localKnowledge.detail.connect.repositoryFilesDisabledNote":
    "Die Auswahl einzelner Dokumente ist im Repository-Modus nicht verfügbar. Das gesamte Repository wird als eine Code-Quelle verbunden.",
  "localKnowledge.detail.connect.connect": "Verbinden",
  "localKnowledge.detail.connect.connecting": "Verbinde…",
  "localKnowledge.detail.connect.limitSummary":
    "Maximale Größe pro Datei: {size}. Parser-Budget: {objects} Objekte, {duration} pro Dokument.",
  "localKnowledge.detail.help.sourceSetup":
    "Eine Knowledgequelle ist das Material, das Keiko für diesen Knowledge Pod durchsuchen darf. Verbinde einen Ordner für eine Sammlung oder einzelne Dokumente für gezielte Ergänzungen.",
  "localKnowledge.detail.help.sourcePath":
    "Dieser Pfad zeigt Keiko, wo die ausgewählte Quelle auf diesem Gerät liegt. Keiko indexiert nur die verbundene Quelle.",
  "localKnowledge.detail.help.sourceDisplayName":
    "Lege optional einen Namen für diese Quelle fest. Ohne Eingabe leitet Keiko einen sicheren Namen aus der ausgewählten Quelle ab.",
  "localKnowledge.detail.help.specificFiles":
    "Nutze das, wenn aus einem Ordner nur bestimmte Dokumente in den Knowledge Pod sollen. Jede Zeile steht für ein Dokument unterhalb des Quellpfads.",
  "localKnowledge.detail.help.repositoryMode":
    "Verbindet diese Quelle als Code-Repository statt als Dokumentordner. Keiko nutzt dann code-bewusstes Chunking, Zitate mit Datei- und Zeilenangabe sowie eine schnelle inkrementelle Aktualisierung anhand der Git-Änderungen. Nicht gemeinsam mit der Auswahl einzelner Dokumente verfügbar.",
  "localKnowledge.detail.help.indexNow":
    "Startet die Indexierung. Keiko liest die Quelle, extrahiert Text und bereitet ihn für spätere Antworten vor.",
  "localKnowledge.detail.help.maintenance":
    "Diese Aktionen sind für Wartung und Fehlerbehebung. Du kannst Änderungen übernehmen, Probleme erneut versuchen, den Index neu aufbauen oder den Knowledge Pod löschen.",
  "localKnowledge.detail.help.maintenanceLimits":
    "Diese Grenzen schützen die App vor Dateien, die zu groß oder zu komplex für eine zuverlässige Verarbeitung sind.",
  "localKnowledge.detail.help.actionReembed":
    "Erstellt die Such-Fingerabdrücke mit dem aktuellen Embedding-Modell neu. Sinnvoll, wenn das Embedding-Modell gewechselt wurde.",
  "localKnowledge.detail.help.actionRebuild":
    "Verarbeitet alle Quellen von Anfang an. Nutze das, wenn Indexierungseinstellungen geändert wurden oder Ergebnisse unvollständig wirken.",
  "localKnowledge.detail.help.actionRefresh":
    "Sucht geänderte oder entfernte Dateien und aktualisiert nur das Nötige. Das ist der normale Wartungslauf für bestehende Quellen.",
  "localKnowledge.detail.help.actionRepair":
    "Versucht Dokumente erneut, die beim Indexieren fehlgeschlagen sind. Bereits erfolgreiche Dokumente bleiben erhalten.",
  "localKnowledge.detail.help.actionDelete":
    "Löscht den lokalen Index dieses Knowledge Pod. Die Dateien auf deinem Gerät werden nicht gelöscht.",
  "localKnowledge.detail.help.actionProgress":
    "Dieser Bereich zeigt den Live-Fortschritt der aktuellen Aktion. Er aktualisiert sich, während Keiko Dokumente und Vektoren verarbeitet.",
  "localKnowledge.detail.help.actionDocuments":
    "Zeigt, wie viele Dokumente diese Aktion bereits verarbeitet hat und wie viele erwartet werden.",
  "localKnowledge.detail.help.actionVectors":
    "Zeigt, wie viele durchsuchbare Text-Fingerabdrücke während dieser Aktion erstellt wurden.",
  "localKnowledge.detail.help.indexStatus":
    "Der Indexstatus zeigt, ob Keiko die verbundenen Quellen bereits verarbeitet hat und ob dieser Knowledge Pod für die Suche bereit ist.",
  "localKnowledge.detail.help.indexedDocuments":
    "Zeigt, wie viele Dokumente Keiko lesen und in den Index aufnehmen konnte. Fehlgeschlagene Dokumente benötigen Aufmerksamkeit.",
  "localKnowledge.detail.help.vectors":
    "Vektoren sind Such-Fingerabdrücke für Textabschnitte. Damit findet Keiko passende Inhalte nach Bedeutung, nicht nur nach exakten Wörtern.",
  "localKnowledge.detail.help.latestJob":
    "Der letzte Job ist der zuletzt gestartete Indexierungslauf. Er zeigt, ob Keiko noch arbeitet, fertig ist oder mit einem Fehler gestoppt hat.",
  "localKnowledge.detail.help.discoveryProgress":
    "Discovery bedeutet, dass Keiko Dokumente in der Quelle findet und prüft. Das ist die Vorstufe, bevor Inhalte wirklich suchbar sind.",
  "localKnowledge.detail.help.retrievalCoverage":
    "Die Retrieval-Abdeckung zeigt, wie viel der indexierten Inhalte für die semantische Suche bereit ist. Niedrige Abdeckung kann zu unvollständigen Treffern führen.",
  "localKnowledge.detail.help.indexMessage":
    "Diese Meldung fasst zusammen, ob Index und Suchdaten zum aktuellen Quellensatz passen.",
  "localKnowledge.detail.help.advanced":
    "Öffnet technische Details zu Quellen, Embeddings, Retrieval und Job-Verlauf. Nützlich, wenn Antworten erwartete Inhalte vermissen lassen.",
  "localKnowledge.detail.help.embeddingSection":
    "Embeddings übersetzen Text in Such-Fingerabdrücke. Dieser Bereich prüft, ob ältere und neue Fingerabdrücke noch zusammenpassen.",
  "localKnowledge.detail.help.pinnedModel":
    "Das fixierte Modell hat die vorhandenen Such-Fingerabdrücke erstellt. Dadurch bleibt nachvollziehbar, womit ältere Indexdaten entstanden sind.",
  "localKnowledge.detail.help.currentModel":
    "Das aktuelle Modell würde Keiko jetzt für neue oder neu aufgebaute Suchdaten verwenden.",
  "localKnowledge.detail.help.compatibility":
    "Kompatibel bedeutet, dass alte und neue Such-Fingerabdrücke zuverlässig vergleichbar sind. Wenn nicht, sollten die Vektoren neu erstellt werden.",
  "localKnowledge.detail.help.embeddingMessage":
    "Diese Meldung erklärt, ob die Embedding-Konfiguration bereit ist oder Aufmerksamkeit braucht.",
  "localKnowledge.detail.help.contextualRetrieval":
    "Kontextuelles Retrieval kann jedem Textabschnitt beim Indexieren eine kurze Einordnung hinzufügen. Das kann spätere Antworten verbessern, benötigt aber zusätzliche Modellaufrufe.",
  "localKnowledge.detail.help.contextStatus":
    "Zeigt, ob kontextuelles Retrieval bereit, deaktiviert oder ein Neuaufbau erforderlich ist.",
  "localKnowledge.detail.help.contextModel":
    "Zeigt, welches Chatmodell den Zusatzkontext erzeugt. Ohne eigenes Modell nutzt Keiko den Gateway-Standard.",
  "localKnowledge.detail.help.contextStale":
    "Veraltete Kontext-Chunks sind Abschnitte, deren Zusatzkontext nicht mehr zu den aktuellen Einstellungen passt. Ein Neuaufbau aktualisiert sie.",
  "localKnowledge.detail.help.contextEnable":
    "Aktiviert kontextuelles Retrieval für künftige Indexierungsläufe. Vorhandene Daten ändern sich erst nach einem Neuaufbau.",
  "localKnowledge.detail.help.contextModelInput":
    "Optionale Modell-ID für die Kontext-Erzeugung. Lasse das Feld leer, um den Gateway-Standard zu verwenden.",
  "localKnowledge.detail.help.contextStrict":
    "Im strikten Modus stoppt die Indexierung, wenn kein Kontext erzeugt werden kann. Lasse ihn aus, wenn Keiko mit einem Fallback weiterarbeiten soll.",
  "localKnowledge.detail.help.contextGeneratedLimit":
    "Begrenzt die Länge des erzeugten Kontexts pro Textabschnitt, damit der Index kompakt bleibt.",
  "localKnowledge.detail.help.contextDocumentLimit":
    "Begrenzt, wie viel Dokumenttext zur Kontext-Erzeugung für einen Abschnitt verwendet werden darf.",
  "localKnowledge.detail.help.contextSave":
    "Speichert diese Retrieval-Einstellungen. Baue den Knowledge Pod danach neu auf, damit vorhandene Abschnitte die neuen Einstellungen nutzen.",
  "localKnowledge.detail.help.sources":
    "Quellen sind die Ordner oder Dokumente, die mit diesem Knowledge Pod verbunden sind. Ein Pod kann mehrere Quellen kombinieren.",
  "localKnowledge.detail.help.sourceCard":
    "Diese Karte zeigt eine verbundene Quelle und wie viele Dokumente daraus indexiert, fehlgeschlagen oder übersprungen wurden.",
  "localKnowledge.detail.help.sourceCoverage":
    "Der Balken fasst das Ergebnis für diese Quelle zusammen: indexierte, fehlgeschlagene und übersprungene Dokumente.",
  "localKnowledge.detail.help.rebind":
    "Nutze das, wenn eine Quelle auf der Festplatte verschoben wurde. Keiko behält die Quelle und zeigt auf den neuen Speicherort.",
  "localKnowledge.detail.help.overview":
    "Der Überblick zeigt Grundeinstellungen und Gesundheitsinformationen zu diesem Knowledge Pod.",
  "localKnowledge.detail.help.overviewStatus":
    "Zeigt den Lebenszyklusstatus des Knowledge Pod, zum Beispiel Entwurf, Indexierung oder bereit.",
  "localKnowledge.detail.help.overviewEmbeddingModel":
    "Zeigt, welches Embedding-Modell mit den Suchdaten dieses Knowledge Pod verbunden ist.",
  "localKnowledge.detail.help.overviewStorage":
    "Zeigt, wie viel lokaler Speicher durch die Indexdaten aktuell belegt wird.",
  "localKnowledge.detail.help.overviewUnsupported":
    "Listet Dokumente, die Keiko mit den verfügbaren Parsern nicht verarbeiten konnte.",
  "localKnowledge.detail.help.overviewLastIndexed":
    "Zeigt, wann Keiko diesen Knowledge Pod zuletzt vollständig verarbeitet hat.",
  "localKnowledge.detail.help.overviewVectorCompatible":
    "Zeigt, ob die vorhandenen Such-Fingerabdrücke noch zur aktuellen Embedding-Konfiguration passen.",
  "localKnowledge.detail.help.overviewStaleReasons":
    "Listet Gründe, warum dieser Knowledge Pod eine Aktualisierung, einen Neuaufbau oder neue Vektoren benötigen kann.",
  "localKnowledge.detail.help.overviewNextSteps":
    "Zeigt konkrete nächste Schritte, wenn einzelne Dokumente nicht indexiert werden konnten.",
  "localKnowledge.detail.help.privacy":
    "Diese Hinweise erklären, was lokal bleibt und wann Keiko das konfigurierte Model Gateway nutzen kann.",
  "localKnowledge.detail.help.diagnostics":
    "Diagnosen zeigen Verarbeitungsprobleme, ohne Rohtext aus Dokumenten offenzulegen. Sie erklären, warum manche Dokumente Aufmerksamkeit brauchen.",
  "localKnowledge.detail.help.diagnosticRow":
    "Eine Diagnose beschreibt ein wiederkehrendes Verarbeitungsproblem, zum Beispiel eine unlesbare Seite oder ein nicht unterstütztes Format.",
  "localKnowledge.detail.help.jobs":
    "Die Job-Historie listet frühere Indexierungsläufe. Sie zeigt, wann Daten verarbeitet wurden und ob ein Lauf fehlgeschlagen ist.",
  "localKnowledge.detail.help.jobRow":
    "Eine Job-Zeile zeigt einen Indexierungslauf mit Status, Zeitraum, Dauer und Dokumentzählung.",
  "localKnowledge.detail.help.largeDocuments":
    "Große Dokumente werden in Etappen verarbeitet, damit Keiko fortsetzen kann, statt von vorne zu beginnen.",
  "localKnowledge.detail.help.largeDocumentRow":
    "Diese Zeile zeigt Phase und Abdeckung für ein großes Dokument.",
  "localKnowledge.detail.help.largeResume":
    "Setzt die Verarbeitung großer Dokumente dort fort, wo Keiko sicher weitermachen kann.",
  "localKnowledge.detail.actions.group": "Aktionen für Knowledge Pod {name}",
  "localKnowledge.detail.actions.maintenance": "Wartung und Löschen",
  "localKnowledge.detail.actions.maintenanceHint":
    "Aktualisieren, reparieren, neu aufbauen oder entfernen",
  "localKnowledge.detail.actions.index.button": "Jetzt indexieren",
  "localKnowledge.detail.actions.index.busy": "Indexiere…",
  "localKnowledge.detail.actions.index.aria": "Diesen Knowledge Pod jetzt indexieren",
  "localKnowledge.detail.actions.delete.title": "Knowledge Pod löschen",
  "localKnowledge.detail.actions.delete.description":
    'Dadurch wird der Pod-Index dauerhaft gelöscht. Quelldateien auf der Festplatte werden nicht gelöscht. Gib "{name}" ein, um zu bestätigen.',
  "localKnowledge.detail.actions.delete.confirmName": "Gib den Pod-Namen zur Bestätigung ein",
  "localKnowledge.detail.actions.delete.aria": "Knowledge Pod {name} löschen",
  "localKnowledge.detail.actions.reembed.title": "Vektoren für das aktuelle Modell neu erstellen",
  "localKnowledge.detail.actions.reembed.description":
    "Erstellt alle Vektoren für das aktuelle Embedding-Modell neu. Nutze diese Aktion, nachdem das konfigurierte Embedding-Modell oder Gateway geändert wurde.",
  "localKnowledge.detail.actions.reembed.confirm": "Vektoren neu erstellen",
  "localKnowledge.detail.actions.reembed.button": "Vektoren für aktuelles Modell neu erstellen",
  "localKnowledge.detail.actions.reembed.aria":
    "Vektoren von Knowledge Pod {name} für das aktuelle Embedding-Modell neu erstellen",
  "localKnowledge.detail.actions.rebuild.title": "Vollständig neu aufbauen",
  "localKnowledge.detail.actions.rebuild.description":
    "Verarbeitet alle Quellen erneut, baut Chunks und Retrieval-Texte neu auf und erstellt Embeddings mit dem aktuellen Modell. Nutze diese Aktion nach Änderungen an Tokenizer, Analyse oder kontextuellem Retrieval.",
  "localKnowledge.detail.actions.rebuild.confirm": "Neu aufbauen",
  "localKnowledge.detail.actions.rebuild.button": "Vollständig neu aufbauen",
  "localKnowledge.detail.actions.rebuild.aria": "Knowledge Pod {name} vollständig neu aufbauen",
  "localKnowledge.detail.actions.refresh.title": "Geänderte Dateien aktualisieren",
  "localKnowledge.detail.actions.refresh.description":
    "Führt eine inkrementelle Aktualisierung aus. Unveränderte Dateien bleiben bestehen, geänderte Dateien werden neu indexiert und entfernte Dateien bereinigt.",
  "localKnowledge.detail.actions.refresh.confirm": "Aktualisieren",
  "localKnowledge.detail.actions.refresh.button": "Geänderte Dateien aktualisieren",
  "localKnowledge.detail.actions.refresh.aria":
    "Geänderte Dateien für Knowledge Pod {name} aktualisieren",
  "localKnowledge.detail.actions.repair.title": "Fehlgeschlagene Dateien reparieren",
  "localKnowledge.detail.actions.repair.description":
    "Versucht zuvor fehlgeschlagene Dateien erneut und nimmt neu geänderte Dateien im selben inkrementellen Lauf mit.",
  "localKnowledge.detail.actions.repair.confirm": "Reparieren",
  "localKnowledge.detail.actions.repair.button": "Fehlgeschlagene Dateien reparieren",
  "localKnowledge.detail.actions.repair.aria":
    "Fehlgeschlagene Dateien für Knowledge Pod {name} reparieren",
  "localKnowledge.detail.progress.indexing": "Dokumente werden indexiert",
  "localKnowledge.detail.progress.reembedding":
    "Vektoren werden für das aktuelle Modell neu erstellt",
  "localKnowledge.detail.progress.refreshing": "Geänderte Dateien werden aktualisiert",
  "localKnowledge.detail.progress.repairing": "Fehlgeschlagene Dateien werden repariert",
  "localKnowledge.detail.progress.remaining": "Voraussichtlich verbleibend: {duration}",
  "localKnowledge.detail.progress.estimating": "Verbleibende Zeit wird geschätzt",
  "localKnowledge.detail.progress.elapsed": "Läuft weiter. Verstrichen: {duration}. {eta}.",
  "localKnowledge.detail.progress.documents": "Dokumente",
  "localKnowledge.detail.progress.vectors": "Vektoren",
  "localKnowledge.detail.progress.documentProgress": "Fortschritt der Dokumentaktion",
  "localKnowledge.detail.progress.vectorProgress": "Fortschritt der Vektoraktion",
  "localKnowledge.detail.progress.delayed": "Fortschrittsaktualisierung verzögert sich: {error}",
  "localKnowledge.detail.deleteAffectedSets.title": "Mitgliedschaft in Knowledge Pod Sets geändert",
  "localKnowledge.detail.deleteAffectedSets.description.one":
    "Dieser Knowledge Pod wurde aus einem Knowledge Pod Set entfernt, zu dem er gehörte.",
  "localKnowledge.detail.deleteAffectedSets.description.many":
    "Dieser Knowledge Pod wurde aus {count} Knowledge Pod Sets entfernt, zu denen er gehörte.",
  "localKnowledge.detail.index.title": "Indexstatus",
  "localKnowledge.detail.index.noJobRecorded": "Kein Job aufgezeichnet",
  "localKnowledge.detail.index.runFailed": "Indexierung fehlgeschlagen: {message}",
  "localKnowledge.detail.index.eta": "ETA {duration}",
  "localKnowledge.detail.index.updating": "Aktualisiert alle 2 s",
  "localKnowledge.detail.index.latestRun": "Letzter Lauf",
  "localKnowledge.detail.index.indexedDocuments": "Indexierte Dokumente",
  "localKnowledge.detail.index.failedSkipped": "{failed} fehlgeschlagen, {skipped} übersprungen",
  "localKnowledge.detail.index.vectors": "Vektoren",
  "localKnowledge.detail.index.chunksMissingVectors": "{count} Chunks ohne Vektoren",
  "localKnowledge.detail.index.allChunksEmbedded": "Alle Chunks haben Embeddings",
  "localKnowledge.detail.index.latestJob": "Letzter Job",
  "localKnowledge.detail.index.notIndexed": "Nicht indexiert",
  "localKnowledge.detail.index.discoveryProgress": "Discovery-Fortschritt",
  "localKnowledge.detail.index.retrievalCoverage": "Retrieval-Abdeckung",
  "localKnowledge.detail.index.embeddingStopped":
    "Embedding wurde vorzeitig beendet: {message}. Für {count} Chunks fehlen noch Vektoren.",
  "localKnowledge.detail.index.missingVectors":
    "Für {count} Chunks fehlen noch Vektoren, bevor Retrieval die gesamte Quelle abdecken kann.",
  "localKnowledge.detail.index.unsupportedDocuments":
    "{count} Dokumente benötigen einen anderen Extraktionspfad, bevor sie indexiert werden können.",
  "localKnowledge.detail.index.aligned": "Index und Vektoren passen zum aktuellen Quellensatz.",
  "localKnowledge.detail.compatibility.title": "Embedding-Kompatibilität",
  "localKnowledge.detail.compatibility.compatible": "Kompatibel",
  "localKnowledge.detail.compatibility.unknown": "Unbekannt",
  "localKnowledge.detail.compatibility.incompatible": "Inkompatibel",
  "localKnowledge.detail.compatibility.notConfigured": "Nicht konfiguriert",
  "localKnowledge.detail.compatibility.noProvider": "Kein Embedding-Anbieter",
  "localKnowledge.detail.compatibility.readyMessage":
    "Das fixierte Embedding-Modell ist für Embeddings konfiguriert.",
  "localKnowledge.detail.compatibility.fixGatewayMessage":
    "Embedding-Kompatibilität konnte nicht bestätigt werden. Führe nach der Gateway-Korrektur eine vollständige Neuerstellung der Vektoren aus.",
  "localKnowledge.detail.compatibility.pinnedModel": "Fixiertes Modell",
  "localKnowledge.detail.compatibility.currentModel": "Aktuelles Embedding-Modell",
  "localKnowledge.detail.compatibility.metric": "Kompatibilität",
  "localKnowledge.detail.compatibility.legacyHealth": "Legacy-Health",
  "localKnowledge.detail.overview.title": "Überblick",
  "localKnowledge.detail.overview.name": "Name",
  "localKnowledge.detail.overview.description": "Beschreibung",
  "localKnowledge.detail.overview.tags": "Knowledge Pod Tags",
  "localKnowledge.detail.overview.statusAria": "Status: {status}",
  "localKnowledge.detail.overview.embeddingModel": "Embedding-Modell",
  "localKnowledge.detail.overview.storageSize": "Speichergröße",
  "localKnowledge.detail.overview.unsupportedDocuments": "Nicht unterstützte Dokumente",
  "localKnowledge.detail.overview.lastIndexed": "Zuletzt indexiert",
  "localKnowledge.detail.overview.vectorCompatible": "Vektorkompatibel",
  "localKnowledge.detail.overview.vectorUnknown": "Unbekannt — Gateway-Konfiguration prüfen",
  "localKnowledge.detail.overview.vectorIncompatible":
    "Inkompatibel — Vektoren vollständig neu erstellen",
  "localKnowledge.detail.overview.staleReasons": "Gründe für veralteten Zustand",
  "localKnowledge.detail.overview.nextSteps": "Nächste Schritte",
  "localKnowledge.detail.overview.unsupportedGuidance":
    "Hinweise zu nicht unterstützten Dokumenten",
  "localKnowledge.detail.overview.unsupported.pdfNeedsOcr":
    "Gescannte PDFs benötigen einen OCR-fähigen Extraktionspfad. Konfiguriere einen verifizierten OCR- oder Vision-Adapter oder stelle ein PDF mit Textebene bereit.",
  "localKnowledge.detail.overview.unsupported.imageNeedsOcr":
    "Reine Bilddokumente benötigen einen OCR-fähigen Extraktionspfad, bevor sie indexiert werden können.",
  "localKnowledge.detail.overview.unsupported.ocrFailed":
    "Die OCR-Extraktion ist für mindestens ein Dokument fehlgeschlagen. Prüfe die Konfiguration des OCR-Adapters und starte die Indexierung erneut.",
  "localKnowledge.detail.overview.unsupported.unsupportedFormat":
    "Einige Dokumente werden in diesem Build nicht unterstützt. Prüfe die Diagnosen im Zustandsbericht für die betroffenen Formate und die nächsten Schritte.",
  "localKnowledge.detail.context.title": "Kontextuelles Retrieval",
  "localKnowledge.detail.context.description":
    "Erzeugt beim Indexieren pro Chunk einen zusätzlichen Chat-Aufruf für Kontext. Baue den Knowledge Pod nach dem Speichern vollständig neu auf.",
  "localKnowledge.detail.context.status.ready": "Bereit",
  "localKnowledge.detail.context.status.rebuild": "Neuaufbau erforderlich",
  "localKnowledge.detail.context.status.degraded": "Eingeschränkt",
  "localKnowledge.detail.context.status.unavailable": "Nicht verfügbar",
  "localKnowledge.detail.context.status.disabled": "Deaktiviert",
  "localKnowledge.detail.context.saved":
    "Gespeichert. Baue diesen Knowledge Pod vollständig neu auf, damit die Retrieval-Texte aktualisiert werden.",
  "localKnowledge.detail.context.saveFailed":
    "Kontextuelles Retrieval konnte nicht gespeichert werden.",
  "localKnowledge.detail.context.retrievalContext": "Retrieval-Kontext",
  "localKnowledge.detail.context.settingsSource": "Einstellungen: {source}",
  "localKnowledge.detail.context.model": "Kontextmodell",
  "localKnowledge.detail.context.gatewayDefault": "Gateway-Standard",
  "localKnowledge.detail.context.strict": "strikt",
  "localKnowledge.detail.context.nonStrict": "Fallback erlaubt",
  "localKnowledge.detail.context.staleChunks": "Veraltete Kontext-Chunks",
  "localKnowledge.detail.context.degradedChunks": "{count} eingeschränkt",
  "localKnowledge.detail.context.generateAtIndex": "Retrieval-Kontext beim Indexieren erzeugen",
  "localKnowledge.detail.context.modelId": "Kontextmodell-ID",
  "localKnowledge.detail.context.defaultModelPlaceholder":
    "Standard-Chatmodell des Gateways nutzen",
  "localKnowledge.detail.context.failOnError":
    "Indexierung fehlschlagen lassen, wenn Kontext nicht erzeugt werden kann",
  "localKnowledge.detail.context.generatedLimit": "Zeichenlimit für erzeugten Kontext",
  "localKnowledge.detail.context.documentLimit": "Zeichenlimit für Dokumentkontext",
  "localKnowledge.detail.context.save": "Retrieval-Einstellungen speichern",
  "localKnowledge.detail.sources.title": "Quellen",
  "localKnowledge.detail.sources.empty": "Mit diesem Knowledge Pod sind keine Quellen verbunden.",
  "localKnowledge.detail.sources.list": "Quellen des Knowledge Pod",
  "localKnowledge.detail.sources.selectedFiles.one": "{root} (1 ausgewählte Datei)",
  "localKnowledge.detail.sources.selectedFiles.many": "{root} ({count} ausgewählte Dateien)",
  "localKnowledge.detail.sources.coverage":
    "Dokumentabdeckung der Quelle: {indexed} indexiert, {failed} fehlgeschlagen, {skipped} übersprungen",
  "localKnowledge.detail.counts.indexed": "{count} indexiert",
  "localKnowledge.detail.counts.failed": "{count} fehlgeschlagen",
  "localKnowledge.detail.counts.skipped": "{count} übersprungen",
  "localKnowledge.detail.counts.processed": "{count} verarbeitet",
  "localKnowledge.detail.privacy.title": "Datenschutz und Löschung",
  "localKnowledge.detail.privacy.details": "Details zu Datenschutz und Löschung",
  "localKnowledge.detail.privacy.localState":
    "Indexierter Text, Vektoren, Diagnosen und Job-Historie bleiben im lokalen Keiko-Laufzeitstatus auf diesem Gerät.",
  "localKnowledge.detail.privacy.modelGateway":
    "Ausgewählte Chunks können beim Indexieren für Embeddings und bei geerdeten Antworten über das konfigurierte Model Gateway gesendet werden, wenn du Fragen zu diesem Knowledge Pod stellst.",
  "localKnowledge.detail.privacy.deletion":
    "Beim Löschen eines Knowledge Pod werden seine lokalen Indexdaten und Mitgliedschaften in Knowledge Pod Sets entfernt. Quelldateien auf der Festplatte werden nicht gelöscht.",
  "localKnowledge.detail.diagnostics.title": "Health-Diagnosen",
  "localKnowledge.detail.diagnostics.empty":
    "Keine Parser-Diagnosen — alle Dokumente wurden sauber verarbeitet.",
  "localKnowledge.detail.diagnostics.groupedList": "Gruppierte Parser-Diagnosen",
  "localKnowledge.detail.diagnostics.list": "Parser-Diagnosen",
  "localKnowledge.detail.diagnostics.severity.info": "Info",
  "localKnowledge.detail.diagnostics.severity.warning": "Warnung",
  "localKnowledge.detail.diagnostics.severity.error": "Fehler",
  "localKnowledge.detail.diagnostics.groupAria": "{severity}: {code} ({count}x)",
  "localKnowledge.detail.diagnostics.rowAria": "{severity}: {code}",
  "localKnowledge.detail.jobs.title": "Indexierungs-Historie",
  "localKnowledge.detail.jobs.empty": "Noch keine Indexierungsjobs aufgezeichnet.",
  "localKnowledge.detail.jobs.list": "Indexierungs-Historie",
  "localKnowledge.detail.jobs.inProgress": "Läuft",
  "localKnowledge.detail.jobs.rowAria": "Job {id}: {status}",
  "localKnowledge.detail.jobs.status.queued": "In Warteschlange",
  "localKnowledge.detail.jobs.status.running": "Läuft",
  "localKnowledge.detail.jobs.status.succeeded": "Erfolgreich",
  "localKnowledge.detail.jobs.status.failed": "Fehlgeschlagen",
  "localKnowledge.detail.jobs.status.cancelled": "Abgebrochen",
  "localKnowledge.detail.large.title": "Große Dokumente",
  "localKnowledge.detail.large.list": "Fortschritt großer Dokumente",
  "localKnowledge.detail.large.qualityWarnings": "Warnungen zur Retrieval-Qualität",
  "localKnowledge.detail.large.inProgress": "In Bearbeitung: {phases}",
  "localKnowledge.detail.large.idle": "Inaktiv",
  "localKnowledge.detail.large.coverage": "{coverage}-Abdeckung",
  "localKnowledge.detail.large.pages": "{count} Seiten",
  "localKnowledge.detail.large.chunksEmbedded": "{embedded}/{chunks} Chunks mit Embedding",
  "localKnowledge.detail.large.resumable": "fortsetzbar",
  "localKnowledge.detail.large.resumeFailed": "Fortsetzen fehlgeschlagen.",
  "localKnowledge.detail.large.partialCoverage.one":
    "1 Dokument wurde mit teilweiser Abdeckung indexiert. Die Pipeline ist stabil; die Retrieval-Qualität ist für dieses Dokument eingeschränkt.",
  "localKnowledge.detail.large.partialCoverage.many":
    "{count} Dokumente wurden mit teilweiser Abdeckung indexiert. Die Pipeline ist stabil; die Retrieval-Qualität ist für diese Dokumente eingeschränkt.",
  "localKnowledge.detail.large.resumeAria": "Unterbrochene Indexierung großer Dokumente fortsetzen",
  "localKnowledge.detail.large.resuming": "Setze fort…",
  "localKnowledge.detail.large.resume.one": "1 Dokument fortsetzen",
  "localKnowledge.detail.large.resume.many": "{count} Dokumente fortsetzen",
  "localKnowledge.detail.recovery.title": "Unterbrochene Indexierung",
  "localKnowledge.detail.recovery.active":
    "Die Indexierung ist noch aktiv ({processed} verarbeitet über {sources} Quellen).",
  "localKnowledge.detail.recovery.resumable":
    "Ein unterbrochener Lauf kann fortgesetzt werden ({processed} verarbeitet über {sources} Quellen).",
  "localKnowledge.detail.recovery.resume": "Indexierung fortsetzen",
  "localKnowledge.detail.recovery.resuming": "Wird fortgesetzt…",
  "localKnowledge.detail.recovery.resumeAria": "Unterbrochene Indexierung fortsetzen",
  "localKnowledge.detail.recovery.failed": "Fortsetzen fehlgeschlagen.",
  "localKnowledge.detail.large.phase.preflight": "Vorprüfung",
  "localKnowledge.detail.large.phase.extracting": "Extraktion",
  "localKnowledge.detail.large.phase.extracted": "Extrahiert",
  "localKnowledge.detail.large.phase.chunking": "Chunking",
  "localKnowledge.detail.large.phase.chunked": "In Chunks zerlegt",
  "localKnowledge.detail.large.phase.embedding": "Embedding",
  "localKnowledge.detail.large.phase.embedded": "Embedding erstellt",
  "localKnowledge.detail.large.phase.complete": "Abgeschlossen",
  "localKnowledge.detail.large.phase.cancelled": "Abgebrochen",
  "localKnowledge.detail.large.phase.failed": "Fehlgeschlagen",
};

export type LocalKnowledgeMessageKey = keyof typeof LOCAL_KNOWLEDGE_EN_MESSAGES;
export type I18nTranslate = (key: LocalKnowledgeMessageKey, values?: MessageValues) => string;
type LocalKnowledgeMessageCatalog = Readonly<Record<LocalKnowledgeMessageKey, string>>;

function catalogFor(locale: Locale): LocalKnowledgeMessageCatalog {
  return locale === "de" ? LOCAL_KNOWLEDGE_DE_MESSAGES : LOCAL_KNOWLEDGE_EN_MESSAGES;
}

function interpolate(template: string, values: MessageValues = {}): string {
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function translateLocalKnowledge(
  locale: Locale,
  key: LocalKnowledgeMessageKey,
  values?: MessageValues,
): string {
  const catalog = catalogFor(locale);
  return interpolate(catalog[key] ?? LOCAL_KNOWLEDGE_EN_MESSAGES[key], values);
}

// 0.3.0 release audit — the server sends a stable reason code for a document it could not extract
// (it must not hold locale copy); this is the single place that turns such a code into operator
// text. Keyed by the contract's closed code list, so a new code cannot ship without both catalog
// halves. An unrecognised code — a newer server talking to an older UI — falls back to the generic
// remediation rather than rendering a raw code or dropping the operator's next step entirely.
const UNSUPPORTED_GUIDANCE_MESSAGE_KEYS: Readonly<
  Record<UnsupportedDocumentGuidanceCode, LocalKnowledgeMessageKey>
> = {
  "pdf-needs-ocr": "localKnowledge.detail.overview.unsupported.pdfNeedsOcr",
  "image-needs-ocr": "localKnowledge.detail.overview.unsupported.imageNeedsOcr",
  "ocr-failed": "localKnowledge.detail.overview.unsupported.ocrFailed",
  "unsupported-format": "localKnowledge.detail.overview.unsupported.unsupportedFormat",
};

const KNOWN_UNSUPPORTED_GUIDANCE_CODES: ReadonlySet<string> = new Set(
  UNSUPPORTED_DOCUMENT_GUIDANCE_CODES,
);

function isUnsupportedGuidanceCode(value: string): value is UnsupportedDocumentGuidanceCode {
  return KNOWN_UNSUPPORTED_GUIDANCE_CODES.has(value);
}

/** Localized remediation text for one unsupported-document reason code. */
export function unsupportedGuidanceText(code: string, t: I18nTranslate): string {
  const key = isUnsupportedGuidanceCode(code)
    ? UNSUPPORTED_GUIDANCE_MESSAGE_KEYS[code]
    : UNSUPPORTED_GUIDANCE_MESSAGE_KEYS["unsupported-format"];
  return t(key);
}

// A Knowledge Pod / Pod Set readiness state, named in the user's language. `undefined` is a summary
// the server did not echo.
const READINESS_LABEL_KEYS: Readonly<Record<KnowledgePodReadiness, LocalKnowledgeMessageKey>> = {
  ready: "localKnowledge.readiness.ready",
  indexing: "localKnowledge.readiness.indexing",
  stale: "localKnowledge.readiness.stale",
  degraded: "localKnowledge.readiness.degraded",
  unavailable: "localKnowledge.readiness.unavailable",
  error: "localKnowledge.readiness.error",
  draft: "localKnowledge.readiness.draft",
};

export function readinessLabelText(
  readiness: KnowledgePodReadiness | undefined,
  t: I18nTranslate,
): string {
  return t(
    readiness === undefined ? "localKnowledge.readiness.unknown" : READINESS_LABEL_KEYS[readiness],
  );
}

// The short reason a Pod Set is not simply ready. Keyed by the contract's closed code list, so a
// new reason cannot ship without both catalog halves.
const SET_REASON_KEYS: Readonly<
  Record<KnowledgePodSetReadinessReasonCode, LocalKnowledgeMessageKey>
> = {
  "member-draft": "localKnowledge.set.reason.memberDraft",
  "member-indexing": "localKnowledge.set.reason.memberIndexing",
  "member-stale": "localKnowledge.set.reason.memberStale",
  "member-error": "localKnowledge.set.reason.memberError",
  "member-unavailable": "localKnowledge.set.reason.memberUnavailable",
  "member-degraded": "localKnowledge.set.reason.memberDegraded",
  "missing-member": "localKnowledge.set.reason.missingMember",
  "policy-denied": "localKnowledge.set.reason.policyDenied",
  "embedding-unknown": "localKnowledge.set.reason.embeddingUnknown",
  "embedding-incompatible": "localKnowledge.set.reason.embeddingIncompatible",
  "embedding-unavailable": "localKnowledge.set.reason.embeddingUnavailable",
  "embedding-opaque": "localKnowledge.set.reason.embeddingOpaque",
  "no-sources": "localKnowledge.set.reason.noSources",
  "no-vectors": "localKnowledge.set.reason.noVectors",
  "future-remote-member": "localKnowledge.set.reason.futureRemoteMember",
  "future-federated-member": "localKnowledge.set.reason.futureFederatedMember",
  "future-ephemeral-member": "localKnowledge.set.reason.futureEphemeralMember",
};

export function setReadinessReasonText(
  code: KnowledgePodSetReadinessReasonCode,
  t: I18nTranslate,
): string {
  return t(SET_REASON_KEYS[code]);
}

// Knowledge Pod guidance is a closed code plus a scope (the producer never emits display text): this
// table is the single place a code becomes a label and a description. Codes whose copy does not
// differ between one pod and a set name the same key for both scopes.
interface GuidanceCopyKeys {
  readonly label: LocalKnowledgeMessageKey;
  readonly description: Readonly<Record<KnowledgePodUiGuidance["scope"], LocalKnowledgeMessageKey>>;
}

function sameForBothScopes(
  label: LocalKnowledgeMessageKey,
  description: LocalKnowledgeMessageKey,
): GuidanceCopyKeys {
  return { label, description: { pod: description, "pod-set": description } };
}

const GUIDANCE_COPY_KEYS: Readonly<Record<KnowledgePodGuidanceCode, GuidanceCopyKeys>> = {
  "embedding-mismatch": {
    label: "localKnowledge.guidance.label.embeddingMismatch",
    description: {
      pod: "localKnowledge.guidance.description.embeddingMismatch.pod",
      "pod-set": "localKnowledge.guidance.description.embeddingMismatch.set",
    },
  },
  "embedding-unavailable": {
    label: "localKnowledge.guidance.label.embeddingUnavailable",
    description: {
      pod: "localKnowledge.guidance.description.embeddingUnavailable.pod",
      "pod-set": "localKnowledge.guidance.description.embeddingUnavailable.set",
    },
  },
  "reindex-recommended": {
    label: "localKnowledge.guidance.label.reindexRecommended",
    description: {
      pod: "localKnowledge.guidance.description.reindexRecommended.pod",
      "pod-set": "localKnowledge.guidance.description.reindexRecommended.set",
    },
  },
  "embedding-opaque": {
    label: "localKnowledge.guidance.label.embeddingOpaque",
    description: {
      pod: "localKnowledge.guidance.description.embeddingOpaque.pod",
      "pod-set": "localKnowledge.guidance.description.embeddingOpaque.set",
    },
  },
  "policy-denied": {
    label: "localKnowledge.guidance.label.policyDenied",
    description: {
      pod: "localKnowledge.guidance.description.policyDenied.pod",
      "pod-set": "localKnowledge.guidance.description.policyDenied.set",
    },
  },
  "sealed-local-policy": {
    label: "localKnowledge.guidance.label.sealedLocalPolicy",
    description: {
      pod: "localKnowledge.guidance.description.sealedLocalPolicy.pod",
      "pod-set": "localKnowledge.guidance.description.sealedLocalPolicy.set",
    },
  },
  "manual-ready": sameForBothScopes(
    "localKnowledge.guidance.label.manualReady",
    "localKnowledge.guidance.description.manualReady",
  ),
  "manual-degraded": sameForBothScopes(
    "localKnowledge.guidance.label.manualDegraded",
    "localKnowledge.guidance.description.manualDegraded",
  ),
  "manual-indexing": sameForBothScopes(
    "localKnowledge.guidance.label.manualIndexing",
    "localKnowledge.guidance.description.manualIndexing",
  ),
  "manual-unavailable": sameForBothScopes(
    "localKnowledge.guidance.label.manualUnavailable",
    "localKnowledge.guidance.description.manualUnavailable",
  ),
  "future-member-placeholder": sameForBothScopes(
    "localKnowledge.guidance.label.futureMember",
    "localKnowledge.guidance.description.futureMember",
  ),
  "members-unavailable": sameForBothScopes(
    "localKnowledge.guidance.label.membersUnavailable",
    "localKnowledge.guidance.description.membersUnavailable",
  ),
  "members-not-ready": sameForBothScopes(
    "localKnowledge.guidance.label.membersNotReady",
    "localKnowledge.guidance.description.membersNotReady",
  ),
  "retrieval-degraded": sameForBothScopes(
    "localKnowledge.guidance.label.retrievalDegraded",
    "localKnowledge.guidance.description.retrievalDegraded",
  ),
  "embedding-readiness-warning": sameForBothScopes(
    "localKnowledge.guidance.label.embeddingReadinessWarning",
    "localKnowledge.guidance.description.embeddingReadinessWarning",
  ),
};

const MANUAL_STATE_KEYS: Readonly<Record<KnowledgePodReadiness, LocalKnowledgeMessageKey>> = {
  ready: "localKnowledge.guidance.manualState.ready",
  indexing: "localKnowledge.guidance.manualState.indexing",
  stale: "localKnowledge.guidance.manualState.stale",
  degraded: "localKnowledge.guidance.manualState.degraded",
  unavailable: "localKnowledge.guidance.manualState.unavailable",
  error: "localKnowledge.guidance.manualState.error",
  draft: "localKnowledge.guidance.manualState.draft",
};

// Only the `manual-*` codes carry facts their copy interpolates (the counts and the state).
function guidanceValues(guidance: KnowledgePodUiGuidance, t: I18nTranslate): MessageValues {
  const manual = guidance.manual;
  if (manual === undefined) return {};
  return {
    counts: t("localKnowledge.guidance.manualCounts", {
      docs: manual.documentCount,
      chunks: manual.chunkCount,
      vectors: manual.vectorCount,
    }),
    state: t(MANUAL_STATE_KEYS[manual.readiness]),
  };
}

/** The label and description of one Knowledge Pod guidance, in the user's language. */
export function knowledgePodGuidanceText(
  guidance: KnowledgePodUiGuidance,
  t: I18nTranslate,
): { readonly label: string; readonly description: string } {
  const keys = GUIDANCE_COPY_KEYS[guidance.code];
  return {
    label: t(keys.label),
    description: t(keys.description[guidance.scope], guidanceValues(guidance, t)),
  };
}

// The operator guidance of one HTML manual refresh reason. The contract owns the closed code list and
// an English sentence for each; this catalog owns the wording the operator reads, in either language
// (a test pins the English text to the contract's, so the two cannot drift apart).
const MANUAL_REFRESH_REASON_KEYS: Readonly<
  Record<ManualRefreshReasonCode, LocalKnowledgeMessageKey>
> = {
  "scope-preserved": "localKnowledge.manualRefresh.reason.scopePreserved",
  "scope-limit-reached": "localKnowledge.manualRefresh.reason.scopeLimitReached",
  "removal-detection-skipped": "localKnowledge.manualRefresh.reason.removalDetectionSkipped",
  "pages-added": "localKnowledge.manualRefresh.reason.pagesAdded",
  "pages-changed": "localKnowledge.manualRefresh.reason.pagesChanged",
  "pages-removed": "localKnowledge.manualRefresh.reason.pagesRemoved",
  "pages-moved": "localKnowledge.manualRefresh.reason.pagesMoved",
  "pages-failed": "localKnowledge.manualRefresh.reason.pagesFailed",
  "links-denied": "localKnowledge.manualRefresh.reason.linksDenied",
  "embedding-incompatible": "localKnowledge.manualRefresh.reason.embeddingIncompatible",
  "crawl-empty": "localKnowledge.manualRefresh.reason.crawlEmpty",
  "crawl-cancelled": "localKnowledge.manualRefresh.reason.crawlCancelled",
  "index-failed": "localKnowledge.manualRefresh.reason.indexFailed",
};

export function manualRefreshReasonText(code: ManualRefreshReasonCode, t: I18nTranslate): string {
  return t(MANUAL_REFRESH_REASON_KEYS[code]);
}

export function useLocalKnowledgeTranslate(): I18nTranslate {
  const locale = useLocale();
  return useMemo<I18nTranslate>(() => {
    const catalog = catalogFor(locale);
    return (key, values) => interpolate(catalog[key] ?? LOCAL_KNOWLEDGE_EN_MESSAGES[key], values);
  }, [locale]);
}
