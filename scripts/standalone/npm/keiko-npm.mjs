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
  writeSync,
} from "node:fs";
import { homedir, uptime } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

const PACKAGE_PATH = ["node_modules", "@oscharko-dev", "keiko"];
const INSTALLED_MARKER = ".keiko-npm-installed";
const CONFIG_NAME = "keiko.config.json";
// The data of every Keiko start form of this computer account: a new package folder, or the
// folder package, finds the chats and settings of the old one.
const STATE_DIR_NAME = ".keiko-standalone";
// npm removes node_modules during `npm ci`, so the installation's lock lies beside this file. The
// lock is a folder that appears complete in one rename: it always holds the entry
// `owner-<pid>-<random>` of the start that installs, which names when it was written, and a Stop
// made meanwhile adds `stop-<pid>-<random>` to it.
const INSTALL_LOCK = ["system", "keiko-npm-install.lock"];
const LOCK_ENTRY = /^(owner|stop)-(\d+)-[0-9a-f]+$/u;
// A lock on its way in or out: `<lock>.<pid>-<random>.candidate` or `.released`.
const LOCK_LEFTOVER = /^keiko-npm-install\.lock\.(\d+)-[0-9a-f]+\.(?:candidate|released)$/u;
const LOCK_ATTEMPTS = 8;
// What renaming or removing the lock folder answers while another start holds or changes it.
const LOCK_CONTENDED = new Set(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 40;
const RENAME_RETRY_MS = 25;
// The query parameter with which npm imports this file to hold the lock it installs under.
const HOLD_PARAMETER = "hold-install-lock";
// The system gives the number of an ended process to a new one, Windows soon after, so a running
// process with the owner's number does not prove that its start still runs. An owner written
// before the computer started, or longer ago than any installation takes, no longer holds the lock.
const LOCK_EXPIRES_AFTER_MS = 60 * 60 * 1000;
// Wall-clock corrections after the computer started move its estimated start time.
const BOOT_TOLERANCE_MS = 10 * 60 * 1000;

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
export function ownedLogsDir(state) {
  const logsDir = npmLogsDir(state);
  if (lstatSync(logsDir, { throwIfNoEntry: false }) === undefined) {
    mkdirSync(logsDir, { mode: 0o700 });
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
  const entries = npmrcEntries(readFileSync(path, "utf8"));
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

function pidAlive(text) {
  const pid = Number.parseInt(text, 10);
  return Number.isInteger(pid) && pid > 0 && processAlive(pid);
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
 * Whether an owner entry written at `writtenAt` can no longer belong to a running start: it was
 * written before the computer started, or longer ago than any installation takes.
 */
export function ownerExpired(writtenAt, now = Date.now(), upMs = uptime() * 1000) {
  return writtenAt < now - upMs - BOOT_TOLERANCE_MS || now - writtenAt > LOCK_EXPIRES_AFTER_MS;
}

// When the owner entry was written; undefined when it names no time this launcher wrote, so only
// its process number decides.
function ownerWrittenAt(path) {
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function liveOwner(dir, name) {
  const entry = LOCK_ENTRY.exec(name);
  if (entry?.[1] !== "owner" || !pidAlive(entry[2])) return false;
  let writtenAt;
  try {
    writtenAt = ownerWrittenAt(join(dir, name));
  } catch (error) {
    // The lock went while it was read: no start holds it any more.
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  return writtenAt === undefined || !ownerExpired(writtenAt);
}

function hasLiveOwner(dir, entries) {
  return entries.some((name) => liveOwner(dir, name));
}

/** Whether another start of this folder is installing Keiko right now. */
export function installerActive(root) {
  const dir = installLockPath(root);
  const entries = lockEntries(dir);
  return entries !== undefined && hasLiveOwner(dir, entries);
}

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

// The lock appears in one rename and already holds its owner, so no start finds it empty.
function publishLock(dir, pause) {
  const token = lockToken();
  const candidate = `${dir}.${token}.candidate`;
  mkdirSync(candidate, { mode: 0o700 });
  const fd = openSync(join(candidate, `owner-${token}`), "wx", 0o600);
  try {
    writeAll(fd, `${String(Date.now())}\n`);
  } finally {
    closeSync(fd);
  }
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
 * start may run, so a test can let one run there.
 */
export function acquireInstallLock(root, pause = () => undefined) {
  const dir = installLockPath(root);
  mkdirSync(dirname(dir), { recursive: true });
  removeLockLeftovers(dirname(dir));
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    // Windows may still hold a handle in a lock folder that was just cleared.
    if (attempt > 0) sleepSync(RENAME_RETRY_MS);
    const entries = lockEntries(dir);
    if (entries !== undefined) {
      if (hasLiveOwner(dir, entries)) return undefined;
      pause("clear");
      clearStaleLock(dir, entries);
    }
    const lock = publishLock(dir, pause);
    if (lock !== undefined) return lock;
  }
  throw new LauncherRefusal(
    `The installation lock ${dir} cannot be taken. Remove it, then start Keiko again.`,
    `Die Installationssperre ${dir} kann nicht uebernommen werden. Entferne sie und starte Keiko dann erneut.`,
  );
}

function stopRequested(dir) {
  return readdirSync(dir).some((name) => LOCK_ENTRY.exec(name)?.[1] === "stop");
}

/**
 * Ends the installation in one rename and returns whether a Stop was requested while this start
 * held the lock. A Stop either added its entry before the rename, which is read here, or finds no
 * lock afterwards and stops Keiko itself.
 */
export function releaseInstallLock(lock) {
  // A lock another start took over, because this one held it too long, is that start's.
  if (!existsSync(join(lock.dir, `owner-${lock.token}`))) return false;
  const released = `${lock.dir}.${lock.token}.released`;
  // A Stop holds its entry open only while it creates it.
  renameRetrying(lock.dir, released);
  try {
    return stopRequested(released);
  } finally {
    rmSync(released, { recursive: true, force: true });
  }
}

// false when the lock was released while the entry was created.
function createLockEntry(path) {
  try {
    closeSync(openSync(path, "wx", 0o600));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Records a Stop in the lock of the start that installs Keiko. Returns false when no start holds
 * the lock, so the caller stops Keiko itself. The entry counts only while it is still in the lock:
 * one that went out with a lock released meanwhile is looked for again.
 */
export function requestStop(root) {
  const dir = installLockPath(root);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const entries = lockEntries(dir);
    if (entries === undefined || !hasLiveOwner(dir, entries)) return false;
    const entry = join(dir, `stop-${lockToken()}`);
    if (createLockEntry(entry) && existsSync(entry)) return true;
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

// A package `npm ci` installs here: not a development package, and meant for this computer. One
// restricted by its C library is left to npm, which can tell glibc from musl.
function expectedHere(entry, platform, arch) {
  return (
    entry.dev !== true &&
    entry.link !== true &&
    entry.libc === undefined &&
    typeof entry.version === "string" &&
    forThisComputer(entry.os, platform) &&
    forThisComputer(entry.cpu, arch)
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

/**
 * The packages package-lock.json names for this computer that are not installed in its version.
 * npm's exit code alone does not prove an installation: an inherited setting can make `npm ci`
 * succeed while it installs nothing, or leaves out this platform's optional Coding runtime.
 */
export function missingFromInstallation(root, platform = process.platform, arch = process.arch) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const packages = isRecord(lock?.packages) ? lock.packages : {};
  return Object.entries(packages)
    .filter(([lockPath, entry]) => lockPath.startsWith("node_modules/") && isRecord(entry))
    .filter(([, entry]) => expectedHere(entry, platform, arch))
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
 * A start that ends while npm still runs, killed alone, then leaves a lock that still holds.
 */
export function holdArgs(lockDir) {
  const url = new URL(import.meta.url);
  url.search = "";
  url.searchParams.set(HOLD_PARAMETER, lockDir);
  return ["--import", url.href];
}

/**
 * Adds an owner entry for this process to the installation lock `dir` and removes it when the
 * process exits. Without a lock there is nothing to keep: the start that runs npm holds none.
 */
export function holdInstallLock(dir, onExit = (listener) => process.once("exit", listener)) {
  const entry = join(dir, `owner-${lockToken()}`);
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
  onExit(() => rmSync(entry, { force: true }));
  return entry;
}

function runNpm(root, nodeDir, env, run) {
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
    const args = [
      ...holdArgs(installLockPath(root)),
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

/** Installs Keiko unless the last complete installation was of this lockfile; the caller holds the lock. */
export function ensureInstalled(root, nodeDir, env, run = spawnSync) {
  const digest = lockfileDigest(root);
  if (installationCurrent(root, digest)) return true;
  if (!runNpm(root, nodeDir, env, run)) return false;
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

function runKeiko(root, args, env, run) {
  const result = run(process.execPath, [keikoCliPath(root), ...args], {
    cwd: root,
    stdio: "inherit",
    env: keikoEnv(env),
  });
  if (result.error !== undefined) {
    // No child ran, so nothing else would say why Start or Stop ended here.
    reportStartRefused(result.error);
    return 1;
  }
  return result.status ?? 1;
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

// While it holds the lock, this start installs Keiko and opens it, unless a Stop came first.
function installThenOpen(root, nodeDir, env, run, lock, args) {
  if (!ensureInstalled(root, nodeDir, env, run)) return { outcome: "install-failed" };
  if (stopRequested(lock.dir)) return { outcome: "cancelled" };
  return { outcome: "opened", code: runKeiko(root, args, env, run) };
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

// A Stop made while this start held the lock stops whatever opened: this start's Keiko, also one
// that reported a failure, or one an earlier start of the folder opened. Stopping a Keiko that does
// not run succeeds.
function settleStart(root, env, run, step, stopped) {
  if (step.outcome === "install-failed") return 1;
  if (!stopped && step.outcome === "opened") {
    if (step.code === 0) reportRunning();
    return step.code;
  }
  const code = stopKeiko(root, stateDir(env), env, run);
  // Why Keiko did not open says more than the Stop after it.
  if (step.code !== undefined && step.code !== 0) return step.code;
  if (code !== 0) return code;
  reportStoppedWhileLoading(step.outcome === "opened");
  return 0;
}

// This start holds the lock until Keiko is open, so a Stop meanwhile is read when the lock goes,
// and a Stop after that finds Keiko open and stops it.
function installAndOpen(root, nodeDir, env, run, lock, args) {
  let step;
  try {
    step = installThenOpen(root, nodeDir, env, run, lock, args);
  } catch (error) {
    releaseInstallLock(lock);
    throw error;
  }
  return settleStart(root, env, run, step, releaseInstallLock(lock));
}

/**
 * Installs Keiko when needed and starts it; returns Keiko's exit code. Every start holds the lock
 * until Keiko is open, also one that installs nothing, so a Stop meanwhile is never lost. It says
 * itself how the start ended: Keiko open, opened by another start of the folder, or stopped while
 * it was being loaded.
 */
export function start(root, nodeDir, env, run = spawnSync, pause = () => undefined) {
  const args = startArgs(root, env);
  const lock = acquireInstallLock(root, pause);
  if (lock === undefined) {
    say(
      "Another start of this folder is opening Keiko. Its window says whether Keiko opened. You can close this one.",
      "Ein anderer Start dieses Ordners oeffnet Keiko gerade. Sein Fenster zeigt, ob Keiko geoeffnet wurde. Dieses kannst du schliessen.",
    );
    return 0;
  }
  return installAndOpen(root, nodeDir, env, run, lock, args);
}

/**
 * Stops a running Keiko. While a start of this folder is still loading Keiko, the Stop is recorded
 * in its lock and that start does not leave Keiko open. A folder Keiko was never loaded into has
 * nothing to stop.
 */
export function stop(root, env, run = spawnSync) {
  const state = stateDir(env);
  if (requestStop(root)) {
    say(
      "Keiko is still being loaded. It does not stay open: the start that loads it stops it.",
      "Keiko wird noch geladen. Es bleibt nicht geoeffnet: Der Start, der es laedt, beendet es.",
    );
    return 0;
  }
  if (!existsSync(keikoCliPath(root))) {
    say("Keiko is not running.", "Keiko laeuft nicht.");
    return 0;
  }
  const code = stopKeiko(root, state, env, run);
  if (code === 0) {
    say(
      "Keiko is stopped. You can close this window.",
      "Keiko ist beendet. Du kannst dieses Fenster schliessen.",
    );
  }
  return code;
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
// carries `catalogOrigin`, every voice deployment it found there a gateway-managed capability.
// A model entered with its own credential carries neither, even on the same endpoint.
function builtFromConnection(config, provider, primary) {
  if (provider === primary) return true;
  if (provider.endpointStyle !== primary.endpointStyle) return false;
  if (provider.apiVersion !== primary.apiVersion) return false;
  if (!sameConnection(provider, primary)) return false;
  const capability = capabilityOf(config, provider);
  return (
    provider.catalogOrigin !== undefined ||
    (capability?.kind === "voice" && capability.voiceProviderLocality === "gateway-managed")
  );
}

function filledText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// The gateway's own name for a model's key variable: every character other than a letter or a digit
// becomes `_`, then upper case.
function modelKeyVariable(modelId) {
  return `KEIKO_MODEL_${modelId.replaceAll(/[^A-Za-z0-9]/gu, "_").toUpperCase()}_API_KEY`;
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
  if (filledText(env[specific])) return specific;
  return filledText(env.KEIKO_DEFAULT_API_KEY) ? "KEIKO_DEFAULT_API_KEY" : undefined;
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
 * The token is typed or pasted without being shown. Enter ends it, Ctrl+C cancels; either way the
 * terminal leaves raw mode. `io` is the process's terminal unless a caller hands in another.
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
    const finish = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
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
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
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

/** Writes a new owner-private file completely and durably; it must not exist yet. */
export function writeNewPrivateFile(path, text, write = writeSync) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeAll(fd, text, write);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces `target` in one step: the text goes into a new owner-private file beside it, which then
 * takes the target's name. An existing file never holds the new token under its old permissions,
 * and a failed write leaves it as it was.
 */
export function publishPrivateFile(target, text, writeNew = writeNewPrivateFile) {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeNew(temporary, text);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
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

// npm's process imports this file with the lock to hold (`holdArgs`); nothing else runs then.
const heldLock = new URL(import.meta.url).searchParams.get(HOLD_PARAMETER);
if (heldLock !== null) holdInstallLock(heldLock);

if (isEntryPoint(process.argv[1], import.meta.url)) {
  process.exitCode = await runCommand(process.argv[2]);
}
