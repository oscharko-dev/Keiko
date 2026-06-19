// Governed coding-context providers (Issue #1211, ADR-0042 D6). Each provider wraps an EXISTING
// retrieval seam and returns redacted, byte-bounded excerpt candidates plus a content-free omission
// when the source is unavailable, not-ready, denied, or excluded for the request's purpose. No
// provider invents retrieval logic: repo-search reuses keiko-workspace `searchText`/`readExcerpt`,
// Local Knowledge reuses the query-only `runLocalKnowledgeRetrieval` path (no answer generation), and
// memory reuses the `retrieveMemoryContext` pipeline already wired for /api/memory/context. Retrieved
// text is untrusted model input (OWASP LLM08/LLM01): every candidate is tagged with its source tier
// (by the orchestrator) and stripped of unsafe format characters before it can reach a model or the
// harness.

import {
  stripUnsafeFormatChars,
  type CodingContextOmission,
  type CodingContextSourceKind,
  type RetrievalQuery,
  type RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import type { MemoryScope, ProjectId, WorkspaceId } from "@oscharko-dev/keiko-contracts/memory";
import {
  DEFAULT_SEARCH_LIMITS,
  detectWorkspaceAt,
  readExcerpt,
  searchText,
  type SearchScope,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { readCitationExcerpt } from "@oscharko-dev/keiko-local-knowledge";
import { retrieveMemoryContext } from "@oscharko-dev/keiko-memory-retrieval";
import { memoryTextEgressRejectionReason } from "@oscharko-dev/keiko-memory-capture";
import type { UiHandlerDeps } from "../deps.js";
import { openStoreForDeps } from "../local-knowledge-grounded-qa.js";
import { vaultAsQueryPort } from "../memory-conv-handlers.js";
import { LOCAL_CONVERSATION_MEMORY_USER_ID } from "../memory-conversation-context.js";
import { memoryCapturePolicyForDeps } from "../memory-capture-policy.js";
import {
  buildConversationRetrievalSignals,
  conversationFusionMode,
} from "../memory-retrieval-signals.js";
import {
  buildLocalKnowledgeScope,
  retrieveEditorLocalKnowledge,
} from "./localKnowledgeRetrieval.js";

// A pre-budget excerpt candidate. `text` is already redacted, format-char-stripped, and clamped to
// the per-excerpt cap; the orchestrator applies the overall byte budget and assigns final ranks.
export interface RawExcerpt {
  readonly sourceKind: CodingContextSourceKind;
  readonly id: string;
  readonly score: number;
  readonly citationRef: string | undefined;
  readonly text: string;
  readonly truncated: boolean;
}

export interface ProviderOutcome {
  readonly excerpts: readonly RawExcerpt[];
  readonly omission: CodingContextOmission | undefined;
}

export interface ProviderContext {
  readonly deps: UiHandlerDeps;
  readonly realRoot: string;
  readonly signal: AbortSignal;
  readonly maxBytesPerExcerpt: number;
  readonly nowMs: number;
}

const REPO_SEARCH_MAX_HITS = 6;
const FILES_FOCUS_MAX_LINES = 240;
const LOCAL_KNOWLEDGE_MAX_REFERENCES = 8;
const MEMORY_MAX_ENTRIES = 8;

function basename(scopePath: string): string {
  const parts = scopePath.split("/");
  return parts[parts.length - 1] ?? scopePath;
}

// strip-then-redact, mirroring grounded-qa redactString: format-char stripping first (GRD-001)
// prevents Trojan-source splits from confusing the redactor; the redactor then removes secrets.
function redactExcerpt(deps: UiHandlerDeps, text: string): string {
  return String(deps.redactor(stripUnsafeFormatChars(text)));
}

// UTF-8-safe byte clamp (no multi-byte split).
function clampToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { text: "", truncated: true };
  }
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }
  const decoded = new TextDecoder("utf-8", { fatal: false })
    .decode(encoded.subarray(0, maxBytes))
    .replace(/�+$/u, "");
  return { text: decoded, truncated: true };
}

