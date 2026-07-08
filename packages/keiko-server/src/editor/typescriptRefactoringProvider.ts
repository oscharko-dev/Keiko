// TypeScript rename/code-action/signature-help resolvers over the project-aware service
// (Epic #2089, Issue #2102). This module computes bounded, reviewable results only; it never
// mutates an editor buffer or writes to disk.

import { sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  LanguageCodeAction,
  LanguageCodeActionKind,
  LanguageCodeActionsResult,
  LanguagePosition,
  LanguageRange,
  LanguageRenameApplyResult,
  LanguageRenamePrepareResult,
  LanguageServiceErrorCode,
  LanguageSignatureHelpResult,
  LanguageSignatureInformation,
  LanguageSignatureParameterInformation,
  LanguageTextEdit,
} from "@oscharko-dev/keiko-contracts";
import { LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import ts from "typescript";
import { computeLineStarts, positionToOffset, spanToRange } from "./textOffsets.js";
import type { TypescriptProjectHandle } from "./typescriptProjectService.js";

export interface TypescriptRefactoringError {
  readonly kind: "error";
  readonly code: LanguageServiceErrorCode;
  readonly message: string;
}

export type TypescriptRenameApplyResolution =
  | { readonly kind: "result"; readonly result: LanguageRenameApplyResult }
  | TypescriptRefactoringError;

interface RenameEditCandidate {
  readonly path: string;
  readonly fileName: string;
  readonly text: string;
  readonly edit: LanguageTextEdit;
}

interface CodeActionCandidate {
  readonly title: string;
  readonly kind: LanguageCodeActionKind;
  readonly changes: readonly ts.FileTextChanges[];
}

const USER_PREFERENCES: ts.UserPreferences = {
  allowRenameOfImportPath: false,
  includePackageJsonAutoImports: "off",
  providePrefixAndSuffixTextForRename: true,
  provideRefactorNotApplicableReason: false,
};

function offsetFor(project: TypescriptProjectHandle, position: LanguagePosition): number {
  return positionToOffset(project.overlayText, computeLineStarts(project.overlayText), position);
}

function rangeOffsets(text: string, range: LanguageRange): ts.TextRange {
  const lineStarts = computeLineStarts(text);
  const start = positionToOffset(text, lineStarts, range.start);
  const end = positionToOffset(text, lineStarts, range.end);
  return { pos: start, end };
}

function textEditFor(text: string, change: ts.TextChange): LanguageTextEdit {
  return {
    range: spanToRange(text, computeLineStarts(text), change.span.start, change.span.length),
    newText: change.newText,
  };
}

function error(code: LanguageServiceErrorCode, message: string): TypescriptRefactoringError {
  return { kind: "error", code, message };
}

export function resolveTypescriptRenamePrepare(
  project: TypescriptProjectHandle,
  position: LanguagePosition,
): LanguageRenamePrepareResult {
  project.cancellation.throwIfCancellationRequested();
  const info = project.service.getRenameInfo(project.overlayPath, offsetFor(project, position), {
    allowRenameOfImportPath: false,
  });
  if (!info.canRename || info.fileToRename !== undefined) {
    return {
      range: null,
      reason: info.canRename ? "File rename is not supported." : info.localizedErrorMessage,
    };
  }
  return {
    range: spanToRange(
      project.overlayText,
      computeLineStarts(project.overlayText),
      info.triggerSpan.start,
      info.triggerSpan.length,
    ),
    placeholder: info.displayName,
  };
}

function renameCandidates(
  project: TypescriptProjectHandle,
  locations: readonly ts.RenameLocation[],
  newName: string,
): readonly RenameEditCandidate[] {
  return locations.flatMap((location): readonly RenameEditCandidate[] => {
    const path = project.workspaceRelativePath(location.fileName);
    const text = project.sourceText(location.fileName);
    if (path === undefined || text === undefined) return [];
    return [
      {
        path,
        fileName: location.fileName,
        text,
        edit: {
          range: spanToRange(
            text,
            computeLineStarts(text),
            location.textSpan.start,
            location.textSpan.length,
          ),
          newText: `${location.prefixText ?? ""}${newName}${location.suffixText ?? ""}`,
        },
      },
    ];
  });
}

function groupRenameCandidates(
  candidates: readonly RenameEditCandidate[],
  project: TypescriptProjectHandle,
): LanguageRenameApplyResult {
  const maxFiles = project.limits.maxRenameChangesetFiles;
  const maxEdits = project.limits.maxRenameChangesetEdits;
  const byPath = new Map<string, { readonly text: string; readonly edits: LanguageTextEdit[] }>();
  let returnedEditCount = 0;
  for (const candidate of candidates) {
    const existing = byPath.get(candidate.path);
    const canOpenFile = existing !== undefined || byPath.size < maxFiles;
    if (!canOpenFile || returnedEditCount >= maxEdits) continue;
    const group = existing ?? { text: candidate.text, edits: [] };
    group.edits.push(candidate.edit);
    byPath.set(candidate.path, group);
    returnedEditCount += 1;
  }
  const totalFileCount = new Set(candidates.map((candidate) => candidate.path)).size;
  return {
    schemaVersion: LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION,
    files: [...byPath.entries()].map(([path, group]) => ({
      path,
      edits: group.edits,
      expectedContentHash: sha256Hex(group.text),
    })),
    truncated: project.truncated || returnedEditCount < candidates.length,
    filesTruncated: byPath.size < totalFileCount,
    returnedFileCount: byPath.size,
    totalFileCount,
    returnedEditCount,
    totalEditCount: candidates.length,
  };
}

export function resolveTypescriptRenameApply(
  project: TypescriptProjectHandle,
  position: LanguagePosition,
  newName: string,
): TypescriptRenameApplyResolution {
  project.cancellation.throwIfCancellationRequested();
  const offset = offsetFor(project, position);
  const info = project.service.getRenameInfo(project.overlayPath, offset, {
    allowRenameOfImportPath: false,
  });
  if (!info.canRename || info.fileToRename !== undefined || newName.length === 0) {
    return error("INVALID_REQUEST", "No renameable symbol is available at this position.");
  }
  const locations = project.service.findRenameLocations(
    project.overlayPath,
    offset,
    false,
    false,
    USER_PREFERENCES,
  );
  if (locations === undefined || locations.length === 0) {
    return error("INVALID_REQUEST", "No renameable symbol is available at this position.");
  }
  return {
    kind: "result",
    result: groupRenameCandidates(renameCandidates(project, locations, newName), project),
  };
}

function diagnosticCodes(diagnostics: readonly { readonly code?: string }[]): readonly number[] {
  return diagnostics
    .map((diagnostic) => Number(diagnostic.code))
    .filter((code): code is number => Number.isInteger(code));
}

interface RefactorActionRef {
  readonly refactorName: string;
  readonly action: ts.RefactorActionInfo;
}

// Enumerate applicable refactor actions WITHOUT computing their edits, so the caller can bound how
// many of the expensive `getEditsForRefactor` calls it makes to the result cap (Issue #2102: apply
// caps before building the full result set, so a position with many refactors cannot exhaust the
// request budget).
function applicableRefactorActions(
  project: TypescriptProjectHandle,
  offsets: ts.TextRange,
): readonly RefactorActionRef[] {
  return project.service
    .getApplicableRefactors(
      project.overlayPath,
      offsets,
      USER_PREFERENCES,
      "invoked",
      undefined,
      false,
    )
    .flatMap((refactor): readonly RefactorActionRef[] =>
      refactor.actions
        .filter(
          (action) => action.notApplicableReason === undefined && action.isInteractive !== true,
        )
        .map((action) => ({ refactorName: refactor.name, action })),
    );
}

function refactorCandidate(
  project: TypescriptProjectHandle,
  offsets: ts.TextRange,
  ref: RefactorActionRef,
): CodeActionCandidate | null {
  const edits = project.service.getEditsForRefactor(
    project.overlayPath,
    ts.getDefaultFormatCodeSettings("\n"),
    offsets,
    ref.refactorName,
    ref.action.name,
    USER_PREFERENCES,
  );
  if (edits === undefined || edits.notApplicableReason !== undefined) return null;
  return { title: ref.action.description, kind: "refactor", changes: edits.edits };
}

function codeActionEdits(
  project: TypescriptProjectHandle,
  changes: readonly ts.FileTextChanges[],
): readonly LanguageTextEdit[] | null {
  const overlayPath = project.workspaceRelativePath(project.overlayPath);
  const edits: LanguageTextEdit[] = [];
  for (const change of changes) {
    const path = project.workspaceRelativePath(change.fileName);
    const text = project.sourceText(change.fileName);
    if (path === undefined || text === undefined) continue;
    if (path !== overlayPath || change.isNewFile === true) return null;
    edits.push(...change.textChanges.map((textChange) => textEditFor(text, textChange)));
  }
  return edits.length > 0 ? edits : [];
}

function buildCodeAction(
  project: TypescriptProjectHandle,
  candidate: CodeActionCandidate,
): LanguageCodeAction | null {
  const edits = codeActionEdits(project, candidate.changes);
  if (edits !== null && edits.length === 0) return null;
  return { title: candidate.title, kind: candidate.kind, edits };
}

export function resolveTypescriptCodeActions(
  project: TypescriptProjectHandle,
  range: LanguageRange,
  diagnostics: readonly { readonly code?: string }[],
): LanguageCodeActionsResult {
  project.cancellation.throwIfCancellationRequested();
  const limit = project.limits.maxCodeActions;
  const offsets = rangeOffsets(project.overlayText, range);
  const fixes = project.service.getCodeFixesAtPosition(
    project.overlayPath,
    offsets.pos,
    offsets.end,
    diagnosticCodes(diagnostics),
    ts.getDefaultFormatCodeSettings("\n"),
    USER_PREFERENCES,
  );
  const refactorRefs = applicableRefactorActions(project, offsets);
  const totalCount = fixes.length + refactorRefs.length;
  // Materialise candidates only up to the cap, quick fixes first, computing refactor edits lazily
  // so the expensive `getEditsForRefactor` runs at most `limit` times regardless of how many
  // refactors apply at this position.
  const candidates: CodeActionCandidate[] = [];
  for (const fix of fixes) {
    if (candidates.length >= limit) break;
    candidates.push({ title: fix.description, kind: "quickfix", changes: fix.changes });
  }
  for (const ref of refactorRefs) {
    if (candidates.length >= limit) break;
    const candidate = refactorCandidate(project, offsets, ref);
    if (candidate !== null) candidates.push(candidate);
  }
  const actions = candidates.flatMap((candidate): readonly LanguageCodeAction[] => {
    const action = buildCodeAction(project, candidate);
    return action === null ? [] : [action];
  });
  return {
    actions,
    truncated: project.truncated || totalCount > limit,
    returnedCount: actions.length,
    totalCount,
  };
}

function display(parts: readonly ts.SymbolDisplayPart[] | undefined): string {
  return parts?.map((part) => part.text).join("") ?? "";
}

function signatureLabel(item: ts.SignatureHelpItem): string {
  const separator = display(item.separatorDisplayParts);
  const parameters = item.parameters.map((parameter) => display(parameter.displayParts));
  return `${display(item.prefixDisplayParts)}${parameters.join(separator)}${display(item.suffixDisplayParts)}`;
}

function signatureParameter(
  parameter: ts.SignatureHelpParameter,
): LanguageSignatureParameterInformation {
  const label = display(parameter.displayParts);
  return { label: label.length > 0 ? label : parameter.name };
}

function signatureInfo(item: ts.SignatureHelpItem): LanguageSignatureInformation {
  const documentation = display(item.documentation);
  return {
    label: signatureLabel(item),
    ...(documentation.length > 0 ? { documentation } : {}),
    parameters: item.parameters.map(signatureParameter),
  };
}

export function resolveTypescriptSignatureHelp(
  project: TypescriptProjectHandle,
  position: LanguagePosition,
): LanguageSignatureHelpResult {
  project.cancellation.throwIfCancellationRequested();
  const help = project.service.getSignatureHelpItems(
    project.overlayPath,
    offsetFor(project, position),
    undefined,
  );
  if (help === undefined || help.items.length === 0) {
    return {
      signatures: [],
      activeSignature: null,
      activeParameter: null,
      truncated: false,
      returnedCount: 0,
      totalCount: 0,
    };
  }
  const capped = help.items.slice(0, project.limits.maxSignatures);
  return {
    signatures: capped.map(signatureInfo),
    activeSignature: help.selectedItemIndex < capped.length ? help.selectedItemIndex : null,
    activeParameter: help.argumentIndex,
    truncated: project.truncated || help.items.length > capped.length,
    returnedCount: capped.length,
    totalCount: help.items.length,
  };
}
