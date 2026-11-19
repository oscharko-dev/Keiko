#!/usr/bin/env node
// Qualifies an npm folder package by starting it the way a person does, on the platform it is for.
//
// The npm folder package (ADR-0121 D9, docs/release/standalone-npm-package.md) is built from a
// published portable release archive, so this script fetches that archive and its checksum file
// from the public GitHub release, builds the package with the repository's one builder, extracts
// the ZIP with the platform's own tool into a folder whose path holds a space, and runs the real
// start and stop files. It proves installation, start, health, the Coding runtime package and stop.
// It uses no model, no gateway and no browser.
//
// One target per run, and the target must equal the host: a package is only qualified by starting
// it on its own platform. Output is body-free: one PASS/FAIL line per check and an evidence file of
// counts, digests, durations and closed values. Everything the run created is removed, also on
// failure; only the ZIP, its checksum and the evidence file stay in --out-dir.

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch, homedir, platform, release, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";

import { StandaloneBuildError, expectedArchiveSha256 } from "../build-standalone-package.mjs";
import { buildNpmPackage } from "../build-standalone-npm-package.mjs";
import { sha256, sha256File, sha256FileChunked } from "../lib/digest.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { readJsonFile } from "../lib/json.mjs";
import {
  CHECK_NAMES,
  DEFAULT_REPOSITORY,
  EVIDENCE_KIND,
  EVIDENCE_SCHEMA_VERSION,
} from "../lib/npm-folder-qualification.mjs";
import {
  platformRuntimePackageName,
  platformRuntimePackages,
} from "../release-workspace-policy.mjs";

const PACKAGE_NAME = "@oscharko-dev/keiko";
const INSTALLED_MARKER = ".keiko-npm-installed";
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const START_TIMEOUT_MS = 15 * 60 * 1000;
const STOP_TIMEOUT_MS = 2 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 90 * 1000;
const FOLDER_NAME_WITH_SPACE = "Keiko npm folder";

/** The host platforms an npm folder package exists for (ADR-0183), by closed target name. */
const HOST_TARGETS = Object.freeze({
  "darwin/arm64": "macos-arm64",
  "darwin/x64": "macos-x64",
  "win32/x64": "windows-x64",
});

const USAGE = `Usage:
  node scripts/testing/qualify-npm-folder-package.mjs --target TARGET --out-dir DIR
       [--version X.Y.Z] [--evidence PATH] [--repository OWNER/NAME]

  --target      ${Object.values(HOST_TARGETS).join(" | ")}; must equal this host
  --out-dir     keeps keiko-<target>.npm.zip, its .sha256 and the evidence file
  --version     the Keiko version to qualify (default: the root package version); its portable
                release must be published, and npm must report the version
  --evidence    the evidence file (default: <out-dir>/keiko-<target>.npm.evidence.json)
  --repository  the GitHub repository whose public release is read (default ${DEFAULT_REPOSITORY})
`;

export class QualificationRefusal extends Error {}

function refuse(message) {
  throw new QualificationRefusal(message);
}

/** The target name of a host platform and architecture, or undefined for an unsupported host. */
export function hostTarget(hostPlatform = platform(), hostArch = arch()) {
  return HOST_TARGETS[`${hostPlatform}/${hostArch}`];
}

