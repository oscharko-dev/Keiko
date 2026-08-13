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
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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
function workspaceThirdPartyRequirements(workspace, packagesRoot) {
  // A bundled workspace outside the product scope would leave `@other/foo` in the path and miss
  // its manifest, silently dropping that workspace's third-party dependencies from the closure —
  // Yarn would then request a package this registry never seeded. Both that case and a genuinely
  // absent manifest fail loudly instead, naming the workspace.
  const scoped = /^@oscharko-dev\/(?<name>[^/]+)$/u.exec(workspace);
  const directory = scoped?.groups?.name;
  if (directory === undefined) {
    fail(
      `bundled workspace ${workspace} is outside the @oscharko-dev scope, so its third-party ` +
        `dependencies cannot be located for the offline closure`,
    );
  }
  const manifestPath = join(packagesRoot, "packages", directory ?? "", "package.json");
  if (!existsSync(manifestPath)) {
    fail(
      `bundled workspace ${workspace} has no manifest at packages/${directory ?? ""}, so its ` +
        `third-party dependencies cannot be added to the offline closure`,
    );
  }
  const workspaceManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // Same npm precedence as any other manifest: an optional entry overrides a same-named required
  // one within this file. Flattening both groups separately would emit a required record for a
  // name npm treats as optional.
  return manifestRequirements(workspaceManifest).filter(
    ({ name }) => !name.startsWith("@oscharko-dev/"),
  );
}

/**
 * A concrete version that satisfies `range`, used only to name an inert stub for an optional
 * dependency this repository does not install. Handles the npm forms that actually occur —
 * exact, `^`, `~`, `>=`, `v`-prefixed, x-ranges and `*` — and returns `undefined` for anything
 * else, which `recordAbsent` treats as fatal. Guessing at a grammar this does not model would
 * serve a stub that does not satisfy the requested range, and Yarn would fail with a confusing
 * "no candidates" error instead of a diagnosable one.
 */
export function minimumSatisfyingVersion(range) {
  const trimmed = (range ?? "").trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x" || trimmed === "latest") return "0.0.0";
  // A strict `>` or `<` excludes the boundary version, so the lowest member of the range is not
  // derivable this way. Those return undefined and the absence becomes fatal, rather than serving
  // a stub the descriptor itself rejects.
  if (/^[<>]\s*[^=]/u.test(trimmed)) return undefined;
  // Anchored, with disjoint leading operators and digits, so there is nothing to backtrack over.
  // The prerelease suffix is preserved: an exact `1.2.3-beta.1` is satisfied only by itself, so
  // dropping it would again produce a stub the range rejects.
  const exact = /^[\s^~>=v]*(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)/u.exec(trimmed);
  if (exact !== null) return exact[1];
  // x-ranges: 1.x, 1.2.x, 1.*
  return partialRangeVersion(trimmed);
}

/** x-ranges (`1.x`, `1.2.x`, `1.*`) and a bare major, each resolving to the range's lowest member. */
function partialRangeVersion(trimmed) {
  // Every partial form npm accepts resolves to the lowest member of its range: an x-range
  // (`1.x`, `1.2.*`), a two-part version (`1.2`, `~1.2`, `^1.2`) or a bare major (`3`, `^3`).
  const partial = /^[\s^~>=v]*(\d+)(?:\.(\d+))?(?:\.[x*])?$/u.exec(trimmed);
  if (partial !== null) return `${partial[1]}.${partial[2] ?? "0"}.0`;
  const xRange = /^[\s^~>=v]*(\d+)(?:\.(\d+))?\.[x*]/u.exec(trimmed);
  return xRange === null ? undefined : `${xRange[1]}.${xRange[2] ?? "0"}.0`;
}

/**
 * npm's package-json documentation: "Entries in optionalDependencies will override entries of the
 * same name in dependencies." That precedence is applied per manifest, so a name listed in both is
 * treated as optional. Across DIFFERENT manifests a genuine required edge still wins — see
 * `record()` — because another package really does need it.
 */
function manifestRequirements(manifest, bundledSet = new Set()) {
  const merged = new Map();
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    merged.set(name, { name, range, optional: false });
  }
  for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) {
    merged.set(name, { name, range, optional: true });
  }
  return [...merged.values()].filter((requirement) => !bundledSet.has(requirement.name));
}

export function vendoredDependencyRequirements(
  manifest = rootPackageJson,
  packagesRoot = repoRoot,
) {
  const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies ?? [];
  const bundledSet = new Set(bundled);
  const requirements = new Map();
  // Keyed by name, but every distinct OPTIONAL range is kept: two bundled workspaces may declare
  // the same absent optional dependency under non-overlapping ranges, and Yarn has to resolve both
  // descriptors. A required edge from any manifest supersedes them all, since that one must
  // genuinely be present, and its own range is the binding one.
  const record = ({ name, range, optional }) => {
    const existing = requirements.get(name) ?? {
      name,
      required: undefined,
      optionalRanges: new Set(),
    };
    if (optional) existing.optionalRanges.add(range);
    else existing.required = range;
    requirements.set(name, existing);
  };
  // The staged root carries optional entries too — `promoteWorkspacePeers` lifts a workspace's
  // optional third-party peers into exactly that field — so both groups belong in the closure.
  for (const requirement of manifestRequirements(manifest, bundledSet)) record(requirement);
  // A bundled workspace ships inside the tarball, but its own third-party dependencies do not:
  // the consumer's package manager still resolves those from a registry. `keiko-local-knowledge`
  // declaring `@napi-rs/canvas` is exactly how the 2026-08-13 upstream publish race reached a
  // required Keiko gate, so the closure has to include them.
  for (const workspace of bundled) {
    for (const requirement of workspaceThirdPartyRequirements(workspace, packagesRoot)) {
      record(requirement);
    }
  }
  return [...requirements.values()]
    .sort((left, right) => compareStrings(left.name, right.name))
    .flatMap(({ name, required, optionalRanges }) =>
      required === undefined
        ? [...optionalRanges].map((range) => ({ name, range, optional: true }))
        : [{ name, range: required, optional: false }],
    );
}

