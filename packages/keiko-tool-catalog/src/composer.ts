// ADR-0175 D1: "Concrete descriptors, profiles, compiler and compatibility" have exactly one
// owner -- this pure package. createKeikoToolCatalog composes an explicit list of independently
// owned registration sets (legacy-native, child, and -- once #3408 lands -- editor) into one
// ToolCatalog snapshot, reusing the existing createToolCatalog compiler rather than a second
// assembly path. A registration set never depends on I/O, providers, handlers or server
// composition: it is trusted local source declarations only (ADR-0175 D3).
import type {
  CatalogCompatibility,
  CatalogNativeExtension,
  CatalogRuntimeRef,
  CatalogVersionRef,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createToolCatalog, type CatalogCompilationContext, type ToolCatalog } from "./catalog.js";

export interface CatalogSetEntry {
  readonly alias: string;
  readonly descriptor: ToolDescriptor;
}
/** One profile's worth of registrations. Independently owned; composed, never merged in place. */
export interface CatalogRegistrationSet {
  readonly profile: CatalogVersionRef;
  readonly adapterDialect: CatalogVersionRef;
  readonly adapterRuntime: CatalogRuntimeRef;
  readonly nativeExtensions?: readonly CatalogNativeExtension[] | undefined;
  readonly compatibility?: readonly CatalogCompatibility[] | undefined;
  readonly entries: readonly CatalogSetEntry[];
}

/**
 * Composes explicit registration sets into one snapshot. No hidden default list is consulted:
 * this package (ADR-0175 D1 -- contracts+security only) can compose `legacyNativeRegistrationSet`
 * and `childRegistrationSet`, both local to it, but never a package-wide "everything" default,
 * because the "editor" set (#3408) lives in `keiko-harness` -- it depends on `keiko-tools` for
 * EditorAgentToolHost's own schema source, which this leaf package must never import (ADR-0019).
 * A caller that needs several sets together (e.g. `keiko-harness`'s editor-agent-catalog.ts, or a
 * future OpenCode set) passes its own explicit list; adding an unused zero-arg convenience here
 * would be exactly the speculative generality AGENTS.md §7 asks agents not to add.
 *
 * `context` defaults to the wall clock and no comparison snapshot, matching every current caller
 * (each composes a first, compatibility-free catalog). A caller publishing a version-bump
 * `compatibility` entry against a prior snapshot supplies both explicitly: `catalog.ts`'s
 * `assertCompatibilityEntries` resolves a `from` endpoint against `context.previous?.descriptors`,
 * and `assertCompatibilityTime` measures the entry's remaining lifetime against
 * `context.referenceTimeMs` -- a hardcoded epoch-zero clock would put every real `expiresAt` far
 * outside `TOOL_CATALOG_LIMITS.maxCompatibilityLifetimeMs`, so a stale default would silently
 * defeat the parameter as completely as an omitted `previous` does.
 */
export function createKeikoToolCatalog(
  sets: readonly CatalogRegistrationSet[],
  compatibility: readonly CatalogCompatibility[] = [],
  context?: CatalogCompilationContext,
): ToolCatalog {
  const descriptors = sets.flatMap((set) => set.entries.map((entry) => entry.descriptor));
  const profiles = sets.map((set) => ({
    profile: set.profile,
    toolRefs: set.entries.map((entry) => ({
      toolRef: entry.descriptor.toolRef,
      alias: entry.alias,
    })),
    nativeExtensions: set.nativeExtensions ?? [],
    adapterDialect: set.adapterDialect,
    adapterRuntime: set.adapterRuntime,
    compatibility: set.compatibility ?? [],
  }));
  return createToolCatalog(
    { descriptors, profiles, compatibility },
    context ?? { referenceTimeMs: Date.now() },
  );
}
