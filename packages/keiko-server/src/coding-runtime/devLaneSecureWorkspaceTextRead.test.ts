import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DevLaneSecureReadBinding } from "./devLanePortableCodingRuntime.js";
import { createDevLaneSecureWorkspaceTextReadPort } from "./devLaneSecureWorkspaceTextRead.js";

const HELPER_BODY = "#!/bin/sh\nexit 3\n";
const PLATFORM = { os: "darwin", arch: "arm64" } as const;

const roots: string[] = [];

interface Fixture {
  readonly binding: DevLaneSecureReadBinding;
  readonly safeCwd: string;
  readonly workspaceRoot: string;
  readonly helperPath: string;
}

function stageFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-dev-lane-read-")));
  roots.push(root);
  const helperPath = join(root, "native", "keiko-secure-workspace-read");
  mkdirSync(join(root, "native"), { recursive: true, mode: 0o700 });
  writeFileSync(helperPath, HELPER_BODY);
  chmodSync(helperPath, 0o755);
  const safeCwd = join(root, "safe-cwd");
  mkdirSync(safeCwd, { recursive: true, mode: 0o700 });
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  return {
    helperPath,
    safeCwd,
    workspaceRoot,
    binding: {
      helperPath,
      helperSizeBytes: HELPER_BODY.length,
      artifact: {
        target: "darwin-arm64",
        installRelativePath: "runtime/native/keiko-secure-workspace-read",
        sha256: createHash("sha256").update(HELPER_BODY, "utf8").digest("hex"),
        protocol: "KSR1/KSS1",
        sourceCommit: "a".repeat(40),
        sourceTreeSha256: "b".repeat(64),
        signed: true,
      },
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("dev-lane secure workspace text read port", () => {
  it("fails closed with workspace-unavailable before touching the helper", async () => {
    const fixture = stageFixture();
    const port = createDevLaneSecureWorkspaceTextReadPort({
      binding: fixture.binding,
      resolveWorkspaceRoot: () => undefined,
      safeCwd: fixture.safeCwd,
      platform: PLATFORM,
    });
    await expect(port.readText({ relativePath: "src/example.ts" })).resolves.toEqual({
      ok: false,
      reason: "workspace-unavailable",
    });
  });

  it("refuses a tampered helper as artifact-unverified on every read", async () => {
    const fixture = stageFixture();
    const port = createDevLaneSecureWorkspaceTextReadPort({
      binding: fixture.binding,
      resolveWorkspaceRoot: () => fixture.workspaceRoot,
      safeCwd: fixture.safeCwd,
      platform: PLATFORM,
    });
    writeFileSync(fixture.helperPath, "#!/bin/sh\nexit 4\n");
    await expect(port.readText({ relativePath: "src/example.ts" })).resolves.toEqual({
      ok: false,
      reason: "artifact-unverified",
    });
  });

  it("refuses a helper whose recorded size drifts from disk", async () => {
    const fixture = stageFixture();
    const port = createDevLaneSecureWorkspaceTextReadPort({
      binding: { ...fixture.binding, helperSizeBytes: HELPER_BODY.length + 1 },
      resolveWorkspaceRoot: () => fixture.workspaceRoot,
      safeCwd: fixture.safeCwd,
      platform: PLATFORM,
    });
    await expect(port.readText({ relativePath: "src/example.ts" })).resolves.toEqual({
      ok: false,
      reason: "artifact-unverified",
    });
  });

  it("admits a digest-verified helper and surfaces its non-protocol output honestly", async () => {
    const fixture = stageFixture();
    const port = createDevLaneSecureWorkspaceTextReadPort({
      binding: fixture.binding,
      resolveWorkspaceRoot: () => fixture.workspaceRoot,
      safeCwd: fixture.safeCwd,
      platform: PLATFORM,
    });
    const result = await port.readText({ relativePath: "src/example.ts" });
    // The fixture helper is digest-valid but does not speak KSR1/KSS1; verification must have
    // passed (no artifact-unverified) and the spawn outcome must fail closed.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["process-failed", "protocol-invalid", "timeout"]).toContain(result.reason);
  });

  it("rejects an unsupported host platform before verification", async () => {
    const fixture = stageFixture();
    const port = createDevLaneSecureWorkspaceTextReadPort({
      binding: fixture.binding,
      resolveWorkspaceRoot: () => fixture.workspaceRoot,
      safeCwd: fixture.safeCwd,
      platform: { os: "linux", arch: "x64" },
    });
    await expect(port.readText({ relativePath: "src/example.ts" })).resolves.toEqual({
      ok: false,
      reason: "unsupported-platform",
    });
  });
});