export function vendoredDependencyNames(manifest = rootPackageJson, packagesRoot = repoRoot) {
  return vendoredDependencyRequirements(manifest, packagesRoot).map(({ name }) => name);
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
  const copies = new Map();
  const record = (root) => {
    const manifest = readInstalledManifest(name, root);
    if (manifest === undefined) return;
    // Keyed by TARGET name and version: two parents may use one alias key for different targets at
    // the same version (`codec: "npm:foo@1.0.0"` and `codec: "npm:bar@1.0.0"`), and npm installs
    // both. A version-only key would discard whichever was scanned second, and Yarn would then ask
    // for a packument this registry never seeded.
    const copyKey = `${typeof manifest.name === "string" ? manifest.name : name}@${manifest.version}`;
    if (copies.has(copyKey)) return;
    copies.set(copyKey, {
      // An `npm:real@1.0.0` alias is installed under the alias directory, but Yarn requests the
      // packument under the TARGET name from the manifest, so that is the key to serve it by.
      name: typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : name,
      version: manifest.version,
      directory: join(root, ...name.split("/")),
      manifest,
    });
  };
  for (const root of installedModuleRoots(modulesRoot, packagesRoot)) record(root);
  return [...copies.values()];
}

/**
 * npm hoists what it can, nests the rest under `packages/<workspace>/node_modules`, and nests a
 * third conflicting version under `node_modules/<pkg>/node_modules`. All three are searched, so a
 * version this repository genuinely pins can never be missing from the served packument.
 */
const moduleRootCache = new Map();

function installedModuleRoots(modulesRoot, packagesRoot) {
  // The root set cannot change during a run, and this walk is otherwise repeated for every visited
  // package name, multiplying syscalls in a required gate.
  const cacheKey = `${modulesRoot}\u0000${packagesRoot}`;
  const cached = moduleRootCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const roots = [modulesRoot];
  const workspacesDir = join(packagesRoot, "packages");
  if (existsSync(workspacesDir)) {
    for (const workspace of readdirSync(workspacesDir)) {
      roots.push(join(workspacesDir, workspace, "node_modules"));
    }
  }
  // Every root is scanned recursively, workspace roots included: npm nests a conflict under a
  // workspace exactly as it does under the hoisted tree.
  const all = [...roots, ...roots.flatMap((root) => nestedModuleRoots(root))];
  moduleRootCache.set(cacheKey, all);
  return all;
}

// npm resolves a conflict below an already nested dependency too
// (`node_modules/a/node_modules/b/node_modules/c`), and a chain of incompatible peer ranges can go
// deeper still. The walk is therefore complete rather than capped at an arbitrary depth: a fixed
// limit would silently omit a package the committed installation genuinely contains, and the gate
// would report it missing or serve a stub in its place. Termination comes from a visited set over
// resolved paths, which also breaks symlink cycles; the whole walk is memoized once per run.
function nestedModuleRoots(modulesRoot, visited = new Set()) {
  if (!existsSync(modulesRoot)) return [];
  const resolvedRoot = realpathSync(modulesRoot);
  if (visited.has(resolvedRoot)) return [];
  visited.add(resolvedRoot);
  const roots = [];
  for (const entry of readdirSync(modulesRoot)) {
    if (entry.startsWith(".")) continue;
    const owners = entry.startsWith("@")
      ? readdirSync(join(modulesRoot, entry)).map((scoped) => join(modulesRoot, entry, scoped))
      : [join(modulesRoot, entry)];
    for (const owner of owners) {
      const nested = join(owner, "node_modules");
      if (!existsSync(nested)) continue;
      roots.push(nested, ...nestedModuleRoots(nested, visited));
    }
  }
  return roots;
}

/**
 * Walks the third-party dependency closure the Yarn consumer has to resolve — the root's own
 * non-bundled dependencies plus those declared by the bundled workspaces — against this
 * repository's installed tree, i.e. the versions `package-lock.json` already pins. A dependency
 * that is only reachable as an optional entry and is not installed here is not an error: Yarn is
 * told not to ask for it via `supportedArchitectures`.
 */
