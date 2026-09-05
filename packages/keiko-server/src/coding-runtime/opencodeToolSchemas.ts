import { createHash, randomUUID } from "node:crypto";

import {
  compileToolProjection,
  createKeikoToolCatalog,
  opencodeRegistrationSet,
  OPENCODE_NATIVE_EXTENSION_DEFINITIONS,
} from "@oscharko-dev/keiko-tool-catalog";
import type { GatewayToolCatalogAdvertisement } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import { CODING_RUNTIME_GIT_MAX_PATHS } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import { CODING_REPOSITORY_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import {
  CODING_TOOL_DISCOVER_MAX_RESULTS,
  CODING_TOOL_READ_MAX_START_LINE,
  CODING_TOOL_READ_MAX_WINDOW_LINES,
} from "./codingToolIpc.js";
import { proposalIdPattern } from "../gitDelivery/proposalId.js";

export const OPENCODE_PINNED_VERSION = "1.17.17";
export const OPENCODE_GOVERNED_ACTION_PERMISSION = "keiko_governed_action";

/**
 * The two native extensions' exact pinned wire schemas live in
 * `@oscharko-dev/keiko-tool-catalog`'s `OPENCODE_NATIVE_EXTENSION_DEFINITIONS` (one source,
 * imported back here); see that package's opencode.ts header comment for why.
 */
function nativeExtensionSchema(alias: "question" | "todowrite"): Readonly<Record<string, unknown>> {
  const definition = OPENCODE_NATIVE_EXTENSION_DEFINITIONS.find((entry) => entry.alias === alias);
  if (definition === undefined)
    throw new TypeError(`Missing native extension definition: ${alias}`);
  return definition.inputSchema;
}

const QUESTION_SCHEMA = nativeExtensionSchema("question");

const WORKSPACE_READ_SCHEMA = {
  type: "object",
  properties: {
    relativePath: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: String.raw`^(?![\\/])(?!.*(?:^|/)\.\.?(/|$))(?!.*\\).+$`,
    },
    startLine: {
      type: "integer",
      minimum: 1,
      maximum: CODING_TOOL_READ_MAX_START_LINE,
      description: "1-based first line of the returned window; pass 1 to start at the file head.",
    },
    maxLines: {
      type: "integer",
      minimum: 1,
      maximum: CODING_TOOL_READ_MAX_WINDOW_LINES,
      description:
        "Window height in lines; startLine 1 with maxLines 5000 reads a small file whole. The result reports totalLines and, when truncated, nextStartLine; the digest always covers the whole file.",
    },
  },
  // OpenCode v1.17.17 declares every custom-tool argument as required in its provider
  // projection, so the pinned model-visible contract must require the window fields too.
  required: ["relativePath", "startLine", "maxLines"],
} as const;

// #3406/#3414: projects #3386's H1 local repository-search handler (executeCodingRepositoryRequest
// in packages/keiko-workspace/src/codingRepositorySearch.ts) as the model-visible tool
// `keiko_repository_search`. Bounds are read back from the handler's own `CODING_REPOSITORY_LIMITS`
// (packages/keiko-contracts/src/coding-repository-search.ts), never restated. Search-only: a hit's
// path/startLine/endLine feeds keiko_workspace_read for the bounded-range read handoff; there is no
// read kind here and no semantic reranking.
const REPOSITORY_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["lexical", "literal", "regex", "symbol"],
      description:
        "lexical: natural-language keyword match. literal: exact substring. regex: bounded, " +
        "ReDoS-safe pattern. symbol: exact identifier (no whitespace).",
    },
    query: {
      type: "string",
      minLength: 1,
      maxLength: CODING_REPOSITORY_LIMITS.queryChars,
      description: "Search text for the selected mode.",
    },
    caseSensitive: { type: "boolean" },
    includeGlobs: {
      type: "array",
      maxItems: CODING_REPOSITORY_LIMITS.globs,
      items: { type: "string", minLength: 1, maxLength: CODING_REPOSITORY_LIMITS.globChars },
      description: "Workspace-relative glob patterns to restrict the search to.",
    },
    excludeGlobs: {
      type: "array",
      maxItems: CODING_REPOSITORY_LIMITS.globs,
      items: { type: "string", minLength: 1, maxLength: CODING_REPOSITORY_LIMITS.globChars },
      description: "Workspace-relative glob patterns to exclude from the search.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: CODING_REPOSITORY_LIMITS.returnedHits,
      description: "Maximum number of bounded content excerpts to return.",
    },
  },
  required: ["mode", "query", "caseSensitive", "includeGlobs", "excludeGlobs", "maxResults"],
} as const;