/** Refuses a target that is not the host: a package is qualified only on its own platform. */
export function assertTargetIsHost(target, host) {
  if (!Object.values(HOST_TARGETS).includes(target)) {
    refuse(`unsupported target ${String(target)}: use ${Object.values(HOST_TARGETS).join(", ")}`);
  }
  if (host === undefined) refuse("this host has no npm folder package target");
  if (target !== host) {
    refuse(`target ${target} is not this host (${host}); start a package only on its own platform`);
  }
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** Parses the command line; anything unknown or malformed is refused. */
export function parseQualifyArgs(argv, rootVersion) {
  const flags = {
    "--target": "target",
    "--out-dir": "outDir",
    "--version": "version",
    "--evidence": "evidence",
    "--repository": "repository",
  };
  const options = { version: rootVersion, repository: DEFAULT_REPOSITORY };
  for (let index = 0; index < argv.length; index += 2) {
    const name = flags[argv[index]];
    const value = argv[index + 1];
    if (name === undefined) refuse(`unknown argument ${String(argv[index])}`);
    if (value === undefined || value.startsWith("--")) refuse(`${argv[index]} needs a value`);
    options[name] = value;
  }
  if (options.target === undefined) refuse("--target is required");
  if (options.outDir === undefined) refuse("--out-dir is required");
  if (!VERSION_PATTERN.test(String(options.version))) refuse("--version must be x.y.z");
  if (!REPOSITORY_PATTERN.test(options.repository)) refuse("--repository must be owner/name");
  return options;
}

/** The public release URLs of one target's portable archive and its checksum file. */
export function releaseAssetUrls({ repository, version, target }) {
  const base = `https://github.com/${repository}/releases/download/v${version}`;
  return {
    archive: `${base}/keiko-${target}.zip`,
    checksums: `${base}/${target}-SHA256SUMS.txt`,
  };
}

/**
 * The Coding runtime package a target's installation must carry, derived from the release's own
 * declaration: the target's entry in platformRuntimePackages names the package, and the installed
 * Keiko manifest says whether the release declares it. `undefined` where it declares none.
 */
export function expectedRuntimePackage(target, keikoManifest) {
  if (platformRuntimePackages[target] === undefined) refuse(`no runtime entry for ${target}`);
  const name = platformRuntimePackageName(target);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const range = keikoManifest?.[field]?.[name];
    if (typeof range === "string" && range.length > 0) return { name, range };
  }
  return undefined;
}

/** True when a log line (a JSON object per line) carries the given operation and fields. */
export function logHasLine(logText, op, fields = {}) {
  return logText.split(/\r?\n/u).some((line) => {
    if (!line.includes(`"${op}"`)) return false;
    try {
      const entry = JSON.parse(line);
      const flat = { ...entry, ...(entry.extra ?? {}), ...(entry.fields ?? {}) };
      return flat.op === op && Object.entries(fields).every(([key, value]) => flat[key] === value);
    } catch {
      return false;
    }
  });
}

/** Names the files of a folder (relative, forward slashes) with their digests, except node_modules. */
export function snapshotOutsideNodeModules(root) {
  const entries = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const name = relative(root, path).split(sep).join("/");
    if (name === "node_modules" || name.startsWith("node_modules/")) continue;
    entries.set(name, entry.isFile() ? sha256File(path) : "directory");
  }
  return entries;
}

/** What a package folder gained or changed outside node_modules; the install lock is documented. */
export function folderDrift(before, after) {
  const documented = (name) =>
    name === "system/keiko-npm-install.lock" || name.startsWith("system/keiko-npm-install.lock/");
  const drift = [];
  for (const [name, digest] of before) {
    if (after.get(name) !== digest) drift.push(`changed or removed: ${name}`);
  }
  for (const name of after.keys()) {
    if (!before.has(name) && !documented(name)) drift.push(`added: ${name}`);
  }
  return drift;
}

/** The body-free evidence of one run: closed values, counts, digests and durations only. */
export function buildEvidence(input) {
  const { target, version, archiveSha256, zipSha256, results, runner } = input;
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: EVIDENCE_KIND,
    target,
    version,
    archiveSha256: archiveSha256 ?? null,
    zipSha256: zipSha256 ?? null,
    runner,
    // Every named check must have run and passed: a run that stopped at a failed check never passes.
    passed:
      results.every((result) => result.ok) &&
      CHECK_NAMES.every((name) => results.some((result) => result.name === name && result.ok)),
    checks: results.map(({ name, ok, durationMs, detail }) => ({
      name,
      result: ok ? "pass" : "fail",
      durationMs,
      ...(detail === undefined ? {} : { detail }),
    })),
  };
}

function runnerIdentity() {
  return { os: platform(), arch: arch(), osRelease: release() };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (typeof address !== "object" || address === null) refuse("no free loopback port");
  return address.port;
}

