// Public sub-barrel for the ephemeral micro-index and connected-context pack assembler
// (Epic #177, Issue #183). External consumers import every contextpack symbol through
// this module; internal modules (compaction.ts, reranker.ts, microIndex.ts, assemble.ts)
// remain implementation detail.

export type {
  BudgetCheckpoint,
  BudgetCheckpointResult,
  CompactionInput,
  CompactionResult,
} from "./compaction.js";
export { compactExcerpt, nextAtomFitsBudget } from "./compaction.js";

export type { RerankerAvailability, RerankerSeam } from "./reranker.js";
export { disabledReranker } from "./reranker.js";

export type { IndexEntry, IndexKeyInput, MicroIndex, MicroIndexOptions } from "./microIndex.js";
export { createMicroIndex, DEFAULT_MICRO_INDEX, makeIndexKey } from "./microIndex.js";

export type {
  AssembleInput,
  AssembleOptions,
  AssembleResult,
  ExcerptSource,
  ExcerptWindow,
} from "./assemble.js";
export { assembleContextPack, contextPackIndexKey } from "./assemble.js";
