import { describe, expect, it } from "vitest";
import { WORKSPACE_MANIFEST_SESSION_ASSERTIONS } from "./workspace-manifest.js";
import { WORKSPACE_SEARCH_MODES } from "./workspace-search.js";
import {
  WORKSPACE_AUTHORITY_REQUIREMENTS,
  WORKSPACE_LIFECYCLE_STATES,
  WORKSPACE_PERSISTENCE_EXPECTATIONS,
  WORKSPACE_TRUST_BOUNDARIES,
} from "./workspace-descriptors.js";
import { WORKSPACE_RESERVED_CHORDS } from "./workspace-ui.js";
import { SELECTION_REASON_PRIORITY, WORKSPACE_LANGUAGES } from "./workspace.js";

// KEIKO-0524 — immutability hardening. Every exported closed-set constant array in the workspace
// territory must be frozen at the module boundary, matching workspace-trust.ts's existing pattern
// (WORKSPACE_TRUST_LEVELS / WORKSPACE_TRUST_REASONS). An unfrozen closed-set export lets any
// aliasing caller mutate the shared array in place and corrupt the closed set for every other
// consumer that imports the same binding.
const FROZEN_TARGETS: readonly (readonly [string, readonly unknown[]])[] = [
  ["WORKSPACE_MANIFEST_SESSION_ASSERTIONS", WORKSPACE_MANIFEST_SESSION_ASSERTIONS],
  ["WORKSPACE_SEARCH_MODES", WORKSPACE_SEARCH_MODES],
  ["WORKSPACE_LIFECYCLE_STATES", WORKSPACE_LIFECYCLE_STATES],
  ["WORKSPACE_TRUST_BOUNDARIES", WORKSPACE_TRUST_BOUNDARIES],
  ["WORKSPACE_AUTHORITY_REQUIREMENTS", WORKSPACE_AUTHORITY_REQUIREMENTS],
  ["WORKSPACE_PERSISTENCE_EXPECTATIONS", WORKSPACE_PERSISTENCE_EXPECTATIONS],
  ["WORKSPACE_RESERVED_CHORDS", WORKSPACE_RESERVED_CHORDS],
  ["WORKSPACE_LANGUAGES", WORKSPACE_LANGUAGES],
  ["SELECTION_REASON_PRIORITY", SELECTION_REASON_PRIORITY],
];

describe("KEIKO-0524 workspace closed-set exports are frozen", () => {
  it.each(FROZEN_TARGETS)("%s is frozen", (_label, target) => {
    expect(Object.isFrozen(target)).toBe(true);
  });
});
