// Windows-only smoke for the Keiko-owned native setup bootstrap (issue #2992). Builds the setup
// companion through the PRODUCTION path (compileSetupBootstrap + appendSetupOverlay, the same
// functions the real release pipeline calls) against a disposable fixture portable tree, then
// exercises the REAL COMPILED EXE directly — no cmd.exe, no IExpress, no SED. This is the
// acceptance test for the vulnerability #2992 fixes: WExtract's undocumented `/C:<command>`
// switch could substitute the embedded install command against the Keiko Authenticode identity;
// the native stub replaces that surface with a closed `/quiet`/`/Q` allowlist that rejects every
// other argument before any side effect.
//
// Not a `*.test.mjs` file on purpose: it compiles a native stub with MSVC and runs a real Windows
// executable, so only the Windows CI leg invokes it directly (`node
// scripts/__tests__/windows-setup-bootstrap-smoke.mjs`), after MSVC has been configured. It must
// never be picked up by `npm test`'s cross-platform vitest run.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { appendSetupOverlay, compileSetupBootstrap } from "../build-windows-portable-setup.mjs";
import { parseSetupOverlay } from "../lib/portable-setup-overlay.mjs";
import { writeZipArchiveFromDirectory } from "../lib/zip-archive.mjs";
import { sha256File, WINDOWS_PORTABLE_SETUP_ASSET_NAME } from "../portable-runtime.mjs";
import { windowsLauncher } from "../../packages/keiko-cli/src/launcher-platforms.ts";

// The closed allowlist this smoke pins (frozen SPEC v1 section 3, point 2): every one of these
// looks like a plausible WExtract/IExpress-style switch (`/C:`, `/T:`, `/D`) or a near-miss of the
// one accepted spelling (`/quiet`, case-insensitive `/Q`) — the argument gate must reject ALL of
// them with zero side effects, because it is an allowlist, never a denylist of known-bad switches.
// Each entry is a full argument vector. Singletons mimic a WExtract/IExpress switch or near-miss the
// one accepted spelling; the mixed vectors pair a VALID leading flag with a rejected one so the gate
// is proven to validate EVERY argument, not just argv[1].
const ADVERSARIAL_ARGUMENTS = Object.freeze([
  ["/C:calc.exe"],
  ["/c:x"],
  ["/C"],
  ["/T:dir"],
  ["/D"],
  ["--anything"],
  ["-q"],
  ["quiet"],
  ["/quiet:extra"],
  ["/Q2"],
  ["/Q", "/C:calc.exe"],
  ["/quiet", "/D"],
]);

function commandOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function commandResultSummary(result) {
  const bytes = (value) =>
    typeof value === "string" ? Buffer.byteLength(value, "utf8") : (value?.byteLength ?? 0);
  return [
    `status=${String(result.status ?? "none")}`,
    `signal=${String(result.signal ?? "none")}`,
    `errorCode=${String(result.error?.code ?? "none")}`,
    `stdoutBytes=${String(bytes(result.stdout))}`,
    `stderrBytes=${String(bytes(result.stderr))}`,
  ].join(" ");
}

function run(command, args, options = {}) {
  const result = runResult(command, args, options);
  assert.equal(result.status, 0, commandResultSummary(result));
}

function runResult(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 45_000, ...options });
  assert.equal(result.error, undefined, commandResultSummary(result));
  return result;
}