export function resolveVendorClosure(
  modulesRoot,
  manifest = rootPackageJson,
  packagesRoot = repoRoot,
) {
  // `manifest` should be the STAGED manifest (`artifact.manifest`), not the repo root:
  // `promoteWorkspacePeers` in stage-publish-package.mjs lifts a bundled workspace's third-party
  // peer dependencies into the staged root, and a closure that re-derived only the workspace's
  // own dependency fields would miss them — the consumer would then request a package this
  // registry never seeded. Deriving from the producer's output keeps the two in step.
  const resolved = new Map();
  const missing = [];
  const stubs = new Map();
  // A package first seen through an optional edge may later be REQUIRED by another parent. Keeping
  // the stub there would serve an inert package for a genuinely required dependency and let the
  // smoke pass without it, so the required edge withdraws the stub and the absence becomes fatal.
  const resolveAgainstExistingStub = (name, requirement, stubKey) => {
    if (requirement?.optional !== false) return;
    stubs.delete(stubKey);
    missing.push(name);
  };
  const visit = (name, requirement) => {
    if (resolved.has(name) || missing.includes(name)) return;
    // No derivable version means no stub can exist for this descriptor, so the lookup is skipped
    // rather than probing a `name@` key that is never written.
    const stubVersion = minimumSatisfyingVersion(requirement?.range);
    const stubKey = stubVersion === undefined ? undefined : `${name}@${stubVersion}`;
    if (stubKey !== undefined && stubs.has(stubKey)) {
      resolveAgainstExistingStub(name, requirement, stubKey);
      return;
    }
    const copies = findInstalledCopies(name, modulesRoot, packagesRoot);
    if (copies.length === 0) {
      recordAbsent(name, requirement);
      return;
    }
    resolved.set(name, copies);
    for (const copy of copies) visitDependenciesOf(copy);
  };
  // npm drops an optional dependency entirely when its platform prebuild cannot be installed, so
  // the tree genuinely may not contain it — that is how `@napi-rs/canvas` is present on macOS here
  // and absent on Linux CI. Yarn still insists on RESOLVING it, so an absent optional package
  // becomes an inert stub: resolvable, never linked. A non-optional absence stays fatal.
  const recordAbsent = (name, requirement) => {
    const version = minimumSatisfyingVersion(requirement?.range);
    if (requirement?.optional === true && version !== undefined) {
      // Keyed by name AND version: canvas 1.0.0 and 1.0.2 each demand their own platform build,
      // so a name-only key would serve one version's stub for the other's requirement.
      stubs.set(`${name}@${version}`, { name, version });
      return;
    }
    missing.push(name);
  };
  const visitDependenciesOf = (copy) => {
    // Same npm precedence as the root manifest: a name in both fields is optional here.
    for (const requirement of manifestRequirements(copy.manifest))
      visit(requirement.name, requirement);
  };
  for (const requirement of vendoredDependencyRequirements(manifest, packagesRoot)) {
    visit(requirement.name, requirement);
  }
  return {
    packages: [...resolved.values()].flat(),
    stubs: [...stubs.values()],
    missing,
  };
}

function packVendoredPackage(entry, destination) {
  // npm names its output `<flattened-name>-<version>.tgz`, which collides across the scope
  // boundary: `@foo/bar@1.2.3` and `foo-bar@1.2.3` both produce `foo-bar-1.2.3.tgz`. A per-package
  // directory keeps the second pack from overwriting the first after its integrity was recorded,
  // which would hand Yarn the wrong bytes.
  // Keyed by a digest of the exact name, not a character-class replacement: collapsing every
  // separator to "-" maps `@foo/bar-baz` and `@foo-bar/baz` onto the same directory, and npm then
  // names both archives `foo-bar-baz-1.2.3.tgz`, so the second overwrites the first after its
  // integrity was recorded and Yarn receives bytes that fail the checksum it was handed.
  const nameDigest = createHash("sha256").update(entry.name).digest("hex").slice(0, 16);
  const packDir = join(destination, `pack-${nameDigest}`);
  mkdirSync(packDir, { recursive: true });
  const result = run(
    "npm",
    ["pack", entry.directory, "--pack-destination", packDir, "--ignore-scripts", "--json"],
    { cwd: repoRoot, timeout: NPM_INSTALL_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    fail(
      `npm pack of vendored dependency ${entry.name} exited ${String(result.status)}: ` +
        `${(result.stderr || result.stdout).trim()}`,
    );
  }
  const produced = JSON.parse(result.stdout).at(0)?.filename;
  if (typeof produced !== "string" || produced.length === 0) {
    fail(`npm pack of vendored dependency ${entry.name} printed no tarball name`);
  }
  return join(packDir, produced);
}

/**
 * A stub carries the real name and a satisfying version so the resolution graph closes, and an
 * `os`/`cpu` pair that matches no host so the package manager never links it. It exists only for
 * optional dependencies this repository does not install; nothing real is ever replaced by one.
 */
// Yarn evaluates platform compatibility from packument metadata, not only from the tarball, so
// these guards have to appear in BOTH. Without them in the packument, an absent optional package
// would be linked as an empty stub and a native-binding regression could pass unnoticed (#3130).
const STUB_INCOMPATIBLE_PLATFORM = "keiko-smoke-never-matches";

export function stubManifest(name, version) {
  return {
    name,
    version,
    description:
      "Inert offline stub served by the Keiko installable-package smoke (#3130). Never linked.",
    os: [STUB_INCOMPATIBLE_PLATFORM],
    cpu: [STUB_INCOMPATIBLE_PLATFORM],
  };
}

function packStubPackage(entry, destination) {
  const stubDir = mkdtempSync(join(destination, "stub-"));
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, "package.json"),
    `${JSON.stringify(stubManifest(entry.name, entry.version), null, 2)}\n`,
    "utf8",
  );
  try {
    return packVendoredPackage({ name: entry.name, directory: stubDir }, destination);
  } finally {
    // The tarball is already written to `destination`; the scaffolding directory is not needed
    // beyond this point, so it goes immediately rather than lingering until the caller cleans up.
    rmSync(stubDir, { recursive: true, force: true });
  }
}