function prepareExcerpt(
  ctx: ProviderContext,
  raw: {
    sourceKind: CodingContextSourceKind;
    id: string;
    score: number;
    citationRef: string | undefined;
    text: string;
    truncated?: boolean;
  },
): RawExcerpt | undefined {
  const redacted = redactExcerpt(ctx.deps, raw.text);
  const clamped = clampToBytes(redacted, ctx.maxBytesPerExcerpt);
  if (clamped.text.length === 0) {
    return undefined;
  }
  return {
    sourceKind: raw.sourceKind,
    id: raw.id,
    score: raw.score,
    citationRef: raw.citationRef,
    text: clamped.text,
    // truncated if the upstream read clamped OR our per-excerpt cap clamped.
    truncated: (raw.truncated ?? false) || clamped.truncated,
  };
}

function omission(
  sourceKind: CodingContextSourceKind,
  reason: CodingContextOmission["reason"],
): CodingContextOmission {
  return { sourceKind, reason };
}

function buildScope(realRoot: string, relativePaths: readonly string[]): SearchScope {
  return {
    workspace: detectWorkspaceAt(realRoot, nodeWorkspaceFs),
    scopeId: "editor-coding-context",
    relativePaths,
  };
}

function buildQuery(text: string, symbol: string | undefined, nowMs: number): RetrievalQuery {
  return {
    kind: symbol !== undefined ? "exact-symbol" : "natural-language",
    text,
    caseSensitive: false,
    maxResults: REPO_SEARCH_MAX_HITS,
    emittedAtMs: nowMs,
  };
}

async function readHitExcerpt(
  scope: SearchScope,
  atom: { scopePath: string; lineRange: { startLine: number; endLine: number } | undefined },
  maxBytes: number,
): Promise<{ content: string; truncated: boolean } | undefined> {
  const startLine = atom.lineRange?.startLine ?? 1;
  const endLine = atom.lineRange?.endLine ?? startLine;
  try {
    const result = await readExcerpt(scope, {
      scopePath: atom.scopePath,
      startLine,
      endLine,
      maxBytes,
    });
    return { content: result.content, truncated: result.truncated };
  } catch {
    return undefined;
  }
}

// AbortSignal.aborted is a live getter that can flip true across an await, but TS narrows it to
// `false` after an early-return guard. Reading it through this helper defeats that narrowing so the
// cooperative cancellation checks stay live (and lint-clean).
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

// ─── files-focus + repo-search provider ─────────────────────────────────────────────
// Grounds the model in the active document and the top lexical hits for the symbol/query, all from
// the contained workspace via the governed keiko-workspace facade (deny/realpath/size enforced there).
async function readFocusExcerpt(
  ctx: ProviderContext,
  scope: SearchScope,
  documentPath: string,
): Promise<RawExcerpt | "denied" | undefined> {
  try {
    const focus = await readExcerpt(scope, {
      scopePath: documentPath,
      startLine: 1,
      endLine: FILES_FOCUS_MAX_LINES,
      maxBytes: ctx.maxBytesPerExcerpt,
    });
    return prepareExcerpt(ctx, {
      sourceKind: "files-focus",
      id: focus.atom.stableId,
      score: 1,
      citationRef: basename(documentPath),
      text: focus.content,
      truncated: focus.truncated,
    });
  } catch {
    return "denied";
  }
}

