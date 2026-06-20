// Default candidate producer for editor-driven test generation (Issue #1202, ADR-0042 D7).
//
// Reuses the existing `unit-test-generation` workflow (`@oscharko-dev/keiko-workflows`) in DRY-RUN
// (apply=false; the workflow fail-closes any patch write) to produce a reviewable candidate test patch,
// then translates its proposed unified diff into the content-free wire patch. This is the WAVE-2
// enablement seam: it is reached only when Gate B (KEIKO_EDITOR_TEST_GENERATION_EXECUTION) is set, which
// only an enforced deny-by-default egress boundary justifies. When the route produces a candidate, it
// immediately sends that candidate through the assured pre-filter before deciding whether the patch is
// apply-ready (`assured`) or untrusted evidence (`unverified`); the seam is proven by tests.
//
// Dry-run generation is a governed model call that produces a diff — it does NOT execute the generated
// tests (the workflow runs verification only in apply mode). The route owns the subsequent assured
// pre-filter execution step, so this runner only reports that one candidate was generated.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { generateUnitTests, type UnitTestTarget } from "@oscharko-dev/keiko-workflows";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  notRunTestGenerationFunnel,
  type CodingContextPack,
  type EditorTestGenerationFunnel,
  type EditorTestGenerationWirePatch,
  type EditorTestGenerationWireProvenance,
  type EditorTestGenerationWireRequest,
  type EditorTestGenerationWireTarget,
} from "@oscharko-dev/keiko-contracts";
import { currentGatewayConfig, type UiHandlerDeps } from "../deps.js";
import { translateDiffToWirePatch, type OriginalContentReader } from "./testGenerationPatch.js";

const GATEWAY_POLICY_VERSION = "editor-test-generation/1";
const PATCH_ID_LENGTH = 32;

export interface TestGenerationRunnerArgs {
  readonly request: EditorTestGenerationWireRequest;
  readonly deps: UiHandlerDeps;
  readonly realRoot: string;
  readonly signal: AbortSignal;
  readonly nowMs: number;
  // Governed discovery context (#1211). The existing workflow assembles its own ContextPack today, so
  // this runner does not read the route-level pack directly.
  readonly contextPack: CodingContextPack;
}

export interface TestGenerationRunResult {
  readonly patch: EditorTestGenerationWirePatch;
  readonly provenance: EditorTestGenerationWireProvenance;
  readonly funnel: EditorTestGenerationFunnel;
}

/** Injectable candidate producer. Returns undefined when no candidate could be produced (→ deferred). */
export type TestGenerationRunner = (
  args: TestGenerationRunnerArgs,
) => Promise<TestGenerationRunResult | undefined>;

function anchorPath(target: EditorTestGenerationWireTarget): string {
  if (target.kind === "changed-file-set") {
    // The parser guarantees a non-empty document set; `?? ""` only satisfies the index check.
    return target.documents[0]?.path ?? "";
  }
  return target.document.path;
}

// Maps the governed editor target to the workflow's UnitTestTarget. The workflow supports file (with an
// optional target function), module, and changed-file targets; a selection maps to its file, a symbol /
// component maps to a file target function.
function toUnitTestTarget(target: EditorTestGenerationWireTarget): UnitTestTarget {
  if (target.kind === "changed-file-set") {
    return { kind: "changedFiles", filePaths: target.documents.map((document) => document.path) };
  }
  if (target.kind === "symbol") {
    return { kind: "file", filePath: target.document.path, targetFunction: target.symbol.name };
  }
  if (target.kind === "frontend-component") {
    return { kind: "file", filePath: target.document.path, targetFunction: target.componentName };
  }
  return { kind: "file", filePath: target.document.path };
}

function resolveModelId(deps: UiHandlerDeps): string | undefined {
  return currentGatewayConfig(deps)?.providers[0]?.modelId;
}

// A content-free, deterministic SHA-256 over length-prefixed parts (ids/paths only, never content).
// Length-prefixing makes the encoding unambiguous, so distinct part lists can never collide.
function contentFreeHash(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(`${part.length.toString()}:${part}`);
  }
  return hash.digest("hex");
}

function originalReader(realRoot: string): OriginalContentReader {
  return (relativePath) => {
    const absolute = resolve(realRoot, relativePath);
    try {
      return nodeWorkspaceFs.exists(absolute) ? nodeWorkspaceFs.readFileUtf8(absolute) : undefined;
    } catch {
      return undefined;
    }
  };
}

// One generated candidate produced this round; the assured pre-filter (#1204/#1206) is `not-run`.
function generatedFunnel(): EditorTestGenerationFunnel {
  return { ...notRunTestGenerationFunnel(), candidatesGenerated: 1, candidatesSurfaced: 1 };
}

export const defaultTestGenerationRunner: TestGenerationRunner = async (args) => {
  const modelId = resolveModelId(args.deps);
  if (modelId === undefined) {
    return undefined;
  }
  const model = args.deps.modelPortFactory(modelId);
  if (model === undefined) {
    return undefined;
  }
  const report = await generateUnitTests(
    {
      workspaceRoot: args.realRoot,
      target: toUnitTestTarget(args.request.target),
      apply: false,
      modelId,
    },
    { model, signal: args.signal },
  );
  if (report.proposedDiff === undefined) {
    return undefined;
  }
  const anchor = anchorPath(args.request.target);
  const patchId = contentFreeHash([modelId, anchor, String(args.nowMs)]).slice(0, PATCH_ID_LENGTH);
  const patch = translateDiffToWirePatch(
    report.proposedDiff,
    patchId,
    originalReader(args.realRoot),
  );
  if (patch === undefined) {
    return undefined;
  }
  return {
    patch,
    provenance: {
      modelId,
      gatewayPolicyVersion: GATEWAY_POLICY_VERSION,
      promptHash: contentFreeHash([modelId, anchor]),
      producedAt: args.nowMs,
    },
    funnel: generatedFunnel(),
  };
};
