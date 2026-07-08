// TypeScript definition/references resolvers over the project-aware service (Epic #2089,
// Issue #2101). This module maps compiler locations into contained, root-relative wire shapes; it
// does not register the operations with the route/provider dispatch layer.

import type {
  LanguageDefinitionResult,
  LanguageLocation,
  LanguagePosition,
  LanguageReferencesResult,
} from "@oscharko-dev/keiko-contracts";
import type ts from "typescript";
import { computeLineStarts, positionToOffset, spanToRange } from "./textOffsets.js";
import type { TypescriptProjectHandle } from "./typescriptProjectService.js";

interface LocationCandidate {
  readonly fileName: string;
  readonly textSpan: ts.TextSpan;
}

interface ReferenceCandidate {
  readonly candidate: LocationCandidate;
  readonly isDeclaration: boolean;
}

function offsetFor(project: TypescriptProjectHandle, position: LanguagePosition): number {
  return positionToOffset(project.overlayText, computeLineStarts(project.overlayText), position);
}

function locationFromCandidate(
  project: TypescriptProjectHandle,
  candidate: LocationCandidate,
): LanguageLocation | null {
  const path = project.workspaceRelativePath(candidate.fileName);
  if (path === undefined) return null;
  const text = project.sourceText(candidate.fileName);
  if (text === undefined) return null;
  return {
    path,
    range: spanToRange(
      text,
      computeLineStarts(text),
      candidate.textSpan.start,
      candidate.textSpan.length,
    ),
  };
}

function containedLocations(
  project: TypescriptProjectHandle,
  candidates: readonly LocationCandidate[],
  limit: number,
): { readonly locations: readonly LanguageLocation[]; readonly truncated: boolean } {
  const locations: LanguageLocation[] = [];
  let capped = false;
  for (const candidate of candidates) {
    if (locations.length >= limit) {
      capped = true;
      break;
    }
    const location = locationFromCandidate(project, candidate);
    if (location !== null) locations.push(location);
  }
  return { locations, truncated: project.truncated || capped };
}

export function resolveTypescriptDefinition(
  project: TypescriptProjectHandle,
  position: LanguagePosition,
): LanguageDefinitionResult {
  project.cancellation.throwIfCancellationRequested();
  const results = project.service.getDefinitionAtPosition(
    project.overlayPath,
    offsetFor(project, position),
  );
  if (results === undefined || results.length === 0) {
    return { locations: [], truncated: false };
  }
  return containedLocations(project, results, project.limits.maxDefinitionLocations);
}

export function resolveTypescriptReferences(
  project: TypescriptProjectHandle,
  position: LanguagePosition,
): LanguageReferencesResult {
  project.cancellation.throwIfCancellationRequested();
  const referencedSymbols = project.service.findReferences(
    project.overlayPath,
    offsetFor(project, position),
  );
  if (referencedSymbols === undefined || referencedSymbols.length === 0) {
    return { locations: [], includesDeclaration: false, truncated: false };
  }
  const items: readonly ReferenceCandidate[] = referencedSymbols.flatMap(
    (symbol): readonly ReferenceCandidate[] => [
      { candidate: symbol.definition, isDeclaration: true },
      ...symbol.references.map((reference): ReferenceCandidate => ({
        candidate: reference,
        isDeclaration: false,
      })),
    ],
  );
  const locations: LanguageLocation[] = [];
  let includesDeclaration = false;
  let capped = false;
  for (const item of items) {
    if (locations.length >= project.limits.maxReferenceLocations) {
      capped = true;
      break;
    }
    const location = locationFromCandidate(project, item.candidate);
    if (location === null) continue;
    locations.push(location);
    // Only report the declaration as included if the declaration location actually survived
    // workspace-containment filtering and the result cap into the returned set (Issue #2101):
    // a reference query whose declaration lives outside the workspace (e.g. a lib .d.ts) must not
    // claim `includesDeclaration: true`.
    if (item.isDeclaration) includesDeclaration = true;
  }
  return { locations, includesDeclaration, truncated: project.truncated || capped };
}
