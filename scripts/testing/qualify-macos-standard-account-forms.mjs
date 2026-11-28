#!/usr/bin/env node
// Qualifies the three macOS delivery forms of a published Keiko as a standard account (#4520).
//
// Epic #4491 promises that a person without administrator rights gets Keiko onto a Mac and starts
// it in each of three forms: the npm package (with a Node.js that person unpacked in their own
// folder), the npm folder package and the standalone folder package. The portable `Keiko.app` is
// not one of them: its setup copies it to /Applications and macOS asks an administrator to allow
// it. For each form, from an empty state, this script does what that person does: install, first
// start, health with the version, one coding run that settles succeeded, a second start that
// reports the running instance, stop, no process left. It records the download mark of each form
// and what a copy of the standalone archive does that carries the mark a browser sets.
//
// It runs as the account under proof and certifies nothing when that account is an administrator
// or may use sudo. The model is the customer-shape LiteLLM twin on loopback. The release assets
// are read from the public GitHub release, the packages from the public npm registry, Node.js from
// nodejs.org. The account has no login session, so the login keychain is not used
// (KEIKO_OS_KEYCHAIN=off). What the account created or changed outside its home is checked by
// standard-account-footprint.mjs, as root. Output is body-free: one PASS/FAIL line per check and
// an evidence file of closed values, counts, digests and durations.

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { arch, homedir, platform, release, userInfo } from "node:os";
import { join, resolve } from "node:path";

import { expectedArchiveSha256 } from "../build-standalone-package.mjs";
import { buildNpmPackage } from "../build-standalone-npm-package.mjs";
import {
  CUSTOMER_SHAPE_API_KEY,
  CUSTOMER_SHAPE_MODEL,
  startCustomerShapeLiteLlmTwin,
  writeCustomerShapeGatewayConfig,
} from "../lib/customer-shape-litellm-twin.mjs";
import { sha256FileChunked } from "../lib/digest.mjs";
import { readFlagPairs } from "../lib/flag-pairs.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { DEFAULT_REPOSITORY } from "../lib/npm-folder-qualification.mjs";
import {
  MODES,
  openApiSession,
  selectLabCheckout,
  stopUnfinishedRun,
} from "./coding-workbench-lab/lab-common.mjs";
import { startRun, watchRun } from "./coding-workbench-lab/wb-run.mjs";
import {
  Checks,
  download,
  ensure,
  extractZip,
  freePort,
  healthVersion,
  hostTarget,
  processesOf,
  releaseAssetUrls,
  runLogged,
  startFile,
  stopFile,
  waitFor,
} from "./qualify-npm-folder-package.mjs";

const EVIDENCE_KIND = "keiko-macos-standard-account-forms";
const EVIDENCE_SCHEMA_VERSION = 1;
export const FORMS = Object.freeze(["npm", "npm-folder", "standalone"]);
export const MARKED_OUTCOMES = Object.freeze([
  "start-refused",
  "started-coding-run-failed",
  "started-coding-run-succeeded",
]);

/** The folder of the account's home a person unpacks Node.js into, as the guides name it. */
export const NODE_FOLDER = ".local/nodejs";

/**
 * The commands README.md gives a person without administrator rights to get a supported Node.js
 * and the npm package, line by line as printed there (a test pins the two together). The script
 * runs exactly these lines, with the version, the architecture and the pinned package version of
 * the run put in.
 */
export const NODE_USER_INSTALL_LINES = Object.freeze([
  'cd "$HOME/Downloads"',
  "NODE_VERSION=26.13.1",
  "NODE_ARCH=arm64",
  'curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"',
  // Everything after the checksum check is one list joined by `&&`: a mismatch stops it before
  // anything is unpacked or run.
  'curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz" | shasum -a 256 -c - &&',
  '  mkdir -p "$HOME/.local/nodejs" &&',
  '  tar -xzf "node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz" -C "$HOME/.local/nodejs" --strip-components 1 &&',
  `  echo 'export PATH="$HOME/.local/nodejs/bin:$PATH"' >> "$HOME/.zprofile" &&`,
  '  export PATH="$HOME/.local/nodejs/bin:$PATH" &&',
  "  npm install -g @oscharko-dev/keiko",
]);

