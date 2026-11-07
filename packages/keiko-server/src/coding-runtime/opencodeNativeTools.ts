import { createHash } from "node:crypto";

import {
  GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS,
  gatewayNativeToolDefinitionBytes,
  gatewayNativeToolSchemaBytes,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";

/**
 * The native tool inventory of the pinned OpenCode producer (#3897, #3908). It is captured from the
 * real binary, never hand-maintained: a routine upgrade regenerates the fixture and the
 * compatibility diff names every added or removed tool or permission action before the new
 * version is admitted. Keiko does not execute these tools; OpenCode does. Keiko binds the autonomy
 * mode to every call through the permission hook (`opencodeNativePolicy.ts`), so this inventory is
 * the vocabulary of what the hook must classify, not a list of handlers.
 */
export interface OpenCodeNativeToolDefinition {
  readonly id: string;
  /** The permission action OpenCode evaluates before the tool runs. */
  readonly action: string;
  /**
   * True for the Code Mode `execute` tool and the `opencode_*` management tools that exist only
   * inside it. The native profile keeps Code Mode available (owner decision, 2026-10-23); the
   * model sees these tools through the Code Mode catalog, never as top-level tools, and
   * `opencodeNativeProjectBoundary.real.test.ts` pins that advertisement against the real
   * executable.
   */
  readonly codemode: boolean;
}

const NATIVE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
/** A provider request may carry MCP and plugin tools beside the native ones; bound, not enumerated. */
/** The native advertisement's one byte contract, owned by the gateway contract (#3897 review). */
export const OPENCODE_NATIVE_TOOL_CONTRACT_MAX_TOOLS =
  GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS.maxTools;
export const OPENCODE_NATIVE_TOOL_CONTRACT_MAX_SCHEMA_BYTES =
  GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS.maxSchemaBytes;
export const OPENCODE_NATIVE_TOOL_CONTRACT_MAX_TOTAL_BYTES =
  GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS.maxTotalBytes;

/**
 * Captured from `ctx.tool.list()` of a plugin loaded by the pinned `opencode serve`;
 * `opencodeNativeTools.opencode-<version>.fixture.json` is the same capture, and the owning test pins
 * both to each other so neither can drift from the producer unnoticed.
 */
export const OPENCODE_NATIVE_TOOL_DEFINITIONS: readonly OpenCodeNativeToolDefinition[] =
  Object.freeze(
    (
      [
        ["read", "read", false],
        ["glob", "glob", false],
        ["grep", "grep", false],
        ["edit", "edit", false],
        ["write", "edit", false],
        ["patch", "edit", false],
        ["shell", "shell", false],
        ["webfetch", "webfetch", false],
        ["websearch", "websearch", false],
        ["skill", "skill", false],
        ["subagent", "subagent", false],
        ["question", "question", false],
        ["todowrite", "todowrite", false],
        ["execute", "execute", true],
        ["opencode_session_rename", "execute", true],
        ["opencode_session_move", "execute", true],
        ["opencode_worktree_create", "execute", true],
        ["opencode_worktree_list", "execute", true],
        ["opencode_worktree_remove", "edit", true],
        ["opencode_models", "execute", true],
        ["opencode_list_mcp_resources", "execute", true],
        ["opencode_read_mcp_resource", "execute", true],
      ] as const
    ).map(([id, action, codemode]) => Object.freeze({ id, action, codemode })),
  );

/**
 * The native tools outside Code Mode, in producer order: the registry the native profile draws its
 * advertisement from. The producer advertises the subset it enables for the agent and model alias,
 * and `opencodeNativeQualification.real.test.ts` pins the two rules against the real executable:
 * `patch` is registered for every model but advertised only to a model whose id contains `gpt-`
 * (not `gpt-4`, not `oss`), where it replaces `edit` and `write`, so the alias `coding` never sees
 * it; the plan tool `todowrite` is registered only under the producer's opt-in experimental
 * switch for it, which the native profile turns on (parity row T19).
 */
export const OPENCODE_NATIVE_TOOL_NAMES: readonly string[] = Object.freeze(
  OPENCODE_NATIVE_TOOL_DEFINITIONS.filter((tool) => !tool.codemode).map((tool) => tool.id),
);

/** Every permission action the pinned producer can evaluate; the policy must classify each. */
export const OPENCODE_NATIVE_PERMISSION_ACTIONS: readonly string[] = Object.freeze([
  "read",
  "glob",
  "grep",
  "list",
  "edit",
  "shell",
  "webfetch",
  "websearch",
  "skill",
  "subagent",
  "question",
  "todowrite",
  "execute",
  "external_directory",
  "doom_loop",
]);

const NATIVE_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  OPENCODE_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.id),
);

export function isOpenCodeNativeToolName(value: unknown): value is string {
  return typeof value === "string" && NATIVE_TOOL_NAME_SET.has(value);
}

