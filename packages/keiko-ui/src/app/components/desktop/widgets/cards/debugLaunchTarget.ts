/**
 * Epic-integration fix (Epic #2096, ADR-0136 D4): resolves the `DebugLaunchTarget` a Start/Continue
 * action should send. Before this module, every debug-start call site (`DebugPanel.tsx`,
 * `EditorDebugSessionHost.tsx`) unconditionally built `{ kind: "file", fileId }`, so the epic's own
 * "debug this test file" scenario (Target Outcome 2/5) had no reachable path even though the
 * catalog-kind launch is fully implemented server-side (#2343-#2345). This is the single seam both
 * call sites route through, so the fix lives in one place instead of being duplicated per caller.
 *
 * It deliberately reuses two existing subsystems instead of adding new ones:
 *  - the M4 command-runner catalog (`fetchCommandCatalog`, Issue #1387) that already backs
 *    `CommandsWidget`, and that the server's `deriveCatalogDebugTarget` (ADR-0136 D4) discovers
 *    through the identical `commandRunner.discover` dependency;
 *  - the test-file recognition rule (`isTestFilePath`, Issue #2212/ADR-0126) that already backs the
 *    "Run Tests for File" palette command.
 */

import type { DebugLaunchTarget } from "@oscharko-dev/keiko-contracts";
import { fetchCommandCatalog } from "../../../../../lib/commands-api";
import type { CommandTask } from "../../../../../lib/types";
import { isTestFilePath } from "./editorCommands";

function fileLaunchTarget(fileId: string): DebugLaunchTarget {
  return { kind: "file", fileId };
}

// The catalog builder (#2344's `deriveCatalogDebugTarget`) re-derives the target from live
// server-side state immediately before launch (D4); the browser only ever names an opaque,
// already-discovered, trusted task id. Picking the first trusted "test" task keeps this
// deterministic without adding a second selection UI — a workspace whose test task is not (yet)
// trusted, or that has none, still falls back to debugging the file directly.
function selectTrustedTestTask(tasks: readonly CommandTask[]): CommandTask | undefined {
  return tasks.find((task) => task.kind === "test" && task.trustState === "trusted");
}

/**
 * Resolves the launch target for a debug Start/Continue action. Only a recognized test file ever
 * attempts the catalog path — every other file keeps the existing, unconditional file-kind launch, so
 * behavior for plain scripts is unchanged. Catalog discovery failure, or the absence of a trusted test
 * task, falls back to the file-kind target rather than blocking the debug action outright.
 */
export async function resolveDebugLaunchTarget(
  root: string,
  fileId: string,
): Promise<DebugLaunchTarget> {
  if (root.length === 0 || !isTestFilePath(fileId)) return fileLaunchTarget(fileId);
  try {
    const catalog = await fetchCommandCatalog(root);
    const task = selectTrustedTestTask(catalog.tasks);
    return task === undefined ? fileLaunchTarget(fileId) : { kind: "catalog", targetId: task.id };
  } catch {
    // Catalog discovery is a best-effort upgrade over the file-kind launch, never a precondition for
    // debugging: a BFF error, an untrusted workspace, or an offline catalog route must not prevent
    // Start from doing anything at all.
    return fileLaunchTarget(fileId);
  }
}
