import {
  CODING_WORKBENCH_AGENTS,
  DEFAULT_CODING_WORKBENCH_AGENT,
  type CodingWorkbenchAgent,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import type { OpenCodeToolProfile } from "@oscharko-dev/keiko-contracts/runtime/opencode-service-host";

/**
 * The primary agents an operator may select for a run on the given OpenCode tool profile (#3897).
 *
 * `plan` is OpenCode's own shipped read-only agent: it denies edits except its own plan file, and
 * it can only do so where OpenCode runs its own tools, the native profile. The mapped profiles
 * (`direct`, `code-mode`) route every tool through Keiko's governed facade, which does not apply
 * OpenCode's agent policy, so a `plan` request there would run as an editing agent under a
 * read-only name. They offer the default agent only and refuse the rest. This is the single rule;
 * the launch resolver, the run's turn port and the composition's run port all read it.
 */
export function openCodeSelectableAgents(
  profile: OpenCodeToolProfile,
): readonly CodingWorkbenchAgent[] {
  return profile === "native" ? CODING_WORKBENCH_AGENTS : [DEFAULT_CODING_WORKBENCH_AGENT];
}

/**
 * Whether a turn may ask for `agent` on a run that offers `selectable`. The default agent is every
 * run's baseline and needs no capability; any other must be offered. An absent request is always
 * admitted: it keeps whatever agent the run already has.
 */
export function isAgentAdmitted(
  selectable: readonly CodingWorkbenchAgent[] | undefined,
  agent: CodingWorkbenchAgent | undefined,
): boolean {
  return (
    agent === undefined ||
    agent === DEFAULT_CODING_WORKBENCH_AGENT ||
    selectable?.includes(agent) === true
  );
}
