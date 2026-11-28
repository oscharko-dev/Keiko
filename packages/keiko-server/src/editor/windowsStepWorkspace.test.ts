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
import { rm } from "node:fs/promises";
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
  it("copies the workspace once without credential-named entries and links, then removes it", async () => {
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

    const cleanup = await step.dispose();
    expect(existsSync(copy.root)).toBe(false);
    expect(cleanup).toMatchObject({ retryCount: 0 });
    expect(await step.dispose()).toBeUndefined();
  });

  it("makes no copy for a run whose steps never asked for one", async () => {
    const real = temporary("keiko-step-real-");
    const stateRoot = temporary("keiko-step-log-");
    await privateStepWorkspace(
      workspaceAt(real),
      createActivityLogSink(stateRoot),
      undefined,
    ).dispose();
    closeFileServerLogSinks();
    expect(
      persistedActivityLogLines(
        readPersistedActivityLog(stateRoot),
        "editor.verification.windows-step-copy",
      ),
    ).toEqual([]);
  });

  describe("removing the copy", () => {
    function copiedStep(
      host: Parameters<typeof privateStepWorkspace>[3],
      correlationId = "step-cleanup",
    ): { readonly step: ReturnType<typeof privateStepWorkspace>; readonly root: string } {
      const real = temporary("keiko-step-real-");
      writeFileSync(join(real, "index.ts"), "export {};\n");
      const step = privateStepWorkspace(
        workspaceAt(real),
        createActivityLogSink(temporary("keiko-step-log-")),
        correlationId,
        host,
      );
      return { step, root: step.workspace().root };
    }

    it("settles only once the copy is gone, so the next copy is never made beside it", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { step, root } = copiedStep({
        remove: async (path, options) => {
          await gate;
          await rm(path, options);
        },
      });

      let settled = false;
      const disposal = step.dispose().then((cleanup) => {
        settled = true;
        return cleanup;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(existsSync(root)).toBe(true);

      release();
      const cleanup = await disposal;
      expect(existsSync(root)).toBe(false);
      expect(cleanup).toMatchObject({ retryCount: 0 });
    });

    it("retries a transient removal failure with a growing delay and reports the retry count", async () => {
      const delays: number[] = [];
      let failures = 2;
      const clock = [100, 160];
      const { step, root } = copiedStep({
        remove: async (path, options) => {
          if (failures > 0) {
            failures -= 1;
            throw Object.assign(new Error("busy"), { code: "EBUSY" });
          }
          await rm(path, options);
        },
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        now: () => clock.shift() ?? 160,
      });

      expect(await step.dispose()).toEqual({ durationMs: 60, retryCount: 2 });
      expect(delays).toEqual([100, 200]);
      expect(existsSync(root)).toBe(false);
    });

    it("gives up after five retries, records the failure and still settles", async () => {
      let attempts = 0;
      const { step } = copiedStep({
        remove: () => {
          attempts += 1;
          return Promise.reject(Object.assign(new Error("locked"), { code: "EPERM" }));
        },
        sleep: () => Promise.resolve(),
      });

      expect(await step.dispose()).toMatchObject({ retryCount: 5 });
      expect(attempts).toBe(6);
    });

    it("does not retry an error that is not transient", async () => {
      let attempts = 0;
      const { step } = copiedStep({
        remove: () => {
          attempts += 1;
          return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
        },
        sleep: () => Promise.reject(new Error("must not wait")),
      });

      expect(await step.dispose()).toMatchObject({ retryCount: 0 });
      expect(attempts).toBe(1);
    });
  });

  it("names the credential files the Windows step canary places beside the private copy", () => {
    // scripts/testing/test-windows-step-confinement.mjs relies on these two names being left out.
    expect(isCredentialNamedSegment(".env")).toBe(true);
    expect(isCredentialNamedSegment("id_rsa")).toBe(true);
    expect(isCredentialNamedSegment("index.ts")).toBe(false);
  });
});
