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

import {
  iexpressPath,
  windowsSetupInstallerScript,
  windowsSetupSed,
} from "../build-windows-portable-setup.mjs";
import { WINDOWS_PORTABLE_SETUP_ASSET_NAME } from "../portable-runtime.mjs";
import { windowsLauncher } from "../../packages/keiko-cli/src/launcher-platforms.ts";

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
    'const managedRoot = resolve(process.env.KEIKO_IEXPRESS_MANAGED_ROOT || join(process.env.LOCALAPPDATA, "Programs", "Keiko"));',
    'if (command === "resolve-root") { console.log(managedRoot); process.exit(0); }',
    'if (command === "setup") {',
    "  mkdirSync(dirname(managedRoot), { recursive: true });",
    "  if (!existsSync(managedRoot)) cpSync(portableRoot, managedRoot, { recursive: true });",
    '  writeFileSync(process.env.KEIKO_IEXPRESS_SETUP_SENTINEL, `${portableRoot}\\n`, "utf8");',
    "  process.exit(0);",
    "}",
    'if (command !== "launch" || !existsSync(managedRoot)) process.exit(3);',
    'writeFileSync(process.env.KEIKO_IEXPRESS_LAUNCH_SENTINEL, `${portableRoot}\\n`, "utf8");',
    'writeFileSync(process.env.KEIKO_IEXPRESS_RUNTIME_SENTINEL, `${process.execPath}\\n`, "utf8");',
    'const nodePath = join(managedRoot, "runtime", "node", "node.exe");',
    'const childScript = process.env.KEIKO_IEXPRESS_EXIT_IMMEDIATELY === "1" ? "process.exit(0)" : "const { writeFileSync } = require(\\"node:fs\\"); setTimeout(() => writeFileSync(process.env.KEIKO_IEXPRESS_HEALTHY, \\"healthy\\\\n\\"), 6000); setTimeout(() => process.exit(0), 14000)";',
    'const child = spawn(nodePath, ["-e", childScript], { detached: true, stdio: "ignore" });',
    "child.unref();",
    'writeFileSync(process.env.KEIKO_IEXPRESS_PID, `${child.pid}\\n`, "utf8");',
    "const deadline = Date.now() + 10000;",
    "const waitSignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));",
    "while (Date.now() < deadline) {",
    "  if (existsSync(process.env.KEIKO_IEXPRESS_HEALTHY)) process.exit(0);",
    "  try { process.kill(child.pid, 0); } catch { process.exit(1); }",
    "  Atomics.wait(waitSignal, 0, 0, 100);",
    "}",
    "process.exit(1);",
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
  run(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "Compress-Archive -LiteralPath $env:KEIKO_FIXTURE_ROOT -DestinationPath $env:KEIKO_FIXTURE_ARCHIVE -Force",
    ],
    {
      env: {
        ...process.env,
        KEIKO_FIXTURE_ARCHIVE: archivePath,
        KEIKO_FIXTURE_ROOT: portableRoot,
      },
    },
  );
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
  healthyPath,
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
      KEIKO_IEXPRESS_HEALTHY: healthyPath,
      KEIKO_IEXPRESS_LAUNCH_SENTINEL: launchSentinelPath,
      KEIKO_IEXPRESS_PID: pidPath,
      KEIKO_IEXPRESS_RUNTIME_SENTINEL: runtimeSentinelPath,
      KEIKO_IEXPRESS_SETUP_SENTINEL: setupSentinelPath,
      KEIKO_IEXPRESS_MANAGED_ROOT: managedRoot,
      LOCALAPPDATA: localAppData,
    },
  };
}

function assertLaunchFailure(installerRoot, executeOptions) {
  const failed = runResult("cmd.exe", ["/d", "/s", "/c", "install-keiko.cmd"], {
    ...executeOptions,
    cwd: installerRoot,
    env: { ...executeOptions.env, KEIKO_IEXPRESS_EXIT_IMMEDIATELY: "1" },
    timeout: 90_000,
  });
  assert.notEqual(failed.status, 0, "setup accepted a lifecycle launch that failed before health");
  const output = commandOutput(failed);
  assert.equal(/Keiko setup failed\. See the message above/u.test(output), true);
  assert.equal(/Keiko setup finished successfully\./u.test(output), false);
  const pidPath = executeOptions.env.KEIKO_IEXPRESS_PID;
  const pid = fixtureProcessId(pidPath);
  rmSync(pidPath, { force: true });
  assert.equal(processExists(pid), false, "failed setup process is still running");
}