const WORKSPACE_DISCOVER_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description:
        "Case-insensitive filename/path keywords. Use a short distinctive term such as safeActivity, timeline, or composer. Use * only when a bounded repository overview is necessary.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: CODING_TOOL_DISCOVER_MAX_RESULTS,
      description: "Maximum number of matching workspace-relative file paths to return.",
    },
  },
  required: ["query", "maxResults"],
} as const;

const CHANGESET_EDIT_SCHEMA = {
  type: "object",
  properties: {
    changeset: {
      type: "object",
      additionalProperties: false,
      properties: {
        patch: {
          type: "string",
          minLength: 1,
          maxLength: 65_536,
          pattern: String.raw`^(?:(?:(?:diff --git [^\r\n]+ [^\r\n]+\r?\n)(?:index [^\r\n]+\r?\n)?)?--- (?:a/|/dev/null)|:[0-7]{6} [0-7]{6} [a-f0-9]{7,64} [a-f0-9]{7,64} M [^\r\n]+\r?\n@@ )`,
          description:
            "Strict unified diff for every listed file. Start each file with `--- a/<path>` and `+++ b/<path>` (or `/dev/null`), followed by one or more `@@ -old +new @@` hunks. A single-file `:100644 ... M <path>` raw-index header is accepted only as a compatibility fallback and is normalized before validation.",
        },
        files: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              file: {
                type: "string",
                minLength: 1,
                maxLength: 512,
                pattern: String.raw`^(?![\\/])(?!.*(?:^|/)\.\.?(/|$))(?!.*\\).+$`,
              },
              expectedContentHash: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
                description: "SHA-256 digest returned by keiko_workspace_read.",
              },
            },
            required: ["file", "expectedContentHash"],
          },
          description: "Every file changed by patch, bound to its last governed read digest.",
        },
        selectedFiles: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            pattern: String.raw`^(?![\\/])(?!.*(?:^|/)\.\.?(/|$))(?!.*\\).+$`,
          },
          description: "Optional subset of files to apply; each entry must occur in files.",
        },
      },
      required: ["patch", "files"],
    },
  },
  required: ["changeset"],
} as const;

const VERIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verifierId: {
      type: "string",
      enum: ["test", "targeted-test", "typecheck", "lint", "build"],
    },
  },
  required: ["verifierId"],
} as const;

/** OpenCode v1.17.17 removes this unsupported JSON Schema keyword before forwarding a tool. */
const VERIFICATION_PROJECTED_SCHEMA = {
  type: "object",
  properties: {
    verifierId: {
      type: "string",
      enum: ["test", "targeted-test", "typecheck", "lint", "build"],
    },
  },
  required: ["verifierId"],
} as const;

/**
 * Exact v1.17.17 built-in `todowrite` projection (#2480). Status/priority are deliberately plain
 * strings upstream; Keiko enforces the closed status vocabulary at the safe-activity normalizer,
 * never here, or the gateway digest comparison would reject the child's declared contract.
 */
const TODO_WRITE_SCHEMA = nativeExtensionSchema("todowrite");

// #2387 read-only public research: one exact https URL per call. The server side enforces the real
// policy (grant, host allowlist, request-line binding, budgets); this schema only bounds the shape.
const RESEARCH_FETCH_SCHEMA = {
  type: "object",
  properties: {
    target: {
      type: "string",
      minLength: 9,
      maxLength: 512,
      pattern: "^https://",
    },
  },
  required: ["target"],
} as const;

const SKILL_SCHEMA = {
  type: "object",
  properties: {
    skillId: {
      type: "string",
      // Character classes are spelled out, NOT `\d`: this string is part of the digest-pinned
      // visible schema surface handed to the pinned OpenCode child, so its bytes are a wire
      // contract. Re-spelling it changes the canonical digest and the runtime is refused 403.
      pattern: String.raw`^skl_[a-z0-9][a-z0-9-]{0,62}@[0-9]{1,4}(?:\.[0-9]{1,4}){0,2}$`,
      maxLength: 80,
    },
  },
  required: ["skillId"],
} as const;