// Where Keiko keeps its state; every form starts with none of them (an empty state).
const STATE_FOLDERS = Object.freeze([
  ".keiko",
  ".keiko-standalone",
  join("Library", "Application Support", "Keiko"),
]);
const WORK_FOLDER = "Keiko qualification";
const TASK_TEXT = "Reply briefly to confirm that the Workbench is ready.";
const START_TIMEOUT_MS = 15 * 60 * 1000;
const STOP_TIMEOUT_MS = 2 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 90 * 1000;
const ACTIVATION_TIMEOUT_MS = 2 * 60 * 1000;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const MARKED_START_TIMEOUT_MS = 2 * 60 * 1000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const ACCOUNTS = Object.freeze(["standard", "any"]);
/** Set only by the CI job that created the account: its home holds nothing to lose. */
export const DISPOSABLE_ACCOUNT_VARIABLE = "KEIKO_QUALIFY_DISPOSABLE_ACCOUNT";
const EXPECTATIONS = Object.freeze(["record", ...MARKED_OUTCOMES]);

const USAGE = `Usage (as the account under proof, on a Mac):
  node scripts/testing/qualify-macos-standard-account-forms.mjs --version X.Y.Z --out-dir DIR
       [--node-version X.Y.Z] [--expect-marked OUTCOME] [--account standard|any]
       [--defer-form FORM] [--repository OWNER/NAME]

  --version        the published Keiko version whose forms are qualified
  --out-dir        keeps the evidence file (keiko-macos-standard-account-forms.json)
  --node-version   the Node.js the npm form unpacks (default: this Node.js)
  --expect-marked  record (default) | ${MARKED_OUTCOMES.join(" | ")}
  --account        standard (default): certify only as a standard account without sudo;
                   any: a rehearsal under another account, which certifies nothing
  --defer-form     ${FORMS.join(" | ")}: leave that form out; the evidence names it as deferred
                   and certifies nothing
`;

/**
 * The first published version whose start request states the repository the person sees. An
 * older release parses start requests exact-keyed and refuses the field, so the driver speaks the
 * protocol of the version under proof; from this version on the statement is required.
 */
export const EXPECTED_WORKSPACE_SINCE = "1.5.11";

/** True when the published `version` (x.y.z) requires the start to state its repository. */
export function startStatesRepository(version) {
  const parse = (text) => String(text).split(".").map(Number);
  const [major, minor, patch] = parse(version);
  const [sinceMajor, sinceMinor, sincePatch] = parse(EXPECTED_WORKSPACE_SINCE);
  if (major !== sinceMajor) return major > sinceMajor;
  if (minor !== sinceMinor) return minor > sinceMinor;
  return patch >= sincePatch;
}

export class FormsRefusal extends Error {}

function refuse(message) {
  throw new FormsRefusal(message);
}

/** Parses the command line; anything unknown or malformed is refused. */
export function parseFormsArgs(argv, nodeVersion = process.versions.node) {
  const flags = {
    "--version": "version",
    "--out-dir": "outDir",
    "--node-version": "nodeVersion",
    "--expect-marked": "expectMarked",
    "--account": "account",
    "--defer-form": "deferForm",
    "--repository": "repository",
  };
  const options = {
    nodeVersion,
    expectMarked: "record",
    account: "standard",
    repository: DEFAULT_REPOSITORY,
  };
  readFlagPairs(argv, flags, options, refuse);
  if (!VERSION_PATTERN.test(String(options.version))) refuse("--version must be x.y.z");
  if (options.outDir === undefined) refuse("--out-dir is required");
  if (!VERSION_PATTERN.test(String(options.nodeVersion))) refuse("--node-version must be x.y.z");
  if (!EXPECTATIONS.includes(options.expectMarked)) refuse("--expect-marked is not an outcome");
  if (!ACCOUNTS.includes(options.account)) refuse("--account must be standard or any");
  if (options.deferForm !== undefined && !FORMS.includes(options.deferForm)) {
    refuse("--defer-form is not a form");
  }
  return { ...options, forms: FORMS.filter((form) => form !== options.deferForm) };
}

