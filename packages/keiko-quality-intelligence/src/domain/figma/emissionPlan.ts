// Target-neutral design-to-code emission plan (Epic #750, Issue #755).
//
// Pure domain: a Screen-IR (#752) + deduped design tokens (#752) + framework-agnostic routing hints
// (#811) are reduced — with NO model and NO IO — to a single, target-NEUTRAL emission plan: a
// per-screen element tree (role + structural default name + text + child order preserved), each
// screen's outgoing navigation targets, and the design-token set carried through verbatim for the
// adapter to theme. A concrete `CodeTargetAdapter` renders this plan; the plan itself encodes no
// framework, tag, or router vocabulary, so future adapters (MUI, a component library) plug in WITHOUT
// changing this module.
//
// Generic by construction: the only structural signal read is `interactionHint` (a #752 role hint)
// and the node's own `name`/`text`. No screen name, mask style, or copy is special-cased.
// Deterministic: the plan carries no timestamp and preserves the IR's stable order, so the same
// input yields a byte-identical plan (and thus byte-identical emitted code).
//
// Layout / sizing / cornerRadius / typography fields from the IR are threaded through unchanged so
// that concrete adapters (htmlCssAdapter) can emit visual-fidelity CSS without re-reading the IR.
// They are carried verbatim and never reinterpreted here.

import type {
  DesignTokens,
  IrLayout,
  IrNode,
  IrSizing,
  IrTypography,
  InteractionHint,
  ScreenIr,
} from "./irTypes.js";
import type { RoutingHint } from "./navGraph.js";

/** The target-neutral role of an element — mirrors the IR `interactionHint`; no framework tag. */
export type EmissionRole = InteractionHint;

/** A target-neutral element in a screen's emission tree. `displayName` is a structural default. */
export interface EmissionElement {
  readonly id: string;
  readonly role: EmissionRole;
  /** Semantic display name — a structural default here; the naming port may override it (never structure). */
  readonly displayName: string;
  readonly text?: string;
  /** Auto-layout properties threaded from the IR node; absent when the node has no auto-layout. */
  readonly layout?: IrLayout;
  /** Per-axis sizing mode threaded from the IR node; absent when not set. */
  readonly sizing?: IrSizing;
  /** Corner radius in pixels threaded from the IR node; absent when zero or absent. */
  readonly cornerRadius?: number;
  /** Per-TEXT typography threaded from the IR node; absent for non-TEXT nodes. */
  readonly typography?: IrTypography;
  readonly children: readonly EmissionElement[];
}

/** A resolved outgoing navigation target for a screen, derived from the routing hints (#811). */
export interface EmissionNavTarget {
  readonly trigger: string;
  readonly toScreenId: string;
  readonly toScreenName: string;
}

/** One screen reduced to its emission tree plus its outgoing navigation targets. */
export interface ScreenEmission {
  readonly screenId: string;
  readonly screenName: string;
  readonly root: EmissionElement;
  readonly navTargets: readonly EmissionNavTarget[];
}

/** The full target-neutral emission plan an adapter renders to a concrete code target. */
export interface CodeEmissionPlan {
  readonly screens: readonly ScreenEmission[];
  readonly tokens: DesignTokens;
}

/** The inputs to a code-emission pass: the screens, their tokens, and their routing hints. */
export interface EmissionInput {
  readonly screens: readonly ScreenIr[];
  readonly tokens: DesignTokens;
  readonly hints: readonly RoutingHint[];
}

// A structural default display name: the node's own name when non-empty, else a role-based fallback.
// Never empty, never model-invented — so emission always has a usable name with no model present.
function structuralDisplayName(node: IrNode): string {
  const trimmed = node.name.trim();
  if (trimmed.length > 0) return trimmed;
  const text = node.text?.trim();
  if (text !== undefined && text.length > 0) return text;
  return node.interactionHint;
}

function toElement(node: IrNode): EmissionElement {
  const text = node.text?.trim();
  return {
    id: node.id,
    role: node.interactionHint,
    displayName: structuralDisplayName(node),
    ...(text !== undefined && text.length > 0 ? { text } : {}),
    ...(node.layout !== undefined ? { layout: node.layout } : {}),
    ...(node.sizing !== undefined ? { sizing: node.sizing } : {}),
    ...(node.cornerRadius !== undefined ? { cornerRadius: node.cornerRadius } : {}),
    ...(node.typography !== undefined ? { typography: node.typography } : {}),
    children: node.children.map(toElement),
  };
}

// Resolve a screen's outgoing nav targets from the routing hints, mapping each hint's `toScreenId`
// to a screen name. A hint targeting an unknown screen falls back to the id as its display name.
function navTargetsFor(
  screenId: string,
  hints: readonly RoutingHint[],
  nameByScreenId: ReadonlyMap<string, string>,
): readonly EmissionNavTarget[] {
  const hint = hints.find((h) => h.screenId === screenId);
  if (hint === undefined) return [];
  return hint.transitions.map((transition) => ({
    trigger: transition.trigger,
    toScreenId: transition.toScreenId,
    toScreenName: nameByScreenId.get(transition.toScreenId) ?? transition.toScreenId,
  }));
}

/**
 * Build the target-neutral emission plan from the Screen-IR, design tokens, and routing hints. Pure,
 * deterministic, model-free: preserves the IR's child order, carries the tokens through verbatim, and
 * attaches each screen's resolved outgoing navigation targets. The same input yields a byte-identical
 * plan, so the emitted code is reproducible.
 */
export function buildEmissionPlan(input: EmissionInput): CodeEmissionPlan {
  const nameByScreenId = new Map(input.screens.map((s) => [s.id, s.name]));
  const screens = input.screens.map((screen) => ({
    screenId: screen.id,
    screenName: screen.name,
    root: toElement(screen.root),
    navTargets: navTargetsFor(screen.id, input.hints, nameByScreenId),
  }));
  return { screens, tokens: input.tokens };
}
