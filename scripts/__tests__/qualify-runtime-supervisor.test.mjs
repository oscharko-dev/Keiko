import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createRuntimeSupervisorQualificationReceipt } from "../qualify-runtime-supervisor.mjs";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-runtime-receipt-"));
  const resourceRoot = join(root, "payload", "Keiko");
  const helper = join(resourceRoot, "runtime", "native", "keiko-runtime-supervisor.exe");
  const artifact = join(root, "keiko-windows-x64.zip");
  const manifest = join(root, "manifest", "portable-manifest.json");
  mkdirSync(join(resourceRoot, "runtime", "native"), { recursive: true });
  mkdirSync(join(root, "manifest"), { recursive: true });
  writeFileSync(helper, "signed-helper-bytes");
  writeFileSync(artifact, "signed-artifact-bytes");
  writeFileSync(
    manifest,
    JSON.stringify({
      artifact: { platformTarget: "windows-x64", sha256: digest("signed-artifact-bytes") },
      release: { commitSha: "a".repeat(40) },
      sidecarRuntimes: [],
    }),
  );
  return { artifact, helper, manifest, resourceRoot };
}

describe("runtime supervisor qualification receipt", () => {
  it("binds only content-free target, commit, artifact, helper, sidecar, backend, and result facts", () => {
    const paths = fixture();
    expect(createRuntimeSupervisorQualificationReceipt(paths, "windows-x64")).toEqual({
      schemaVersion: 1,
      suiteVersion: "runtime-tree-qualification-v1",
      platformTarget: "windows-x64",
      sourceCommitSha: "a".repeat(40),
      artifactSha256: digest("signed-artifact-bytes"),
      helperSha256: digest("signed-helper-bytes"),
      sidecars: [],
      backend: "windows-job-object",
      result: "passed",
    });
  });

  it("rejects stale artifact bytes and every macOS qualification claim", () => {
    const paths = fixture();
    writeFileSync(paths.artifact, "changed-after-manifest");
    expect(() => createRuntimeSupervisorQualificationReceipt(paths, "windows-x64")).toThrow(
      "artifact bytes do not match manifest",
    );
    expect(() => createRuntimeSupervisorQualificationReceipt(paths, "macos-arm64")).toThrow(
      "only windows-x64 has a qualified native backend",
    );
    expect(readFileSync(paths.helper, "utf8")).toBe("signed-helper-bytes");
  });
});
