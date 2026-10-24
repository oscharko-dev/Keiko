import type { EmbeddingModelIdentity } from "@oscharko-dev/keiko-contracts";
import type { MemoryEmbeddingInput, MemoryEmbeddingRow } from "@oscharko-dev/keiko-memory-vault";

export function memoryInputEmbeddingIdentity(input: MemoryEmbeddingInput): EmbeddingModelIdentity {
  return {
    provider: input.provider,
    modelId: input.modelId,
    ...(input.modelRevision !== undefined ? { modelRevision: input.modelRevision } : {}),
    vectorDimensions: input.vector.length,
    vectorMetric: input.metric,
  };
}

export function memoryStoredEmbeddingIdentity(row: MemoryEmbeddingRow): EmbeddingModelIdentity {
  return {
    provider: row.provider,
    modelId: row.modelId,
    ...(row.modelRevision !== undefined ? { modelRevision: row.modelRevision } : {}),
    vectorDimensions: row.dimensions,
    vectorMetric: row.metric,
  };
}
