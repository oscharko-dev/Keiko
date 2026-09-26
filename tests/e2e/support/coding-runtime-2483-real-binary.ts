import { e2eStateDir } from "./e2e-state-dir.js";

export const REAL_BINARY_DEFAULT_UI_PORT = 32483;

export function realBinaryStateDir(): string {
  const runId = process.env.GITHUB_RUN_ID;
  const stateId =
    runId === undefined || runId.length === 0
      ? "code-task-2483-real-binary"
      : `code-task-2483-real-binary-${runId}`;
  return e2eStateDir(stateId);
}
