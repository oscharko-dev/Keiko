// The five read-only BFF endpoints (ADR-0011 D5 routes 2,3,4,10,11). Each returns a redacted JSON
// projection of already-safe data: config via `toSafeObject` (strips apiKey), the full capability
// registry, the workflow launch-form descriptors, and evidence list/detail served straight from the
// store (manifests are redacted-by-construction on disk, served as-is per D9). No secret reaches any
// response; the config route never leaks the config path even on a load failure (handled upstream in
// deps.ts, which yields `config: undefined` rather than throwing).

import { toSafeObject, listCapabilities } from "../gateway/index.js";
import {
  UNIT_TEST_WORKFLOW_DESCRIPTOR,
  BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR,
} from "../workflows/index.js";
import {
  listEvidence,
  loadEvidence,
  assertValidRunId,
  EvidenceReadError,
  EvidenceSchemaError,
  type EvidenceListEntry,
} from "../audit/index.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";

// Route 2 — resolved config (SafeGatewayConfig, never apiKey) or null when no config was resolved.
export function handleConfig(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const config = deps.config === undefined ? null : toSafeObject(deps.config);
  return { status: 200, body: { config, configPresent: deps.configPresent } };
}

// Route 3 — the full capability registry. The UI filters `kind === "chat"` for model pickers.
export function handleModels(): RouteResult {
  return { status: 200, body: { models: listCapabilities() } };
}

// Route 4 — launch-form metadata: the workflow descriptors plus the synthesized explain-plan inputs
// (explain-plan is a harness task with no workflow descriptor).
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
      },
    },
  };
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
// (UTC `YYYY-MM-DD`). `workspace`/`model` are not on the list projection (header-only), so they are
// no-op filters here — applied at the detail level by the UI when a manifest is loaded.
function matchesFilters(entry: EvidenceListEntry, filters: EvidenceFilters): boolean {
  if (filters.workflow !== undefined && entry.taskType !== filters.workflow) {
    return false;
  }
  if (filters.outcome !== undefined && entry.outcome !== filters.outcome) {
    return false;
  }
  if (filters.date !== undefined) {
    const day = new Date(entry.startedAt).toISOString().slice(0, 10);
    if (day !== filters.date) {
      return false;
    }
  }
  return true;
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
