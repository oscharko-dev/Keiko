// Installable-package smoke (Issue #169 D2, AC2). Packs the root, installs the tarball into a
// fresh npm and Yarn projects, and asserts that (a) every private runtime workspace resolves from
// the tarball-local vendor graph, (b) the CLI bin is executable end-to-end (`--version`, `--help`),
// (c) the SDK root export resolves with the vendor graph in place, and (d) the packaged UI static
// export resolves through `keiko ui`. This is the
// runtime mirror of `scripts/check-package-surface.mjs`'s static tarball assertions, intended to
// fire BEFORE publish so a broken bundle can never reach users.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import ts from "typescript";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { createStagedPublishPackage } from "./stage-publish-package.mjs";

export const DEFAULT_NPM_INSTALL_TIMEOUT_MS = 600_000;
export const WINDOWS_NPM_INSTALL_TIMEOUT_MS = 600_000;
export const DEFAULT_EFFECTIVE_NPM_INSTALL_TIMEOUT_MS =
  process.platform === "win32" ? WINDOWS_NPM_INSTALL_TIMEOUT_MS : DEFAULT_NPM_INSTALL_TIMEOUT_MS;
export const NPM_INSTALL_TIMEOUT_MS =
  parsePositiveTimeoutEnv("KEIKO_SMOKE_INSTALL_TIMEOUT_MS") ??
  DEFAULT_EFFECTIVE_NPM_INSTALL_TIMEOUT_MS;
const UI_HEALTH_TIMEOUT_MS = 30_000;
const UI_HEALTH_POLL_INTERVAL_MS = 250;
const LIFECYCLE_COMMAND_TIMEOUT_MS = 90_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const rootPackageSurfaceContract = JSON.parse(
  readFileSync(join(repoRoot, "scripts", "root-package-surface.contract.json"), "utf8"),
);
const rootVersion = rootPackageJson.version;
const runtimeWorkspaces = rootPackageJson.bundleDependencies ?? [];

export function parseArgs(argv) {
  return {
    includeOptional: argv.includes("--include-optional"),
  };
}

function fail(message) {
  console.error(`installable-smoke failed: ${message}`);
  process.exit(1);
}

export function parsePositiveTimeoutEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    fail(`${name} must be a positive integer number of milliseconds.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    fail(`${name} must be a safe integer number of milliseconds.`);
  }
  return parsed;
}

function run(cmd, args, options = {}) {
  // SECURITY-SHELL-OK: npm-only Windows .cmd compatibility; node/bin paths stay shell:false.
  // `npm` resolves to `npm.cmd` on Windows, which modern Node refuses to spawn without a shell
  // (CVE-2024-27980 hardening); route npm — and only npm — through the shell so the packaged-artifact
  // smoke is cross-platform (the #284 OS matrix surfaced this). `node` is a real executable and is
  // spawned directly (no shell) so absolute bin paths never pass through shell word-splitting. The
  // npm arguments are tool-internal literals plus a tarball path under a controlled directory — no
  // untrusted shell input. POSIX is unaffected: the shell runs the same `npm …` invocation.
  const needsShell = process.platform === "win32" && (cmd === "npm" || cmd === "corepack");
  const result = spawnSync(cmd, args, { encoding: "utf8", shell: needsShell, ...options });
  if (result.error) {
    fail(`${cmd} ${args.join(" ")} could not spawn: ${result.error.message}`);
  }
  return result;
}

export function terminateProcessTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync(resolveHostExecutable("taskkill"), ["/pid", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") child.kill("SIGKILL");
  }
}

function settleTimedOutProcess(child, stdout, stderr, settle) {
  let terminationError;
  try {
    terminateProcessTree(child);
  } catch (error) {
    terminationError = error instanceof Error ? error.message : String(error);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  settle({
    timedOut: true,
    status: null,
    signal: process.platform === "win32" ? "TASKKILL" : "SIGKILL",
    stdout: stdout.join(""),
    stderr:
      terminationError === undefined
        ? stderr.join("")
        : `${stderr.join("")}\nprocess-tree termination failed: ${terminationError}`,
  });
}

export function runAsync(cmd, args, options = {}) {
  const needsShell = process.platform === "win32" && (cmd === "npm" || cmd === "corepack");
  const { timeout, ...spawnOptions } = options;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError("runAsync requires a positive finite timeout in milliseconds");
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const stdout = [];
    const stderr = [];
    // SECURITY-SHELL-OK: corepack-only Windows .cmd compatibility; argv is fixed by this smoke.
    const child = spawn(cmd, args, {
      ...spawnOptions,
      detached: process.platform !== "win32",
      shell: needsShell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const settle = (result) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = globalThis.setTimeout(() => {
      settleTimedOutProcess(child, stdout, stderr, settle);
    }, timeout);
    child.once("error", (error) => {
      settle({ error, status: null, signal: null, stdout: "", stderr: "" });
    });
    child.once("close", (status, signal) => {
      settle({ status, signal, stdout: stdout.join(""), stderr: stderr.join("") });
    });
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, ms));
}

function formatTsDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (diagnostic.file === undefined || diagnostic.start === undefined) {
        return message;
      }
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${diagnostic.file.fileName}:${String(line + 1)}:${String(character + 1)} ${message}`;
    })
    .join("\n");
}

function diffExpectedExports(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((item) => !actualSet.has(item)),
    unexpected: actual.filter((item) => !expectedSet.has(item)),
  };
}

