import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  assertHostBindingsAreReal,
  assertStubsAreForeignOnly,
  writeSeedIndex,
  hostBindingSuffixes,
  corepackCacheDir,
  privateYarnHome,
  assertStagedRootDescriptors,
  YARN_RC_FILENAME,
  isStagedVendorArchive,
  classifyProvisionFailure,
  persistentVendorSeedDir,
  seedThenPack,
  loadSeedIndex,
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
import {
  PINNED_YARN,
  PINNED_YARN_SHA512,
  PINNED_YARN_SOURCE_URL,
  PINNED_YARN_VERSION,
  pinnedYarnVersionFromLocator,
} from "../lib/pinned-yarn.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const ROOT_MANIFEST = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const SMOKE_INVOCATION = /npm run smoke:install(?::optional)?/u;

/**
 * `ci.yml` split into its top-level jobs, so a workflow assertion can be scoped to the job that
 * owns the steps instead of scanning the whole document — the difference between proving a step
 * runs in THIS job and proving it runs somewhere in the file.
 */
function ciJobs() {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const body = workflow.slice(workflow.indexOf("\njobs:"));
  const starts = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gmu)];
  return starts.map((start, index) => ({
    name: start[1],
    text: body.slice(start.index, starts[index + 1]?.index ?? body.length),
  }));
}

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
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, "utf8");
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

function isolatedChildEnv(root, extraEnv = {}) {
  const sandboxTmp = join(root, "tmp");
  mkdirSync(sandboxTmp, { recursive: true });
  return {
    PATH: join(root, "bin"),
    TMPDIR: sandboxTmp,
    TMP: sandboxTmp,
    TEMP: sandboxTmp,
    ...extraEnv,
  };
}

function runIsolatedSmokeModule(root, source, extraEnv = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: ROOT,
    encoding: "utf8",
    env: isolatedChildEnv(root, extraEnv),
    timeout: 15_000,
  });
}

function runProvisionPinnedYarnChild(root, extraEnv = {}, locator = PINNED_YARN) {
  return runIsolatedSmokeModule(
    root,
    [
      'import { provisionPinnedYarnForSetup } from "./scripts/installable-package-smoke.mjs";',
      `provisionPinnedYarnForSetup(${JSON.stringify(locator)});`,
    ].join("\n"),
    extraEnv,
  );
}

function yarnSha512ForBytes(bytes) {
  return createHash("sha512").update(bytes).digest("hex");
}

