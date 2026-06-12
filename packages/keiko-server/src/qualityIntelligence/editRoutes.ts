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

// A list field is an array (≤ MAX_LIST_ITEMS) of non-blank strings. `minItems` separates the two
// domain shapes: steps and expected results are the load-bearing body of a test case and must carry
// at least one entry (clearing them produces an empty, meaningless test case → reject); preconditions
// and tags are legitimately optional and may be cleared. Blank ("") items are rejected for every list
// field (a blank step / tag is never meaningful), keeping the persisted body clean.
const isListField = (value: unknown, minItems: 0 | 1): value is readonly string[] =>
  Array.isArray(value) &&
  value.length >= minItems &&
  value.length <= MAX_LIST_ITEMS &&
  value.every((item) => typeof item === "string" && item.length > 0);

const isValidTitle = (value: unknown): boolean =>
  typeof value === "string" && value.length >= 1 && value.length <= MAX_TITLE_LEN;

// Per-field validators keyed by field name. Keeping the branching in a data table (not a switch)
// holds the validator helper's cyclomatic complexity low while still rejecting any malformed value.
const FIELD_VALIDATORS: Readonly<Record<string, (value: unknown) => boolean>> = {
  title: isValidTitle,
  preconditions: (value) => isListField(value, 0),
  steps: (value) => isListField(value, 1),
  expectedResults: (value) => isListField(value, 1),
  priority: (value) => typeof value === "string" && PRIORITIES.has(value),
  riskClass: (value) => typeof value === "string" && RISK_CLASSES.has(value),
  tags: (value) => isListField(value, 0),
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

function parseEditorLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, MAX_LABEL_LEN) : undefined;
}

type CollectOutcome =
  | { readonly ok: true; readonly fields: EditableFields }
  // `invalidField` names the field that failed validation; `undefined` means no field was supplied.
  | { readonly ok: false; readonly invalidField: string | undefined };

function collectEditedFields(edited: Record<string, unknown>): CollectOutcome {
  const collected: Partial<Record<(typeof EDITABLE_KEYS)[number], unknown>> = {};
  let fieldCount = 0;
  for (const key of EDITABLE_KEYS) {
    const value = edited[key];
    if (value === undefined) continue;
    if (!isValidField(key, value)) return { ok: false, invalidField: key };
    collected[key] = value;
    fieldCount += 1;
  }
  return fieldCount > 0
    ? { ok: true, fields: collected as EditableFields }
    : { ok: false, invalidField: undefined };
}

type ParseOutcome =
  | { readonly ok: true; readonly edit: ParsedEdit }
  | { readonly ok: false; readonly message: string };

// Returns the parsed edit, or a field-specific rejection message so the reviewer learns WHICH field
// is invalid (a generic "edit is invalid" is not actionable). Any failing field rejects the whole
// edit (no partial persist).
function parseEdit(body: Record<string, unknown>): ParseOutcome {
  const candidateId = body.candidateId;
  if (typeof candidateId !== "string" || candidateId.trim().length === 0) {
    return { ok: false, message: "A candidate id is required." };
  }
  const editorLabel = parseEditorLabel(body.editorLabel);
  if (editorLabel === undefined) {
    return { ok: false, message: "A non-empty reviewer label is required." };
  }
  const edited = body.edited;
  if (!isObject(edited)) {
    return { ok: false, message: "An `edited` object with the changed fields is required." };
  }
  const collected = collectEditedFields(edited);
  if (!collected.ok) {
    return {
      ok: false,
      message:
        collected.invalidField === undefined
          ? "At least one editable field must be supplied."
          : `The "${collected.invalidField}" field is empty or invalid.`,
    };
  }
  return { ok: true, edit: { candidateId, edited: collected.fields, editorLabel } };
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
  if (!edit.ok) {
    return { ok: false, result: errorResult(400, "QI_BAD_EDIT", edit.message) };
  }
  return { ok: true, edit: edit.edit };
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
    if (result.reason === "no-edited-fields") {
      return errorResult(400, "QI_BAD_EDIT", "At least one editable field must be supplied.");
    }
    if (result.reason === "artifact-not-found") {
      // The run manifest exists but its candidates companion is missing — a distinct, observable
      // failure (corruption / partial state) rather than an unknown candidate id.
      return errorResult(
        404,
        "QI_CANDIDATES_NOT_FOUND",
        "No candidates artifact exists for this run.",
      );
    }
    return errorResult(404, "QI_NOT_FOUND", "Candidate not found for this run.");
  }
  if (result.changed) {
    appendEditAudit({
      runId,
      evidenceDir,
      candidateId: edit.candidateId,
      reviewerLabel: edit.editorLabel,
      now: new Date().toISOString(),
      redact: deps.redactor,
    });
  }
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
