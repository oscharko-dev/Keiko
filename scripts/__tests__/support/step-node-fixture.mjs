import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { WINDOWS_PORTABLE_RUNTIME_APPROVAL } from "../../../packages/keiko-server/src/coding-runtime/npmLaneRuntimeApprovals.ts";
import { STEP_NODE_LICENSE_SOURCE_PATH } from "../../lib/portable-step-node.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/** The pin the server enforces, with only the binary identity replaced by the fixture bytes. */
export function fixtureStepNodeApproval(bytes) {
  const real = WINDOWS_PORTABLE_RUNTIME_APPROVAL.stepNode;
  if (real === undefined) throw new Error("the Windows approval carries no step Node.js pin");
  return {
    ...WINDOWS_PORTABLE_RUNTIME_APPROVAL,
    stepNode: {
      ...real,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: Buffer.byteLength(bytes),
    },
  };
}

/**
 * What `resolveStepNodeRuntime` returns, for fixture bytes: the real license text of the
 * repository and the real approval's source and patch digests, so the staged entry is the
 * producer's own and only the executable bytes are a fixture.
 */
export function fixtureStepNodeRuntime(bytes = "fixture step node") {
  const root = mkdtempSync(join(tmpdir(), "keiko-step-node-fixture-"));
  const sourceBinary = join(root, "node.exe");
  writeFileSync(sourceBinary, bytes);
  return {
    approved: fixtureStepNodeApproval(bytes).stepNode,
    package: { version: "0.0.0", tarball: "fixture.tgz", sha256: "0".repeat(64) },
    sourceBinary,
    sourceLicense: join(repoRoot, ...STEP_NODE_LICENSE_SOURCE_PATH.split("/")),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
