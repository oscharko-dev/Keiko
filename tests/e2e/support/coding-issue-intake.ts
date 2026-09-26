import { join } from "node:path";
import { e2eStateDir } from "./e2e-state-dir.js";

export const ISSUE_INTAKE_PORT = 32585;
export const ISSUE_INTAKE_LAUNCHER_SECRET = "issue-intake-3385-local-pairing-fixture";
export const ISSUE_INTAKE_CONTEXT_MARKER = "ISSUE_CONTEXT_CAUSALITY_3385";
export const ISSUE_INTAKE_ORIGINAL = "export const value = 'ORIGINAL_ISSUE_3385';\n";
export const ISSUE_INTAKE_EDITED = "export const value = 'NEW_ISSUE_3385';\n";
export const ISSUE_INTAKE_TARGET = "src/example.ts";
export const ISSUE_INTAKE_REFERENCE = "https://github.com/fixture/issue-intake/issues/42";

export function issueIntakeStateDir(): string {
  return e2eStateDir(
    process.env.GITHUB_RUN_ID === undefined
      ? "coding-issue-intake-3385"
      : `coding-issue-intake-3385-${process.env.GITHUB_RUN_ID}`,
  );
}
export function issueIntakeRepository(stateDir: string): string {
  return join(stateDir, "repository");
}
export function issueIntakeManagedRoot(stateDir: string): string {
  return join(stateDir, "bff-state", "ui-db", "task-workspaces");
}
export function issueIntakeRevisionPath(stateDir: string): string {
  return join(stateDir, "provider-revision.txt");
}
export function issueIntakeObservationPath(stateDir: string): string {
  return join(stateDir, "gateway-observation.jsonl");
}
