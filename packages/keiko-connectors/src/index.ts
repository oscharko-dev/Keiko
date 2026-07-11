// @oscharko-dev/keiko-connectors — governed Atlassian connector domain logic (Epic #2238,
// ADR-0128). Depends on keiko-contracts and keiko-security only; no network or filesystem
// capability of its own. keiko-server is the sole composition root: it owns the concrete vault
// instance, the metadata store, and the gatewayFetch-backed AtlassianHttpPort adapter.

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
  ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpBodyResult,
  type AtlassianHttpPort,
  type AtlassianHttpRequest,
  type AtlassianHttpResult,
} from "./atlassian-http-port.js";
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
