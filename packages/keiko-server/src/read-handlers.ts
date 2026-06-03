// The six read-only BFF endpoints (ADR-0011 D5 routes 2,3,4,10,11,12). Each returns a redacted JSON
// projection of already-safe data: config via `toSafeObject` (strips apiKey), configured model
// capabilities, the workflow launch-form descriptors, the workspace summary built from the workspace
// layer, and evidence list/detail served straight from the store (manifests are redacted-by-
// construction on disk, served as-is per D9). No secret reaches any response; the config route
// never leaks the config path even on a load failure (handled upstream in deps.ts, which yields
// `config: undefined` rather than throwing).

import { toSafeObject, listConfiguredCapabilities } from "@oscharko-dev/keiko-model-gateway";
import {
  UNIT_TEST_WORKFLOW_DESCRIPTOR,
  BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR,
} from "@oscharko-dev/keiko-workflows";
import { DEFAULT_LIMITS } from "@oscharko-dev/keiko-harness";
import {
  listEvidence,
  loadEvidence,
  assertValidRunId,
  EvidenceReadError,
  EvidenceSchemaError,
  type EvidenceListEntry,
} from "@oscharko-dev/keiko-evidence";
import {
  buildContextPackFromFiles,
  buildWorkspaceSummary,
  DEFAULT_CONTEXT_REQUEST,
  detectWorkspace,
  discoverWithStats,
  WORKSPACE_CODES,
  WorkspaceError,
  type WorkspaceCode,
  type WorkspaceSummary,
} from "@oscharko-dev/keiko-workspace";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig, currentGatewayConfigPresent } from "./deps.js";
import { validateProjectPath } from "./store/validation.js";

// Route 2 — resolved config (SafeGatewayConfig, never apiKey/baseUrl) or null when no config was resolved.
export function handleConfig(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const config = currentGatewayConfig(deps);
  return {
    status: 200,
    body: {
      config: config === undefined ? null : toSafeObject(config),
      configPresent: currentGatewayConfigPresent(deps),
    },
  };
}

// Route 3 — models published by the resolved UI gateway config. If no config is resolved, no
// model-backed run can start, so the endpoint returns an empty list.
export function handleModels(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const config = currentGatewayConfig(deps);
  const models = config === undefined ? [] : listConfiguredCapabilities(config);
  return { status: 200, body: { models } };
}

// Route 4 — launch-form metadata: the workflow descriptors plus the synthesized explain-plan and
// verify inputs (both are harness tasks with no workflow descriptor — verify is BFF-only and runs
// the deterministic verification orchestrator).
export function handleWorkflows(): RouteResult {
  return {
    status: 200,
    body: {
      descriptors: [UNIT_TEST_WORKFLOW_DESCRIPTOR, BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR],
      explainPlan: {
        inputs: [
          {
            name: "filePath",
            type: "string",
            required: true,
            description: "Path to the file to explain (read-only task).",
          },
          {
            name: "question",
            type: "string",
            required: false,
            description: "Optional focusing question for the explanation.",
          },
        ],
        defaultLimits: DEFAULT_LIMITS,
      },
      verify: {
        inputs: [
          {
            name: "workspaceRoot",
            type: "string",
            required: true,
            description: "Project root to verify.",
          },
          {
            name: "targetFiles",
            type: "string[]",
            required: false,
            description: "Optional file subset to target tests for.",
          },
        ],
        defaultLimits: DEFAULT_LIMITS,
      },
    },
  };
}

function parsePositiveBudget(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("invalid budget");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("invalid budget");
  }
  return parsed;
}

function workspaceErrorResult(error: WorkspaceError): RouteResult {
  const status =
    error.code === WORKSPACE_CODES.NOT_FOUND
      ? 404
      : error.code === WORKSPACE_CODES.FILE_TOO_LARGE || error.code === WORKSPACE_CODES.READ_FAILED
        ? 422
        : 400;
  return { status, body: errorBody(error.code, workspaceErrorMessage(error.code)) };
}

const WORKSPACE_ERROR_MESSAGES: Record<WorkspaceCode, string> = {
  [WORKSPACE_CODES.PATH_ESCAPE]: "The workspace path is outside the registered project.",
  [WORKSPACE_CODES.PATH_DENIED]: "The workspace path is denied by policy.",
  [WORKSPACE_CODES.NOT_FOUND]: "The workspace could not be found.",
  [WORKSPACE_CODES.FILE_TOO_LARGE]: "The workspace file is too large.",
  [WORKSPACE_CODES.READ_FAILED]: "The workspace could not be read.",
};

function workspaceErrorMessage(code: WorkspaceCode): string {
  return WORKSPACE_ERROR_MESSAGES[code];
}

interface WorkspaceRequest {
  readonly dir: string;
  readonly task: string | undefined;
  readonly budget: number | undefined;
}

function readWorkspaceRequest(q: URLSearchParams): WorkspaceRequest | RouteResult {
  let budget: number | undefined;
  try {
    budget = parsePositiveBudget(q.get("budget"));
  } catch {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "The budget query parameter must be a positive integer."),
    };
  }
  const dir = q.get("dir");
  if (dir === null) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "The dir query parameter is required."),
    };
  }
  return { dir, task: q.get("task") ?? undefined, budget };
}

