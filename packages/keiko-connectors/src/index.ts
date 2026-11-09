// @oscharko-dev/keiko-connectors — governed Atlassian connector domain logic (Epic #2238,
// ADR-0128). Depends on keiko-contracts and keiko-security only; no network or filesystem
// capability of its own. keiko-server is the sole composition root: it owns the concrete vault
// instance, the metadata store, and the gatewayFetch-backed AtlassianHttpPort adapter.

export { KEIKO_CONNECTORS_VERSION } from "./version.js";
export { JIRA_PROJECT_LEAD_MAX_CHARS, JIRA_PROJECT_URL_MAX_CHARS } from "./jira-native-values.js";

export {
  ATLASSIAN_ACCOUNT_EMAIL_MAX_CHARS,
  ATLASSIAN_API_TOKEN_MAX_CHARS,
  ATLASSIAN_API_TOKEN_MIN_CHARS,
  AtlassianCredentialCustodyError,
  atlassianAuthorizationHeaderValue,
  createAtlassianCredentialCustody,
  isAtlassianCredentialMetadata,
  isSafeAtlassianAccountEmail,
  isSafeAtlassianApiToken,
  type AtlassianCredentialCustody,
  type AtlassianCredentialCustodyDeps,
  type AtlassianCredentialCustodyErrorCode,
  type AtlassianCredentialExecutionResolver,
  type AtlassianCredentialMetadata,
  type AtlassianCredentialMetadataStore,
  type AtlassianCredentialVaultPort,
  type AtlassianResolvedCredential,
  type CreatedAtlassianCredentialCustody,
} from "./atlassian-credential-custody.js";
export {
  JiraHumanInputCustodyError,
  type JiraHumanInputCustody,
  type JiraHumanInputExecutionResolver,
} from "./jira-human-input-custody.js";
export {
  copyHumanInputBinding,
  humanInputView,
  parseHumanInputValues,
  type JiraHumanInputBinding,
  type JiraHumanInputContext,
  type JiraHumanInputValues,
} from "./jira-human-input-values.js";
export {
  prepareJiraHumanInput,
  type JiraHumanInputSelection,
} from "./jira-human-input-preparation.js";
export { prepareJiraHumanInputReview } from "./jira-human-input-review.js";
export { jiraNativeId } from "./jira-native-values.js";
export { parseJsonRecord, parseJsonObjectOrArray } from "./atlassian-sync-classify.js";
export { jiraApplicationLinkId } from "./jira-reciprocal-link-values.js";
export {
  JiraPrivateSessionError,
  type JiraPrivateSessionAccess,
  type JiraPrivateSessionExecutionResolver,
} from "./jira-private-session-custody.js";
export {
  jiraPrivateCookie,
  jiraSessionBindingForInput,
  jiraPrivateSessionReference,
  copyJiraSessionBinding,
  type JiraPrivateSessionBinding,
  type JiraPrivateSessionScope,
  type JiraPrivateCookie,
} from "./jira-private-session-values.js";
export type {
  JiraPrivateIdentityPorts,
  JiraHumanInputHttpRequest,
} from "./jira-private-identity-ports.js";
export { executeAdmittedJiraRequest } from "./jira-request-admission.js";
export type {
  JiraAvatarPorts,
  JiraAvatarSession,
  JiraAvatarTarget,
  JiraAvatarMutation,
  JiraAvatarAttempt,
} from "./jira-avatar-mutation-values.js";
export {
  ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES,
  ATLASSIAN_HTTP_UPLOAD_MAX_BYTES,
  type AtlassianHttpUpload,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  isAtlassianApplicationRoleVersion,
  type AtlassianHttpBodyResult,
  type AtlassianHttpPort,
  type AtlassianHttpRequest,
  type AtlassianHttpResult,
} from "./atlassian-http-port.js";
export { maintenancePathNode } from "./jira-maintenance-mutation-values.js";
export {
  ATLASSIAN_SYNC_ITEM_MAX_BYTES,
  ATLASSIAN_SYNC_PAGINATED_FETCH_TIMEOUT_MS,
  ATLASSIAN_SYNC_RETRY_BASE_DELAY_MS,
  ATLASSIAN_SYNC_RETRY_FACTOR,
  ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS,
  ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS,
  runAtlassianSyncFetch,
  type AtlassianSyncEnumerationOutcome,
  type AtlassianSyncFetchContext,
  type AtlassianSyncFetchOutcome,
  type AtlassianSyncItem,
  type AtlassianSyncItemFailure,
  type AtlassianSyncItemFetchOutcome,
  type AtlassianSyncItemRef,
  type AtlassianSyncSource,
  type RunAtlassianSyncFetchDeps,
} from "./atlassian-sync-lane.js";
export {
  CONFLUENCE_LIST_RESPONSE_MAX_BYTES,
  createConfluenceSyncSource,
  type ConfluencePageRef,
  type ConfluenceSyncSourceOptions,
} from "./confluence-sync-adapter.js";
export {
  createInMemoryConfluenceFixture,
  type ConfluenceFixturePage,
  type ConfluenceFixtureSpace,
  type InMemoryConfluenceFixtureOptions,
} from "./confluence-sync-fixtures.js";
export {
  ATLASSIAN_CONNECTION_VERIFICATION_STATUSES,
  ATLASSIAN_VERIFY_CONNECTION_PATHS,
  ATLASSIAN_VERIFY_CONNECTION_TIMEOUT_MS,
  buildAtlassianVerificationRequest,
  isAtlassianConnectionVerificationStatus,
  verifyAtlassianConnection,
  type AtlassianConnectionVerificationStatus,
  type VerifyAtlassianConnectionInput,
} from "./atlassian-connection-verification.js";
export {
  verifyJiraDataCenterConnection,
  verifyJiraDataCenterCompatibility,
  verifyJiraDataCenterIdentity,
  type JiraDataCenterCompatibilityResult,
} from "./jira-connection-verification.js";
export {
  ADF_SUPPORTED_DOC_VERSION,
  ADF_TO_TEXT_MAX_DEPTH,
  ADF_TO_TEXT_MAX_NODES,
  ADF_TO_TEXT_MAX_OUTPUT_CHARS,
  convertAdfToText,
  type AdfConversionOutcome,
  type AdfDocShape,
  type AdfTruncationReason,
} from "./adf-to-text.js";
export {
  JIRA_COMPOSED_DOCUMENT_MAX_BYTES,
  JIRA_DOCUMENT_TRUNCATION_MARKER,
  buildJiraIssueCitationMetadata,
  jiraIssueMetadataLine,
  serializeJiraIssueCitationMetadata,
} from "./jira-issue-document.js";
export {
  JIRA_INCREMENTAL_SYNC_OVERLAP_MS,
  JIRA_LIST_RESPONSE_MAX_BYTES,
  JIRA_SEARCH_PAGE_SIZE,
  composeJiraScopeJql,
  createJiraSyncSource,
  laterJiraProviderTimestamp,
  parseJiraProviderTimestampMs,
  type JiraIncrementalSyncOptions,
  type JiraIssueRef,
  type JiraSyncEnumerationSnapshot,
  type JiraSyncSourceOptions,
} from "./jira-sync-adapter.js";
export {
  buildHostileJiraAdfDocument,
  createInMemoryJiraFixture,
  type InMemoryJiraFixtureOptions,
  type JiraFixtureComment,
  type JiraFixtureIssue,
  type JiraFixtureProject,
} from "./jira-sync-fixtures.js";
export {
  ATLASSIAN_LIVE_SEARCH_TIMEOUT_MS,
  JIRA_LIVE_SEARCH_MAX_PAGE_REQUESTS,
  JIRA_LIVE_SEARCH_MAX_TOTAL_BYTES,
  JIRA_LIVE_SEARCH_TEMPLATE_JQL,
  executeJiraLiveSearch,
  resolveJiraLiveSearchJql,
  type JiraLiveSearchDeps,
  type JiraLiveSearchFailureReason,
  type JiraLiveSearchInput,
  type JiraLiveSearchOutcome,
} from "./jira-live-search.js";
export {
  MARKDOWN_LITE_MAX_INPUT_CHARS,
  type MarkdownLiteRejectionReason,
} from "./markdown-lite-blocks.js";
export {
  ADF_COMPOSED_DOC_VERSION,
  composePlainTextToAdf,
  type AdfComposedBlockNode,
  type AdfComposedDocument,
  type AdfComposedInlineNode,
  type PlainTextToAdfResult,
} from "./plain-text-to-adf.js";
export {
  composePlainTextToStorageFormat,
  escapeStorageFormatText,
  type PlainTextToStorageFormatResult,
} from "./plain-text-to-storage-format.js";
export {
  ATLASSIAN_WRITE_ACTION_TIMEOUT_MS,
  ATLASSIAN_WRITE_RESPONSE_MAX_BYTES,
  executeAtlassianWriteRequest,
  type AtlassianWriteHttpDeps,
  type AtlassianWriteHttpOutcome,
  type AtlassianWriteHttpRequest,
} from "./atlassian-write-http.js";
export {
  JIRA_ISSUE_LABELS_MAX_ENTRIES,
  JIRA_SUMMARY_MAX_CHARS,
  addJiraIssueComment,
  createJiraIssue,
  transitionJiraIssue,
  updateJiraIssueFields,
  type AddJiraIssueCommentInput,
  type AddJiraIssueCommentResult,
  type AtlassianWriteActionFailure,
  type CreateJiraIssueInput,
  type CreateJiraIssueResult,
  type JiraWriteActionDeps,
  type TransitionJiraIssueInput,
  type TransitionJiraIssueResult,
  type UpdateJiraIssueFieldsInput,
  type UpdateJiraIssueFieldsResult,
} from "./jira-write-actions.js";
export {
  CONFLUENCE_TITLE_MAX_CHARS,
  addConfluencePageComment,
  createConfluencePage,
  updateConfluencePage,
  type AddConfluencePageCommentInput,
  type AddConfluencePageCommentResult,
  type ConfluenceWriteActionDeps,
  type CreateConfluencePageInput,
  type CreateConfluencePageResult,
  type UpdateConfluencePageInput,
  type UpdateConfluencePageResult,
} from "./confluence-write-actions.js";