function runHealthySetup(setupPath, executeOptions, healthyPath, pidPath) {
  run(setupPath, ["/Q"], { ...executeOptions, timeout: 90_000 });
  assert.equal(existsSync(healthyPath), true, "setup process did not survive its health window");
  waitForFixtureProcessExit(pidPath);
}

function assertFreshSetup({
  executeOptions,
  healthyPath,
  launchSentinelPath,
  managedRoot,
  pidPath,
  runtimeSentinelPath,
  setupPath,
  setupSentinelPath,
}) {
  runHealthySetup(setupPath, executeOptions, healthyPath, pidPath);
  assert.equal(existsSync(managedRoot), true, "setup did not create the managed root");
  assert.equal(existsSync(setupSentinelPath), true, "generated installer did not invoke setup");
  assert.equal(existsSync(launchSentinelPath), true, "generated installer did not invoke launch");
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
  healthyPath,
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
  rmSync(healthyPath, { force: true });
  rmSync(setupSentinelPath, { force: true });
  rmSync(launchSentinelPath, { force: true });
  rmSync(runtimeSentinelPath, { force: true });
  runHealthySetup(setupPath, executeOptions, healthyPath, pidPath);
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

function assertCustomRootSetup(setupAssertion, localAppData) {
  assertFreshSetup(setupAssertion);
  assertExistingSetupUnchanged(setupAssertion);
  assert.equal(
    existsSync(join(localAppData, "Programs", "Keiko")),
    false,
    "setup duplicated a registered custom install into the default root",
  );
}

function runWindowsIExpressCommandSmoke() {
  const root = mkdtempSync(join(tmpdir(), "keiko-iexpress-command-"));
  const inputRoot = join(root, "input");
  const localAppData = join(root, "local-app-data");
  const managedRoot = join(localAppData, "Kéiko Üñîçødé & % ! ^ (Programs)", "Keiko");
  const setupPath = join(root, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
  const archivePath = join(inputRoot, "keiko-windows-x64.zip");
  const sedPath = join(root, "setup.sed");
  const healthyPath = join(root, "healthy.txt");
  const launchSentinelPath = join(root, "launch-root.txt");
  const setupSentinelPath = join(root, "setup-root.txt");
  const runtimeSentinelPath = join(root, "runtime-root.txt");
  const pidPath = join(root, "runtime.pid");
  let failure;
  try {
    mkdirSync(inputRoot, { recursive: true });
    writePortableFixture(root, archivePath);
    writeFileSync(join(inputRoot, "install-keiko.cmd"), windowsSetupInstallerScript(), "utf8");
    writeFileSync(sedPath, windowsSetupSed({ inputRoot, outputPath: setupPath }));
    run(iexpressPath(), ["/N", "/Q", sedPath], { timeout: 120_000 });

    const executeOptions = setupEnvironment(
      healthyPath,
      localAppData,
      pidPath,
      launchSentinelPath,
      runtimeSentinelPath,
      setupSentinelPath,
      managedRoot,
    );
    const setupAssertion = {
      executeOptions,
      healthyPath,
      launchSentinelPath,
      managedRoot,
      pidPath,
      runtimeSentinelPath,
      setupPath,
      setupSentinelPath,
    };
    assertCustomRootSetup(setupAssertion, localAppData);
    rmSync(healthyPath, { force: true });
    assertLaunchFailure(inputRoot, executeOptions);
    assert.equal(existsSync(healthyPath), false, "failed setup reported a healthy launch");
  } catch (error) {
    failure = error;
  } finally {
    failure = cleanupSmoke(root, pidPath, failure);
  }
  if (failure !== undefined) throw failure;
}

assert.equal(process.platform, "win32", "this smoke must run on a Windows host");
runWindowsIExpressCommandSmoke();
console.log("windows-iexpress-command-smoke: PASS");