const isStubEntry = (entry) => entry?.manifest?.os?.[0] === STUB_INCOMPATIBLE_PLATFORM;

/**
 * A stub is only ever legitimate for a FOREIGN platform prebuild. If a package is seeded for real
 * but the optional binding matching this host is a stub, the install would run without the native
 * binding while ADR-0021 D7 claims the running platform's binding is installed and proven — so the
 * gate says so instead of quietly shipping the weaker guarantee (#3130).
 */
function stubbedHostBindings(seeded, entry, hostSuffixes) {
  if (isStubEntry(entry)) return [];
  return Object.entries(entry.manifest?.optionalDependencies ?? {})
    .filter(([optional]) => hostSuffixes.some((suffix) => optional.endsWith(suffix)))
    .filter(([optional, range]) => {
      // The version THIS parent declares, not any version under the name. The lockfile carries
      // canvas 1.0.0 and 1.0.2, so an aggregate check passes as soon as one binding is real while
      // the other parent still resolves its exact binding to a stub.
      const required = minimumSatisfyingVersion(range);
      const versions = seeded.get(optional);
      if (versions === undefined || required === undefined) return false;
      const candidate = versions.get(required);
      return candidate !== undefined && isStubEntry(candidate);
    })
    .map(([optional, range]) => `${entry.name}@${entry.version} -> ${optional}@${range}`);
}

/**
 * Prebuilt binding names carry an ABI suffix on some platforms — `-linux-x64-gnu`, `-linux-x64-musl`,
 * `-win32-x64-msvc` — so a bare `-<platform>-<arch>` suffix matches nothing on exactly the lanes CI
 * runs. The set is derived from the same libc detection `supportedArchitectures()` uses, so a glibc
 * host does not accept the musl build as its own.
 */
export function hostBindingSuffixes(
  platform = process.platform,
  arch = process.arch,
  libc = undefined,
) {
  const base = `-${platform}-${arch}`;
  if (platform === "linux") {
    const resolvedLibc = libc ?? linuxLibc();
    // `linuxLibc()` yields the value Yarn's `supportedArchitectures` expects — `glibc` — while the
    // prebuilt packages are named with the toolchain, `-gnu`. Using the Yarn spelling here would
    // generate `-linux-x64-glibc`, which matches no published binding, and the guard would be
    // inert on the glibc lane exactly as the bare suffix was on every lane.
    return [base, `${base}-${resolvedLibc === "musl" ? "musl" : "gnu"}`];
  }
  if (platform === "win32") return [base, `${base}-msvc`];
  return [base];
}

export function assertHostBindingsAreReal(seeded) {
  const hostSuffixes = hostBindingSuffixes();
  const offenders = [...seeded.values()].flatMap((versions) =>
    [...versions.values()].flatMap((entry) => stubbedHostBindings(seeded, entry, hostSuffixes)),
  );
  if (offenders.length > 0) {
    fail(
      `this host's native bindings are not installed, so the Yarn arm would pass without them: ` +
        `${offenders.join(", ")} — run \`npm install\` before the installable-package smoke`,
    );
  }
}

/**
 * An entry seeded by an earlier pass wins — it was captured before `prepack` pruned the tree,
 * including entries restored from a previous PROCESS through the index. The one exception is a
 * cached STUB: once the real package is installed again it must supersede the placeholder, or the
 * lane would keep skipping a native binding that is now available.
 */
function shouldSeed(seeded, entry) {
  const existing = seeded.get(entry.name)?.get(entry.version);
  if (existing === undefined) return true;
  return isStubEntry(existing) && !isStubEntry(entry);
}

function seedEntry(seeded, entry, tarballPath) {
  const versions = seeded.get(entry.name) ?? new Map();
  versions.set(entry.version, {
    ...entry,
    tarballPath,
    integrity: tarballIntegrity(tarballPath),
  });
  seeded.set(entry.name, versions);
}

const SEED_INDEX_FILE = "seed-index.json";

/**
 * The seed has to survive across processes, not just across calls: CI runs this script twice and
 * the first run's `prepack` prunes the native optionals out of `node_modules`. A directory alone
 * is not enough — without an index the second process starts from an empty map, re-derives from
 * the pruned tree, and overwrites the real archives with stubs. The index is what makes the
 * pre-prune artifacts reusable (#3130).
 */
export function loadSeedIndex(destination) {
  const indexPath = join(destination, SEED_INDEX_FILE);
  if (!existsSync(indexPath)) return new Map();
  let raw;
  try {
    raw = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    // A malformed index is recoverable state, not a reason to fail a required gate: the closure is
    // simply re-packed from the tree. Failing here would turn an interrupted previous run into a
    // red build that no change to this checkout could fix.
    return new Map();
  }
  // A document that parses but is not an index object would throw on Object.entries outside the
  // try, defeating the recovery this function documents.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return new Map();
  const seeded = new Map();
  for (const [name, versions] of Object.entries(raw)) {
    const restored = new Map();
    for (const [version, entry] of Object.entries(versions)) {
      // An indexed entry is only reused when its archive still exists, lives INSIDE this cache,
      // and still hashes to the integrity that was recorded for it. Anything else is dropped and
      // re-packed from the tree rather than served on trust.
      if (isReusableSeedEntry(destination, entry))
        restored.set(version, { ...entry, name, version });
    }
    if (restored.size > 0) seeded.set(name, restored);
  }
  return seeded;
}

