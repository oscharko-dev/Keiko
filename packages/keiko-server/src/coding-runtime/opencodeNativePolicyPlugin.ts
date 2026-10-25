import {
  GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS,
  GOVERNED_TOOL_SETTLEMENT_GRACE_MS,
} from "@oscharko-dev/keiko-contracts/runtime/tools";

/** The facade action the native policy hook sends; the composition's tool bridge answers it. */
export const OPENCODE_NATIVE_POLICY_ACTION = "native-policy";
export const OPENCODE_NATIVE_POLICY_MAX_RESOURCES = 64;
export const OPENCODE_NATIVE_POLICY_MAX_RESOURCE_CHARS = 2_048;
export const OPENCODE_NATIVE_POLICY_MAX_RESPONSE_BYTES = 64 * 1_024;
export const OPENCODE_NATIVE_POLICY_MAX_MESSAGE_CHARS = 1_024;
/** The hook waits as long as one human decision may take, plus the bridge's settlement grace. */
export const OPENCODE_NATIVE_POLICY_WAIT_MS =
  GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS + GOVERNED_TOOL_SETTLEMENT_GRACE_MS;

/**
 * Code Mode's management tools that change state but assert no OpenCode permission (2.1.4, measured
 * with the real runtime): the policy decides them through the tool hook instead, as it decides the
 * Code Mode program itself (`execute`, which asserts none either). Every other Code Mode tool either
 * asserts a permission the evaluate hook sees or only reads.
 */
export const OPENCODE_CODE_MODE_GOVERNED_TOOLS = Object.freeze([
  "opencode_session_move",
  "opencode_worktree_create",
] as const);

/**
 * The one governed management tool that names its effect (#3903 AC4): it moves a session, the
 * current one when `sessionID` is omitted, to `directory`. The hook sends both, so the policy can
 * admit the run's own session moving inside the task workspace.
 */
export const OPENCODE_CODE_MODE_SESSION_MOVE = "opencode_session_move";

/**
 * The governed management tool that would add an unmanaged worktree (#3903 AC4): the hook sends
 * the name it carries, and Keiko's managed task-workspace owner provisions an approved one.
 */
export const OPENCODE_CODE_MODE_WORKTREE_CREATE = "opencode_worktree_create";

/** Secrets and Keiko bindings never reach a shell the native agent starts. */
export const OPENCODE_NATIVE_SHELL_ENV_DENYLIST = Object.freeze([
  "OPENCODE_SERVER_PASSWORD",
  "KEIKO_MODEL_GATEWAY_URL",
  "KEIKO_MODEL_GATEWAY_CAPABILITY",
  "KEIKO_TOOL_FACADE_URL",
  "KEIKO_TOOL_FACADE_CAPABILITY",
  "KEIKO_CODING_RUN_ID",
  "KEIKO_CODING_MODE",
  "KEIKO_CODING_WORKSPACE_ROOT",
] as const);

const DENY_MESSAGE =
  "Keiko refused this action: its policy service did not answer. Continue with another step.";
const OVERSIZED_MESSAGE =
  "Keiko refused this action: it is too large to review (at most 64 commands or paths of 2,048 characters each). Split it into smaller steps, or write a long script to a file first.";

/**
 * Dependency-free V2 plugin source (#3897): the one place Keiko's autonomy mode touches the native
 * agent loop. OpenCode evaluates its own permission rules first; this hook asks the server-owned
 * policy for the final effect of every evaluated action and can only narrow the result. A missing,
 * failed or oversized answer denies the action (fail closed), and so does a request whose resource
 * list exceeds the accepted bounds: the hook never clips authority-bearing input, because OpenCode
 * would still execute the complete original action (#3897 review). The shell hook strips Keiko's
 * bindings and the server password from every shell the agent starts, so no tool output can
 * carry them.
 */
export function createGeneratedOpenCodeNativePolicyPlugin(): string {
  return [...pluginConstantsSource(), ...policyEvaluationSource(), ...pluginBodySource()].join(
    "\n",
  );
}

