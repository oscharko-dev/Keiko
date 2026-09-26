import { join } from "node:path";
import { e2eStateDir } from "./e2e-state-dir.js";

export const COMMIT_PORT = 32586;
export const COMMIT_LAUNCHER_SECRET = "verified-commit-3386-local-pairing-fixture";
export const COMMIT_MESSAGE =
  "fix: verify the reviewed code task\n\nReviewed <script>text</script> remains plain text.";
export const COMMIT_ORIGINAL = "export const value = 'ORIGINAL_COMMIT_3386';\n";
export const COMMIT_EDITED = "export const value = 'VERIFIED_COMMIT_3386';\n";
export const COMMIT_TARGET = "src/example.ts";
export const COMMIT_OPERATIONS = ["propose", "execute", "finish"] as const;
export type CommitFixtureOperation = (typeof COMMIT_OPERATIONS)[number];
export function commitStateDir(): string {
  return e2eStateDir("coding-issue-commit-3386");
}
export function commitRepository(stateDir: string): string {
  return join(stateDir, "repository");
}
export function commitManagedRoot(stateDir: string): string {
  return join(stateDir, "bff-state", "ui-db", "task-workspaces");
}
export function commitControlPath(stateDir: string): string {
  return join(stateDir, "commit-control.json");
}
export function commitObservationPath(stateDir: string): string {
  return join(stateDir, "commit-observation.json");
}
