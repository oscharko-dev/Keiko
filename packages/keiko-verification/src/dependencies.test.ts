import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { DEPENDENCY_INSTALL_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/verification";
import {
  DEPENDENCY_INSTALL_ARGS,
  planDependencyBootstrap,
  runDependencyBootstrap,
  type DependencyBootstrapDeps,
} from "./dependencies.js";
import { recordingSpawn, scriptChildClose } from "./_support.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-deps-"));
  roots.push(root);
  return root;
}

function workspaceAt(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "demo",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function writeManifestText(root: string, content: string): void {
  writeFileSync(join(root, "package.json"), content, "utf8");
}

function writeManifest(root: string, manifest: Readonly<Record<string, unknown>>): void {
  writeManifestText(root, JSON.stringify(manifest));
}

function bootstrapDepsFor(
  root: string,
  spawn: DependencyBootstrapDeps["spawn"],
): DependencyBootstrapDeps {
  return {
    workspace: workspaceAt(root),
    fs: nodeWorkspaceFs,
    spawn,
    processEnv: process.env,
    now: () => 1_000,
  };
}

describe("planDependencyBootstrap", () => {
  it("plans 'none' when the workspace has no package.json", () => {
    const root = tempRoot();
    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({ kind: "none" });
  });

  it("plans 'none' when package.json declares no dependencies", () => {
    const root = tempRoot();
    writeManifest(root, { name: "demo", scripts: { test: "vitest run" } });
    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({ kind: "none" });
  });

  it("plans 'none' when every declaration section is present but empty", () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: {}, devDependencies: {}, optionalDependencies: {} });
    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({ kind: "none" });
  });

  it("refuses with manifest-unreadable when package.json is malformed JSON", () => {
    const root = tempRoot();
    writeManifestText(root, "{ not valid json");
    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({
      kind: "refused",
      reason: "manifest-unreadable",
      lockfile: "absent",
    });
  });

  it("refuses with manifest-unreadable when package.json JSON is not a plain object", () => {
    const root = tempRoot();
    writeManifestText(root, JSON.stringify(["dependencies", "not", "an", "object"]));
    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({
      kind: "refused",
      reason: "manifest-unreadable",
      lockfile: "absent",
    });
  });

  it("refuses with manifest-unreadable when package.json exceeds the size cap, and still reports a present lockfile", () => {
    const root = tempRoot();
    writeManifestText(root, JSON.stringify({ dependencies: {}, padding: "x".repeat(1_048_577) }));
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({
      kind: "refused",
      reason: "manifest-unreadable",
      lockfile: "present",
    });
  });

  it("refuses with project-npm-config when a project .npmrc is present", () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    writeFileSync(join(root, ".npmrc"), "registry=https://example.invalid\n", "utf8");
    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({
      kind: "refused",
      reason: "project-npm-config",
      lockfile: "absent",
    });
  });

  it("plans 'install' when dependencies are declared and the installed-tree marker is absent", () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({
      kind: "install",
      lockfile: "absent",
    });
  });

  it("reports lockfile 'present' in an install plan when a root lockfile already exists", () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({
      kind: "install",
      lockfile: "present",
    });
  });

  it("plans 'current' when the hidden installed-tree marker is newer than the manifest and lockfile", () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".package-lock.json"), "{}", "utf8");

    const base = new Date("2024-01-01T00:00:00.000Z");
    const installedAt = new Date(base.getTime() + 60_000);
    utimesSync(join(root, "package.json"), base, base);
    utimesSync(join(root, "package-lock.json"), base, base);
    utimesSync(join(root, "node_modules", ".package-lock.json"), installedAt, installedAt);

    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({
      kind: "current",
      lockfile: "present",
    });
  });

  it("plans 'install' when the manifest was modified after the installed-tree marker", () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".package-lock.json"), "{}", "utf8");

    const installedAt = new Date("2024-01-01T00:00:00.000Z");
    const manifestTouchedAt = new Date(installedAt.getTime() + 60_000);
    utimesSync(join(root, "node_modules", ".package-lock.json"), installedAt, installedAt);
    utimesSync(join(root, "package.json"), manifestTouchedAt, manifestTouchedAt);

    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({
      kind: "install",
      lockfile: "absent",
    });
  });
});

describe("runDependencyBootstrap — settled plans (no spawn)", () => {
  it("settles 'none' without spawning", async () => {
    const rec = recordingSpawn();
    const outcome = await runDependencyBootstrap(
      { kind: "none" },
      bootstrapDepsFor(tempRoot(), rec.fn),
    );
    expect(outcome).toEqual({
      summary: { state: "none", lockfile: "absent", exitCode: null, durationMs: 0 },
    });
    expect(rec.calls()).toHaveLength(0);
  });

  it("settles 'current' without spawning", async () => {
    const rec = recordingSpawn();
    const outcome = await runDependencyBootstrap(
      { kind: "current", lockfile: "present" },
      bootstrapDepsFor(tempRoot(), rec.fn),
    );
    expect(outcome).toEqual({
      summary: { state: "current", lockfile: "present", exitCode: null, durationMs: 0 },
    });
    expect(rec.calls()).toHaveLength(0);
  });

  it("settles 'refused' (project-npm-config) without spawning, with a fixed redacted detail", async () => {
    const rec = recordingSpawn();
    const outcome = await runDependencyBootstrap(
      { kind: "refused", reason: "project-npm-config", lockfile: "absent" },
      bootstrapDepsFor(tempRoot(), rec.fn),
    );
    expect(outcome).toEqual({
      summary: {
        state: "refused",
        lockfile: "absent",
        exitCode: null,
        durationMs: 0,
        detail: "project npm config present; dependency installation refused",
      },
    });
    expect(rec.calls()).toHaveLength(0);
  });

  it("settles 'refused' (manifest-unreadable) without spawning", async () => {
    const rec = recordingSpawn();
    const outcome = await runDependencyBootstrap(
      { kind: "refused", reason: "manifest-unreadable", lockfile: "present" },
      bootstrapDepsFor(tempRoot(), rec.fn),
    );
    expect(outcome.summary.detail).toBe("package.json unreadable; dependency installation refused");
    expect(rec.calls()).toHaveLength(0);
  });
});

