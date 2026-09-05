import { join } from "node:path";
import { e2eStateDir } from "./e2e-state-dir.js";

export const CI_PORT = 32588;
export const CI_OPERATIONS = [
  "observe-ci",
  "ci-repair",
  "ci-invalid-pr",
  "ci-invalid-head",
  "ci-force-fresh",
] as const;
export type CiFixtureOperation = (typeof CI_OPERATIONS)[number];
export const CI_MODES = [
  "pending",
  "failed",
  "ready",
  "visibility-unknown",
  "wrong-pr",
  "wrong-head",
] as const;
export type CiFixtureMode = (typeof CI_MODES)[number];
export function ciStateDir(): string {
  return e2eStateDir("coding-issue-ci-3388");
}
export function ciProviderPath(stateDir: string): string {
  return join(stateDir, "ci-provider.json");
}
export interface CiProviderState {
  readonly mode: CiFixtureMode;
  readonly reads: number;
  readonly rejectedTargets: number;
}