function fixtureCli() {
  return [
    'const { spawn } = require("node:child_process");',
    'const { cpSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");',
    'const { dirname, join, resolve } = require("node:path");',
    "const args = process.argv.slice(2);",
    "const command = args[1];",
    'const index = args.indexOf("--portable-root");',
    "if (index < 0 || args[index + 1] === undefined) process.exit(2);",
    "const portableRoot = resolve(args[index + 1]);",
    'const managedRoot = resolve(process.env.KEIKO_SETUP_SMOKE_MANAGED_ROOT || join(process.env.LOCALAPPDATA, "Programs", "Keiko"));',
    'if (command === "resolve-root") { console.log(managedRoot); process.exit(0); }',
    'if (command === "setup") {',
    "  mkdirSync(dirname(managedRoot), { recursive: true });",
    "  if (!existsSync(managedRoot)) cpSync(portableRoot, managedRoot, { recursive: true });",
    '  writeFileSync(process.env.KEIKO_SETUP_SMOKE_SETUP_SENTINEL, `${portableRoot}\\n`, "utf8");',
    "  process.exit(0);",
    "}",
    'if (command !== "launch" || !existsSync(managedRoot)) process.exit(3);',
    'writeFileSync(process.env.KEIKO_SETUP_SMOKE_LAUNCH_SENTINEL, `${portableRoot}\\n`, "utf8");',
    'writeFileSync(process.env.KEIKO_SETUP_SMOKE_RUNTIME_SENTINEL, `${process.execPath}\\n`, "utf8");',
    'const nodePath = join(managedRoot, "runtime", "node", "node.exe");',
    'const childScript = process.env.KEIKO_SETUP_SMOKE_EXIT_IMMEDIATELY === "1" ? "process.exit(0)" : "setTimeout(() => process.exit(0), 14000)";',
    'const child = spawn(nodePath, ["-e", childScript], { detached: true, stdio: "ignore" });',
    "child.unref();",
    'writeFileSync(process.env.KEIKO_SETUP_SMOKE_PID, `${child.pid}\\n`, "utf8");',
    "// Mirrors the real lifecycle CLI: launch exits 0 only after its own health window saw the",
    "// spawned process stay alive; a child that dies early fails the launch (and the installer).",
    "const deadline = Date.now() + 3000;",
    "const waitSignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));",
    "while (Date.now() < deadline) {",
    "  try { process.kill(child.pid, 0); } catch { process.exit(1); }",
    "  Atomics.wait(waitSignal, 0, 0, 100);",
    "}",
    "// One final liveness probe AFTER the loop: a child that died inside the last wait window",
    "// must not slip through as a healthy launch.",
    "try { process.kill(child.pid, 0); } catch { process.exit(1); }",
    "process.exit(0);",
  ].join("\n");
}

function portableExecutableFixture() {
  const bytes = Buffer.alloc(128);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set([0x50, 0x45, 0x00, 0x00], 64);
  return bytes;
}

function writePortableFixture(root, archivePath) {
  const portableRoot = join(root, "Keiko");
  mkdirSync(join(portableRoot, "runtime", "node"), { recursive: true });
  mkdirSync(join(portableRoot, "app", "dist", "cli"), { recursive: true });
  writeFileSync(join(portableRoot, "Keiko.exe"), portableExecutableFixture());
  copyFileSync(process.execPath, join(portableRoot, "runtime", "node", "node.exe"));
  writeFileSync(join(portableRoot, "app", "dist", "cli", "index.js"), fixtureCli(), "utf8");
  writeZipArchiveFromDirectory(portableRoot, archivePath, { rootName: "Keiko" });
  assertNativeLauncherTransport(root);
}

