// Public sub-barrel for the deterministic context-budget allocator (ADR-0052 D6). External
// consumers import the allocator surface and the default budget plan through this module.

export type {
  AllocateContextInput,
  AllocateContextResult,
  AllocatedContextLane,
  ContextLaneInput,
  ContextLaneItemInput,
} from "./allocator.js";
export { allocateContext } from "./allocator.js";

export { DEFAULT_CONTEXT_BUDGET } from "./defaults.js";

export type { BuildCompactionInput, CompactionDigest } from "./compaction.js";
export { buildCompactionRecords } from "./compaction.js";

export type { RehydrationResult } from "./rehydration.js";
export { rehydrateProvenanceRef, rehydrateHandle } from "./rehydration.js";
