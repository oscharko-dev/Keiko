import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isCredentialNamedSegment, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { closeFileServerLogSinks, createActivityLogSink } from "../observability/index.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import { privateStepWorkspace } from "./windowsStepWorkspace.js";

const roots: string[] = [];

afterEach(() => {
  closeFileServerLogSinks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function workspaceAt(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "step-copy",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  } as unknown as WorkspaceInfo;
}

describe("privateStepWorkspace (#4496)", () => {
  it("copies the workspace once without credential-named entries and links, then removes it", () => {
    const real = temporary("keiko-step-real-");
    const outside = temporary("keiko-step-outside-");
    mkdirSync(join(real, "src"));
    mkdirSync(join(real, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(real, ".ssh"));
    writeFileSync(join(real, "src", "index.ts"), "export {};\n");
    writeFileSync(join(real, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(real, ".env"), "SECRET=1\n");
    writeFileSync(join(real, ".env.example"), "SECRET=\n");
    writeFileSync(join(real, "src", "server.PEM"), "key\n");
    writeFileSync(join(real, ".ssh", "id_rsa"), "key\n");
    writeFileSync(join(outside, "data.txt"), "outside\n");
    symlinkSync(outside, join(real, "linked"));
    const stateRoot = temporary("keiko-step-log-");

    const step = privateStepWorkspace(
      workspaceAt(real),
      createActivityLogSink(stateRoot),
      "step-copy-proof",
    );
    const copy = step.workspace();

    expect(step.workspace()).toBe(copy);
    expect(copy.root).not.toBe(real);
    expect(copy.selectedRoot).toBe(copy.root);
    expect(readFileSync(join(copy.root, "src", "index.ts"), "utf8")).toBe("export {};\n");
    expect(existsSync(join(copy.root, "node_modules", "pkg", "index.js"))).toBe(true);
    expect(existsSync(join(copy.root, ".env.example"))).toBe(true);
    expect(existsSync(join(copy.root, ".env"))).toBe(false);
    expect(existsSync(join(copy.root, "src", "server.PEM"))).toBe(false);
    expect(existsSync(join(copy.root, ".ssh"))).toBe(false);
    expect(existsSync(join(copy.root, "linked"))).toBe(false);
    // The workspace itself is untouched.
    expect(existsSync(join(real, ".env"))).toBe(true);

    closeFileServerLogSinks();
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateRoot),
      "editor.verification.windows-step-copy",
    ).map((line) =>
      expectActivityLogProof("editor.verification.windows-step-copy.credentials-skipped", line),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      op: "editor.verification.windows-step-copy",
      correlationId: "step-copy-proof",
      outcome: "copied",
      skippedLinkCount: 1,
      skippedCredentialCount: 3,
      completeness: "complete",
      loss: "none",
    });

    step.dispose();
    expect(existsSync(copy.root)).toBe(false);
    step.dispose();
  });

  it("makes no copy for a run whose steps never asked for one", () => {
    const real = temporary("keiko-step-real-");
    const stateRoot = temporary("keiko-step-log-");
    privateStepWorkspace(workspaceAt(real), createActivityLogSink(stateRoot), undefined).dispose();
    closeFileServerLogSinks();
    expect(
      persistedActivityLogLines(
        readPersistedActivityLog(stateRoot),
        "editor.verification.windows-step-copy",
      ),
    ).toEqual([]);
  });

  it("names the credential files the Windows step canary places beside the private copy", () => {
    // scripts/testing/test-windows-step-confinement.mjs relies on these two names being left out.
    expect(isCredentialNamedSegment(".env")).toBe(true);
    expect(isCredentialNamedSegment("id_rsa")).toBe(true);
    expect(isCredentialNamedSegment("index.ts")).toBe(false);
  });
});