/** Downloads a URL into a file, bounded in bytes and in time; a stalled server is refused. */
export async function download(
  url,
  destination,
  { timeoutMs = DOWNLOAD_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {},
) {
  const signal = globalThis.AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: "follow", credentials: "omit", signal });
    await writeBounded(downloadBody(response, url), destination, url);
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
      refuse(`${url} did not finish within ${Math.round(timeoutMs / 1000)} s`);
    }
    throw error;
  }
}

// The body of an answer that may be downloaded: a success whose declared size is within the bound.
function downloadBody(response, url) {
  if (!response.ok || response.body === null) refuse(`${url} answered ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_DOWNLOAD_BYTES) refuse(`${url} is larger than ${MAX_DOWNLOAD_BYTES} bytes`);
  return response.body;
}

async function writeBounded(body, destination, url) {
  const fd = openSync(destination, "w", 0o600);
  let written = 0;
  try {
    for await (const chunk of body) {
      written += chunk.length;
      if (written > MAX_DOWNLOAD_BYTES) refuse(`${url} exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
      writeFileSync(fd, chunk);
    }
  } finally {
    closeSync(fd);
  }
}

function startFile(folder, os) {
  return join(folder, os === "win32" ? "Start Keiko.cmd" : "Start Keiko.command");
}

function stopFile(folder, os) {
  return join(folder, os === "win32" ? "Stop Keiko.cmd" : "Stop Keiko.command");
}

// A person double-clicks the file; the shell (sh, cmd) runs it. cmd is given the quoted path
// verbatim, as Explorer does, so a space in the path cannot split it.
function shellInvocation(file, os) {
  return os === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", `"${file}"`], verbatim: true }
    : { command: "sh", args: [file], verbatim: false };
}

/** Runs a start or stop file with output to files: the Keiko it opens must not hold a pipe open. */
export function runWrapper(file, { env, cwd, logPath, timeoutMs, os = platform() }) {
  const { command, args, verbatim } = shellInvocation(file, os);
  const fd = openSync(logPath, "w", 0o600);
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", fd, fd],
      windowsVerbatimArguments: verbatim,
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const done = (status) => {
      clearTimeout(timer);
      closeSync(fd);
      resolveRun({ status, output: readFileSync(logPath, "utf8") });
    };
    child.once("error", () => done(null));
    child.once("exit", (code) => done(code));
  });
}

// Windows extracts with the tar.exe the operating system ships in System32 (bsdtar reads ZIP).
// Windows PowerShell's Expand-Archive is not used: started from a pwsh step it inherits pwsh's
// module path and left the hosted runner's folder without its start file (#4068).
function windowsTar() {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

function extractZip(zipPath, destination, os) {
  mkdirSync(destination, { recursive: true });
  const result =
    os === "win32"
      ? spawnSync(windowsTar(), ["-x", "-f", zipPath, "-C", destination], { encoding: "utf8" })
      : spawnSync("ditto", ["-x", "-k", zipPath, destination], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.error?.message ?? "")
      .trim()
      .slice(-400);
    refuse(`the platform extraction tool failed (${String(result.status)}): ${detail}`);
  }
}

function folderEntries(folder) {
  try {
    return readdirSync(folder).sort().join(", ");
  } catch {
    return "missing";
  }
}

/**
 * The PowerShell command that lists the process ids naming the folder in `$env:KEIKO_QUALIFY_FOLDER`.
 * `-like` reads `[` and `]` as wildcards, so the path is escaped first: a folder named `a[1]` must
 * match itself and nothing else.
 */
export function windowsProcessListCommand() {
  return [
    "$folder = [WildcardPattern]::Escape($env:KEIKO_QUALIFY_FOLDER);",
    "Get-CimInstance Win32_Process | Where-Object {",
    "$_.CommandLine -like ('*' + $folder + '*') -or $_.ExecutablePath -like ($folder + '*')",
    "} | ForEach-Object { $_.ProcessId }",
  ].join(" ");
}

