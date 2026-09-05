import { createHash, randomUUID } from "node:crypto";

import {
  compileToolProjection,
  createKeikoToolCatalog,
  opencodeRegistrationSet,
} from "@oscharko-dev/keiko-tool-catalog";
import type { GatewayToolCatalogAdvertisement } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import {
  CODING_TOOL_DISCOVER_MAX_RESULTS,
  CODING_TOOL_READ_MAX_START_LINE,
  CODING_TOOL_READ_MAX_WINDOW_LINES,
} from "./codingToolIpc.js";

export const OPENCODE_PINNED_VERSION = "1.17.17";
export const OPENCODE_GOVERNED_ACTION_PERMISSION = "keiko_governed_action";

const QUESTION_SCHEMA = {
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
} as const;

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
const TODO_WRITE_SCHEMA = {
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
} as const;

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

export const OPENCODE_MODEL_VISIBLE_TOOLS = [
  { name: "question", parameters: QUESTION_SCHEMA },
  { name: "keiko_workspace_discover", parameters: WORKSPACE_DISCOVER_SCHEMA },
  { name: "keiko_workspace_read", parameters: WORKSPACE_READ_SCHEMA },
  { name: "keiko_changeset_edit", parameters: CHANGESET_EDIT_SCHEMA },
  { name: "keiko_verification", parameters: VERIFICATION_SCHEMA },
  { name: "keiko_research_fetch", parameters: RESEARCH_FETCH_SCHEMA },
  { name: "keiko_skill", parameters: SKILL_SCHEMA },
  { name: "keiko_child_agent", parameters: CHILD_AGENT_SCHEMA },
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
