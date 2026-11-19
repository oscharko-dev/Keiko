// The Windows runtime supervisor's closed refusal reasons (`NativeRuntimeTree.failureReason`), as the
// closed run failure codes a refused launch settles with (#4068). Before this mapping the reason fed
// only the exit diagnostic, and a launch the supervisor refused read as the internal `runtime-failed`.
// The codes carry no path, identifier or Windows error text; the Workbench words each one.
import type { CodingWorkbenchRuntimeFailureCode } from "@oscharko-dev/keiko-contracts";

export type SupervisorRefusalFailureCode = Extract<
  CodingWorkbenchRuntimeFailureCode,
  | "runtime-supervisor-grants-acl"
  | "runtime-supervisor-grants-directory"
  | "runtime-supervisor-grants-capability"
  | "runtime-supervisor-gateway-connect"
  | "runtime-supervisor-gateway-admit"
  | "runtime-supervisor-refused"
>;

// The refusals with a cause of their own; every other supervisor refusal keeps the one
// "the supervisor refused the launch" code rather than the internal error.
const SPECIFIC_REFUSALS: ReadonlyMap<string, SupervisorRefusalFailureCode> = new Map([
  ["supervisor-grants-acl", "runtime-supervisor-grants-acl"],
  ["supervisor-grants-directory", "runtime-supervisor-grants-directory"],
  ["supervisor-grants-capability", "runtime-supervisor-grants-capability"],
  ["supervisor-gateway-connect", "runtime-supervisor-gateway-connect"],
  ["supervisor-gateway-admit", "runtime-supervisor-gateway-admit"],
]);

const SUPERVISOR_REFUSAL_FAILURE_CODES: ReadonlySet<string> = new Set([
  ...SPECIFIC_REFUSALS.values(),
  "runtime-supervisor-refused",
]);

/** Whether a start failure code is one of the supervisor's refusal causes. */
export function isSupervisorRefusalFailureCode(code: string): code is SupervisorRefusalFailureCode {
  return SUPERVISOR_REFUSAL_FAILURE_CODES.has(code);
}

/** The failure code of a supervisor refusal, or `undefined` when the tree was not refused. */
export function supervisorRefusalFailureCode(
  refusal: string | undefined,
): SupervisorRefusalFailureCode | undefined {
  if (refusal?.startsWith("supervisor-") !== true) return undefined;
  return SPECIFIC_REFUSALS.get(refusal) ?? "runtime-supervisor-refused";
}
