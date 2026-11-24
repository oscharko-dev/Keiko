import { DEFAULT_VERIFICATION_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/verification";
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from "@oscharko-dev/keiko-tools";

// How long one command may run when a person starts it in the terminal, a task run executes a
// workspace script, a container run executes its task, or a Coding run's governed command tool
// runs one. Owner decision 2026-11-24: as long as one governed verification step (30 minutes), so a
// Maven build or a full test suite finishes instead of ending at the sandbox's 30-second default for
// read-only tool commands. The same value is the default and the ceiling a request may ask for; the
// person's Stop ends a command earlier.
export const COMMAND_RUN_MAX_DURATION_MS = DEFAULT_VERIFICATION_LIMITS.wallTimeMs;

// The sandbox policy of those command surfaces: the default policy with the command wall time.
export const COMMAND_SANDBOX_POLICY: SandboxPolicy = Object.freeze({
  ...DEFAULT_SANDBOX_POLICY,
  defaultTimeoutMs: COMMAND_RUN_MAX_DURATION_MS,
});
