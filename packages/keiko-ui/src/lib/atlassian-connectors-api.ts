// Issue #2245 (Epic #2238, ADR-0128) — typed BFF client for the governed Atlassian connector lane.
//
// Mirrors the local-knowledge-api conventions exactly: every route hits the same-origin BFF through
// the shared `bffFetchJson` scaffold (Accept: application/json, the CSRF header + JSON content-type
// on state-changing methods, a per-request correlation id, and the `{ error: { code, message } }`
// envelope parsed into an `ApiError`). Response bodies are NEVER logged. The API token is write-only
// (ADR-0128 D2): it rides the create request body once and is never returned, echoed, or persisted
// client-side — no function here reads or exposes it after the create call resolves.
//
// Wire types come from `@oscharko-dev/keiko-contracts`; the few UI-local response envelopes below
// (credential metadata projection, list wrappers) have no contract equivalent and are composed from
// contract enums, exactly as local-knowledge-api defines `CapsuleDetail`/`SourceIndexStats` for
// server shapes the contract layer does not name.

import { bffFetchJson } from "./http";
import type {
  AtlassianConnectionVerificationStatus,
  AtlassianConnectorProvider,
  AtlassianConnectorAuthScheme,
  AtlassianConnectorActionExecutionResult,
  AtlassianConnectorActivityRecord,
  AtlassianConnectorActivityReasonCode,
  AtlassianConnectorActionDisposition,
  AtlassianConnectorPendingApproval,
  AtlassianSyncJobState,
  JiraLiveSearchResult,
} from "@oscharko-dev/keiko-contracts";
import {
  ATLASSIAN_CONNECTION_VERIFICATION_STATUSES,
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
  isAtlassianConnectionVerificationStatus,
} from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// UI-local wire shapes (no contract equivalent; enums come from keiko-contracts)
// ---------------------------------------------------------------------------

// The bounded connection-probe outcome union the verify route returns (ADR-0128 D3) is the shared
// contract wire type; the UI aliases it (and its guard/status list) under local names so every
// surface renders exactly these actionable states and never a raw provider error — one source of
// truth in the contracts leaf, no re-declaration.
export const ATLASSIAN_CONNECTOR_VERIFY_STATUSES = ATLASSIAN_CONNECTION_VERIFICATION_STATUSES;

export type AtlassianConnectorVerifyStatus = AtlassianConnectionVerificationStatus;

export const isAtlassianConnectorVerifyStatus = isAtlassianConnectionVerificationStatus;