function externalConsumerCompilerOptions() {
  return {
    baseUrl: repoRoot,
    ignoreDeprecations: "6.0",
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: false,
    paths: {
      ws: ["node_modules/@types/ws/index.d.ts"],
    },
    strict: true,
    typeRoots: [join(repoRoot, "node_modules", "@types")],
    types: ["node", "ws"],
  };
}

function probeHost(compilerOptions, probeFile, probeText) {
  const host = ts.createCompilerHost(compilerOptions, true);
  host.readFile = (fileName) => {
    if (fileName === probeFile) {
      return probeText;
    }
    return ts.sys.readFile(fileName);
  };
  host.fileExists = (fileName) => fileName === probeFile || ts.sys.fileExists(fileName);
  return host;
}

function collectConsumerVisibleTypeExports(specifier, fromDirectory) {
  // TypeScript normalises program filenames to forward slashes internally, and the custom compiler
  // host below matches the in-memory probe by exact string (`fileName === probeFile`). On Windows
  // `join` yields backslashes, so TS would look up `C:/.../probe.ts` while the host holds
  // `C:\...\probe.ts` → no match → "probe file not found". Use a forward-slash path so the host and
  // `program.getSourceFile` agree with TS's normalisation on every OS (POSIX is already `/`).
  const probeFile = join(fromDirectory, "__keiko-public-api-probe__.ts").replaceAll("\\", "/");
  const probeText =
    `export * from ${JSON.stringify(specifier)};\n` +
    `export type __Probe = typeof import(${JSON.stringify(specifier)});\n`;
  const compilerOptions = externalConsumerCompilerOptions();
  const host = probeHost(compilerOptions, probeFile, probeText);
  const program = ts.createProgram([probeFile], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    fail(
      "installed declarations do not typecheck for an external consumer:\n" +
        formatTsDiagnostics(diagnostics),
    );
  }
  const sourceFile = program.getSourceFile(probeFile);
  if (sourceFile === undefined) {
    fail(`TypeScript source file not found: ${probeFile}`);
  }
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(sourceFile);
  if (symbol === undefined) {
    fail(`TypeScript module symbol not found for: ${probeFile}`);
  }
  return checker
    .getExportsOfModule(symbol)
    .map((item) => item.getName())
    .filter((item) => item !== "__Probe")
    .sort((left, right) => left.localeCompare(right));
}

export function packRoot() {
  // BEHAVIOURAL BRANCH (env-gated, opt-in): default behaviour is unchanged — the gating Linux
  // `build-scan-sbom-smoke` job leaves the flag unset and packs with the full `prepack` chain
  // (clean + build + every release gate). ONLY the cross-platform runtime smoke (#284 AC4) opts in
  // by setting KEIKO_SMOKE_PACK_IGNORE_SCRIPTS=1, which packs the
  // ALREADY-BUILT dist (assembled by the job's explicit build / prepare:bin / build:ui steps)
  // WITHOUT re-running that chain: the prepack gates (arch-check, package-surface, supply-chain)
  // are the Linux publish gate — they run on the gating `build-scan-sbom-smoke` job and several
  // shell out to `npx`/`npm` in ways that are not Windows-portable, which is a separate concern from
  // verifying that the PACKED ARTIFACT runs cross-platform. On Linux the gate keeps the full
  // prepack pack (flag unset), so its coverage is unchanged.
  if (process.env.KEIKO_SMOKE_PACK_IGNORE_SCRIPTS !== "1") {
    const gateResult = run("npm", ["run", "prepack"], { cwd: repoRoot });
    if (gateResult.status !== 0) {
      fail(`npm run prepack exited ${String(gateResult.status)}: ${gateResult.stderr}`);
    }
  }
  const staged = createStagedPublishPackage();
  const manifest = JSON.parse(readFileSync(join(staged.packageDir, "package.json"), "utf8"));
  const artifactRoot = mkdtempSync(join(tmpdir(), "keiko-install-artifact-"));
  const result = run(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", artifactRoot],
    { cwd: staged.packageDir },
  );
  staged.cleanup();
  if (result.status !== 0) {
    rmSync(artifactRoot, { recursive: true, force: true });
    fail(`npm pack exited ${String(result.status)}: ${result.stderr}`);
  }
  const tarballName = `oscharko-dev-keiko-${rootVersion}.tgz`;
  const tarballPath = join(artifactRoot, tarballName);
  if (!existsSync(tarballPath)) {
    rmSync(artifactRoot, { recursive: true, force: true });
    fail(`expected tarball at ${tarballPath} after npm pack`);
  }
  return {
    manifest,
    tarballPath,
    cleanup: () => rmSync(artifactRoot, { recursive: true, force: true }),
  };
}

function installInto(tmp, tarballPath, options) {
  const initResult = run("npm", ["init", "-y"], { cwd: tmp });
  if (initResult.status !== 0) {
    fail(`npm init -y exited ${String(initResult.status)}: ${initResult.stderr}`);
  }
  // `--ignore-scripts` matches the conservative posture the gate models for consumer installs:
  // a future vendored package that acquires a `postinstall` hook would otherwise execute it on
  // every CI build and developer machine before review (issue #169 security-triage finding L1).
  const installResult = run(
    "npm",
    [
      "install",
      tarballPath,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...(options.includeOptional ? [] : ["--omit=optional"]),
    ],
    { cwd: tmp, timeout: NPM_INSTALL_TIMEOUT_MS },
  );
  if (installResult.status !== 0) {
    fail(
      `npm install of tarball exited ${String(installResult.status)} ` +
        `(signal=${String(installResult.signal)}): ${installResult.stderr}`,
    );
  }
}

