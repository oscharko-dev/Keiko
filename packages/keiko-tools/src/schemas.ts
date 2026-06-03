// The model-facing tool contract: 6 ToolDefinitions with JSON-Schema `parameters`. Kept apart
// from registry.ts so the dispatch logic stays small and the schema table is a single frozen
// surface the gateway/model see. No runtime logic — just the frozen definitions.

import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";

function obj(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  {
    name: "read_file",
    description:
      "Read a UTF-8 file inside the workspace. Output is redacted; files above the byte cap are rejected.",
    parameters: obj(
      {
        path: { type: "string", description: "Workspace-relative file path." },
        maxBytes: { type: "number", description: "Optional read cap in bytes." },
      },
      ["path"],
    ),
  },
  {
    name: "list_files",
    description: "List workspace files (deny-list and optional .gitignore applied).",
    parameters: obj(
      {
        maxDepth: { type: "number", description: "Optional recursion depth cap." },
        maxFiles: { type: "number", description: "Optional result count cap." },
        applyGitignore: { type: "boolean", description: "Apply the .gitignore subset." },
      },
      [],
    ),
  },
  {
    name: "inspect_package_scripts",
    description: "Return the `scripts` object from a package.json inside the workspace.",
    parameters: obj(
      { path: { type: "string", description: "Optional path; defaults to package.json." } },
      [],
    ),
  },
  {
    name: "run_command",
    description:
      "Run an allowlisted read-only command (npm/git by default) with no shell, a clean env, " +
      "a trusted executable path, a workspace cwd, a timeout, and capped redacted output.",
    parameters: obj(
      {
        command: { type: "string", description: "Bare executable name (PATH-resolved)." },
        args: { type: "array", items: { type: "string" }, description: "Argument vector." },
        cwd: { type: "string", description: "Optional workspace-relative working directory." },
        timeoutMs: { type: "number", description: "Optional wall-time budget in ms." },
      },
      ["command"],
    ),
  },
  {
    name: "propose_patch",
    description: "Validate a unified diff and return a dry-run preview. Never writes to disk.",
    parameters: obj({ diff: { type: "string", description: "Unified diff text." } }, ["diff"]),
  },
  {
    name: "apply_patch",
    description:
      "Apply a validated unified diff atomically. Fail-closed: refuses unless apply is enabled.",
    parameters: obj({ diff: { type: "string", description: "Unified diff text." } }, ["diff"]),
  },
]);
