// Public surface of @oscharko-dev/keiko-local-knowledge (Epic #189, Issue #193). Composes
// the #265 schema with a node:sqlite runtime, exposes typed CRUD for capsules/sources/sets.
//
// No retrieval, no embedding generation, no HTTP — those ship in #196 (indexing
// orchestrator), #199 (retrieval), and #197/#198 (UI surfaces). This package is a leaf and
// depends only on @oscharko-dev/keiko-contracts.

export { KEIKO_LOCAL_KNOWLEDGE_VERSION } from "./version.js";
export { KnowledgeStoreError, KnowledgePathError, KnowledgeNotFoundError } from "./errors.js";
export { resolveKnowledgeStorePath, type ResolveKnowledgeStorePathOptions } from "./store-paths.js";
export {
  openKnowledgeStore,
  type KnowledgeStore,
  type OpenKnowledgeStoreOptions,
} from "./store.js";
export {
  createCapsule,
  deleteCapsule,
  getCapsule,
  listCapsules,
  updateCapsuleState,
  type CreateCapsuleInput,
} from "./capsule-lifecycle.js";