/** The documented lines with this run's Node.js version, architecture and Keiko version. */
export function nodeUserInstallScript({ nodeVersion, nodeArch, keikoVersion }) {
  const filled = NODE_USER_INSTALL_LINES.map((line) => {
    if (line.startsWith("NODE_VERSION=")) return `NODE_VERSION=${nodeVersion}`;
    if (line.startsWith("NODE_ARCH=")) return `NODE_ARCH=${nodeArch}`;
    if (line.trimStart().startsWith("npm install -g ")) return `${line}@${keikoVersion}`;
    return line;
  });
  return filled.join("\n");
}

/** The account's groups and whether it may use sudo: what makes a run certify the promise. */
export function accountFacts(run = spawnSync) {
  const id = run("id", ["-Gn"], { encoding: "utf8" });
  const groups = String(id.stdout ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (id.error !== undefined || id.status !== 0 || groups.length === 0) {
    refuse("the account's groups could not be read");
  }
  const sudo = run("sudo", ["-n", "true"], { encoding: "utf8", timeout: 10_000 });
  // A sudo that could not start or ran out of time refused nothing; only its own answer counts.
  if (sudo.error !== undefined || sudo.status === null) refuse("sudo could not be asked");
  return {
    groups,
    administrator: groups.includes("admin"),
    sudo: sudo.status === 0 ? "available" : "refused",
  };
}

/** The standalone archive's public release URL and its checksum file. */
export function standaloneAssetUrls({ repository, version, target }) {
  const base = `https://github.com/${repository}/releases/download/v${version}`;
  const archive = `${base}/keiko-${target}.standalone.zip`;
  return { archive, checksum: `${archive}.sha256` };
}

/** How many entries below a folder carry the download mark (`find -xattrname`). */
export function markedEntryCount(folder, run = spawnSync) {
  const listed = run("find", [folder, "-xattrname", "com.apple.quarantine"], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (listed.status !== 0) refuse("the download mark could not be counted");
  return String(listed.stdout)
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

/** The mark a browser writes on a download: flags, the time in hex, the agent and an event id. */
export function browserDownloadMark(nowMs = Date.now(), eventId = randomUUID().toUpperCase()) {
  return `0083;${Math.floor(nowMs / 1000).toString(16)};Safari;${eventId}`;
}

/** The marked-download outcome, from what the start, the health check and the run showed. */
export function markedOutcome({ healthy, codingRun }) {
  if (!healthy) return "start-refused";
  return codingRun === "succeeded" ? "started-coding-run-succeeded" : "started-coding-run-failed";
}

/**
 * Whether Gatekeeper assesses programs on this Mac (`spctl --status`), recorded beside the outcome.
 * It was on on the hosted runner too, and the marked copy still ran there (#4520).
 */
export function gatekeeperState(run = spawnSync) {
  const result = run("/usr/sbin/spctl", ["--status"], { encoding: "utf8" });
  const text = `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`;
  if (/assessments enabled/u.test(text)) return "enabled";
  if (/assessments disabled/u.test(text)) return "disabled";
  return "unknown";
}

/**
 * Whether the account owns this Mac's desktop session (the owner of `/dev/console`). Where it does,
 * macOS held a marked copy with its "Not Opened" dialog; where it does not, as for the account on a
 * hosted runner, the marked copy ran. A pinned outcome therefore holds only in a desktop session.
 */
export function desktopSession(account = userInfo().username, run = spawnSync) {
  const owner = run("/usr/bin/stat", ["-f", "%Su", "/dev/console"], { encoding: "utf8" });
  return owner.status === 0 && String(owner.stdout ?? "").trim() === account;
}

/** A form passed only when its checks ran through to a coding run that settled `succeeded`. */
function formPassed(entry) {
  return (
    entry.passed &&
    entry.checks.some((check) => check.name === "coding-run-succeeded" && check.result === "pass")
  );
}

/**
 * Whether the marked-download observation holds. It needs a mark on the extracted files, without
 * which it shows nothing about the mark, and a pinned outcome holds only in a desktop session.
 */
function markedMatches(marked, expectMarked) {
  if (marked === undefined || marked.markedEntryCount === 0) return false;
  if (!MARKED_OUTCOMES.includes(marked.outcome)) return false;
  if (expectMarked === "record") return true;
  return marked.desktopSession === true && expectMarked === marked.outcome;
}

/**
 * The body-free evidence: closed values, counts, digests and durations. A pinned marked outcome
 * holds only in the account's desktop session; `record` records whatever the start showed. Only a
 * run of all three forms under `--account standard` certifies; a rehearsal under another account,
 * or a run that deferred a form, never does.
 */
export function buildFormsEvidence({ options, account, forms, marked, runner }) {
  const qualified = options.forms ?? FORMS;
  const deferred = FORMS.filter((form) => !qualified.includes(form));
  const formsPassed = qualified.every((form) =>
    forms.some((entry) => entry.form === form && formPassed(entry)),
  );
  const passed = formsPassed && markedMatches(marked, options.expectMarked);
  const certifiable =
    deferred.length === 0 &&
    options.account === "standard" &&
    !account.administrator &&
    account.sudo === "refused";
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: EVIDENCE_KIND,
    version: options.version,
    nodeVersion: options.nodeVersion,
    accountMode: options.account,
    account,
    runner,
    passed,
    certifies: passed && certifiable,
    formsDeferred: deferred,
    forms,
    markedDownload: marked ?? null,
  };
}

function checkResults(checks) {
  return checks.results.map(({ name, ok, durationMs, detail }) => ({
    name,
    result: ok ? "pass" : "fail",
    durationMs,
    ...(detail === undefined ? {} : { detail }),
  }));
}

function removeStates(home) {
  for (const folder of STATE_FOLDERS) rmSync(join(home, folder), { recursive: true, force: true });
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) refuse(`git ${args[0]} failed: ${String(result.stderr).trim()}`);
}

function createRepository(root) {
  mkdirSync(root, { recursive: true });
  git(["init", "-q", "-b", "main", root], root);
  writeFileSync(join(root, "README.md"), "Synthetic delivery-form qualification repository.\n");
  git(["add", "README.md"], root);
  git(
    [
      "-c",
      "user.name=Keiko Qualification",
      "-c",
      "user.email=qualify@example.invalid",
      "commit",
      "-q",
      "-m",
      "Initial synthetic fixture",
    ],
    root,
  );
}

/**
 * The environment every start gets: the account's own, a loopback port, the twin's gateway and a
 * launcher secret the script pairs with. PATH holds the system's folders and, for the npm form
 * only, the Node.js it unpacked: no form sees a Node.js of the runner or of another form.
 */
function startEnvironment(context, form, port) {
  return {
    HOME: context.home,
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? "",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "",
    PATH: [...form.path, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    KEIKO_UI_PORT: String(port),
    KEIKO_OS_KEYCHAIN: "off",
    KEIKO_CONFIG_FILE: context.configPath,
    KEIKO_DEFAULT_API_KEY: CUSTOMER_SHAPE_API_KEY,
    KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET: context.launcherSecret,
  };
}

/** One coding run on the synthetic repository, from activation to its settled state. */
async function codingRun(baseUrl, context, timeoutMs = RUN_TIMEOUT_MS) {
  const session = await openApiSession(baseUrl, {
    KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET: context.launcherSecret,
  });
  const post = (path, body) => session.request("POST", path, body);
  const activated = await session.request(
    "POST",
    "/api/gateway/readiness",
    { modelId: CUSTOMER_SHAPE_MODEL },
    { timeoutMs: ACTIVATION_TIMEOUT_MS },
  );
  ensure(activated.status < 300, `model activation answered HTTP ${String(activated.status)}`);
  await selectLabCheckout(post, context.repository, "main");
  const repository = await realpath(context.repository);
  const runId = await startRun(session, {
    repository,
    text: TASK_TEXT,
    mode: MODES[1],
    model: CUSTOMER_SHAPE_MODEL,
    statesRepository: startStatesRepository(context.options.version),
  });
  const snapshot = await watchRun(session, runId, {
    approve: "none",
    deadline: Date.now() + timeoutMs,
  });
  await stopUnfinishedRun(post, runId, snapshot);
  const reason = snapshot?.failure?.code ?? snapshot?.terminalReason ?? "no reason";
  ensure(
    snapshot?.state === "succeeded",
    `the run ended ${String(snapshot?.state)} (${String(reason)})`,
  );
  return "succeeded";
}

// --- the three forms -----------------------------------------------------------------------------

function npmForm(context) {
  const folder = join(context.home, NODE_FOLDER);
  const keiko = join(folder, "bin", "keiko");
  return {
    form: "npm",
    folder,
    path: [join(folder, "bin")],
    stateDir: join(context.home, ".keiko"),
    // The headless start README.md names; a person's `keiko start` also opens the browser.
    start: { command: keiko, args: ["start", "--no-open"] },
    stop: { command: keiko, args: ["stop"] },
    install: async (checks, env) => {
      await checks.run("node-user-install", async () => {
        mkdirSync(join(context.home, "Downloads"), { recursive: true });
        const script = nodeUserInstallScript({
          nodeVersion: context.options.nodeVersion,
          nodeArch: arch(),
          keikoVersion: context.options.version,
        });
        const result = await runLogged("/bin/zsh", ["-e", "-c", script], {
          env,
          cwd: context.home,
          logPath: join(context.work, "npm-install.log"),
          timeoutMs: INSTALL_TIMEOUT_MS,
        });
        if (result.status !== 0) console.log(`npm-install: ${tail(result.output)}`);
        ensure(result.status === 0, `exit ${String(result.status)}`);
        ensure(existsSync(keiko), "npm installed no keiko command");
      });
    },
  };
}

/** What both folder forms share: a `Keiko` folder in the account's own folder and its start files. */
function folderForm(context, form, subfolder) {
  const parent = join(context.home, WORK_FOLDER, subfolder);
  const folder = join(parent, "Keiko");
  const extract = (zip) => {
    extractZip(zip, parent, "darwin");
    ensure(existsSync(startFile(folder, "darwin")), "the package has no start file");
  };
  return {
    form,
    parent,
    folder,
    extract,
    path: [],
    stateDir: join(context.home, ".keiko-standalone"),
    start: { command: "/bin/sh", args: [startFile(folder, "darwin")] },
    stop: { command: "/bin/sh", args: [stopFile(folder, "darwin")] },
  };
}

function npmFolderForm(context) {
  const form = folderForm(context, "npm-folder", "npm folder");
  form.install = async (checks) => {
    await checks.run("package-build-and-extract", async () => {
      const urls = releaseAssetUrls({ ...context.options, target: context.target });
      const archive = join(context.work, `keiko-${context.target}.zip`);
      const sums = join(context.work, `${context.target}-SHA256SUMS.txt`);
      await download(urls.checksums, sums);
      await download(urls.archive, archive);
      const built = buildNpmPackage({
        target: context.target,
        archive,
        sha256sums: sums,
        outDir: context.work,
      });
      ensure(built.packageVersion === context.options.version, `built ${built.packageVersion}`);
      form.extract(built.outputPath);
      return `zip ${built.outputSha256.slice(0, 16)}`;
    });
  };
  return form;
}

function standaloneForm(context) {
  const form = folderForm(context, "standalone", "standalone");
  form.install = async (checks) => {
    await checks.run("archive-download-and-extract", async () => {
      const zip = await downloadStandalone(context);
      form.extract(zip);
      return `zip ${sha256FileChunked(zip).slice(0, 16)}`;
    });
  };
  return form;
}

/** Downloads the standalone archive once and verifies it against its published checksum. */
async function downloadStandalone(context) {
  if (context.standaloneZip !== undefined) return context.standaloneZip;
  const urls = standaloneAssetUrls({ ...context.options, target: context.target });
  const zip = join(context.work, `keiko-${context.target}.standalone.zip`);
  const checksum = `${zip}.sha256`;
  await download(urls.checksum, checksum);
  await download(urls.archive, zip);
  const expected = expectedArchiveSha256({ sha256sums: checksum }, zip);
  ensure(sha256FileChunked(zip) === expected, "the archive digest differs from its checksum");
  context.standaloneZip = zip;
  return zip;
}

const FORM_FACTORIES = Object.freeze({
  npm: npmForm,
  "npm-folder": npmFolderForm,
  standalone: standaloneForm,
});

// --- one form, end to end ------------------------------------------------------------------------

function tail(text = "") {
  return text.split(/\r?\n/u).slice(-12).join(" | ").slice(-1200);
}

function runCommand(spec, env, context, name, timeoutMs) {
  return runLogged(spec.command, spec.args, {
    env,
    cwd: context.home,
    logPath: join(context.work, name),
    timeoutMs,
  });
}

/** Runs a start or stop file and requires it to exit 0. */
async function runSucceeded(spec, env, context, name, timeoutMs) {
  const result = await runCommand(spec, env, context, name, timeoutMs);
  // The output goes to the job log only; the evidence keeps the closed exit status.
  if (result.status !== 0) console.log(`${name}: ${tail(result.output)}`);
  ensure(result.status === 0, `exit ${String(result.status)}`);
  return result;
}

function ownProcesses(form) {
  return [...new Set([...processesOf(form.folder), ...processesOf(form.stateDir)])];
}

async function startChecks(form, checks, env, context) {
  await checks.run("first-start", () =>
    runSucceeded(form.start, env, context, `${form.form}-start-1.log`, START_TIMEOUT_MS),
  );
  await checks.run("health-reports-version", async () => {
    const health = await waitFor(async () => {
      const seen = await healthVersion(context.port);
      return seen.reachable ? seen : false;
    }, HEALTH_TIMEOUT_MS);
    ensure(health !== false, "health did not answer");
    ensure(health.version === context.options.version, `version ${String(health.version)}`);
  });
  await checks.run("coding-run-succeeded", () =>
    codingRun(`http://127.0.0.1:${String(context.port)}`, context),
  );
  await checks.run("second-start-reports-running", async () => {
    const second = await runSucceeded(
      form.start,
      env,
      context,
      `${form.form}-start-2.log`,
      START_TIMEOUT_MS,
    );
    ensure(/already running/iu.test(second.output), "no 'already running' report");
  });
}

async function stopChecks(form, checks, env, context) {
  await checks.run("stop-exits-clean", () =>
    runSucceeded(form.stop, env, context, `${form.form}-stop.log`, STOP_TIMEOUT_MS),
  );
  await checks.run("no-process-left", async () => {
    const gone = await waitFor(async () => !(await healthVersion(context.port)).reachable, 30_000);
    ensure(gone, "health still answers after stop");
    ensure(await waitFor(() => ownProcesses(form).length === 0, 30_000), "a process remains");
  });
  await checks.run("download-mark-absent", () => {
    const marked = markedEntryCount(form.folder);
    ensure(marked === 0, `${String(marked)} entries carry the download mark`);
    return "0 marked entries";
  });
}

/**
 * Keeps a form's Activity Log beside the evidence before the next form removes its state. The log
 * is body-free by construction and is the record of why a check failed (AGENTS.md section 8).
 */
function keepActivityLog(form, context) {
  const logs = join(form.stateDir, "logs");
  if (!existsSync(logs)) return;
  try {
    cpSync(logs, join(context.logDir, form.form), { recursive: true });
  } catch (error) {
    // The log is the record, not a check: a copy that failed is said, and the form's verdict stands.
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`${form.form}: the Activity Log could not be kept (${detail})`);
  }
}

/** Ends whatever a failed form left running, so the next form starts from an empty state. */
async function emergencyStop(form, env, context) {
  if ((await healthVersion(context.port)).reachable) {
    await runCommand(form.stop, env, context, `${form.form}-emergency-stop.log`, STOP_TIMEOUT_MS);
  }
  for (const pid of ownProcesses(form)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone between the listing and the signal: nothing left to end.
    }
  }
}