const CHILD_AGENT_SCHEMA = {
  type: "object",
  properties: {
    objective: { type: "string", minLength: 1, maxLength: 512 },
    maxToolCalls: { type: "integer", minimum: 1, maximum: 32 },
  },
  required: ["objective", "maxToolCalls"],
} as const;

// #3386/#3387/#3388: the Git status/diff/stage/commit, push/pull-request and CI-observation
// tools. Every arguments field the model can supply is server-validated by the existing
// codingToolIpc.ts wire parsers (codingRuntimeGitIpc.ts's `RuntimeGitRequest`,
// codingRuntimeDeliveryIpc.ts's `DraftToolRequest`, VerifiedCommitService's commit propose/execute
// branch) -- these schemas only bound the shape shown to the model, never the enforcement boundary.
// A path/SHA/proposal identity handed back by the server is never re-validated by the model; the
// model never commits, pushes or opens a PR directly, it only proposes and, once a human approves
// through the existing Workbench approval channel, redeems the resulting proposalId.
const GIT_STATUS_SCHEMA = { type: "object", properties: {}, required: [] } as const;

const GIT_PUSH_SCHEMA = { type: "object", properties: {}, required: [] } as const;

const GIT_DIFF_SCHEMA = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["working-tree", "index"] },
    paths: {
      type: "array",
      minItems: 1,
      maxItems: CODING_RUNTIME_GIT_MAX_PATHS,
      items: { type: "string", minLength: 1, maxLength: 512 },
      description: "Workspace-relative paths to diff; denied or ignored paths never appear.",
    },
  },
  required: ["scope", "paths"],
} as const;

const GIT_STAGE_SCHEMA = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      minItems: 1,
      maxItems: CODING_RUNTIME_GIT_MAX_PATHS,
      items: { type: "string", minLength: 1, maxLength: 512 },
      description: "Workspace-relative paths to propose staging.",
    },
  },
  required: ["paths"],
} as const;

const GIT_COMMIT_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: "string",
      minLength: 1,
      maxLength: 8_192,
      description: "Proposed commit message. This proposes only; a human approval is required.",
    },
  },
  required: ["message"],
} as const;

const GIT_PULL_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: String.raw`^[^\0\r\n]+$`,
      description: "Proposed draft pull-request title.",
    },
  },
  required: ["title"],
} as const;

const GIT_CI_STATUS_SCHEMA = {
  type: "object",
  properties: {
    forceFresh: {
      type: "boolean",
      description:
        "Set true to bypass the cached readiness snapshot and force one fresh provider read.",
    },
  },
  required: ["forceFresh"],
} as const;

// The four write-class proposals (stage/commit/push/pull-request) share one redemption tool: once
// the Workbench approval channel admits a proposal, the model redeems it by kind + proposalId
// rather than each proposal type growing its own execute-phase tool.
// The proposalId pattern below is derived from gitDelivery/proposalId.ts's PROPOSAL_ID_PREFIXES,
// the single source of truth for the three prefixes the server actually mints for these four
// redeemable kinds: "stage" (runtimeGitService.ts), "commit" (verifiedCommitService.ts's
// VerifiedCommitService.propose()), and "push"/"pull-request" (both minted via
// draftDeliveryId("delivery") in draftDeliveryFacts.ts) -- three prefixes for four kinds, not two.
const GIT_EXECUTE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["stage", "commit", "push", "pull-request"] },
    proposalId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: proposalIdPattern(),
      description: "The proposalId returned by the matching propose-phase tool call.",
    },
  },
  required: ["kind", "proposalId"],
} as const;

