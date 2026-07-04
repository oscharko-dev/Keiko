// Installable-package smoke (Issue #169 D2, AC2). Packs the root, installs the tarball into a
// fresh tmpdir, and asserts that (a) every bundleDependencies workspace ships under
// node_modules/@oscharko-dev/keiko/node_modules/@oscharko-dev/keiko-<name>/dist/, (b) the CLI bin
// is executable end-to-end (`--version`, `--help`), (c) the SDK root export resolves with the
// bundle in place, and (d) the packaged UI static export resolves through `keiko ui`. This is the
// runtime mirror of `scripts/check-package-surface.mjs`'s static tarball assertions, intended to
// fire BEFORE publish so a broken bundle can never reach users.

import { spawn, spawnSync } from "node:child_process";
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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const DEFAULT_NPM_INSTALL_TIMEOUT_MS = 90_000;
const WINDOWS_NPM_INSTALL_TIMEOUT_MS = 300_000;
const NPM_INSTALL_TIMEOUT_MS =
  process.platform === "win32" ? WINDOWS_NPM_INSTALL_TIMEOUT_MS : DEFAULT_NPM_INSTALL_TIMEOUT_MS;
const UI_HEALTH_TIMEOUT_MS = 30_000;
const UI_HEALTH_POLL_INTERVAL_MS = 250;
const LIFECYCLE_COMMAND_TIMEOUT_MS = 90_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const rootPackageSurfaceContract = JSON.parse(
  readFileSync(join(repoRoot, "scripts", "root-package-surface.contract.json"), "utf8"),
);
const rootVersion = rootPackageJson.version;
const bundled = rootPackageJson.bundleDependencies ?? [];

function parseArgs(argv) {
  return {
    includeOptional: argv.includes("--include-optional"),
  };
}

function fail(message) {
  console.error(`installable-smoke failed: ${message}`);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  // SECURITY-SHELL-OK: npm-only Windows .cmd compatibility; node/bin paths stay shell:false.
  // `npm` resolves to `npm.cmd` on Windows, which modern Node refuses to spawn without a shell
  // (CVE-2024-27980 hardening); route npm — and only npm — through the shell so the packaged-artifact
  // smoke is cross-platform (the #284 OS matrix surfaced this). `node` is a real executable and is
  // spawned directly (no shell) so absolute bin paths never pass through shell word-splitting. The
  // npm arguments are tool-internal literals plus a tarball path under a controlled directory — no
  // untrusted shell input. POSIX is unaffected: the shell runs the same `npm …` invocation.
  const needsShell = cmd === "npm";
  const result = spawnSync(cmd, args, { encoding: "utf8", shell: needsShell, ...options });
  if (result.error) {
    fail(`${cmd} ${args.join(" ")} could not spawn: ${result.error.message}`);
  }
  return result;
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
  const probeFile = join(fromDirectory, "__keiko-public-api-probe__.ts").replace(/\\/gu, "/");
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
    .sort();
}

function packRoot() {
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
  const packArgs =
    process.env.KEIKO_SMOKE_PACK_IGNORE_SCRIPTS === "1"
      ? ["pack", "--silent", "--ignore-scripts"]
      : ["pack", "--silent"];
  const result = run("npm", packArgs, { cwd: repoRoot });
  if (result.status !== 0) {
    fail(`npm pack exited ${String(result.status)}: ${result.stderr}`);
  }
  const tarballName = `oscharko-dev-keiko-${rootVersion}.tgz`;
  const tarballPath = join(repoRoot, tarballName);
  if (!existsSync(tarballPath)) {
    fail(`expected tarball at ${tarballPath} after npm pack`);
  }
  return tarballPath;
}

function installInto(tmp, tarballPath, options) {
  const initResult = run("npm", ["init", "-y"], { cwd: tmp });
  if (initResult.status !== 0) {
    fail(`npm init -y exited ${String(initResult.status)}: ${initResult.stderr}`);
  }
  // `--ignore-scripts` matches the conservative posture the gate models for consumer installs:
  // a future bundled package that acquires a `postinstall` hook would otherwise execute it on
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

function assertBundledPayload(tmp) {
  const bundleRoot = join(tmp, "node_modules", "@oscharko-dev", "keiko", "node_modules");
  for (const name of bundled) {
    const shortName = name.replace(/^@oscharko-dev\//, "");
    const dist = join(bundleRoot, "@oscharko-dev", shortName, "dist");
    if (!existsSync(dist)) {
      fail(`bundleDependencies payload missing: ${dist}`);
    }
    const entries = readdirSync(dist);
    if (entries.length === 0) {
      fail(`bundleDependencies payload empty: ${dist}`);
    }
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
    const runtimeExports = Object.keys(mod).sort();
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
    const server = createServer();
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
    .replace(/\\/gu, "/")
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
  const child = spawn("node", [bin, "ui", "--port", String(port)], {
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
    fail(`keiko start exited ${String(startResult.status)}: ${startResult.stderr}`);
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
  const stateDir = join(tmp, ".keiko-lifecycle-smoke");
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
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tarballPath = packRoot();
  const tmp = mkdtempSync(join(tmpdir(), "keiko-install-smoke-"));
  try {
    installInto(tmp, tarballPath, options);
    assertCliExecutable(tmp);
    assertBundledPayload(tmp);
    assertCliVersionAndHelp(tmp);
    await assertInstalledRootRuntimeSurface(tmp);
    assertInstalledRootTypeSurface(tmp);
    await assertPackagedUi(tmp);
    await assertPackagedLifecycleCommands(tmp);
    console.log(
      `installable-smoke ok: tarball installed (${options.includeOptional ? "optional deps included" : "optional deps omitted"}), ${String(bundled.length)} bundled packages present, root runtime/types + CLI + UI/lifecycle reachable.`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
}

void main();