/** Process ids whose command line names the folder; macOS reads ps, Windows reads CIM. */
export function processesOf(folder, os = platform()) {
  const result =
    os === "win32"
      ? spawnSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", windowsProcessListCommand()],
          { env: { ...process.env, KEIKO_QUALIFY_FOLDER: folder }, encoding: "utf8" },
        )
      : spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 });
  if (result.status !== 0) refuse("the process list could not be read");
  const lines = String(result.stdout)
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "");
  const own = new Set([process.pid, process.ppid]);
  const pids = (os === "win32" ? lines : lines.filter((line) => line.includes(folder))).map(
    (line) => Number.parseInt(line.trim(), 10),
  );
  return pids.filter((pid) => Number.isInteger(pid) && !own.has(pid));
}

async function healthVersion(port) {
  try {
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: globalThis.AbortSignal.timeout(5000),
    });
    const body = await response.json();
    return { reachable: true, status: body?.status, version: body?.version };
  } catch {
    return { reachable: false };
  }
}

async function waitFor(condition, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (performance.now() > deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
}

/** Runs named checks in order; a failed check ends the run (later ones need its result). */
class Checks {
  constructor(print = (line) => console.log(line)) {
    this.results = [];
    this.print = print;
    this.failed = false;
  }

  async run(name, body) {
    if (this.failed) return;
    const started = performance.now();
    let ok = false;
    let detail;
    try {
      detail = await body();
      ok = true;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    const durationMs = Math.round(performance.now() - started);
    this.results.push({ name, ok, durationMs, ...(ok ? {} : { detail }) });
    this.failed = !ok;
    this.print(`${ok ? "PASS" : "FAIL"} ${name} (${durationMs} ms)${ok ? "" : `: ${detail}`}`);
  }
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

/** Everything one run creates, so one cleanup can remove it. */
async function qualify(options, session) {
  const { target, version, repository, outDir } = options;
  const os = platform();
  const checks = session.checks;
  const urls = releaseAssetUrls({ repository, version, target });
  const archive = join(session.work, `keiko-${target}.zip`);
  const sums = join(session.work, `${target}-SHA256SUMS.txt`);
  await checks.run("archive-checksum", async () => {
    await download(urls.checksums, sums);
    await download(urls.archive, archive);
    session.archiveSha256 = sha256FileChunked(archive);
    ensure(
      session.archiveSha256 === expectedArchiveSha256({ sha256sums: sums }, archive),
      "digest",
    );
  });
  await checks.run("package-build", () => {
    const built = buildNpmPackage({ target, archive, sha256sums: sums, outDir });
    ensure(built.packageVersion === version, `built Keiko ${built.packageVersion}`);
    session.zip = built.outputPath;
    session.zipSha256 = built.outputSha256;
    ensure(sha256FileChunked(session.zip) === session.zipSha256, "zip digest differs");
  });
  await checks.run("extract-with-platform-tool", () => {
    extractZip(session.zip, session.parent, os);
    session.folder = join(session.parent, "Keiko");
    const start = startFile(session.folder, os);
    ensure(
      existsSync(start) && statSync(start).isFile(),
      `no start file; extracted: ${folderEntries(session.parent)}; package: ${folderEntries(session.folder)}`,
    );
    session.before = snapshotOutsideNodeModules(session.folder);
  });
  if (!checks.failed) await startStopChecks(session, options, os);
}

async function startStopChecks(session, options, os) {
  const { checks, folder } = session;
  const { target, version } = options;
  const wrapper = (file, name, timeoutMs) =>
    runWrapper(file, {
      env: session.env,
      cwd: homedir(),
      logPath: join(session.work, name),
      timeoutMs,
      os,
    });
  await checks.run("first-start-installs", async () => {
    const first = await wrapper(startFile(folder, os), "start-1.log", START_TIMEOUT_MS);
    session.firstOutput = first.output;
    ensure(first.status === 0, `exit ${String(first.status)}`);
  });
  await checks.run("health-reports-version", async () => {
    const health = await waitFor(async () => {
      const seen = await healthVersion(session.port);
      return seen.reachable ? seen : false;
    }, HEALTH_TIMEOUT_MS);
    ensure(health !== false, "health did not answer");
    ensure(health.status === "ok", `status ${String(health.status)}`);
    ensure(health.version === version, `version ${String(health.version)}`);
  });
  await checks.run("installation-record-matches-lockfile", () => {
    const record = readFileSync(join(folder, "node_modules", INSTALLED_MARKER), "utf8").trim();
    const shipped = sha256File(join(folder, "package-lock.json"));
    const declared = readJsonFile(join(folder, "system", "npm-package.json")).lockfileSha256;
    ensure(record === shipped && shipped === declared, "record, lockfile and manifest differ");
  });
  await checks.run("coding-runtime-package", () => codingRuntimeCheck(session, target));
  await checks.run("second-start-reports-running", async () => {
    const second = await wrapper(startFile(folder, os), "start-2.log", START_TIMEOUT_MS);
    ensure(second.status === 0, `exit ${String(second.status)}`);
    ensure(/already running/iu.test(second.output), "no 'already running' report");
    ensure(!/loaded from the npm registry/iu.test(second.output), "it installed again");
  });
  await checks.run("folder-unchanged-outside-node-modules", () => {
    const drift = folderDrift(session.before, snapshotOutsideNodeModules(folder));
    ensure(drift.length === 0, `${drift.length} entries drifted: ${drift.slice(0, 3).join("; ")}`);
  });
  await stopChecks(session, wrapper, os);
}

function codingRuntimeCheck(session, target) {
  const keiko = join(session.folder, "node_modules", ...PACKAGE_NAME.split("/"));
  const expected = expectedRuntimePackage(target, readJsonFile(join(keiko, "package.json")));
  session.expectedRuntime = expected;
  if (expected === undefined) return "none declared for this target";
  const installed = join(session.folder, "node_modules", ...expected.name.split("/"));
  const manifest = readJsonFile(join(installed, "package.json"));
  ensure(typeof manifest.version === "string", `${expected.name} is not installed`);
  return `${expected.name} installed`;
}

async function stopChecks(session, wrapper, os) {
  const { checks, folder } = session;
  await checks.run("stop-exits-clean", async () => {
    const stop = await wrapper(stopFile(folder, os), "stop.log", STOP_TIMEOUT_MS);
    ensure(stop.status === 0, `exit ${String(stop.status)}`);
  });
  await checks.run("no-process-left", async () => {
    const gone = await waitFor(async () => !(await healthVersion(session.port)).reachable, 30_000);
    ensure(gone, "health still answers after stop");
    const clear = await waitFor(() => processesOf(folder, os).length === 0, 30_000);
    ensure(clear, `${processesOf(folder, os).length} process(es) of the folder remain`);
  });
  await checks.run("activity-log-lifecycle", () => activityLogCheck(session));
}

// The lifecycle lines a start and a stop of a real installation write on the Activity Log.
const LIFECYCLE_OPERATIONS = Object.freeze([
  "process.started",
  "cli.lifecycle.stop-requested",
  "server.runtime.shutdown",
  "process.exiting",
]);

async function activityLogCheck(session) {
  // Loaded here: the reader needs the built workspace packages, the pure parts of this module do not.
  const { activityLogDirectory, readActivityLogText } =
    await import("../lib/activity-log-files.mjs");
  const text = readActivityLogText(activityLogDirectory(session.state));
  ensure(text.length > 0, "the Activity Log is empty");
  const absent = LIFECYCLE_OPERATIONS.filter((op) => !logHasLine(text, op));
  ensure(absent.length === 0, `no lifecycle line for ${absent.join(", ")}`);
  const unqualified = RUNTIME_PACKAGE_MISSING_REASONS.some((reason) =>
    logHasLine(text, "coding-runtime.install.unqualified", { reason }),
  );
  if (session.expectedRuntime === undefined) {
    ensure(unqualified, "no runtime-package-missing line for a target without a runtime");
  } else {
    ensure(!unqualified, "the installed Coding runtime package was reported missing");
  }
}

// How an installation without the Coding runtime package for its computer names that on the
// Activity Log. A folder package declares itself managed outside the app, so a Keiko that knows
// the distinction records the managed reason; an earlier one records the npm reason for it. The
// qualification runs against every published version, so either one is the same finding.
const RUNTIME_PACKAGE_MISSING_REASONS = Object.freeze([
  "npm-runtime-package-missing",
  "managed-runtime-package-missing",
]);

function emergencyStop(session, os) {
  if (session.folder === undefined) return;
  try {
    spawnSync(
      os === "win32" ? "cmd.exe" : "sh",
      shellInvocation(stopFile(session.folder, os), os).args,
      {
        env: session.env,
        cwd: homedir(),
        timeout: STOP_TIMEOUT_MS,
        windowsVerbatimArguments: os === "win32",
        stdio: "ignore",
      },
    );
    for (const pid of processesOf(session.folder, os)) process.kill(pid, "SIGKILL");
  } catch {
    // Cleanup reports through the run's own result; a process that is already gone is the goal.
  }
}

/**
 * Removes what the run created. A path that cannot be removed (Windows holds a file a little after
 * its process ends) never hides the evidence or stops the others: it is counted and named by its
 * closed word, never by its path. Returns the words of the paths that remain.
 */
export function cleanup(session, os, { remove = rmSync, warn = console.warn } = {}) {
  emergencyStop(session, os);
  const remaining = [];
  for (const [word, path] of [
    ["root", session.root],
    ["work", session.work],
    ["state", session.state],
  ]) {
    if (path === undefined) continue;
    try {
      remove(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      remaining.push(word);
    }
  }
  if (remaining.length > 0) {
    warn(`WARN cleanup left ${remaining.length} path(s) behind: ${remaining.join(", ")}`);
  }
  return remaining;
}

/** Runs the qualification and returns the evidence; creates and removes its own folders. */
export async function runQualification(options) {
  assertTargetIsHost(options.target, hostTarget());
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const os = platform();
  const token = sha256(`${process.pid}-${performance.now()}`).slice(0, 12);
  // The long, canonical spelling: a Windows temp folder is reported in its 8.3 short form, which a
  // process listing would not match.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "keiko-npm-qualify-")));
  const session = {
    checks: new Checks(),
    work: mkdtempSync(join(tmpdir(), "keiko-npm-qualify-")),
    root,
    parent: join(root, FOLDER_NAME_WITH_SPACE),
    state: join(homedir(), `.keiko-qualify-${token}`),
    port: await freePort(),
  };
  session.env = {
    ...process.env,
    KEIKO_STATE_DIR: session.state,
    KEIKO_UI_PORT: String(session.port),
    KEIKO_UI_OPEN_BROWSER: "0",
    KEIKO_OS_KEYCHAIN: "off",
  };
  try {
    await qualify({ ...options, outDir }, session);
  } catch (error) {
    session.checks.results.push({ name: "run", ok: false, durationMs: 0, detail: String(error) });
    session.checks.print(`FAIL run: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (session.firstOutput !== undefined && session.checks.results.some((r) => !r.ok)) {
      console.log(`--- last output of the first start (tail) ---\n${tail(session.firstOutput)}`);
    }
    cleanup(session, os);
  }
  return buildEvidence({
    target: options.target,
    version: options.version,
    archiveSha256: session.archiveSha256,
    zipSha256: session.zipSha256,
    results: session.checks.results,
    runner: runnerIdentity(),
  });
}

function tail(text = "") {
  return text.split(/\r?\n/u).slice(-25).join("\n");
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const rootVersion = readJsonFile(
      resolve(import.meta.dirname, "..", "..", "package.json"),
    ).version;
    const options = parseQualifyArgs(argv, rootVersion);
    const evidence = await runQualification(options);
    const path = resolve(
      options.evidence ?? join(options.outDir, `keiko-${options.target}.npm.evidence.json`),
    );
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(
      `${evidence.passed ? "PASS" : "FAIL"} npm folder package ${options.target} ${options.version}`,
    );
    return evidence.passed ? 0 : 1;
  } catch (error) {
    if (!(error instanceof QualificationRefusal || error instanceof StandaloneBuildError))
      throw error;
    console.error(`FAIL qualify-npm-folder-package: ${error.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
