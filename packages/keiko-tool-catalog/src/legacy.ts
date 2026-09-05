import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { DEFAULT_SANDBOX_POLICY } from "@oscharko-dev/keiko-contracts/runtime/tools";
import type {
  CatalogEffect,
  CatalogJsonObject,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createToolRef } from "./identity.js";
import { createToolDescriptor } from "./descriptor.js";
import type { ToolCatalog } from "./catalog.js";
import { createKeikoToolCatalog, type CatalogRegistrationSet } from "./composer.js";

interface LegacyRegistration {
  readonly alias: string;
  readonly descriptor: ToolDescriptor;
}
function objectSchema(
  properties: CatalogJsonObject,
  required: readonly string[],
): CatalogJsonObject {
  return { type: "object", properties, required, additionalProperties: false };
}
function registration(
  canonicalId: string,
  alias: string,
  description: string,
  inputSchema: CatalogJsonObject,
  effect: CatalogEffect = "workspace-read",
): LegacyRegistration {
  return {
    alias,
    descriptor: createToolDescriptor({
      toolRef: createToolRef(canonicalId, 1),
      description,
      inputSchema,
      resultSchema: { type: "string", maxLength: TOOL_CATALOG_LIMITS.maxStringBytes },
      effects: [effect],
      actionMapping: [{ action: alias, effects: [effect] }],
      policyReferences: [effect],
      handlerRequirement: { id: "legacy-tool-port", contractVersion: 1 },
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
function reads(): readonly LegacyRegistration[] {
  return [
    registration(
      "keiko.file.read",
      "read_file",
      "Read a UTF-8 file inside the workspace. Output is redacted; files above the byte cap are rejected.",
      objectSchema(
        {
          path: { type: "string", minLength: 1, description: "Workspace-relative file path." },
          maxBytes: { type: "number", minimum: 0, description: "Optional read cap in bytes." },
        },
        ["path"],
      ),
    ),
    registration(
      "keiko.file.list",
      "list_files",
      "List workspace files (deny-list and optional .gitignore applied).",
      objectSchema(
        {
          maxDepth: { type: "number", minimum: 0, description: "Optional recursion depth cap." },
          maxFiles: { type: "number", minimum: 0, description: "Optional result count cap." },
          applyGitignore: { type: "boolean", description: "Apply the .gitignore subset." },
        },
        [],
      ),
    ),
    registration(
      "keiko.package.scripts",
      "inspect_package_scripts",
      "Return the `scripts` object from a package.json inside the workspace.",
      objectSchema(
        { path: { type: "string", description: "Optional path; defaults to package.json." } },
        [],
      ),
    ),
  ];
}
function command(): LegacyRegistration {
  return registration(
    "keiko.command.run",
    "run_command",
    "Run an allowlisted read-only command (npm/git by default) with no shell, a clean env, " +
      "a trusted executable path, a workspace cwd, a timeout, and capped redacted output.",
    objectSchema(
      {
        command: {
          type: "string",
          minLength: 1,
          description: "Bare executable name (PATH-resolved).",
        },
        args: { type: "array", items: { type: "string" }, description: "Argument vector." },
        cwd: { type: "string", description: "Optional workspace-relative working directory." },
        timeoutMs: { type: "number", minimum: 0, description: "Optional wall-time budget in ms." },
      },
      ["command"],
    ),
    "command-execution",
  );
}
function patches(): readonly LegacyRegistration[] {
  const schema = objectSchema(
    { diff: { type: "string", minLength: 1, description: "Unified diff text." } },
    ["diff"],
  );
  return [
    registration(
      "keiko.patch.propose",
      "propose_patch",
      "Validate a unified diff and return a dry-run preview. Never writes to disk.",
      schema,
    ),
    registration(
      "keiko.patch.apply",
      "apply_patch",
      "Apply a validated unified diff atomically. Fail-closed: refuses unless apply is enabled.",
      schema,
      "workspace-write",
    ),
  ];
}
/** The "legacy-native" registration set: the six existing implemented legacy handlers. */
export function legacyNativeRegistrationSet(): CatalogRegistrationSet {
  const entries = [...reads(), command(), ...patches()];
  return {
    profile: { id: "legacy-native", version: 1 },
    adapterDialect: { id: "legacy-json-schema", version: 1 },
    adapterRuntime: { id: "keiko", version: "0.3.17" },
    nativeExtensions: [],
    compatibility: [],
    entries,
  };
}

/** Version-bound metadata for implemented legacy handlers. Binding still decides readiness and authority. */
export function createInitialToolCatalog(): ToolCatalog {
  return createKeikoToolCatalog([legacyNativeRegistrationSet()]);
}
