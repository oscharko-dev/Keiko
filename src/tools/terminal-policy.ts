// Re-export shim: the terminal-policy command-allowlist gate lives in
// @oscharko-dev/keiko-tools (issue #162, ADR-0019). All existing import sites
// (`from "../tools/terminal-policy.js"`) keep resolving unchanged via this barrel.

export {
  TERMINAL_COMMAND_RULES,
  TERMINAL_NO_FLAGS,
  isTerminalCommandAllowed,
  type TerminalCommandDecision,
} from "@oscharko-dev/keiko-tools";
