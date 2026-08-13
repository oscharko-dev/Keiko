import { Buffer } from "node:buffer";
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
  minimumSatisfyingVersion,
  resolveVendorClosure,
  assertRegistryOnlyDescriptors,
  persistentVendorSeedDir,
  seedThenPack,
  seedVendoredRegistry,
  stubManifest,
  findInstalledCopies,
  runAsync,
  startLocalRegistry,
  terminateProcessTree,
  vendoredDependencyNames,
  vendoredDependencyRequirements,
  yarnChildEnv,
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

  // #3130: before this pin the Yarn arm pointed only the `oscharko-dev` scope at the local
  // registry and installed with a deleted lockfile, so the whole transitive graph resolved live
  // from public npm. A 22-minute partial publish of `@napi-rs/canvas` 1.0.6 turned every Keiko
  // pull request red on 2026-08-13. The install must now be answerable entirely offline.
  it("routes every package through the local registry, not only the oscharko-dev scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-yarn-hermetic-test-"));
    const binDir = join(root, "bin");
    const projectDir = join(root, "project");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const artifact = localRegistryArtifact(root);
    writeExecutable(join(binDir, "corepack"), "process.exit(0);");
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${previousPath}`;
    try {
      await installIntoWithYarn(projectDir, artifact, new Map());
      const rc = readFileSync(join(projectDir, ".yarnrc.yml"), "utf8");
      const globalRegistry = /^npmRegistryServer: (http:\/\/127\.0\.0\.1:\d+)$/mu.exec(rc);
      expect(globalRegistry).not.toBeNull();
      // The scoped entry must point at the same loopback registry, so no resolution path is left
      // pointing at the public registry.
      expect(rc).toContain(`    npmRegistryServer: ${globalRegistry?.[1] ?? ""}`);
      // No resolution path may reference a public registry, and the architecture narrowing the
      // offline closure depends on must be present.
      expect(rc).not.toMatch(/registry\.(?:npmjs|yarnpkg)\.(?:org|com)/u);
      expect(rc).toContain("supportedArchitectures:");
      expect(rc).toContain(`    - ${process.platform}`);
      expect(rc).toContain(`    - ${process.arch}`);
      // A hermetic gate makes no outbound telemetry call either.
      expect(rc).toContain("enableTelemetry: false");
    } finally {
      process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves the repository-pinned third-party closure and 404s anything unseeded", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-yarn-closure-test-"));
    const artifact = localRegistryArtifact(root);
    const seeded = new Map([
      [
        "yauzl",
        new Map([
          [
            "3.4.0",
            {
              name: "yauzl",
              version: "3.4.0",
              tarballBytes: Buffer.from("yauzl fixture"),
              manifest: {
                name: "yauzl",
                version: "3.4.0",
                optionalDependencies: { fsevents: "*" },
              },
            },
          ],
        ]),
      ],
    ]);
    const registry = await startLocalRegistry(artifact, seeded);
    try {
      const served = await globalThis.fetch(`${registry.registryUrl}/yauzl`);
      expect(served.ok).toBe(true);
      const packument = await served.json();
      expect(packument.versions["3.4.0"].dist.tarball).toContain("/yauzl/-/yauzl-3.4.0.tgz");
      // Optional edges are preserved, so the running platform's real native binding still
      // installs and is still proven; the foreign-platform prebuilds resolve to inert stubs
      // instead of reaching the public registry (#3130).
      expect(packument.versions["3.4.0"].optionalDependencies).toEqual({ fsevents: "*" });

      // An unseeded package must not fall through to the public registry.
      const unseeded = await globalThis.fetch(`${registry.registryUrl}/@napi-rs%2Fcanvas`);
      expect(unseeded.status).toBe(404);
    } finally {
      await registry.close();
    }
  });

  // The first #3130 attempt passed on macOS and failed on Linux CI: npm drops an optional
  // dependency entirely when its platform prebuild cannot be installed, so `@napi-rs/canvas` was
  // present here and absent there, and Yarn — which resolves optional entries regardless — got a
  // 404 from the offline registry. An absent optional package must resolve to an inert stub.
  it("stubs an optional dependency the tree does not install, and still fails on a real absence", () => {
    // The incident itself: an OPTIONAL dependency the tree does not install must become a stub,
    // resolvable and inert, so Yarn's resolution step closes instead of 404ing.
    const optionalAbsent = resolveVendorClosure(join(ROOT, "node_modules"), {
      dependencies: {},
      optionalDependencies: { "keiko-smoke-absent-optional": "^2.3.4" },
      bundleDependencies: [],
    });
    expect(optionalAbsent.missing).toEqual([]);
    expect(optionalAbsent.stubs).toEqual([
      { name: "keiko-smoke-absent-optional", version: "2.3.4" },
    ]);

    // A non-optional absence stays fatal — the stub path must never mask a genuine gap.
    const requiredAbsent = resolveVendorClosure(join(ROOT, "node_modules"), {
      dependencies: { "keiko-smoke-absent-optional": "^2.3.4" },
      bundleDependencies: [],
    });
    expect(requiredAbsent.missing).toEqual(["keiko-smoke-absent-optional"]);
    expect(requiredAbsent.stubs).toEqual([]);
  });

  // Yarn reads YARN_* env vars above .yarnrc.yml, so an ambient override on a runner would send
  // the install back to a live registry and straight past the fail-closed 404s.
  it("neutralizes ambient Yarn registry environment overrides", () => {
    const env = yarnChildEnv("http://127.0.0.1:12345", {
      PATH: "/usr/bin",
      YARN_NPM_REGISTRY_SERVER: "https://registry.example.invalid",
      YARN_NPM_ALWAYS_AUTH: "true",
      YARN_UNSAFE_HTTP_WHITELIST: "example.invalid",
      YARN_ENABLE_NETWORK: "true",
      YARN_NODE_LINKER: "pnp",
      YARN_RC_FILENAME: "/tmp/elsewhere.yml",
    });
    expect(env.YARN_NPM_REGISTRY_SERVER).toBe("http://127.0.0.1:12345");
    expect(env.YARN_UNSAFE_HTTP_WHITELIST).toBe("127.0.0.1");
    expect(env.YARN_NPM_ALWAYS_AUTH).toBeUndefined();
    expect(env.YARN_ENABLE_NETWORK).toBeUndefined();
    expect(env.YARN_ENABLE_GLOBAL_CACHE).toBe("false");
    expect(env.PATH).toBe("/usr/bin");
    // Any YARN_* setting can change the install shape, not only the registry ones: a linker or
    // rc-file override would leave no node_modules tree for the assertions to inspect.
    expect(env.YARN_RC_FILENAME).toBeUndefined();
    expect(env.YARN_NODE_LINKER).toBe("node-modules");
    expect(env.YARN_ENABLE_TELEMETRY).toBe("false");
    // Corepack must not fetch the package manager mid-install; the pinned tool is provisioned first.
    expect(env.COREPACK_ENABLE_NETWORK).toBe("0");
  });

  // A stub's platform guards must reach the PACKUMENT, not just the tarball: Yarn decides
  // compatibility from packument metadata, so without them it would link the empty stub and a
  // missing native binding could pass unnoticed.
  it("keeps the stub platform guards in the served packument", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-stub-packument-test-"));
    const artifact = localRegistryArtifact(root);
    const tarballPath = join(root, "stub.tgz");
    writeFileSync(tarballPath, "stub bytes\n", "utf8");
    const seeded = new Map([
      [
        "@napi-rs/canvas-linux-x64-musl",
        new Map([
          [
            "1.0.2",
            {
              name: "@napi-rs/canvas-linux-x64-musl",
              version: "1.0.2",
              tarballPath,
              integrity: "sha512-stub",
              manifest: stubManifest("@napi-rs/canvas-linux-x64-musl", "1.0.2"),
            },
          ],
        ]),
      ],
    ]);
    const registry = await startLocalRegistry(artifact, seeded);
    try {
      const packument = await (
        await globalThis.fetch(`${registry.registryUrl}/@napi-rs%2Fcanvas-linux-x64-musl`)
      ).json();
      const served = packument.versions["1.0.2"];
      expect(served.os).toEqual(["keiko-smoke-never-matches"]);
      expect(served.cpu).toEqual(["keiko-smoke-never-matches"]);
      // The guards must not match any real host, or the stub could be linked somewhere.
      expect(served.os).not.toContain(process.platform);
      expect(served.cpu).not.toContain(process.arch);
    } finally {
      await registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a copy nested below a workspace's own node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-workspace-nested-test-"));
    try {
      // packages/<workspace>/node_modules/a/node_modules/demo — npm nests conflicts under a
      // workspace exactly as it does under the hoisted tree.
      const deep = join(
        root,
        "packages",
        "keiko-demo",
        "node_modules",
        "a",
        "node_modules",
        "demo",
      );
      mkdirSync(deep, { recursive: true });
      writeFileSync(
        join(deep, "package.json"),
        JSON.stringify({ name: "demo", version: "9.9.9" }),
        "utf8",
      );
      const copies = findInstalledCopies("demo", join(root, "node_modules"), root);
      expect(copies.map((copy) => copy.version)).toEqual(["9.9.9"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a copy nested below another nested dependency", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-nested-scan-test-"));
    try {
      // node_modules/a/node_modules/b/node_modules/demo — deeper than one level.
      const deep = join(root, "node_modules", "a", "node_modules", "b", "node_modules", "demo");
      mkdirSync(deep, { recursive: true });
      writeFileSync(
        join(deep, "package.json"),
        JSON.stringify({ name: "demo", version: "4.5.6" }),
        "utf8",
      );
      const copies = findInstalledCopies("demo", join(root, "node_modules"), root);
      expect(copies.map((copy) => copy.version)).toEqual(["4.5.6"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packs installed dependencies and synthesizes stubs for absent optional ones", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-seed-test-"));
    const destination = mkdtempSync(join(tmpdir(), "keiko-seed-out-"));
    try {
      const demoDir = join(root, "node_modules", "demo");
      mkdirSync(demoDir, { recursive: true });
      writeFileSync(
        join(demoDir, "package.json"),
        JSON.stringify({
          name: "demo",
          version: "1.2.3",
          optionalDependencies: { "demo-absent-platform": "^4.5.6" },
        }),
        "utf8",
      );

      const seeded = seedVendoredRegistry(destination, join(root, "node_modules"), {
        dependencies: { demo: "^1.2.3" },
        bundleDependencies: [],
      });

      const packed = seeded.get("demo")?.get("1.2.3");
      expect(packed?.integrity).toMatch(/^sha512-/u);
      expect(existsSync(packed?.tarballPath ?? "")).toBe(true);

      // The absent optional dependency is synthesized, with its platform guards intact.
      const stub = seeded.get("demo-absent-platform")?.get("4.5.6");
      expect(stub?.manifest.os).toEqual(["keiko-smoke-never-matches"]);
      expect(existsSync(stub?.tarballPath ?? "")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  }, 60_000);

  // A package first seen as optional may later be genuinely REQUIRED by another parent. Serving
  // the inert stub for that required edge would let the smoke pass without the real dependency.
  it("withdraws an optional stub when another package requires the same dependency", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-stub-withdraw-test-"));
    try {
      // The two edges must come from DIFFERENT parents: within one manifest they are merged
      // before the walk, so only a cross-parent fixture reaches the branch under test.
      const write = (name, manifest) => {
        const dir = join(root, "node_modules", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...manifest }), "utf8");
      };
      write("parent-optional", {
        version: "1.0.0",
        optionalDependencies: { "keiko-smoke-absent-both": "^7.8.9" },
      });
      write("parent-required", {
        version: "1.0.0",
        dependencies: { "keiko-smoke-absent-both": "^7.8.9" },
      });

      const closure = resolveVendorClosure(join(root, "node_modules"), {
        dependencies: { "parent-optional": "^1.0.0", "parent-required": "^1.0.0" },
        bundleDependencies: [],
      });
      // The optional edge is visited first and stubs the package; the required edge must withdraw
      // that stub, or a genuinely required dependency would be served as an inert stub. Across
      // DIFFERENT manifests the required edge binds — unlike within one manifest, where npm gives
      // optionalDependencies precedence.
      expect(closure.stubs).toEqual([]);
      expect(closure.missing).toEqual(["keiko-smoke-absent-both"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ranks a prerelease below its own release when naming dist-tags.latest", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-prerelease-test-"));
    const artifact = localRegistryArtifact(root);
    const versions = new Map();
    for (const version of ["1.0.0", "1.0.0-beta.2", "1.0.0-beta.10"]) {
      const tarballPath = join(root, `demo-${version}.tgz`);
      writeFileSync(tarballPath, `demo ${version}\n`, "utf8");
      versions.set(version, {
        name: "demo",
        version,
        tarballPath,
        integrity: `sha512-${version}`,
        manifest: { name: "demo", version },
      });
    }
    const registry = await startLocalRegistry(artifact, new Map([["demo", versions]]));
    try {
      const packument = await (await globalThis.fetch(`${registry.registryUrl}/demo`)).json();
      // Lexical ordering would name 1.0.0-beta.2 latest; SemVer precedence names the release.
      expect(packument["dist-tags"].latest).toBe("1.0.0");
      const ordered = Object.keys(packument.versions);
      // beta.2 precedes beta.10 numerically, not lexically.
      expect(ordered.indexOf("1.0.0-beta.2")).toBeLessThan(ordered.indexOf("1.0.0-beta.10"));
    } finally {
      await registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a seeded dependency that would resolve outside the registry", () => {
    const offending = new Map([
      [
        "demo",
        new Map([
          [
            "1.0.0",
            {
              name: "demo",
              version: "1.0.0",
              manifest: {
                name: "demo",
                version: "1.0.0",
                dependencies: { sneaky: "git+https://example.invalid/pkg.git" },
              },
            },
          ],
        ]),
      ],
    ]);
    rejectProcessExit();
    // Yarn resolves such a descriptor directly, never through npmRegistryServer, so the install
    // would leave the hermetic boundary without ever hitting a fail-closed 404.
    expect(() => assertRegistryOnlyDescriptors(offending)).toThrow(/process\.exit\(1\)/u);

    vi.restoreAllMocks();
    const clean = new Map([
      [
        "demo",
        new Map([
          [
            "1.0.0",
            { name: "demo", version: "1.0.0", manifest: { dependencies: { ok: "^1.0.0" } } },
          ],
        ]),
      ],
    ]);
    expect(() => assertRegistryOnlyDescriptors(clean)).not.toThrow();
  });

  it("keys the vendor seed directory to the lockfile so a second run reuses it", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-seed-key-test-"));
    try {
      const lockA = join(root, "a.json");
      const lockB = join(root, "b.json");
      writeFileSync(lockA, '{"lockfileVersion":3}', "utf8");
      writeFileSync(lockB, '{"lockfileVersion":4}', "utf8");
      // CI runs this script twice against one checkout; the second run must find the first run's
      // pre-prune artifacts rather than re-deriving them from a tree prepack has since pruned.
      expect(persistentVendorSeedDir(lockA)).toBe(persistentVendorSeedDir(lockA));
      expect(persistentVendorSeedDir(lockA)).not.toBe(persistentVendorSeedDir(lockB));
      expect(existsSync(persistentVendorSeedDir(lockA))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the request instead of crashing when a tarball cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-stream-error-test-"));
    const artifact = localRegistryArtifact(root);
    const seeded = new Map([
      [
        "demo",
        new Map([
          [
            "1.0.0",
            {
              name: "demo",
              version: "1.0.0",
              // Points at a path that does not exist, so the read stream errors mid-response.
              tarballPath: join(root, "definitely-missing.tgz"),
              integrity: "sha512-missing",
              manifest: { name: "demo", version: "1.0.0" },
            },
          ],
        ]),
      ],
    ]);
    const registry = await startLocalRegistry(artifact, seeded);
    try {
      await expect(
        globalThis.fetch(`${registry.registryUrl}/demo/-/demo-1.0.0.tgz`).then((r) => r.text()),
      ).rejects.toThrow();
      // The registry itself must survive: a later request still succeeds.
      const stillAlive = await globalThis.fetch(`${registry.registryUrl}/demo`);
      expect(stillAlive.ok).toBe(true);
    } finally {
      await registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `prepack` runs `prune:package-native-optionals`, which deletes @napi-rs/canvas out of
  // node_modules. Seeding after packRoot() would therefore stub the current host's native binding
  // and let the Yarn arm pass without it, so main() must seed BEFORE packing.
  it("seeds the vendored registry before packRoot prunes native optionals", () => {
    // Observes the production calls rather than their source positions: a text-order pin would
    // stay green if a refactor moved the effective call and left the statement text in place.
    const calls = [];
    const { vendored, artifact } = seedThenPack("/tmp/keiko-seed-order-fixture", {
      seedVendoredRegistry: (destination) => {
        calls.push("seed");
        return new Map([["destination", destination]]);
      },
      packRoot: () => {
        calls.push("pack");
        return { manifest: { name: "fixture" }, tarballPath: "/tmp/fixture.tgz" };
      },
    });
    expect(calls).toEqual(["seed", "pack"]);
    expect(vendored.get("destination")).toBe("/tmp/keiko-seed-order-fixture");
    expect(artifact.tarballPath).toBe("/tmp/fixture.tgz");
  });

  // npm's package-json contract: within ONE manifest, an optionalDependencies entry overrides a
  // same-named dependencies entry. An earlier revision of this test asserted the opposite and was
  // wrong about npm, not about the code.
  it("lets optionalDependencies override dependencies inside one manifest", () => {
    const requirements = vendoredDependencyRequirements(
      {
        dependencies: { demo: "^2.0.0" },
        optionalDependencies: { demo: "^1.0.0" },
        bundleDependencies: [],
      },
      ROOT,
    );
    const demo = requirements.find((entry) => entry.name === "demo");
    expect(demo?.optional).toBe(true);
    expect(demo?.range).toBe("^1.0.0");
  });

  // Two bundled workspaces may declare the same absent optional dependency under non-overlapping
  // ranges. A name-keyed map would keep only the first, and Yarn — which still resolves the second
  // descriptor from the tarball — would find no candidate for it.
  it("keeps every distinct optional range for the same package", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-multi-range-test-"));
    try {
      for (const [workspace, range] of [
        ["keiko-alpha", "^1.0.0"],
        ["keiko-beta", "^2.0.0"],
      ]) {
        const dir = join(root, "packages", workspace);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            name: `@oscharko-dev/${workspace}`,
            optionalDependencies: { "keiko-smoke-absent-multi": range },
          }),
          "utf8",
        );
      }
      const requirements = vendoredDependencyRequirements(
        {
          dependencies: {},
          bundleDependencies: ["@oscharko-dev/keiko-alpha", "@oscharko-dev/keiko-beta"],
        },
        root,
      );
      const ranges = requirements
        .filter((entry) => entry.name === "keiko-smoke-absent-multi")
        .map((entry) => entry.range)
        .sort();
      expect(ranges).toEqual(["^1.0.0", "^2.0.0"]);

      // Each distinct range yields its own stub, so both descriptors can resolve.
      const closure = resolveVendorClosure(
        join(root, "node_modules"),
        {
          dependencies: {},
          bundleDependencies: ["@oscharko-dev/keiko-alpha", "@oscharko-dev/keiko-beta"],
        },
        root,
      );
      expect(closure.stubs.map((stub) => stub.version).sort()).toEqual(["1.0.0", "2.0.0"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a concrete stub version across the npm range forms it models", () => {
    expect(minimumSatisfyingVersion("^1.0.2")).toBe("1.0.2");
    expect(minimumSatisfyingVersion("~3.4.5")).toBe("3.4.5");
    expect(minimumSatisfyingVersion("2.0.0")).toBe("2.0.0");
    expect(minimumSatisfyingVersion(">=1.2.3")).toBe("1.2.3");
    expect(minimumSatisfyingVersion("v4.5.6")).toBe("4.5.6");
    // A wildcard is satisfied by anything, so the lowest version is a valid stub.
    expect(minimumSatisfyingVersion("*")).toBe("0.0.0");
    expect(minimumSatisfyingVersion("")).toBe("0.0.0");
    // x-ranges resolve to the lowest member of the range.
    expect(minimumSatisfyingVersion("1.x")).toBe("1.0.0");
    expect(minimumSatisfyingVersion("1.2.x")).toBe("1.2.0");
    expect(minimumSatisfyingVersion("3")).toBe("3.0.0");
    // A grammar this helper does not model stays undefined, which recordAbsent treats as fatal —
    // serving a stub that does not satisfy the range would fail later and far less legibly.
    expect(minimumSatisfyingVersion("npm:other@^1.0.0")).toBeUndefined();
    expect(minimumSatisfyingVersion("github:owner/repo")).toBeUndefined();
    // A strict comparator excludes its own boundary, so no stub version is derivable.
    expect(minimumSatisfyingVersion(">1.2.3")).toBeUndefined();
    expect(minimumSatisfyingVersion("<2.0.0")).toBeUndefined();
    // `>=` does include the boundary.
    expect(minimumSatisfyingVersion(">=1.2.3")).toBe("1.2.3");
    // An exact prerelease is satisfied only by itself, so the suffix must survive.
    expect(minimumSatisfyingVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });

  // An unseeded .tgz used to fall through to the root artifact with HTTP 200, so a request for a
  // package we never vendored was answered with real Keiko bytes under a foreign name. A hermetic
  // registry must refuse, not substitute.
  it("never answers an unseeded or wrong-version tarball with the root artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-yarn-tarball-test-"));
    const artifact = localRegistryArtifact(root);
    const stubTarball = join(root, "yauzl.tgz");
    writeFileSync(stubTarball, "yauzl fixture bytes\n", "utf8");
    const seeded = new Map([
      [
        "yauzl",
        new Map([
          [
            "3.4.0",
            {
              name: "yauzl",
              version: "3.4.0",
              tarballPath: stubTarball,
              integrity: "sha512-fixture",
              manifest: { name: "yauzl", version: "3.4.0" },
            },
          ],
        ]),
      ],
    ]);
    const registry = await startLocalRegistry(artifact, seeded);
    try {
      const seededTarball = await globalThis.fetch(
        `${registry.registryUrl}/yauzl/-/yauzl-3.4.0.tgz`,
      );
      expect(await seededTarball.text()).toBe("yauzl fixture bytes\n");

      // Wrong version of a seeded package.
      const wrongVersion = await globalThis.fetch(
        `${registry.registryUrl}/yauzl/-/yauzl-9.9.9.tgz`,
      );
      expect(wrongVersion.status).toBe(404);

      // Never-seeded package.
      const unseeded = await globalThis.fetch(
        `${registry.registryUrl}/@napi-rs/canvas/-/canvas-1.0.2.tgz`,
      );
      expect(unseeded.status).toBe(404);

      // The root package's own tarball is still served.
      const rootShortName = ROOT_MANIFEST.name.split("/").at(-1);
      const rootTarball = await globalThis.fetch(
        `${registry.registryUrl}/${ROOT_MANIFEST.name}/-/${rootShortName}-${ROOT_MANIFEST.version}.tgz`,
      );
      expect(await rootTarball.text()).toBe("registry fixture bytes\n");
    } finally {
      await registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("orders dist-tags.latest numerically, not lexicographically", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-yarn-version-order-test-"));
    const artifact = localRegistryArtifact(root);
    const versions = new Map();
    for (const version of ["1.0.9", "1.0.10"]) {
      const tarballPath = join(root, `demo-${version}.tgz`);
      writeFileSync(tarballPath, `demo ${version}\n`, "utf8");
      versions.set(version, {
        name: "demo",
        version,
        tarballPath,
        integrity: `sha512-${version}`,
        manifest: { name: "demo", version },
      });
    }
    const registry = await startLocalRegistry(artifact, new Map([["demo", versions]]));
    try {
      const packument = await (await globalThis.fetch(`${registry.registryUrl}/demo`)).json();
      // A string sort would name 1.0.9 latest because "9" > "1".
      expect(packument["dist-tags"].latest).toBe("1.0.10");
    } finally {
      await registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes the third-party dependency closure over the repository's installed tree", () => {
    const bundled = ROOT_MANIFEST.bundleDependencies ?? [];
    expect(bundled.length).toBeGreaterThan(0);
    const names = vendoredDependencyNames(ROOT_MANIFEST);
    expect(names).not.toContain(bundled[0]);
    expect(names.length).toBeGreaterThan(0);

    const { packages, missing } = resolveVendorClosure(join(ROOT, "node_modules"), ROOT_MANIFEST);
    expect(missing).toEqual([]);
    const resolvedNames = packages.map((entry) => entry.name);
    for (const name of names) expect(resolvedNames).toContain(name);
    // Transitive runtime dependencies are included, so the registry can answer the whole graph.
    // `pend` is reachable only through `yauzl`, so it proves the walk is genuinely transitive.
    const transitive = resolvedNames.filter((name) => !names.includes(name));
    expect(transitive.length).toBeGreaterThan(0);
    expect(resolvedNames).toContain("pend");
    for (const entry of packages) expect(entry.version).toMatch(/^\d+\.\d+\.\d+/u);
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
