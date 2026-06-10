// Model-only-for-naming port for design-to-code emission (Epic #750, Issue #755).
//
// The deterministic emitter (emissionPlan.ts) already produces a complete, usable plan with
// structural default names and NO model. This module is the strictly-additive seam by which a
// capability-routed model may supply BETTER semantic display names — and nothing else. The override
// is enforced STRUCTURALLY: `applyNaming` only ever replaces an element's `displayName`; it cannot
// add, remove, reorder, or re-parent an element, change a role, change text, or change navigation.
// There is no code path by which a model name reaches structure. An absent provider, an unknown id,
// or an empty/whitespace name leaves the structural default in place — so naming degrades gracefully
// to the deterministic baseline. The provider is injected (a port), so no model id is hard-coded
// here; the server tier resolves the model by capability (#810) and backs this port.

import type { CodeEmissionPlan, EmissionElement, ScreenEmission } from "./emissionPlan.js";

/** A request for semantic names: each element's id, role, and current structural default name. */
export interface SemanticNamingRequest {
  readonly elements: readonly {
    readonly id: string;
    readonly role: EmissionElement["role"];
    readonly structuralName: string;
  }[];
}

/**
 * The naming port: given the structural elements, return a map (or record) from element id to a
 * proposed semantic display name. The server backs this with a capability-routed model; tests back it
 * with a plain function. Returning nothing for an id leaves its structural default untouched.
 */
export type SemanticNamingProvider = (
  request: SemanticNamingRequest,
) => ReadonlyMap<string, string> | Readonly<Record<string, string>>;

function collectRequestElements(
  element: EmissionElement,
  out: SemanticNamingRequest["elements"][number][],
): void {
  out.push({ id: element.id, role: element.role, structuralName: element.displayName });
  for (const child of element.children) collectRequestElements(child, out);
}

function buildRequest(plan: CodeEmissionPlan): SemanticNamingRequest {
  const elements: SemanticNamingRequest["elements"][number][] = [];
  for (const screen of plan.screens) collectRequestElements(screen.root, elements);
  return { elements };
}

// Project the provider result to id/value pairs, accepting either a Map or a plain record.
function namingEntries(
  result: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  if (result instanceof Map) {
    const map: ReadonlyMap<string, string> = result;
    return [...map.entries()];
  }
  return Object.entries(result);
}

// Normalise the provider result to a lookup. A non-string or empty/whitespace value is dropped so a
// garbage model output never overrides a structural default — it simply contributes nothing.
function toNameLookup(
  result: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const lookup = new Map<string, string>();
  for (const [id, value] of namingEntries(result)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) lookup.set(id, trimmed);
  }
  return lookup;
}

function renameElement(
  element: EmissionElement,
  names: ReadonlyMap<string, string>,
): EmissionElement {
  const override = names.get(element.id);
  return {
    ...element,
    ...(override !== undefined ? { displayName: override } : {}),
    children: element.children.map((child) => renameElement(child, names)),
  };
}

function renameScreen(screen: ScreenEmission, names: ReadonlyMap<string, string>): ScreenEmission {
  return { ...screen, root: renameElement(screen.root, names) };
}

/**
 * Apply a semantic-naming provider to a plan, overriding ONLY element display names. The element
 * tree, roles, text, tokens, and navigation are preserved byte-for-byte; only `displayName` fields
 * may change, and only for elements the provider names with a non-empty string. With no usable name
 * for an element (or a missing provider entry), the structural default stands. Deterministic and
 * side-effect-free.
 */
export function applyNaming(
  plan: CodeEmissionPlan,
  provider: SemanticNamingProvider,
): CodeEmissionPlan {
  const names = toNameLookup(provider(buildRequest(plan)));
  if (names.size === 0) return plan;
  return { ...plan, screens: plan.screens.map((screen) => renameScreen(screen, names)) };
}