/**
 * True when a completed tool part's own metadata says its work failed. The status of a part says
 * only that the tool returned, and two producers return a failure that way:
 * - A Code Mode `execute` whose JavaScript threw (#3897) carries the boolean `metadata.error`.
 * - A `shell` command that exited non-zero (#3901), ran out of its timeout (`metadata.timeout`) or
 *   was killed by a signal (`metadata.signal`, with no exit status at all; #4271) carries those.
 * A command moved to the background reports none of them and has not failed. No output text is
 * scanned and no body is read. The history projection (`opencodeV2History.ts`) and the event-part
 * projection (`opencodeSafeActivity.ts`) both call this, so the two cannot disagree on an outcome.
 */
export function isOpenCodeToolExecutionFailure(tool: unknown, state: unknown): boolean {
  if (!isPlainRecord(state) || state.status !== "completed") return false;
  if (!isPlainRecord(state.metadata)) return false;
  if (tool === "execute") return state.metadata.error === true;
  return tool === "shell" && isFailedShellResult(state.metadata);
}

/** The closed upstream token OpenCode reports when its own permission rules rejected a call. */
const OPENCODE_PERMISSION_REJECTED_ERROR_TYPE = "permission.rejected";

/**
 * True when an errored tool part was refused by OpenCode's own static permission rules (the
 * mode-independent `external_directory` deny floor) before Keiko's policy hook was consulted. Only
 * the closed upstream token `error.type` is compared, against its exact literal; the upstream
 * `message` is untrusted and is never read. The live and history projections both call this, so a
 * reloaded run shows the same refusal card as the live one.
 */
export function isOpenCodePermissionRejection(state: unknown): boolean {
  if (!isPlainRecord(state) || state.status !== "error") return false;
  return isPlainRecord(state.error) && state.error.type === OPENCODE_PERMISSION_REJECTED_ERROR_TYPE;
}

function isFailedShellResult(metadata: Readonly<Record<string, unknown>>): boolean {
  if (metadata.timeout === true || typeof metadata.signal === "string") return true;
  // A malformed exit status speaks for nothing, as it does for the run's evidence.
  return Number.isInteger(metadata.exit) && metadata.exit !== 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A tool name OpenCode may advertise or report: native, MCP-namespaced or plugin-registered. */
export function isAdmissibleOpenCodeToolName(value: unknown): value is string {
  return typeof value === "string" && NATIVE_TOOL_NAME.test(value);
}

/**
 * Body-free label for a tool name in log lines: a native id is closed vocabulary; any other
 * admissible name is a repository, MCP or plugin tool and is reported as `extension`.
 */
export function openCodeToolLogLabel(tool: string): string {
  return isOpenCodeNativeToolName(tool) ? tool : "extension";
}

interface AdvertisedTool {
  readonly name: string;
  /** Absent counts as empty; the gateway counts the description the advertisement forwards. */
  readonly description?: string | undefined;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * Admission of the native tool contract a provider request carries. The gateway forwards these
 * definitions to the provider as data; nothing in them registers a handler or authority in Keiko
 * (ADR-0175 D2). What is admitted is therefore bounded shape: admissible names, no duplicates, no
 * oversized schema, and at least one tool.
 */
export function isAdmittedOpenCodeNativeToolContract(
  tools: readonly AdvertisedTool[] | undefined,
): boolean {
  if (tools === undefined || tools.length === 0) return false;
  if (tools.length > OPENCODE_NATIVE_TOOL_CONTRACT_MAX_TOOLS) return false;
  const names = new Set<string>();
  let total = 0;
  for (const tool of tools) {
    if (!isAdmissibleOpenCodeToolName(tool.name) || names.has(tool.name)) return false;
    names.add(tool.name);
    const bytes = admittedDefinitionBytes(tool);
    if (bytes === undefined) return false;
    total += bytes;
    if (total > OPENCODE_NATIVE_TOOL_CONTRACT_MAX_TOTAL_BYTES) return false;
  }
  return true;
}

/** One tool's complete definition bytes under the gateway contract, or undefined when unbounded. */
function admittedDefinitionBytes(tool: AdvertisedTool): number | undefined {
  const description = tool.description ?? "";
  if (description.length > GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS.maxDescriptionChars)
    return undefined;
  const schemaBytes = gatewayNativeToolSchemaBytes(tool.parameters);
  if (schemaBytes > OPENCODE_NATIVE_TOOL_CONTRACT_MAX_SCHEMA_BYTES) return undefined;
  return gatewayNativeToolDefinitionBytes({ ...tool, description });
}

/** Stable digest of the advertised tool-name set, for body-free gateway evidence. */
export function openCodeNativeToolSetDigest(tools: readonly AdvertisedTool[]): string {
  const hash = createHash("sha256");
  hash.update("keiko.opencode.native-tool-set.v1\0");
  for (const name of tools.map((tool) => tool.name).sort(compareCodeUnits)) {
    hash.update(`${String(name.length)}:${name}`);
  }
  return hash.digest("hex");
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