function registryPackument(registryUrl, artifact, tarballBytes) {
  const integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
  return {
    name: rootPackageJson.name,
    "dist-tags": { latest: rootVersion },
    versions: {
      [rootVersion]: {
        ...artifact.manifest,
        dist: {
          integrity,
          tarball: `${registryUrl}/@oscharko-dev/keiko/-/keiko-${rootVersion}.tgz`,
        },
      },
    },
  };
}

// The published root declares 23 bundled private workspaces plus a handful of genuine third-party
// runtime dependencies. Everything the Yarn consumer resolves therefore has to come from somewhere,
// and before #3130 only the `oscharko-dev` scope was pointed at this local registry — the rest was
// resolved live from the public npm registry, on every run. That made a required gate depend on a
// stranger's publish timing: on 2026-08-13 `@napi-rs/canvas` 1.0.6 was published 22 minutes before
// its own `linux-x64-musl` platform package, and every Keiko pull request went red in that window.
// The closure below is seeded from THIS repository's `node_modules`, i.e. exactly the versions the
// committed `package-lock.json` already pins, so the smoke answers the Yarn-compatibility question
// offline and deterministically.
function workspaceThirdPartyNames(workspace, packagesRoot) {
  const manifestPath = join(
    packagesRoot,
    "packages",
    workspace.replace(/^@oscharko-dev\//u, ""),
    "package.json",
  );
  if (!existsSync(manifestPath)) return [];
  const workspaceManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return ["dependencies", "optionalDependencies"]
    .flatMap((group) => Object.keys(workspaceManifest[group] ?? {}))
    .filter((name) => !name.startsWith("@oscharko-dev/"));
}

export function vendoredDependencyNames(manifest = rootPackageJson, packagesRoot = repoRoot) {
  const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies ?? [];
  const bundledSet = new Set(bundled);
  const names = new Set(
    Object.keys(manifest.dependencies ?? {}).filter((name) => !bundledSet.has(name)),
  );
  // A bundled workspace ships inside the tarball, but its own third-party dependencies do not:
  // the consumer's package manager still resolves those from a registry. `keiko-local-knowledge`
  // declaring `@napi-rs/canvas` is exactly how the 2026-08-13 upstream publish race reached a
  // required Keiko gate, so the closure has to include them.
  for (const workspace of bundled) {
    for (const name of workspaceThirdPartyNames(workspace, packagesRoot)) names.add(name);
  }
  return [...names].sort(compareStrings);
}

/**
 * Yarn resolves every `optionalDependencies` entry unless the supported architectures are pinned,
 * which for a package like `@napi-rs/canvas` means all eleven prebuilt platform packages. Only the
 * running platform's variant is installed here, so narrowing this to the current host keeps the
 * offline closure both small and complete. `glibcVersionRuntime` is absent on musl builds.
 */
function linuxLibc() {
  if (process.platform !== "linux") return undefined;
  const glibc = process.report?.getReport?.()?.header?.glibcVersionRuntime;
  return glibc === undefined ? "musl" : "glibc";
}

export function supportedArchitectures() {
  const libc = linuxLibc();
  return {
    os: [process.platform],
    cpu: [process.arch],
    ...(libc === undefined ? {} : { libc: [libc] }),
  };
}

function compareStrings(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function readInstalledManifest(name, modulesRoot) {
  const manifestPath = join(modulesRoot, ...name.split("/"), "package.json");
  if (!existsSync(manifestPath)) return undefined;
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

/**
 * npm hoists what it can and nests the rest, so one dependency name can be installed at several
 * versions across the workspace tree (`@napi-rs/canvas` is hoisted at 1.0.0 while
 * `keiko-local-knowledge` carries 1.0.2 for its own `^1.0.2` range). The offline registry has to
 * offer every installed copy, or Yarn resolves a range this repository genuinely satisfies against
 * a packument that happens to omit it.
 */
export function findInstalledCopies(name, modulesRoot, packagesRoot = repoRoot) {
  const roots = [modulesRoot];
  const workspacesDir = join(packagesRoot, "packages");
  if (existsSync(workspacesDir)) {
    for (const workspace of readdirSync(workspacesDir)) {
      roots.push(join(workspacesDir, workspace, "node_modules"));
    }
  }
  const copies = new Map();
  for (const root of roots) {
    const manifest = readInstalledManifest(name, root);
    if (manifest === undefined || copies.has(manifest.version)) continue;
    copies.set(manifest.version, {
      name,
      version: manifest.version,
      directory: join(root, ...name.split("/")),
      manifest,
    });
  }
  return [...copies.values()];
}

/**
 * Walks the third-party dependency closure the Yarn consumer has to resolve — the root's own
 * non-bundled dependencies plus those declared by the bundled workspaces — against this
 * repository's installed tree, i.e. the versions `package-lock.json` already pins. A dependency
 * that is only reachable as an optional entry and is not installed here is not an error: Yarn is
 * told not to ask for it via `supportedArchitectures`.
 */
export function resolveVendorClosure(modulesRoot, manifest = rootPackageJson) {
  const resolved = new Map();
  const missing = [];
  const optional = new Set();
  const visit = (name) => {
    if (resolved.has(name) || missing.includes(name)) return;
    const copies = findInstalledCopies(name, modulesRoot);
    if (copies.length === 0) {
      missing.push(name);
      return;
    }
    resolved.set(name, copies);
    for (const copy of copies) {
      for (const dependency of Object.keys(copy.manifest.dependencies ?? {})) visit(dependency);
      // Optional entries are followed only when this repository actually installs them. The
      // registry strips `optionalDependencies` from every manifest it serves (see
      // `vendoredPackument`), so Yarn never asks for the foreign-platform prebuilds that made this
      // gate depend on an upstream publish race in the first place.
      for (const dependency of Object.keys(copy.manifest.optionalDependencies ?? {})) {
        optional.add(dependency);
        if (findInstalledCopies(dependency, modulesRoot).length > 0) visit(dependency);
      }
    }
  };
  for (const name of vendoredDependencyNames(manifest)) visit(name);
  return {
    packages: [...resolved.values()].flat(),
    missing: missing.filter((name) => !optional.has(name)),
  };
}

function packVendoredPackage(entry, destination) {
  const result = run(
    "npm",
    ["pack", entry.directory, "--pack-destination", destination, "--ignore-scripts"],
    { cwd: repoRoot, timeout: NPM_INSTALL_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    fail(`npm pack of vendored dependency ${entry.name} exited ${String(result.status)}`);
  }
  const produced = result.stdout.trim().split(/\r?\n/u).at(-1);
  if (produced === undefined || produced.length === 0) {
    fail(`npm pack of vendored dependency ${entry.name} printed no tarball name`);
  }
  return join(destination, produced);
}

export function seedVendoredRegistry(destination, modulesRoot = join(repoRoot, "node_modules")) {
  const { packages, missing } = resolveVendorClosure(modulesRoot);
  if (missing.length > 0) {
    fail(
      `vendored dependency closure is not installed: ${missing.join(", ")} — ` +
        `run \`npm install\` before the installable-package smoke`,
    );
  }
  const seeded = new Map();
  for (const entry of packages) {
    const tarballPath = packVendoredPackage(entry, destination);
    const versions = seeded.get(entry.name) ?? new Map();
    versions.set(entry.version, { ...entry, tarballBytes: readFileSync(tarballPath) });
    seeded.set(entry.name, versions);
  }
  return seeded;
}

function tarballFileName(name, version) {
  return `${name.split("/").at(-1)}-${version}.tgz`;
}

function vendoredPackument(name, versions, registryUrl) {
  const sorted = [...versions.values()].sort((left, right) =>
    compareStrings(left.version, right.version),
  );
  const entries = {};
  for (const entry of sorted) {
    // `optionalDependencies` are stripped so the Yarn arm resolves exactly what the npm arm
    // installs with `--omit=optional`. Without this the consumer resolves every prebuilt platform
    // package of a dependency like `@napi-rs/canvas` — eleven of them — and a single upstream
    // publish gap in any one of them fails a required Keiko gate (#3130).
    const manifest = Object.fromEntries(
      Object.entries(entry.manifest).filter(([key]) => key !== "optionalDependencies"),
    );
    entries[entry.version] = {
      ...manifest,
      dist: {
        integrity: `sha512-${createHash("sha512").update(entry.tarballBytes).digest("base64")}`,
        tarball: `${registryUrl}/${name}/-/${tarballFileName(name, entry.version)}`,
      },
    };
  }
  return {
    name,
    "dist-tags": { latest: sorted.at(-1)?.version },
    versions: entries,
  };
}

function localRegistryHandler(artifact, tarballBytes, registryUrl, requests, vendored) {
  const packument = registryPackument(registryUrl, artifact, tarballBytes);
  const seeded = vendored ?? new Map();
  return (request, response) => {
    const pathname = new URL(request.url ?? "/", registryUrl).pathname;
    requests.push(pathname);
    const requested = decodeURIComponent(pathname.slice(1));
    if (pathname.endsWith(".tgz")) {
      for (const [name, versions] of seeded) {
        if (!requested.startsWith(`${name}/-/`)) continue;
        const wanted = [...versions.values()].find(
          (entry) => requested === `${name}/-/${tarballFileName(name, entry.version)}`,
        );
        if (wanted === undefined) break;
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(wanted.tarballBytes);
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(tarballBytes);
      return;
    }
    if (requested.toLowerCase() === rootPackageJson.name) {
      response.writeHead(200, { "content-type": "application/vnd.npm.install-v1+json" });
      response.end(JSON.stringify(packument));
      return;
    }
    const vendoredVersions = seeded.get(requested);
    if (vendoredVersions !== undefined) {
      response.writeHead(200, { "content-type": "application/vnd.npm.install-v1+json" });
      response.end(JSON.stringify(vendoredPackument(requested, vendoredVersions, registryUrl)));
      return;
    }
    // A 404 here is the hermeticity guarantee, not an oversight: the install may only see packages
    // this repository already pins. An unexpected request fails the gate loudly instead of silently
    // reaching the public registry (#3130).
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  };
}

export async function startLocalRegistry(artifact, vendored) {
  const tarballBytes = readFileSync(artifact.tarballPath);
  const requests = [];
  let handler;
  const server = createHttpServer((request, response) => {
    if (handler === undefined) {
      response.writeHead(503);
      response.end();
      return;
    }
    handler(request, response);
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("local package registry did not bind a TCP port");
  }
  const registryUrl = `http://127.0.0.1:${String(address.port)}`;
  handler = localRegistryHandler(artifact, tarballBytes, registryUrl, requests, vendored);
  try {
    const health = await globalThis.fetch(
      `${registryUrl}/${encodeURIComponent(rootPackageJson.name)}`,
    );
    if (!health.ok) {
      throw new Error(
        `local package registry failed its packument health check (HTTP ${String(health.status)})`,
      );
    }
  } catch (error) {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    throw error;
  }
  return {
    registryUrl,
    requests,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

function writeYarnConfiguration(tmp, registryUrl) {
  const architectureLines = Object.entries(supportedArchitectures()).flatMap(([key, values]) => [
    `  ${key}:`,
    ...values.map((value) => `    - ${value}`),
  ]);
  const lines = [
    "nodeLinker: node-modules",
    "enableGlobalCache: false",
    "globalFolder: .yarn/global",
    "cacheFolder: .yarn/cache",
    `npmRegistryServer: ${registryUrl}`,
    "npmScopes:",
    "  oscharko-dev:",
    `    npmRegistryServer: ${registryUrl}`,
    "supportedArchitectures:",
    ...architectureLines,
    "unsafeHttpWhitelist:",
    "  - 127.0.0.1",
  ];
  writeFileSync(join(tmp, ".yarnrc.yml"), `${lines.join("\n")}\n`);
}

export async function installIntoWithYarn(tmp, artifact, vendored) {
  const registry = await startLocalRegistry(artifact, vendored);
  writeFileSync(
    join(tmp, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        packageManager: "yarn@4.9.1",
        dependencies: { [rootPackageJson.name]: rootVersion },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  rmSync(join(tmp, "yarn.lock"), { force: true });
  // `npmRegistryServer` is set GLOBALLY, not only for the `oscharko-dev` scope (#3130): every
  // package this install resolves must come from the local registry, which serves the packed root
  // plus the repository-pinned third-party closure and 404s everything else. Scoping it made the
  // gate depend on live npm for the transitive graph, so an unrelated upstream publish could — and
  // did — turn every Keiko pull request red.
  writeYarnConfiguration(tmp, registry.registryUrl);
  try {
    const result = await runAsync(
      "corepack",
      ["yarn", "install", "--no-immutable", "--mode=skip-build"],
      {
        cwd: tmp,
        timeout: NPM_INSTALL_TIMEOUT_MS,
        env: { ...process.env, YARN_ENABLE_GLOBAL_CACHE: "false" },
      },
    );
    if (result.timedOut === true || result.error !== undefined || result.status !== 0) {
      const outcome = result.timedOut === true ? "timed out" : `exited ${String(result.status)}`;
      fail(
        `Yarn registry install ${outcome} ` +
          `(signal=${String(result.signal)}; registry=${registry.registryUrl}; ` +
          `requests=${registry.requests.join(",")}): ` +
          `${(result.error?.message ?? result.stderr) || result.stdout}`,
      );
    }
  } finally {
    await registry.close();
  }
}

function assertCliExecutable(tmp) {
  const cliEntry = join(tmp, "node_modules", "@oscharko-dev", "keiko", "dist", "cli", "index.js");
  if (!existsSync(cliEntry)) {
    fail(`installed tarball missing CLI entry at ${cliEntry}`);
  }
  // The POSIX executable bit is meaningless on Windows: NTFS has no `0o111`, Node's statSync reports
  // a fixed `100666`, and executability is determined by file extension / PATHEXT. The CLI's *actual*
  // runnability is verified cross-platform by assertCliVersionAndHelp (it runs `node <bin> --version`
  // / `--help`). Only enforce the exec bit on the platforms where it is a real concept.
  if (process.platform !== "win32") {
    const mode = statSync(cliEntry).mode;
    if ((mode & 0o111) === 0) {
      fail(`installed CLI entry ${cliEntry} is not executable (mode ${mode.toString(8)})`);
    }
  }
}

export function assertVendoredPayload(tmp) {
  const dependencyRoot = join(tmp, "node_modules");
  for (const name of runtimeWorkspaces) {
    const shortName = name.replace(/^@oscharko-dev\//, "");
    const candidates = [
      join(dependencyRoot, "@oscharko-dev", shortName, "dist"),
      join(
        dependencyRoot,
        "@oscharko-dev",
        "keiko",
        "node_modules",
        "@oscharko-dev",
        shortName,
        "dist",
      ),
    ];
    const dist = candidates.find((candidate) => existsSync(candidate));
    if (dist === undefined) {
      fail(`vendored runtime dependency missing: ${candidates.join(" or ")}`);
    }
    const entries = readdirSync(dist);
    if (entries.length === 0) {
      fail(`vendored runtime dependency empty: ${dist}`);
    }
  }
}

export function assertProductiveTypeScriptRuntime(tmp) {
  const manifest = join(tmp, "node_modules", "typescript", "package.json");
  if (!existsSync(manifest)) {
    fail(`productive TypeScript runtime dependency missing: ${manifest}`);
  }
}

function assertCliVersionAndHelp(tmp) {
  // Resolve the installed CLI entry directly rather than the `node_modules/.bin/keiko` symlink so
  // the gate does not depend on npm's per-platform `.bin` shim shape (Copilot review on #169).
  const bin = join(tmp, "node_modules", "@oscharko-dev", "keiko", "dist", "cli", "index.js");
  const versionResult = run("node", [bin, "--version"], { cwd: tmp });
  if (versionResult.status !== 0) {
    fail(`keiko --version exited ${String(versionResult.status)}: ${versionResult.stderr}`);
  }
  if (!versionResult.stdout.includes(rootVersion)) {
    fail(`keiko --version stdout did not include ${rootVersion}: ${versionResult.stdout}`);
  }
  const helpResult = run("node", [bin, "--help"], { cwd: tmp });
  if (helpResult.status !== 0) {
    fail(`keiko --help exited ${String(helpResult.status)}: ${helpResult.stderr}`);
  }
}

async function assertInstalledRootRuntimeSurface(tmp) {
  try {
    const moduleUrl = pathToFileURL(
      join(tmp, "node_modules", "@oscharko-dev", "keiko", "dist", "index.js"),
    ).href;
    const mod = await import(moduleUrl);
    const runtimeExports = Object.keys(mod).sort((a, b) => a.localeCompare(b));
    const diff = diffExpectedExports(runtimeExports, rootPackageSurfaceContract.runtimeExports);
    if (diff.missing.length > 0 || diff.unexpected.length > 0) {
      fail(
        "installed root runtime contract drifted " +
          `(missing ${String(diff.missing.length)}, unexpected ${String(diff.unexpected.length)}).`,
      );
    }
  } catch (error) {
    fail(`installed root import failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertInstalledRootTypeSurface(tmp) {
  const typeExports = collectConsumerVisibleTypeExports("@oscharko-dev/keiko", tmp);
  const diff = diffExpectedExports(typeExports, rootPackageSurfaceContract.declarationExports);
  if (diff.missing.length > 0 || diff.unexpected.length > 0) {
    fail(
      "installed root declaration contract drifted " +
        `(missing ${String(diff.missing.length)}, unexpected ${String(diff.unexpected.length)}).`,
    );
  }
}

async function reserveUiPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not reserve a loopback TCP port for keiko ui"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function waitForHealth(baseUrl, child, stdoutChunks, stderrChunks) {
  const deadline = Date.now() + UI_HEALTH_TIMEOUT_MS;
  let lastError = "health endpoint did not respond";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(
        `keiko ui exited ${String(child.exitCode)} before /api/health was reachable.\n` +
          `stdout:\n${stdoutChunks.join("")}\n` +
          `stderr:\n${stderrChunks.join("")}`,
      );
    }
    try {
      const res = await globalThis.fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
      lastError = `/api/health returned ${String(res.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(UI_HEALTH_POLL_INTERVAL_MS);
  }
  fail(
    `keiko ui did not become healthy within ${String(UI_HEALTH_TIMEOUT_MS)}ms: ${lastError}\n` +
      `stdout:\n${stdoutChunks.join("")}\n` +
      `stderr:\n${stderrChunks.join("")}`,
  );
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise())),
    sleep(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

async function assertQiRouteReachable(baseUrl) {
  // Issue #284 AC4: prove the Quality Intelligence BFF seam is reachable on the PACKED artifact and
  // that its evidence-directory path resolves cross-platform. This GET drives the QI local store's
  // directory resolution (resolveEvidenceDir -> existingQiBaseDir) without requiring a model, so it
  // is deterministic and offline — exactly the path handling most likely to break on Windows. A QI
  // run / evidence WRITE is model-gated (Model Gateway) and out of an offline smoke; the read seam
  // is what this asserts cross-platform.
  //
  // Test layering: the handler (handleListQiRuns) is already unit-tested in keiko-server's
  // uiRoutes.test.ts (populated, empty-`[]`, and limit-boundary cases), so the response SHAPE is
  // covered at the unit level. This assertion is deliberately integration-only — it verifies a
  // property a unit test cannot express: that the route is reachable and the evidence-dir path
  // resolves on the packed artifact, per OS. The `!Array.isArray` check also fails closed on a
  // null / malformed `runs` shape, so the empty and the malformed cases both surface clearly.
  const res = await globalThis.fetch(`${baseUrl}/api/quality-intelligence/runs`);
  if (!res.ok) {
    fail(`keiko ui GET /api/quality-intelligence/runs exited with HTTP ${String(res.status)}`);
  }
  const payload = await res.json();
  if (!Array.isArray(payload.runs)) {
    fail(
      `keiko ui QI runs response did not contain runs[]: ${JSON.stringify(payload).slice(0, 200)}`,
    );
  }
}

function seedNestedRepositoryPickerFixture(tmp) {
  const repoRootPath = join(tmp, "Keiko");
  mkdirSync(join(repoRootPath, ".git"), { recursive: true });
  mkdirSync(join(repoRootPath, "packages", "keiko-editor", "src"), { recursive: true });
  mkdirSync(join(tmp, "StorybookStatic", "assets"), { recursive: true });
  writeFileSync(
    join(repoRootPath, "packages", "keiko-editor", "src", "range.ts"),
    "export const sourceRange = 1;\n",
    "utf8",
  );
  writeFileSync(join(tmp, "StorybookStatic", "assets", "range.ts"), "generated\n", "utf8");
  return realpathSync(repoRootPath);
}

function assertNestedRepositoryFirstSearchResult(first, expectedRepoRoot) {
  if (!samePath(first?.root, expectedRepoRoot)) {
    fail(
      "repository picker search did not rebase the first nested repo result " +
        `to ${expectedRepoRoot}: ${JSON.stringify(first).slice(0, 240)}`,
    );
  }
  if (first.path !== "packages/keiko-editor/src/range.ts") {
    fail(`repository picker search returned non-canonical first path: ${String(first.path)}`);
  }
  if (
    first.fileRole !== "source" ||
    first.matchQuality !== "exact" ||
    first.rootKind !== "nested-git-root"
  ) {
    fail(
      "repository picker search first result metadata was not source/exact/nested-git-root: " +
        JSON.stringify(first).slice(0, 240),
    );
  }
}

function assertGeneratedRepositorySearchFixture(payload) {
  const generated = payload.results?.find(
    (entry) => entry.path === "StorybookStatic/assets/range.ts",
  );
  if (generated?.fileRole !== "generated" || generated.rootKind !== "selected-root") {
    fail(
      "repository picker search generated fixture metadata was not generated/selected-root: " +
        JSON.stringify(generated).slice(0, 240),
    );
  }
}

async function assertRepositoryPickerSearchRebasesNestedRepo(baseUrl, tmp) {
  const expectedRepoRoot = seedNestedRepositoryPickerFixture(tmp);
  const res = await globalThis.fetch(
    `${baseUrl}/api/files/search?root=${encodeURIComponent(tmp)}&query=range&limit=10`,
  );
  if (!res.ok) {
    fail(
      `keiko ui GET /api/files/search for repository picker exited with HTTP ${String(res.status)}`,
    );
  }
  const payload = await res.json();
  const first = payload.results?.[0];
  assertNestedRepositoryFirstSearchResult(first, expectedRepoRoot);
  assertGeneratedRepositorySearchFixture(payload);
  if (payload.results?.some((entry) => entry.path === "Keiko/packages/keiko-editor/src/range.ts")) {
    fail("repository picker search leaked the parent-folder label into a result path");
  }
}

// Compare two absolute paths for equality. On Windows paths are case-insensitive and may differ in
// separator (`\` vs `/`), drive-letter case, or 8.3 short-name expansion between `realpathSync`
// and the server's resolved path, so compare every realpath variant we can resolve there; POSIX
// comparison stays exact (case-sensitive).
//
// Test layering for the cross-platform path helpers (this `samePath` and the forward-slash
// `probeFile` above): they are deliberately covered by the CI matrix itself rather than a unit test.
// This script IS the integration test, and each platform branch is exercised on its own runner —
// the `win32` branches by `cross-platform-smoke (windows-latest)`, the POSIX branches by the
// `(macos-latest)` leg and the gating Linux `build-scan-sbom-smoke` job. A unit test would mock the
// platform/fs and assert against the harness, not the product, so it is intentionally not added.
function comparableWindowsPath(value) {
  return String(value)
    .replace(/^\\\\\?\\/u, "")
    .replaceAll("\\", "/")
    .toLowerCase();
}

function windowsPathVariants(value) {
  const variants = new Set([comparableWindowsPath(value)]);
  for (const resolvePath of [realpathSync, realpathSync.native]) {
    try {
      variants.add(comparableWindowsPath(resolvePath(value)));
    } catch {
      // Missing paths should still compare by their normalized literal form.
    }
  }
  return variants;
}

function samePath(a, b) {
  if (a === undefined || b === undefined) return false;
  if (process.platform !== "win32") return a === b;
  const left = windowsPathVariants(a);
  const right = windowsPathVariants(b);
  return [...left].some((candidate) => right.has(candidate));
}

async function assertUiLaunchProject(baseUrl, tmp) {
  const expectedProjectPath = realpathSync(tmp);
  const projectsRes = await globalThis.fetch(`${baseUrl}/api/projects`);
  if (!projectsRes.ok) {
    fail(`keiko ui GET /api/projects exited with HTTP ${String(projectsRes.status)}`);
  }
  const projectsPayload = await projectsRes.json();
  const launchProject = projectsPayload.projects?.[0];
  if (!samePath(launchProject?.path, expectedProjectPath)) {
    fail(`keiko ui did not select launch cwd; first project was ${String(launchProject?.path)}`);
  }
  if (launchProject.available !== true) {
    fail("keiko ui launch cwd project is not available");
  }
}

async function assertPackagedUi(tmp) {
  const packageRoot = join(tmp, "node_modules", "@oscharko-dev", "keiko");
  const staticRoot = join(packageRoot, "dist", "ui", "static");
  const hashesFile = join(packageRoot, "dist", "ui", "csp-hashes.json");
  if (!existsSync(staticRoot)) {
    fail(`installed tarball missing packaged UI static root at ${staticRoot}`);
  }
  if (readdirSync(staticRoot).length === 0) {
    fail(`installed packaged UI static root is empty: ${staticRoot}`);
  }
  if (!existsSync(hashesFile)) {
    fail(`installed tarball missing packaged UI CSP hashes at ${hashesFile}`);
  }
  const bin = join(packageRoot, "dist", "cli", "index.js");
  const port = await reserveUiPort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn(process.execPath, [bin, "ui", "--port", String(port)], {
    cwd: tmp,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => stdoutChunks.push(String(chunk)));
  child.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));
  try {
    await waitForHealth(baseUrl, child, stdoutChunks, stderrChunks);
    await assertUiLaunchProject(baseUrl, tmp);
    await assertQiRouteReachable(baseUrl);
    await assertRepositoryPickerSearchRebasesNestedRepo(baseUrl, tmp);
    const home = await globalThis.fetch(`${baseUrl}/`);
    if (!home.ok) {
      fail(`keiko ui GET / exited with HTTP ${String(home.status)}`);
    }
    const html = await home.text();
    if (!html.includes("Keiko")) {
      fail("keiko ui home page did not contain the Keiko shell marker");
    }
  } finally {
    await stopChild(child);
  }
}

function lifecycleCommandRunner(tmp, bin, port, stateDir) {
  const commonArgs = [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--state-dir",
    stateDir,
    "--start-timeout",
    "30",
    "--stop-timeout",
    "10",
  ];
  return (command, extra = []) =>
    run("node", [bin, command, ...commonArgs, ...extra], {
      cwd: tmp,
      timeout: LIFECYCLE_COMMAND_TIMEOUT_MS,
    });
}

function assertLifecycleStart(runLifecycle) {
  const startResult = runLifecycle("start");
  if (startResult.status !== 0) {
    // Surface the UI child's own log (keiko start reports its path as "Logs: <path>") so a startup
    // crash is diagnosable from CI instead of hiding behind a bare non-zero exit.
    const logMatch = /Logs:\s*(\S+)/u.exec(startResult.stderr);
    let logTail = "";
    if (logMatch) {
      try {
        logTail = `\n--- ${logMatch[1]} (tail) ---\n${readFileSync(logMatch[1], "utf8")
          .split("\n")
          .slice(-40)
          .join("\n")}`;
      } catch {
        logTail = `\n--- ${logMatch[1]} unreadable ---`;
      }
    }
    fail(`keiko start exited ${String(startResult.status)}: ${startResult.stderr}${logTail}`);
  }
  if (!startResult.stdout.includes("Keiko UI running on")) {
    fail(`keiko start did not report a running UI: ${startResult.stdout}`);
  }
}

function assertLifecycleStatusRunning(runLifecycle) {
  const statusResult = runLifecycle("status");
  if (statusResult.status !== 0 || !statusResult.stdout.includes("Keiko UI is running on")) {
    fail(
      `keiko status did not report the packaged UI as running ` +
        `(status=${String(statusResult.status)}): ${statusResult.stdout}${statusResult.stderr}`,
    );
  }
}

function assertLifecycleRestart(runLifecycle) {
  const restartResult = runLifecycle("restart");
  if (restartResult.status !== 0) {
    fail(`keiko restart exited ${String(restartResult.status)}: ${restartResult.stderr}`);
  }
  if (!restartResult.stdout.includes("Keiko UI running on")) {
    fail(`keiko restart did not report a running UI after restart: ${restartResult.stdout}`);
  }
}

function assertLifecycleStop(runLifecycle) {
  const stopResult = runLifecycle("stop");
  if (stopResult.status !== 0 || !stopResult.stdout.includes("Keiko UI stopped")) {
    fail(
      `keiko stop did not stop the packaged UI ` +
        `(status=${String(stopResult.status)}): ${stopResult.stdout}${stopResult.stderr}`,
    );
  }
}

function assertLifecycleStatusStopped(runLifecycle) {
  const stoppedStatus = runLifecycle("status");
  if (stoppedStatus.status !== 0 || !stoppedStatus.stdout.includes("not running")) {
    fail(`keiko status after stop did not report not running: ${stoppedStatus.stdout}`);
  }
}

async function assertPackagedLifecycleCommands(tmp) {
  const packageRoot = join(tmp, "node_modules", "@oscharko-dev", "keiko");
  const bin = join(packageRoot, "dist", "cli", "index.js");
  const port = await reserveUiPort();
  // The runtime state / UI data dir MUST live outside the workspace (the lifecycle cwd = tmp): keiko
  // rejects a state dir inside the current workspace so the UI DB can never overlap a selected
  // repository (packages/keiko-server/src/store/paths.ts). It must also live INSIDE the user's home
  // directory: `keiko start` refuses a state dir outside home to close the launcher's F4 env-var
  // planting attack (KEIKO-0330). A home-contained temp dir satisfies both: outside the workspace,
  // inside home, cleaned up when the smoke completes.
  const stateDir = mkdtempSync(join(homedir(), ".keiko-smoke-state-"));
  const lifecycleRun = lifecycleCommandRunner(tmp, bin, port, stateDir);

  let started = false;
  try {
    assertLifecycleStart(lifecycleRun);
    started = true;
    assertLifecycleStatusRunning(lifecycleRun);
    assertLifecycleRestart(lifecycleRun);
    assertLifecycleStop(lifecycleRun);
    started = false;
    assertLifecycleStatusStopped(lifecycleRun);
  } finally {
    if (started) {
      lifecycleRun("stop");
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifact = packRoot();
  const tmp = mkdtempSync(join(tmpdir(), "keiko-install-smoke-"));
  const yarnTmp = mkdtempSync(join(tmpdir(), "keiko-yarn-install-smoke-"));
  const vendorTmp = mkdtempSync(join(tmpdir(), "keiko-yarn-vendor-seed-"));
  try {
    installInto(tmp, artifact.tarballPath, options);
    assertCliExecutable(tmp);
    assertVendoredPayload(tmp);
    assertProductiveTypeScriptRuntime(tmp);
    assertCliVersionAndHelp(tmp);
    await assertInstalledRootRuntimeSurface(tmp);
    assertInstalledRootTypeSurface(tmp);
    await assertPackagedUi(tmp);
    await assertPackagedLifecycleCommands(tmp);
    const vendored = seedVendoredRegistry(vendorTmp);
    await installIntoWithYarn(yarnTmp, artifact, vendored);
    assertCliExecutable(yarnTmp);
    assertVendoredPayload(yarnTmp);
    assertProductiveTypeScriptRuntime(yarnTmp);
    assertCliVersionAndHelp(yarnTmp);
    await assertInstalledRootRuntimeSurface(yarnTmp);
    assertInstalledRootTypeSurface(yarnTmp);
    console.log(
      `installable-smoke ok: npm tarball + Yarn registry installs passed (${options.includeOptional ? "optional deps included" : "optional deps omitted"}), ${String(runtimeWorkspaces.length)} vendored packages present, root runtime/types + CLI + UI/lifecycle reachable.`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(yarnTmp, { recursive: true, force: true });
    rmSync(vendorTmp, { recursive: true, force: true });
    artifact.cleanup();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
