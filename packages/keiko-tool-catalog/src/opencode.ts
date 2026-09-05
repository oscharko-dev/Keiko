// #3414: the "opencode" registration set. ADR-0175 D2 reserves the seven managed-OpenCode
// canonical identities below plus the two exhaustively-declared native extensions (`question`,
// `todowrite` -- adapter-native, never Keiko tool descriptors, per D2's explicit "not Keiko tools
// or compatibility exceptions"). packages/keiko-server/src/coding-sidecar-gateway.ts uses this set
// to build the `toolCatalog` advertisement it forwards to the real model provider (the schema shown
// to the underlying LLM as a function-calling interface -- advisory only; the provider performs no
// server-side schema enforcement of its own).
//
// `OPENCODE_NATIVE_EXTENSION_DEFINITIONS` below is the single source for the two native
// extensions' exact pinned wire schemas. Unlike the seven managed tools, a native extension is
// never compiled through the catalog dialect (no descriptor, no `pattern`-keyword gap: these are
// plain literal JSON Schema objects, carried verbatim). packages/keiko-server/src/coding-runtime/
// opencodeToolSchemas.ts imports them back to build `OPENCODE_MODEL_VISIBLE_TOOLS`, and
// packages/keiko-model-gateway/src/toolCatalogBridge.ts imports them to append the two native
// extensions to a bound advertisement's model-visible tool list -- one copy, two consumers
// (#3414 follow-up: the model-gateway bridge no longer drops a profile's native extensions).
//
// This set is intentionally NOT the source for
// packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts's `OPENCODE_MODEL_VISIBLE_TOOLS`/
// `OPENCODE_TOOL_SOURCE_DEFINITIONS`: those pin what the real, pinned OpenCode 1.17.17 runtime
// itself generates and enforces BEFORE a call ever reaches Keiko (owned by the concurrently-worked
// opencodeRuntimeAdapter.ts) and must keep matching that generated adapter source exactly, pattern
// keyword included, or the sidecar-gateway's incoming exact-set trust check
// (`hasExactOpenCodeVisibleToolContract`) would start rejecting legitimate real traffic.
//
// Known, reported representability gap (ADR-0175 D3: "unsupported dialect semantics are
// incompatibility, never silently omitted keywords"): packages/keiko-tool-catalog/src/schema.ts's
// closed dialect has no `pattern` keyword (TYPE_KEYS.string only allows minLength/maxLength), so
// the format-level regexes the real OpenCode wire schemas use today for `relativePath` (path
// traversal), `expectedContentHash` (hex-64), `target` (https-only) and `skillId` (skill-id shape)
// cannot be expressed in a catalog descriptor. Following the precedent already accepted for
// `keiko.file.read`'s `path` in legacy.ts (also pattern-free), those format checks stay owned by
// the real handler and OpenCode's own generated adapter source, never by this advisory,
// model-facing schema; once schema.ts gains `pattern` support this set becomes a candidate single
// source for OPENCODE_TOOL_SOURCE_DEFINITIONS too (see the #3414 report).
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { DEFAULT_SANDBOX_POLICY } from "@oscharko-dev/keiko-contracts/runtime/tools";
import type {
  CatalogEffect,
  CatalogIdempotency,
  CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createToolRef } from "./identity.js";
import { createToolDescriptor } from "./descriptor.js";
import type { CatalogRegistrationSet, CatalogSetEntry } from "./composer.js";

// Mirrors packages/keiko-server/src/coding-runtime/codingToolIpc.ts's own bounds. That file cannot
// be imported here (ADR-0019: this pure package depends only on contracts+security), so the three
// numeric literals are pinned again with this comment as the single cross-reference; a change to
// either side without the other is a drift the migration inventory should catch.
const OPENCODE_DISCOVER_MAX_RESULTS = 100;
const OPENCODE_READ_MAX_START_LINE = 1_000_000;
const OPENCODE_READ_MAX_WINDOW_LINES = 5_000;

