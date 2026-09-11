import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { DEPENDENCY_INSTALL_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/verification";
import {
  DEPENDENCY_APPROVED_REGISTRY,
  DEPENDENCY_INSTALL_ARGS,
  planDependencyBootstrap,
  runDependencyBootstrap,
  type DependencyBootstrapDeps,
} from "./dependencies.js";
import { recordingSpawn, scriptChildClose } from "./_support.js";
import { registryEgressEnv, type RegistryEgressProxy } from "./registryEgress.js";

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

const REGISTRY_INTEGRITY = `sha512-${"A".repeat(86)}==`;

function registryEntry(name: string): Readonly<Record<string, unknown>> {
  return {
    version: "1.3.0",
    resolved: `${DEPENDENCY_APPROVED_REGISTRY}${name}/-/${name}-1.3.0.tgz`,
    integrity: REGISTRY_INTEGRITY,
  };
}

// The lockfile npm 7+ writes (version 3): the workspace's own folder plus what it installs.
function lockfileText(packages: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } });
}

function writeLockfile(root: string, packages?: Readonly<Record<string, unknown>>): void {
  writeFileSync(join(root, "package-lock.json"), lockfileText(packages), "utf8");
}

// npm's hidden lockfile: the tree an install left behind, which the bootstrap reads back.
function writeInstalledTree(
  root: string,
  packages: Readonly<Record<string, unknown>> = {
    "node_modules/left-pad": registryEntry("left-pad"),
  },
): void {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", ".package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
    "utf8",
  );
}

function planFor(root: string): ReturnType<typeof planDependencyBootstrap> {
  return planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs);
}

