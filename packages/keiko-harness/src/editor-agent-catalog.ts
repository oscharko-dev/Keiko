// #3408: the "editor" registration set. This cannot live in the pure `keiko-tool-catalog` package
// (ADR-0175 D1 -- it depends only on contracts+security) because it derives its nine descriptors
// from EditorAgentToolHost's own existing schema/name source (`editor-agent-schemas.ts`), which
// only `keiko-tools` (and its downstream consumers, including this package) can import. This file
// owns exactly the descriptor derivation; dispatch itself stays entirely inside EditorAgentToolHost
// -> EditorAgentHttpClient -> the existing agentRoutes.ts / agentVerificationRoute.ts path via the
// generic legacy-port-catalog.ts adapter (no second execution path).
//
// The nine canonical identities are ADR-0175 D2's frozen reservation table, keyed by the exact
// legacy tool name EDITOR_AGENT_TOOL_DEFINITIONS declares for each -- an explicit per-entry
// mapping, not a positional zip, so a future reordering of EDITOR_AGENT_TOOL_DEFINITIONS can never
// silently misassign a canonical identity to the wrong alias.
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { DEFAULT_SANDBOX_POLICY } from "@oscharko-dev/keiko-contracts/runtime/tools";
import type {
  CatalogEffect,
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
import { EDITOR_AGENT_TOOL_DEFINITIONS } from "@oscharko-dev/keiko-tools";
import {
  createKeikoToolCatalog,
  createToolDescriptor,
  createToolRef,
  type CatalogRegistrationSet,
  type CatalogSetEntry,
} from "@oscharko-dev/keiko-tool-catalog";
import { createLegacyPortCatalogFactory } from "./legacy-port-catalog.js";
import type { HarnessCatalogFactory } from "./catalog-runtime.js";
import type { ToolPort } from "./ports.js";

// Keyed by the legacy tool name (packages/keiko-tools/src/editor-agent-schemas.ts), not by
// position, so the mapping cannot silently drift if EDITOR_AGENT_TOOL_DEFINITIONS is reordered.
const EDITOR_CANONICAL_IDS_BY_NAME: ReadonlyMap<string, string> = new Map([
  ["editor_list_sessions", "keiko.editor.sessions"],
  ["editor_snapshot", "keiko.editor.snapshot"],
  ["editor_navigate", "keiko.editor.navigate"],
  ["editor_navigate_symbol", "keiko.editor.symbol"],
  ["editor_search_workspace", "keiko.editor.search"],
  ["editor_git_context", "keiko.editor.git"],
  ["editor_propose_edit", "keiko.editor.edit"],
  ["editor_propose_changeset", "keiko.editor.changeset"],
  ["editor_request_verification", "keiko.editor.verify"],
]);

function canonicalIdFor(definition: ToolDefinition): string {
  const canonicalId = EDITOR_CANONICAL_IDS_BY_NAME.get(definition.name);
  if (canonicalId === undefined)
    throw new TypeError(`No reserved canonical identity for editor tool "${definition.name}"`);
  return canonicalId;
}

const SCALAR_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The catalog's closed JSON Schema dialect (ADR-0175 D3) does not represent `oneOf`/`anyOf`/
// `allOf`/`default`/`pattern`/`uniqueItems`. EditorAgentToolHost's own real schemas (imported,
// never retyped) keep enforcing those at the handler; this projection derives a structurally
// looser -- never stricter -- catalog-legal governance schema from the same source, so the
// catalog's argument-shape gate can never reject a call the real handler would accept.
function projectSchema(value: unknown): CatalogJsonObject {
  const schema = isRecord(value) ? value : {};
  const type = typeof schema.type === "string" ? schema.type : "object";
  if (type === "object") return projectObject(schema);
  if (type === "array") return projectArray(schema);
  return projectScalar(schema, type);
}

function projectObject(schema: Record<string, unknown>): CatalogJsonObject {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const projected = Object.fromEntries(
    Object.entries(properties).map(([key, entry]) => [key, projectSchema(entry)]),
  );
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (key): key is string => typeof key === "string" && Object.hasOwn(projected, key),
      )
    : [];
  const additionalProperties =
    typeof schema.additionalProperties === "boolean" ? schema.additionalProperties : true;
  return { type: "object", properties: projected, required, additionalProperties };
}

