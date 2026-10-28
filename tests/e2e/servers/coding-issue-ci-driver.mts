import type { ProductionRuntimeBackendInput } from "../../../packages/keiko-server/src/coding-runtime/productionCodingRuntimeResolver.js";
import type { CodingToolResult } from "../../../packages/keiko-server/src/coding-runtime/codingToolIpc.js";
import type { CiFixtureOperation } from "../support/coding-issue-ci.js";
import { COMMIT_TARGET } from "../support/coding-issue-commit.js";

function invoke(
  run: ProductionRuntimeBackendInput,
  id: string,
  body: Readonly<Record<string, unknown>>,
): Promise<CodingToolResult> {
  return run.toolFacade.execute({
    capability: run.minted.toolFacadeCapability,
    body: JSON.stringify({ ...body, actionId: id, idempotencyKey: id }),
  });
}
/** The supervisor selects existing facade actions; it never supplies claims, PR identity or freshness authority. */
export async function invokeCiFixture(
  run: ProductionRuntimeBackendInput,
  operation: CiFixtureOperation,
  id: number,
  stage: () => Promise<void>,
): Promise<CodingToolResult> {
  const identity = `ci-fixture-${String(id)}`;
  if (operation === "ci-repair") return repair(run, identity, stage);
  const invalid = {
    "observe-ci": {},
    "ci-invalid-pr": { prNumber: 999 },
    "ci-invalid-head": { headSha: "f".repeat(40) },
    "ci-force-fresh": { forceFresh: true },
  };
  return invoke(run, identity, { action: "git", operation: "ci", ...invalid[operation] });
}
async function repair(
  run: ProductionRuntimeBackendInput,
  id: string,
  stage: () => Promise<void>,
): Promise<CodingToolResult> {
  const read = await invoke(run, `${id}-read`, { action: "read", relativePath: COMMIT_TARGET });
  if (!("read" in read) || read.read.text.split("\n").length !== 2)
    throw new Error("ci-fixture-repair-read-failed");
  const next = "export const value = 'REPAIRED_CI_3388';\n";
  // The model-visible edit form (#3873, PR #3876): one exact replacement bound to the file's read
  // digest. The catalog's `keiko.changeset.edit` schema no longer offers a diff beside it, so the
  // retired `patch` form this repair used to send is refused as invalid before it reaches the
  // editor (opencodeToolSchemas.ts's CHANGESET_EDIT_SCHEMA).
  const edited = await invoke(run, `${id}-edit`, {
    action: "edit",
    changeset: {
      edits: [
        { file: COMMIT_TARGET, oldString: read.read.text, newString: next, replaceAll: false },
      ],
      deletions: [],
      renames: [],
      files: [{ file: COMMIT_TARGET, expectedContentHash: read.read.digest }],
      selectedFiles: [COMMIT_TARGET],
    },
  });
  if (edited.status !== "completed") return edited;
  await stage();
  return invoke(run, `${id}-verify`, { action: "verification", verifierId: "typecheck" });
}