export const OPENCODE_MODEL_VISIBLE_TOOLS = [
  { name: "question", parameters: QUESTION_SCHEMA },
  { name: "keiko_workspace_discover", parameters: WORKSPACE_DISCOVER_SCHEMA },
  { name: "keiko_workspace_read", parameters: WORKSPACE_READ_SCHEMA },
  { name: "keiko_repository_search", parameters: REPOSITORY_SEARCH_SCHEMA },
  { name: "keiko_changeset_edit", parameters: CHANGESET_EDIT_SCHEMA },
  { name: "keiko_verification", parameters: VERIFICATION_SCHEMA },
  { name: "keiko_research_fetch", parameters: RESEARCH_FETCH_SCHEMA },
  { name: "keiko_skill", parameters: SKILL_SCHEMA },
  { name: "keiko_child_agent", parameters: CHILD_AGENT_SCHEMA },
  { name: "keiko_git_status", parameters: GIT_STATUS_SCHEMA },
  { name: "keiko_git_diff", parameters: GIT_DIFF_SCHEMA },
  { name: "keiko_git_stage", parameters: GIT_STAGE_SCHEMA },
  { name: "keiko_git_commit", parameters: GIT_COMMIT_SCHEMA },
  { name: "keiko_git_push", parameters: GIT_PUSH_SCHEMA },
  { name: "keiko_pull_request", parameters: GIT_PULL_REQUEST_SCHEMA },
  { name: "keiko_git_execute", parameters: GIT_EXECUTE_SCHEMA },
  { name: "keiko_ci_status", parameters: GIT_CI_STATUS_SCHEMA },
  { name: "todowrite", parameters: TODO_WRITE_SCHEMA },
] as const;

export const OPENCODE_MODEL_VISIBLE_TOOL_NAMES = OPENCODE_MODEL_VISIBLE_TOOLS.map(
  ({ name }) => name,
);

export const OPENCODE_TOOL_SOURCE_DEFINITIONS = [
  {
    name: "keiko_workspace_discover",
    action: "discover",
    arguments: {
      query: WORKSPACE_DISCOVER_SCHEMA.properties.query,
      maxResults: WORKSPACE_DISCOVER_SCHEMA.properties.maxResults,
    },
  },
  {
    name: "keiko_workspace_read",
    action: "read",
    arguments: {
      relativePath: WORKSPACE_READ_SCHEMA.properties.relativePath,
      startLine: WORKSPACE_READ_SCHEMA.properties.startLine,
      maxLines: WORKSPACE_READ_SCHEMA.properties.maxLines,
    },
  },
  {
    name: "keiko_repository_search",
    action: "repository-search",
    arguments: {
      mode: REPOSITORY_SEARCH_SCHEMA.properties.mode,
      query: REPOSITORY_SEARCH_SCHEMA.properties.query,
      caseSensitive: REPOSITORY_SEARCH_SCHEMA.properties.caseSensitive,
      includeGlobs: REPOSITORY_SEARCH_SCHEMA.properties.includeGlobs,
      excludeGlobs: REPOSITORY_SEARCH_SCHEMA.properties.excludeGlobs,
      maxResults: REPOSITORY_SEARCH_SCHEMA.properties.maxResults,
    },
  },
  {
    name: "keiko_changeset_edit",
    action: "edit",
    arguments: { changeset: CHANGESET_EDIT_SCHEMA.properties.changeset },
  },
  {
    name: "keiko_verification",
    action: "verification",
    arguments: { verifierId: VERIFICATION_SCHEMA.properties.verifierId },
  },
  {
    name: "keiko_research_fetch",
    action: "egress",
    arguments: { target: RESEARCH_FETCH_SCHEMA.properties.target },
  },
  {
    name: "keiko_skill",
    action: "skill",
    arguments: { skillId: SKILL_SCHEMA.properties.skillId },
  },
  {
    name: "keiko_child_agent",
    action: "child-agent",
    arguments: {
      objective: CHILD_AGENT_SCHEMA.properties.objective,
      maxToolCalls: CHILD_AGENT_SCHEMA.properties.maxToolCalls,
    },
  },
  { name: "keiko_git_status", action: "git-status", arguments: {} },
  {
    name: "keiko_git_diff",
    action: "git-diff",
    arguments: { scope: GIT_DIFF_SCHEMA.properties.scope, paths: GIT_DIFF_SCHEMA.properties.paths },
  },
  {
    name: "keiko_git_stage",
    action: "git-stage",
    arguments: { paths: GIT_STAGE_SCHEMA.properties.paths },
  },
  {
    name: "keiko_git_commit",
    action: "git-commit",
    arguments: { message: GIT_COMMIT_SCHEMA.properties.message },
  },
  { name: "keiko_git_push", action: "git-push", arguments: {} },
  {
    name: "keiko_pull_request",
    action: "git-pull-request",
    arguments: { title: GIT_PULL_REQUEST_SCHEMA.properties.title },
  },
  {
    name: "keiko_git_execute",
    action: "git-execute",
    arguments: {
      kind: GIT_EXECUTE_SCHEMA.properties.kind,
      proposalId: GIT_EXECUTE_SCHEMA.properties.proposalId,
    },
  },
  {
    name: "keiko_ci_status",
    action: "git-ci",
    arguments: { forceFresh: GIT_CI_STATUS_SCHEMA.properties.forceFresh },
  },
] as const;