async function searchHitExcerpts(
  ctx: ProviderContext,
  scope: SearchScope,
  term: string,
  symbol: string | undefined,
): Promise<readonly RawExcerpt[] | "unavailable"> {
  let hits: Awaited<ReturnType<typeof searchText>>;
  try {
    hits = await searchText(scope, buildQuery(term, symbol, ctx.nowMs), DEFAULT_SEARCH_LIMITS);
  } catch {
    return "unavailable";
  }
  const excerpts: RawExcerpt[] = [];
  for (const atom of hits.atoms.slice(0, REPO_SEARCH_MAX_HITS)) {
    if (isAborted(ctx.signal)) {
      break;
    }
    const hit = await readHitExcerpt(scope, atom, ctx.maxBytesPerExcerpt);
    if (hit === undefined) {
      continue;
    }
    const prepared = prepareExcerpt(ctx, {
      sourceKind: "repo-search",
      id: atom.stableId,
      score: atom.score,
      citationRef: basename(atom.scopePath),
      text: hit.content,
      truncated: hit.truncated,
    });
    if (prepared !== undefined) {
      excerpts.push(prepared);
    }
  }
  return excerpts;
}

export async function runRepoSearchProvider(
  ctx: ProviderContext,
  input: {
    readonly documentPath: string;
    readonly symbol: string | undefined;
    readonly queryText: string | undefined;
    readonly changedFiles: readonly string[] | undefined;
  },
): Promise<ProviderOutcome> {
  if (isAborted(ctx.signal)) {
    return { excerpts: [], omission: omission("repo-search", "unavailable") };
  }
  const scope = buildScope(ctx.realRoot, [input.documentPath, ...(input.changedFiles ?? [])]);
  const focus = await readFocusExcerpt(ctx, scope, input.documentPath);
  if (focus === "denied") {
    return { excerpts: [], omission: omission("files-focus", "denied") };
  }
  const excerpts: RawExcerpt[] = focus !== undefined ? [focus] : [];
  const term = input.symbol ?? input.queryText ?? basename(input.documentPath);
  if (term.trim().length === 0 || isAborted(ctx.signal)) {
    return { excerpts, omission: undefined };
  }
  const hits = await searchHitExcerpts(ctx, scope, term, input.symbol);
  if (hits === "unavailable") {
    return { excerpts, omission: omission("repo-search", "unavailable") };
  }
  return { excerpts: [...excerpts, ...hits], omission: undefined };
}

// ─── Local Knowledge provider (query-only, no answer generation) ─────────────────────
function localKnowledgeExcerpts(
  ctx: ProviderContext,
  store: ReturnType<typeof openStoreForDeps>["store"],
  references: readonly RetrievalReference[],
): RawExcerpt[] {
  const excerpts: RawExcerpt[] = [];
  for (const reference of references.slice(0, LOCAL_KNOWLEDGE_MAX_REFERENCES)) {
    if (isAborted(ctx.signal)) {
      break;
    }
    const text = readCitationExcerpt(store, reference.capsuleId, reference.citation);
    const prepared = prepareExcerpt(ctx, {
      sourceKind: "local-knowledge",
      id: reference.chunkId,
      score: reference.score,
      citationRef: reference.citation.safeDisplayName,
      text,
    });
    if (prepared !== undefined) {
      excerpts.push(prepared);
    }
  }
  return excerpts;
}

export async function runLocalKnowledgeProvider(
  ctx: ProviderContext,
  input: {
    readonly queryText: string | undefined;
    readonly capsuleId: string | undefined;
    readonly capsuleSetId: string | undefined;
  },
): Promise<ProviderOutcome> {
  const query = input.queryText;
  if (query === undefined || query.trim().length === 0) {
    return { excerpts: [], omission: omission("local-knowledge", "unavailable") };
  }
  const scope = buildLocalKnowledgeScope(input.capsuleId, input.capsuleSetId);
  if (scope === undefined) {
    return { excerpts: [], omission: omission("local-knowledge", "unavailable") };
  }
  let env: ReturnType<typeof openStoreForDeps>;
  try {
    env = openStoreForDeps(ctx.deps);
  } catch {
    return { excerpts: [], omission: omission("local-knowledge", "unavailable") };
  }
  try {
    const outcome = await retrieveEditorLocalKnowledge(
      ctx.deps,
      env.store,
      scope,
      query,
      ctx.signal,
    );
    if (outcome.kind === "conflict") {
      return { excerpts: [], omission: omission("local-knowledge", "denied") };
    }
    if (outcome.kind === "not-ready" || outcome.noEvidence) {
      return { excerpts: [], omission: omission("local-knowledge", "not-ready") };
    }
    return {
      excerpts: localKnowledgeExcerpts(ctx, env.store, outcome.references),
      omission: undefined,
    };
  } catch {
    return { excerpts: [], omission: omission("local-knowledge", "unavailable") };
  } finally {
    env.close();
  }
}