function treeDigest(root) {
  const hash = createHash("sha256");
  const visit = (path) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const stat = statSync(child);
      if (stat.isDirectory()) visit(child);
      else {
        hash.update(relative(root, child).replaceAll("\\", "/"));
        hash.update(readFileSync(child));
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function fixtureProcessId(pidPath) {
  assert.equal(existsSync(pidPath), true, "fixture CLI did not record its managed process");
  const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  assert.equal(Number.isSafeInteger(pid) && pid > 0, true, "fixture CLI recorded an invalid PID");
  return pid;
}

function waitForFixtureProcessExit(pidPath) {
  if (!existsSync(pidPath)) return;
  const pid = fixtureProcessId(pidPath);
  const deadline = Date.now() + 10_000;
  const waitSignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (processExists(pid) && Date.now() < deadline) {
    Atomics.wait(waitSignal, 0, 0, 100);
  }
  rmSync(pidPath, { force: true });
  assert.equal(processExists(pid), false, `fixture process ${pid} did not stop`);
}

function waitForFile(path, message) {
  const deadline = Date.now() + 10_000;
  const waitSignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (!existsSync(path) && Date.now() < deadline) {
    Atomics.wait(waitSignal, 0, 0, 100);
  }
  assert.equal(existsSync(path), true, message);
}

function assertNativeLauncherTransport(root) {
  const launcherRoot = join(root, "Kéiko Üñîçødé & 100% ! ^ (Programs)");
  const launcherExe = join(launcherRoot, "Keiko.exe");
  const launcherPath = join(root, "Keiko.bat");
  const sentinelPath = join(root, "native-launcher.txt");
  mkdirSync(launcherRoot, { recursive: true });
  copyFileSync(process.execPath, launcherExe);
  writeFileSync(
    join(root, "start"),
    'const { writeFileSync } = require("node:fs"); writeFileSync(process.env.KEIKO_LAUNCHER_SENTINEL, `${process.argv.slice(2).join(" ")}\\n`, "utf8");\n',
    "utf8",
  );
  const launcherContent = windowsLauncher.generateContent({ exe: launcherExe, port: undefined });
  assert.equal(
    Array.from(launcherContent).every((character) => character.charCodeAt(0) <= 0x7f),
    true,
    "native launcher registration must remain ASCII-only",
  );
  writeFileSync(launcherPath, launcherContent, "ascii");
  run("cmd.exe", ["/D", "/C", launcherPath], {
    cwd: root,
    env: { ...process.env, KEIKO_LAUNCHER_SENTINEL: sentinelPath },
  });
  waitForFile(sentinelPath, "native launcher did not start the Unicode/metacharacter path");
  assert.equal(readFileSync(sentinelPath, "utf8"), "--open\n");
}

function cleanupSmoke(root, pidPath, failure) {
  try {
    waitForFixtureProcessExit(pidPath);
  } catch (error) {
    failure ??= error;
  }
  try {
    rmSync(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 });
  } catch (error) {
    failure ??= error;
  }
  return failure;
}

function setupEnvironment(
  localAppData,
  pidPath,
  launchSentinelPath,
  runtimeSentinelPath,
  setupSentinelPath,
  managedRoot,
) {
  return {
    env: {
      ...process.env,
      KEIKO_SETUP_SMOKE_LAUNCH_SENTINEL: launchSentinelPath,
      KEIKO_SETUP_SMOKE_PID: pidPath,
      KEIKO_SETUP_SMOKE_RUNTIME_SENTINEL: runtimeSentinelPath,
      KEIKO_SETUP_SMOKE_SETUP_SENTINEL: setupSentinelPath,
      KEIKO_SETUP_SMOKE_MANAGED_ROOT: managedRoot,
      LOCALAPPDATA: localAppData,
    },
  };
}

// Case 1 (frozen SPEC v1 §7): a fresh install runs the compiled EXE with NO arguments at all —
// the real double-click grammar (`argc == 1`). Case 2: an existing-install revalidation runs with
// the explicit `/Q`. Both are accepted argument shapes; the spawned process never owns the console
// alone here (GetConsoleProcessList sees this harness too), so neither the success pacing sleep
// nor an interactive failure pause can ever block the smoke.
function runFreshInstall(setupPath, executeOptions, pidPath) {
  run(setupPath, [], { ...executeOptions, timeout: 90_000 });
  waitForFixtureProcessExit(pidPath);
}

function runExistingInstallRevalidation(setupPath, executeOptions, pidPath) {
  run(setupPath, ["/Q"], { ...executeOptions, timeout: 90_000 });
  waitForFixtureProcessExit(pidPath);
}

function assertFreshSetup({
  executeOptions,
  launchSentinelPath,
  managedRoot,
  pidPath,
  runtimeSentinelPath,
  setupPath,
  setupSentinelPath,
}) {
  runFreshInstall(setupPath, executeOptions, pidPath);
  assert.equal(existsSync(managedRoot), true, "setup did not create the managed root");
  assert.equal(existsSync(setupSentinelPath), true, "compiled bootstrap did not invoke setup");
  assert.equal(existsSync(launchSentinelPath), true, "compiled bootstrap did not invoke launch");
  const extractedRoot = readFileSync(setupSentinelPath, "utf8").trim();
  assert.equal(existsSync(extractedRoot), false, "setup did not remove its extracted staging root");
  assert.equal(resolve(readFileSync(launchSentinelPath, "utf8").trim()), resolve(managedRoot));
  assert.equal(
    resolve(readFileSync(runtimeSentinelPath, "utf8").trim()),
    resolve(join(managedRoot, "runtime", "node", "node.exe")),
  );
}

function assertExistingSetupUnchanged({
  executeOptions,
  launchSentinelPath,
  managedRoot,
  pidPath,
  runtimeSentinelPath,
  setupPath,
  setupSentinelPath,
}) {
  writeFileSync(
    join(managedRoot, "existing-install-marker.txt"),
    "must remain unchanged\n",
    "utf8",
  );
  const before = treeDigest(managedRoot);
  rmSync(setupSentinelPath, { force: true });
  rmSync(launchSentinelPath, { force: true });
  rmSync(runtimeSentinelPath, { force: true });
  runExistingInstallRevalidation(setupPath, executeOptions, pidPath);
  const extractedRoot = resolve(readFileSync(setupSentinelPath, "utf8").trim());
  assert.notEqual(
    extractedRoot,
    resolve(managedRoot),
    "existing-install validation executed the previously installed runtime",
  );
  assert.equal(
    existsSync(extractedRoot),
    false,
    "setup did not remove its extracted validation root",
  );
  assert.equal(resolve(readFileSync(launchSentinelPath, "utf8").trim()), resolve(managedRoot));
  assert.equal(
    resolve(readFileSync(runtimeSentinelPath, "utf8").trim()),
    resolve(join(managedRoot, "runtime", "node", "node.exe")),
  );
  assert.equal(
    treeDigest(managedRoot),
    before,
    "setup replaced bytes in the existing managed root",
  );
}

// Case 3: a custom (Unicode/metacharacter) managed root must never leave a duplicate install at
// the default `%LOCALAPPDATA%\Programs\Keiko` location.
function assertCustomRootSetup(setupAssertion, localAppData) {
  assertFreshSetup(setupAssertion);
  assertExistingSetupUnchanged(setupAssertion);
  assert.equal(
    existsSync(join(localAppData, "Programs", "Keiko")),
    false,
    "setup duplicated a registered custom install into the default root",
  );
}

// Case 4: a launch that fails its health window must report the documented exit code (frozen
// SPEC v1 §3 point 10), print the failure wording, and leave no orphan process — running the REAL
// compiled EXE directly, never a cmd.exe bypass (the issue's third acceptance criterion).
function assertLaunchFailure(setupPath, executeOptions) {
  const failed = runResult(setupPath, ["/Q"], {
    ...executeOptions,
    env: { ...executeOptions.env, KEIKO_SETUP_SMOKE_EXIT_IMMEDIATELY: "1" },
    timeout: 90_000,
  });
  assert.equal(failed.status, 18, "launch failure must report the documented exit code");
  const output = commandOutput(failed);
  assert.equal(/Keiko setup failed\. See the message above/u.test(output), true);
  assert.equal(/Keiko setup finished successfully\./u.test(output), false);
  const pidPath = executeOptions.env.KEIKO_SETUP_SMOKE_PID;
  const pid = fixtureProcessId(pidPath);
  rmSync(pidPath, { force: true });
  assert.equal(processExists(pid), false, "failed setup process is still running");
}

function listTempInstallDirs(temporaryRoot) {
  return new Set(readdirSync(temporaryRoot).filter((name) => name.startsWith("Keiko-install-")));
}

function assertNoNewInstallStagingDirs(before, after, label) {
  const created = [...after].filter((name) => !before.has(name));
  assert.deepEqual(
    created,
    [],
    `${label} created unexpected staging dir(s): ${created.join(", ")}`,
  );
}

// Case 5, the regression pin for #2992: every argument below either mimics a WExtract/IExpress
// switch (`/C:`, `/T:`, `/D`) or near-misses the one accepted spelling (`/quiet`, `/Q`). The
// argument gate is an ALLOWLIST — `argc == 1` or every argument is (case-insensitively) `/quiet`
// or `/Q`, nothing else — so each of these must be rejected with exit 87 and zero side effects,
// verified against the REAL managed root established by cases 1-3.
function assertAdversarialArgumentsRejected(setupPath, localAppData, managedRoot, expectedDigest) {
  const temporaryRoot = tmpdir();
  const dir = mkdtempSync(join(temporaryRoot, "keiko-setup-smoke-adversarial-"));
  try {
    ADVERSARIAL_ARGUMENTS.forEach((argv, index) => {
      const label = `arguments [${argv.join(" ")}]`;
      const setupSentinelPath = join(dir, `setup-sentinel-${String(index)}.txt`);
      const executeOptions = setupEnvironment(
        localAppData,
        join(dir, `pid-${String(index)}.txt`),
        join(dir, `launch-sentinel-${String(index)}.txt`),
        join(dir, `runtime-sentinel-${String(index)}.txt`),
        setupSentinelPath,
        managedRoot,
      );
      const before = listTempInstallDirs(temporaryRoot);
      const attempt = runResult(setupPath, argv, { ...executeOptions, timeout: 45_000 });
      const after = listTempInstallDirs(temporaryRoot);
      assert.equal(attempt.status, 87, `${label} must be rejected with exit code 87`);
      assert.equal(existsSync(setupSentinelPath), false, `${label} reached the fixture CLI`);
      assertNoNewInstallStagingDirs(before, after, label);
    });
    assert.equal(
      treeDigest(managedRoot),
      expectedDigest,
      "an adversarial argument altered the managed root",
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// Cases 6 and 7 both fail during step 4 ("self-open + integrity", frozen SPEC v1 §3): the stub
// hashes its own embedded payload against the baked-in expected digest before staging anything.
// Neither a tampered byte nor a truncated overlay may reach extraction, so this asserts the same
// "nothing happened" shape for both, parameterized only by the accepted exit code(s).
function assertIntegrityFailure(setupPath, localAppData, expectedStatuses, label) {
  const dir = mkdtempSync(join(tmpdir(), "keiko-setup-smoke-integrity-"));
  try {
    const managedRoot = join(dir, "managed-root");
    const setupSentinelPath = join(dir, "setup-sentinel.txt");
    const executeOptions = setupEnvironment(
      localAppData,
      join(dir, "pid.txt"),
      join(dir, "launch-sentinel.txt"),
      join(dir, "runtime-sentinel.txt"),
      setupSentinelPath,
      managedRoot,
    );
    const temporaryRoot = tmpdir();
    const before = listTempInstallDirs(temporaryRoot);
    const attempt = runResult(setupPath, ["/Q"], { ...executeOptions, timeout: 45_000 });
    const after = listTempInstallDirs(temporaryRoot);
    assert.equal(
      expectedStatuses.includes(attempt.status),
      true,
      `${label} exited ${String(attempt.status)}, expected one of ${expectedStatuses.join("/")} (${commandResultSummary(attempt)})`,
    );
    assert.equal(existsSync(setupSentinelPath), false, `${label} reached the fixture CLI`);
    assert.equal(existsSync(managedRoot), false, `${label} created a managed root`);
    assertNoNewInstallStagingDirs(before, after, label);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function flipPayloadByte(sourcePath, destinationPath) {
  const bytes = readFileSync(sourcePath);
  const overlay = parseSetupOverlay(bytes);
  const tampered = Buffer.from(bytes);
  const targetOffset = overlay.payloadStart + Math.floor(overlay.payloadSize / 2);
  tampered[targetOffset] ^= 0xff;
  writeFileSync(destinationPath, tampered);
}

function truncateOverlayTail(sourcePath, destinationPath, cutBytes) {
  const bytes = readFileSync(sourcePath);
  writeFileSync(destinationPath, bytes.subarray(0, bytes.length - cutBytes));
}

async function buildSetupCompanion(root, archivePath, setupPath) {
  const stubPath = join(root, "keiko-setup-bootstrap-stub.exe");
  const payloadSha256Hex = await sha256File(archivePath);
  const payloadSizeBytes = statSync(archivePath).size;
  compileSetupBootstrap({ outputPath: stubPath, payloadSha256Hex, payloadSizeBytes });
  await appendSetupOverlay(stubPath, archivePath, setupPath);
}

// Cases 4-7: every negative path (launch failure, the adversarial argument matrix, a tampered
// payload, a truncated overlay) runs against the SAME managed root cases 1-3 already established,
// so "nothing happened" assertions have a real, populated install to prove they left untouched.
function runNegativePathCases(root, setupPath, executeOptions, localAppData, managedRoot) {
  assertLaunchFailure(setupPath, executeOptions); // case 4
  assertAdversarialArgumentsRejected(setupPath, localAppData, managedRoot, treeDigest(managedRoot)); // case 5

  const tamperedPath = join(root, "keiko-windows-x64-setup-tampered.exe");
  flipPayloadByte(setupPath, tamperedPath);
  assertIntegrityFailure(tamperedPath, localAppData, [12], "tampered payload"); // case 6

  const truncatedPath = join(root, "keiko-windows-x64-setup-truncated.exe");
  truncateOverlayTail(setupPath, truncatedPath, 10);
  assertIntegrityFailure(truncatedPath, localAppData, [11, 12], "truncated overlay"); // case 7
}

async function runWindowsSetupBootstrapSmoke() {
  const root = mkdtempSync(join(tmpdir(), "keiko-setup-bootstrap-"));
  const inputRoot = join(root, "input");
  const localAppData = join(root, "local-app-data");
  const managedRoot = join(localAppData, "Kéiko Üñîçødé & % ! ^ (Programs)", "Keiko");
  const setupPath = join(root, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
  const archivePath = join(inputRoot, "keiko-windows-x64.zip");
  const launchSentinelPath = join(root, "launch-root.txt");
  const setupSentinelPath = join(root, "setup-root.txt");
  const runtimeSentinelPath = join(root, "runtime-root.txt");
  const pidPath = join(root, "runtime.pid");
  let failure;
  try {
    mkdirSync(inputRoot, { recursive: true });
    writePortableFixture(root, archivePath);
    await buildSetupCompanion(root, archivePath, setupPath);

    const executeOptions = setupEnvironment(
      localAppData,
      pidPath,
      launchSentinelPath,
      runtimeSentinelPath,
      setupSentinelPath,
      managedRoot,
    );
    const setupAssertion = {
      executeOptions,
      launchSentinelPath,
      managedRoot,
      pidPath,
      runtimeSentinelPath,
      setupPath,
      setupSentinelPath,
    };
    assertCustomRootSetup(setupAssertion, localAppData); // cases 1, 2, 3
    runNegativePathCases(root, setupPath, executeOptions, localAppData, managedRoot);
  } catch (error) {
    failure = error;
  } finally {
    failure = cleanupSmoke(root, pidPath, failure);
  }
  if (failure !== undefined) throw failure;
}

assert.equal(process.platform, "win32", "this smoke must run on a Windows host");
await runWindowsSetupBootstrapSmoke();
console.log("windows-setup-bootstrap-smoke: PASS");
