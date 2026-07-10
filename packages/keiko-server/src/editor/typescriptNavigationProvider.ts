// TypeScript definition/references resolvers over the project-aware service (Epic #2089,
// Issue #2101). This module maps compiler locations into contained, root-relative wire shapes; it
// does not register the operations with the route/provider dispatch layer.

import type {
  LanguageCallHierarchyIncomingCall,
  LanguageCallHierarchyItem,
  LanguageCallHierarchyOutgoingCall,
  LanguageCallHierarchyResult,
  LanguageDefinitionResult,
  LanguageImplementationResult,
  LanguageLocation,
  LanguagePosition,
  LanguageRange,
  LanguageReferencesResult,
  LanguageSymbolKind,
  LanguageTypeDefinitionResult,
} from "@oscharko-dev/keiko-contracts";
import ts from "typescript";
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

interface HierarchyBudget {
  itemCount: number;
  callSiteCount: number;
  truncated: boolean;
}

const HIERARCHY_KIND_BY_ELEMENT = new Map<string, LanguageSymbolKind>([
  [ts.ScriptElementKind.classElement, "class"],
  [ts.ScriptElementKind.interfaceElement, "interface"],
  [ts.ScriptElementKind.functionElement, "function"],
  [ts.ScriptElementKind.localFunctionElement, "function"],
  [ts.ScriptElementKind.memberFunctionElement, "method"],
  [ts.ScriptElementKind.constructorImplementationElement, "constructor"],
  [ts.ScriptElementKind.moduleElement, "module"],
  [ts.ScriptElementKind.memberVariableElement, "field"],
  [ts.ScriptElementKind.memberGetAccessorElement, "property"],
  [ts.ScriptElementKind.memberSetAccessorElement, "property"],
  [ts.ScriptElementKind.enumElement, "enum"],
  [ts.ScriptElementKind.enumMemberElement, "enumMember"],
  [ts.ScriptElementKind.typeParameterElement, "typeParameter"],
]);

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

export function resolveTypescriptTypeDefinition(
  project: TypescriptProjectHandle,
  position: LanguagePosition,
): LanguageTypeDefinitionResult {
  project.cancellation.throwIfCancellationRequested();
  const results = project.service.getTypeDefinitionAtPosition(
    project.overlayPath,
    offsetFor(project, position),
  );
  return containedLocations(project, results ?? [], project.limits.maxDefinitionLocations);
}

export function resolveTypescriptImplementation(
  project: TypescriptProjectHandle,
  position: LanguagePosition,
): LanguageImplementationResult {
  project.cancellation.throwIfCancellationRequested();
  const results = project.service.getImplementationAtPosition(
    project.overlayPath,
    offsetFor(project, position),
  );
  return containedLocations(project, results ?? [], project.limits.maxDefinitionLocations);
}

function hierarchyItem(
  project: TypescriptProjectHandle,
  item: ts.CallHierarchyItem,
): LanguageCallHierarchyItem | null {
  const path = project.workspaceRelativePath(item.file);
  const text = project.sourceText(item.file);
  if (path === undefined || text === undefined) return null;
  const lineStarts = computeLineStarts(text);
  return {
    name: item.name,
    kind: HIERARCHY_KIND_BY_ELEMENT.get(item.kind) ?? "variable",
    path,
    range: spanToRange(text, lineStarts, item.span.start, item.span.length),
    selectionRange: spanToRange(
      text,
      lineStarts,
      item.selectionSpan.start,
      item.selectionSpan.length,
    ),
    ...(item.containerName === undefined ? {} : { containerName: item.containerName }),
  };
}

function hierarchyRanges(
  project: TypescriptProjectHandle,
  fileName: string,
  spans: readonly ts.TextSpan[],
  budget: HierarchyBudget,
): readonly LanguageRange[] {
  const text = project.sourceText(fileName);
  if (text === undefined) return [];
  const ranges: LanguageRange[] = [];
  const lineStarts = computeLineStarts(text);
  for (const span of spans) {
    if (budget.callSiteCount >= project.limits.maxCallHierarchyCallSites) {
      budget.truncated = true;
      break;
    }
    ranges.push(spanToRange(text, lineStarts, span.start, span.length));
    budget.callSiteCount += 1;
  }
  return ranges;
}

function takeHierarchyItem(
  project: TypescriptProjectHandle,
  item: ts.CallHierarchyItem,
  budget: HierarchyBudget,
): LanguageCallHierarchyItem | null {
  if (budget.itemCount >= project.limits.maxCallHierarchyItems) {
    budget.truncated = true;
    return null;
  }
  const mapped = hierarchyItem(project, item);
  if (mapped !== null) budget.itemCount += 1;
  return mapped;
}

function incomingCalls(
  project: TypescriptProjectHandle,
  root: ts.CallHierarchyItem,
  budget: HierarchyBudget,
): readonly LanguageCallHierarchyIncomingCall[] {
  return project.service
    .provideCallHierarchyIncomingCalls(root.file, root.selectionSpan.start)
    .flatMap((call): readonly LanguageCallHierarchyIncomingCall[] => {
      const item = takeHierarchyItem(project, call.from, budget);
      if (item === null) return [];
      return [
        { item, fromRanges: hierarchyRanges(project, call.from.file, call.fromSpans, budget) },
      ];
    });
}

function outgoingCalls(
  project: TypescriptProjectHandle,
  root: ts.CallHierarchyItem,
  budget: HierarchyBudget,
): readonly LanguageCallHierarchyOutgoingCall[] {
  return project.service
    .provideCallHierarchyOutgoingCalls(root.file, root.selectionSpan.start)
    .flatMap((call): readonly LanguageCallHierarchyOutgoingCall[] => {
      const item = takeHierarchyItem(project, call.to, budget);
      if (item === null) return [];
      return [{ item, fromRanges: hierarchyRanges(project, root.file, call.fromSpans, budget) }];
    });
}

export function resolveTypescriptCallHierarchy(
  project: TypescriptProjectHandle,
  position: LanguagePosition,
): LanguageCallHierarchyResult {
  project.cancellation.throwIfCancellationRequested();
  const prepared = project.service.prepareCallHierarchy(
    project.overlayPath,
    offsetFor(project, position),
  );
  const roots = prepared === undefined ? [] : Array.isArray(prepared) ? prepared : [prepared];
  const budget: HierarchyBudget = { itemCount: 0, callSiteCount: 0, truncated: false };
  const mappedRoots = roots.flatMap((root): LanguageCallHierarchyResult["roots"] => {
    const item = takeHierarchyItem(project, root, budget);
    if (item === null) return [];
    return [
      {
        item,
        incomingCalls: incomingCalls(project, root, budget),
        outgoingCalls: outgoingCalls(project, root, budget),
      },
    ];
  });
  return { roots: mappedRoots, truncated: project.truncated || budget.truncated };
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
