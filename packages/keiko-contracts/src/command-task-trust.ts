// Repository-authored scripts are executable code from the selected workspace. The browser can see
// whether a task is currently runnable, but the server owns the trust decision and re-checks it at
// execution time; the request never carries this field back as authority.
//
// The trust states live in this import-free module so editor-verification, which the first-load
// desktop shell reaches, does not pull the command-runner validators into the initial bundle.
export type CommandTaskTrustState = "trusted" | "approval-required";

export const COMMAND_TASK_TRUST_STATES: readonly CommandTaskTrustState[] = Object.freeze([
  "trusted",
  "approval-required",
] as const satisfies readonly CommandTaskTrustState[]);