async function qualifyForm(name, context) {
  const form = FORM_FACTORIES[name](context);
  removeStates(context.home);
  context.port = await freePort();
  const env = startEnvironment(context, form, context.port);
  const checks = new Checks((line) => console.log(`${name}: ${line}`));
  try {
    await form.install(checks, env);
    await startChecks(form, checks, env, context);
    await stopChecks(form, checks, env, context);
  } finally {
    await emergencyStop(form, env, context);
    keepActivityLog(form, context);
  }
  return { form: name, passed: !checks.failed, checks: checkResults(checks) };
}

/**
 * The standalone archive with the mark a browser sets, extracted with the macOS tool that, like
 * Finder, hands the mark to every extracted file. Records whether it starts and whether a coding
 * run then succeeds; Keiko never removes or bypasses the mark.
 */
async function qualifyMarkedDownload(context) {
  const zip = await downloadStandalone(context);
  const form = folderForm(context, "marked-download", "marked download");
  mkdirSync(form.parent, { recursive: true });
  const marked = join(form.parent, `keiko-${context.target}.standalone.zip`);
  copyFileSync(zip, marked);
  const written = spawnSync("/usr/bin/xattr", [
    "-w",
    "com.apple.quarantine",
    browserDownloadMark(),
    marked,
  ]);
  if (written.status !== 0) refuse("the download mark could not be written");
  form.extract(marked);
  const markedEntries = markedEntryCount(form.folder);
  if (markedEntries === 0)
    refuse("the extracted copy carries no download mark: nothing to observe");
  const gatekeeper = gatekeeperState();
  const desktop = desktopSession();
  console.log(
    `marked-download: ${String(markedEntries)} marked entries; Gatekeeper ${gatekeeper}; desktop session ${desktop ? "yes" : "no"}`,
  );
  return {
    gatekeeper,
    desktopSession: desktop,
    ...(await observeMarkedStart(form, context, markedEntries)),
  };
}

