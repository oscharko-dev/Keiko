// Start, stop and the administrator's access step of a Keiko npm package (ADR-0121 D9).
//
// This file ships inside the package as system/keiko-npm.mjs and runs with the Node.js runtime next
// to it. Keiko itself is not in the package: the first start installs the exact version that
// package.json names from the npm registry the folder's .npmrc names (the computer's npm
// configuration without one), checked against the integrity hashes in package-lock.json. A later
// start installs again only when the lockfile changed or an earlier installation did not finish.
//
// Only Node.js built-ins: the file must run before anything is installed.

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { Worker } from "node:worker_threads";

const PACKAGE_PATH = ["node_modules", "@oscharko-dev", "keiko"];
const INSTALLED_MARKER = ".keiko-npm-installed";
const CONFIG_NAME = "keiko.config.json";
// The data of every Keiko start form of this computer account: a new package folder, or the
// folder package, finds the chats and settings of the old one.
const STATE_DIR_NAME = ".keiko-standalone";
// npm removes node_modules during `npm ci`, so the installation's lock lies beside this file. The
// lock is a folder that appears complete in one rename: it always holds the entry
// `owner-<pid>-<random>` of the start that installs, whose content only that start's own process
// rewrites every few seconds, and a Stop made meanwhile adds `stop-<pid>-<random>` to it. npm's own
// process adds `npm-<pid>-<random>` while it installs and renews only that entry. A start that is about to let go of the lock adds
// `closing-<pid>-<random>` first: from then on no Stop is accepted by that lock.
const INSTALL_LOCK = ["system", "keiko-npm-install.lock"];
// The start that opened Keiko last leaves its token as `keiko-npm-start-generation-<token>`,
// written once its launch of Keiko really happened (the CLI was spawned) and only while it still
// holds its lock. The lock is gone once the start let go; the record is not, so a Stop that waited
// for the lock can tell that another start opened Keiko meanwhile. A start whose launch never
// happened records nothing. The record lives in two places: this folder's `system/`, and Keiko's
// data folder, which every package folder of the account shares, so a Stop of one folder also sees
// a start of another folder that uses the same data.
const GENERATION_PREFIX = "keiko-npm-start-generation-";
const GENERATION_DIR = "system";
// A Stop that acts while only npm of an ended start holds the lock holds no lock of its own: it
// leaves `keiko-npm-stop-handoff-<pid>-<random>` in system/ for the time its stop runs, and every
// start waits for such an entry (whose process runs) before it opens Keiko.
const STOP_HANDOFF = /^keiko-npm-stop-handoff-(\d+)-[0-9a-f]+$/u;
const LOCK_ENTRY = /^(owner|npm|stop|closing)-(\d+)-([0-9a-f]+)$/u;
const START_KINDS = new Set(["owner"]);
const HOLDER_KINDS = new Set(["owner", "npm"]);
// A lock on its way in or out: `<lock>.<pid>-<random>.candidate` or `.released`.
const LOCK_LEFTOVER = /^keiko-npm-install\.lock\.(\d+)-[0-9a-f]+\.(?:candidate|released)$/u;
const LOCK_ATTEMPTS = 8;
const OBSERVE_ATTEMPTS = 8;
// What renaming or removing the lock folder answers while another start holds or changes it.
const LOCK_CONTENDED = new Set(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 40;
const RENAME_RETRY_MS = 25;
// The query parameters with which npm imports this file to hold the lock it installs under, and to
// keep the entry of the start that runs it.
const HOLD_PARAMETER = "hold-install-lock";
const KEEP_PARAMETER = "keep-install-lock-owner";
// The system gives the number of an ended process to a new one, Windows soon after, and a clock can
// jump, so neither a running process number nor a timestamp proves that a holder still runs. A
// holder proves it by renewing: every holder rewrites its own entry this often, and a start that
// finds a lock whose entries have a running process number watches them for up to
// LOCK_OBSERVE_MS on its own monotonic clock. Any entry that changed means the lock is live; none
// that did means its holder ended or is frozen, and the lock is taken over.
const LOCK_RENEW_MS = 15 * 1000;
const LOCK_OBSERVE_MS = 60 * 1000;
const LOCK_OBSERVE_STEP_MS = 500;
// How long a start waits for an npm whose start window was closed: a first installation takes a
// few minutes.
const ORPHANED_NPM_WAIT_MS = 10 * 60 * 1000;
// The optional Coding runtime of a platform, which `npm ci` must install whatever its `engines` say.
const CODING_RUNTIME_PACKAGE = /(?:^|\/)node_modules\/@oscharko-dev\/keiko-coding-runtime-[^/]+$/u;

/** Prints one message in English and in German, as every start file does. */
function say(english, german) {
  console.log(english);
  console.log(german);
}

/** A refusal a person can act on, in English and in German. */
export class LauncherRefusal extends Error {
  constructor(english, german) {
    super(`${english}\n${german}`);
    this.name = "LauncherRefusal";
  }
}

/** Where npm's own command line lies next to a Node.js runtime: bin/../lib on macOS, beside on Windows. */
export function npmCliCandidates(nodeDir) {
  return [
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
}

export function keikoCliPath(root) {
  return join(root, ...PACKAGE_PATH, "dist", "cli", "index.js");
}

// A path with its deepest existing ancestor resolved through every link, so a link on the way
// cannot lead out of the home folder. An ancestor that cannot be resolved refuses.
function canonicalPath(path) {
  const tail = [];
  let current = path;
  while (lstatSync(current, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}

function insideOrEqual(path, folder) {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

/** The home folder Keiko's command line will see: os.homedir() reads HOME, on Windows USERPROFILE. */
export function homeOf(env, platform = process.platform) {
  const declared = platform === "win32" ? env.USERPROFILE : env.HOME;
  return declared !== undefined && declared.length > 0 ? declared : homedir();
}

/**
 * Keiko's data folder as one absolute path, inside the person's home folder: the start, npm and
 * Keiko all use this one path. A relative KEIKO_STATE_DIR is resolved once, here. A folder outside
 * the home folder is refused before anything is written, as `keiko start` refuses it.
 */
export function stateDir(env, home = homeOf(env), cwd = process.cwd()) {
  const declared = env.KEIKO_STATE_DIR;
  const selected =
    declared !== undefined && declared.length > 0
      ? resolve(cwd, declared)
      : join(resolve(home), STATE_DIR_NAME);
  if (!insideOrEqual(canonicalPath(selected), canonicalPath(resolve(home)))) {
    throw new LauncherRefusal(
      "KEIKO_STATE_DIR must name a folder inside your home folder.",
      "KEIKO_STATE_DIR muss einen Ordner in deinem Benutzerordner nennen.",
    );
  }
  return selected;
}

/** npm's log lives in Keiko's data, not in ~/.npm; npm itself keeps it to its last ten files. */
export function npmLogsDir(state) {
  return join(state, "npm-logs");
}

// Whether `path` is a real folder of this account inside `container`: no link or junction (lstat
// reports both), no file, no folder of another account, nothing that resolves elsewhere.
function ownFolderInside(path, container) {
  const entry = lstatSync(path);
  const owned = typeof process.getuid !== "function" || entry.uid === process.getuid();
  return (
    !entry.isSymbolicLink() &&
    entry.isDirectory() &&
    owned &&
    insideOrEqual(realpathSync(path), realpathSync(container))
  );
}

/**
 * The log folder npm writes and rotates its files in, created when missing. It must be Keiko's own:
 * a real folder of this account inside the data folder, never a link that leads elsewhere or a
 * folder of another account. Anything else is refused before npm runs.
 */
export function ownedLogsDir(state, makeDir = mkdirSync) {
  const logsDir = npmLogsDir(state);
  try {
    makeDir(logsDir, { mode: 0o700 });
  } catch (error) {
    // Already there, also when the start of another package folder sharing this data folder made
    // it just now: whatever is there is checked below.
    if (error?.code !== "EEXIST") throw error;
  }
  if (!ownFolderInside(logsDir, state)) {
    throw new LauncherRefusal(
      `The folder npm-logs in Keiko's data folder ${state} is a link, a file or a folder of another account. Remove it, then start Keiko again.`,
      `Der Ordner npm-logs in Keikos Datenordner ${state} ist eine Verknuepfung, eine Datei oder ein Ordner eines anderen Kontos. Entferne ihn und starte Keiko dann erneut.`,
    );
  }
  return logsDir;
}

/**
 * What `npm ci` empties and fills must be this folder's own: npm deletes every entry of
 * node_modules first, so a link or junction to a shared folder would lose that folder's contents.
 * npm itself installs only from the lockfile this start checks, so a competing npm-shrinkwrap.json,
 * which npm reads first, is refused as well. Both refusals come before anything is changed.
 */
export function refuseForeignInstallTarget(root) {
  if (existsSync(join(root, "npm-shrinkwrap.json"))) {
    throw new LauncherRefusal(
      "This folder holds a file npm-shrinkwrap.json, which npm would install instead of package-lock.json. Remove it, then start Keiko again.",
      "Dieser Ordner enthaelt eine Datei npm-shrinkwrap.json, die npm statt package-lock.json installieren wuerde. Entferne sie und starte Keiko dann erneut.",
    );
  }
  const modules = join(root, "node_modules");
  if (
    lstatSync(modules, { throwIfNoEntry: false }) !== undefined &&
    !ownFolderInside(modules, root)
  ) {
    throw new LauncherRefusal(
      `The folder node_modules in ${root} is a link, a file or a folder of another account, and npm would empty it. Remove it, then start Keiko again.`,
      `Der Ordner node_modules in ${root} ist eine Verknuepfung, eine Datei oder ein Ordner eines anderen Kontos, und npm wuerde ihn leeren. Entferne ihn und starte Keiko dann erneut.`,
    );
  }
}

// --prefix: npm installs into exactly this folder, and reads this folder's .npmrc as its project
// configuration, even when a folder above it is an npm project or workspace root.
// --workspaces=false: npm installs no workspace of any project.
// --ignore-scripts: Keiko needs no install script, and none of its dependencies may run one here.
// --replace-registry-host=npmjs: the public addresses in the lockfile go to the configured registry.
// --dry-run=false, --package-lock-only=false, --global=false, --install-strategy=hoisted: npm
// installs for real, into this folder, in the layout the start reads.
// --include=prod|optional|peer: an inherited `omit` cannot leave out the packages Keiko runs with,
// among them the optional Coding runtime of this platform.
// Everything is set on the command line, which no npm_config_* variable and no .npmrc overrides:
// npm writes nothing outside the folder and Keiko's data folder.
export function installArgs(npmCli, root, cacheDir, logsDir) {
  return [
    npmCli,
    "ci",
    "--prefix",
    root,
    "--workspaces=false",
    "--dry-run=false",
    "--package-lock-only=false",
    "--global=false",
    "--install-strategy=hoisted",
    "--include=prod",
    "--include=optional",
    "--include=peer",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--replace-registry-host=npmjs",
    "--cache",
    cacheDir,
    "--logs-dir",
    logsDir,
  ];
}

function quoted(text) {
  return (
    text.length > 1 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  );
}

function unquotedIniText(text) {
  const inner = text.startsWith("'") ? text.slice(1, -1) : text;
  try {
    return String(JSON.parse(inner));
  } catch {
    return inner;
  }
}

// A key or value as npm's ini reader takes it: a quoted text is unquoted, and an unquoted text
// ends at the first ; or # not escaped with a backslash.
function iniText(raw) {
  const text = raw.trim();
  if (quoted(text)) return unquotedIniText(text);
  let value = "";
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      value += ";#\\".includes(character) ? character : `\\${character}`;
      escaped = false;
    } else if (character === ";" || character === "#") {
      break;
    } else if (character === "\\") {
      escaped = true;
    } else {
      value += character;
    }
  }
  return (escaped ? `${value}\\` : value).trim();
}

// The settings of an .npmrc as npm reads them: keys keep their case, and a [section] line puts the
// keys below it into that section, where npm does not read them as its own settings.
function npmrcEntries(text) {
  const entries = [];
  let section;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]*)\]$/u.exec(line);
    if (header !== null) {
      section = header[1];
      continue;
    }
    const split = line.indexOf("=");
    entries.push({
      key: iniText(split < 0 ? line : line.slice(0, split)),
      value: split < 0 ? undefined : iniText(line.slice(split + 1)),
      section,
    });
  }
  return entries;
}

