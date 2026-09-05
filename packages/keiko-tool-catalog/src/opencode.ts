// #3414: the "opencode" registration set. ADR-0175 D2 reserves the seven managed-OpenCode
// canonical identities below plus the two exhaustively-declared native extensions (`question`,
// `todowrite` -- adapter-native, never Keiko tool descriptors, per D2's explicit "not Keiko tools
// or compatibility exceptions"). Descriptors here are the single source for these tools' governed
// shape; packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts derives its
// model-visible/gateway wire list from this set via `gatewayToolDefinitions` rather than
// hand-authoring a second copy.
//
// Known, reported representability gap (ADR-0175 D3: "unsupported dialect semantics are
// incompatibility, never silently omitted keywords"): packages/keiko-tool-catalog/src/schema.ts's
// closed dialect has no `pattern` keyword (TYPE_KEYS.string only allows minLength/maxLength), so
// the format-level regexes the real OpenCode wire schemas use today for `relativePath` (path
// traversal), `expectedContentHash` (hex-64), `target` (https-only) and `skillId` (skill-id shape)
// cannot be expressed in a catalog descriptor. Following the precedent already accepted for
// `keiko.file.read`'s `path` in legacy.ts (also pattern-free), those format checks remain owned by
// the real handler at dispatch time, not by this advertised/argument-gate schema; this file never
// widens an existing catalog-enforced constraint, it simply does not duplicate handler-owned format
// validation the closed dialect cannot represent.
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
    inputSchema: managedObjectSchema(
      { target: { type: "string", minLength: 9, maxLength: 512 } },
      ["target"],
    ),
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
 * governed tools this file can safely and losslessly represent, plus the two exhaustively-declared
 * native extensions. `keiko.changeset.edit` and `keiko_repository_search` (H1, #3386) are not yet
 * members -- see the comments above and the #3414 report for exact reasons and follow-ups.
 *
 * NOTE for consumers building a live gateway advertisement: `packages/keiko-model-gateway/src/
 * toolCatalogBridge.ts`'s `normalizerFor` (and `invocation.ts`'s `selectedTools`) do not yet merge
 * native extensions into the bound tool list -- both reject or silently drop them today. A caller
 * that must produce a bridge-compatible advertisement composes its own catalog from these same
 * entries with `nativeExtensions: []` until that merge lands (also #3414's report).
 */
export function opencodeRegistrationSet(): CatalogRegistrationSet {
  return {
    profile: OPENCODE_PROFILE,
    adapterDialect: OPENCODE_DIALECT,
    adapterRuntime: OPENCODE_RUNTIME,
    nativeExtensions: [
      { alias: "question", contractVersion: 1 },
      { alias: "todowrite", contractVersion: 1 },
    ],
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