// The non-secret credential metadata projection every credentials route answers (ADR-0128 D2). It
// carries no field that could hold the token; `authRef` is the opaque vault handle and `createdAt`
// is the epoch-ms registration time surfaced in the connector list.
export interface AtlassianConnectorMetadata {
  readonly schemaVersion: typeof ATLASSIAN_CONNECTOR_SCHEMA_VERSION;
  readonly authRef: string;
  readonly provider: AtlassianConnectorProvider;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authScheme: AtlassianConnectorAuthScheme;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Request/response envelopes
// ---------------------------------------------------------------------------

// The create request is the ONLY hop the token makes. `apiToken` is write-only: it is not part of
// any response type below, so a caller cannot round-trip it back into client state.
export interface CreateAtlassianConnectorInput {
  readonly provider: AtlassianConnectorProvider;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly accountEmail: string;
  readonly apiToken: string;
}

export interface VerifyAtlassianConnectorResult {
  readonly authRef: string;
  readonly status: AtlassianConnectorVerifyStatus;
}

// A human-triggered sync start (ADR-0128 D5): a Confluence space scope or a Jira project scope with
// optional JQL. No authority envelope — a direct human trigger is human-approved by construction.
export interface StartConfluenceSyncInput {
  readonly spaceKeys: readonly string[];
  readonly displayName?: string;
}

export interface StartJiraSyncInput {
  readonly projectKeys: readonly string[];
  readonly jql?: string;
  readonly displayName?: string;
}

export type StartAtlassianSyncInput = StartConfluenceSyncInput | StartJiraSyncInput;

export interface AtlassianSyncJobResult {
  readonly job: AtlassianSyncJobState;
  readonly capsuleId?: string;
}

// The approve route executes on approval and answers the connector's typed result: for a write it
// carries `result` (succeeded/failed with a closed reason); for a live search it also carries the
// ephemeral `liveSearch` payload; for an admitted sync it carries the started `job` (202). When the
// Authority Envelope re-check at approve time fails, the disposition is `denied` and `reasonCode`
// holds exactly one content-free reason (ADR-0125 revalidation).
export interface ApproveAtlassianConnectorActionResult {
  readonly disposition: AtlassianConnectorActionDisposition;
  readonly result?: AtlassianConnectorActionExecutionResult;
  readonly liveSearch?: JiraLiveSearchResult;
  readonly job?: AtlassianSyncJobState;
  readonly capsuleId?: string;
  readonly reasonCode?: AtlassianConnectorActivityReasonCode;
  readonly correlationId?: string;
}

export interface RejectAtlassianConnectorActionResult {
  readonly approvalId: string;
  readonly disposition: AtlassianConnectorActionDisposition;
  readonly outcome: "cancelled";
  readonly correlationId?: string;
}

// ---------------------------------------------------------------------------
// Shared fetch wrapper — friendly parse-failure message (uiux-fix F033/C064 parity).
// ---------------------------------------------------------------------------

function friendlyParseFailureMessage(status: number): string {
  return `The server returned an unexpected error (HTTP ${status.toString()}). Try again.`;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return bffFetchJson<T>(path, init, { parseFailureMessage: friendlyParseFailureMessage });
}

const CREDENTIALS_PATH = "/api/atlassian-connectors/credentials";

function credentialPath(authRef: string, suffix = ""): string {
  return `${CREDENTIALS_PATH}/${encodeURIComponent(authRef)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export async function listAtlassianConnectors(): Promise<readonly AtlassianConnectorMetadata[]> {
  const response = await fetchJson<{ credentials: readonly AtlassianConnectorMetadata[] }>(
    CREDENTIALS_PATH,
  );
  return response.credentials;
}

export async function createAtlassianConnector(
  input: CreateAtlassianConnectorInput,
): Promise<AtlassianConnectorMetadata> {
  return fetchJson<AtlassianConnectorMetadata>(CREDENTIALS_PATH, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteAtlassianConnector(authRef: string): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>(credentialPath(authRef), { method: "DELETE" });
}

export async function verifyAtlassianConnector(
  authRef: string,
): Promise<VerifyAtlassianConnectorResult> {
  return fetchJson<VerifyAtlassianConnectorResult>(credentialPath(authRef, "/verify"), {
    method: "POST",
    body: "{}",
  });
}

// ---------------------------------------------------------------------------
// Sync jobs and activity
// ---------------------------------------------------------------------------

export async function startAtlassianConnectorSync(
  authRef: string,
  input: StartAtlassianSyncInput,
): Promise<AtlassianSyncJobResult> {
  return fetchJson<AtlassianSyncJobResult>(credentialPath(authRef, "/sync-jobs"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getAtlassianConnectorSyncJob(jobId: string): Promise<AtlassianSyncJobResult> {
  return fetchJson<AtlassianSyncJobResult>(
    `/api/atlassian-connectors/sync-jobs/${encodeURIComponent(jobId)}`,
  );
}

export async function cancelAtlassianConnectorSyncJob(
  jobId: string,
): Promise<AtlassianSyncJobResult> {
  return fetchJson<AtlassianSyncJobResult>(
    `/api/atlassian-connectors/sync-jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST", body: "{}" },
  );
}

export async function listAtlassianConnectorActivity(
  authRef: string,
): Promise<readonly AtlassianConnectorActivityRecord[]> {
  const response = await fetchJson<{ activity: readonly AtlassianConnectorActivityRecord[] }>(
    credentialPath(authRef, "/activity"),
  );
  return response.activity;
}

