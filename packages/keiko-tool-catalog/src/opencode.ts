// #3414 (extended by #3386/#3387/#3388): the "opencode" registration set. ADR-0175 D2 reserves the
// sixteen managed-OpenCode canonical identities below (the original seven workspace/verification
// tools, the eight Git status/diff/stage/commit, push/pull-request and CI-observation tools, plus
// #3386's H1 local repository-search handler projected as `keiko.repo.search@1` / alias
// `keiko_repository_search` -- see `repositorySearchSpec` below) plus the two exhaustively-declared
// native extensions (`question`, `todowrite` -- adapter-native, never Keiko tool descriptors, per
// D2's explicit "not Keiko tools or compatibility exceptions").
// packages/keiko-server/src/coding-sidecar-gateway.ts uses this set to build the `toolCatalog`
// advertisement it forwards to the real model provider (the schema shown to the underlying LLM as
// a function-calling interface -- advisory only; the provider performs no server-side schema
// enforcement of its own).
//
// `OPENCODE_NATIVE_EXTENSION_DEFINITIONS` below is the single source for the two native
// extensions' exact pinned wire schemas. Unlike the sixteen managed tools, a native extension is
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
// Formerly-reported representability gap (ADR-0175 D3: "unsupported dialect semantics are
// incompatibility, never silently omitted keywords"), now partially closed: schema.ts's closed
// dialect gained a `pattern` keyword (TYPE_KEYS.string, enforced both at compile time and at
// match time), so `relativePath` (path traversal), `expectedContentHash` (hex-64), `target`
// (https-only) and `skillId` (skill-id shape) below now carry the exact same regex the real
// OpenCode wire schemas use (opencodeToolSchemas.ts), rather than omitting the format check. This
// projection is still NOT the source OPENCODE_MODEL_VISIBLE_TOOLS/OPENCODE_TOOL_SOURCE_DEFINITIONS
// are generated from (see the header note above) — that consolidation, and matching
// `codingToolIpc.ts`'s independent action vocabulary to this one, remain open (#3414 follow-up).
// `keiko.file.read`'s `path` in legacy.ts stays pattern-free; that is a separate, still-open case.
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { DEFAULT_SANDBOX_POLICY } from "@oscharko-dev/keiko-contracts/runtime/tools";
import { CODING_RUNTIME_GIT_MAX_PATHS } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import { CODING_REPOSITORY_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
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
export const OPENCODE_NATIVE_EXTENSION_DEFINITIONS: readonly OpenCodeNativeExtensionDefinition[] = [
  {
    alias: "question",
    contractVersion: 1,
    description: "Ask the operator one or more structured clarifying questions before proceeding.",
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
  const sortedRequired = [...required].sort(compareStrings);
  return {
    type: "object",
    properties,
    required: sortedRequired,
    additionalProperties: true,
  };
}

interface OpenCodeToolSpec {
  readonly canonicalId: string;
  readonly alias: string;
  readonly description: string;
  readonly inputSchema: CatalogJsonObject;
  /** One or more `CodingWorkbenchActionClass` effects (ties to gitOperationRequirements.ts's own classification for the same operation -- never a second formula). */
  readonly effects: readonly CatalogEffect[];
  readonly idempotency: CatalogIdempotency;
  readonly handlerId: string;
}

const OPENCODE_RESULT_SCHEMA: CatalogJsonObject = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [
        "completed",
        "failed",
        "denied",
        "invalid",
        "cancelled",
        "timeout",
        "busy",
        "observed",
      ],
    },
    evidence: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", maxLength: 256 },
          code: { type: "string", maxLength: 256 },
        },
        required: ["kind", "code"],
        additionalProperties: false,
      },
    },
  },
  required: ["status", "evidence"],
  additionalProperties: true,
};