function isReusableSeedEntry(destination, entry) {
  if (typeof entry?.tarballPath !== "string" || !existsSync(entry.tarballPath)) return false;
  // Containment: an index that points outside the cache could otherwise name any file on disk.
  const resolvedRoot = realpathSync(destination);
  const resolved = realpathSync(entry.tarballPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) return false;
  return entry.integrity === tarballIntegrity(resolved);
}

export function writeSeedIndex(destination, seeded) {
  // Published by rename so a concurrent reader never sees a half-written file: two smoke commands
  // share this path within one checkout, and an interrupted write would otherwise leave malformed
  // JSON that the next invocation cannot parse.
  const serializable = {};
  for (const [name, versions] of seeded) {
    serializable[name] = Object.fromEntries(
      [...versions].map(([version, entry]) => [
        version,
        { tarballPath: entry.tarballPath, integrity: entry.integrity, manifest: entry.manifest },
      ]),
    );
  }
  const target = join(destination, SEED_INDEX_FILE);
  const staging = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(staging, `${JSON.stringify(serializable, null, 2)}\n`);
  renameSync(staging, target);
}

export function seedVendoredRegistry(
  destination,
  modulesRoot = join(repoRoot, "node_modules"),
  manifest = rootPackageJson,
  seeded = loadSeedIndex(destination),
) {
  const { packages, stubs, missing } = resolveVendorClosure(modulesRoot, manifest);
  // A name already restored from the index was captured from an intact tree by an earlier process;
  // its absence now is `prepack`'s pruning, not a broken checkout. Likewise a stub must never
  // replace a real archive we already hold.
  const restored = (name) => seeded.has(name);
  const genuinelyMissing = missing.filter((name) => !restored(name));
  const neededStubs = stubs.filter((entry) => !restored(entry.name));
  if (genuinelyMissing.length > 0) {
    fail(
      `vendored dependency closure is not installed: ${genuinelyMissing.join(", ")} — ` +
        `run \`npm install\` before the installable-package smoke`,
    );
  }
  const pending = [
    ...packages.map((entry) => ({ entry, pack: packVendoredPackage })),
    ...neededStubs.map((entry) => ({
      entry: { ...entry, manifest: stubManifest(entry.name, entry.version) },
      pack: packStubPackage,
    })),
  ];
  for (const { entry, pack } of pending) {
    if (shouldSeed(seeded, entry)) seedEntry(seeded, entry, pack(entry, destination));
  }
  writeSeedIndex(destination, seeded);
  assertHostBindingsAreReal(seeded);
  return seeded;
}

function tarballIntegrity(tarballPath) {
  return `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`;
}

