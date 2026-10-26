/**
 * The Keiko-registered tools of the native profile (#3897): Keiko's governed Git delivery path.
 *
 * Standalone OpenCode delivers through its shell (`git commit`, `git push`, `gh pr create`). In
 * Keiko the shell refuses those (ADR-0135: signed commits, bounded refs, delivery is a Keiko
 * product action; ADR-0087: merge is never model-visible), so the native agent proposes delivery
 * through exactly these tools instead. They are the mapped profile's own generated tools, served by
 * the same tool facade with the same capability, bounds and approvals: a proposal never mutates
 * anything, the operator approves it through the Workbench review per mode, and only
 * `keiko_git_execute` redeems an approved proposal. `keiko_verification` is part of the set because
 * a commit proposal requires the commit proof only Keiko's verifier records; it is the sole
 * non-Git member. No other Keiko tool is registered for a native run.
 *
 * A dependency-free module: the plugin generator, the permission policy and the tests all read
 * this one list, so none of them can drift from it.
 */
/** The generated plugin that registers them; readiness requires it active beside the policy hook. */
export const OPENCODE_NATIVE_DELIVERY_PLUGIN_ID = "keiko.native-delivery";
export const OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE = "keiko_native_delivery";

export const OPENCODE_NATIVE_DELIVERY_TOOL_NAMES: readonly string[] = Object.freeze([
  "keiko_git_status",
  "keiko_git_diff",
  "keiko_git_stage",
  "keiko_verification",
  "keiko_git_commit",
  "keiko_git_push",
  "keiko_pull_request",
  "keiko_git_execute",
  "keiko_git_sync",
  "keiko_ci_status",
]);

const DELIVERY_TOOL_NAME_SET: ReadonlySet<string> = new Set(OPENCODE_NATIVE_DELIVERY_TOOL_NAMES);

export function isOpenCodeNativeDeliveryToolName(value: unknown): value is string {
  return typeof value === "string" && DELIVERY_TOOL_NAME_SET.has(value);
}

/**
 * What a refused shell Git write tells the model (the policy's `delivery-reserved` verdict): the
 * way to deliver, in tool names this module owns. The tests pin every `keiko_*` name in it against
 * the list above, so the pointer cannot name a tool the run does not have.
 */
export const OPENCODE_NATIVE_DELIVERY_REFUSAL_MESSAGE =
  "Keiko refused this command: Git delivery is a Keiko action, not a shell one. Propose it with keiko_git_stage (unstage: true gives staged changes back), keiko_git_commit, keiko_git_push and keiko_pull_request (the operator approves each proposal), then redeem an approved proposal with keiko_git_execute. Fetch or fast-forward pull with keiko_git_sync. Branches, merges and history rewrites are not available; read-only Git commands still run.";
