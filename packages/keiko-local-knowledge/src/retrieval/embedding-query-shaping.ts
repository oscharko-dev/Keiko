import type { EmbeddingModelIdentity } from "@oscharko-dev/keiko-contracts";

export const QWEN3_QUERY_INSTRUCTION_TASK =
  "Given a user question, retrieve relevant local knowledge passages that answer the question.";

function isQwen3EmbeddingIdentity(identity: EmbeddingModelIdentity): boolean {
  const haystack = `${identity.modelId} ${identity.modelRevision ?? ""}`.toLowerCase();
  return haystack.includes("qwen3");
}

export function shapeEmbeddingQuery(identity: EmbeddingModelIdentity, query: string): string {
  if (!isQwen3EmbeddingIdentity(identity)) return query;
  return `Instruct: ${QWEN3_QUERY_INSTRUCTION_TASK}\nQuery:${query}`;
}
