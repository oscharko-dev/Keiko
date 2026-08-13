import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertProductiveTypeScriptRuntime,
  assertVendoredPayload,
  installIntoWithYarn,
  packRoot,
  runAsync,
  startLocalRegistry,
  terminateProcessTree,
} from "../installable-package-smoke.mjs";
import { provenancePublishArgs } from "../lib/npm-publish-preflight.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const ROOT_MANIFEST = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

afterEach(() => {
  vi.restoreAllMocks();
});

function rejectProcessExit() {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)})`);
  });
}

function writeExecutable(path, body) {
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 2_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, 25));
  }
  return !processExists(pid);
}

function localRegistryArtifact(root) {
  const tarballPath = join(root, "keiko.tgz");
  writeFileSync(tarballPath, "registry fixture bytes\n", "utf8");
  return {
    manifest: {
      name: ROOT_MANIFEST.name,
      version: ROOT_MANIFEST.version,
      bundleDependencies: ROOT_MANIFEST.bundleDependencies,
    },
    tarballPath,
  };
}

function writeVendoredRuntimeFixture(root) {
  const packageRoot = join(root, "node_modules", "@oscharko-dev", "keiko");
  for (const name of ROOT_MANIFEST.bundleDependencies) {
    const shortName = name.replace(/^@oscharko-dev\//u, "");
    const dist = join(packageRoot, "node_modules", "@oscharko-dev", shortName, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.js"), "export {};\n", "utf8");
  }
  const typescriptRoot = join(root, "node_modules", "typescript");
  mkdirSync(typescriptRoot, { recursive: true });
  writeFileSync(join(typescriptRoot, "package.json"), '{"name":"typescript"}\n', "utf8");
}

describe("registry install smoke security posture", () => {
  it("does not disable TLS verification for npm, yarn, or Node", () => {
    const source = readFileSync(join(ROOT, "scripts", "registry-install-smoke.mjs"), "utf8");

    expect(source).toContain("strict-ssl=true");
    expect(source).toContain("enableStrictSsl: true");
    expect(source).not.toContain("strict-ssl=false");
    expect(source).not.toContain("enableStrictSsl: false");
    expect(source).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed");
  });

  it("always executes the Yarn registry install proof for the root package", () => {
    const binDir = mkdtempSync(join(tmpdir(), "keiko-registry-smoke-bin-"));
    try {
      const installFixture = [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const version = process.env.ROOT_VERSION;",
        "const bundled = JSON.parse(process.env.BUNDLED_DEPS ?? '[]');",
        "const root = join(process.cwd(), 'node_modules', '@oscharko-dev', 'keiko');",
        "mkdirSync(join(root, 'dist', 'cli'), { recursive: true });",
        "writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));",
        "writeFileSync(join(root, 'dist', 'index.js'), `export const SDK_VERSION = ${JSON.stringify(version)};\\n`);",
        "writeFileSync(",
        "  join(root, 'dist', 'cli', 'index.js'),",
        "  `if (process.argv.includes('--version')) console.log('${version}'); else if (process.argv.includes('--help')) console.log('help'); else process.exit(2);\\n`,",
        ");",
        "for (const name of bundled) {",
        "  const shortName = name.replace(/^@oscharko-dev\\//u, '');",
        "  const dist = join(root, 'node_modules', '@oscharko-dev', shortName, 'dist');",
        "  mkdirSync(dist, { recursive: true });",
        "  writeFileSync(join(dist, 'index.js'), 'export {};\\n');",
        "}",
      ];
      writeExecutable(join(binDir, "npm"), installFixture.join("\n"));
      const marker = join(binDir, "corepack-called");
      writeExecutable(
        join(binDir, "corepack"),
        [
          ...installFixture,
          "writeFileSync(process.env.COREPACK_MARKER, 'called\\n', 'utf8');",
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, ["scripts/registry-install-smoke.mjs"], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          BUNDLED_DEPS: JSON.stringify(ROOT_MANIFEST.bundleDependencies),
          COREPACK_MARKER: marker,
          KEIKO_REGISTRY_INSTALL_PACKAGE: `${ROOT_MANIFEST.name}@${ROOT_MANIFEST.version}`,
          KEIKO_REGISTRY_URL: "https://registry.npmjs.org/",
          ROOT_VERSION: ROOT_MANIFEST.version,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `registry-install-smoke: PASS - ${ROOT_MANIFEST.name}@${ROOT_MANIFEST.version} installs`,
      );
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe("installable package smoke optional-dependency coverage", () => {
  it("serves a registry packument, tarball, and fail-closed missing response", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-local-registry-test-"));
    const artifact = localRegistryArtifact(root);
    const registry = await startLocalRegistry(artifact);
    try {
      const packumentResponse = await globalThis.fetch(
        `${registry.registryUrl}/${encodeURIComponent(ROOT_MANIFEST.name)}`,
      );
      const packument = await packumentResponse.json();
      const version = packument.versions[ROOT_MANIFEST.version];
      expect(packumentResponse.ok).toBe(true);
      expect(version.dist.integrity).toMatch(/^sha512-/u);
      const tarballResponse = await globalThis.fetch(version.dist.tarball);
      expect(await tarballResponse.text()).toBe("registry fixture bytes\n");
      expect((await globalThis.fetch(`${registry.registryUrl}/missing`)).status).toBe(404);
      expect(registry.requests).toEqual(
        expect.arrayContaining([`/${encodeURIComponent(ROOT_MANIFEST.name)}`, "/missing"]),
      );
    } finally {
      await registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes the registry when its health check rejects", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-local-registry-failure-test-"));
    const artifact = localRegistryArtifact(root);
    const healthFailure = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
    try {
      await expect(startLocalRegistry(artifact)).rejects.toThrow("offline");
    } finally {
      healthFailure.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes the registry when its health check is not OK", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-local-registry-http-failure-test-"));
    const artifact = localRegistryArtifact(root);
    const healthFailure = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 503 });
    try {
      await expect(startLocalRegistry(artifact)).rejects.toThrow("HTTP 503");
    } finally {
      healthFailure.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packs the root through the staged publish tree", () => {
    const previous = process.env.KEIKO_SMOKE_PACK_IGNORE_SCRIPTS;
    process.env.KEIKO_SMOKE_PACK_IGNORE_SCRIPTS = "1";
    let artifact;
    try {
      artifact = packRoot();
      expect(existsSync(artifact.tarballPath)).toBe(true);
      expect(artifact.manifest.bundleDependencies).toEqual(ROOT_MANIFEST.bundleDependencies);
    } finally {
      artifact?.cleanup();
      if (previous === undefined) delete process.env.KEIKO_SMOKE_PACK_IGNORE_SCRIPTS;
      else process.env.KEIKO_SMOKE_PACK_IGNORE_SCRIPTS = previous;
    }
  }, 60_000);

  it("runs the Yarn registry flow through the isolated project", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-yarn-registry-test-"));
    const binDir = join(root, "bin");
    const projectDir = join(root, "project");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const artifact = localRegistryArtifact(root);
    writeExecutable(join(binDir, "corepack"), "process.exit(0);");
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${previousPath}`;
    try {
      await installIntoWithYarn(projectDir, artifact);
      expect(readFileSync(join(projectDir, "package.json"), "utf8")).toContain(
        ROOT_MANIFEST.version,
      );
      expect(readFileSync(join(projectDir, ".yarnrc.yml"), "utf8")).toContain(
        "enableGlobalCache: false",
      );
    } finally {
      process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates nested vendored workspaces and the TypeScript runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-vendored-runtime-test-"));
    try {
      writeVendoredRuntimeFixture(root);
      expect(() => assertVendoredPayload(root)).not.toThrow();
      expect(() => assertProductiveTypeScriptRuntime(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing or empty vendored runtime workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-vendored-runtime-negative-test-"));
    try {
      rejectProcessExit();
      expect(() => assertVendoredPayload(root)).toThrow(/process\.exit\(1\)/u);

      vi.restoreAllMocks();
      const first = ROOT_MANIFEST.bundleDependencies[0].replace(/^@oscharko-dev\//u, "");
      mkdirSync(
        join(
          root,
          "node_modules",
          "@oscharko-dev",
          "keiko",
          "node_modules",
          "@oscharko-dev",
          first,
          "dist",
        ),
        { recursive: true },
      );
      rejectProcessExit();
      expect(() => assertVendoredPayload(root)).toThrow(/process\.exit\(1\)/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing productive TypeScript runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-typescript-runtime-negative-test-"));
    try {
      rejectProcessExit();
      expect(() => assertProductiveTypeScriptRuntime(root)).toThrow(/process\.exit\(1\)/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an asynchronous command spawn failure", async () => {
    const result = await runAsync(join(tmpdir(), "keiko-command-that-does-not-exist"), [], {
      timeout: 1_000,
    });

    expect(result.error?.code).toBe("ENOENT");
    expect(result.status).toBeNull();
  });

  it("treats an EPERM process probe as an existing process", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("operation not permitted");
      error.code = "EPERM";
      throw error;
    });

    expect(processExists(42)).toBe(true);
  });

  it("ignores an already-exited process while terminating a timed-out process tree", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("process not found");
      error.code = "ESRCH";
      throw error;
    });
    const childKill = vi.fn();

    terminateProcessTree({ pid: 42, kill: childKill });

    expect(kill).toHaveBeenCalledWith(-42, "SIGKILL");
    expect(childKill).not.toHaveBeenCalled();
  });

  it("falls back to killing the child when process-group termination fails", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("operation not permitted");
      error.code = "EPERM";
      throw error;
    });
    const childKill = vi.fn();

    terminateProcessTree({ pid: 42, kill: childKill });

    expect(childKill).toHaveBeenCalledWith("SIGKILL");
  });

  it("fails closed when the Yarn registry install command exits non-zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-yarn-registry-failure-test-"));
    const binDir = join(root, "bin");
    const projectDir = join(root, "project");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const artifact = localRegistryArtifact(root);
    writeExecutable(
      join(binDir, "corepack"),
      "process.stderr.write('rejected\\n'); process.exit(7);",
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${previousPath}`;
    try {
      rejectProcessExit();
      await expect(installIntoWithYarn(projectDir, artifact)).rejects.toThrow(
        /process\.exit\(1\)/u,
      );
    } finally {
      process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([undefined, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid asynchronous command timeout: %s",
    (timeout) => {
      expect(() => runAsync(process.execPath, ["--version"], { timeout })).toThrow(
        /requires a positive finite timeout/u,
      );
    },
  );

  it("settles a timed-out process-tree run and terminates its ready descendant", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-install-timeout-"));
    const fixture = join(fixtureRoot, "hang.mjs");
    const marker = join(fixtureRoot, "descendant-pid");
    let descendantPid;
    let readyRun;
    try {
      writeFileSync(
        fixture,
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });',
          'writeFileSync(process.env.DESCENDANT_PID_MARKER, String(child.pid), "utf8");',
          "setInterval(() => {}, 60_000);",
        ].join("\n"),
        "utf8",
      );
      readyRun = runAsync(process.execPath, [fixture], {
        env: { ...process.env, DESCENDANT_PID_MARKER: marker },
        timeout: 5_000,
      });
      const markerDeadline = Date.now() + 2_000;
      while (!existsSync(marker) && Date.now() < markerDeadline) {
        await new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, 25));
      }
      expect(existsSync(marker)).toBe(true);
      descendantPid = Number.parseInt(readFileSync(marker, "utf8"), 10);
      const startedAt = Date.now();
      const result = await readyRun;

      expect(result.timedOut).toBe(true);
      expect(result.status).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(6_000);
      expect(await waitForProcessExit(descendantPid)).toBe(true);
    } finally {
      await readyRun;
      if (descendantPid !== undefined && processExists(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps an explicit optional-dependency install mode", () => {
    const source = readFileSync(join(ROOT, "scripts", "installable-package-smoke.mjs"), "utf8");
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

    expect(source).toContain("--include-optional");
    expect(source).toContain("--omit=optional");
    expect(source).toContain("const DEFAULT_NPM_INSTALL_TIMEOUT_MS = 600_000;");
    expect(manifest.scripts["smoke:install:optional"]).toBe(
      "node scripts/installable-package-smoke.mjs --include-optional",
    );
  });
});

describe("release publish security posture", () => {
  it("requires TLS verification and npm provenance on the real publish path", () => {
    const source = readFileSync(join(ROOT, "scripts", "release-publish.mjs"), "utf8");
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");

    // The TLS pin RELOCATED with its owner (0.3.2): enforcement moved from refusing a weakened
    // user config to script-OWNED transport policy — the publish states strict-ssl=true in its
    // temporary userconfig AND re-states it through the environment, so a user-level
    // strict-ssl=false can neither weaken nor block a release. Strictly stronger than the
    // refusal message this replaces.
    expect(source).toContain('"strict-ssl=true"');
    expect(source).toContain('NPM_CONFIG_STRICT_SSL: "true"');
    // The provenance pin RELOCATED with its owner again (0.3.2 coverage repair): the predicate
    // moved into the in-process-testable preflight lib. Strengthened twice over: the publish
    // path must route through the single predicate (source pin), and the predicate itself is
    // held to its gating behavior — the flag appears exactly when BOTH GitHub-issued OIDC
    // values exist, because the request URL alone cannot mint a token (CodeRabbit on #3063:
    // substring presence cannot distinguish AND from OR).
    expect(source).toContain("provenancePublishArgs(process.env)");
    const url = "https://token.actions.example/exchange";
    const token = "runner-issued-value";
    expect(
      provenancePublishArgs({
        ACTIONS_ID_TOKEN_REQUEST_URL: url,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: token,
      }),
    ).toEqual(["--provenance"]);
    expect(provenancePublishArgs({ ACTIONS_ID_TOKEN_REQUEST_URL: url })).toEqual([]);
    expect(provenancePublishArgs({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: token })).toEqual([]);
    expect(provenancePublishArgs({})).toEqual([]);
    expect(workflow).toMatch(/publish:[\s\S]*permissions:[\s\S]*id-token:\s*write/u);
  });
});