function rootTarballPath(name, version) {
  return `${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
}

function seededTarball(seeded, requested) {
  for (const [name, versions] of seeded) {
    if (!requested.startsWith(`${name}/-/`)) continue;
    return [...versions.values()].find(
      (entry) => requested === `${name}/-/${tarballFileName(name, entry.version)}`,
    );
  }
  return undefined;
}

function tarballFileName(name, version) {
  return `${name.split("/").at(-1)}-${version}.tgz`;
}

function releaseSegments(version) {
  const [core = ""] = version.split("+");
  const [release = "", ...prerelease] = core.split("-");
  return {
    numbers: release.split(".").map((part) => Number.parseInt(part, 10) || 0),
    prerelease: prerelease.join("-"),
  };
}

function compareIdentifier(left, right) {
  const [numericLeft, numericRight] = [/^\d+$/u.test(left), /^\d+$/u.test(right)];
  if (numericLeft && numericRight) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  // SemVer §11: numeric identifiers always rank below alphanumeric ones.
  if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
  return compareStrings(left, right);
}

function comparePrereleaseIdentifiers(left, right) {
  // SemVer §11: a version WITH a prerelease ranks below the same version without one.
  if (left === right) return 0;
  if (left === "") return 1;
  if (right === "") return -1;
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const [a, b] = [leftParts[index], rightParts[index]];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const difference = compareIdentifier(a, b);
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareVersions(left, right) {
  const [a, b] = [releaseSegments(left), releaseSegments(right)];
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return comparePrereleaseIdentifiers(a.prerelease, b.prerelease);
}

// An ALLOWLIST, not a denylist. A denylist of bad protocols is wrong by construction: it was
// missing `ssh:` and `ssh+git:` — which Yarn's Git resolver accepts and whose error output echoes
// the full descriptor, credentials included — and the next protocol would have slipped through the
// same way. Only a registry descriptor is acceptable here: no protocol at all (a semver range, a
// tag, `*`), or an explicit `npm:` alias. Everything else resolves outside the loopback registry
// and is refused before Yarn starts (#3130).
const REGISTRY_PROTOCOL = /^npm:/iu;
const HAS_PROTOCOL = /^[a-z][a-z0-9+.-]*:/iu;
// Yarn also accepts a colon-less forge shorthand (`owner/repo`, `owner/repo#semver:^1.0.0`), which
// it fetches straight from GitHub. A leading `@` is excluded so a scoped package name is not
// mistaken for one.
const FORGE_SHORTHAND = /^[^@\s/][^\s/]*\/[^\s/]+$/u;

/** A descriptor's shape, never its value: the value may carry a token or a private endpoint. */
function descriptorClass(range) {
  const protocol = /^([a-z][a-z0-9+.-]*):/iu.exec(range)?.[1];
  if (protocol !== undefined) return `${protocol.toLowerCase()}:`;
  return FORGE_SHORTHAND.test(range) ? "forge-shorthand" : "unknown";
}

function isNonRegistryDescriptor(range) {
  if (HAS_PROTOCOL.test(range)) return !REGISTRY_PROTOCOL.test(range);
  return FORGE_SHORTHAND.test(range);
}

function manifestProtocolOffenders(name, entry) {
  return ["dependencies", "optionalDependencies", "peerDependencies"]
    .flatMap((group) => Object.entries(entry.manifest?.[group] ?? {}))
    .filter(([, range]) => typeof range === "string" && isNonRegistryDescriptor(range))
    .map(
      // The descriptor VALUE never reaches the log: `git+https://token@host/pkg.git` would carry a
      // credential into a required gate's output. Only the owning package, the dependency name and
      // the descriptor's shape are reported, per the repository's body-free evidence rule.
      ([dependency, range]) =>
        `${name}@${entry.version} -> ${dependency} (${descriptorClass(range)})`,
    );
}

/**
 * The staged root's own non-bundled dependencies are checked too: a `git+https:` or tarball-URL
 * descriptor there would be resolved by Yarn outside the loopback registry just as surely as one
 * in a seeded manifest. The `file:vendor/...` entries are the intentional exception — that is how
 * `stage-publish-package.mjs` points at the tarball-local private workspaces (ADR-0021 / #3101),
 * and they never leave the installed package.
 */
export function assertStagedRootDescriptors(manifest) {
  const offenders = ["dependencies", "optionalDependencies"]
    .flatMap((group) => Object.entries(manifest?.[group] ?? {}))
    .filter(([, range]) => typeof range === "string")
    .filter(([, range]) => !/^file:vendor[/\\]/u.test(range))
    .filter(([, range]) => isNonRegistryDescriptor(range))
    .map(([dependency, range]) => `${dependency} (${descriptorClass(range)})`);
  if (offenders.length > 0) {
    fail(
      `staged root declares non-registry dependency protocols outside its vendor archives: ` +
        `${offenders.join(", ")}`,
    );
  }
}

export function assertRegistryOnlyDescriptors(seeded) {
  const offenders = [...seeded].flatMap(([name, versions]) =>
    [...versions.values()].flatMap((entry) => manifestProtocolOffenders(name, entry)),
  );
  if (offenders.length > 0) {
    fail(
      `vendored closure declares non-registry dependency protocols, which would resolve outside ` +
        `the offline registry: ${offenders.join(", ")}`,
    );
  }
}

function vendoredPackument(name, versions, registryUrl) {
  const sorted = [...versions.values()].sort((left, right) =>
    compareVersions(left.version, right.version),
  );
  const entries = {};
  for (const entry of sorted) {
    // Optional edges are preserved so the running platform's real native binding still installs
    // and is still proven; the foreign-platform prebuilds resolve to inert stubs instead (#3130).
    entries[entry.version] = {
      ...entry.manifest,
      dist: {
        integrity: entry.integrity,
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
      if (requested === rootTarballPath(rootPackageJson.name, rootVersion)) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(tarballBytes);
        return;
      }
      const served = seededTarball(seeded, requested);
      if (served === undefined) {
        // An unseeded or wrong-version tarball is never answered with the root artifact: serving
        // real bytes under a foreign name would be a silent substitution, not a hermetic registry.
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      const stream = createReadStream(served.tarballPath);
      // An unhandled stream error would take the registry — and with it the gate — down with an
      // opaque crash; destroying the response instead surfaces as a failed fetch Yarn can report.
      stream.on("error", () => response.destroy());
      // `pipe()` only unpipes and pauses the source when the destination goes away, leaving its
      // descriptor open, so an aborted download would accumulate descriptors until EMFILE.
      response.on("close", () => stream.destroy());
      stream.pipe(response);
      return;
    }
    // Exact match only. A registry should answer for the name it was asked for and nothing else;
    // case-folding here would serve the root packument under a name npm would treat as different.
    if (requested === rootPackageJson.name) {
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

/**
 * Yarn reads `YARN_*` environment variables at a HIGHER precedence than `.yarnrc.yml`, so an
 * ambient `YARN_NPM_REGISTRY_SERVER` on a runner or developer machine would silently send this
 * install back to a live registry and past the fail-closed 404s. Registry-affecting variables are
 * therefore dropped and the loopback server is re-asserted through the environment as well (#3130).
 */
/**
 * Yarn reads `.yarnrc.yml` from the home directory and from every ancestor of the project, so
 * sanitizing environment variables alone leaves an ambient rc able to switch on hardened mode,
 * register plugins, or inject `packageExtensions` inside a gate that claims to be hermetic. The
 * child therefore gets a private, empty home; provisioning uses the same one so both agree on
 * Corepack's cache location (#3130).
 */
/**
 * Corepack caches package managers under `COREPACK_HOME`, which defaults to a path inside `HOME`.
 * Since the child gets a private, empty home for rc isolation, leaving the cache to follow it would
 * make every run download Yarn afresh — turning an occasional network dependency into a per-run
 * one. The cache therefore lives at a stable path of its own, keyed by the pinned version so a
 * bump does not reuse the previous tool (#3130).
 */
export function corepackCacheDir() {
  const dir = join(tmpdir(), `keiko-corepack-${PINNED_YARN.replace(/[^a-zA-Z0-9.]+/gu, "-")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function privateYarnHome() {
  const home = mkdtempSync(join(tmpdir(), "keiko-yarn-home-"));
  return home;
}

export function yarnChildEnv(registryUrl, baseEnv = process.env, home = undefined) {
  // Every `YARN_*` variable is dropped, not a curated subset: Yarn maps each of its settings to
  // one, and an ambient `YARN_NODE_LINKER=pnp` or `YARN_RC_FILENAME` would change the install
  // shape just as surely as a registry override. The gate then re-asserts only what it needs, so
  // its outcome cannot depend on the machine it runs on (#3130).
  // `COREPACK_*` is stripped for the same reason as `YARN_*`: `COREPACK_ENABLE_PROJECT_SPEC=0`
  // makes Corepack ignore the project's `packageManager` field and run its system-wide Yarn, so
  // the gate would exercise an unreviewed version despite the pin.
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !/^(?:YARN_|COREPACK_)/u.test(key)),
  );
  return {
    ...env,
    // A private home keeps an ambient `~/.yarnrc.yml` out of this install entirely.
    ...(home === undefined ? {} : { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home }),
    // Explicit, so the cache does not follow the private home and vanish between runs.
    COREPACK_HOME: corepackCacheDir(),
    COREPACK_ENABLE_PROJECT_SPEC: "1",
    YARN_ENABLE_GLOBAL_CACHE: "false",
    YARN_ENABLE_TELEMETRY: "false",
    YARN_NODE_LINKER: "node-modules",
    YARN_NPM_REGISTRY_SERVER: registryUrl,
    YARN_UNSAFE_HTTP_WHITELIST: "127.0.0.1",
    // Corepack must not reach repo.yarnpkg.com during the install: the pinned tool is provisioned
    // beforehand, so an outage there cannot fail a gate that claims to resolve offline (#3130).
    COREPACK_ENABLE_NETWORK: "0",
  };
}

const PINNED_YARN = "yarn@4.9.1";

/**
 * Downloads the pinned Yarn into Corepack's cache if it is not there yet. This is the one network
 * call the smoke may still make, and it is tool provisioning rather than dependency resolution:
 * it happens before the install, its failure names Corepack explicitly, and the install itself
 * then runs with `COREPACK_ENABLE_NETWORK=0`.
 *
 * `--cache-only` matters: a plain `--global` install would make this version Corepack's system-wide
 * default and change unrelated invocations on a developer machine or shared runner. A gate must not
 * mutate the environment it runs in; the throwaway project's own `packageManager` field is what
 * selects Yarn here.
 */
/** Entry point for the setup step, so provisioning happens before the gate rather than inside it. */
export function provisionPinnedYarnForSetup() {
  if (isPinnedYarnCached()) {
    console.log(`provision-pinned-yarn: ${PINNED_YARN} already cached; no request made.`);
    return;
  }
  provisionPinnedYarn(undefined, undefined);
  console.log(`provision-pinned-yarn: ${PINNED_YARN} cached in ${corepackCacheDir()}.`);
}

function isPinnedYarnCached() {
  const cache = join(corepackCacheDir(), "v1", "yarn");
  if (!existsSync(cache)) return false;
  return readdirSync(cache).includes(PINNED_YARN.split("@").at(-1) ?? "");
}

function provisionPinnedYarn(registryUrl, home) {
  // Already cached from an earlier run or a CI setup step: no network call at all. That keeps an
  // outage at the package-manager host from failing a gate whose dependency install is offline.
  if (isPinnedYarnCached()) return;
  // Provisioning must see the SAME sanitized environment as the install, or `COREPACK_HOME` is
  // honoured here and stripped there — Corepack would then cache the tool in one place and search
  // another with networking already disabled. Only the network flag differs.
  const env = { ...yarnChildEnv(registryUrl, process.env, home), COREPACK_ENABLE_NETWORK: "1" };
  const result = run("corepack", ["install", "--global", "--cache-only", PINNED_YARN], {
    timeout: NPM_INSTALL_TIMEOUT_MS,
    env,
  });
  if (result.status !== 0) {
    fail(
      `corepack could not provision ${PINNED_YARN} before the offline install: ` +
        `${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function writeYarnConfiguration(tmp, registryUrl) {
  const architectureLines = Object.entries(supportedArchitectures()).flatMap(([key, values]) => [
    `  ${key}:`,
    ...values.map((value) => `    - ${value}`),
  ]);
  const lines = [
    "nodeLinker: node-modules",
    "enableGlobalCache: false",
    "enableTelemetry: false",
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
  assertRegistryOnlyDescriptors(vendored ?? new Map());
  assertStagedRootDescriptors(artifact.manifest);
  const registry = await startLocalRegistry(artifact, vendored);
  const yarnHome = privateYarnHome();
  provisionPinnedYarn(registry.registryUrl, yarnHome);
  writeFileSync(
    join(tmp, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        packageManager: PINNED_YARN,
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
        env: yarnChildEnv(registry.registryUrl, process.env, yarnHome),
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
    rmSync(yarnHome, { recursive: true, force: true });
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

/**
 * CI runs this script twice — `smoke:install` then `smoke:install:optional` — as separate
 * processes against one checkout. The first run's `prepack` permanently prunes `@napi-rs/canvas`
 * and its bindings out of `node_modules`, so a second run seeding from that tree would substitute
 * inert stubs and let the optional lane pass without the native binding it exists to prove.
 *
 * The seed directory is therefore stable and keyed by the lockfile, so the second invocation
 * reuses the pre-prune artifacts the first one packed instead of re-deriving them from a mutated
 * tree (#3130).
 */
export function persistentVendorSeedDir(lockfilePath = join(repoRoot, "package-lock.json")) {
  // Keyed by the CHECKOUT as well as the lockfile: two checkouts sharing a lockfile must not share
  // a cache, and a predictable path on a shared host is otherwise pre-creatable by another user.
  // The lockfile is hashed as BYTES. Interpolating the Buffer into a template string would decode
  // it as UTF-8 first, and any byte sequence that does not survive that round trip would map two
  // distinct lockfiles onto one cache directory.
  const digest = createHash("sha256").update(repoRoot).update("\u0000");
  digest.update(existsSync(lockfilePath) ? readFileSync(lockfilePath) : "no-lockfile");
  // The implementation is part of the key: switching revisions in one worktree without touching
  // the lockfile would otherwise run new packing, manifest-projection or stub logic against
  // tarballs produced by the old logic, and the gate could stay green over the very regression it
  // is meant to catch.
  digest.update("\u0000").update(readFileSync(fileURLToPath(import.meta.url)));
  const key = digest.digest("hex").slice(0, 24);
  const dir = join(tmpdir(), `keiko-yarn-vendor-seed-${key}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(dir);
  return dir;
}

/** A cache another account can write is a cache that can hand this gate unverified bytes. */
function assertPrivateDirectory(dir) {
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail(`vendor seed cache ${dir} is not a real directory`);
  }
  if (process.getuid !== undefined && stats.uid !== process.getuid()) {
    fail(`vendor seed cache ${dir} is not owned by this user`);
  }
  // Group/other write bits would let another account replace an archive between runs. POSIX mode
  // bits carry no meaning on Windows — Node reports a synthetic mode there and exposes no ACL API —
  // so the check is skipped rather than evaluated against a value that says nothing. That platform
  // is not left unguarded: `os.tmpdir()` is per-user on Windows
  // (`%LOCALAPPDATA%\Temp`), so the shared-directory exposure this check addresses does not arise
  // by default, and the containment plus integrity checks in `isReusableSeedEntry` apply on every
  // platform regardless.
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    fail(`vendor seed cache ${dir} is group- or world-writable`);
  }
}

/**
 * Seeds the offline registry and THEN packs the publish artifact, in that order, because
 * `packRoot()` runs `prepack`, whose `prune:package-native-optionals` step deletes
 * `@napi-rs/canvas` and its platform bindings out of `node_modules`. Seeding afterwards would find
 * them gone, serve inert stubs in their place, and let the Yarn arm pass without the native
 * binding it exists to prove (#3130).
 *
 * Dependency-injected so the ordering is observable in a test: a pin comparing source positions
 * would stay green if a refactor moved the effective call and left the statement text in place.
 */
export function seedThenPack(vendorTmp, deps) {
  const seed = deps?.seedVendoredRegistry ?? seedVendoredRegistry;
  const pack = deps?.packRoot ?? packRoot;
  const vendored = seed(vendorTmp);
  const artifact = pack();
  return { vendored, artifact };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Stable and lockfile-keyed, so the second CI invocation reuses the pre-prune artifacts.
  const vendorTmp = persistentVendorSeedDir();
  // Both directories are created INSIDE the try, so a failure creating the second does not strand
  // the first; the finally tolerates either being unassigned.
  let tmp;
  let yarnTmp;
  let artifact;
  try {
    tmp = mkdtempSync(join(tmpdir(), "keiko-install-smoke-"));
    yarnTmp = mkdtempSync(join(tmpdir(), "keiko-yarn-install-smoke-"));
    const seeded = seedThenPack(vendorTmp);
    const { vendored } = seeded;
    artifact = seeded.artifact;
    installInto(tmp, artifact.tarballPath, options);
    assertCliExecutable(tmp);
    assertVendoredPayload(tmp);
    assertProductiveTypeScriptRuntime(tmp);
    assertCliVersionAndHelp(tmp);
    await assertInstalledRootRuntimeSurface(tmp);
    assertInstalledRootTypeSurface(tmp);
    await assertPackagedUi(tmp);
    await assertPackagedLifecycleCommands(tmp);
    // Top up from the STAGED manifest: `promoteWorkspacePeers` can lift third-party peers into it
    // that the repository manifest never named. Anything already captured above is kept as-is, so
    // the pre-prune copies win.
    seedVendoredRegistry(vendorTmp, undefined, artifact.manifest, vendored);
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
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    if (yarnTmp !== undefined) rmSync(yarnTmp, { recursive: true, force: true });
    // vendorTmp is deliberately NOT removed: it is the lockfile-keyed cache the next invocation
    // reuses, and it lives under the OS temp directory.
    artifact?.cleanup();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
