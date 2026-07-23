import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REAL_BINARY_DEFAULT_UI_PORT = 32483;

export function realBinaryStateDir(): string {
  const override = process.env.KEIKO_E2E_STATE_DIR;
  if (override !== undefined && override.length > 0) return override;
  const runId = process.env.GITHUB_RUN_ID;
  const stateId =
    runId === undefined || runId.length === 0
      ? "code-task-2483-real-binary"
      : `code-task-2483-real-binary-${runId}`;
  return join(realpathSync(tmpdir()), "keiko-e2e", stateId);
}
