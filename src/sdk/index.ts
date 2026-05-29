// Single-sourced package version; CLI and SDK both read this to avoid drift.
export const SDK_VERSION = "0.1.0";

// The typed agent surface. AgentConfig, the session factory, the run result, and the
// session handle all live in the harness module (ADR-0004); the SDK re-exports them so
// callers import the agent API from one place.
export {
  createSession,
  runAgent,
  type AgentConfig,
  type AgentSession,
  type HarnessDeps,
  type RunResult,
  type TaskInput,
  type TaskType,
} from "../harness/index.js";

// Safe workspace context surface (ADR-0005). The only file-read path is the
// boundary-checked one; no export returns raw arbitrary file content.
export {
  buildWorkspaceSummary,
  detectWorkspace,
  summarizeForAudit,
  type AuditEntry,
  type AuditSummary,
  type ContextEntrySummary,
  type ContextPackSummary,
  type WorkspaceInfo,
  type WorkspaceSummary,
} from "../workspace/index.js";