export {
  createJiraManagedProvider,
  type JiraManagedConnection,
  type JiraManagedProviderDeps,
  type JiraManagedMutationExecutor,
  type JiraDraftBatchExecutor,
} from "./jira-managed-tools.js";
export {
  executeJiraAgileRead,
  JIRA_AGILE_READ_OPERATIONS,
  type JiraAgileReadOperation,
} from "./jira-agile-reads.js";
export {
  executeJiraAgileMutation,
  checkJiraAgileMutation,
  checkJiraAgileMutationTemplates,
} from "./jira-agile-mutations.js";
export {
  JIRA_AGILE_MUTATIONS,
  parseAgileMutation,
  isJiraAgileMutation,
  type JiraAgileMutation,
  type AgileMutationInput,
} from "./jira-agile-inputs.js";
export { executeJiraFilterRead, JIRA_FILTER_READ_OPERATIONS } from "./jira-filter-reads.js";
export {
  executeJiraIssueDetailRead,
  isJiraIssueDetailRead,
  JIRA_ISSUE_DETAIL_READS,
} from "./jira-managed-issue-details.js";
export {
  executeJiraCommentRead,
  executeJiraCommentMutation,
  isJiraCommentRead,
  isJiraCommentMutation,
} from "./jira-managed-comments.js";
export {
  executeJiraComponentRead,
  executeJiraComponentMutation,
  isJiraComponentRead,
  isJiraComponentMutation,
} from "./jira-managed-components.js";
export {
  executeJiraVersionRead,
  executeJiraVersionMutation,
  isJiraVersionRead,
  isJiraVersionMutation,
} from "./jira-managed-versions.js";
export {
  readJiraCreateTemplateRules,
  type JiraCreateTemplateRules,
  type JiraCreateTemplateRulesResult,
} from "./jira-create-template-metadata.js";
export {
  isJiraIssueTypeReference,
  isJiraProjectReference,
  JIRA_PROJECT_REFERENCE_PATTERN,
  resolveJiraDraftPlacement,
  resolveJiraDraftPlacementWith,
  JIRA_PLACEMENT_TYPE_NAMES_MAX,
  type JiraDraftPlacement,
  type JiraDraftPlacementResult,
} from "./jira-draft-placement.js";
export { JIRA_METADATA_MAX_UPDATES } from "./jira-field-metadata.js";
export {
  JIRA_ISSUE_LINKS_MAX,
  JIRA_ISSUE_LINKS_PER_REQUEST_MAX,
  isJiraIssueLinkWrite,
} from "./jira-issue-links.js";
export {
  parseJiraAttachmentArguments,
  type JiraAttachmentContent,
  type JiraAttachmentSource,
  type JiraAttachmentSourceRequest,
  type JiraAttachmentSourceResult,
  type JiraAttachmentArguments,
} from "./jira-attachments.js";
export {
  JIRA_DRAFT_IDENTITY_PREFIX,
  JIRA_REQUIREMENT_IDS_MAX,
  parseRequirementIds,
  excludedJiraDraftRefs,
  jiraDraftDependencies,
  jiraDraftIdentity,
  checkJiraDraft,
  parseJiraDraft,
  type JiraDraft,
  type JiraDraftCheck,
  type JiraDraftProblem,
  type JiraDraftItem,
  type JiraDraftLink,
  type JiraDraftParent,
} from "./jira-draft.js";
export {
  descriptionWithFooter,
  type JiraTraceOutcome,
  type JiraTraceRequest,
} from "./jira-requirement-trace.js";
export {
  executeJiraDraftItem,
  findJiraDraftItem,
  jiraDraftFieldRefusals,
  readJiraAttachmentLimit,
  type JiraDraftFieldRefusal,
} from "./jira-managed-mutations.js";
export { jiraBrowseUrl } from "./jira-browse-url.js";
export {
  JIRA_TEMPLATE_FINDING_CODES,
  checkJiraIssueTemplate,
  checkJiraIssueTemplates,
  jiraTemplateValuePresent,
  jiraTemplateValueText,
  matchingJiraIssueTemplates,
  resolveJiraTemplateFieldIds,
  jiraTemplateViolationGuidance,
  validateJiraIssueTemplateAgainstInstance,
  type JiraFieldCatalogEntry,
  type JiraTemplateFinding,
  type JiraTemplateFindingCode,
  type JiraTemplateInstanceMetadata,
  type JiraTemplateSubject,
} from "./jira-issue-template-check.js";
export {
  gateJiraMutationByTemplates,
  JIRA_TEMPLATE_SYSTEM_FIELDS,
  type JiraIssueTemplateSet,
  type JiraIssueTemplateSource,
  type JiraTemplateGateInput,
  type JiraTemplateGateResult,
} from "./jira-managed-template-gate.js";
export {
  checkJiraManagedMutation,
  requestFor as createJiraReadRequest,
} from "./jira-managed-mutations.js";
export {
  deriveJiraTemplateSections,
  proposeJiraIssueTemplates,
  readJiraTemplateInstanceMetadata,
  renderProposedJiraIssueTemplate,
  type JiraTemplateInstanceRead,
  type JiraTemplateProposal,
  type JiraTemplateProposalInput,
} from "./jira-issue-template-instance.js";
export { createJiraReportTemplateChecker } from "./jira-report-template-checker.js";
export { createJiraReportStore, type JiraReportStore } from "./jira-report-store.js";
export {
  createJiraDraftStore,
  type JiraDraftSourceBinding,
  type JiraDraftStore,
  type StagedJiraDraft,
  type StagedJiraDraftItem,
} from "./jira-draft-store.js";
export {
  executeJiraDraftStageTool,
  firstJiraDraftTemplateRefusal,
  parseJiraDraftReference,
  resolveJiraDraftArguments,
  type JiraDraftActivity,
  type JiraDraftPreparation,
  type JiraDraftTemplateRefusal,
  type JiraDraftRefusal,
  type JiraDraftResolution,
  type JiraDraftToolDeps,
} from "./jira-draft-stage-tool.js";
export { withJiraCreateMetadataMemo, type JiraDraftReadCounts } from "./jira-draft-read-memo.js";
export { exportJiraReport, jiraReportCommentText } from "./jira-report-export.js";
export type {
  JiraReportActivity,
  JiraReportRequirementIds,
  JiraReportToolDeps,
} from "./jira-report-tool.js";
export type {
  JiraReport,
  JiraReportCheckerBinder,
  JiraReportCheckerPort,
  JiraReportComplianceChecker,
  JiraReportFieldCatalogEntry,
  JiraReportDeviation,
  JiraReportIssueFacts,
} from "./jira-report-types.js";
export { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
export { jiraPropertyPathKey, jiraPropertyUserText } from "./jira-entity-property-values.js";
export { jiraRemoteVersionLinkGlobalId } from "./jira-managed-remote-version-links.js";
export { rolePrincipalText } from "./jira-role-values.js";
export { isJiraFieldId } from "./jira-field-metadata.js";
export { JIRA_NONSECRET_PREFERENCE_KINDS } from "./jira-managed-application-settings.js";
export type {
  JiraEmailTemplateEntry,
  JiraEmailTemplatePack,
  JiraEmailTemplateObservation,
} from "./jira-email-template-values.js";