const OPENCODE_PROFILE = { id: "opencode", version: 1 } as const;
const OPENCODE_DIALECT = { id: "managed-runtime-json-schema", version: 1 } as const;
const OPENCODE_RUNTIME = { id: "opencode", version: "1.17.17" } as const;

export interface OpenCodeNativeExtensionDefinition {
  readonly alias: "question" | "todowrite";
  readonly contractVersion: 1;
  readonly description: string;
  readonly inputSchema: CatalogJsonObject;
}

// Exact v1.17.17 built-in `question` wire schema (pinned digest input; byte-identical to the
// projection packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts pins for the
// INCOMING sidecar trust check -- see this file's header comment for why this is the one source).
const QUESTION_EXTENSION_SCHEMA: CatalogJsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  properties: {
    questions: {
      description: "Questions to ask",
      items: {
        properties: {
          header: { description: "Very short label (max 30 chars)", type: "string" },
          multiple: { description: "Allow selecting multiple choices", type: "boolean" },
          options: {
            description: "Available choices",
            items: {
              properties: {
                description: { description: "Explanation of choice", type: "string" },
                label: { description: "Display text (1-5 words, concise)", type: "string" },
              },
              required: ["label", "description"],
              type: "object",
            },
            type: "array",
          },
          question: { description: "Complete question", type: "string" },
        },
        required: ["question", "header", "options"],
        type: "object",
      },
      type: "array",
    },
  },
  required: ["questions"],
  type: "object",
};

// Exact v1.17.17 built-in `todowrite` wire schema (#2480); byte-identical to its source schema.
const TODO_WRITE_EXTENSION_SCHEMA: CatalogJsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    todos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string", description: "Brief description of the task" },
          status: {
            type: "string",
            description: "Current status of the task: pending, in_progress, completed, cancelled",
          },
          priority: {
            type: "string",
            description: "Priority level of the task: high, medium, low",
          },
        },
        required: ["content", "status", "priority"],
      },
      description: "The updated todo list",
    },
  },
  required: ["todos"],
};

/**
 * The two OpenCode-native extensions (ADR-0175 D2), exhaustively declared: never Keiko tool
 * descriptors, never compiled through the catalog dialect. This is the single source for their
 * pinned wire schemas -- packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts and
 * packages/keiko-model-gateway/src/toolCatalogBridge.ts both import this constant rather than
 * each holding their own copy.
 */
export const OPENCODE_NATIVE_EXTENSION_DEFINITIONS: readonly OpenCodeNativeExtensionDefinition[] =
  [
    {
      alias: "question",
      contractVersion: 1,
      description:
        "Ask the operator one or more structured clarifying questions before proceeding.",
      inputSchema: QUESTION_EXTENSION_SCHEMA,
    },
    {
      alias: "todowrite",
      contractVersion: 1,
      description: "Record or update the governed run's todo list.",
      inputSchema: TODO_WRITE_EXTENSION_SCHEMA,
    },
  ];

function managedObjectSchema(
  properties: CatalogJsonObject,
  required: readonly string[],
): CatalogJsonObject {
  // The managed-runtime dialect (dialect.ts `managedInputSchema`) requires every object-typed
  // schema in the tree to declare `additionalProperties: true` (stripped on projection, since the
  // pinned OpenCode runtime does not support declaring it restrictively) and every property to be
  // required (the runtime declares every custom-tool argument required in its provider
  // projection). `required` is intentionally alphabetical: `compileCatalogSchema` (schema.ts)
  // re-sorts it, so an unsorted literal here would silently diverge from the compiled descriptor.
  return {
    type: "object",
    properties,
    required: [...required].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    additionalProperties: true,
  };
}

interface OpenCodeToolSpec {
  readonly canonicalId: string;
  readonly alias: string;
  readonly description: string;
  readonly inputSchema: CatalogJsonObject;
  readonly effect: CatalogEffect;
  readonly idempotency: CatalogIdempotency;
  readonly handlerId: string;
}