// A coding run of the marked copy: its failure is the observation, recorded with its reason.
async function markedCodingRun(context) {
  try {
    const state = await codingRun(`http://127.0.0.1:${String(context.port)}`, context, 3 * 60_000);
    return { state };
  } catch (error) {
    return { state: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function observeMarkedStart(form, context, markedEntries) {
  removeStates(context.home);
  context.port = await freePort();
  const env = startEnvironment(context, form, context.port);
  try {
    const started = await runCommand(
      form.start,
      env,
      context,
      "marked-start.log",
      MARKED_START_TIMEOUT_MS,
    );
    const health = await waitFor(async () => (await healthVersion(context.port)).reachable, 60_000);
    const run = health ? await markedCodingRun(context) : { state: "not-run" };
    const outcome = markedOutcome({ healthy: Boolean(health), codingRun: run.state });
    console.log(`marked-download: start exit ${String(started.status)}, ${outcome}`);
    if (!health) console.log(`marked-download: start output: ${tail(started.output)}`);
    if (run.detail !== undefined) console.log(`marked-download: coding run: ${run.detail}`);
    return { markedEntryCount: markedEntries, startExit: started.status, outcome };
  } finally {
    await emergencyStop(form, env, context);
    keepActivityLog(form, context);
  }
}

function runnerIdentity() {
  return { os: platform(), arch: arch(), osRelease: release() };
}

async function runForms(context) {
  const forms = [];
  for (const name of context.options.forms) forms.push(await qualifyForm(name, context));
  const marked = await qualifyMarkedDownload(context).catch((error) => {
    console.log(`marked-download: FAIL ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  removeStates(context.home);
  return { forms, marked };
}

/** The path with every symbolic link resolved, so a link to the real home is that home. */
function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    // A path that does not exist yet links nowhere; its resolved form is all there is to compare.
    return resolve(path);
  }
}

/**
 * Every form starts from an empty state, so the run removes Keiko's state folders in the home it
 * runs in. It runs only where that loses nothing: as the CI job's fresh standard account, or in a
 * rehearsal whose HOME is a folder of its own, never the account's real home.
 */
export function assertDisposableHome(
  options,
  home,
  env = process.env,
  realHome = userInfo().homedir,
) {
  if (
    options.account === "standard" &&
    (env.CI !== "true" || env[DISPOSABLE_ACCOUNT_VARIABLE] !== "1")
  ) {
    refuse(
      `a standard-account run belongs to the CI job's fresh account (CI=true, ${DISPOSABLE_ACCOUNT_VARIABLE}=1)`,
    );
  }
  if (options.account === "any" && canonical(home) === canonical(realHome)) {
    refuse(
      "a rehearsal needs HOME set to a folder of its own: the run removes Keiko's state there",
    );
  }
}

/** Runs the whole qualification and returns its evidence; removes what it created. */
async function runFormsQualification(options) {
  if (platform() !== "darwin") refuse("the macOS delivery forms are qualified on a Mac only");
  const account = accountFacts();
  console.log(`account groups: ${account.groups.join(" ")}; sudo ${account.sudo}`);
  if (options.account === "standard" && (account.administrator || account.sudo !== "refused")) {
    refuse("this account is an administrator or may use sudo: nothing would be proven");
  }
  const home = homedir();
  assertDisposableHome(options, home);
  const work = join(home, WORK_FOLDER, "work");
  rmSync(join(home, WORK_FOLDER), { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const twin = await startCustomerShapeLiteLlmTwin();
  const context = {
    options,
    home,
    work,
    target: hostTarget(),
    configPath: join(home, WORK_FOLDER, "gateway.json"),
    repository: join(home, WORK_FOLDER, "repository"),
    launcherSecret: randomBytes(32).toString("hex"),
    logDir: join(resolve(options.outDir), "activity-logs"),
  };
  rmSync(context.logDir, { recursive: true, force: true });
  try {
    writeCustomerShapeGatewayConfig(context.configPath, twin.baseUrl);
    createRepository(context.repository);
    const { forms, marked } = await runForms(context);
    return buildFormsEvidence({ options, account, forms, marked, runner: runnerIdentity() });
  } finally {
    await twin.close();
    rmSync(join(home, WORK_FOLDER), { recursive: true, force: true });
  }
}

function formsVerdict(evidence) {
  if (evidence.certifies) return "CERTIFIED";
  if (!evidence.passed) return "FAIL";
  const deferred = evidence.formsDeferred;
  return deferred.length > 0
    ? `PASS (not certified: ${deferred.join(", ")} deferred)`
    : "PASS (not certified)";
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const options = parseFormsArgs(argv);
    const evidence = await runFormsQualification(options);
    const outDir = resolve(options.outDir);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${EVIDENCE_KIND}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`${formsVerdict(evidence)} macOS delivery forms ${options.version}`);
    // A standard-account run never gets here as an administrator: runFormsQualification refuses it.
    const uncertifiedPass = options.account === "any" || evidence.formsDeferred.length > 0;
    return evidence.passed && (evidence.certifies || uncertifiedPass) ? 0 : 1;
  } catch (error) {
    if (!(error instanceof FormsRefusal)) throw error;
    console.error(`FAIL qualify-macos-standard-account-forms: ${error.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