// Termination reaches a fake child through its process group on POSIX and through the child itself
// on Windows. The group kill is stubbed, so the fake child's pid never signals a real process group
// on the host.
function recordTerminationSignals(): {
  readonly sent: (child: {
    readonly pid?: number | undefined;
    readonly killed: readonly string[];
  }) => readonly string[];
  readonly restore: () => void;
} {
  const groupKill = vi.spyOn(process, "kill").mockImplementation(() => true);
  return {
    sent: (child) => [
      ...groupKill.mock.calls.flatMap(([pid, signal]) =>
        child.pid !== undefined && pid === -child.pid && typeof signal === "string" ? [signal] : [],
      ),
      ...child.killed,
    ],
    restore: (): void => {
      groupKill.mockRestore();
    },
  };
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
    writeLockfile(root);
    expect(planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs)).toEqual({
      kind: "install",
      lockfile: "present",
    });
  });

  it("plans 'current' when the hidden installed-tree marker is newer than the manifest and lockfile", () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    writeLockfile(root);
    writeInstalledTree(root);

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
    writeInstalledTree(root);

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

// The install keeps host network, so every source npm would contact is checked before it runs
// (CodeRabbit review, PR #3452: CWE-918 and CWE-494).
describe("planDependencyBootstrap — dependency sources", () => {
  it.each([
    ["dependencies", "http://registry.internal.example/left-pad-1.3.0.tgz"],
    ["dependencies", "https://example.com/left-pad-1.3.0.tgz"],
    ["dependencies", "http://169.254.169.254/latest/meta-data"],
    ["devDependencies", "git+ssh://git@github.com/owner/repo.git"],
    ["devDependencies", "github:owner/repo"],
    ["optionalDependencies", "owner/repo"],
    ["peerDependencies", "git@github.com:owner/repo.git"],
    ["dependencies", "file:../outside"],
    ["dependencies", "./vendor/left-pad"],
    ["dependencies", "."],
    ["dependencies", "left-pad-1.3.0.tgz"],
    ["dependencies", "npm:left-pad@github:owner/repo"],
  ])(
    "refuses a %s specifier %j that names a location instead of the registry",
    (section, specifier) => {
      const root = tempRoot();
      writeManifest(root, {
        devDependencies: { typescript: "^6.0.3" },
        [section]: { probe: specifier },
      });
      expect(planFor(root)).toEqual({
        kind: "refused",
        reason: "unapproved-source",
        lockfile: "absent",
      });
    },
  );

  it.each([
    "1.3.0",
    "^6.0.3",
    "~1.2.3",
    ">=1.0.0 <2.0.0 || 3.x",
    "latest",
    "*",
    "",
    "1.0.0-beta.1+build.5",
    "npm:left-pad@^1.3.0",
    "npm:@scope/left-pad@1.3.0",
  ])("plans an install for the registry specifier %j", (specifier) => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { probe: specifier } });
    expect(planFor(root)).toEqual({ kind: "install", lockfile: "absent" });
  });

  it.each([
    [
      "an override naming a tarball URL",
      { overrides: { "left-pad": "http://registry.internal.example/x.tgz" } },
    ],
    [
      "a nested override naming a Git remote",
      { overrides: { react: { "left-pad": "github:owner/repo" } } },
    ],
    ["a workspace pattern leaving the workspace", { workspaces: ["../outside/*"] }],
    ["an absolute workspace pattern", { workspaces: ["/srv/packages/*"] }],
    [
      "a workspaces field npm cannot read as patterns",
      { workspaces: { packages: ["packages/*"] } },
    ],
  ])("refuses %s", (_label, fields) => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.3.0" }, ...fields });
    expect(planFor(root)).toEqual({
      kind: "refused",
      reason: "unapproved-source",
      lockfile: "absent",
    });
  });

  it("plans an install for registry overrides, a dependency reference and contained workspaces", () => {
    const root = tempRoot();
    writeManifest(root, {
      dependencies: { "left-pad": "1.3.0" },
      overrides: { react: "18.3.1", "left-pad": { "is-number": "$left-pad" } },
      workspaces: ["packages/*", "./tools/cli"],
    });
    expect(planFor(root)).toEqual({ kind: "install", lockfile: "absent" });
  });

  it("plans an install when every lockfile entry is the workspace, a link, a bundle or the registry", () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.3.0" }, workspaces: ["packages/*"] });
    writeLockfile(root, {
      "packages/app": { version: "1.0.0" },
      "node_modules/app": { resolved: "packages/app", link: true },
      "node_modules/left-pad": registryEntry("left-pad"),
      "node_modules/left-pad/node_modules/bundled": { version: "1.0.0", inBundle: true },
      "node_modules/unresolved": { version: "1.0.0", integrity: REGISTRY_INTEGRITY },
    });
    expect(planFor(root)).toEqual({ kind: "install", lockfile: "present" });
  });

  const registryUrl = `${DEPENDENCY_APPROVED_REGISTRY}left-pad/-/left-pad-1.3.0.tgz`;
  it.each([
    ["a cleartext URL", { resolved: registryUrl.replace("https:", "http:") }],
    [
      "another host",
      { resolved: "https://registry.internal.example/left-pad/-/left-pad-1.3.0.tgz" },
    ],
    ["a user in the URL", { resolved: registryUrl.replace("https://", "https://operator@") }],
    ["a non-default port", { resolved: registryUrl.replace(".org/", ".org:8443/") }],
    ["a Git remote", { resolved: "git+ssh://git@github.com/owner/repo.git#0123abc" }],
    ["no integrity", { integrity: undefined }],
    ["a malformed integrity", { integrity: "md5-0123" }],
  ])("refuses a lockfile entry with %s", (_label, override) => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.3.0" } });
    writeLockfile(root, { "node_modules/left-pad": { ...registryEntry("left-pad"), ...override } });
    expect(planFor(root)).toEqual({
      kind: "refused",
      reason: "unapproved-source",
      lockfile: "present",
    });
  });

  it.each([
    [
      "a link leaving the workspace",
      { "node_modules/app": { resolved: "../outside", link: true } },
    ],
    [
      "an install location leaving the workspace",
      { "node_modules/../../outside": registryEntry("x") },
    ],
    ["a workspace folder with a source", { "packages/app": registryEntry("app") }],
  ])("refuses a lockfile with %s", (_label, packages) => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.3.0" } });
    writeLockfile(root, packages);
    expect(planFor(root)).toEqual({
      kind: "refused",
      reason: "unapproved-source",
      lockfile: "present",
    });
  });

  it.each([
    ["an empty object", "{}"],
    ["a version-1 lockfile", JSON.stringify({ lockfileVersion: 1, dependencies: {} })],
    ["malformed JSON", "{ not json"],
    ["packages that are not an object", JSON.stringify({ lockfileVersion: 3, packages: [] })],
  ])("refuses a lockfile that is %s as unreadable", (_label, text) => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.3.0" } });
    writeFileSync(join(root, "package-lock.json"), text, "utf8");
    expect(planFor(root)).toEqual({
      kind: "refused",
      reason: "lockfile-unreadable",
      lockfile: "present",
    });
  });

  it("checks npm-shrinkwrap.json as it checks package-lock.json", () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.3.0" } });
    writeFileSync(
      join(root, "npm-shrinkwrap.json"),
      lockfileText({
        "node_modules/left-pad": {
          ...registryEntry("left-pad"),
          resolved: "http://registry.internal.example/x.tgz",
        },
      }),
      "utf8",
    );
    expect(planFor(root)).toEqual({
      kind: "refused",
      reason: "unapproved-source",
      lockfile: "present",
    });
  });

  it("refuses a current installed tree that names an unapproved source instead of running against it", () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.3.0" } });
    writeInstalledTree(root, {
      "node_modules/left-pad": {
        ...registryEntry("left-pad"),
        resolved: "http://registry.internal.example/x.tgz",
      },
    });
    const base = new Date("2024-01-01T00:00:00.000Z");
    const installedAt = new Date(base.getTime() + 60_000);
    utimesSync(join(root, "package.json"), base, base);
    utimesSync(join(root, "node_modules", ".package-lock.json"), installedAt, installedAt);

    expect(planFor(root)).toEqual({
      kind: "refused",
      reason: "unapproved-source",
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

    writeInstalledTree(root); // npm's hidden lockfile, as the (faked) install leaves it

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
      egress: { allowed: 0, refused: 0 },
    });
    expect(outcome.excerpt).toBeUndefined();
  });

  it("reports lockfile 'created' when the install writes package-lock.json before exiting", async () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    const plan = planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs);
    expect(plan).toEqual({ kind: "install", lockfile: "absent" });
    // Simulates npm having written both lockfiles as a side effect of the (faked) install.
    writeLockfile(root, { "node_modules/left-pad": registryEntry("left-pad") });
    writeInstalledTree(root);

    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stdout: "added 1 package\n", exitCode: 0 });
    const outcome = await runDependencyBootstrap(plan, bootstrapDepsFor(root, rec.fn));

    expect(outcome.summary.state).toBe("installed");
    expect(outcome.summary.lockfile).toBe("created");
  });

  // A registry package may itself name a URL or Git source; npm fetches it and records it in the
  // tree it installs. The fetch cannot be prevented, but no step ever runs against what it brought.
  it("refuses an installed tree that names an unapproved source, so no step runs against it", async () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.3.0" } });
    const plan = planFor(root);
    expect(plan).toEqual({ kind: "install", lockfile: "absent" });
    writeInstalledTree(root, {
      "node_modules/left-pad": registryEntry("left-pad"),
      "node_modules/left-pad/node_modules/inner": {
        version: "1.0.0",
        resolved: "http://registry.internal.example/inner-1.0.0.tgz",
        integrity: REGISTRY_INTEGRITY,
      },
    });

    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stdout: "added 2 packages\n", exitCode: 0 });
    const outcome = await runDependencyBootstrap(plan, bootstrapDepsFor(root, rec.fn));

    expect(outcome.summary).toEqual({
      state: "refused",
      lockfile: "absent",
      exitCode: 0,
      durationMs: expect.any(Number) as number,
      detail: expect.stringContaining("approved HTTPS registry") as string,
      egress: { allowed: 0, refused: 0 },
    });
    expect(outcome.excerpt).toBeUndefined();
  });

  it("refuses an install that left no installed-tree lockfile to check", async () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.3.0" } });
    const plan = planFor(root);

    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stdout: "added 1 package\n", exitCode: 0 });
    const outcome = await runDependencyBootstrap(plan, bootstrapDepsFor(root, rec.fn));

    expect(outcome.summary.state).toBe("refused");
    expect(outcome.summary.detail).toContain("lockfile");
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
    const signals = recordTerminationSignals();
    try {
      const root = tempRoot();
      writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
      const plan = planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs);

      const rec = recordingSpawn(); // never closes on its own
      const terminations: unknown[] = [];
      const pending = runDependencyBootstrap(plan, {
        ...bootstrapDepsFor(root, rec.fn),
        onTerminated: (evidence) => {
          terminations.push(evidence);
        },
      });
      await vi.advanceTimersByTimeAsync(DEPENDENCY_INSTALL_LIMITS.wallTimeMs);
      expect(signals.sent(rec.child)).toContain("SIGTERM");
      // The ceiling's own SIGTERM does not make a stub child exit; emulate it dying afterwards,
      // mirroring keiko-tools/src/exec.test.ts's "times out and rejects" fake-child pattern.
      rec.child.emit("close", null, "SIGTERM");
      const outcome = await pending;

      expect(outcome.summary.exitCode).toBeNull();
      // The boundary rejects on its own ceiling; the summary names that, not a generic failure.
      expect(outcome.summary.state).toBe("timed-out");
      // The ceiling's kill reaches the termination evidence seam every governed step reports
      // through: exactly one decision, attributed to the wall-time ceiling.
      expect(terminations).toEqual([expect.objectContaining({ reason: "timeout" })]);
    } finally {
      signals.restore();
      vi.useRealTimers();
    }
  });

  // The run going away aborts the install; the summary says it was cancelled, not that npm failed.
  it("settles an npm install aborted by its run as cancelled", async () => {
    const root = tempRoot();
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    const plan = planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs);
    const controller = new AbortController();
    const signals = recordTerminationSignals();
    try {
      const rec = recordingSpawn(); // never closes on its own
      const terminations: unknown[] = [];
      const pending = runDependencyBootstrap(plan, {
        ...bootstrapDepsFor(root, rec.fn),
        signal: controller.signal,
        onTerminated: (evidence) => {
          terminations.push(evidence);
        },
      });
      // npm starts once the egress proxy is listening; the run goes away while it runs.
      await vi.waitFor(() => {
        expect(rec.calls()).toHaveLength(1);
      });
      controller.abort();
      // The abort must reach the child before it closes: an implementation that ignored the signal
      // would still read "cancelled" off the aborted signal once the child closed on its own
      // (CodeRabbit review, PR #3452).
      await vi.waitFor(() => {
        expect(signals.sent(rec.child)).toContain("SIGTERM");
      });
      rec.child.emit("close", null, "SIGTERM");
      const outcome = await pending;

      expect(outcome.summary.exitCode).toBeNull();
      expect(outcome.summary.state).toBe("cancelled");
      expect(terminations).toEqual([expect.objectContaining({ reason: "abort" })]);
    } finally {
      signals.restore();
    }
  });
});

// The install's egress (ADR-0043 D17): npm reaches the network only through the registry egress
// proxy, which the bootstrap starts, hands to npm through its pinned environment, counts and closes.
describe("runDependencyBootstrap — registry egress", () => {
  function fakeEgressProxy(
    counts = { allowed: 0, refused: 0 },
  ): RegistryEgressProxy & { readonly closed: () => number } {
    let closed = 0;
    return {
      url: "http://127.0.0.1:4873",
      counts: () => counts,
      close: (): Promise<void> => {
        closed += 1;
        return Promise.resolve();
      },
      closed: () => closed,
    };
  }

  function installPlan(root: string): ReturnType<typeof planDependencyBootstrap> {
    writeManifest(root, { dependencies: { "left-pad": "1.0.0" } });
    return planDependencyBootstrap(workspaceAt(root), nodeWorkspaceFs);
  }

  it("runs npm behind the egress proxy, records its tunnels and closes it", async () => {
    const root = tempRoot();
    const plan = installPlan(root);
    writeInstalledTree(root);
    const proxy = fakeEgressProxy({ allowed: 3, refused: 0 });
    const rec = recordingSpawn();
    scriptChildClose(rec.child, { exitCode: 0 });

    const outcome = await runDependencyBootstrap(plan, {
      ...bootstrapDepsFor(root, rec.fn),
      startEgressProxy: () => Promise.resolve(proxy),
    });

    const env = rec.calls()[0]?.options.env;
    expect(env).toMatchObject(registryEgressEnv(proxy.url, DEPENDENCY_APPROVED_REGISTRY));
    // The configuration is only as good as its wiring: the proxy itself must reach the child.
    expect(env?.npm_config_https_proxy).toBe(proxy.url);
    expect(outcome.summary).toMatchObject({
      state: "installed",
      egress: { allowed: 3, refused: 0 },
    });
    expect(proxy.closed()).toBe(1);
  });

  it("settles an install that failed after a refused destination as refused", async () => {
    const root = tempRoot();
    const plan = installPlan(root);
    const proxy = fakeEgressProxy({ allowed: 1, refused: 2 });
    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stderr: "npm error 403 Forbidden\n", exitCode: 1 });

    const outcome = await runDependencyBootstrap(plan, {
      ...bootstrapDepsFor(root, rec.fn),
      startEgressProxy: () => Promise.resolve(proxy),
    });

    expect(outcome.summary).toMatchObject({
      state: "refused",
      exitCode: 1,
      egress: { allowed: 1, refused: 2 },
      detail: expect.stringContaining("source other than the approved HTTPS registry") as string,
    });
    expect(proxy.closed()).toBe(1);
  });

  it("keeps an install that failed without a refused destination a failure", async () => {
    const root = tempRoot();
    const plan = installPlan(root);
    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stderr: "npm error ETARGET\n", exitCode: 1 });

    const outcome = await runDependencyBootstrap(plan, {
      ...bootstrapDepsFor(root, rec.fn),
      startEgressProxy: () => Promise.resolve(fakeEgressProxy({ allowed: 2, refused: 0 })),
    });

    expect(outcome.summary).toMatchObject({ state: "failed", egress: { allowed: 2, refused: 0 } });
  });

  it("fails closed without spawning npm when the egress proxy cannot start", async () => {
    const root = tempRoot();
    const plan = installPlan(root);
    const rec = recordingSpawn();

    const outcome = await runDependencyBootstrap(plan, {
      ...bootstrapDepsFor(root, rec.fn),
      startEgressProxy: () => Promise.reject(new Error("listen EADDRINUSE")),
    });

    expect(rec.calls()).toHaveLength(0);
    expect(outcome.summary).toMatchObject({
      state: "failed",
      exitCode: null,
      detail: expect.stringContaining("egress proxy could not start") as string,
    });
    expect(outcome.summary).not.toHaveProperty("egress");
  });

  it("cancels an install whose run went away before npm started, without spawning it", async () => {
    const root = tempRoot();
    const plan = installPlan(root);
    const proxy = fakeEgressProxy();
    const controller = new AbortController();
    controller.abort();
    const rec = recordingSpawn();

    const outcome = await runDependencyBootstrap(plan, {
      ...bootstrapDepsFor(root, rec.fn),
      signal: controller.signal,
      startEgressProxy: () => Promise.resolve(proxy),
    });

    expect(rec.calls()).toHaveLength(0);
    expect(outcome.summary).toMatchObject({
      state: "cancelled",
      egress: { allowed: 0, refused: 0 },
    });
    expect(proxy.closed()).toBe(1);
  });

  it("closes the egress proxy when the run aborts the install", async () => {
    const root = tempRoot();
    const plan = installPlan(root);
    const proxy = fakeEgressProxy();
    const controller = new AbortController();
    const signals = recordTerminationSignals();
    try {
      const rec = recordingSpawn(); // never closes on its own
      const pending = runDependencyBootstrap(plan, {
        ...bootstrapDepsFor(root, rec.fn),
        signal: controller.signal,
        startEgressProxy: () => Promise.resolve(proxy),
      });
      await vi.waitFor(() => {
        expect(rec.calls()).toHaveLength(1);
      });
      controller.abort();
      await vi.waitFor(() => {
        expect(signals.sent(rec.child)).toContain("SIGTERM");
      });
      rec.child.emit("close", null, "SIGTERM");
      const outcome = await pending;

      expect(outcome.summary.state).toBe("cancelled");
      expect(proxy.closed()).toBe(1);
    } finally {
      signals.restore();
    }
  });
});
