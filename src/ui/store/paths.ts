// ADR-0013 D4 — resolveUiDbPath precedence (mirrors resolveEvidenceDir):
// explicit option → KEIKO_UI_DATA_DIR/keiko-ui.db → homedir()/.keiko/keiko-ui.db.

import { homedir } from "node:os";
import { join } from "node:path";

export const UI_DB_FILENAME = "keiko-ui.db";
export const UI_DB_DIRNAME = ".keiko";

export function resolveUiDbPath(
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const dir = env.KEIKO_UI_DATA_DIR;
  if (dir !== undefined && dir.length > 0) return join(dir, UI_DB_FILENAME);
  return join(homedir(), UI_DB_DIRNAME, UI_DB_FILENAME);
}
