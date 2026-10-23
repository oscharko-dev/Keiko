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
    `const ENV_DENYLIST = new Set(${JSON.stringify(OPENCODE_NATIVE_SHELL_ENV_DENYLIST)});`,
    "const endpoint = process.env.KEIKO_TOOL_FACADE_URL;",
    "const capability = process.env.KEIKO_TOOL_FACADE_CAPABILITY;",
    "const runId = process.env.KEIKO_CODING_RUN_ID;",
    "function boundedResources(resources) {",
    "  if (resources === undefined || resources === null) return [];",
    "  if (!Array.isArray(resources) || resources.length > MAX_RESOURCES) return null;",
    '  if (resources.some((value) => typeof value !== "string" || value.length > MAX_RESOURCE_CHARS)) return null;',
    "  return resources;",
    "}",
    "function source(value) {",
    '  if (!value || typeof value !== "object" || value.type !== "tool") return null;',
    '  return { type: "tool", messageID: String(value.messageID ?? ""), id: String(value.id ?? "") };',
    "}",
  ];
}

function policyEvaluationSource(): readonly string[] {
  return [
    "async function evaluate(event) {",
    '  const refusal = { effect: "deny", message: DENY_MESSAGE };',
    "  if (!endpoint || !capability || !runId) return refusal;",
    "  const resources = boundedResources(event.resources);",
    "  if (resources === null) return refusal;",
    "  try {",
    '    const body = JSON.stringify({ action: ACTION, runId, sessionID: event.sessionID, agent: typeof event.agent === "string" ? event.agent : null, permission: String(event.action), resources, source: source(event.source), configured: event.effect });',
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
    "      const decision = await evaluate(event);",
    "      event.effect = decision.effect;",
    "      if (decision.message !== undefined) event.message = decision.message;",
    "    });",
    '    await ctx.shell.hook("create.before", (event) => {',
    "      for (const name of Object.keys(event.env ?? {})) {",
    '        if (ENV_DENYLIST.has(name) || name.startsWith("KEIKO_")) delete event.env[name];',
    "      }",
    "    });",
    "  },",
    "};",
  ];
}