// ─── Memory provider (query-only, reuses retrieveMemoryContext) ───────────────────────
function editorMemoryScopes(realRoot: string): readonly MemoryScope[] {
  return [
    { kind: "workspace", workspaceId: realRoot as WorkspaceId },
    { kind: "project", projectId: realRoot as ProjectId },
    { kind: "user", userId: LOCAL_CONVERSATION_MEMORY_USER_ID },
    { kind: "global" },
  ];
}

async function runMemoryRetrieval(
  ctx: ProviderContext,
  vault: NonNullable<UiHandlerDeps["memoryVault"]>,
  queryText: string | undefined,
  scopes: readonly MemoryScope[],
): Promise<ReturnType<typeof retrieveMemoryContext>> {
  // Embedding egress gate (#204 O-F4): never send a secret-shaped query to the secondary embedding
  // model — identical to the conversation memory path.
  const safeForSecondaryModel =
    queryText === undefined ||
    memoryTextEgressRejectionReason(queryText, memoryCapturePolicyForDeps(ctx.deps)) === null;
  const signals = await buildConversationRetrievalSignals(
    ctx.deps,
    vault,
    queryText,
    scopes,
    ctx.nowMs,
    safeForSecondaryModel,
  );
  return retrieveMemoryContext(
    {
      scopes,
      nowMs: ctx.nowMs,
      ...(queryText !== undefined ? { queryText } : {}),
      fusion: conversationFusionMode(ctx.deps),
      ...(signals.semanticById !== undefined ? { semanticById: signals.semanticById } : {}),
      ...(signals.strengthById.size > 0 ? { strengthById: signals.strengthById } : {}),
      ...(signals.embeddingById.size > 0 ? { embeddingById: signals.embeddingById } : {}),
    },
    vaultAsQueryPort(vault),
  );
}

function memoryExcerpts(
  ctx: ProviderContext,
  result: ReturnType<typeof retrieveMemoryContext>,
): RawExcerpt[] {
  const scoreById = new Map(result.included.map((item) => [item.memoryId, item.score]));
  const excerpts: RawExcerpt[] = [];
  for (const entry of result.contextBlock.memories.slice(0, MEMORY_MAX_ENTRIES)) {
    const prepared = prepareExcerpt(ctx, {
      sourceKind: "memory",
      id: entry.memoryId,
      score: scoreById.get(entry.memoryId) ?? entry.confidence,
      citationRef: entry.inclusionReason,
      text: entry.bodyExcerpt,
    });
    if (prepared !== undefined) {
      excerpts.push(prepared);
    }
  }
  return excerpts;
}

export async function runMemoryProvider(
  ctx: ProviderContext,
  input: { readonly queryText: string | undefined },
): Promise<ProviderOutcome> {
  const vault = ctx.deps.memoryVault;
  if (vault === undefined) {
    return { excerpts: [], omission: omission("memory", "unavailable") };
  }
  let result: ReturnType<typeof retrieveMemoryContext>;
  try {
    result = await runMemoryRetrieval(
      ctx,
      vault,
      input.queryText,
      editorMemoryScopes(ctx.realRoot),
    );
  } catch {
    return { excerpts: [], omission: omission("memory", "unavailable") };
  }
  return { excerpts: memoryExcerpts(ctx, result), omission: undefined };
}