function entryFor(spec: OpenCodeToolSpec): CatalogSetEntry {
  return {
    alias: spec.alias,
    descriptor: createToolDescriptor({
      toolRef: createToolRef(spec.canonicalId, 1),
      description: spec.description,
      inputSchema: spec.inputSchema,
      resultSchema: OPENCODE_RESULT_SCHEMA,
      effects: spec.effects,
      actionMapping: [{ action: spec.alias, effects: spec.effects }],
      policyReferences: spec.effects,
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
    effects: ["workspace-read"],
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
        relativePath: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          // #3414 AC1: schema.ts now supports `pattern` — this is the exact real wire pattern
          // (opencodeToolSchemas.ts WORKSPACE_READ_SCHEMA.relativePath), no longer a format check
          // this advisory projection had to omit.
          pattern: String.raw`^(?![\\/])(?!.*(?:^|/)\.\.?(/|$))(?!.*\\).+$`,
        },
        startLine: { type: "integer", minimum: 1, maximum: OPENCODE_READ_MAX_START_LINE },
        maxLines: { type: "integer", minimum: 1, maximum: OPENCODE_READ_MAX_WINDOW_LINES },
      },
      ["relativePath", "startLine", "maxLines"],
    ),
    effects: ["workspace-read"],
    idempotency: "read-only",
    handlerId: "opencode-workspace-read-port",
  };
}

// #3406/#3414: projects #3386's H1 local repository-search handler (executeCodingRepositoryRequest
// in packages/keiko-workspace/src/codingRepositorySearch.ts, mounted server-side by
// packages/keiko-server/src/coding-runtime/productionManagedWorktreeTools.ts's
// `repositorySearch` port) as the model-visible tool `keiko_repository_search` under its reserved
// canonical identity `keiko.repo.search@1`. Field bounds are read back from the handler's own
// `CODING_REPOSITORY_LIMITS` (packages/keiko-contracts/src/coding-repository-search.ts) rather than
// restated, so a limit change there cannot silently diverge from the schema shown to the model.
// This is a search-only tool: `keiko_workspace_discover` remains path-only discovery and
// `keiko_workspace_read` remains the bounded-range read handoff a hit's `path`/`startLine`/
// `endLine` feeds into -- no semantic reranking and no read-kind request is ever projected here.
function repositorySearchSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.repo.search",
    alias: "keiko_repository_search",
    description:
      "Search the workspace's tracked text content for lexical, literal, regex or symbol " +
      "matches, returning bounded content excerpts with file path and line range.",
    inputSchema: managedObjectSchema(
      {
        mode: { type: "string", enum: ["lexical", "literal", "regex", "symbol"] },
        query: { type: "string", minLength: 1, maxLength: CODING_REPOSITORY_LIMITS.queryChars },
        caseSensitive: { type: "boolean" },
        includeGlobs: {
          type: "array",
          maxItems: CODING_REPOSITORY_LIMITS.globs,
          items: {
            type: "string",
            minLength: 1,
            maxLength: CODING_REPOSITORY_LIMITS.globChars,
          },
        },
        excludeGlobs: {
          type: "array",
          maxItems: CODING_REPOSITORY_LIMITS.globs,
          items: {
            type: "string",
            minLength: 1,
            maxLength: CODING_REPOSITORY_LIMITS.globChars,
          },
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: CODING_REPOSITORY_LIMITS.returnedHits,
        },
      },
      ["mode", "query", "caseSensitive", "includeGlobs", "excludeGlobs", "maxResults"],
    ),
    effects: ["workspace-read"],
    idempotency: "read-only",
    handlerId: "opencode-repository-search-port",
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
      // #3414 AC1: exact real wire pattern (opencodeToolSchemas.ts's `expectedContentHash`).
      expectedContentHash: {
        type: "string",
        minLength: 64,
        maxLength: 64,
        pattern: "^[a-f0-9]{64}$",
      },
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
    effects: ["workspace-write"],
    idempotency: "server-key-required",
    handlerId: "opencode-changeset-edit-port",
  };
}

function verificationSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.verification.run",
    alias: "keiko_verification",
    description:
      "Run one named verification gate (test, typecheck, lint or build). Ordinary working-tree " +
      "tests may pass without commit proof. For a commit, execute a ready stage proposal, or an " +
      "approval-required stage proposal after approval, then rerun verification and proceed only " +
      'when the result reports verification: { commitProof: "recorded" }. A ' +
      "candidate-not-staged result with nextAction stage-then-verify requires staging and another " +
      "verification run.",
    inputSchema: managedObjectSchema(
      {
        verifierId: {
          type: "string",
          enum: ["test", "targeted-test", "typecheck", "lint", "build"],
        },
      },
      ["verifierId"],
    ),
    effects: ["verification"],
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
      {
        // #3414 AC1: exact real wire pattern (opencodeToolSchemas.ts RESEARCH_FETCH_SCHEMA).
        target: { type: "string", minLength: 9, maxLength: 512, pattern: "^https://" },
      },
      ["target"],
    ),
    effects: ["network-egress"],
    idempotency: "server-key-required",
    handlerId: "opencode-research-fetch-port",
  };
}

function skillSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.skill.invoke",
    alias: "keiko_skill",
    description: "Invoke one approved, read-only skill by its pinned identifier.",
    inputSchema: managedObjectSchema(
      {
        // #3414 AC1: exact real wire pattern (opencodeToolSchemas.ts SKILL_SCHEMA.skillId).
        skillId: {
          type: "string",
          maxLength: 80,
          pattern: String.raw`^skl_[a-z0-9][a-z0-9-]{0,62}@[0-9]{1,4}(?:\.[0-9]{1,4}){0,2}$`,
        },
      },
      ["skillId"],
    ),
    effects: ["workspace-read"],
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
    effects: ["workspace-read"],
    idempotency: "read-only",
    handlerId: "opencode-child-agent-port",
  };
}

// #3386/#3387/#3388: the Git status/diff/stage/commit, push/pull-request and CI-observation
// specs. For status/diff/stage/commit/push/pull-request, effects mirror
// packages/keiko-server/src/coding-runtime/gitOperationRequirements.ts's own per-operation
// classification exactly (the live authority-envelope classification this catalog must never
// disagree with) -- status/diff read-only, stage a local write, commit delivery-substrate,
// push/pull-request delivery-substrate plus network-egress. gitOperationRequirements.ts has no CI
// entry; CI observation instead mirrors codingToolIpc.ts's concrete read-only provider poll:
// workspace-read plus connector-access and network-egress. None of these five schemas can express the
// format-level regexes
// (proposalId prefix, control-character-free title) the real OpenCode wire schemas pin in
// packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts -- the same documented
// `pattern`-keyword gap this file's header comment already covers for `keiko.changeset.edit`; those
// checks stay owned by the real handler, never this advisory, model-facing schema.
function gitStatusSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.git.status",
    alias: "keiko_git_status",
    description: "Read the workspace's current Git status.",
    inputSchema: managedObjectSchema({}, []),
    effects: ["workspace-read"],
    idempotency: "read-only",
    handlerId: "opencode-git-status-port",
  };
}

function gitDiffSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.git.diff",
    alias: "keiko_git_diff",
    description: "Read one bounded Git diff (working-tree or staged) for given paths.",
    inputSchema: managedObjectSchema(
      {
        scope: { type: "string", enum: ["working-tree", "index"] },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: CODING_RUNTIME_GIT_MAX_PATHS,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
      ["scope", "paths"],
    ),
    effects: ["workspace-read"],
    idempotency: "read-only",
    handlerId: "opencode-git-diff-port",
  };
}

function gitStageSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.git.stage",
    alias: "keiko_git_stage",
    description:
      "Create a non-mutating proposal to stage one or more workspace-relative paths. This call " +
      "does not mutate the Git index. If the result is ready, call keiko_git_execute with kind " +
      "stage and the returned proposalId. If the result is approval-required, wait for approval " +
      "before calling that execute tool. Execute staging before rerunning verification for commit " +
      "proof.",
    inputSchema: managedObjectSchema(
      {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: CODING_RUNTIME_GIT_MAX_PATHS,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
      ["paths"],
    ),
    effects: ["workspace-write"],
    idempotency: "server-key-required",
    handlerId: "opencode-git-stage-port",
  };
}

function gitCommitSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.git.commit",
    alias: "keiko_git_commit",
    description:
      "Create an approval-required commit proposal over the staged changes. This call does not " +
      "create a commit. First complete staging and rerun verification until it reports " +
      'verification: { commitProof: "recorded" }. After commit approval, call ' +
      "keiko_git_execute with kind commit and the returned proposalId.",
    inputSchema: managedObjectSchema(
      { message: { type: "string", minLength: 1, maxLength: 8_192 } },
      ["message"],
    ),
    effects: ["delivery-substrate"],
    idempotency: "server-key-required",
    handlerId: "opencode-git-commit-port",
  };
}

function gitPushSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.git.push",
    alias: "keiko_git_push",
    description: "Propose pushing the last verified commit by its exact SHA.",
    inputSchema: managedObjectSchema({}, []),
    effects: ["delivery-substrate", "network-egress"],
    idempotency: "server-key-required",
    handlerId: "opencode-git-push-port",
  };
}

function gitPullRequestSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.git.pullrequest",
    alias: "keiko_pull_request",
    description: "Propose opening a draft pull request with the given title.",
    inputSchema: managedObjectSchema({ title: { type: "string", minLength: 1, maxLength: 256 } }, [
      "title",
    ]),
    effects: ["delivery-substrate", "network-egress"],
    idempotency: "server-key-required",
    handlerId: "opencode-git-pull-request-port",
  };
}

function gitExecuteSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.git.execute",
    alias: "keiko_git_execute",
    description:
      "Execute a stage, commit, push or pull-request proposal when its result is ready, or after " +
      "approval when its result is approval-required, using its matching kind and returned " +
      "proposalId. Stage execution mutates the Git index and must complete before commit-grade " +
      "verification; proposal tools alone perform no Git mutation.",
    inputSchema: managedObjectSchema(
      {
        kind: { type: "string", enum: ["stage", "commit", "push", "pull-request"] },
        proposalId: { type: "string", minLength: 1, maxLength: 64 },
      },
      ["kind", "proposalId"],
    ),
    effects: ["workspace-write", "delivery-substrate", "network-egress"],
    idempotency: "server-key-required",
    handlerId: "opencode-git-execute-port",
  };
}

function ciStatusSpec(): OpenCodeToolSpec {
  return {
    canonicalId: "keiko.ci.status",
    alias: "keiko_ci_status",
    description: "Observe the accepted run's CI readiness.",
    inputSchema: managedObjectSchema({ forceFresh: { type: "boolean" } }, ["forceFresh"]),
    effects: ["workspace-read", "connector-access", "network-egress"],
    idempotency: "server-key-required",
    handlerId: "opencode-ci-status-port",
  };
}

/**
 * The canonical "opencode" registration set (ADR-0175 D2). Declares the sixteen managed-OpenCode
 * governed tools plus the two exhaustively-declared native extensions (`nativeExtensions` is
 * derived from `OPENCODE_NATIVE_EXTENSION_DEFINITIONS` above, the same single source consumers use
 * for their pinned wire schemas). `keiko_repository_search` (H1, #3386) is a member as of #3414:
 * its handler is implemented and mounted server-side; see `repositorySearchSpec` above.
 * `keiko.changeset.edit`'s descriptor is a structurally-equivalent, strictly LOOSER projection of
 * the real wire schema (all fields required, nested `additionalProperties` stripped-as-true) --
 * see `changesetEditSpec` above for exactly why and why that is safe for its one consumer; the
 * eight #3386/#3387/#3388 Git/CI specs above have the same relationship to their own hand-authored
 * real wire schemas.
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
      repositorySearchSpec(),
      changesetEditSpec(),
      verificationSpec(),
      researchFetchSpec(),
      skillSpec(),
      childRunSpec(),
      gitStatusSpec(),
      gitDiffSpec(),
      gitStageSpec(),
      gitCommitSpec(),
      gitPushSpec(),
      gitPullRequestSpec(),
      gitExecuteSpec(),
      ciStatusSpec(),
    ].map(entryFor),
  };
}