// npm replaces ${NAME} in a value with that environment variable, and ${NAME?} with nothing when
// the variable is not set.
function expandedNpmrcValue(value, env) {
  return value.replaceAll(
    /\$\{([^${}?]+)(\?)?\}/gu,
    (whole, name, optional) => env[name] ?? (optional === "?" ? "" : whole),
  );
}

// npm ignores a registry that is no URL with a host and asks the public registry instead.
function registryAddress(value, env) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(expandedNpmrcValue(value, env));
    return (url.protocol === "https:" || url.protocol === "http:") && url.host.length > 0;
  } catch {
    return false;
  }
}

// Syntax this reader cannot interpret exactly as npm does: a bare carriage return ends a line for
// npm but not here, and `${...}` in a key can spell a registry key from the environment. Refusing
// it keeps the administrator's registry from being replaced by an inherited override unseen.
function refuseUnreadableSyntax(text) {
  const bareReturn = /\r(?!\n)/u.test(text);
  // A comment line is no setting: npm's ini parser skips it after leading whitespace.
  const expandedKey = text.split(/\r?\n/u).some((line) => {
    if (/^\s*[;#]/u.test(line)) return false;
    const split = line.indexOf("=");
    return (split < 0 ? line : line.slice(0, split)).includes("${");
  });
  if (!bareReturn && !expandedKey) return;
  throw new LauncherRefusal(
    "The file .npmrc uses syntax this start cannot read exactly as npm does (a bare carriage return as a line ending, or ${...} in a setting name), so the registry could not be told for certain. Use plain lines with line feeds and write the registry as registry=<address>.",
    "Die Datei .npmrc nutzt eine Syntax, die dieser Start nicht genau so liest wie npm (ein einzelnes Wagenruecklaufzeichen als Zeilenende oder ${...} in einem Einstellungsnamen); die Registry laesst sich daher nicht sicher bestimmen. Nutze einfache Zeilen mit Zeilenvorschub und schreibe die Registry als registry=<Adresse>.",
  );
}

function refuseScopedRegistry(entries) {
  if (entries.some(({ key }) => /^@[^:]+:registry$/iu.test(key))) {
    throw new LauncherRefusal(
      "The file .npmrc names a registry for a scope (@scope:registry). An npm package loads Keiko from one registry: name it with one line registry=<address>.",
      "Die Datei .npmrc nennt eine Registry fuer einen Scope (@scope:registry). Ein npm-Paket laedt Keiko aus einer Registry: Nenne sie mit einer Zeile registry=<Adresse>.",
    );
  }
}

/**
 * Whether the folder's .npmrc names the registry, in the one form a package supports and npm
 * reads: one global line `registry=<http or https address>`, a lowercase key outside any
 * [section]. npm loads a lockfile's packages from the global registry only, so a scoped registry
 * (`@scope:registry=`) would never be asked; and npm ignores another spelling (`REGISTRY=`), a
 * list (`registry[]=`), a registry in a section and an address it cannot read, and asks the public
 * registry instead. Each of these is refused before any request.
 */
export function folderRegistry(root, env = process.env) {
  const path = join(root, ".npmrc");
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  refuseUnreadableSyntax(text);
  const entries = npmrcEntries(text);
  refuseScopedRegistry(entries);
  const named = entries.filter(({ key }) => key.replace(/\[\]$/u, "").toLowerCase() === "registry");
  if (named.some(({ key, section }) => key !== "registry" || section !== undefined)) {
    throw new LauncherRefusal(
      "The file .npmrc names the registry in a form npm does not read (another spelling than registry, a list or a [section]), so npm would ask the public registry. Write one line registry=<address>.",
      "Die Datei .npmrc nennt die Registry in einer Form, die npm nicht liest (andere Schreibweise als registry, eine Liste oder ein [Abschnitt]); npm wuerde die oeffentliche Registry fragen. Schreibe eine Zeile registry=<Adresse>.",
    );
  }
  if (named.length > 1) {
    throw new LauncherRefusal(
      "The file .npmrc names the registry more than once. Keep one line registry=<address>.",
      "Die Datei .npmrc nennt die Registry mehrfach. Behalte eine Zeile registry=<Adresse>.",
    );
  }
  if (named.length === 0) return false;
  if (!registryAddress(named[0].value, env)) {
    throw new LauncherRefusal(
      "The registry in the file .npmrc is no http or https address, so npm would ask the public registry. Write one line registry=<address>, for example registry=https://npm.example.com/.",
      "Die Registry in der Datei .npmrc ist keine http- oder https-Adresse; npm wuerde die oeffentliche Registry fragen. Schreibe eine Zeile registry=<Adresse>, zum Beispiel registry=https://npm.example.com/.",
    );
  }
  return true;
}

export function lockfileDigest(root) {
  return createHash("sha256")
    .update(readFileSync(join(root, "package-lock.json")))
    .digest("hex");
}

/** Installed means: the last complete installation was of exactly this lockfile, and Keiko is there. */
export function installationCurrent(root, digest) {
  const marker = join(root, "node_modules", INSTALLED_MARKER);
  if (!existsSync(marker) || !existsSync(keikoCliPath(root))) return false;
  return readFileSync(marker, "utf8").trim() === digest;
}

// Windows spells the search path `Path`; a second `PATH` beside it would be ignored by one child
// and not by another.
function pathKey(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * npm and the packages it installs find this folder's Node.js first. When the folder's .npmrc
 * names the registry, an inherited npm_config_registry, which npm would rank above it, is dropped:
 * the folder's registry is the administrator's choice for this package. Proxy and credential
 * settings stay as they are.
 */
export function npmEnv(env, nodeDir, registryNamed = false) {
  const key = pathKey(env);
  const current = env[key];
  const kept = Object.entries(env).filter(
    ([name]) => !registryNamed || name.toLowerCase() !== "npm_config_registry",
  );
  return {
    ...Object.fromEntries(kept),
    [key]: current ? `${nodeDir}${delimiter}${current}` : nodeDir,
  };
}

/**
 * Keiko of a package performs no installation of its own: no setup, no Windows gateway service, no
 * update. A new version arrives as a new package (ADR-0121 D9). The declaration is pinned, as the
 * in-place launcher of the folder package pins it: an inherited `user-local` does not apply here.
 */
export function keikoEnv(env) {
  return { ...env, KEIKO_PORTABLE_MANAGEMENT: "organization-managed" };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * How the lock tells whether a process with a number runs. Tests replace `alive`: the system may
 * give the number of a process that just ended to a new one before a test looks.
 */
export const lockProcesses = { alive: processAlive };

function pidAlive(text) {
  const pid = Number.parseInt(text, 10);
  return Number.isInteger(pid) && pid > 0 && lockProcesses.alive(pid);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockToken() {
  return `${String(process.pid)}-${randomBytes(8).toString("hex")}`;
}

export function installLockPath(root) {
  return join(root, ...INSTALL_LOCK);
}

// The entries of the lock folder, or undefined when no start holds the lock.
function lockEntries(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The clock the lock observes renewal with: monotonic, so a wall-clock jump (a suspended computer,
 * a corrected clock) changes nothing. Tests replace both; `sleep` is told the lock folder.
 */
export const lockClock = {
  now: () => performance.now(),
  sleep: (milliseconds) => sleepSync(milliseconds),
};

// Whether a lock entry is of one of the kinds and its process number runs.
function lockEntryOf(kinds) {
  return (name) => {
    const match = LOCK_ENTRY.exec(name);
    return match !== null && kinds.has(match[1]) && pidAlive(match[2]);
  };
}

// The content of each entry that `accepts` says is to be watched.
function renewalSnapshot(dir, names, accepts) {
  const seen = new Map();
  for (const name of names) {
    if (!accepts(name)) continue;
    try {
      seen.set(name, readFileSync(join(dir, name), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return seen;
}

/**
 * The entries of the folder `dir` that `accepts` and that are renewing. Without an entry that
 * `accepts` the answer is empty at once. Otherwise the entries are watched for up to
 * LOCK_OBSERVE_MS: one that changed (or appeared) is renewal; none means the number was reused or
 * the holder is frozen. Only the observer's monotonic clock counts, never a timestamp. `sleepDir`
 * is what the clock's sleep is told.
 */
function renewedEntries(dir, accepts, sleepDir = dir) {
  const names = lockEntries(dir);
  if (names === undefined) return [];
  const first = renewalSnapshot(dir, names, accepts);
  if (first.size === 0) return [];
  const deadline = lockClock.now() + LOCK_OBSERVE_MS;
  while (lockClock.now() < deadline) {
    lockClock.sleep(LOCK_OBSERVE_STEP_MS, sleepDir);
    const current = lockEntries(dir);
    if (current === undefined) return [];
    const next = renewalSnapshot(dir, current, accepts);
    const renewed = [...next].filter(([name, content]) => first.get(name) !== content);
    if (renewed.length > 0) return renewed.map(([name]) => name);
  }
  return [];
}

// Whether the lock `dir` has a holder of one of the kinds that is renewing.
function renewalObserved(dir, kinds) {
  return renewedEntries(dir, lockEntryOf(kinds)).length > 0;
}

// Whether an entry of a start (not npm) with a running process number is in the lock.
function hasStartEntry(names) {
  return names.some((name) => {
    const match = LOCK_ENTRY.exec(name);
    return match?.[1] === "owner" && pidAlive(match[2]);
  });
}

/** Whether another start of this folder is installing Keiko right now. */
export function installerActive(root) {
  return renewalObserved(installLockPath(root), HOLDER_KINDS);
}

// The Start process renews its own owner entry for as long as it holds the lock, also while it is
// blocked in a synchronous npm run: a worker thread does it, which ends with the process. It only
// rewrites an entry that is still there and stops once it is gone, so it never recreates one.
const RENEWAL_WORKER = String.raw`
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const timer = setInterval(() => {
  let fd;
  try {
    fd = fs.openSync(workerData.path, "r+");
  } catch (error) {
    if (error.code === "ENOENT") clearInterval(timer);
    return;
  }
  try {
    const bytes = Buffer.from(String(Date.now()) + "\n");
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.ftruncateSync(fd, bytes.length);
  } finally {
    fs.closeSync(fd);
  }
}, workerData.every);
`;

function startRenewalWorker(path) {
  const worker = new Worker(RENEWAL_WORKER, {
    eval: true,
    // The worker's source is CommonJS: an `--input-type=module` of the parent must not reach it.
    execArgv: [],
    workerData: { path, every: lockRenewal.everyMs },
  });
  worker.unref();
  worker.once("error", (error) => {
    say(
      `Keiko could not renew its installation lock (${String(error?.code ?? "unknown")}). Another start may begin an installation beside it.`,
      `Keiko konnte seine Installationssperre nicht erneuern (${String(error?.code ?? "unbekannt")}). Ein anderer Start kann daneben eine Installation beginnen.`,
    );
  });
  return () => {
    void worker.terminate();
  };
}

/** How the start renews its own entry; tests replace `start`. */
export const lockRenewal = { everyMs: LOCK_RENEW_MS, start: startRenewalWorker };

// What a start left when it ended between preparing its lock and removing it after use.
function removeLockLeftovers(system) {
  for (const name of readdirSync(system)) {
    const leftover = LOCK_LEFTOVER.exec(name);
    if (leftover !== null && !pidAlive(leftover[1])) {
      rmSync(join(system, name), { recursive: true, force: true });
    }
  }
}

// Clears a lock no running start holds: only the entries read before, so a lock another start
// published meanwhile, whose entries carry other names, stays. The folder goes once it is empty.
function clearStaleLock(dir, entries) {
  for (const name of entries) rmSync(join(dir, name), { recursive: true, force: true });
  try {
    rmdirSync(dir);
  } catch (error) {
    if (error?.code !== "ENOENT" && !LOCK_CONTENDED.has(error?.code)) throw error;
  }
}

// Windows refuses to rename a folder while another process has a file in it open, and a scanner
// may hold a fresh file for a moment: such a rename is tried again. `taken` tells the lock of
// another start, which is final, from a handle that passes.
function renameRetrying(from, to, taken = () => false) {
  let failure;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    if (attempt > 0) sleepSync(RENAME_RETRY_MS);
    try {
      renameSync(from, to);
      return true;
    } catch (error) {
      if (!LOCK_CONTENDED.has(error?.code)) throw error;
      if (taken()) return false;
      failure = error;
    }
  }
  throw failure;
}

// The lock appears in one rename and already holds its owner, so no start finds it empty. A lock
// taken to carry out a Stop appears closed as well: its closing entry is in the same rename, so no
// observer ever sees that Stop's owner entry as a start that is about to open Keiko.
function publishLock(dir, pause, closing) {
  const token = lockToken();
  const candidate = `${dir}.${token}.candidate`;
  mkdirSync(candidate, { mode: 0o700 });
  const fd = openSync(join(candidate, `owner-${token}`), "wx", 0o600);
  try {
    writeAll(fd, `${String(Date.now())}\n`);
  } finally {
    closeSync(fd);
  }
  if (closing) closeSync(openSync(join(candidate, `closing-${token}`), "wx", 0o600));
  pause("publish");
  try {
    return renameRetrying(candidate, dir, () => existsSync(dir)) ? { dir, token } : undefined;
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}

/**
 * Makes this start the folder's one installer and returns its lock, or undefined while another
 * start installs. A lock whose start no longer runs (it crashed or was closed) is cleared and
 * taken; of two starts that find it so, one takes it. `pause` names each step at which another
 * start may run, so a test can let one run there. With `closing` the lock is born closed, as a Stop
 * takes it.
 */
export function acquireInstallLock(root, pause = () => undefined, { closing = false } = {}) {
  const dir = installLockPath(root);
  mkdirSync(dirname(dir), { recursive: true });
  removeLockLeftovers(dirname(dir));
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    // Windows may still hold a handle in a lock folder that was just cleared.
    if (attempt > 0) sleepSync(RENAME_RETRY_MS);
    const entries = lockEntries(dir);
    if (entries !== undefined) {
      if (renewalObserved(dir, HOLDER_KINDS)) return undefined;
      pause("clear");
      clearStaleLock(dir, entries);
    }
    const lock = publishLock(dir, pause, closing);
    if (lock !== undefined) {
      lock.stopRenewing = lockRenewal.start(join(dir, ownerEntryName(lock)));
      return lock;
    }
  }
  throw new LauncherRefusal(
    `The installation lock ${dir} cannot be taken. Remove it, then start Keiko again.`,
    `Die Installationssperre ${dir} kann nicht uebernommen werden. Entferne sie und starte Keiko dann erneut.`,
  );
}

function hasStopEntry(names) {
  return names.some((name) => LOCK_ENTRY.exec(name)?.[1] === "stop");
}

// A closing entry counts only beside the owner entry of the same start: a stray one that a killed
// start left in a lock another start published closes nothing.
function hasClosingEntry(names) {
  return names.some((name) => {
    const match = LOCK_ENTRY.exec(name);
    return match?.[1] === "closing" && names.includes(`owner-${match[2]}-${match[3]}`);
  });
}

function ownerEntryName(lock) {
  return `owner-${lock.token}`;
}

// The entries of the lock this start still holds, or undefined when the lock is gone or another
// start's: a lock holds this start's owner entry exactly while it is the generation it published.
function heldEntries(lock) {
  const names = lockEntries(lock.dir);
  return names?.includes(ownerEntryName(lock)) ? names : undefined;
}

// A start that no longer owns the lock generation it published ends here: another start took the
// lock over, so this one must neither write completion state nor open Keiko over a newer Stop or
// into a tree that start reinstalls.
function lostLockRefusal() {
  return new LauncherRefusal(
    "Another start of this folder took over the installation of Keiko, so this start ends without opening Keiko. Start Keiko again.",
    "Ein anderer Start dieses Ordners hat die Installation von Keiko uebernommen, daher endet dieser Start, ohne Keiko zu oeffnen. Starte Keiko erneut.",
  );
}

function refuseLostLock(lock) {
  if (lock === undefined || heldEntries(lock) !== undefined) return;
  throw lostLockRefusal();
}

// Whether a Stop was recorded in the lock this start still holds, from one read of it. A lock
// another start took over is that start's, and one it released meanwhile is gone.
function heldStopRecorded(lock) {
  const names = heldEntries(lock);
  return names !== undefined && hasStopEntry(names);
}

// Whether adding the entry succeeded; false when the lock went away meanwhile. An entry that is
// already there counts as added.
function createLockEntry(path) {
  try {
    closeSync(openSync(path, "wx", 0o600));
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return true;
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Stops the lock accepting Stops and returns whether one was recorded in it while this start held
 * it (`owned` is false for a lock that is no longer this start's: another start took it over and
 * the Stop belongs to that start). A Stop adds its entry and then looks for this closing entry, so
 * it is either read here or turned away and stops Keiko itself. The lock stays this start's until
 * `removeInstallLock`, so no other start opens Keiko before the recorded Stop is carried out.
 */
export function closeInstallLock(lock, pause = () => undefined) {
  if (heldEntries(lock) === undefined) return { owned: false, stopRequested: false };
  const closing = join(lock.dir, `closing-${lock.token}`);
  if (!createLockEntry(closing)) return { owned: false, stopRequested: false };
  pause("closed");
  const names = heldEntries(lock);
  if (names === undefined) {
    // The lock was replaced while the entry was added: never leave it in a foreign lock.
    rmSync(closing, { force: true });
    return { owned: false, stopRequested: false };
  }
  return { owned: true, stopRequested: hasStopEntry(names) };
}

/**
 * Lets go of the lock this start acquired and nothing else: its own owner entry goes first, and
 * only then the entries read beside it. A lock without this start's owner entry is another start's
 * and is never moved, read or removed, so no replacement is ever exposed.
 */
export function removeInstallLock(lock) {
  lock.stopRenewing?.();
  const names = heldEntries(lock);
  if (names === undefined) return;
  try {
    rmSync(join(lock.dir, ownerEntryName(lock)));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  clearStaleLock(
    lock.dir,
    names.filter((name) => name !== ownerEntryName(lock)),
  );
}

/** Closes and removes the lock; returns whether a Stop was requested while this start held it. */
export function releaseInstallLock(lock) {
  const { stopRequested } = closeInstallLock(lock);
  removeInstallLock(lock);
  return stopRequested;
}

// Whether a start (not npm alone) holds the lock and has not closed it.
function acceptsStop(names) {
  return names !== undefined && hasStartEntry(names) && !hasClosingEntry(names);
}

/**
 * Records a Stop in the lock of the start that installs Keiko. Returns false when no start holds
 * the lock or it is closing, so the caller stops Keiko itself. Only the entry of the start counts
 * (running and renewing), never npm's alone: a start that ended while npm still runs cannot stop
 * Keiko after the installation. The entry counts only while the start's entry is still there and
 * no closing entry follows it.
 */
export function requestStop(root) {
  const dir = installLockPath(root);
  if (!renewalObserved(dir, START_KINDS)) return false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (!acceptsStop(lockEntries(dir))) return false;
    const name = `stop-${lockToken()}`;
    if (!createLockEntry(join(dir, name))) continue;
    const after = lockEntries(dir);
    if (after?.includes(name) && acceptsStop(after)) return true;
    rmSync(join(dir, name), { force: true });
  }
  return false;
}

// Whether npm installs a lockfile package on this computer: a `!name` in its `os` or `cpu` list
// excludes this computer, any other name there restricts the package to the computers named.
function forThisComputer(list, current) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (list.includes(`!${current}`)) return false;
  const named = list.filter((name) => typeof name === "string" && !name.startsWith("!"));
  return named.length === 0 || named.includes(current);
}

// Whether npm must install an optional package: npm leaves out one whose `engines` this Node.js or
// npm does not meet, which only npm can evaluate. Such a package is required only when it is the
// Coding runtime, whose versions match the folder's Node.js.
function optionalRequired(lockPath, entry) {
  return (
    entry.optional !== true || entry.engines === undefined || CODING_RUNTIME_PACKAGE.test(lockPath)
  );
}

// A package `npm ci` installs here: not a development package, and meant for this computer. One
// restricted by its C library is left to npm, which can tell glibc from musl, and so are the
// packages only it needs; off Linux npm installs none of them.
function expectedHere(lockPath, entry, platform, arch) {
  return (
    entry.dev !== true &&
    entry.link !== true &&
    entry.libc === undefined &&
    typeof entry.version === "string" &&
    forThisComputer(entry.os, platform) &&
    forThisComputer(entry.cpu, arch) &&
    optionalRequired(lockPath, entry)
  );
}

function installedVersion(root, lockPath) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, ...lockPath.split("/"), "package.json"), "utf8"),
    );
    return isRecord(manifest) ? manifest.version : undefined;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

// The names a lockfile package depends on. An optional peer is installed only when another
// package needs it, so it is reached through that package or not at all.
function dependencyNames(entry) {
  const peerMeta = isRecord(entry.peerDependenciesMeta) ? entry.peerDependenciesMeta : {};
  return DEPENDENCY_FIELDS.flatMap((field) =>
    isRecord(entry[field])
      ? Object.keys(entry[field]).filter(
          (name) => field !== "peerDependencies" || peerMeta[name]?.optional !== true,
        )
      : [],
  );
}

// The lockfile path npm resolves `name` to from the package at `from`: the nearest node_modules
// folder at or above `from` that holds it.
function resolvedLockPath(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (isRecord(packages[candidate])) return candidate;
    if (base === "") return undefined;
    const cut = base.lastIndexOf("/node_modules/");
    base = cut < 0 ? "" : base.slice(0, cut);
  }
}

// A linked package's own dependencies resolve from the folder it links to.
function linkedFolder(packages, entry) {
  if (entry.link !== true || typeof entry.resolved !== "string") return undefined;
  return isRecord(packages[entry.resolved]) ? entry.resolved : undefined;
}

/**
 * The lockfile paths npm installs here: every package reached from the folder's own package
 * through packages meant for this computer. npm leaves an optional package of another computer
 * out together with the packages only it needs, nested or hoisted, so neither is looked for; a
 * package another installed package needs is. A lock without the folder's own entry is not one
 * npm writes; then every package meant for this computer is looked for.
 */
function packagesNpmInstalls(packages, platform, arch) {
  if (!isRecord(packages[""])) return undefined;
  const reached = new Set([""]);
  const installed = new Set();
  const queue = [""];
  while (queue.length > 0) {
    const from = queue.shift();
    for (const name of dependencyNames(packages[from])) {
      const target = resolvedLockPath(packages, from, name);
      if (target === undefined || reached.has(target)) continue;
      reached.add(target);
      const entry = packages[target];
      const linked = linkedFolder(packages, entry);
      if (linked !== undefined && !reached.has(linked)) {
        reached.add(linked);
        queue.push(linked);
      }
      if (!expectedHere(target, entry, platform, arch)) continue;
      installed.add(target);
      queue.push(target);
    }
  }
  return installed;
}

/**
 * The packages package-lock.json names for this computer that are not installed in its version.
 * npm's exit code alone does not prove an installation: an inherited setting can make `npm ci`
 * succeed while it installs nothing, or leaves out this platform's optional Coding runtime.
 */
export function missingFromInstallation(root, platform = process.platform, arch = process.arch) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const packages = isRecord(lock?.packages) ? lock.packages : {};
  const installs = packagesNpmInstalls(packages, platform, arch);
  return Object.entries(packages)
    .filter(([lockPath, entry]) => lockPath.startsWith("node_modules/") && isRecord(entry))
    .filter(([lockPath, entry]) =>
      installs === undefined
        ? expectedHere(lockPath, entry, platform, arch)
        : installs.has(lockPath),
    )
    .filter(([lockPath, entry]) => installedVersion(root, lockPath) !== entry.version)
    .map(([lockPath]) =>
      lockPath.slice(lockPath.lastIndexOf("node_modules/") + "node_modules/".length),
    );
}

function installedCompletely(root, logsDir) {
  const missing = missingFromInstallation(root);
  if (missing.length === 0) return true;
  say(
    `npm ended without installing ${String(missing.length)} package(s) package-lock.json names for this computer, among them ${missing[0]}. An npm setting of this computer may leave packages out; tell your administrator. npm's log: ${logsDir}`,
    `npm hat ${String(missing.length)} Paket(e), die package-lock.json fuer diesen Computer nennt, nicht installiert, darunter ${missing[0]}. Eine npm-Einstellung dieses Computers laesst womoeglich Pakete aus; sag deinem Administrator Bescheid. Das Protokoll von npm: ${logsDir}`,
  );
  return false;
}

/**
 * The arguments that let npm's own process hold the installation lock while it runs: npm imports
 * this file, which adds an owner entry for npm's process to the lock and removes it when npm exits.
 * A start that ends while npm still runs, killed alone, then leaves a lock that still holds. `keep`
 * names the owner entry of the start that runs npm. npm's process only checks that it is still
 * there and never renews it: that entry stays the start's own signal, so it stops changing when the
 * start's process ends, whatever npm does.
 */
export function holdArgs(lockDir, keep) {
  const url = new URL(import.meta.url);
  url.search = "";
  url.searchParams.set(HOLD_PARAMETER, lockDir);
  if (keep !== undefined) url.searchParams.set(KEEP_PARAMETER, keep);
  return ["--import", url.href];
}

// Writes the current time over the timestamp of an owner entry that is still in the lock; false
// once it is gone, so a lock released or taken over meanwhile is never recreated. The file is
// written in place and never emptied: a write that fails leaves the last valid timestamp.
function renewOwnerEntry(path, write = writeSync) {
  let fd;
  try {
    fd = openSync(path, "r+");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  try {
    const bytes = Buffer.from(`${String(Date.now())}\n`, "utf8");
    if (write(fd, bytes, 0, bytes.length, 0) !== bytes.length) {
      throw Object.assign(new Error("the owner entry could not be renewed"), { code: "EIO" });
    }
    ftruncateSync(fd, bytes.length);
  } finally {
    closeSync(fd);
  }
  return true;
}

// Renews npm's own entry and returns whether the lock is lost: the entry is gone (the lock was
// released or taken over), or the start's entry `keep` is. npm must end then. The start's entry is
// only read: renewing it from here would let a start whose window closed look alive for as long as
// npm runs. A failed renewal is said once per hold and the entry left as it was, so its expiry
// still applies; it never ends npm.
function renewHeld(dir, entry, keep, failure, write) {
  let lost = keep !== undefined && lockEntries(dir)?.includes(keep) !== true;
  try {
    if (!renewOwnerEntry(entry, write)) lost = true;
  } catch (error) {
    if (!failure.reported) {
      failure.reported = true;
      say(
        `Keiko could not renew its installation lock (${String(error?.code ?? "unknown")}). If its entry goes unrenewed for a minute, another start may begin an installation beside it.`,
        `Keiko konnte seine Installationssperre nicht erneuern (${String(error?.code ?? "unbekannt")}). Bleibt der Eintrag eine Minute lang unerneuert, kann ein anderer Start daneben eine Installation beginnen.`,
      );
    }
  }
  return lost;
}

function renewalTimer(renew) {
  const timer = setInterval(renew, LOCK_RENEW_MS);
  // The renewal never keeps npm's process running.
  timer.unref();
  return () => clearInterval(timer);
}

// npm's process lost its lock: another start took it over, so two npm processes must never install
// into the same folder, and this one ends at once without writing further.
function endNpmLockLost() {
  say(
    "Keiko's installation lock was taken over by another start, so this npm ends. Start Keiko again.",
    "Die Installationssperre von Keiko wurde von einem anderen Start uebernommen, daher endet dieses npm. Starte Keiko erneut.",
  );
  process.exit(1);
}

function lockNotJoined() {
  return Object.assign(
    new Error("the installation lock is not the one of the start that ran npm"),
    {
      code: "ELOCKGEN",
    },
  );
}

// An npm entry this process creates in the lock `dir`, or undefined when no lock is there.
function createOwnerEntry(dir) {
  const entry = join(dir, `npm-${lockToken()}`);
  let fd;
  try {
    fd = openSync(entry, "wx", 0o600);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    writeAll(fd, `${String(Date.now())}\n`);
  } finally {
    closeSync(fd);
  }
  return entry;
}

// The entry of the start that requested the hold, which must be in the lock now and still after
// npm's own entry was added: only then npm joined the generation that start acquired.
function joinedEntries(dir, keep) {
  if (LOCK_ENTRY.exec(keep)?.[1] !== "owner") throw lockNotJoined();
  if (lockEntries(dir)?.includes(keep) !== true) throw lockNotJoined();
  const entry = createOwnerEntry(dir);
  if (entry === undefined || lockEntries(dir)?.includes(keep) !== true) {
    if (entry !== undefined) rmSync(entry, { force: true });
    throw lockNotJoined();
  }
  return entry;
}

/**
 * Adds an entry for this process to the installation lock `dir`, renews it every few seconds while
 * the process runs and removes it when the process exits: the lock holds as long as npm runs. The
 * start's entry `keep` is renewed by the start alone; npm only verifies it is still there.
 * When a start requested the hold (`keep`), npm runs only joined to the generation that start
 * acquired: a missing lock, a missing `keep` entry or a replaced lock throws (code `ELOCKGEN`), and
 * a lock lost while npm runs ends npm through `onLost`. Without `keep` no hold was requested, and
 * without a lock there is nothing to join.
 */
export function holdInstallLock(dir, options = {}) {
  const {
    keep,
    onExit = (listener) => process.once("exit", listener),
    every = renewalTimer,
    onLost = endNpmLockLost,
    write = writeSync,
  } = options;
  const entry = keep === undefined ? createOwnerEntry(dir) : joinedEntries(dir, keep);
  if (entry === undefined) return undefined;
  const failure = { reported: false };
  const stopRenewing = every(() => {
    if (renewHeld(dir, entry, keep, failure, write)) onLost();
  });
  onExit(() => {
    stopRenewing();
    rmSync(entry, { force: true });
  });
  return entry;
}

// npm's process imports this file with the lock to hold (`holdArgs`); nothing else runs then. npm
// must not install without its entry, so a lock it cannot hold, or one that is no longer the lock
// of the start that ran it, ends npm with the reason.
function holdFromImport(params) {
  try {
    holdInstallLock(params.get(HOLD_PARAMETER), { keep: params.get(KEEP_PARAMETER) ?? undefined });
  } catch (error) {
    if (error?.code === "ELOCKGEN") {
      say(
        "Keiko's installation lock is no longer the one of the start that ran npm, so npm does not install. Start Keiko again.",
        "Die Installationssperre von Keiko ist nicht mehr die des Starts, der npm gestartet hat, daher installiert npm nicht. Starte Keiko erneut.",
      );
      process.exit(1);
    }
    say(
      `Keiko could not hold its installation lock (${String(error?.code ?? "unknown")}), so npm does not install. Check the access rights of the folder "system", then start Keiko again.`,
      `Keiko konnte seine Installationssperre nicht halten (${String(error?.code ?? "unbekannt")}), daher installiert npm nicht. Pruefe die Zugriffsrechte des Ordners "system" und starte Keiko dann erneut.`,
    );
    process.exit(1);
  }
}

function runNpm(root, nodeDir, env, run, lock) {
  const npmCli = npmCliCandidates(nodeDir).find((candidate) => existsSync(candidate));
  if (npmCli === undefined) {
    say(
      'Keiko is incomplete: npm is missing in the folder "system".',
      'Keiko ist unvollstaendig: Im Ordner "system" fehlt npm.',
    );
    return false;
  }
  const registryNamed = folderRegistry(root, env);
  const state = stateDir(env);
  refuseForeignInstallTarget(root);
  say(
    "Keiko is loaded from the npm registry. The first start can take a few minutes.",
    "Keiko wird aus der npm-Registry geladen. Der erste Start kann einige Minuten dauern.",
  );
  rmSync(join(root, "node_modules", INSTALLED_MARKER), { force: true });
  // Keiko creates its data folder owner-private; npm, which runs first, must not create it wider.
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const logsDir = ownedLogsDir(state);
  // A cache of this attempt only, owner-private: nothing that was there before is touched, and the
  // downloads are not needed again once the packages are in node_modules.
  const cacheDir = mkdtempSync(join(state, "npm-cache-"));
  try {
    const keep = lock === undefined ? undefined : `owner-${lock.token}`;
    const args = [
      ...holdArgs(installLockPath(root), keep),
      ...installArgs(npmCli, root, cacheDir, logsDir),
    ];
    const result = run(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      env: npmEnv(env, nodeDir, registryNamed),
    });
    if (result.status === 0 && existsSync(keikoCliPath(root)))
      return installedCompletely(root, logsDir);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
  say(
    `Keiko could not be loaded from the npm registry. Check the network connection and the file .npmrc in this folder, or tell your administrator. npm's log: ${logsDir}`,
    `Keiko konnte nicht aus der npm-Registry geladen werden. Pruefe die Netzwerkverbindung und die Datei .npmrc in diesem Ordner oder sag deinem Administrator Bescheid. Das Protokoll von npm: ${logsDir}`,
  );
  return false;
}

/**
 * Installs Keiko unless the last complete installation was of this lockfile; the caller holds
 * `lock`, whose owner entry npm's process keeps renewed while it installs.
 */
export function ensureInstalled(root, nodeDir, env, run = spawnSync, lock = undefined) {
  const digest = lockfileDigest(root);
  if (installationCurrent(root, digest)) return true;
  refuseLostLock(lock);
  if (!runNpm(root, nodeDir, env, run, lock)) return false;
  refuseLostLock(lock);
  const fd = openSync(join(root, "node_modules", INSTALLED_MARKER), "w");
  try {
    writeAll(fd, `${digest}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Why the system refused to start Keiko's process: only its error code, never a path. */
function reportStartRefused(error) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code === "ENOENT") {
    say(
      'Keiko is incomplete: the Node.js runtime is missing in the folder "system". Unpack the folder again.',
      'Keiko ist unvollstaendig: Im Ordner "system" fehlt die Node.js-Laufzeit. Entpacke den Ordner noch einmal.',
    );
    return;
  }
  say(
    `Keiko could not be started (${code ?? "unknown error"}).`,
    `Keiko konnte nicht gestartet werden (${code ?? "unbekannter Fehler"}).`,
  );
}

// Runs Keiko's command line. `spawned` is false when the system refused to start it: no child ran,
// so nothing was launched.
function spawnKeiko(root, args, env, run) {
  const result = run(process.execPath, [keikoCliPath(root), ...args], {
    cwd: root,
    stdio: "inherit",
    env: keikoEnv(env),
  });
  if (result.error !== undefined) {
    // No child ran, so nothing else would say why Start or Stop ended here.
    reportStartRefused(result.error);
    return { code: 1, spawned: false };
  }
  return { code: result.status ?? 1, spawned: true };
}

function runKeiko(root, args, env, run) {
  return spawnKeiko(root, args, env, run).code;
}

export function startArgs(root, env) {
  const args = ["start", "--state-dir", stateDir(env)];
  const config = join(root, CONFIG_NAME);
  return existsSync(config) ? [...args, "--provisioned-config", config] : args;
}

function stopKeiko(root, state, env, run) {
  return runKeiko(root, ["stop", "--state-dir", state], env, run);
}

function reportRunning() {
  say(
    "Keiko is running in your browser. You can close this window.",
    "Keiko laeuft in deinem Browser. Du kannst dieses Fenster schliessen.",
  );
}

// The records of `dir`, in the order they were written (the newest last).
function generationRecords(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const written = [];
  for (const name of names.filter((entry) => entry.startsWith(GENERATION_PREFIX))) {
    try {
      written.push({ name, at: statSync(join(dir, name)).mtimeMs });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return written
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
    .map(({ name }) => name);
}

// The token of the newest record of `dir`, or "" when none exists.
function newestGeneration(dir) {
  for (const name of generationRecords(dir).reverse()) {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return "";
}

/**
 * The token of the start that opened Keiko last in this folder, or "" when none did. It outlives
 * the lock, so a Stop that waited for the lock can tell that a start opened Keiko meanwhile.
 */
export function startGeneration(root) {
  return newestGeneration(join(root, GENERATION_DIR));
}

/** The same for every package folder that uses the data folder `state`. */
export function stateGeneration(state) {
  return newestGeneration(state);
}

// Publishes the record of the start that holds `lock` in `dir` and returns whether it did. The
// record has a name of its own, so it never replaces another one, and only records that were there
// before the lock was checked are removed, which makes them older than this start's lock
// generation. The records are listed first, the lock checked second, the record published third and
// the lock checked again: a start that lost its lock at any point leaves the newer record of its
// replacement alone and withdraws only its own.
function publishLaunchRecord(dir, lock) {
  const own = `${GENERATION_PREFIX}${lock.token}`;
  const earlier = generationRecords(dir).filter((name) => name !== own);
  if (heldEntries(lock) === undefined) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  publishPrivateFile(join(dir, own), `${lock.token}\n`);
  if (heldEntries(lock) === undefined) {
    rmSync(join(dir, own), { force: true });
    return false;
  }
  for (const name of earlier) rmSync(join(dir, name), { force: true });
  return true;
}

// Written once the start's launch of Keiko happened: in this folder and, when `state` names it, in
// the data folder the package folders of the account share. Each record is published whole under
// its own name by the owner-private publisher and only while the start owns the lock generation it
// published, so a returning former owner never displaces what a replacement start recorded.
// Returns whether the start's records were written.
export function recordStartLaunch(root, lock, state = undefined) {
  if (!publishLaunchRecord(join(root, GENERATION_DIR), lock)) return false;
  return state === undefined || publishLaunchRecord(state, lock);
}

// While it holds the lock, this start installs Keiko and opens it, unless a Stop came first.
function installThenOpen(root, nodeDir, env, run, lock, args) {
  if (!ensureInstalled(root, nodeDir, env, run, lock)) return { outcome: "install-failed" };
  refuseLostLock(lock);
  if (heldStopRecorded(lock)) return { outcome: "cancelled" };
  const launch = spawnKeiko(root, args, env, run);
  // Only a start that opened Keiko (its command line ended with success) can supersede a Stop that
  // waits. A launch the system refused, or one the command line refused before it opened anything
  // (its lifecycle was busy), started nothing, and a failed one leaves it uncertain: none of them
  // may make an earlier Stop look as if Keiko had been started again.
  if (launch.spawned && launch.code === 0) recordStartLaunch(root, lock, stateDir(env));
  return { outcome: "opened", code: launch.code };
}

function reportStoppedWhileLoading(opened) {
  if (opened) {
    say(
      "Keiko was stopped again right after it opened: Stop was pressed while it was being loaded.",
      "Keiko wurde direkt nach dem Oeffnen wieder beendet: Waehrend es geladen wurde, wurde Beenden gedrueckt.",
    );
    return;
  }
  say(
    "Keiko was stopped while it was being loaded and does not start. You can close this window.",
    "Keiko wurde beendet, waehrend es geladen wurde, und startet nicht. Du kannst dieses Fenster schliessen.",
  );
}

// A Stop recorded while this start held the lock that the start could not carry out: the window
// says so instead of leaving the promise standing. A folder that could not load Keiko has no
// command line to stop one with; a start that ended with an error leaves the Stop to be repeated.
function reportStopNotCarriedOut(installed) {
  if (!installed) {
    say(
      "Stop was pressed while Keiko was being loaded, but this folder could not load Keiko and cannot stop it. If Keiko is open from another folder, stop it there.",
      "Beenden wurde gedrueckt, waehrend Keiko geladen wurde, aber dieser Ordner konnte Keiko nicht laden und kann es nicht beenden. Ist Keiko aus einem anderen Ordner geoeffnet, beende es dort.",
    );
    return;
  }
  say(
    "Stop was pressed while Keiko was being loaded, but this start ended with an error before it stopped Keiko. Double-click Stop Keiko again.",
    "Beenden wurde gedrueckt, waehrend Keiko geladen wurde, aber dieser Start endete mit einem Fehler, bevor er Keiko beendet hat. Doppelklicke erneut auf Stop Keiko.",
  );
}

// A Stop made while this start held the lock stops whatever opened: this start's Keiko, also one
// that reported a failure, or one an earlier start of the folder opened. Stopping a Keiko that does
// not run succeeds. `stop.code` is the result of a Stop already carried out under the lock.
function settleStart(step, stop) {
  if (step.outcome === "install-failed") {
    if (stop.stopRequested) reportStopNotCarriedOut(false);
    return 1;
  }
  if (!stop.stopRequested && step.outcome === "opened") {
    if (step.code === 0) reportRunning();
    return step.code;
  }
  // Why Keiko did not open says more than the Stop after it.
  if (step.code !== undefined && step.code !== 0) return step.code;
  if (stop.code !== 0) return stop.code;
  reportStoppedWhileLoading(step.outcome === "opened");
  return 0;
}

// A Stop this start's lock accepted is carried out while the start still holds that lock, and the
// lock is let go of only afterwards: no other start can open Keiko in between and see it stopped,
// and a Stop accepted here can never stop the Keiko a later start opened. A start that cancelled
// opening Keiko because it saw a Stop also carries it out here, whether or not the requester has
// withdrawn that provisional entry by now: the requester stops under the lock itself, and a stop
// of a Keiko that is not running succeeds, so what matters is that no stop runs once the lock is
// gone. A start that no longer owns its lock carries out neither kind of request: the lock, and
// every Stop recorded in it, belongs to the start that took it over.
function closeAndStop(root, env, run, lock, step, pause) {
  const closed = closeInstallLock(lock, pause);
  if (!closed.owned) {
    if (step.outcome === "cancelled") throw lostLockRefusal();
    return { stopRequested: false, code: undefined };
  }
  const stopRequested = closed.stopRequested || step.outcome === "cancelled";
  if (stopRequested && step.outcome !== "install-failed") {
    return { stopRequested, code: stopKeiko(root, stateDir(env), env, run) };
  }
  return { stopRequested, code: undefined };
}

// This start holds the lock until Keiko is open, so a Stop meanwhile is carried out before the lock
// goes, and a Stop after that finds Keiko open and stops it.
function installAndOpen(root, nodeDir, env, run, lock, args, pause) {
  let step;
  let stop;
  try {
    step = installThenOpen(root, nodeDir, env, run, lock, args);
    stop = closeAndStop(root, env, run, lock, step, pause);
  } catch (error) {
    if (releaseInstallLock(lock)) reportStopNotCarriedOut(true);
    throw error;
  }
  removeInstallLock(lock);
  return settleStart(step, stop);
}

/**
 * Installs Keiko when needed and starts it; returns Keiko's exit code. Every start holds the lock
 * until Keiko is open, also one that installs nothing, so a Stop meanwhile is never lost. It says
 * itself how the start ended: Keiko open, opened by another start of the folder, or stopped while
 * it was being loaded.
 */
function lockClosing(root) {
  const names = lockEntries(installLockPath(root));
  return names !== undefined && hasClosingEntry(names);
}

// A closing lock is let go shortly: its start opened Keiko, or a Stop is stopping it under the
// lock. A start waits for it and then takes the lock itself, instead of leaving it to a holder
// that is already done. Returns `{ lock }` once it holds the lock, `{ closing: true }` when the
// lock is still closing after the wait, and `{}` when the lock is held but not closing.
function acquireAfterClosing(root, pause) {
  const deadline = lockClock.now() + STOP_LOCK_WAIT_MS;
  for (;;) {
    const lock = acquireInstallLock(root, pause);
    if (lock !== undefined) return { lock };
    if (!lockClosing(root)) return {};
    if (lockClock.now() >= deadline) return { closing: true };
    lockClock.sleep(LOCK_OBSERVE_STEP_MS, installLockPath(root));
  }
}

// The wait for a closing lock ended in the lock or in a lock still closing after the wait.
const closingSettled = (step) => step.lock !== undefined || step.closing === true;

function reportInstallationRunning() {
  say(
    "Keiko is being installed by a window of this folder that was closed. This start waits for that installation to end.",
    "Keiko wird gerade von einem Fenster dieses Ordners installiert, das geschlossen wurde. Dieser Start wartet, bis diese Installation endet.",
  );
}

// Whether one of the start entries seen renewing is still in the lock and its start has not closed
// it: the lock may have changed hands while the renewal was observed, and an entry that renewed in
// a lock a Stop now closes belongs to a holder that opens nothing for this start.
function startStillOpening(dir, renewed) {
  const names = lockEntries(dir);
  if (names === undefined) return false;
  return renewed.some((name) => {
    const match = LOCK_ENTRY.exec(name);
    return names.includes(name) && !names.includes(`closing-${match[2]}-${match[3]}`);
  });
}

// A lock that is held but whose start does not renew: only npm of a start that was closed holds
// it. No window reports that installation's result and it cannot open Keiko, so a start that finds
// the lock so waits for that npm to end and then takes the lock itself. `another` is true when a
// start that renews holds the lock: that start opens Keiko and its window says whether it did.
// A lock that starts closing meanwhile (a later start opened Keiko and lets go, or a Stop acts under
// it) is waited for like the first one. `closing` is true when the lock is still closing after
// that wait: its holder opens nothing for this start.
function acquireAfterOrphanedNpm(root, pause) {
  const dir = installLockPath(root);
  const deadline = lockClock.now() + ORPHANED_NPM_WAIT_MS;
  let told = false;
  for (;;) {
    const lock = acquireInstallLock(root, pause);
    if (lock !== undefined) return { lock };
    if (lockClosing(root)) {
      const after = acquireAfterClosing(root, pause);
      if (closingSettled(after)) return after;
      continue;
    }
    if (startStillOpening(dir, renewedEntries(dir, lockEntryOf(START_KINDS)))) {
      return { another: true };
    }
    if (lockClock.now() >= deadline) return { another: false };
    if (!told) reportInstallationRunning();
    told = true;
    lockClock.sleep(LOCK_OBSERVE_STEP_MS, dir);
  }
}

function reportAnotherStart() {
  say(
    "Another start of this folder is opening Keiko. Its window says whether Keiko opened. You can close this one.",
    "Ein anderer Start dieses Ordners oeffnet Keiko gerade. Sein Fenster zeigt, ob Keiko geoeffnet wurde. Dieses kannst du schliessen.",
  );
}

function reportStillClosing() {
  say(
    "Keiko is still being closed by another window of this folder (a Stop that has not finished). Wait a moment, then start Keiko again.",
    "Keiko wird noch von einem anderen Fenster dieses Ordners beendet (ein Beenden, das noch nicht fertig ist). Warte einen Moment und starte Keiko dann erneut.",
  );
}

function reportStopStillActing() {
  say(
    "A Stop of this folder is still stopping Keiko, so this start does not open it yet. Wait a moment, then start Keiko again.",
    "Ein Beenden dieses Ordners beendet Keiko noch, daher oeffnet dieser Start es noch nicht. Warte einen Moment und starte Keiko dann erneut.",
  );
}

function reportInstallationStillRunning() {
  say(
    "An installation of Keiko in this folder is still running and no window reports it. Wait a minute, then start Keiko again.",
    "In diesem Ordner laeuft noch eine Installation von Keiko, deren Fenster geschlossen wurde. Warte eine Minute und starte Keiko dann erneut.",
  );
}

// The stop handoffs of Stops that act without a lock of their own and are renewing. A Stop renews
// its handoff for as long as it acts, so one whose process number runs but whose handoff does not
// change while it is watched belongs to a Stop that ended (its number was reused): it is removed,
// like one whose process number does not run at all.
function liveStopHandoffs(root) {
  const system = join(root, "system");
  return readdirSync(system).filter((name) => {
    const match = STOP_HANDOFF.exec(name);
    if (match === null) return false;
    const acts =
      pidAlive(match[1]) &&
      renewedEntries(system, (entry) => entry === name, installLockPath(root)).length > 0;
    if (!acts) rmSync(join(system, name), { force: true });
    return acts;
  });
}

// A start that holds the lock waits until no Stop acts under a handoff: that Stop decided before
// this start took the lock, so its stop must not land on the Keiko this start opens. Returns false
// when a Stop was still acting after the same wait a Stop gives the lock.
function awaitStopHandoffs(root) {
  const deadline = lockClock.now() + STOP_LOCK_WAIT_MS;
  while (liveStopHandoffs(root).length > 0) {
    if (lockClock.now() >= deadline) return false;
    lockClock.sleep(LOCK_OBSERVE_STEP_MS, installLockPath(root));
  }
  return true;
}

function lockRefused(closing, another) {
  if (closing) {
    reportStillClosing();
    return 1;
  }
  if (another) {
    reportAnotherStart();
    return 0;
  }
  reportInstallationStillRunning();
  return 1;
}

export function start(root, nodeDir, env, run = spawnSync, pause = () => undefined) {
  const args = startArgs(root, env);
  const first = acquireAfterClosing(root, pause);
  const { lock, another, closing } = closingSettled(first)
    ? first
    : acquireAfterOrphanedNpm(root, pause);
  if (lock === undefined) return lockRefused(closing, another);
  if (!awaitStopHandoffs(root)) {
    if (releaseInstallLock(lock)) reportStopNotCarriedOut(true);
    reportStopStillActing();
    return 1;
  }
  return installAndOpen(root, nodeDir, env, run, lock, args, pause);
}

const STOP_LOCK_WAIT_MS = 90 * 1000;

function reportStopRecorded() {
  say(
    "Keiko is still being loaded. It does not stay open: the start that loads it stops it.",
    "Keiko wird noch geladen. Es bleibt nicht geoeffnet: Der Start, der es laedt, beendet es.",
  );
}

// Waits for the lock of a start that is closing. A later start that wins it before this Stop does
// records the Stop in its own lock instead (`recorded`): that start does not leave Keiko open, so
// this Stop must not act, or it would end the Keiko that start just reported running.
function waitForStopLock(root) {
  const deadline = lockClock.now() + STOP_LOCK_WAIT_MS;
  let lock = acquireInstallLock(root, undefined, { closing: true });
  while (lock === undefined && lockClock.now() < deadline) {
    if (requestStop(root)) return { recorded: true };
    lockClock.sleep(LOCK_OBSERVE_STEP_MS, installLockPath(root));
    lock = acquireInstallLock(root, undefined, { closing: true });
  }
  return { lock, recorded: false };
}

function reportStopLockLost() {
  say(
    "Another start of this folder took over the lock while Stop waited, so Stop did not act. Double-click Stop Keiko again.",
    "Ein anderer Start dieses Ordners hat die Sperre uebernommen, waehrend Beenden wartete, daher hat Beenden nicht gewirkt. Doppelklicke erneut auf Stop Keiko.",
  );
}

function reportStartCameAfterStop() {
  say(
    "Keiko was started again while Stop waited, and that start came after it, so Keiko stays open. Double-click Stop Keiko again to stop it.",
    "Keiko wurde erneut gestartet, waehrend Beenden wartete, und dieser Start kam danach, daher bleibt Keiko geoeffnet. Doppelklicke erneut auf Stop Keiko, um es zu beenden.",
  );
}

// The two start records a Stop is bound to: this folder's and the data folder's, which every
// package folder using the same data shares.
function readRecords(root, state) {
  return { folder: startGeneration(root), shared: stateGeneration(state) };
}

// What a Stop saw when it was pressed: the start records, and the starts that held the lock then.
// A start that held the lock at that moment came before the Stop, whenever it finished, so only a
// record that names neither the one seen nor a holder seen belongs to a start that came after. The
// data folder's record binds the Stop to the starts of every folder that uses it: a start of
// another package folder that opened Keiko while the Stop waited came after it. The reads must
// agree: a start that records its launch and lets go of the lock between them would show the
// earlier record and no holder, and look like a start that came after the Stop. The reads are
// repeated until both records are the same on both sides of the holder listing.
function observeStart(root, state, pause = () => undefined) {
  let records = readRecords(root, state);
  for (let attempt = 0; attempt < OBSERVE_ATTEMPTS; attempt += 1) {
    pause("observe");
    const holders = new Set(
      (lockEntries(installLockPath(root)) ?? [])
        .map((name) => LOCK_ENTRY.exec(name))
        .filter((match) => match?.[1] === "owner")
        .map((match) => `${match[2]}-${match[3]}`),
    );
    const after = readRecords(root, state);
    if (after.folder === records.folder && after.shared === records.shared) {
      return { records, holders, state };
    }
    records = after;
  }
  return { records, holders: new Set([records.folder.trim(), records.shared.trim()]), state };
}

function startCameAfter(root, seen) {
  const later = (current, before) => current !== before && !seen.holders.has(current.trim());
  return (
    later(startGeneration(root), seen.records.folder) ||
    later(stateGeneration(seen.state), seen.records.shared)
  );
}

// A Stop the lock turned away (its start is closing) acts under the lock itself: it waits until
// that start has let go, takes the lock, closes it so no further Stop is recorded in it, and only
// then stops Keiko. No start opens Keiko between the Stop's decision and its effect, so the Stop
// can never end the Keiko a newer start opened.
function stopUnderLock(root, state, env, run, seen) {
  const { lock, recorded } = waitForStopLock(root);
  if (recorded) {
    reportStopRecorded();
    return 0;
  }
  if (lock === undefined) {
    say(
      "Another start of this folder is still opening Keiko, so Stop did not act. Double-click Stop Keiko again in a moment.",
      "Ein anderer Start dieses Ordners oeffnet Keiko noch, daher hat Beenden nicht gewirkt. Doppelklicke gleich erneut auf Stop Keiko.",
    );
    return 1;
  }
  try {
    if (!closeInstallLock(lock).owned) {
      reportStopLockLost();
      return 1;
    }
    if (startCameAfter(root, seen)) {
      reportStartCameAfterStop();
      return 0;
    }
    return stopNow(root, state, env, run);
  } finally {
    removeInstallLock(lock);
  }
}

// The lock holds a start that runs: it, not npm alone, decides what opens Keiko.
function startHoldsLock(root) {
  const names = lockEntries(installLockPath(root));
  return names !== undefined && hasStartEntry(names);
}

// Only npm of a start that already ended holds the lock, so this Stop acts without one. It leaves
// a handoff first, which outlives npm, and every start that takes the lock afterwards waits for it
// (`awaitStopHandoffs`) before it opens Keiko: the stop can never land on a Keiko that start
// opened. Written before the lock is looked at again, so a start either sees the handoff or is seen
// holding the lock; in that case the Stop withdraws and acts under the lock like any other.
function stopUnderHandoff(root, state, env, run, seen, pause) {
  const handoff = join(root, "system", `keiko-npm-stop-handoff-${lockToken()}`);
  closeSync(openSync(handoff, "wx", 0o600));
  // Renewed from a worker thread, because the stop command blocks this one.
  const stopRenewing = lockRenewal.start(handoff);
  pause("handoff");
  if (startHoldsLock(root)) {
    stopRenewing();
    rmSync(handoff, { force: true });
    return stopUnderLock(root, state, env, run, seen);
  }
  try {
    if (startCameAfter(root, seen)) {
      reportStartCameAfterStop();
      return 0;
    }
    return stopNow(root, state, env, run);
  } finally {
    stopRenewing();
    rmSync(handoff, { force: true });
  }
}

function stopNow(root, state, env, run) {
  const code = stopKeiko(root, state, env, run);
  if (code === 0) {
    say(
      "Keiko is stopped. You can close this window.",
      "Keiko ist beendet. Du kannst dieses Fenster schliessen.",
    );
  }
  return code;
}

// Only npm of a start that already ended holds the lock: no start can open Keiko until that npm
// ends, and a Stop must not wait for it, so it acts at once.
function onlyNpmHoldsLock(root) {
  const names = lockEntries(installLockPath(root));
  return (
    names !== undefined &&
    !hasStartEntry(names) &&
    renewalObserved(installLockPath(root), HOLDER_KINDS)
  );
}

/**
 * Stops a running Keiko. While a start of this folder is still loading Keiko, the Stop is recorded
 * in its lock and that start does not leave Keiko open. A folder Keiko was never loaded into has
 * nothing to stop.
 */
export function stop(root, env, run = spawnSync, pause = () => undefined) {
  const state = stateDir(env);
  // The start record and the starts holding the lock as this Stop was pressed, read before it asks
  // the lock: a start that opens Keiko while the lock answers, or later while the Stop waits, and
  // that was not holding the lock now, came after this Stop.
  const seen = observeStart(root, state, pause);
  if (requestStop(root)) {
    reportStopRecorded();
    return 0;
  }
  if (!existsSync(keikoCliPath(root))) {
    say("Keiko is not running.", "Keiko laeuft nicht.");
    return 0;
  }
  return onlyNpmHoldsLock(root)
    ? stopUnderHandoff(root, state, env, run, seen, pause)
    : stopUnderLock(root, state, env, run, seen);
}

// The gateway connection Gateway Setup verified, and what it built from it. One token covers only
// these blocks: a model or reranker with another endpoint, header or credential never receives it.
const DEFAULT_KEY_HEADER = "authorization";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A loop, not `/\/+$/`: a run of `/` before other text makes that pattern retry at every slash.
function withoutTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47 /* '/' */) end -= 1;
  return value.slice(0, end);
}

function baseUrlIdentity(value) {
  if (typeof value !== "string") return undefined;
  try {
    return withoutTrailingSlashes(new URL(value.trim()).href);
  } catch {
    return withoutTrailingSlashes(value.trim());
  }
}

// The capability Keiko reads for a model, as the gateway's configuration loader merges them: an
// entry of the top-level `capabilities` list with the model's id wins over the provider's own
// `capability`, where Gateway Setup stores a gateway-managed voice deployment it found.
function capabilityOf(config, provider) {
  const listed = Array.isArray(config.capabilities)
    ? config.capabilities.find(
        (capability) => isRecord(capability) && capability.id === provider.modelId,
      )
    : undefined;
  if (listed !== undefined) return listed;
  return isRecord(provider.capability) ? provider.capability : undefined;
}

// The main chat connection, as Gateway Setup reads it: the first chat model (a model without a
// capability entry is a chat model), else the first model that is not a voice deployment.
function primaryProvider(config) {
  const kind = (provider) => capabilityOf(config, provider)?.kind;
  const providers = config.providers.filter(isRecord);
  return (
    providers.find((provider) => kind(provider) === undefined || kind(provider) === "chat") ??
    providers.find((provider) => kind(provider) !== "voice")
  );
}

function sameConnection(block, primary) {
  const header = (candidate) => (candidate.apiKeyHeaderName ?? DEFAULT_KEY_HEADER).toLowerCase();
  return (
    baseUrlIdentity(block.baseUrl) !== undefined &&
    baseUrlIdentity(block.baseUrl) === baseUrlIdentity(primary.baseUrl) &&
    header(block) === header(primary)
  );
}

// Gateway Setup marks what it built from the connection it verified: every chat and embedding model
// carries `catalogOrigin`, and a voice provider it proved to share the gateway's credential carries
// `credentialOrigin` (as the reranker does). A voice deployment needs both that mark and the
// gateway-managed locality the gateway's loader reads: a locality alone survives a voice key rotated
// on its own, and the mark alone says nothing about a deployment Keiko reaches outside the gateway.
// A model entered with its own credential carries neither mark, even on the same endpoint.
function builtFromConnection(config, provider, primary) {
  if (provider === primary) return true;
  if (provider.endpointStyle !== primary.endpointStyle) return false;
  if (provider.apiVersion !== primary.apiVersion) return false;
  if (!sameConnection(provider, primary)) return false;
  if (provider.catalogOrigin !== undefined) return true;
  const capability = capabilityOf(config, provider);
  return (
    provider.credentialOrigin === "gateway-connection" &&
    capability?.kind === "voice" &&
    capability.voiceProviderLocality === "gateway-managed"
  );
}

function filledText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Whether the gateway's loader takes a key from this environment value: any value that is not
// empty, blanks included.
function setInEnvironment(value) {
  return typeof value === "string" && value.length > 0;
}

// The gateway's own name for a model's key variable: every UTF-16 code unit other than a letter or
// a digit becomes `_`, then upper case. The expression has no `u` flag, as the loader's has none,
// so a character outside the Basic Multilingual Plane becomes two `_` there and here alike.
function modelKeyVariable(modelId) {
  return `KEIKO_MODEL_${modelId.replaceAll(/[^A-Za-z0-9]/g, "_").toUpperCase()}_API_KEY`;
}

// A block whose key Gateway Setup kept out of the file: no sealed key, no key in the file, and no
// other model's key it follows.
function keyOutsideFile(block) {
  return (
    block.apiKeySecretRef === undefined &&
    !filledText(block.apiKey) &&
    !filledText(block.apiKeySourceModelId)
  );
}

// The environment variable a block draws its key from on this computer, as the gateway's loader
// resolves it; undefined when its key is in the file or it needs none.
function environmentKey(block, env, specific) {
  if (!keyOutsideFile(block)) return undefined;
  if (setInEnvironment(env[specific])) return specific;
  return setInEnvironment(env.KEIKO_DEFAULT_API_KEY) ? "KEIKO_DEFAULT_API_KEY" : undefined;
}

/**
 * The models (and reranker) whose key this computer takes from an environment variable, which
 * Gateway Setup keeps out of the saved file: an exported file would leave the team without a key.
 */
export function environmentKeys(config, env) {
  const providers = Array.isArray(config.providers) ? config.providers.filter(isRecord) : [];
  const found = providers
    .map((provider) => ({
      name: blockName(provider, "a model"),
      variable: filledText(provider.modelId)
        ? environmentKey(provider, env, modelKeyVariable(provider.modelId))
        : undefined,
    }))
    .filter(({ variable }) => variable !== undefined);
  if (isRecord(config.reranker)) {
    const variable = environmentKey(config.reranker, env, "KEIKO_RERANKER_API_KEY");
    if (variable !== undefined) found.push({ name: "the reranker", variable });
  }
  return found;
}

function refuseEnvironmentKeys(config, env) {
  const found = environmentKeys(config, env);
  if (found.length === 0) return;
  const named = found.map(({ name, variable }) => `${name} (${variable})`).join(", ");
  throw new LauncherRefusal(
    `Keiko takes the key of ${named} from an environment variable of this computer, which the team's computers do not have. Unset the variable, enter the key in Gateway Setup, stop Keiko, then run this again.`,
    `Keiko nimmt den Schluessel von ${named} aus einer Umgebungsvariable dieses Computers, die die Computer des Teams nicht haben. Entferne die Variable, gib den Schluessel in der Gateway-Einrichtung ein, beende Keiko und fuehre dies dann erneut aus.`,
  );
}

function blockName(block, fallback) {
  return typeof block?.modelId === "string" ? block.modelId : fallback;
}

/** The sealed blocks of a configuration: providers first, then a reranker, with their test. */
function sealedBlocks(config, primary) {
  const providers = Array.isArray(config.providers) ? config.providers.filter(isRecord) : [];
  const blocks = providers.map((provider) => ({
    block: provider,
    fallback: "a model",
    verified: () => builtFromConnection(config, provider, primary),
  }));
  if (isRecord(config.reranker)) {
    const reranker = config.reranker;
    blocks.push({
      block: reranker,
      fallback: "the reranker",
      // Address and header alone do not show whose key it is: Gateway Setup marks the reranker it
      // proved to share the gateway's credential (`credentialOrigin`), never one with its own key.
      verified: () =>
        sameConnection(reranker, primary) && reranker.credentialOrigin === "gateway-connection",
    });
  }
  return blocks.filter(({ block }) => block.apiKeySecretRef !== undefined);
}

/**
 * Which keys sealed on this computer the team token replaces (`token`), and which belong to another
 * connection (`foreign`, by model name). A reranker shares the token only on the gateway's own
 * endpoint and header, exactly where Gateway Setup wires a discovered one.
 */
export function credentialScope(config) {
  const providers = Array.isArray(config.providers) ? config.providers.filter(isRecord) : [];
  const primary = providers.length > 0 ? primaryProvider(config) : undefined;
  const token = new Set();
  const foreign = [];
  for (const { block, fallback, verified } of sealedBlocks(config, primary)) {
    if (primary !== undefined && verified()) token.add(block);
    else foreign.push(blockName(block, fallback));
  }
  return { token, foreign };
}

export function needsToken(config) {
  return credentialScope(config).token.size > 0;
}

function withToken(block, scope, token) {
  if (!scope.token.has(block)) return block;
  const kept = Object.entries(block).filter(([field]) => field !== "apiKeySecretRef");
  return { ...Object.fromEntries(kept), apiKey: token };
}

/**
 * The configuration Gateway Setup saved on this computer, made usable on every other one: a key
 * sealed into this computer's vault (`apiKeySecretRef`) names nothing elsewhere, so on the verified
 * gateway connection it becomes the token the administrator enters. A key of any other connection
 * refuses: one token must never reach a service it was not verified for. Throws a message a person
 * can act on.
 */
export function teamConfig(config, token) {
  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    throw new Error("the configuration names no models");
  }
  for (const provider of config.providers) {
    if (!filledText(provider?.modelId) || !filledText(provider.baseUrl)) {
      throw new TypeError("a model in the configuration names no modelId or baseUrl");
    }
  }
  const scope = credentialScope(config);
  if (scope.foreign.length > 0) {
    const names = scope.foreign.join(", ");
    throw new LauncherRefusal(
      `This configuration uses more than one credential: ${names} has its own connection. The access step writes one gateway token. Remove the other connection in Gateway Setup, or prepare keiko.config.json by hand with every key.`,
      `Diese Konfiguration nutzt mehr als einen Zugang: ${names} hat eine eigene Verbindung. Der Zugangsschritt schreibt ein Gateway-Token. Entferne die andere Verbindung in der Gateway-Einrichtung oder erstelle keiko.config.json von Hand mit allen Schluesseln.`,
    );
  }
  const providers = config.providers.map((provider) => withToken(provider, scope, token));
  return config.reranker === undefined
    ? { ...config, providers }
    : { ...config, providers, reranker: withToken(config.reranker, scope, token) };
}

const ENTER = new Set(["\r", "\n"]);
const ERASE = new Set(["\u007f", "\b"]);
const CANCEL = "\u0003";
const ESCAPE = "\u001b";

// ESC [ parameters final-byte (CSI) or ESC O final-byte (SS3): an arrow, Home or Delete key, never
// part of a token. Returns the next state, or undefined when the character is not part of a key:
// after a lone ESC (the Escape key itself) a character is typed as usual.
function escapeState(state, character) {
  if (state === "escape") {
    if (character === "[") return "csi";
    if (character === "O") return "ss3";
    return character === ESCAPE ? "escape" : undefined;
  }
  if (state === "ss3") return "none";
  const code = character.codePointAt(0);
  return code >= 0x40 && code <= 0x7e ? "none" : "csi";
}

function typeCharacter(token, character) {
  if (ERASE.has(character)) token.pop();
  else if (character.codePointAt(0) >= 0x20) token.push(character);
}

/**
 * Applies one chunk of raw terminal input to the token typed so far. A terminal may hand one key
 * over in two reads, so `escape` carries the state of an unfinished key into the next chunk.
 * Enter and Ctrl+C are never part of a key sequence, so they end the input in every state: an
 * unfinished key cannot swallow them and leave the terminal in raw mode.
 */
export function tokenInput(value, chunk, escape = "none") {
  const token = [...value];
  let state = escape;
  for (const character of chunk) {
    if (ENTER.has(character)) return { value: token.join(""), end: "enter", escape: "none" };
    if (character === CANCEL) return { value: "", end: "cancel", escape: "none" };
    const next = state === "none" ? undefined : escapeState(state, character);
    if (next !== undefined) state = next;
    else if (character === ESCAPE) state = "escape";
    else {
      state = "none";
      typeCharacter(token, character);
    }
  }
  return { value: token.join(""), end: undefined, escape: state };
}

/**
 * The token is typed or pasted without being shown. Enter ends it, Ctrl+C cancels, and a terminal
 * that closes before Enter ends it with an error; each way the terminal leaves raw mode. `io` is
 * the process's terminal unless a caller hands in another.
 */
export function readHidden(prompt, io = process) {
  const { stdin, stdout } = io;
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error("no terminal to read the token from / kein Terminal fuer die Eingabe des Tokens"),
    );
  }
  stdout.write(prompt);
  return new Promise((resolveToken, rejectToken) => {
    let value = "";
    let escape = "none";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (stdin.destroyed !== true) stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdin.off("end", onClosed);
      stdin.off("close", onClosed);
      stdout.write("\n");
      if (error === undefined) resolveToken(value.trim());
      else rejectToken(error);
    };
    const onData = (chunk) => {
      const step = tokenInput(value, chunk, escape);
      value = step.value;
      escape = step.escape;
      if (step.end === "enter") finish();
      else if (step.end === "cancel") finish(new Error("cancelled / abgebrochen"));
    };
    const onClosed = () =>
      finish(
        new Error(
          "the terminal closed before the token was entered / das Terminal wurde geschlossen, bevor der Token eingegeben war",
        ),
      );
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.on("end", onClosed);
    stdin.on("close", onClosed);
    stdin.resume();
  });
}

/**
 * Writes all of `text`: writeSync may write fewer bytes than it was given without throwing (a full
 * disk, a file-size limit), so it is called again for the rest, and a call that writes nothing
 * throws.
 */
export function writeAll(fd, text, write = writeSync) {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = write(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error(
        "the file could not be written completely / die Datei konnte nicht vollstaendig geschrieben werden",
      );
    }
    offset += written;
  }
}

function windowsSystemProgram(env, name) {
  const root = env.SystemRoot ?? env.windir ?? String.raw`C:\Windows`;
  if (!/^[A-Za-z]:\\/u.test(root)) {
    throw new LauncherRefusal(
      "Windows' system folder cannot be found, so the access file cannot be made private.",
      "Der Systemordner von Windows ist nicht zu finden, daher kann die Zugangsdatei nicht privat gemacht werden.",
    );
  }
  return win32.join(root, "System32", name);
}

function refusePrivateAccess() {
  throw new LauncherRefusal(
    "The access file cannot be limited to your Windows account, so no token is written. Move this folder into a folder of your own on this computer, then run this step again; a USB stick or a network drive may not support this.",
    "Die Zugangsdatei kann nicht auf dein Windows-Konto beschraenkt werden, daher wird kein Token geschrieben. Verschiebe diesen Ordner in einen eigenen Ordner auf diesem Computer und fuehre diesen Schritt dann erneut aus; ein USB-Stick oder ein Netzlaufwerk unterstuetzt das moeglicherweise nicht.",
  );
}

/**
 * Windows applies no mode bits: a new file takes the permissions its folder hands down, which can
 * let other accounts read it. Before a byte of the token is written, the file is cut off from
 * them and granted to the account that runs this step alone (its SID from whoami, the grant by
 * icacls, both from Windows' own System32). Other systems keep the 0600 the file was created with.
 */
const WINDOWS_SPAWN = { encoding: "utf8", windowsHide: true, shell: false };

function ranCleanly(result) {
  return result.error === undefined && result.status === 0;
}

// The SID of the account this process runs as, from its own token.
function currentAccountSid(env, run) {
  const who = run(
    windowsSystemProgram(env, "whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    WINDOWS_SPAWN,
  );
  const sid = ranCleanly(who)
    ? /,"(S-1-\d+(?:-\d+)+)"\s*$/u.exec(String(who.stdout).trim())?.[1]
    : undefined;
  return sid ?? refusePrivateAccess();
}

export function restrictToCurrentAccount(path, options = {}) {
  const { platform = process.platform, env = process.env, run = spawnSync } = options;
  if (platform !== "win32") return;
  const sid = currentAccountSid(env, run);
  const grant = run(
    windowsSystemProgram(env, "icacls.exe"),
    [path, "/inheritance:r", "/grant:r", `*${sid}:F`],
    WINDOWS_SPAWN,
  );
  if (!ranCleanly(grant)) refusePrivateAccess();
}

// The seam the tests use to stand in for Windows' access control.
export const privateFileAccess = { restrict: restrictToCurrentAccount };

/** Writes a new owner-private file completely and durably; it must not exist yet. */
export function writeNewPrivateFile(path, text, write = writeSync) {
  const fd = openSync(path, "wx", 0o600);
  try {
    privateFileAccess.restrict(path);
    writeAll(fd, text, write);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces `target` in one step: the text goes into a new owner-private file in an owner-private
 * folder beside it, which then takes the target's name. An existing file never holds the new token under its old permissions,
 * and a failed write leaves it as it was.
 */
export function publishPrivateFile(target, text, writeNew = writeNewPrivateFile) {
  // The file is created inside a folder that is already private to this account, so no other
  // account can open it before its own access is limited: Windows hands a new file the permissions
  // of its folder.
  const stage = join(
    dirname(target),
    `.${basename(target)}.${String(process.pid)}.${randomBytes(6).toString("hex")}.stage`,
  );
  mkdirSync(stage, { mode: 0o700 });
  try {
    privateFileAccess.restrict(stage);
    const temporary = join(stage, basename(target));
    writeNew(temporary, text);
    renameSync(temporary, target);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// Keiko reads its configuration from KEIKO_CONFIG_FILE or KEIKO_UI_DATA_DIR when one is set, so
// Gateway Setup then saved it there, not in the data folder this step reads.
function configOverride(env) {
  return ["KEIKO_CONFIG_FILE", "KEIKO_UI_DATA_DIR"].find(
    (name) => env[name] !== undefined && env[name].length > 0,
  );
}

/**
 * The administrator's access step: writes the team's keiko.config.json from the configuration
 * Gateway Setup saved. Returns the exit code; a token that was needed and not entered throws.
 */
export async function saveConfig(root, env, io = {}) {
  const readToken = io.readToken ?? readHidden;
  const override = configOverride(env);
  if (override !== undefined) {
    say(
      `${override} is set, so Keiko keeps its configuration elsewhere. Unset it, start Keiko from this folder, complete Gateway Setup, stop Keiko, then run this again.`,
      `${override} ist gesetzt, daher speichert Keiko seine Konfiguration anderswo. Entferne die Variable, starte Keiko aus diesem Ordner, schliesse die Gateway-Einrichtung ab, beende Keiko und fuehre dies erneut aus.`,
    );
    return 1;
  }
  const saved = join(stateDir(env), "ui", CONFIG_NAME);
  if (!existsSync(saved)) {
    say(
      "Set Keiko up first: start Keiko, complete Gateway Setup, stop Keiko, then run this again.",
      "Richte Keiko zuerst ein: Keiko starten, Gateway-Einrichtung abschliessen, Keiko beenden, dann dies erneut ausfuehren.",
    );
    return 1;
  }
  const config = JSON.parse(readFileSync(saved, "utf8"));
  // Refuses another connection's key, and a key only this computer's environment holds, before the
  // token is asked for.
  teamConfig(config, "");
  refuseEnvironmentKeys(config, env);
  const token = needsToken(config)
    ? await readToken("API token (not shown) / API-Token (wird nicht angezeigt): ")
    : "";
  if (needsToken(config) && token.length === 0) throw new Error("no token entered");
  const text = `${JSON.stringify(teamConfig(config, token), null, 2)}\n`;
  publishPrivateFile(join(root, CONFIG_NAME), text, io.writeNew);
  say(
    `Saved: ${CONFIG_NAME}. Everyone who starts this folder uses this gateway without entering anything. The file holds the token in plain text: share the folder with your team only.`,
    `Gespeichert: ${CONFIG_NAME}. Wer diesen Ordner startet, nutzt dieses Gateway, ohne etwas einzugeben. Die Datei enthaelt das Token im Klartext: Gib den Ordner nur an dein Team weiter.`,
  );
  return 0;
}

/** Runs one command of a start file; `context` stands in for the process in tests. */
export async function main(command, context = {}) {
  const root = context.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const nodeDir = context.nodeDir ?? dirname(process.execPath);
  const env = context.env ?? process.env;
  const run = context.run ?? spawnSync;
  if (command === "start") return start(root, nodeDir, env, run);
  if (command === "stop") return stop(root, env, run);
  if (command === "save-config") return saveConfig(root, env, context.io);
  console.error("usage: keiko-npm.mjs start | stop | save-config");
  return 2;
}

/**
 * Whether Node.js runs this file as its program. Node.js resolves symbolic links for the module's
 * URL but not for argv[1], so a folder reached through a link (/tmp, a redirected Documents
 * folder, a subst drive) compares both resolved; a plain comparison would start nothing there.
 * Both sides use the same realpathSync the module loader uses, so they resolve alike.
 */
export function isEntryPoint(scriptPath, moduleUrl) {
  if (scriptPath === undefined || !existsSync(scriptPath)) return false;
  return realpathSync(scriptPath) === realpathSync(fileURLToPath(moduleUrl));
}

/** Runs the command and turns every failure into a message and exit code 1. */
export async function runCommand(command, context = {}) {
  try {
    return await main(command, context);
  } catch (error) {
    console.error(`Keiko: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const holdParams = new URL(import.meta.url).searchParams;
if (holdParams.has(HOLD_PARAMETER)) holdFromImport(holdParams);

if (isEntryPoint(process.argv[1], import.meta.url)) {
  process.exitCode = await runCommand(process.argv[2]);
}