// `todowrite` left this deny list for OPENCODE_MODEL_VISIBLE_TOOLS (#2480 plan projection).
export const OPENCODE_PINNED_BUILT_IN_TOOLS = [
  "invalid",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "webfetch",
  "websearch",
  "skill",
  "apply_patch",
  "lsp",
  "plan",
  "execute",
  "git",
] as const;

interface OpenCodeToolInput {
  readonly name: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

/** Preserves the default code-unit sort so schema digests stay byte-stable across locales. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function schemaDigest(schema: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(stableJson(schema), "utf8").digest("hex");
}

/** Gateway requests contain OpenCode's v1.17.17 projection, not the generated source schema. */
const EXPECTED_GATEWAY_SCHEMA_DIGESTS: ReadonlyMap<string, string> = new Map(
  OPENCODE_MODEL_VISIBLE_TOOLS.map(({ name, parameters }) => [
    name,
    schemaDigest(name === "keiko_verification" ? VERIFICATION_PROJECTED_SCHEMA : parameters),
  ]),
);

export function hasExactOpenCodeVisibleToolContract(
  tools: readonly OpenCodeToolInput[] | undefined,
): boolean {
  if (tools?.length !== OPENCODE_MODEL_VISIBLE_TOOLS.length) return false;
  const names = new Set(tools.map(({ name }) => name));
  return (
    names.size === OPENCODE_MODEL_VISIBLE_TOOLS.length &&
    tools.every(
      ({ name, parameters }) =>
        EXPECTED_GATEWAY_SCHEMA_DIGESTS.get(name) === schemaDigest(parameters),
    )
  );
}

const OPENCODE_GATEWAY_PROFILE = { id: "opencode", version: 1 } as const;
const OPENCODE_GATEWAY_OFFER_LIFETIME_MS = 30_000;

/**
 * The catalog used to build the sidecar gateway's OUTGOING `toolCatalog` advertisement (the
 * function-calling schema shown to the underlying model). This composes the same fifteen governed
 * entries (the original seven workspace/verification tools plus the eight #3386/#3387/#3388
 * Git/CI tools) plus the two native extensions `@oscharko-dev/keiko-tool-catalog`'s
 * `opencodeRegistrationSet()` declares, unmodified: `packages/keiko-model-gateway/src/
 * toolCatalogBridge.ts`'s bridge merges a bound projection's native extensions into the
 * model-visible tool list and passes a call to one of their aliases straight through to the
 * sidecar, unbound (#3414 follow-up). This catalog is never used to validate incoming sidecar
 * requests, which stays `hasExactOpenCodeVisibleToolContract` above, pinned to the real OpenCode
 * 1.17.17 runtime's own generated tool source.
 */
const OPENCODE_GATEWAY_CATALOG = createKeikoToolCatalog([opencodeRegistrationSet()]);

/**
 * Builds the "bound" `toolCatalog` advertisement for one outgoing coding-sidecar-gateway request.
 * The model-gateway bridge derives the actual forwarded `tools` from this projection; the caller
 * must never also forward a raw `tools` field alongside it (ADR-0175 D1/D4).
 */
export function createOpenCodeGatewayToolCatalogAdvertisement(
  now: number,
): GatewayToolCatalogAdvertisement {
  const projection = compileToolProjection(OPENCODE_GATEWAY_CATALOG, OPENCODE_GATEWAY_PROFILE);
  return {
    kind: "bound",
    catalog: OPENCODE_GATEWAY_CATALOG,
    projection,
    offered: {
      binding: {
        catalogRevision: projection.catalogRevision,
        profile: projection.profile,
        projectionDigest: projection.projectionDigest,
        handlerSetDigest: projection.projectionDigest,
        readiness: "ready",
      },
      offerId: `opencode-gateway-${randomUUID()}`,
      toolRefs: projection.tools.map((tool) => tool.toolRef),
      expiresAt: new Date(now + OPENCODE_GATEWAY_OFFER_LIFETIME_MS).toISOString(),
    },
  };
}
