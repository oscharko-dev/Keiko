// Pure validators for the Local Knowledge Connector contracts (Epic #189, Issue #191).
// No filesystem reads, no clock reads, no crypto, no randomness; these helpers only inspect
// the structure of an `unknown` payload and report which invariants failed. Producers and
// consumers wire these at trust-boundary edges (BFF, audit, indexer entry points).
//
// Each validator returns a discriminated `{ ok: true; value } | { ok: false; errors }` so
// downstream code can branch without throwing. Errors are short, machine-readable strings,
// one per failed invariant, to keep diagnostics deterministic for evaluation harnesses.

import type {
  CapsuleSet,
  ConnectorGraphState,
  ConnectorNode,
  EmbeddingModelIdentity,
  KnowledgeCapsule,
  KnowledgeSourceScope,
} from "./local-knowledge.js";
import {
  CAPSULE_ANSWER_GROUNDING_POLICIES,
  CAPSULE_LIFECYCLE_STATES,
  CAPSULE_OUTPUT_MODES,
  CAPSULE_RETRIEVAL_EFFORTS,
  CONNECTOR_NODE_KINDS,
  EMBEDDING_VECTOR_METRICS,
  KNOWLEDGE_SOURCE_SCOPE_KINDS,
} from "./local-knowledge.js";
import { isSafeScopePath, isSafeStorageReference } from "./local-knowledge-paths.js";

// ─── Result types ─────────────────────────────────────────────────────────────
export interface ValidationOk<T> {
  readonly ok: true;
  readonly value: T;
}
export interface ValidationFail {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type LocalKnowledgeValidation<T> = ValidationOk<T> | ValidationFail;

// ─── Shared primitive guards ──────────────────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// Soft-cap chosen to keep browser surfaces safe (matches the upper bound a Conversation
// Center summary card will render without truncation). NUL and the ASCII control range
// are rejected because they corrupt terminal output and many UI text renderers; \n and \t
// are explicitly allowed since legitimate display strings carry line breaks.
const SAFE_DISPLAY_MAX_CHARS = 4096;

// Intentionally matches control characters; this is the entire purpose of the safety
// gate. The `no-control-regex` lint rule guards against accidental control matches, not
// deliberate ones.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export function isSafeDisplaySummary(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length > SAFE_DISPLAY_MAX_CHARS) {
    return false;
  }
  return !FORBIDDEN_CONTROL_RE.test(value);
}

function isSafeDisplayString(value: unknown): value is string {
  return isNonEmptyTrimmedString(value) && isSafeDisplaySummary(value);
}

function validateSafeDisplayStringField(
  errors: string[],
  field: string,
  value: unknown,
): void {
  if (!isSafeDisplayString(value)) {
    errors.push(`${field} must be a browser-safe non-empty trimmed string`);
  }
}

