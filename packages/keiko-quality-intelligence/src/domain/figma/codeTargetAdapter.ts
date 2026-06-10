// The pluggable CodeTargetAdapter seam for design-to-code emission (Epic #750, Issue #755).
//
// All code emission goes through a single seam: the workflow builds a target-NEUTRAL emission plan
// (emissionPlan.ts) from the Screen-IR + tokens + routing hints, optionally enriches element names
// via the injected naming port (semanticNaming.ts), and hands the plan to a `CodeTargetAdapter` which
// renders it to a concrete `CodeArtifact`. The first slice ships exactly one adapter (the
// framework-agnostic HTML/CSS adapter). A future MUI / component-library adapter is purely additive:
// it implements this same interface and is selected at the call site — the emitter, plan, and naming
// port do not change. No framework is hard-coded into the emitter.
//
// The artifact is a REVIEWABLE proposal (an ordered list of files), never auto-applied: this module
// has no filesystem, network, or model access — the model only reaches naming, through the injected
// provider. Deterministic: a given input + adapter yields a byte-identical artifact.

import { applyNaming, type SemanticNamingProvider } from "./semanticNaming.js";
import { buildEmissionPlan, type CodeEmissionPlan, type EmissionInput } from "./emissionPlan.js";

/** A single proposed file in the reviewable code artifact. Path is artifact-relative, POSIX-style. */
export interface CodeFile {
  readonly path: string;
  readonly contents: string;
}

/** The reviewable output of a code-emission pass: the producing adapter plus its ordered files. */
export interface CodeArtifact {
  readonly adapterName: string;
  readonly files: readonly CodeFile[];
}

/**
 * The pluggable code-target seam. An adapter is a pure function from the target-neutral plan to a
 * concrete code artifact. `name` records which target produced an artifact. Additive: future targets
 * implement this interface without changing the emitter.
 */
export interface CodeTargetAdapter {
  readonly name: string;
  readonly emit: (plan: CodeEmissionPlan) => CodeArtifact;
}

/**
 * Emit reviewable code for a set of screens through the selected adapter. Builds the deterministic,
 * target-neutral plan, applies the optional semantic-naming port (which may rename elements but never
 * change structure), and renders through the adapter. With no naming provider the structural default
 * names are used, so emission is fully deterministic and model-independent. The result is a proposal,
 * not an applied change.
 */
export function emitCode(
  input: EmissionInput,
  adapter: CodeTargetAdapter,
  naming?: SemanticNamingProvider,
): CodeArtifact {
  const base = buildEmissionPlan(input);
  const plan = naming !== undefined ? applyNaming(base, naming) : base;
  return adapter.emit(plan);
}