describe("runDependencyBootstrap — install exec outcomes", () => {
  it("spawns npm with the exact DEPENDENCY_INSTALL_ARGS argv and maps exit 0 to installed", async () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    const plan = planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs);
    expect(plan).toEqual({ kind: "install", lockfile: "absent" });

    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stdout: "added 1 package in 400ms\n", exitCode: 0 });
    const outcome = await runDependencyBootstrap(plan, bootstrapDepsFor(root, rec.fn));

    expect(rec.calls()).toHaveLength(1);
    // The resolved executable is an absolute, host-specific path (matches the "node" step's own
    // toMatch pattern in orchestrator.test.ts), never the bare "npm" the plan/summary carry.
    expect(rec.calls()[0]?.command).toMatch(/npm/u);
    expect(rec.calls()[0]?.args).toEqual(DEPENDENCY_INSTALL_ARGS);
    expect(DEPENDENCY_INSTALL_ARGS).toContain("--ignore-scripts");
    expect(outcome.summary).toEqual({
      state: "installed",
      lockfile: "absent",
      exitCode: 0,
      durationMs: expect.any(Number) as number,
    });
    expect(outcome.excerpt).toBeUndefined();
  });

  it("reports lockfile 'created' when the install writes package-lock.json before exiting", async () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    const plan = planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs);
    expect(plan).toEqual({ kind: "install", lockfile: "absent" });
    // Simulates npm having written the lockfile as a side effect of the (faked) install.
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");

    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stdout: "added 1 package\n", exitCode: 0 });
    const outcome = await runDependencyBootstrap(plan, bootstrapDepsFor(root, rec.fn));

    expect(outcome.summary.state).toBe("installed");
    expect(outcome.summary.lockfile).toBe("created");
  });

  it("maps a non-zero npm exit to failed, with a redacted excerpt of the captured output", async () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    const plan = planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs);

    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stderr: "npm ERR! network failure\n", exitCode: 1 });
    const outcome = await runDependencyBootstrap(plan, bootstrapDepsFor(root, rec.fn));

    expect(outcome.summary.state).toBe("failed");
    expect(outcome.summary.exitCode).toBe(1);
    expect(outcome.summary.lockfile).toBe("absent");
    expect(outcome.summary.detail).toBe("npm install failed (exit 1)");
    expect(outcome.excerpt).toBe("npm ERR! network failure");
  });

  it("never lets a failed summary carry the raw child output beyond the redacted excerpt", async () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    const plan = planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs);
    const secretToken = "ghp_" + "A".repeat(36);

    const rec = recordingSpawn();
    scriptChildClose(rec.child, {
      stderr: `npm ERR! auth failed token=${secretToken}\n`,
      exitCode: 1,
    });
    const outcome = await runDependencyBootstrap(plan, bootstrapDepsFor(root, rec.fn));

    expect(JSON.stringify(outcome.summary)).not.toContain(secretToken);
    expect(outcome.excerpt).not.toContain(secretToken);
    expect(outcome.excerpt).toContain("[REDACTED]");
  });

  // Coding Workbench run 15/16 (ADR-0043 D17): an install that never exits within the wall-time
  // ceiling must not silently hang the verification tool. `runCommand` (keiko-tools) enforces the
  // ceiling via its own internal timer, so a fake child that never emits "close" on its own lets
  // fake timers drive that ceiling deterministically instead of waiting DEPENDENCY_INSTALL_LIMITS
  // .wallTimeMs (240s) of real time.
  it("settles an npm install that outlives its wall-time ceiling as timed-out", async () => {
    vi.useFakeTimers();
    try {
      const root = tempRoot();
      writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
      const plan = planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs);

      const rec = recordingSpawn(); // never closes on its own
      const pending = runDependencyBootstrap(plan, bootstrapDepsFor(root, rec.fn));
      await vi.advanceTimersByTimeAsync(DEPENDENCY_INSTALL_LIMITS.wallTimeMs);
      // The ceiling's own SIGTERM does not make a stub child exit; emulate it dying afterwards,
      // mirroring keiko-tools/src/exec.test.ts's "times out and rejects" fake-child pattern.
      rec.child.emit("close", null, "SIGTERM");
      const outcome = await pending;

      expect(outcome.summary.exitCode).toBeNull();
      // The boundary rejects on its own ceiling; the summary names that, not a generic failure.
      expect(outcome.summary.state).toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });

  // The run going away aborts the install; the summary says it was cancelled, not that npm failed.
  it("settles an npm install aborted by its run as cancelled", async () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    const plan = planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs);
    const controller = new AbortController();

    const rec = recordingSpawn(); // never closes on its own
    const pending = runDependencyBootstrap(plan, {
      ...bootstrapDepsFor(root, rec.fn),
      signal: controller.signal,
    });
    controller.abort();
    rec.child.emit("close", null, "SIGTERM");
    const outcome = await pending;

    expect(outcome.summary.exitCode).toBeNull();
    expect(outcome.summary.state).toBe("cancelled");
  });
});