function pluginConstantsSource(): readonly string[] {
  return [
    `const ACTION = ${JSON.stringify(OPENCODE_NATIVE_POLICY_ACTION)};`,
    `const MAX_RESOURCES = ${String(OPENCODE_NATIVE_POLICY_MAX_RESOURCES)};`,
    `const MAX_RESOURCE_CHARS = ${String(OPENCODE_NATIVE_POLICY_MAX_RESOURCE_CHARS)};`,
    `const MAX_RESPONSE_BYTES = ${String(OPENCODE_NATIVE_POLICY_MAX_RESPONSE_BYTES)};`,
    `const MAX_MESSAGE_CHARS = ${String(OPENCODE_NATIVE_POLICY_MAX_MESSAGE_CHARS)};`,
    `const WAIT_MS = ${String(OPENCODE_NATIVE_POLICY_WAIT_MS)};`,
    `const DENY_MESSAGE = ${JSON.stringify(DENY_MESSAGE)};`,
    `const OVERSIZED_MESSAGE = ${JSON.stringify(OVERSIZED_MESSAGE)};`,
    `const ENV_DENYLIST = new Set(${JSON.stringify(OPENCODE_NATIVE_SHELL_ENV_DENYLIST)});`,
    `const CODE_MODE_GOVERNED = new Set(${JSON.stringify(OPENCODE_CODE_MODE_GOVERNED_TOOLS)});`,
    "const endpoint = process.env.KEIKO_TOOL_FACADE_URL;",
    "const capability = process.env.KEIKO_TOOL_FACADE_CAPABILITY;",
    "const runId = process.env.KEIKO_CODING_RUN_ID;",
    "const fullAccess = process.env.KEIKO_CODING_MODE === 'autonomous-delivery';",
    ...patchBytesSource(),
    ...managementSource(),
    "function searchPath(event) {",
    '  const path = event.metadata && typeof event.metadata === "object" ? event.metadata.path : undefined;',
    '  return typeof path === "string" && path.length > 0 && path.length <= MAX_RESOURCE_CHARS ? path : undefined;',
    "}",
    "function boundedResources(resources) {",
    "  if (resources === undefined || resources === null) return [];",
    "  if (!Array.isArray(resources) || resources.length > MAX_RESOURCES) return null;",
    '  if (resources.some((value) => typeof value !== "string" || value.length > MAX_RESOURCE_CHARS)) return null;',
    "  return resources;",
    "}",
    "// A Code Mode program is reviewed as its own text, split at line breaks into the bounded",
    "// resources a human approves; a line too long to review stays whole, so the bounds refuse it.",
    "function programResources(input) {",
    '  const code = input && typeof input.code === "string" ? input.code : "";',
    "  const chunks = [];",
    '  let current = "";',
    String.raw`  for (const line of code.split("\n")) {`,
    String.raw`    const joined = current.length === 0 ? line : current + "\n" + line;`,
    "    if (joined.length <= MAX_RESOURCE_CHARS) { current = joined; continue; }",
    "    if (current.length > 0) chunks.push(current);",
    "    current = line;",
    "  }",
    "  if (current.trim().length > 0) chunks.push(current);",
    "  return chunks;",
    "}",
    "function source(value) {",
    '  if (!value || typeof value !== "object" || value.type !== "tool") return null;',
    '  return { type: "tool", messageID: String(value.messageID ?? ""), id: String(value.id ?? "") };',
    "}",
  ];
}

function managementSource(): readonly string[] {
  return [
    "// A session move is reviewed by the directory it names and the session it moves (absent: the",
    "// calling one); a new worktree by the name it is given.",
    "function managementResources(tool, input) {",
    '  if (!input || typeof input !== "object") return [];',
    `  const value = tool === ${JSON.stringify(OPENCODE_CODE_MODE_SESSION_MOVE)} ? input.directory : tool === ${JSON.stringify(OPENCODE_CODE_MODE_WORKTREE_CREATE)} ? input.name : undefined;`,
    '  return typeof value === "string" ? [value] : [];',
    "}",
    "function managementTarget(tool, input) {",
    `  if (tool !== ${JSON.stringify(OPENCODE_CODE_MODE_SESSION_MOVE)} || !input || typeof input !== "object") return null;`,
    "  return input.sessionID === undefined ? null : input.sessionID;",
    "}",
  ];
}

