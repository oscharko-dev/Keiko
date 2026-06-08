// Quality Intelligence inline-edit BFF route (Epic #712, Issue #726).
//
//   * POST /api/quality-intelligence/runs/:id/edit — edit a generated candidate's fields inline
//
// Updates the candidate row in place inside the MUTABLE candidates artifact (redacted, with
// provenance appended to `editedRevisions[]`) and records an `edit` audit entry. The IMMUTABLE run
// manifest (`<runId>.qi.json`) is never touched. CSRF is enforced by the dispatch layer for POST
// (mirrors reviewRoutes); the body is capped at 16KB and every field is validated before persist.

import type { IncomingMessage } from "node:http";
import {
  applyQualityIntelligenceCandidateEdit,
  loadQualityIntelligenceRun,
  type QualityIntelligenceCandidateRow,
} from "@oscharko-dev/keiko-evidence";
import {
  QualityIntelligence,
  type QualityIntelligenceUiCandidate,
} from "@oscharko-dev/keiko-contracts";
import type { RouteContext, RouteResult, RouteDefinition } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { appendEditAudit, candidateReviewStateOf, loadRunReviewState } from "./reviewStore.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TITLE_LEN = 256;
const MAX_LIST_ITEMS = 100;
const MAX_LABEL_LEN = 80;

type EditableFields = QualityIntelligence.QualityIntelligenceCandidateEditableFields;

const PRIORITIES: ReadonlySet<string> = new Set(
  QualityIntelligence.QUALITY_INTELLIGENCE_PRIORITIES,
);
const RISK_CLASSES: ReadonlySet<string> = new Set(
  QualityIntelligence.QUALITY_INTELLIGENCE_RISK_CLASSES,
);

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

const errorResult = (status: number, code: string, message: string): RouteResult => ({
  status,
  body: { error: { code, message } },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= MAX_LIST_ITEMS &&
  value.every((item) => typeof item === "string" && item.length > 0);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= MAX_LIST_ITEMS &&
  value.every((item) => typeof item === "string");

const isValidTitle = (value: unknown): boolean =>
  typeof value === "string" && value.length >= 1 && value.length <= MAX_TITLE_LEN;

// Per-field validators keyed by field name. Keeping the branching in a data table (not a switch)
// holds the validator helper's cyclomatic complexity low while still rejecting any malformed value.
const FIELD_VALIDATORS: Readonly<Record<string, (value: unknown) => boolean>> = {
  title: isValidTitle,
  preconditions: isNonEmptyStringArray,
  steps: isNonEmptyStringArray,
  expectedResults: isNonEmptyStringArray,
  priority: (value) => typeof value === "string" && PRIORITIES.has(value),
  riskClass: (value) => typeof value === "string" && RISK_CLASSES.has(value),
  tags: isStringArray,
};

// Validate one editable field. Returns `false` for a malformed value so the caller rejects the whole
// edit (no partial persist). Unknown keys are ignored by the caller (only EDITABLE_KEYS are read).
function isValidField(key: string, value: unknown): boolean {
  return FIELD_VALIDATORS[key]?.(value) ?? false;
}

const EDITABLE_KEYS = [
  "title",
  "preconditions",
  "steps",
  "expectedResults",
  "priority",
  "riskClass",
  "tags",
] as const;

interface ParsedEdit {
  readonly candidateId: string;
  readonly edited: EditableFields;
  readonly editorLabel: string;
}

// Returns the parsed edit, or undefined when the request is malformed (bad candidateId, no known
// fields, or any field that fails its per-field validation → reject the whole edit, no partial work).
function parseEdit(body: Record<string, unknown>): ParsedEdit | undefined {
  const candidateId = body.candidateId;
  if (typeof candidateId !== "string" || candidateId.trim().length === 0) return undefined;
  const edited = body.edited;
  if (!isObject(edited)) return undefined;
  const collected: Record<string, unknown> = {};
  for (const key of EDITABLE_KEYS) {
    const value = edited[key];
    if (value === undefined) continue;
    if (!isValidField(key, value)) return undefined;
    collected[key] = value;
  }
  if (Object.keys(collected).length === 0) return undefined;
  const editorLabel =
    typeof body.editorLabel === "string" && body.editorLabel.trim().length > 0
      ? body.editorLabel.trim().slice(0, MAX_LABEL_LEN)
      : "editor";
  return { candidateId, edited: collected, editorLabel };
}

type ReadOutcome =
  | { readonly ok: true; readonly edit: ParsedEdit }
  | { readonly ok: false; readonly result: RouteResult };

async function readEdit(req: IncomingMessage): Promise<ReadOutcome> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return { ok: false, result: errorResult(413, "QI_BODY_TOO_LARGE", "Edit body is too large.") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "Edit body is not valid JSON."),
    };
  }
  if (!isObject(parsed)) {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "Edit body must be an object."),
    };
  }
  const edit = parseEdit(parsed);
  if (edit === undefined) {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_EDIT", "A valid candidate edit is required."),
    };
  }
  return { ok: true, edit };
}

function projectCandidate(
  row: QualityIntelligenceCandidateRow,
  evidenceDir: string,
  runId: string,
): QualityIntelligenceUiCandidate {
  const reviewArtifact = loadRunReviewState(runId, evidenceDir);
  return {
    id: row.id,
    title: row.title,
    preconditions: row.preconditions,
    steps: row.steps,
    expectedResults: row.expectedResults,
    priority: row.priority,
    riskClass: row.riskClass,
    tags: row.tags,
    status: row.status,
    reviewState: candidateReviewStateOf(reviewArtifact, row.id),
    derivedFromAtomIds: row.derivedFromAtomIds,
  };
}

// Apply a validated edit (redacted, in-place), append the audit entry, and project the updated
// candidate for the wire. Split out of the handler to keep the handler within the line budget.
function recordEdit(
  runId: string,
  edit: ParsedEdit,
  evidenceDir: string,
  deps: UiHandlerDeps,
): RouteResult {
  const result = applyQualityIntelligenceCandidateEdit({
    runId,
    candidateId: edit.candidateId,
    editedFields: edit.edited,
    provenance: {
      editedAt: new Date().toISOString(),
      editedBy: "human",
      editorLabel: edit.editorLabel,
    },
    evidenceDir,
    redact: deps.redactor,
  });
  if (!result.ok) {
    return result.reason === "no-edited-fields"
      ? errorResult(400, "QI_BAD_EDIT", "A valid candidate edit is required.")
      : errorResult(404, "QI_NOT_FOUND", "Candidate not found for this run.");
  }
  appendEditAudit({
    runId,
    evidenceDir,
    candidateId: edit.candidateId,
    reviewerLabel: edit.editorLabel,
    now: new Date().toISOString(),
  });
  return {
    status: 200,
    body: { candidate: projectCandidate(result.candidate, evidenceDir, runId) },
  };
}

export async function handleQiEditCandidate(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const { id } = ctx.params;
  if (id === undefined || id.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "Run id is required.");
  }
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined) {
    return errorResult(500, "QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }
  const parsed = await readEdit(ctx.req);
  if (!parsed.ok) return parsed.result;
  try {
    if (loadQualityIntelligenceRun(id, { evidenceDir }) === undefined) {
      return errorResult(404, "QI_RUN_NOT_FOUND", "Quality Intelligence run not found.");
    }
    return recordEdit(id, parsed.edit, evidenceDir, deps);
  } catch {
    return errorResult(500, "QI_EDIT_FAILED", "Failed to record the candidate edit.");
  }
}

export const QI_EDIT_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/quality-intelligence/runs/:id/edit",
    handler: handleQiEditCandidate,
  },
];