function yarnLocatorForBytes(version, bytes) {
  return `yarn@${version}+sha512.${yarnSha512ForBytes(bytes)}`;
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
  // `new URL()` passes `%zz` through untouched and `decodeURIComponent` raises `URIError` on it.
  // Unhandled inside an http handler that is an uncaught exception, so the registry would die
  // mid-install and the gate would report a crash instead of a verdict. The second half of this
  // test is the point: the server must still be serving afterwards (KfQ thread 3780494646).
  it("answers a malformed request path instead of dying on it", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-local-registry-malformed-test-"));
    const artifact = localRegistryArtifact(root);
    const registry = await startLocalRegistry(artifact);
    try {
      for (const malformed of ["/%zz", "/%", "/foo%E0%A4%A.tgz", "/%2f-%2f%ff.tgz"]) {
        const response = await globalThis.fetch(`${registry.registryUrl}${malformed}`);
        expect(response.status, `${malformed} must be answered, not crash the server`).toBe(400);
      }
      // Still serving: a request that used to be unreachable once the process had died.
      const packument = await globalThis.fetch(
        `${registry.registryUrl}/${encodeURIComponent(ROOT_MANIFEST.name)}`,
      );
      expect(packument.ok).toBe(true);
    } finally {
      await registry.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      expect(readFileSync(join(projectDir, YARN_RC_FILENAME), "utf8")).toContain(
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
      // The default name must NOT be present. Writing under a private name is only half of the
      // isolation — leaving a `.yarnrc.yml` behind would restore exactly the ancestor-and-default
      // discovery the private name exists to defeat (KfQ thread 3780545615).
      expect(existsSync(join(projectDir, ".yarnrc.yml"))).toBe(false);
      const rc = readFileSync(join(projectDir, YARN_RC_FILENAME), "utf8");
      const globalRegistry = /^npmRegistryServer: (http:\/\/127\.0\.0\.1:\d+)$/mu.exec(rc);
      expect(globalRegistry).not.toBeNull();
      // EVERY scoped entry must equal the global loopback registry, compared as a whole value
      // rather than searched for as a substring. `toContain` would also accept a scoped entry
      // that merely STARTS with the loopback URL — `http://127.0.0.1:12345.evil.example/` embeds
      // `http://127.0.0.1:12345` and would have passed, leaving that scope resolving off-host
      // while the assertion stayed green (KfQ thread 3780296820).
      const scopedRegistries = [...rc.matchAll(/^ {4}npmRegistryServer: (\S+)$/gmu)].map(
        (match) => match[1],
      );
      expect(scopedRegistries.length).toBeGreaterThan(0);
      for (const scoped of scopedRegistries) {
        expect(scoped).toBe(globalRegistry?.[1]);
      }
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
    // rc-file override would leave no node_modules tree for the assertions to inspect. The rc
    // filename is now REPLACED rather than merely stripped — stripping it restored the default
    // `.yarnrc.yml`, which Yarn also merges from every ancestor of a project living under a
    // world-writable `os.tmpdir()`. Overriding it with the private per-run name is the stronger
    // assertion: the ambient value cannot survive, and neither can an ancestor file.
    expect(env.YARN_RC_FILENAME).toBe(YARN_RC_FILENAME);
    expect(env.YARN_RC_FILENAME).toMatch(/^\.yarnrc-keiko-[0-9a-f]{18}\.yml$/u);
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

  it("finds a copy nested arbitrarily deep, past any fixed limit", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-deep-nesting-test-"));
    try {
      // Ten levels: deeper than the fixed depth the previous revision imposed, which would have
      // reported this package missing even though the installation contains it.
      let dir = join(root, "node_modules");
      for (let level = 0; level < 10; level += 1) dir = join(dir, `pkg${level}`, "node_modules");
      const deep = join(dir, "demo");
      mkdirSync(deep, { recursive: true });
      writeFileSync(
        join(deep, "package.json"),
        JSON.stringify({ name: "demo", version: "7.7.7" }),
        "utf8",
      );
      const copies = findInstalledCopies("demo", join(root, "node_modules"), root);
      expect(copies.map((copy) => copy.version)).toEqual(["7.7.7"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

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

  const seededWithDependency = (range) =>
    new Map([
      [
        "demo",
        new Map([
          [
            "1.0.0",
            {
              name: "demo",
              version: "1.0.0",
              manifest: { name: "demo", version: "1.0.0", dependencies: { sneaky: range } },
            },
          ],
        ]),
      ],
    ]);

  // Yarn resolves each of these directly rather than through npmRegistryServer, so the install
  // would leave the hermetic boundary without ever hitting a fail-closed 404.
  it.each([
    ["git+https", "git+https://token@example.invalid/pkg.git"],
    ["ssh", "ssh://user:token@example.invalid/repo.git"],
    ["ssh+git", "ssh+git://example.invalid/repo.git"],
    ["forge shorthand", "owner/repo"],
    ["portal", "portal:../elsewhere"],
  ])("rejects a %s dependency before Yarn starts", (_label, range) => {
    rejectProcessExit();
    expect(() => assertRegistryOnlyDescriptors(seededWithDependency(range))).toThrow(
      /process\.exit\(1\)/u,
    );
  });

  it("names the descriptor's shape without leaking its value", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    expect(() =>
      assertRegistryOnlyDescriptors(
        seededWithDependency("git+https://token@secret-host.invalid/pkg.git"),
      ),
    ).toThrow(/process\.exit\(1\)/u);
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).toContain("demo@1.0.0 -> sneaky (git+https:)");
    // The value may carry a credential or a private endpoint and must never reach the log.
    expect(logged).not.toContain("secret-host.invalid");
  });

  it.each([
    ["a semver range", "^1.0.0"],
    ["an npm alias", "npm:other@^1.0.0"],
    ["a scoped npm alias", "npm:@scope/pkg@1.0.0"],
    ["a tag", "beta"],
  ])("accepts %s", (_label, range) => {
    expect(() => assertRegistryOnlyDescriptors(seededWithDependency(range))).not.toThrow();
  });

  it("packs scope-ambiguous names without one archive overwriting the other", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-pack-collision-test-"));
    const destination = mkdtempSync(join(tmpdir(), "keiko-pack-collision-out-"));
    try {
      const names = ["@foo/bar-baz", "@foo-bar/baz"];
      for (const name of names) {
        const dir = join(root, "node_modules", ...name.split("/"));
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name, version: "1.2.3", description: name }),
          "utf8",
        );
      }
      const seeded = seedVendoredRegistry(destination, join(root, "node_modules"), {
        dependencies: { "@foo/bar-baz": "^1.2.3", "@foo-bar/baz": "^1.2.3" },
        bundleDependencies: [],
      });

      const packed = names.map((name) => seeded.get(name)?.get("1.2.3")?.tarballPath ?? "");
      for (const tarballPath of packed) expect(existsSync(tarballPath)).toBe(true);
      // Distinct paths, and each archive still carries its own bytes.
      expect(packed[0]).not.toBe(packed[1]);
      expect(readFileSync(packed[0] ?? "")).not.toEqual(readFileSync(packed[1] ?? ""));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  }, 60_000);

  // CI runs this script twice as separate processes and the first run's prepack prunes the native
  // optionals out of the shared checkout. A directory alone did not carry the seed across: the
  // second process started from an empty map and re-derived stubs from the pruned tree.
  it("reuses the pre-prune seed in a second process after the tree is pruned", () => {
    const tree = mkdtempSync(join(tmpdir(), "keiko-two-process-tree-"));
    const seedDir = mkdtempSync(join(tmpdir(), "keiko-two-process-seed-"));
    const manifest = { dependencies: { "demo-native": "^1.0.0" }, bundleDependencies: [] };
    try {
      const packageDir = join(tree, "node_modules", "demo-native");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "demo-native", version: "1.0.0" }),
        "utf8",
      );

      const first = seedVendoredRegistry(seedDir, join(tree, "node_modules"), manifest);
      const realTarball = first.get("demo-native")?.get("1.0.0")?.tarballPath;
      expect(realTarball).toBeDefined();

      // prepack prunes the package out of the shared tree.
      rmSync(packageDir, { recursive: true, force: true });

      // Second process: fresh map, pruned tree, same seed directory.
      const second = seedVendoredRegistry(
        seedDir,
        join(tree, "node_modules"),
        manifest,
        loadSeedIndex(seedDir),
      );
      const entry = second.get("demo-native")?.get("1.0.0");
      // The real archive, not a stub, and the very same file.
      expect(entry?.manifest?.os).toBeUndefined();
      expect(entry?.tarballPath).toBe(realTarball);
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
    }
  }, 60_000);

  // The counterpart to the test above, and the reason sharing this cache is safe. Two invocations
  // share it within one checkout and both read the index before either publishes, so a process
  // that seeded AFTER the prune would otherwise publish stubs carrying a matching integrity value
  // — and the other process would accept them precisely because the stub is intact. A real archive
  // is integrity-verified on read and self-heals; a stub is a legitimate artifact for a foreign
  // platform and cannot be told apart from one by integrity (Codex thread 3780203131).
  it("persists a foreign-platform stub but never this host's own binding stub", () => {
    const tree = mkdtempSync(join(tmpdir(), "keiko-stub-index-tree-"));
    const seedDir = mkdtempSync(join(tmpdir(), "keiko-stub-index-seed-"));
    // One binding this host would link, one it never would. Both stub here, because neither is
    // installed in this empty tree — the difference is only which one may outlive the process.
    const hostBinding = `demo-native${hostBindingSuffixes().at(-1)}`;
    const foreignBinding = "demo-native-aix-ppc64";
    const manifest = {
      optionalDependencies: { [foreignBinding]: "^1.0.0", [hostBinding]: "^1.0.0" },
      bundleDependencies: [],
    };
    try {
      mkdirSync(join(tree, "node_modules"), { recursive: true });
      const seeded = seedVendoredRegistry(seedDir, join(tree, "node_modules"), manifest);
      expect(seeded.get(hostBinding)?.get("1.0.0")?.manifest?.os).toBeDefined();
      expect(seeded.get(foreignBinding)?.get("1.0.0")?.manifest?.os).toBeDefined();

      const published = loadSeedIndex(seedDir);
      // The host's own binding must not be inheritable: a process seeding after the prune would
      // otherwise hand the next one a placeholder that passes integrity precisely by being intact.
      expect(published.get(hostBinding)).toBeUndefined();
      // The foreign stub must survive. CI seeds from the intact tree and then prunes the native
      // packages, so a stub only derivable from a parent manifest that the prune deletes cannot be
      // rebuilt by the second process — dropping it 404s a package the lockfile genuinely pins.
      expect(published.get(foreignBinding)?.get("1.0.0")).toBeDefined();
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
    }
  }, 60_000);

  // `keiko-local-knowledge` declares `@napi-rs/canvas` — the PARENT, not a platform child —
  // optional, and the lockfile records no `os`/`cpu` for it, so it installs everywhere. An
  // optional-fetch failure would stub it, and `stubbedHostBindings` returns early on a stubbed
  // parent, so the host-binding guard alone would let the lane pass with no Canvas implementation
  // at all (Codex thread 3780501190). Platform data comes from `package-lock.json` rather than a
  // literal, so a package that gains or loses a platform restriction is judged by what it pins.
  // The scope cache is keyed by path. Unkeyed, the SECOND fixture below would be answered from the
  // FIRST file's scopes — the `lockfilePath` argument ignored and the verdict decided by call
  // order, which is the one property `scripts/**` tooling must not have (CodeRabbit thread
  // 3780586007).
  // The persist filter and the assertion must judge stubs by the SAME criterion. They did not: the
  // filter matched host-binding name SUFFIXES, so a platform-agnostic parent carried no suffix, was
  // published, and the assertion then rejected it — leaving an integrity-valid poisoned entry that
  // every later invocation reloaded and rejected again (Codex thread 3780652032).
  it("publishes no stub for a package the lockfile installs here, suffix or not", () => {
    const seedDir = mkdtempSync(join(tmpdir(), "keiko-agnostic-stub-"));
    const stubbed = (name) =>
      new Map([
        [
          name,
          new Map([["1.0.2", { manifest: stubManifest(name, "1.0.2"), name, version: "1.0.2" }]]),
        ],
      ]);
    try {
      // Read the written document directly. `loadSeedIndex` re-validates each entry against a real
      // archive on disk, so a synthetic fixture would be dropped on READ and the assertion would
      // pass without the filter doing anything — a test that cannot fail for its own regression.
      const written = (seeded) => {
        writeSeedIndex(seedDir, seeded);
        return JSON.parse(readFileSync(join(seedDir, "seed-index.json"), "utf8"));
      };

      // Carries no platform in its name, and the lockfile scopes it to nothing — it installs here.
      expect(written(stubbed("@napi-rs/canvas"))["@napi-rs/canvas"]).toBeUndefined();

      // A binding for a platform this host is not: still shareable, still published.
      const foreign = written(stubbed("@napi-rs/canvas-android-arm64"));
      expect(foreign["@napi-rs/canvas-android-arm64"]?.["1.0.2"]).toBeDefined();

      // And this host's own binding, which the lockfile pins to this platform.
      const own = `@napi-rs/canvas${hostBindingSuffixes().at(-1)}`;
      expect(written(stubbed(own))[own]).toBeUndefined();
    } finally {
      rmSync(seedDir, { recursive: true, force: true });
    }
  });

  // npm evaluates both halves of a mixed `os`/`cpu` list. Treating a negation as the whole answer
  // let `["darwin", "!win32"]` allow Linux, which classifies a legitimately foreign stub as
  // host-installable and fails the hermetic smoke on a correct closure (Codex thread 3780652044).
  it("honours the allowlist half of a mixed platform list", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-mixed-platform-"));
    const stubbed = new Map([
      [
        "demo-native",
        new Map([
          [
            "1.0.2",
            {
              manifest: stubManifest("demo-native", "1.0.2"),
              name: "demo-native",
              version: "1.0.2",
            },
          ],
        ]),
      ],
    ]);
    const write = (file, scope) => {
      const path = join(dir, file);
      writeFileSync(
        path,
        JSON.stringify({
          packages: { "node_modules/demo-native": { version: "1.0.2", ...scope } },
        }),
        "utf8",
      );
      return path;
    };
    try {
      const other = process.platform === "darwin" ? "linux" : "darwin";
      rejectProcessExit();
      // Names THIS platform positively: it installs here, so a stub is wrong.
      expect(() =>
        assertStubsAreForeignOnly(stubbed, write("here.json", { os: [process.platform, "!aix"] })),
      ).toThrow(/process\.exit\(1\)/u);
      // Names only ANOTHER platform positively, with an unrelated negation: foreign, stub is right.
      expect(() =>
        assertStubsAreForeignOnly(stubbed, write("elsewhere.json", { os: [other, "!aix"] })),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the lockfile it is given, not the one it read first", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-lockfile-scope-"));
    const write = (file, scope) => {
      const path = join(dir, file);
      writeFileSync(
        path,
        JSON.stringify({
          packages: { "node_modules/demo-native": { version: "1.0.2", ...scope } },
        }),
        "utf8",
      );
      return path;
    };
    const stubbed = new Map([
      [
        "demo-native",
        new Map([
          [
            "1.0.2",
            {
              manifest: stubManifest("demo-native", "1.0.2"),
              name: "demo-native",
              version: "1.0.2",
            },
          ],
        ]),
      ],
    ]);
    try {
      // Pins it with no platform scope: installs everywhere, so a stub is wrong.
      const everywhere = write("everywhere.json", {});
      rejectProcessExit();
      expect(() => assertStubsAreForeignOnly(stubbed, everywhere)).toThrow(/process\.exit\(1\)/u);

      // A DIFFERENT lockfile scoping it away from this host: the same stub is now correct.
      const foreign = write("foreign.json", { cpu: ["mips"], os: ["aix"] });
      expect(() => assertStubsAreForeignOnly(stubbed, foreign)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a stub for a package the lockfile installs on this host", () => {
    const stubbed = (name) =>
      new Map([
        [
          name,
          new Map([["1.0.2", { manifest: stubManifest(name, "1.0.2"), name, version: "1.0.2" }]]),
        ],
      ]);

    // Platform-agnostic parent: a stub here means the capability is absent, on every host.
    rejectProcessExit();
    expect(() => assertStubsAreForeignOnly(stubbed("@napi-rs/canvas"))).toThrow(
      /process\.exit\(1\)/u,
    );

    // A binding for a platform this host is not: the stub is the correct artifact.
    const foreign =
      process.platform === "android"
        ? "@napi-rs/canvas-win32-x64-msvc"
        : "@napi-rs/canvas-android-arm64";
    expect(() => assertStubsAreForeignOnly(stubbed(foreign))).not.toThrow();

    // A name the lockfile pins no platform data for is a closure question, not a platform one.
    expect(() => assertStubsAreForeignOnly(stubbed("not-in-the-lockfile-at-all"))).not.toThrow();
  });

  it("validates the staged root's own descriptors, allowing only its vendor archives", () => {
    // `file:vendor/...` is how stage-publish-package points at the tarball-local private
    // workspaces; anything else external must be rejected before Yarn can resolve it.
    expect(() =>
      assertStagedRootDescriptors({
        dependencies: {
          "@oscharko-dev/keiko-cli": "file:vendor/keiko-cli-0.3.7.tgz",
          typescript: "~6.0.3",
        },
      }),
    ).not.toThrow();

    rejectProcessExit();
    expect(() =>
      assertStagedRootDescriptors({
        dependencies: { sneaky: "git+https://token@example.invalid/pkg.git" },
      }),
    ).toThrow(/process\.exit\(1\)/u);
  });

  // A `file:` descriptor is resolved by Yarn straight from the filesystem, never through the
  // loopback registry, so the vendor exemption is the one hole in the hermeticity this gate
  // enforces. It has to match the shape `stage-publish-package.mjs` actually writes —
  // `vendor/<archive>.tgz`, one segment — rather than the `file:vendor/` prefix, which a
  // traversal descriptor also satisfies (KfQ thread 3780151719).
  it("accepts only the exact staged vendor archive shape, not any file:vendor prefix", () => {
    expect(isStagedVendorArchive("file:vendor/keiko-cli-0.3.7.tgz")).toBe(true);
    expect(isStagedVendorArchive("file:vendor\\keiko-cli-0.3.7.tgz")).toBe(true);

    for (const escape of [
      "file:vendor/../../ambient-package",
      "file:vendor/../../../etc/passwd.tgz",
      "file:vendor/nested/dir/pkg.tgz",
      "file:vendor/..",
      "file:vendor/",
      "file:vendorish/pkg.tgz",
      "file:vendor/pkg",
    ]) {
      expect(isStagedVendorArchive(escape), `${escape} must not be exempt`).toBe(false);
    }

    rejectProcessExit();
    expect(() =>
      assertStagedRootDescriptors({
        dependencies: { ambient: "file:vendor/../../ambient-package" },
      }),
    ).toThrow(/process\.exit\(1\)/u);
  });

  // Corepack is the only child in this gate that contacts a remote host, so it is the only one
  // whose failure output can carry an endpoint or the credentials embedded in a proxy URL. The
  // gate reports a classification and never the text it matched (KfQ thread 3780151718).
  it("classifies a Corepack provisioning failure without echoing its output", () => {
    const secret = "https://deploy:hunter2@proxy.internal:8080";
    const cases = [
      [{ stderr: `getaddrinfo ENOTFOUND ${secret}`, stdout: "", signal: null }, /unreachable/u],
      [{ stderr: `EINTEGRITY ${secret}`, stdout: "", signal: null }, /integrity/u],
      [{ stderr: `Mismatch hashes. Expected ${secret}`, stdout: "", signal: null }, /integrity/u],
      [{ stderr: `401 Unauthorized ${secret}`, stdout: "", signal: null }, /unauthorized/u],
      [{ stderr: "", stdout: `404 Not Found ${secret}`, signal: null }, /not found/u],
      [{ stderr: `weird ${secret}`, stdout: "", signal: null }, /no known class/u],
      [{ stderr: `ENOTFOUND ${secret}`, stdout: "", signal: "SIGKILL" }, /terminated/u],
    ];
    for (const [result, expected] of cases) {
      const classification = classifyProvisionFailure(result);
      expect(classification).toMatch(expected);
      expect(classification).not.toContain("hunter2");
      expect(classification).not.toContain("proxy.internal");
      expect(classification).not.toContain("https://");
    }
  });

  // ADR-0021 D7 claims the running platform's native binding is installed and proven. A stub is
  // only ever legitimate for a FOREIGN platform, so a real parent whose host binding is stubbed
  // would let the Yarn arm pass without the binding while the ADR promises otherwise.
  it("refuses a stubbed binding for the running host", () => {
    // The real prebuilds carry an ABI suffix on Linux and Windows (`-linux-x64-gnu`,
    // `-win32-x64-msvc`). An earlier revision of this test used a bare `-<platform>-<arch>` name,
    // which exists on no CI lane and hid the fact that the guard matched nothing there.
    const hostBinding = `demo-native${hostBindingSuffixes().at(-1)}`;
    const foreignBinding = "demo-native-aix-mips";
    const build = (bindingIsStub) =>
      new Map([
        [
          "demo-native",
          new Map([
            [
              "1.0.0",
              {
                name: "demo-native",
                version: "1.0.0",
                manifest: {
                  optionalDependencies: { [hostBinding]: "1.0.0", [foreignBinding]: "1.0.0" },
                },
              },
            ],
          ]),
        ],
        [
          hostBinding,
          new Map([
            [
              "1.0.0",
              bindingIsStub
                ? {
                    name: hostBinding,
                    version: "1.0.0",
                    manifest: stubManifest(hostBinding, "1.0.0"),
                  }
                : { name: hostBinding, version: "1.0.0", manifest: { name: hostBinding } },
            ],
          ]),
        ],
        // A foreign platform binding may legitimately be a stub.
        [
          foreignBinding,
          new Map([
            [
              "1.0.0",
              {
                name: foreignBinding,
                version: "1.0.0",
                manifest: stubManifest(foreignBinding, "1.0.0"),
              },
            ],
          ]),
        ],
      ]);

    expect(() => assertHostBindingsAreReal(build(false))).not.toThrow();
    rejectProcessExit();
    expect(() => assertHostBindingsAreReal(build(true))).toThrow(/process\.exit\(1\)/u);
  });

  // Derived from `package-lock.json`, not from a hand-written list. The previous revision listed
  // the published names as literals and simply omitted 32-bit ARM, whose glibc builds are spelled
  // `gnueabihf` rather than `gnu` — so the helper matched nothing on that lane and the test could
  // not say so (Codex thread 3780358321). Reading the names the lockfile actually pins means a
  // prebuild added upstream under a new ABI spelling fails here instead of silently disabling the
  // guard for that host.
  it("derives a suffix matching every prebuild the lockfile pins", () => {
    const lockfile = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
    const published = [
      ...new Set(
        Object.keys(lockfile.packages ?? {})
          .map((path) => path.split("node_modules/").at(-1))
          .filter((name) => name?.startsWith("@napi-rs/canvas-")),
      ),
    ];
    expect(published.length).toBeGreaterThan(5);

    // Only the platforms this helper claims to answer for; `android`/`riscv64` builds exist
    // upstream but are not hosts Keiko runs its gates on.
    const covered = published.filter((name) => /-(?:linux|win32|darwin)-/u.test(name));
    expect(covered.length).toBeGreaterThan(4);

    for (const name of covered) {
      const [platform, arch, ...abi] = name.slice("@napi-rs/canvas-".length).split("-");
      const libc = platform === "linux" ? (abi.includes("musl") ? "musl" : "glibc") : undefined;
      const suffixes = hostBindingSuffixes(platform, arch, libc);
      expect(
        suffixes.some((suffix) => name.endsWith(suffix)),
        `${platform}/${arch}/${libc ?? "-"} derives ${JSON.stringify(suffixes)}, none matching ${name}`,
      ).toBe(true);
    }
  });

  // The lockfile carries canvas 1.0.0 and 1.0.2, so checking "any version under this name is
  // real" passes while the 1.0.2 parent still resolves its own exact binding to a stub.
  it("checks the binding version each parent declares, not any version under the name", () => {
    const binding = `demo-native${hostBindingSuffixes().at(-1)}`;
    const parent = (version, bindingVersion) => [
      version,
      {
        name: "demo-native",
        version,
        manifest: { optionalDependencies: { [binding]: bindingVersion } },
      },
    ];
    const seeded = new Map([
      ["demo-native", new Map([parent("1.0.0", "1.0.0"), parent("1.0.2", "1.0.2")])],
      [
        binding,
        new Map([
          // 1.0.0 is real, 1.0.2 is a stub — an aggregate check would see "not all stubs" and pass.
          ["1.0.0", { name: binding, version: "1.0.0", manifest: { name: binding } }],
          ["1.0.2", { name: binding, version: "1.0.2", manifest: stubManifest(binding, "1.0.2") }],
        ]),
      ],
    ]);
    rejectProcessExit();
    expect(() => assertHostBindingsAreReal(seeded)).toThrow(/process\.exit\(1\)/u);
  });

  // The Corepack cache holds an executable Corepack will run, so a predictable shared path is a
  // code-execution surface, not merely a data one: another account could pre-create it with a
  // forged `.corepack` metadata file and binary.
  it("pins Yarn with a reviewed Corepack integrity locator", () => {
    const installableSource = readFileSync(
      join(ROOT, "scripts", "installable-package-smoke.mjs"),
      "utf8",
    );
    const registrySource = readFileSync(
      join(ROOT, "scripts", "registry-install-smoke.mjs"),
      "utf8",
    );

    expect(PINNED_YARN).toBe(`yarn@${PINNED_YARN_VERSION}+sha512.${PINNED_YARN_SHA512}`);
    expect(PINNED_YARN_SHA512).toMatch(/^[a-f0-9]{128}$/u);
    expect(PINNED_YARN_SOURCE_URL).toBe(
      "https://repo.yarnpkg.com/4.9.1/packages/yarnpkg-cli/bin/yarn.js",
    );
    expect(pinnedYarnVersionFromLocator(PINNED_YARN)).toBe(PINNED_YARN_VERSION);
    expect(() => pinnedYarnVersionFromLocator(`yarn@${PINNED_YARN_VERSION}`)).toThrow(TypeError);
    expect(installableSource).toContain("packageManager: PINNED_YARN");
    expect(registrySource).toContain("packageManager: PINNED_YARN");
    expect(installableSource).not.toContain('const PINNED_YARN = "yarn@4.9.1"');
    expect(registrySource).not.toContain('packageManager: "yarn@4.9.1"');
  });

  it("keeps the Corepack cache private and per-user", () => {
    const dir = corepackCacheDir();
    expect(existsSync(dir)).toBe(true);
    // Separate paths per account, so two users never contend for one directory.
    if (process.getuid !== undefined) {
      expect(dir.endsWith(`-${String(process.getuid())}`)).toBe(true);
      const mode = statSync(dir).mode & 0o777;
      expect(mode & 0o022).toBe(0);
    }
  });

  it("keeps the Corepack cache off the private home so it survives between runs", () => {
    const home = privateYarnHome();
    try {
      const env = yarnChildEnv("http://127.0.0.1:12345", { PATH: "/usr/bin" }, home);
      // If the cache followed HOME it would be empty every run, and the gate would download the
      // package manager on each invocation instead of only when it is genuinely absent.
      expect(env.COREPACK_HOME).toBe(corepackCacheDir());
      expect(env.COREPACK_HOME.startsWith(home)).toBe(false);
      expect(existsSync(env.COREPACK_HOME)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("gives the Yarn child a private home so ambient rc files cannot apply", () => {
    const home = privateYarnHome();
    try {
      expect(existsSync(home)).toBe(true);
      const env = yarnChildEnv(
        "http://127.0.0.1:12345",
        { PATH: "/usr/bin", HOME: "/real/home" },
        home,
      );
      // Yarn reads ~/.yarnrc.yml, so the home must be the private one, not the developer's.
      expect(env.HOME).toBe(home);
      expect(env.USERPROFILE).toBe(home);
      expect(env.XDG_CONFIG_HOME).toBe(home);
      // Without a private home the caller's environment is left untouched.
      const inherited = yarnChildEnv("http://127.0.0.1:12345", {
        PATH: "/usr/bin",
        HOME: "/real/home",
      });
      expect(inherited.HOME).toBe("/real/home");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the Corepack cache key and lookup stable across a hash change", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-corepack-cache-key-test-"));
    const fixtureBytes = "fixture Yarn bytes\n";
    const fixtureLocator = yarnLocatorForBytes(PINNED_YARN_VERSION, fixtureBytes);
    const fixtureHash = yarnSha512ForBytes(fixtureBytes);
    const alternateHashLocator = `yarn@${PINNED_YARN_VERSION}+sha512.${"0".repeat(128)}`;
    try {
      const result = runIsolatedSmokeModule(
        root,
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import { join } from "node:path";',
          "import { corepackCacheDir, isPinnedYarnCached } from './scripts/installable-package-smoke.mjs';",
          "import { PINNED_YARN_NAME, PINNED_YARN_VERSION } from './scripts/lib/pinned-yarn.mjs';",
          `const locator = ${JSON.stringify(fixtureLocator)};`,
          `const alternate = ${JSON.stringify(alternateHashLocator)};`,
          `const fixtureBytes = ${JSON.stringify(fixtureBytes)};`,
          `const fixtureHash = ${JSON.stringify(fixtureHash)};`,
          "const originalDir = corepackCacheDir(locator);",
          "const alternateDir = corepackCacheDir(alternate);",
          "const entry = join(originalDir, 'v1', PINNED_YARN_NAME, PINNED_YARN_VERSION);",
          "mkdirSync(entry, { recursive: true });",
          "writeFileSync(",
          "  join(entry, '.corepack'),",
          "  JSON.stringify({",
          "    locator: { name: PINNED_YARN_NAME, reference: PINNED_YARN_VERSION },",
          "    bin: ['yarn', 'yarnpkg'],",
          "    hash: `sha512.${fixtureHash}`,",
          "  }),",
          "  'utf8',",
          ");",
          "writeFileSync(join(entry, 'yarn.js'), fixtureBytes, 'utf8');",
          "console.log(JSON.stringify({",
          "  sameDir: originalDir === alternateDir,",
          "  originalCached: isPinnedYarnCached(locator),",
          "  alternateCached: isPinnedYarnCached(alternate),",
          "}));",
        ].join("\n"),
      );
      const outcome = JSON.parse(result.stdout);

      expect(result.status).toBe(0);
      expect(outcome).toEqual({
        sameDir: true,
        originalCached: true,
        alternateCached: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("provisions the integrity-pinned Yarn locator on a cold Corepack cache", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-corepack-cold-cache-test-"));
    const binDir = join(root, "bin");
    const marker = join(root, "corepack-call.json");
    const fixtureBytes = "freshly downloaded Yarn bytes\n";
    const fixtureLocator = yarnLocatorForBytes(PINNED_YARN_VERSION, fixtureBytes);
    const fixtureHash = yarnSha512ForBytes(fixtureBytes);
    mkdirSync(binDir, { recursive: true });
    try {
      writeExecutable(
        join(binDir, "corepack"),
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import { join } from "node:path";',
          "writeFileSync(",
          "  process.env.KEIKO_COREPACK_MARKER,",
          "  JSON.stringify({",
          "    argv: process.argv.slice(2),",
          "    corepackHome: process.env.COREPACK_HOME,",
          "    network: process.env.COREPACK_ENABLE_NETWORK,",
          "  }),",
          "  'utf8',",
          ");",
          "const entry = join(",
          "  process.env.COREPACK_HOME,",
          "  'v1',",
          "  'yarn',",
          "  process.env.PINNED_YARN_VERSION,",
          ");",
          "mkdirSync(",
          "  entry,",
          "  { recursive: true },",
          ");",
          "writeFileSync(",
          "  join(entry, '.corepack'),",
          "  JSON.stringify({",
          "    locator: { name: 'yarn', reference: process.env.PINNED_YARN_VERSION },",
          "    bin: ['yarn', 'yarnpkg'],",
          "    hash: `sha512.${process.env.PINNED_YARN_SHA512}`,",
          "  }),",
          "  'utf8',",
          ");",
          "writeFileSync(join(entry, 'yarn.js'), process.env.FIXTURE_YARN_BYTES, 'utf8');",
        ].join("\n"),
      );
      const result = runProvisionPinnedYarnChild(
        root,
        {
          FIXTURE_YARN_BYTES: fixtureBytes,
          KEIKO_COREPACK_MARKER: marker,
          PINNED_YARN_SHA512: fixtureHash,
          PINNED_YARN_VERSION,
        },
        fixtureLocator,
      );
      const record = JSON.parse(readFileSync(marker, "utf8"));

      expect(result.status).toBe(0);
      expect(record.argv).toEqual(["install", "--global", "--cache-only", fixtureLocator]);
      expect(record.corepackHome).toContain(`keiko-corepack-yarn-${PINNED_YARN_VERSION}-`);
      expect(record.network).toBe("1");
      expect(result.stdout).toContain(`provision-pinned-yarn: ${fixtureLocator} cached`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed and redacts Corepack output when the cold download hash mismatches", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-corepack-mismatch-test-"));
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    try {
      writeExecutable(
        join(binDir, "corepack"),
        [
          'import { writeSync } from "node:fs";',
          "writeSync(2, 'Mismatch hashes. Expected secret, got tampered\\n');",
          "process.exit(44);",
        ].join("\n"),
      );
      const result = runProvisionPinnedYarnChild(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("the archive failed its integrity check");
      expect(result.stderr).not.toContain("Expected secret");
      expect(result.stderr).not.toContain("tampered");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let a glibc host claim the musl build, or the reverse", () => {
    // The toolchain name in the package (`-gnu`) differs from the value Yarn's
    // supportedArchitectures wants (`glibc`); mapping one to the other is what this guards.
    const glibc = hostBindingSuffixes("linux", "x64", "glibc");
    const musl = hostBindingSuffixes("linux", "x64", "musl");
    expect(glibc.some((s) => "@napi-rs/canvas-linux-x64-musl".endsWith(s))).toBe(false);
    expect(musl.some((s) => "@napi-rs/canvas-linux-x64-gnu".endsWith(s))).toBe(false);
  });

  it("recovers from a malformed seed index instead of failing the gate", () => {
    const seedDir = mkdtempSync(join(tmpdir(), "keiko-seed-malformed-test-"));
    try {
      writeFileSync(join(seedDir, "seed-index.json"), "{ this is not json", "utf8");
      // An interrupted previous run must not turn into a red build no change can fix.
      expect(loadSeedIndex(seedDir).size).toBe(0);

      // A document that parses but is not an index object must recover the same way rather than
      // throwing outside the guard.
      for (const payload of ["null", "[]", '"a string"', "42"]) {
        writeFileSync(join(seedDir, "seed-index.json"), payload, "utf8");
        expect(loadSeedIndex(seedDir).size).toBe(0);
      }
    } finally {
      rmSync(seedDir, { recursive: true, force: true });
    }
  });

  it("lets a real package supersede a cached stub", () => {
    const tree = mkdtempSync(join(tmpdir(), "keiko-stub-supersede-tree-"));
    const seedDir = mkdtempSync(join(tmpdir(), "keiko-stub-supersede-seed-"));
    const manifest = {
      dependencies: {},
      optionalDependencies: { "demo-native": "^1.0.0" },
      bundleDependencies: [],
    };
    try {
      mkdirSync(join(tree, "node_modules"), { recursive: true });
      // First run: the package is not installed, so an inert stub is cached.
      const first = seedVendoredRegistry(seedDir, join(tree, "node_modules"), manifest);
      expect(first.get("demo-native")?.get("1.0.0")?.manifest?.os).toEqual([
        "keiko-smoke-never-matches",
      ]);

      // The package becomes available without the lockfile changing.
      const packageDir = join(tree, "node_modules", "demo-native");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "demo-native", version: "1.0.0" }),
        "utf8",
      );

      const second = seedVendoredRegistry(
        seedDir,
        join(tree, "node_modules"),
        manifest,
        loadSeedIndex(seedDir),
      );
      // The real archive must replace the placeholder, or the lane keeps skipping a binding that
      // is now installed.
      expect(second.get("demo-native")?.get("1.0.0")?.manifest?.os).toBeUndefined();
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("drops an indexed seed entry whose bytes no longer match its integrity", () => {
    const seedDir = mkdtempSync(join(tmpdir(), "keiko-seed-tamper-test-"));
    try {
      const tarballPath = join(seedDir, "demo-1.0.0.tgz");
      writeFileSync(tarballPath, "original bytes\n", "utf8");
      writeFileSync(
        join(seedDir, "seed-index.json"),
        JSON.stringify({
          demo: {
            "1.0.0": { tarballPath, integrity: "sha512-not-the-real-hash", manifest: {} },
          },
        }),
        "utf8",
      );
      // A cache entry is only reused when its bytes still hash to what was recorded, so a swapped
      // archive is re-packed from the tree instead of being served on trust.
      expect(loadSeedIndex(seedDir).size).toBe(0);
    } finally {
      rmSync(seedDir, { recursive: true, force: true });
    }
  });

  it("rejects an indexed seed entry pointing outside the cache directory", () => {
    const seedDir = mkdtempSync(join(tmpdir(), "keiko-seed-escape-test-"));
    const outside = mkdtempSync(join(tmpdir(), "keiko-seed-outside-"));
    try {
      const tarballPath = join(outside, "elsewhere.tgz");
      const bytes = "outside bytes\n";
      writeFileSync(tarballPath, bytes, "utf8");
      // The REAL integrity, so the integrity rule cannot reject this entry and containment is the
      // only rule left that can — otherwise this would pass even with containment deleted.
      const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      writeFileSync(
        join(seedDir, "seed-index.json"),
        JSON.stringify({ demo: { "1.0.0": { tarballPath, integrity, manifest: {} } } }),
        "utf8",
      );
      // An index naming a path outside the cache could otherwise serve any file on disk.
      expect(loadSeedIndex(seedDir).size).toBe(0);
    } finally {
      rmSync(seedDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keys the vendor seed directory to the lockfile bytes, not its UTF-8 decoding", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-lockfile-bytes-test-"));
    try {
      const first = join(root, "a.json");
      const second = join(root, "b.json");
      // Byte sequences that do not survive a UTF-8 round trip: interpolating the Buffer into a
      // template string would decode both to the same replacement characters and collide.
      writeFileSync(first, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
      writeFileSync(second, Buffer.from([0x7b, 0xfe, 0xff, 0x7d]));
      expect(persistentVendorSeedDir(first)).not.toBe(persistentVendorSeedDir(second));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
  // Every job that runs a smoke must prepare the offline fixture first, and in core-quality that
  // preparation has to precede `prune:package-native-optionals` — a seed taken after the prune
  // serves stubs where the host binding belongs.
  it("prepares the offline smoke inside every job that runs one, before that job's prune", () => {
    // Scoped per JOB, not over the whole document. A document-wide "is there a `provision:smoke`
    // somewhere above this smoke site" check stays green when the step is deleted from
    // `build-scan-sbom-smoke` or the cross-platform job, because an earlier job's invocation
    // still sits above it — the assertion would then no longer be able to fail for the regression
    // it was written to catch (KfQ thread 3780151720).
    const jobs = ciJobs();
    const smokeJobs = jobs.filter((job) => SMOKE_INVOCATION.test(job.text));
    expect(smokeJobs.length).toBeGreaterThan(0);
    for (const job of smokeJobs) {
      const prepare = job.text.indexOf("npm run provision:smoke");
      expect(prepare, `${job.name} runs a smoke without preparing it`).toBeGreaterThan(-1);
      expect(prepare, `${job.name} prepares after its own smoke`).toBeLessThan(
        job.text.search(SMOKE_INVOCATION),
      );
      // Where the job also prunes, preparation precedes the prune, not merely the smoke: a seed
      // taken after the prune serves stubs where the host binding belongs.
      const prune = job.text.indexOf("npm run prune:package-native-optionals");
      if (prune > -1) {
        expect(prepare, `${job.name} prepares after its own prune`).toBeLessThan(prune);
      }
    }
  });

  it("bounds every step that may reach the package-manager host", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    // Preparation is the one smoke step that may download; the child call is bounded inside the
    // script, this bounds anything outside it. Without a step bound a hang runs to the 360-minute
    // runner default.
    const steps = workflow
      .split(/^ {6}- name: /mu)
      .filter((step) => step.includes("provision:smoke"));
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step).toMatch(/^\s*timeout-minutes: \d+$/mu);
    }
  });

  it("runs the zizmor anchor check before the scanner whose finding it explains", () => {
    const hygiene = readFileSync(
      join(ROOT, ".github", "workflows", "workflow-hygiene.yml"),
      "utf8",
    );
    // `.github/zizmor.yml` ignores are line numbers: a line inserted above one drops a reviewed
    // risk acceptance, and the scanner then reports the underlying finding with no hint of the
    // cause. Ordering the check first makes the required context name the corrected line (#3130).
    const check = hygiene.indexOf("node scripts/check-zizmor-anchors.mjs");
    const scanner = hygiene.indexOf("- name: Run zizmor");
    expect(check).toBeGreaterThan(-1);
    expect(scanner).toBeGreaterThan(-1);
    expect(check).toBeLessThan(scanner);
  });

  it("seeds the vendored registry before packRoot prunes native optionals", () => {
    // Observes the production calls rather than their source positions: a text-order pin would
    // stay green if a refactor moved the effective call and left the statement text in place.
    const calls = [];
    // A sentinel, not a path: both dependencies are stubbed, so nothing touches the filesystem.
    const { vendored, artifact } = seedThenPack("<seed-destination-sentinel>", {
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
    expect(vendored.get("destination")).toBe("<seed-destination-sentinel>");
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
  // A foreign-scope or missing workspace manifest used to return [] silently, dropping that
  // workspace's third-party dependencies from the closure — Yarn would then request a package the
  // registry never seeded, and the failure would name the dependency rather than the cause.
  it("fails loudly when a bundled workspace manifest cannot be located", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-workspace-scope-test-"));
    try {
      rejectProcessExit();
      expect(() =>
        vendoredDependencyRequirements(
          { dependencies: {}, bundleDependencies: ["@other-scope/thing"] },
          root,
        ),
      ).toThrow(/process\.exit\(1\)/u);

      vi.restoreAllMocks();
      rejectProcessExit();
      expect(() =>
        vendoredDependencyRequirements(
          { dependencies: {}, bundleDependencies: ["@oscharko-dev/never-created"] },
          root,
        ),
      ).toThrow(/process\.exit\(1\)/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    // Two-part partials are valid npm ranges and resolve to the lowest member.
    expect(minimumSatisfyingVersion("1.2")).toBe("1.2.0");
    expect(minimumSatisfyingVersion("~1.2")).toBe("1.2.0");
    expect(minimumSatisfyingVersion("^1.2")).toBe("1.2.0");
    expect(minimumSatisfyingVersion("^3")).toBe("3.0.0");
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