function workspaceNotRegisteredResult(): RouteResult {
  return {
    status: 403,
    body: errorBody("WORKSPACE_NOT_REGISTERED", "The workspace directory is not a registered project."),
  };
}

function resolveRegisteredWorkspace(
  rawDir: string,
  deps: UiHandlerDeps,
): { readonly normalized: string } | RouteResult {
  let normalized: string;
  try {
    normalized = validateProjectPath(rawDir, { mustExist: false });
  } catch {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "The dir query parameter must be a valid local project path."),
    };
  }
  const registered = deps.store.listProjects().some((project) => project.path === normalized);
  if (!registered) {
    return workspaceNotRegisteredResult();
  }
  return { normalized };
}

function workspaceSummaryResult(
  request: WorkspaceRequest,
  registeredRoot: string,
  deps: UiHandlerDeps,
): RouteResult {
  try {
    const workspace = detectWorkspace(registeredRoot);
    if (workspace.root !== registeredRoot) {
      return workspaceNotRegisteredResult();
    }
    const { files, stats } = discoverWithStats(workspace, DEFAULT_CONTEXT_REQUEST.discovery);
    const wantsContext = request.task !== undefined || request.budget !== undefined;
    const pack = wantsContext
      ? buildContextPackFromFiles(
          workspace,
          {
            ...DEFAULT_CONTEXT_REQUEST,
            task: request.task,
            budgetBytes: request.budget ?? DEFAULT_CONTEXT_REQUEST.budgetBytes,
          },
          files,
        )
      : undefined;
    const summary = buildWorkspaceSummary(workspace, pack, stats);
    const body = deps.redactor({ summary }) as { readonly summary: WorkspaceSummary };
    return { status: 200, body };
  } catch (error) {
    if (error instanceof WorkspaceError) {
      const result = workspaceErrorResult(error);
      return { status: result.status, body: deps.redactor(result.body) };
    }
    throw error;
  }
}

// Route 12 — workspace summary and optional context pack, built by the safe workspace layer.
export function handleWorkspace(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const request = readWorkspaceRequest(ctx.url.searchParams);
  if ("status" in request) {
    return request;
  }
  const registered = resolveRegisteredWorkspace(request.dir, deps);
  if ("status" in registered) {
    return registered;
  }
  return workspaceSummaryResult(request, registered.normalized, deps);
}

interface EvidenceFilters {
  readonly workspace: string | undefined;
  readonly date: string | undefined;
  readonly workflow: string | undefined;
  readonly model: string | undefined;
  readonly outcome: string | undefined;
}

function readFilters(url: URL): EvidenceFilters {
  const q = url.searchParams;
  return {
    workspace: q.get("workspace") ?? undefined,
    date: q.get("date") ?? undefined,
    workflow: q.get("workflow") ?? undefined,
    model: q.get("model") ?? undefined,
    outcome: q.get("outcome") ?? undefined,
  };
}

// `EvidenceListEntry.startedAt` is epoch ms; the `date` filter matches the started-at calendar day
// (UTC `YYYY-MM-DD`). `workspace` is a substring match to support path-fragment filtering, while
// `model` is an exact model-id match.
function matchesOptionalFilter(value: string | undefined, filter: string | undefined): boolean {
  return filter === undefined || value === filter;
}

function matchesDateFilter(entry: EvidenceListEntry, date: string | undefined): boolean {
  return date === undefined || new Date(entry.startedAt).toISOString().slice(0, 10) === date;
}

function matchesWorkspaceFilter(entry: EvidenceListEntry, workspace: string | undefined): boolean {
  return workspace === undefined || entry.workspaceRoot?.includes(workspace) === true;
}

function matchesFilters(entry: EvidenceListEntry, filters: EvidenceFilters): boolean {
  return (
    matchesOptionalFilter(entry.taskType, filters.workflow) &&
    matchesOptionalFilter(entry.outcome, filters.outcome) &&
    matchesDateFilter(entry, filters.date) &&
    matchesOptionalFilter(entry.modelId, filters.model) &&
    matchesWorkspaceFilter(entry, filters.workspace)
  );
}

// Route 10 — evidence list header projection, filtered server-side.
export function handleEvidenceList(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const filters = readFilters(ctx.url);
  const entries = listEvidence(deps.evidenceStore).filter((entry) =>
    matchesFilters(entry, filters),
  );
  return { status: 200, body: { entries } };
}

// Route 11 — a single evidence manifest, served as-is (already redacted on disk). Invalid runId →
// 400; absent → 404; an EvidenceSchemaError → 422; an EvidenceReadError → 422 (safe, pre-redacted
// `.message`).
export function handleEvidenceDetail(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const runId = ctx.params.runId ?? "";
  try {
    assertValidRunId(runId);
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "The run id is not valid.") };
  }
  try {
    const manifest = loadEvidence(deps.evidenceStore, runId);
    if (manifest === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "No evidence for that run id.") };
    }
    return { status: 200, body: { manifest } };
  } catch (error) {
    if (error instanceof EvidenceSchemaError) {
      return { status: 422, body: errorBody("EVIDENCE_SCHEMA", error.message) };
    }
    if (error instanceof EvidenceReadError) {
      return { status: 422, body: errorBody("EVIDENCE_READ", error.message) };
    }
    throw error;
  }
}
