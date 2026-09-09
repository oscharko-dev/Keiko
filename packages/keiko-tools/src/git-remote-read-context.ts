import type { RunCommandDeps } from "./exec.js";
import type { CommandResult } from "./types.js";

/** Typed remote reads consume data; ordinary CI context must not corrupt that data. A mutation whose
 * response is itself a typed projection (`pr create --jq <identity>`) is the same case (#3390). */
export function gitRemoteReadContext<T extends { readonly runDeps: RunCommandDeps }>(
  context: T,
): T {
  return {
    ...context,
    runDeps: {
      ...context.runDeps,
      policy: {
        ...context.runDeps.policy,
        // Reuse the existing source-read scrub mode. Credentials and secret-shaped values are
        // still redacted; an explicitly stricter caller policy remains authoritative.
        outputScrub: context.runDeps.policy.outputScrub ?? "credentials-only",
      },
    },
  };
}

/** A typed provider observation is unusable when either output stream was altered by redaction. */
export function gitRemoteReadWasRedacted(result: CommandResult): boolean {
  return result.outputRedacted === true;
}