function patchBytesSource(): readonly string[] {
  return [
    "const ENCODER = new TextEncoder();",
    "// The size of the unified diff the producer computed for a proposed edit; only the size leaves.",
    "// No diff means the edit cannot apply; one this plugin cannot measure is reported as -1, which",
    "// the server refuses, so a changed producer is refused rather than left uncharged.",
    "function patchBytes(event) {",
    '  if (String(event.action) !== "edit") return null;',
    '  const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : undefined;',
    "  if (!metadata) return null;",
    '  const parts = Array.isArray(metadata.files) ? metadata.files.map((file) => (file && typeof file === "object" ? file.patch : undefined)) : [metadata.diff].flat();',
    '  if (parts.length === 0 || parts.some((part) => typeof part !== "string")) return -1;',
    "  return parts.reduce((total, part) => total + ENCODER.encode(part).length, 0);",
    "}",
  ];
}

function policyEvaluationSource(): readonly string[] {
  return [
    "async function evaluate(event) {",
    '  const refusal = { effect: "deny", message: DENY_MESSAGE };',
    "  if (!endpoint || !capability || !runId) return refusal;",
    "  const resources = boundedResources(event.resources);",
    '  if (resources === null) return { effect: "deny", message: OVERSIZED_MESSAGE };',
    "  try {",
    '    const body = JSON.stringify({ action: ACTION, runId, sessionID: event.sessionID, agent: typeof event.agent === "string" ? event.agent : null, permission: String(event.action), resources, source: source(event.source), searchPath: searchPath(event), patchBytes: patchBytes(event), targetSessionID: event.targetSessionID ?? null, configured: event.effect });',
    '    const response = await fetch(endpoint, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(WAIT_MS), headers: { Authorization: "Bearer " + capability, "Content-Type": "application/json" }, body });',
    '    if (!response.ok || response.type === "opaqueredirect") return refusal;',
    "    const text = await response.text();",
    "    if (text.length > MAX_RESPONSE_BYTES) return refusal;",
    "    const result = JSON.parse(text);",
    '    if (!result || (result.effect !== "allow" && result.effect !== "deny")) return refusal;',
    '    const message = typeof result.message === "string" ? result.message.slice(0, MAX_MESSAGE_CHARS) : undefined;',
    "    return message === undefined ? { effect: result.effect } : { effect: result.effect, message };",
    "  } catch {",
    "    return refusal;",
    "  }",
    "}",
  ];
}

function pluginBodySource(): readonly string[] {
  return [
    "export default {",
    '  id: "keiko.native-policy",',
    "  async setup(ctx) {",
    '    await ctx.permission.hook("evaluate", async (event) => {',
    "      // An earlier hook's deny stands: this hook can only keep or narrow the configured effect.",
    '      if (event.effect === "deny") return;',
    "      const decision = await evaluate(event);",
    "      event.effect = decision.effect;",
    "      if (decision.message !== undefined) event.message = decision.message;",
    "    });",
    '    await ctx.shell.hook("create.before", (event) => {',
    "      for (const name of Object.keys(event.env ?? {})) {",
    '        if (ENV_DENYLIST.has(name) || name.startsWith("KEIKO_")) delete event.env[name];',
    "      }",
    "      // The runtime's own package manager stays offline; at Full access a shell may reach registries.",
    "      if (fullAccess && event.env) delete event.env.npm_config_offline;",
    "    });",
    "    // Code Mode stays available. The producer asserts no permission for a Code Mode program",
    "    // (`execute`) nor for the nested management tools that change state, so the same policy",
    "    // decides them here; a refusal blocks the call with the policy's message.",
    '    await ctx.tool.hook("execute.before", async (event) => {',
    '      if (event.tool !== "execute" && !CODE_MODE_GOVERNED.has(event.tool)) return;',
    '      const resources = event.tool === "execute" ? programResources(event.input) : managementResources(event.tool, event.input);',
    '      const decision = await evaluate({ sessionID: event.sessionID, agent: event.agent, action: event.tool, resources, targetSessionID: managementTarget(event.tool, event.input), effect: "ask", source: { type: "tool", messageID: event.messageID, id: event.id } });',
    '      if (decision.effect !== "allow") throw new Error(decision.message ?? DENY_MESSAGE);',
    "    });",
    "  },",
    "};",
  ];
}