function entryFor(spec: OpenCodeToolSpec): CatalogSetEntry {
  return {
    alias: spec.alias,
    descriptor: createToolDescriptor({
      toolRef: createToolRef(spec.canonicalId, 1),
      description: spec.description,
      inputSchema: spec.inputSchema,
      resultSchema: { type: "string", maxLength: TOOL_CATALOG_LIMITS.maxStringBytes },
      effects: [spec.effect],
      actionMapping: [{ action: spec.alias, effects: [spec.effect] }],
      policyReferences: [spec.effect],
      handlerRequirement: { id: spec.handlerId, contractVersion: 1 },
      bounds: {
        maxArgumentBytes: TOOL_CATALOG_LIMITS.maxArgumentBytes,
        maxResultBytes: TOOL_CATALOG_LIMITS.maxResultBytes,
        maxResultCount: 1,
        maxDurationMs: DEFAULT_SANDBOX_POLICY.defaultTimeoutMs,
      },
      idempotency: spec.idempotency,
      cancellation: "before-effect",
    }),
  };
}

function discoverSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.workspace.discover",
    alias: "keiko_workspace_discover",
    description: "Discover workspace-relative file paths by case-insensitive keyword match.",
    inputSchema: managedObjectSchema(
      {
        query: { type: "string", minLength: 1, maxLength: 256 },
        maxResults: { type: "integer", minimum: 1, maximum: OPENCODE_DISCOVER_MAX_RESULTS },
      },
      ["query", "maxResults"],
    ),
    effect: "workspace-read",
    idempotency: "read-only",
    handlerId: "opencode-workspace-discover-port",
  };
}

function readSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.workspace.read",
    alias: "keiko_workspace_read",
    description: "Read one bounded, line-windowed slice of a workspace text file.",
    inputSchema: managedObjectSchema(
      {
        relativePath: { type: "string", minLength: 1, maxLength: 512 },
        startLine: { type: "integer", minimum: 1, maximum: OPENCODE_READ_MAX_START_LINE },
        maxLines: { type: "integer", minimum: 1, maximum: OPENCODE_READ_MAX_WINDOW_LINES },
      },
      ["relativePath", "startLine", "maxLines"],
    ),
    effect: "workspace-read",
    idempotency: "read-only",
    handlerId: "opencode-workspace-read-port",
  };
}

function changesetEditSpec(): OpenCodeToolSpec {
  // The real wire form (opencodeToolSchemas.ts CHANGESET_EDIT_SCHEMA) declares `selectedFiles`
  // optional and `additionalProperties: false` at two nested levels; the managed-runtime dialect
  // requires every property required and every object's additionalProperties stripped-as-true, so
  // this projected schema is a strictly LOOSER, structurally-equivalent shape (every file must now
  // be listed under `selectedFiles`, unknown extra keys are ignored rather than rejected). This is
  // safe here: this schema is only ever advisory input to the underlying LLM's function-calling
  // interface (packages/keiko-model-gateway forwards it to the provider, which performs no
  // server-side schema enforcement of its own), never the dispatch-time enforcement boundary --
  // the OpenCode-generated adapter source (OPENCODE_TOOL_SOURCE_DEFINITIONS, unchanged) and the
  // real changeset handler keep their own independent, stricter validation.
  const fileEntry = managedObjectSchema(
    {
      file: { type: "string", minLength: 1, maxLength: 512 },
      expectedContentHash: { type: "string", minLength: 64, maxLength: 64 },
    },
    ["file", "expectedContentHash"],
  );
  const changeset = managedObjectSchema(
    {
      patch: { type: "string", minLength: 1, maxLength: 65_536 },
      files: { type: "array", minItems: 1, maxItems: 50, items: fileEntry },
      selectedFiles: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    ["patch", "files", "selectedFiles"],
  );
  return {
    canonicalId: "keiko.changeset.edit",
    alias: "keiko_changeset_edit",
    description: "Apply one validated unified-diff changeset to the workspace.",
    inputSchema: managedObjectSchema({ changeset }, ["changeset"]),
    effect: "workspace-write",
    idempotency: "server-key-required",
    handlerId: "opencode-changeset-edit-port",
  };
}

function verificationSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.verification.run",
    alias: "keiko_verification",
    description: "Run one named verification gate (test, typecheck, lint or build).",
    inputSchema: managedObjectSchema(
      {
        verifierId: {
          type: "string",
          enum: ["test", "targeted-test", "typecheck", "lint", "build"],
        },
      },
      ["verifierId"],
    ),
    effect: "verification",
    idempotency: "server-key-required",
    handlerId: "opencode-verification-port",
  };
}

function researchFetchSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.research.fetch",
    alias: "keiko_research_fetch",
    description: "Fetch one public https URL for read-only research.",
    inputSchema: managedObjectSchema({ target: { type: "string", minLength: 9, maxLength: 512 } }, [
      "target",
    ]),
    effect: "network-egress",
    idempotency: "server-key-required",
    handlerId: "opencode-research-fetch-port",
  };
}

function skillSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.skill.invoke",
    alias: "keiko_skill",
    description: "Invoke one approved, read-only skill by its pinned identifier.",
    inputSchema: managedObjectSchema({ skillId: { type: "string", maxLength: 80 } }, ["skillId"]),
    effect: "connector-access",
    idempotency: "server-key-required",
    handlerId: "opencode-skill-port",
  };
}

function childRunSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.child.run",
    alias: "keiko_child_agent",
    description: "Run one bounded, one-layer read-only child agent toward an objective.",
    inputSchema: managedObjectSchema(
      {
        objective: { type: "string", minLength: 1, maxLength: 512 },
        maxToolCalls: { type: "integer", minimum: 1, maximum: 32 },
      },
      ["objective", "maxToolCalls"],
    ),
    effect: "workspace-read",
    idempotency: "read-only",
    handlerId: "opencode-child-agent-port",
  };
}

/**
 * The canonical "opencode" registration set (ADR-0175 D2). Declares the seven managed-OpenCode
 * governed tools plus the two exhaustively-declared native extensions (`nativeExtensions` is
 * derived from `OPENCODE_NATIVE_EXTENSION_DEFINITIONS` above, the same single source consumers use
 * for their pinned wire schemas). `keiko_repository_search` (H1, #3386) is not yet a member --
 * H1's handler is not implemented; see the #3414 report. `keiko.changeset.edit`'s descriptor is a
 * structurally-equivalent, strictly LOOSER projection of the real wire schema (all fields
 * required, nested `additionalProperties` stripped-as-true) -- see `changesetEditSpec` above for
 * exactly why and why that is safe for its one consumer.
 *
 * `packages/keiko-model-gateway/src/toolCatalogBridge.ts`'s bridge merges these native extensions
 * into a bound advertisement's model-visible tool list and passes a call to one of their aliases
 * straight through to the sidecar, unbound (#3414 follow-up); a caller that must NOT expose the
 * native extensions on its advertisement composes its own catalog from these same entries with
 * `nativeExtensions: []`.
 */
export function opencodeRegistrationSet(): CatalogRegistrationSet {
  return {
    profile: OPENCODE_PROFILE,
    adapterDialect: OPENCODE_DIALECT,
    adapterRuntime: OPENCODE_RUNTIME,
    nativeExtensions: OPENCODE_NATIVE_EXTENSION_DEFINITIONS.map(({ alias, contractVersion }) => ({
      alias,
      contractVersion,
    })),
    compatibility: [],
    entries: [
      discoverSpec(),
      readSpec(),
      changesetEditSpec(),
      verificationSpec(),
      researchFetchSpec(),
      skillSpec(),
      childRunSpec(),
    ].map(entryFor),
  };
}