function validateSafeDisplayStringArrayField(
  errors: string[],
  field: string,
  value: unknown,
): void {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be a string array`);
    return;
  }
  for (const entry of value) {
    if (!isSafeDisplayString(entry)) {
      errors.push(`${field} entry must be a browser-safe non-empty trimmed string`);
      return;
    }
  }
}

// ─── EmbeddingModelIdentity ───────────────────────────────────────────────────
function pushBadEnum(
  errors: string[],
  field: string,
  value: unknown,
  allowed: readonly string[],
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(`${field} must be one of ${allowed.join("|")}`);
  }
}

export function validateEmbeddingModelIdentity(
  input: unknown,
): LocalKnowledgeValidation<EmbeddingModelIdentity> {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["embeddingModelIdentity must be an object"] };
  }
  if (!isNonEmptyTrimmedString(input.provider)) {
    errors.push("embeddingModelIdentity.provider must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(input.modelId)) {
    errors.push("embeddingModelIdentity.modelId must be a non-empty string");
  }
  if (!isFinitePositiveInteger(input.vectorDimensions)) {
    errors.push("embeddingModelIdentity.vectorDimensions must be a positive integer");
  }
  pushBadEnum(
    errors,
    "embeddingModelIdentity.vectorMetric",
    input.vectorMetric,
    EMBEDDING_VECTOR_METRICS,
  );
  if (input.modelRevision !== undefined && !isNonEmptyTrimmedString(input.modelRevision)) {
    errors.push("embeddingModelIdentity.modelRevision must be a non-empty string when set");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as EmbeddingModelIdentity };
}

// ─── KnowledgeSourceScope ─────────────────────────────────────────────────────
function validateGlobs(field: string, globs: unknown, errors: string[]): void {
  if (globs === undefined) {
    return;
  }
  if (!isStringArray(globs)) {
    errors.push(`${field} must be a string array when set`);
    return;
  }
  for (const glob of globs) {
    if (glob.length === 0 || glob.includes("\0")) {
      errors.push(`${field} entry must be a non-empty NUL-free string`);
      return;
    }
  }
}

function validateFolderScope(input: Record<string, unknown>, errors: string[]): void {
  if (typeof input.rootPath !== "string" || !isSafeScopePath(input.rootPath)) {
    errors.push("scope.rootPath is unsafe or empty");
  }
  if (typeof input.recursive !== "boolean") {
    errors.push("scope.recursive must be a boolean");
  }
  validateGlobs("scope.includeGlobs", input.includeGlobs, errors);
  validateGlobs("scope.excludeGlobs", input.excludeGlobs, errors);
}

function validateRepositoryScope(input: Record<string, unknown>, errors: string[]): void {
  if (typeof input.repositoryRoot !== "string" || !isSafeScopePath(input.repositoryRoot)) {
    errors.push("scope.repositoryRoot is unsafe or empty");
  }
  validateGlobs("scope.includeGlobs", input.includeGlobs, errors);
  validateGlobs("scope.excludeGlobs", input.excludeGlobs, errors);
}

function validateFilesScope(input: Record<string, unknown>, errors: string[]): void {
  if (typeof input.rootPath !== "string" || !isSafeScopePath(input.rootPath)) {
    errors.push("scope.rootPath is unsafe or empty");
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    errors.push("scope.files must be a non-empty array");
    return;
  }
  for (const entry of input.files) {
    if (typeof entry !== "string" || !isSafeStorageReference(entry)) {
      errors.push("scope.files entry is unsafe or empty");
      return;
    }
  }
}

export function validateKnowledgeSourceScope(
  input: unknown,
): LocalKnowledgeValidation<KnowledgeSourceScope> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["scope must be an object"] };
  }
  const kind = input.kind;
  if (!KNOWLEDGE_SOURCE_SCOPE_KINDS.includes(kind as KnowledgeSourceScope["kind"])) {
    return {
      ok: false,
      errors: [`scope.kind must be one of ${KNOWLEDGE_SOURCE_SCOPE_KINDS.join("|")}`],
    };
  }
  const errors: string[] = [];
  if (kind === "folder") {
    validateFolderScope(input, errors);
  } else if (kind === "repository") {
    validateRepositoryScope(input, errors);
  } else {
    validateFilesScope(input, errors);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as KnowledgeSourceScope };
}

// ─── KnowledgeCapsule ─────────────────────────────────────────────────────────
function validateCapsuleEnums(input: Record<string, unknown>, errors: string[]): void {
  pushBadEnum(errors, "capsule.retrievalEffort", input.retrievalEffort, CAPSULE_RETRIEVAL_EFFORTS);
  pushBadEnum(errors, "capsule.outputMode", input.outputMode, CAPSULE_OUTPUT_MODES);
  pushBadEnum(
    errors,
    "capsule.answerGroundingPolicy",
    input.answerGroundingPolicy,
    CAPSULE_ANSWER_GROUNDING_POLICIES,
  );
  pushBadEnum(errors, "capsule.lifecycleState", input.lifecycleState, CAPSULE_LIFECYCLE_STATES);
}

function validateCapsuleTimestamps(input: Record<string, unknown>, errors: string[]): void {
  if (!isFiniteNonNegativeNumber(input.createdAt)) {
    errors.push("capsule.createdAt must be a finite non-negative number");
  }
  if (!isFiniteNonNegativeNumber(input.updatedAt)) {
    errors.push("capsule.updatedAt must be a finite non-negative number");
  }
}

function validateCapsuleSourceLineage(input: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length === 0) {
    errors.push("capsule.sourceIds must be a non-empty array");
    return;
  }
  for (const id of input.sourceIds) {
    if (!isNonEmptyTrimmedString(id)) {
      errors.push("capsule.sourceIds entry must be a non-empty string");
      return;
    }
  }
}

function validateKnowledgeCapsuleDisplayMetadata(
  input: Record<string, unknown>,
  errors: string[],
): void {
  validateSafeDisplayStringField(errors, "capsule.displayName", input.displayName);
  if (input.description !== undefined) {
    validateSafeDisplayStringField(errors, "capsule.description", input.description);
  }
  if (input.sourceRoutingInstructions !== undefined) {
    validateSafeDisplayStringField(
      errors,
      "capsule.sourceRoutingInstructions",
      input.sourceRoutingInstructions,
    );
  }
  validateSafeDisplayStringArrayField(errors, "capsule.tags", input.tags);
}

export function validateKnowledgeCapsule(
  input: unknown,
): LocalKnowledgeValidation<KnowledgeCapsule> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["capsule must be an object"] };
  }
  const errors: string[] = [];
  if (!isNonEmptyTrimmedString(input.id)) {
    errors.push("capsule.id must be a non-empty string");
  }
  validateKnowledgeCapsuleDisplayMetadata(input, errors);
  validateCapsuleSourceLineage(input, errors);
  validateCapsuleEnums(input, errors);
  const identityResult = validateEmbeddingModelIdentity(input.embeddingModelIdentity);
  if (!identityResult.ok) {
    for (const reason of identityResult.errors) {
      errors.push(`capsule.${reason}`);
    }
  }
  if (
    typeof input.storageReference !== "string" ||
    !isSafeStorageReference(input.storageReference)
  ) {
    errors.push("capsule.storageReference must be a safe relative path");
  }
  validateCapsuleTimestamps(input, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as KnowledgeCapsule };
}

// ─── CapsuleSet ───────────────────────────────────────────────────────────────
function validateCapsuleSetCapsuleIds(input: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(input.capsuleIds) || input.capsuleIds.length === 0) {
    errors.push("capsuleSet.capsuleIds must be a non-empty array");
    return;
  }
  for (const id of input.capsuleIds) {
    if (!isNonEmptyTrimmedString(id)) {
      errors.push("capsuleSet.capsuleIds entry must be a non-empty string");
      return;
    }
  }
}

export function validateCapsuleSet(input: unknown): LocalKnowledgeValidation<CapsuleSet> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["capsuleSet must be an object"] };
  }
  const errors: string[] = [];
  if (!isNonEmptyTrimmedString(input.id)) {
    errors.push("capsuleSet.id must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(input.displayName)) {
    errors.push("capsuleSet.displayName must be a non-empty trimmed string");
  }
  if (!isStringArray(input.tags)) {
    errors.push("capsuleSet.tags must be a string array");
  }
  validateCapsuleSetCapsuleIds(input, errors);
  if (!isFiniteNonNegativeNumber(input.composedAt)) {
    errors.push("capsuleSet.composedAt must be a finite non-negative number");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as CapsuleSet };
}

// ─── ConnectorGraphState ──────────────────────────────────────────────────────
function validateFilesWindowNode(node: Record<string, unknown>, errors: string[]): void {
  const scopeResult = validateKnowledgeSourceScope(node.scope);
  if (!scopeResult.ok) {
    for (const reason of scopeResult.errors) {
      errors.push(`graph.nodes entry.files-window.${reason}`);
    }
  }
}

function validateLocalKnowledgeNodeTarget(
  target: unknown,
  errors: string[],
): void {
  if (!isRecord(target)) {
    errors.push("graph.nodes entry.local-knowledge.target must be an object");
    return;
  }
  if (target.kind === "capsule") {
    if (!isNonEmptyTrimmedString(target.capsuleId)) {
      errors.push(
        "graph.nodes entry.local-knowledge.target.capsuleId must be a non-empty string",
      );
    }
    return;
  }
  if (target.kind === "capsule-set") {
    if (!isNonEmptyTrimmedString(target.capsuleSetId)) {
      errors.push(
        "graph.nodes entry.local-knowledge.target.capsuleSetId must be a non-empty string",
      );
    }
    return;
  }
  errors.push('graph.nodes entry.local-knowledge.target.kind must be "capsule" or "capsule-set"');
}

function validateLocalKnowledgeNode(node: Record<string, unknown>, errors: string[]): void {
  validateLocalKnowledgeNodeTarget(node.target, errors);
}

function validateConversationCenterNode(
  node: Record<string, unknown>,
  errors: string[],
): void {
  if (!isNonEmptyTrimmedString(node.conversationId)) {
    errors.push("graph.nodes entry.conversation-center.conversationId must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(node.route)) {
    errors.push("graph.nodes entry.conversation-center.route must be a non-empty string");
  }
}

function collectNodeKinds(
  nodes: readonly unknown[],
  errors: string[],
): ReadonlyMap<string, ConnectorNode["kind"]> {
  const nodeKinds = new Map<string, ConnectorNode["kind"]>();
  for (const node of nodes) {
    if (!isRecord(node)) {
      errors.push("graph.nodes entry must be an object");
      continue;
    }
    if (!isNonEmptyTrimmedString(node.nodeId)) {
      errors.push("graph.nodes entry must have a non-empty nodeId");
      continue;
    }
    if (nodeKinds.has(node.nodeId)) {
      errors.push(`graph.nodes contains a duplicate nodeId: ${node.nodeId}`);
      continue;
    }
    if (
      typeof node.kind !== "string" ||
      !(CONNECTOR_NODE_KINDS as readonly string[]).includes(node.kind)
    ) {
      errors.push("graph.nodes entry has an unknown kind");
      continue;
    }
    nodeKinds.set(node.nodeId, node.kind as ConnectorNode["kind"]);
    if (node.kind === "files-window") {
      validateFilesWindowNode(node, errors);
    } else if (node.kind === "local-knowledge") {
      validateLocalKnowledgeNode(node, errors);
    } else {
      validateConversationCenterNode(node, errors);
    }
  }
  return nodeKinds;
}

function validateEdgeNodeId(
  field: "from" | "to",
  nodeId: unknown,
  nodeKinds: ReadonlyMap<string, ConnectorNode["kind"]>,
  errors: string[],
): string | undefined {
  if (typeof nodeId !== "string" || !nodeKinds.has(nodeId)) {
    errors.push(`graph.edges references unknown ${field}.nodeId`);
    return undefined;
  }
  return nodeId;
}

function validateEdgeNodeKind(
  field: "from" | "to",
  kind: unknown,
  nodeId: string | undefined,
  nodeKinds: ReadonlyMap<string, ConnectorNode["kind"]>,
  errors: string[],
): void {
  if (typeof kind !== "string" || !(CONNECTOR_NODE_KINDS as readonly string[]).includes(kind)) {
    errors.push(`graph.edges ${field}.kind must be a known node kind`);
    return;
  }
  if (nodeId !== undefined && nodeKinds.get(nodeId) !== kind) {
    errors.push(`graph.edges ${field}.kind must match the referenced node kind`);
  }
}

function validateEdgeRecord(
  edge: Record<string, unknown>,
  nodeKinds: ReadonlyMap<string, ConnectorNode["kind"]>,
  errors: string[],
): void {
  const from = edge.from as Record<string, unknown>;
  const to = edge.to as Record<string, unknown>;
  const fromId = validateEdgeNodeId("from", from.nodeId, nodeKinds, errors);
  const toId = validateEdgeNodeId("to", to.nodeId, nodeKinds, errors);
  validateEdgeNodeKind("from", from.kind, fromId, nodeKinds, errors);
  validateEdgeNodeKind("to", to.kind, toId, nodeKinds, errors);
  if (!isFiniteNonNegativeNumber(edge.createdAt)) {
    errors.push("graph.edges entry must have a finite non-negative createdAt");
  }
}

function validateEdges(
  edges: readonly unknown[],
  nodeKinds: ReadonlyMap<string, ConnectorNode["kind"]>,
  errors: string[],
): void {
  for (const edge of edges) {
    if (!isRecord(edge) || !isRecord(edge.from) || !isRecord(edge.to)) {
      errors.push("graph.edges entry must have from/to objects");
      continue;
    }
    validateEdgeRecord(edge, nodeKinds, errors);
  }
}

export function validateConnectorGraphState(
  input: unknown,
): LocalKnowledgeValidation<ConnectorGraphState> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["graph must be an object"] };
  }
  const errors: string[] = [];
  if (input.schemaVersion !== "1") {
    errors.push('graph.schemaVersion must be the literal "1"');
  }
  if (!Array.isArray(input.nodes)) {
    return { ok: false, errors: [...errors, "graph.nodes must be an array"] };
  }
  if (!Array.isArray(input.edges)) {
    return { ok: false, errors: [...errors, "graph.edges must be an array"] };
  }
  const nodeKinds = collectNodeKinds(input.nodes, errors);
  validateEdges(input.edges, nodeKinds, errors);
  if (!isFiniteNonNegativeNumber(input.updatedAt)) {
    errors.push("graph.updatedAt must be a finite non-negative number");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as ConnectorGraphState };
}

// Re-export the connector node alias so consumers of this validator module can narrow
// without dipping back into the types file when they already imported the validator.
export type { ConnectorNode };
