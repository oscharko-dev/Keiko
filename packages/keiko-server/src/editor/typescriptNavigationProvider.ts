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
  let visited = 0;
  for (const candidate of candidates) {
    visited += 1;
    const location = locationFromCandidate(project, candidate);
    if (location !== null) locations.push(location);
    if (locations.length >= limit) break;
  }
  return { locations, truncated: project.truncated || visited < candidates.length };
}

export function resolveTypescriptDefinition(
  project: TypescriptProjectHandle,
  position: LanguagePosition,
): LanguageDefinitionResult {
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
  const referencedSymbols = project.service.findReferences(
    project.overlayPath,
    offsetFor(project, position),
  );
  if (referencedSymbols === undefined || referencedSymbols.length === 0) {
    return { locations: [], includesDeclaration: false, truncated: false };
  }
  const candidates = referencedSymbols.flatMap((symbol) => [
    symbol.definition,
    ...symbol.references,
  ]);
  const locations = containedLocations(project, candidates, project.limits.maxReferenceLocations);
  return {
    locations: locations.locations,
    includesDeclaration: referencedSymbols.length > 0,
    truncated: locations.truncated,
  };
}