// ---------------------------------------------------------------------------
// Write-action approvals
// ---------------------------------------------------------------------------

const APPROVALS_PATH = "/api/atlassian-connectors/action-approvals";

function approvalPath(approvalId: string, suffix = ""): string {
  return `${APPROVALS_PATH}/${encodeURIComponent(approvalId)}${suffix}`;
}

export async function listAtlassianConnectorApprovals(): Promise<
  readonly AtlassianConnectorPendingApproval[]
> {
  const response = await fetchJson<{ approvals: readonly AtlassianConnectorPendingApproval[] }>(
    APPROVALS_PATH,
  );
  return response.approvals;
}

export async function getAtlassianConnectorApproval(
  approvalId: string,
): Promise<AtlassianConnectorPendingApproval> {
  const response = await fetchJson<{ approval: AtlassianConnectorPendingApproval }>(
    approvalPath(approvalId),
  );
  return response.approval;
}

export async function approveAtlassianConnectorAction(
  approvalId: string,
): Promise<ApproveAtlassianConnectorActionResult> {
  return fetchJson<ApproveAtlassianConnectorActionResult>(approvalPath(approvalId, "/approve"), {
    method: "POST",
    body: "{}",
  });
}

export async function rejectAtlassianConnectorAction(
  approvalId: string,
): Promise<RejectAtlassianConnectorActionResult> {
  return fetchJson<RejectAtlassianConnectorActionResult>(approvalPath(approvalId, "/reject"), {
    method: "POST",
    body: "{}",
  });
}

// ---------------------------------------------------------------------------
// Dependency-injection surface — components take `client?: AtlassianConnectorsClient` so tests can
// substitute a mock (mirrors GovernedMergeCard's `client` prop). The default binds the real helpers.
// ---------------------------------------------------------------------------

export interface AtlassianConnectorsClient {
  readonly listConnectors: () => Promise<readonly AtlassianConnectorMetadata[]>;
  readonly createConnector: (
    input: CreateAtlassianConnectorInput,
  ) => Promise<AtlassianConnectorMetadata>;
  readonly deleteConnector: (authRef: string) => Promise<{ ok: true }>;
  readonly verifyConnector: (authRef: string) => Promise<VerifyAtlassianConnectorResult>;
  readonly startSync: (
    authRef: string,
    input: StartAtlassianSyncInput,
  ) => Promise<AtlassianSyncJobResult>;
  readonly getSyncJob: (jobId: string) => Promise<AtlassianSyncJobResult>;
  readonly cancelSyncJob: (jobId: string) => Promise<AtlassianSyncJobResult>;
  readonly listActivity: (authRef: string) => Promise<readonly AtlassianConnectorActivityRecord[]>;
  readonly listApprovals: () => Promise<readonly AtlassianConnectorPendingApproval[]>;
  readonly getApproval: (approvalId: string) => Promise<AtlassianConnectorPendingApproval>;
  readonly approveAction: (approvalId: string) => Promise<ApproveAtlassianConnectorActionResult>;
  readonly rejectAction: (approvalId: string) => Promise<RejectAtlassianConnectorActionResult>;
}

export const defaultAtlassianConnectorsClient: AtlassianConnectorsClient = {
  listConnectors: listAtlassianConnectors,
  createConnector: createAtlassianConnector,
  deleteConnector: deleteAtlassianConnector,
  verifyConnector: verifyAtlassianConnector,
  startSync: startAtlassianConnectorSync,
  getSyncJob: getAtlassianConnectorSyncJob,
  cancelSyncJob: cancelAtlassianConnectorSyncJob,
  listActivity: listAtlassianConnectorActivity,
  listApprovals: listAtlassianConnectorApprovals,
  getApproval: getAtlassianConnectorApproval,
  approveAction: approveAtlassianConnectorAction,
  rejectAction: rejectAtlassianConnectorAction,
};
