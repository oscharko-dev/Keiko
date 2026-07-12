import { createHash } from "node:crypto";

export const OPENCODE_PINNED_VERSION = "1.17.17";

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
      pattern: "^(?![\\\\/])(?!.*(?:^|/)\\.\\.?(/|$))(?!.*\\\\).+$",
    },
  },
  required: ["relativePath"],
} as const;

const CHANGESET_EDIT_SCHEMA = {
  type: "object",
  properties: {
    changeset: {
      type: "object",
      additionalProperties: false,
      properties: {
        patch: { type: "string", maxLength: 262_144 },
        files: { type: "array", maxItems: 256 },
        selectedFiles: { type: "array", maxItems: 256 },
        prepared: { type: "object" },
      },
    },
  },
  required: ["changeset"],
} as const;

export const OPENCODE_MODEL_VISIBLE_TOOLS = [
  { name: "question", parameters: QUESTION_SCHEMA },
  { name: "keiko_workspace_read", parameters: WORKSPACE_READ_SCHEMA },
  { name: "keiko_changeset_edit", parameters: CHANGESET_EDIT_SCHEMA },
] as const;

export const OPENCODE_MODEL_VISIBLE_TOOL_NAMES = OPENCODE_MODEL_VISIBLE_TOOLS.map(
  ({ name }) => name,
);

export const OPENCODE_TOOL_SOURCE_DEFINITIONS = [
  {
    name: "keiko_workspace_read",
    action: "read",
    argument: "relativePath",
    inputSchema: WORKSPACE_READ_SCHEMA.properties.relativePath,
  },
  {
    name: "keiko_changeset_edit",
    action: "edit",
    argument: "changeset",
    inputSchema: CHANGESET_EDIT_SCHEMA.properties.changeset,
  },
] as const;

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
  "todowrite",
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
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function schemaDigest(schema: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(stableJson(schema), "utf8").digest("hex");
}

const EXPECTED_SCHEMA_DIGESTS: ReadonlyMap<string, string> = new Map(
  OPENCODE_MODEL_VISIBLE_TOOLS.map(({ name, parameters }) => [name, schemaDigest(parameters)]),
);

export function hasExactOpenCodeVisibleToolContract(
  tools: readonly OpenCodeToolInput[] | undefined,
): boolean {
  if (tools?.length !== OPENCODE_MODEL_VISIBLE_TOOLS.length) return false;
  const names = new Set(tools.map(({ name }) => name));
  return (
    names.size === OPENCODE_MODEL_VISIBLE_TOOLS.length &&
    tools.every(
      ({ name, parameters }) => EXPECTED_SCHEMA_DIGESTS.get(name) === schemaDigest(parameters),
    )
  );
}
