/**
 * Pure editor-side target selection for test generation (Issue #1202, ADR-0042 D7).
 *
 * Maps the current editor state (document, optional non-empty selection, optional resolved symbol,
 * optional changed-file set, optional frontend component) to the governed
 * {@link EditorTestGenerationContext} and the content-free {@link EditorTestGenerationRequest} the host
 * forwards to the loopback BFF. No Monaco, no I/O, no model: this is the editor's half of the
 * "workflow request adapter" deliverable — the server resolves the workspace target from these
 * coordinates and reuses the existing unit-test-generation workflow.
 *
 * Target precedence is fixed and total so the derived mode is deterministic: an explicit changed-file
 * set wins, then a frontend component, then a resolved symbol, then a non-empty selection, then the
 * whole file.
 */
import { isEmptyRange } from "./range.js";
import type {
  EditorDocumentIdentity,
  EditorRange,
  EditorRequestIdentity,
  EditorSymbolRef,
  EditorTestGenerationContext,
  EditorTestGenerationRequest,
} from "./types.js";

/** A frontend-component target: a named component and the optional range that scopes it. */
export interface TestGenerationComponentTarget {
  readonly name: string;
  readonly range?: EditorRange | undefined;
}

/** The editor state a test-generation request is derived from. All scope fields are optional. */
export interface TestGenerationTargetInput {
  readonly document: EditorDocumentIdentity;
  /** A non-empty selection range; an empty/collapsed selection is treated as "no selection". */
  readonly selection?: EditorRange | undefined;
  readonly symbol?: EditorSymbolRef | undefined;
  readonly changedFiles?: readonly EditorDocumentIdentity[] | undefined;
  readonly component?: TestGenerationComponentTarget | undefined;
}

/** The discriminator of the derived {@link EditorTestGenerationContext}. */
export type TestGenerationMode = EditorTestGenerationContext["kind"];

function hasChangedSet(input: TestGenerationTargetInput): boolean {
  return input.changedFiles !== undefined && input.changedFiles.length > 0;
}

function hasSelection(input: TestGenerationTargetInput): boolean {
  return input.selection !== undefined && !isEmptyRange(input.selection);
}

/** Resolves the governed target mode from editor state using the fixed precedence. Total. */
export function testGenerationMode(input: TestGenerationTargetInput): TestGenerationMode {
  if (hasChangedSet(input)) {
    return "changed-file-set";
  }
  if (input.component !== undefined) {
    return "frontend-component";
  }
  if (input.symbol !== undefined) {
    return "symbol";
  }
  if (hasSelection(input)) {
    return "selection";
  }
  return "file";
}

function buildComponentContext(
  input: TestGenerationTargetInput,
  component: TestGenerationComponentTarget,
): EditorTestGenerationContext {
  return {
    kind: "frontend-component",
    document: input.document,
    componentName: component.name,
    ...(component.range === undefined ? {} : { range: component.range }),
  };
}

/** Builds the governed {@link EditorTestGenerationContext} for the resolved mode. Total. */
export function buildTestGenerationContext(
  input: TestGenerationTargetInput,
): EditorTestGenerationContext {
  const mode = testGenerationMode(input);
  if (mode === "changed-file-set") {
    return { kind: "changed-file-set", files: input.changedFiles ?? [] };
  }
  if (mode === "frontend-component" && input.component !== undefined) {
    return buildComponentContext(input, input.component);
  }
  if (mode === "symbol" && input.symbol !== undefined) {
    return { kind: "symbol", document: input.document, symbol: input.symbol };
  }
  if (mode === "selection" && input.selection !== undefined) {
    return { kind: "selection", document: input.document, range: input.selection };
  }
  return { kind: "file", document: input.document };
}

/** Arguments for {@link buildTestGenerationRequest}. */
export interface BuildTestGenerationRequestArgs {
  readonly request: EditorRequestIdentity;
  readonly target: TestGenerationTargetInput;
  /** Advisory context budget (bytes); the server clamps it to the `test-generation` purpose budget. */
  readonly contextBudgetBytes: number;
}

/** Assembles the content-free {@link EditorTestGenerationRequest} the host forwards to the BFF. */
export function buildTestGenerationRequest(
  args: BuildTestGenerationRequestArgs,
): EditorTestGenerationRequest {
  return {
    request: args.request,
    context: buildTestGenerationContext(args.target),
    contextBudgetBytes: Math.max(0, Math.trunc(args.contextBudgetBytes)),
  };
}