function projectArray(schema: Record<string, unknown>): CatalogJsonObject {
  const out: Record<string, CatalogJsonValue> = {
    type: "array",
    items: projectSchema(schema.items),
  };
  if (typeof schema.minItems === "number") out.minItems = schema.minItems;
  if (typeof schema.maxItems === "number") out.maxItems = schema.maxItems;
  return out;
}

function projectableEnum(type: string, value: unknown): readonly CatalogJsonValue[] | undefined {
  if (type === "object" || type === "array" || !Array.isArray(value) || value.length === 0)
    return undefined;
  const scalars = value.filter(
    (item): item is CatalogJsonValue =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean",
  );
  return scalars.length === value.length ? scalars : undefined;
}

function projectScalar(schema: Record<string, unknown>, type: string): CatalogJsonObject {
  const resolved = SCALAR_TYPES.has(type) ? type : "string";
  const out: Record<string, CatalogJsonValue> = { type: resolved };
  const values = projectableEnum(resolved, schema.enum);
  if (values !== undefined) out.enum = values;
  if (resolved === "string") {
    if (typeof schema.minLength === "number") out.minLength = schema.minLength;
    if (typeof schema.maxLength === "number") out.maxLength = schema.maxLength;
  }
  if (resolved === "number" || resolved === "integer") {
    if (typeof schema.minimum === "number") out.minimum = schema.minimum;
    if (typeof schema.maximum === "number") out.maximum = schema.maximum;
  }
  return out;
}

function editorEffect(canonicalId: string): CatalogEffect {
  return canonicalId === "keiko.editor.verify" ? "verification" : "workspace-read";
}

function editorEntry(definition: ToolDefinition, canonicalId: string): CatalogSetEntry {
  const effect = editorEffect(canonicalId);
  return {
    alias: definition.name,
    descriptor: createToolDescriptor({
      toolRef: createToolRef(canonicalId, 1),
      description: definition.description,
      inputSchema: projectSchema(definition.parameters),
      resultSchema: { type: "string", maxLength: TOOL_CATALOG_LIMITS.maxStringBytes },
      effects: [effect],
      actionMapping: [{ action: definition.name, effects: [effect] }],
      policyReferences: [effect],
      handlerRequirement: { id: "editor-agent-tool-host", contractVersion: 1 },
      bounds: {
        maxArgumentBytes: TOOL_CATALOG_LIMITS.maxArgumentBytes,
        maxResultBytes: TOOL_CATALOG_LIMITS.maxResultBytes,
        maxResultCount: 1,
        maxDurationMs: DEFAULT_SANDBOX_POLICY.defaultTimeoutMs,
      },
      idempotency: effect === "workspace-read" ? "read-only" : "server-key-required",
      cancellation: "before-effect",
    }),
  };
}

/** The "editor" registration set: all nine Editor descriptors (ADR-0175 D2). */
export function editorAgentRegistrationSet(): CatalogRegistrationSet {
  if (EDITOR_AGENT_TOOL_DEFINITIONS.length !== EDITOR_CANONICAL_IDS_BY_NAME.size)
    throw new TypeError("Editor tool definition count no longer matches the reserved identities");
  const entries = EDITOR_AGENT_TOOL_DEFINITIONS.map((definition) =>
    editorEntry(definition, canonicalIdFor(definition)),
  );
  return {
    profile: { id: "editor", version: 1 },
    adapterDialect: { id: "editor-json-schema", version: 1 },
    adapterRuntime: { id: "keiko", version: "0.3.17" },
    nativeExtensions: [],
    compatibility: [],
    entries,
  };
}

/**
 * Binds an existing editor ToolPort to the "editor" catalog profile (#3408). Callers that must
 * scope dispatch to fewer than the full nine tools (agentProducerRoute.ts's PRODUCER_TOOL_NAMES)
 * pass their own scoping ToolPort wrapper here rather than the raw EditorAgentToolHost -- the
 * catalog offers all nine (ADR-0175 D2), the caller's own port still decides what actually runs.
 */
export function createEditorAgentCatalogFactory(port: ToolPort): HarnessCatalogFactory {
  const set = editorAgentRegistrationSet();
  const catalog = createKeikoToolCatalog([set]);
  return createLegacyPortCatalogFactory(catalog, set.profile, port);
}
