import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL, URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The two readers of the declaration: the CLI's (Windows gateway service setup) and the server's
// (update preflight).
import { managedOutsideApp } from "../../packages/keiko-cli/src/portable-management.ts";
// The lifecycle owner's own fence, which the folder launcher's starts and Stops are ordered by.
import {
  STOP_SUPERSEDED_EXIT_CODE as CLI_STOP_SUPERSEDED,
  checkStopFence,
  clearLaunchOrder,
  recordLaunchOrder,
} from "../../packages/keiko-cli/dist/launch-order.js";
// The gateway's own loader, whose key variables the export must name alike.
import { parseGatewayConfig } from "../../packages/keiko-model-gateway/dist/index.js";
import {
  externallyManagedInstallMode,
  portableManagementFromEnv,
} from "../../packages/keiko-server/src/update-portable-install-mode.ts";

import {
  LauncherRefusal,
  STOP_SUPERSEDED_EXIT_CODE,
  acquireInstallLock,
  closeInstallLock,
  credentialScope,
  ensureInstalled,
  environmentKeys,
  folderRegistry,
  holdArgs,
  holdInstallLock,
  homeOf,
  installArgs,
  installLockPath,
  installationCurrent,
  installerActive,
  isEntryPoint,
  keikoCliPath,
  keikoEnv,
  lockClock,
  lockProcesses,
  lockRenewal,
  lockfileDigest,
  main,
  missingFromInstallation,
  needsToken,
  npmCliCandidates,
  npmEnv,
  npmLogsDir,
  orderClock,
  ownedLogsDir,
  privateFileAccess,
  publishPrivateFile,
  readHidden,
  refuseForeignInstallTarget,
  releaseInstallLock,
  removeInstallLock,
  requestStop,
  restrictToCurrentAccount,
  runCommand,
  saveConfig,
  start,
  startArgs,
  stateDir,
  stop,
  teamConfig,
  tokenInput,
  writeNewPrivateFile,
} from "../standalone/npm/keiko-npm.mjs";

// The start logic that ships inside an npm package (system/keiko-npm.mjs). It runs with Node.js
// built-ins only, before Keiko is installed.

const tempRoots = [];

// The lock watches its holders renew on a monotonic clock for up to a minute. The tests give it a
// virtual one: `sleep` advances it, and every fifteen virtual seconds each holder entry of the lock
// that still has a running process number is rewritten, unless the test froze the holders.
const clock = { renewing: true, now: 0, last: 0, writes: 0, frozen: new Set() };
const realRenewalStart = lockRenewal.start;
// Starts and Stops are ordered by the wall clock. The tests give them one that moves on with every
// reading, so the order in which a test makes things happen is the order of their times.
const wall = { now: 0 };

function renewEntries(dir, pattern) {
  const names = existsSync(dir) ? readdirSync(dir) : [];
  for (const name of names.filter((entry) => pattern.test(entry))) {
    const path = join(dir, name);
    if (clock.frozen.has(name) || !statSync(path).isFile()) continue;
    clock.writes += 1;
    writeFileSync(path, `${String(clock.now)}-${String(clock.writes)}\n`);
  }
}

// The holders of the lock renew, and so does a Stop that acts under a handoff in system/ (the
// worker thread of the real Stop does it); a test freezes one to stand in for a Stop that ended.
function renewHolders(dir) {
  renewEntries(dir, /^(owner|npm)-\d+-/u);
  renewEntries(dirname(dir), /^keiko-npm-stop-handoff-\d+-/u);
}

beforeEach(() => {
  Object.assign(clock, { renewing: true, now: 0, last: 0, writes: 0, frozen: new Set() });
  vi.spyOn(lockClock, "now").mockImplementation(() => clock.now);
  vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
    clock.now += milliseconds;
    if (!clock.renewing || clock.now - clock.last < 15_000) return;
    clock.last = clock.now;
    renewHolders(dir);
  });
  vi.spyOn(lockRenewal, "start").mockImplementation(() => () => undefined);
  wall.now = 1_800_000_000_000;
  vi.spyOn(orderClock, "now").mockImplementation(() => (wall.now += 1));
});

afterEach(() => {
  vi.restoreAllMocks();
  endedPids.clear();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The messages a person reads are not what these tests check.
function quiet() {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

function tempDir(prefix = "keiko-npm-runtime-") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

// A package folder inside a home folder of its own: the data folder lies in that home folder.
function packageRoot() {
  const root = join(tempDir(), "Keiko");
  mkdirSync(join(root, "system"), { recursive: true });
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  return root;
}

function homeEnv(root, extra = {}) {
  const home = dirname(root);
  return { HOME: home, USERPROFILE: home, ...extra };
}

function installKeiko(root, marker) {
  mkdirSync(join(root, "node_modules", "@oscharko-dev", "keiko", "dist", "cli"), {
    recursive: true,
  });
  writeFileSync(keikoCliPath(root), "");
  if (marker !== undefined)
    writeFileSync(join(root, "node_modules", ".keiko-npm-installed"), marker);
}

function ownedCaches(state) {
  return existsSync(state)
    ? readdirSync(state).filter((name) => name.startsWith("npm-cache-"))
    : [];
}

// The owner entries of the folder's installation lock.
function lockOwners(root) {
  return readdirSync(installLockPath(root)).filter((name) => name.startsWith("owner-"));
}

// A lock on its way in or out that a start left in system/.
function lockLeftovers(root) {
  return readdirSync(join(root, "system")).filter((name) =>
    name.startsWith("keiko-npm-install.lock."),
  );
}

// The lock of a start that no longer runs, with the further entries it held.
function staleLock(root, pid, extra = [], writtenAt = "") {
  const dir = installLockPath(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `owner-${String(pid)}-0a`), writtenAt);
  for (const name of extra) writeFileSync(join(dir, name), "");
}

const systemAlive = lockProcesses.alive;
const endedPids = new Set();

// The number of a process that ended. The system may give it to a new process before the lock
// looks, Windows soon after, so the lock's probe is told it ended (review finding on PR #4464); a
// number that runs again is a case of its own below.
function endedPid() {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  endedPids.add(pid);
  vi.spyOn(lockProcesses, "alive").mockImplementation(
    (candidate) => !endedPids.has(candidate) && systemAlive(candidate),
  );
  return pid;
}

// A hold whose exit and renewal the test runs itself.
function heldByTest(dir, keep, extra = {}) {
  const hold = { renew: undefined, exit: undefined };
  hold.entry = holdInstallLock(dir, {
    ...extra,
    keep,
    onExit: (listener) => {
      hold.exit = listener;
    },
    every: (renew) => {
      hold.renew = renew;
      return () => {
        hold.renew = undefined;
      };
    },
  });
  return hold;
}

// What a run call asked for: npm's `ci` behind the arguments that let npm hold the lock, or Keiko's
// own command.
function commandOf(call) {
  return call[1].includes("ci") ? "ci" : call[1][1];
}

// The value after a flag of a command line.
function flagValue(args, flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

// Keiko's command line as the folder launcher meets it. A start opens Keiko and records its order;
// a fenced stop asks the lifecycle owner's own fence (launch-order.ts) whether a start that began
// after the Stop opened Keiko, and then leaves it open. Folders given the same data folder share
// what it records. The hooks run inside a start or stop, before it takes effect: a start or
// takeover that the lifecycle guard lets in first.
function lifecycleCli({ beforeStart = () => undefined, beforeStop = () => undefined } = {}) {
  const cli = { commands: [], running: true };
  cli.run = vi.fn((_node, args) => {
    const [, command] = args;
    const state = flagValue(args, "--state-dir");
    mkdirSync(state, { recursive: true });
    if (command === "start") {
      beforeStart();
      cli.commands.push(command);
      cli.running = true;
      const order = flagValue(args, "--launch-order");
      if (order !== undefined) recordLaunchOrder(state, Number(order), undefined);
      return { status: 0 };
    }
    beforeStop();
    cli.commands.push(command);
    const fence = flagValue(args, "--unless-launched-after");
    if (cli.running && fence !== undefined) {
      if (checkStopFence(state, Number(fence), undefined) === "superseded") {
        return { status: CLI_STOP_SUPERSEDED };
      }
    }
    cli.running = false;
    clearLaunchOrder(state, undefined);
    return { status: 0 };
  });
  // A start that holds `lock` opening Keiko, as the launcher's own start does.
  cli.open = (root, env, lock) =>
    cli.run(process.execPath, [
      keikoCliPath(root),
      ...startArgs(root, env),
      "--launch-order",
      String(lock.orderedAt),
    ]);
  return cli;
}

describe("the npm package start", () => {
  it("finds npm where macOS and Windows Node.js distributions keep it", () => {
    expect(npmCliCandidates(join("/p", "system", "node", "bin"))).toContain(
      join("/p", "system", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    );
    expect(npmCliCandidates(join("C:", "p", "system", "node"))).toContain(
      join("C:", "p", "system", "node", "node_modules", "npm", "bin", "npm-cli.js"),
    );
  });

  it("reads the home folder as Keiko's command line does", () => {
    expect(homeOf({ HOME: "/h", USERPROFILE: "C:\\u" }, "linux")).toBe("/h");
    expect(homeOf({ HOME: "/h", USERPROFILE: "C:\\u" }, "win32")).toBe("C:\\u");
    expect(homeOf({ HOME: "" }, "darwin")).not.toBe("");
  });

  it("keeps Keiko's data in the user's .keiko-standalone folder unless another is named", () => {
    const home = tempDir();

    expect(stateDir({}, home)).toBe(join(home, ".keiko-standalone"));
    expect(stateDir({ KEIKO_STATE_DIR: "" }, home)).toBe(join(home, ".keiko-standalone"));
    expect(stateDir({ KEIKO_STATE_DIR: join(home, "s") }, home)).toBe(join(home, "s"));
    // A relative name is resolved once, against the start's working folder, for npm and Keiko.
    expect(stateDir({ KEIKO_STATE_DIR: "s" }, home, home)).toBe(join(home, "s"));
    expect(stateDir({ HOME: home, USERPROFILE: home })).toBe(join(home, ".keiko-standalone"));
  });

  it("refuses a data folder outside the home folder, also one reached through a link", () => {
    // Review finding on PR #4464 (P1): the start wrote and cleaned npm's cache in KEIKO_STATE_DIR
    // before `keiko start` checked that it lies in the home folder.
    const home = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(home, "link"), process.platform === "win32" ? "junction" : "dir");

    expect(() => stateDir({ KEIKO_STATE_DIR: outside }, home)).toThrow(LauncherRefusal);
    expect(() => stateDir({ KEIKO_STATE_DIR: join("..", "x") }, home, home)).toThrow(
      LauncherRefusal,
    );
    expect(() => stateDir({ KEIKO_STATE_DIR: join(home, "link", "state") }, home)).toThrow(
      /inside your home folder/u,
    );
  });

  it("installs again unless the last complete installation was of this exact lockfile", () => {
    const root = packageRoot();
    const digest = lockfileDigest(root);

    expect(installationCurrent(root, digest)).toBe(false);
    installKeiko(root);
    expect(installationCurrent(root, digest)).toBe(false);
    installKeiko(root, `${"0".repeat(64)}\n`);
    expect(installationCurrent(root, digest)).toBe(false);
    installKeiko(root, `${digest}\n`);
    expect(installationCurrent(root, digest)).toBe(true);
    rmSync(keikoCliPath(root));
    expect(installationCurrent(root, digest)).toBe(false);
  });

  it("puts the package's Node.js first on the search path, in the spelling Windows uses", () => {
    expect(npmEnv({ PATH: "/bin" }, "/n").PATH).toBe(`/n${delimiter}/bin`);
    const windows = npmEnv({ Path: "C:\\w" }, "C:\\n");
    expect(windows.Path).toBe(`C:\\n${delimiter}C:\\w`);
    expect(windows.PATH).toBeUndefined();
    expect(npmEnv({}, "/n").PATH).toBe("/n");
  });

  it("drops an inherited registry only when the folder names one, and keeps proxy and access", () => {
    const env = {
      PATH: "/bin",
      npm_config_registry: "http://a.example/",
      NPM_CONFIG_REGISTRY: "http://b.example/",
      npm_config_https_proxy: "http://proxy.example:3128",
      "npm_config_//mirror.example/:_authToken": "secret",
    };

    const named = npmEnv(env, "/n", true);
    expect(named.npm_config_registry).toBeUndefined();
    expect(named.NPM_CONFIG_REGISTRY).toBeUndefined();
    expect(named.npm_config_https_proxy).toBe("http://proxy.example:3128");
    expect(named["npm_config_//mirror.example/:_authToken"]).toBe("secret");
    expect(npmEnv(env, "/n").npm_config_registry).toBe("http://a.example/");
  });

  it("accepts one global registry in the folder's .npmrc and refuses scoped routing", () => {
    // Review finding on PR #4464 (P1): npm loads a lockfile's packages from the global registry, so
    // a scoped registry would silently never be asked.
    const root = packageRoot();
    const npmrc = join(root, ".npmrc");

    expect(folderRegistry(root)).toBe(false);
    writeFileSync(npmrc, "; proxy only\nhttps-proxy=http://proxy.example:3128\n");
    expect(folderRegistry(root)).toBe(false);
    writeFileSync(
      npmrc,
      "# mirror\nregistry=https://mirror.example/\n//mirror.example/:_authToken=${TOKEN}\n",
    );
    expect(folderRegistry(root)).toBe(true);
    writeFileSync(npmrc, "registry=https://a.example/\r\n@oscharko-dev:registry=https://b/\r\n");
    expect(() => folderRegistry(root)).toThrow(/@scope:registry/u);
    writeFileSync(npmrc, "registry=https://a.example/\nregistry = https://b.example/\n");
    expect(() => folderRegistry(root)).toThrow(/more than once/u);
  });

  it("refuses a registry line npm would not read, before any request", () => {
    // Review finding on PR #4464 (P2): `REGISTRY=` counted as the folder's registry and dropped the
    // inherited one, while npm ignores the key and asks the public registry.
    const root = packageRoot();
    const npmrc = join(root, ".npmrc");
    const env = { MIRROR: "https://mirror.example/" };
    for (const read of [
      "registry=https://mirror.example/\n",
      'registry = "https://mirror.example/"\n',
      "registry='https://mirror.example/'\n",
      "registry=https://mirror.example/ ; the team mirror\n",
      "registry=${MIRROR}\n",
      "registry=${MIRROR?}\n",
    ]) {
      writeFileSync(npmrc, read);
      expect(folderRegistry(root, env), read).toBe(true);
    }
    for (const [ignored, reason] of [
      ["REGISTRY=https://mirror.example/\n", /form npm does not read/u],
      ["Registry=https://mirror.example/\n", /form npm does not read/u],
      ["registry[]=https://mirror.example/\n", /form npm does not read/u],
      ["[mirror]\nregistry=https://mirror.example/\n", /form npm does not read/u],
      ["@Oscharko-Dev:Registry=https://mirror.example/\n", /@scope:registry/u],
      ["registry=mirror.example\n", /no http or https address/u],
      ["registry=ftp://mirror.example/\n", /no http or https address/u],
      ['registry="https://mirror.example/" ; quoted, then commented\n', /no http or https/u],
      ["registry=\n", /no http or https address/u],
      ["registry\n", /no http or https address/u],
      ["registry=${UNSET}\n", /no http or https address/u],
      ["registry=${UNSET?}\n", /no http or https address/u],
    ]) {
      writeFileSync(npmrc, ignored);
      expect(() => folderRegistry(root, env), ignored).toThrow(reason);
    }
  });

  it("refuses .npmrc syntax it cannot read exactly as npm does, before any request", () => {
    // Review finding on PR #4464 (P2): npm reads a registry after a bare carriage return and a key
    // spelled by `${...}`; the reader saw neither, kept the inherited registry override and the
    // administrator's mirror was never asked.
    const root = packageRoot();
    const npmrc = join(root, ".npmrc");
    for (const unreadable of [
      "proxy=http://p.example\rregistry=https://mirror.example/\n",
      "registry=https://mirror.example/\r",
      "${KEY}=https://mirror.example/\n",
      "@scope:${KEY}=https://mirror.example/\n",
    ]) {
      writeFileSync(npmrc, unreadable);
      expect(() => folderRegistry(root, { KEY: "registry" }), unreadable).toThrow(
        /cannot read exactly as npm does/u,
      );
    }
    // Comment lines are no settings: npm's parser skips them, so they are no reason to refuse.
    writeFileSync(npmrc, "; see ${HOME}\n  # ${KEY}=x\nregistry=https://a.example/\n;${KEY}=y\r\n");
    expect(folderRegistry(root)).toBe(true);
    // Review finding on PR #4464 (P2): a comment naming a variable, with no `=`, is no key either.
    writeFileSync(npmrc, "# Set ${TEAM_TOKEN} before running npm\nregistry=https://a.example/\n");
    expect(folderRegistry(root)).toBe(true);
    // Plain lines in either line ending keep working.
    writeFileSync(npmrc, "registry=https://a.example/\r\nproxy=http://p.example\r\n");
    expect(folderRegistry(root)).toBe(true);
  });

  it("declares Keiko managed outside the app, whatever the environment declares", () => {
    // Review finding on PR #4464 (P1): an inherited user-local declaration let Keiko of the folder
    // look for a Windows gateway service helper.
    for (const declared of [undefined, "", "user-local", "machine-managed"]) {
      const env = declared === undefined ? {} : { KEIKO_PORTABLE_MANAGEMENT: declared };
      const started = keikoEnv(env);
      expect(started.KEIKO_PORTABLE_MANAGEMENT).toBe("organization-managed");
      // What Keiko itself reads from the environment the launcher starts it with.
      expect(managedOutsideApp(started)).toBe(true);
      expect(
        externallyManagedInstallMode(portableManagementFromEnv(started), "@oscharko-dev/keiko"),
      ).toMatchObject({ installKind: "portable-it-managed", reason: "portable-it-managed" });
    }
  });

  it("runs npm in this folder only, without install scripts, its cache and log in Keiko's data", () => {
    const args = installArgs("/n/npm-cli.js", "/p", "/s/npm-cache-1", npmLogsDir("/s"));

    expect(args.slice(0, 2)).toEqual(["/n/npm-cli.js", "ci"]);
    // Pinned on the command line: no folder above the package and no workspace root takes over.
    expect(args[args.indexOf("--prefix") + 1]).toBe("/p");
    expect(args).toContain("--workspaces=false");
    expect(args).toContain("--ignore-scripts");
    expect(args).toContain("--no-update-notifier");
    expect(args).toContain("--replace-registry-host=npmjs");
    expect(args[args.indexOf("--cache") + 1]).toBe("/s/npm-cache-1");
    expect(args[args.indexOf("--logs-dir") + 1]).toBe(join("/s", "npm-logs"));
    // Review finding on PR #4464 (P2): an inherited dry-run, package-lock-only or omit made
    // `npm ci` succeed without installing, or leave out this platform's Coding runtime.
    expect(args).toEqual(
      expect.arrayContaining([
        "--dry-run=false",
        "--package-lock-only=false",
        "--global=false",
        "--install-strategy=hoisted",
        "--include=prod",
        "--include=optional",
        "--include=peer",
      ]),
    );
  });

  describe("the installation check against the lockfile", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: { "@oscharko-dev/keiko": "1.5.3" },
          devDependencies: { devtool: "1.0.0" },
        },
        "node_modules/@oscharko-dev/keiko": {
          version: "1.5.3",
          dependencies: { nested: "3.0.0", "not-on-windows": "2.0.0", "musl-only": "1.0.0" },
          optionalDependencies: { "@oscharko-dev/keiko-coding-runtime-darwin-arm64": "1.5.3" },
        },
        "node_modules/@oscharko-dev/keiko-coding-runtime-darwin-arm64": {
          version: "1.5.3",
          optional: true,
          os: ["darwin"],
          cpu: ["arm64"],
        },
        "node_modules/not-on-windows": { version: "2.0.0", os: ["!win32"] },
        "node_modules/devtool": { version: "1.0.0", dev: true },
        "node_modules/musl-only": { version: "1.0.0", os: ["linux"], libc: ["musl"] },
        "node_modules/@oscharko-dev/keiko/node_modules/nested": { version: "3.0.0" },
      },
    };

    function lockedRoot() {
      const root = packageRoot();
      writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
      return root;
    }

    function installPackage(root, lockPath, version) {
      const folder = join(root, ...lockPath.split("/"));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "package.json"), JSON.stringify({ version }));
    }

    it("names every package the lockfile promises this computer that is not installed", () => {
      const root = lockedRoot();
      installPackage(root, "node_modules/@oscharko-dev/keiko", "1.5.3");
      installPackage(root, "node_modules/@oscharko-dev/keiko/node_modules/nested", "3.0.0");
      installPackage(root, "node_modules/not-on-windows", "1.0.0");

      expect(missingFromInstallation(root, "darwin", "arm64")).toEqual([
        "@oscharko-dev/keiko-coding-runtime-darwin-arm64",
        "not-on-windows",
      ]);
      // Another computer's optional runtime is not expected; a package excluded there neither.
      expect(missingFromInstallation(root, "win32", "x64")).toEqual([]);
      installPackage(root, "node_modules/@oscharko-dev/keiko-coding-runtime-darwin-arm64", "1.5.3");
      installPackage(root, "node_modules/not-on-windows", "2.0.0");
      expect(missingFromInstallation(root, "darwin", "arm64")).toEqual([]);
    });

    it("leaves to npm an optional package whose engines it may not meet, but not the Coding runtime", () => {
      // Audit of PR #4464: npm skips an optional package whose `engines` the folder's Node.js does
      // not meet and exits 0; the check then refused every later start.
      const root = packageRoot();
      const runtime = "node_modules/@oscharko-dev/keiko-coding-runtime-darwin-arm64";
      writeFileSync(
        join(root, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": {
              dependencies: { "required-engines": "1.0.0" },
              optionalDependencies: {
                "optional-engines": "1.0.0",
                "@oscharko-dev/keiko-coding-runtime-darwin-arm64": "1.5.3",
                "optional-plain": "1.0.0",
              },
            },
            "node_modules/optional-engines": {
              version: "1.0.0",
              optional: true,
              engines: { node: "<1" },
            },
            "node_modules/required-engines": { version: "1.0.0", engines: { node: ">=26" } },
            [runtime]: {
              version: "1.5.3",
              optional: true,
              os: ["darwin"],
              cpu: ["arm64"],
              engines: { node: ">=26" },
            },
            "node_modules/optional-plain": { version: "1.0.0", optional: true },
          },
        }),
      );

      expect(missingFromInstallation(root, "darwin", "arm64")).toEqual([
        "required-engines",
        "@oscharko-dev/keiko-coding-runtime-darwin-arm64",
        "optional-plain",
      ]);
    });

    it("does not look for the packages only an optional package of another computer needs", () => {
      // Review finding on PR #4464: a package nested under, or hoisted for, an optional package
      // npm leaves out on this computer was looked for, so every start reported it missing.
      const root = packageRoot();
      writeFileSync(
        join(root, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": {
              dependencies: { app: "1.0.0" },
              optionalDependencies: { "darwin-only": "1.0.0" },
            },
            "node_modules/app": {
              version: "1.0.0",
              dependencies: { shared: "1.0.0", linked: "1.0.0" },
              peerDependencies: { "optional-peer": "1.0.0", peer: "1.0.0" },
              peerDependenciesMeta: { "optional-peer": { optional: true } },
            },
            "node_modules/darwin-only": {
              version: "1.0.0",
              optional: true,
              os: ["darwin"],
              dependencies: {
                "nested-for-darwin": "1.0.0",
                "only-for-darwin": "1.0.0",
                shared: "1.0.0",
              },
            },
            "node_modules/darwin-only/node_modules/nested-for-darwin": { version: "1.0.0" },
            "node_modules/only-for-darwin": { version: "1.0.0", optional: true },
            "node_modules/shared": { version: "1.0.0" },
            "node_modules/peer": { version: "1.0.0", peer: true },
            "node_modules/optional-peer": { version: "1.0.0", peer: true, optional: true },
            // A link is npm's to make; the dependencies of the folder it links to are installed.
            "node_modules/linked": { link: true, resolved: "packages/linked" },
            "packages/linked": { version: "1.0.0", dependencies: { "via-link": "1.0.0" } },
            "node_modules/via-link": { version: "1.0.0" },
          },
        }),
      );

      // On Windows npm leaves darwin-only out with the two packages only it needs; the package it
      // shares with app, and app's required peer, are still installed.
      expect(missingFromInstallation(root, "win32", "x64")).toEqual([
        "app",
        "shared",
        "peer",
        "via-link",
      ]);
      expect(missingFromInstallation(root, "darwin", "arm64")).toEqual([
        "app",
        "darwin-only",
        "nested-for-darwin",
        "only-for-darwin",
        "shared",
        "peer",
        "via-link",
      ]);
    });

    it("looks for every package meant for this computer in a lock without the folder's own entry", () => {
      const root = packageRoot();
      writeFileSync(
        join(root, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/unreached": { version: "1.0.0" },
            "node_modules/elsewhere": { version: "1.0.0", os: ["darwin"] },
          },
        }),
      );

      expect(missingFromInstallation(root, "win32", "x64")).toEqual(["unreached"]);
    });

    it("refuses a manifest that cannot be read as not installed", () => {
      const root = lockedRoot();
      installPackage(root, "node_modules/@oscharko-dev/keiko", "1.5.3");
      installPackage(root, "node_modules/@oscharko-dev/keiko/node_modules/nested", "3.0.0");
      writeFileSync(join(root, "node_modules", "@oscharko-dev", "keiko", "package.json"), "{");

      expect(missingFromInstallation(root, "win32", "x64")).toEqual(["@oscharko-dev/keiko"]);
    });
  });

  describe("the installation", () => {
    // A stand-in for `npm ci`: it writes into the cache and the log folder it was given and, when
    // it succeeds, installs Keiko's command line.
    function fakeNpm(root, succeeds, during = () => undefined) {
      const calls = [];
      const run = (_node, args, options) => {
        calls.push({ args, options });
        writeFileSync(join(args[args.indexOf("--cache") + 1], "keiko.tgz"), "tarball");
        writeFileSync(join(args[args.indexOf("--logs-dir") + 1], "debug.log"), "log");
        during();
        if (succeeds) installKeiko(root);
        return { status: succeeds ? 0 : 1 };
      };
      return { calls, run };
    }

    function installFixture() {
      const root = packageRoot();
      const nodeDir = join(root, "system", "node");
      mkdirSync(join(nodeDir, "node_modules", "npm", "bin"), { recursive: true });
      writeFileSync(join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), "");
      const env = homeEnv(root);
      return { root, nodeDir, env, state: stateDir(env) };
    }

    it("creates the data folder owner-private, marks the lockfile and removes its own cache", () => {
      quiet();
      const { root, nodeDir, env, state } = installFixture();
      const npm = fakeNpm(root, true);

      expect(ensureInstalled(root, nodeDir, env, npm.run)).toBe(true);
      if (process.platform !== "win32") expect(statSync(state).mode & 0o777).toBe(0o700);
      expect(ownedCaches(state)).toEqual([]);
      expect(readdirSync(npmLogsDir(state))).toEqual(["debug.log"]);
      expect(installationCurrent(root, lockfileDigest(root))).toBe(true);
      expect(npm.calls[0].options.cwd).toBe(root);
      // A current installation is not repeated.
      expect(ensureInstalled(root, nodeDir, env, npm.run)).toBe(true);
      expect(npm.calls).toHaveLength(1);
    });

    it.each([true, false])(
      "keeps a folder named npm-cache that was there before (install succeeds: %s)",
      (succeeds) => {
        // Review finding on PR #4464 (P1): the fixed <state>/npm-cache was removed on success and
        // emptied on failure even when it predated the installation.
        quiet();
        const { root, nodeDir, env, state } = installFixture();
        mkdirSync(join(state, "npm-cache", "_cacache"), { recursive: true });
        writeFileSync(join(state, "npm-cache", "_cacache", "kept"), "kept");

        expect(ensureInstalled(root, nodeDir, env, fakeNpm(root, succeeds).run)).toBe(succeeds);
        expect(readFileSync(join(state, "npm-cache", "_cacache", "kept"), "utf8")).toBe("kept");
        expect(ownedCaches(state)).toEqual([]);
      },
    );

    it("keeps npm's log of a failed attempt and marks nothing", () => {
      quiet();
      const { root, nodeDir, env, state } = installFixture();

      expect(ensureInstalled(root, nodeDir, env, fakeNpm(root, false).run)).toBe(false);
      expect(readdirSync(npmLogsDir(state))).toEqual(["debug.log"]);
      expect(ownedCaches(state)).toEqual([]);
      expect(existsSync(join(root, "node_modules", ".keiko-npm-installed"))).toBe(false);
    });

    it.each(["link", "file"])(
      "refuses an npm-logs %s in the data folder before npm writes anything",
      (kind) => {
        // Review finding on PR #4464 (P2): npm wrote and rotated its log through an npm-logs that
        // led out of Keiko's data folder.
        quiet();
        const { root, nodeDir, env, state } = installFixture();
        const elsewhere = tempDir();
        mkdirSync(state, { recursive: true });
        if (kind === "link") symlinkSync(elsewhere, npmLogsDir(state), "dir");
        else writeFileSync(npmLogsDir(state), "");
        const run = vi.fn();

        expect(() => ensureInstalled(root, nodeDir, env, run)).toThrow(LauncherRefusal);
        expect(() => ensureInstalled(root, nodeDir, env, run)).toThrow(/npm-logs/u);
        expect(run).not.toHaveBeenCalled();
        expect(readdirSync(elsewhere)).toEqual([]);
        expect(ownedCaches(state)).toEqual([]);
      },
    );

    it("uses the npm-logs folder that another package folder's start made a moment before", () => {
      // Review finding on PR #4464: two package folders share the data folder but not their
      // locks, and the second start's mkdir failed with EEXIST when the first had just made it.
      const state = tempDir();
      const raced = (path, options) => {
        mkdirSync(path, options);
        mkdirSync(path, options);
      };

      expect(ownedLogsDir(state, raced)).toBe(npmLogsDir(state));
      // What the other start left there is still checked: a file is refused.
      const other = tempDir();
      const fileFirst = (path, options) => {
        writeFileSync(path, "");
        mkdirSync(path, options);
      };
      expect(() => ownedLogsDir(other, fileFirst)).toThrow(LauncherRefusal);
    });

    it("refuses a data folder outside the home folder before npm or any folder is touched", () => {
      const { root, nodeDir } = installFixture();
      const outside = join(tempDir(), "state");
      const run = vi.fn();

      expect(() => start(root, nodeDir, homeEnv(root, { KEIKO_STATE_DIR: outside }), run)).toThrow(
        LauncherRefusal,
      );
      expect(run).not.toHaveBeenCalled();
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("refuses scoped registry routing before npm sends a request", () => {
      const { root, nodeDir, env } = installFixture();
      writeFileSync(join(root, ".npmrc"), "@oscharko-dev:registry=https://mirror.example/\n");
      const run = vi.fn();

      expect(() => start(root, nodeDir, env, run)).toThrow(/@scope:registry/u);
      expect(run).not.toHaveBeenCalled();
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("starts nothing when the folder carries no npm", () => {
      quiet();
      const root = packageRoot();
      const run = vi.fn();

      expect(start(root, join(root, "system", "node"), homeEnv(root), run)).toBe(1);
      expect(run).not.toHaveBeenCalled();
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("starts the installed Keiko declared managed outside the app, with its exit code", () => {
      const { root, nodeDir, env } = installFixture();
      installKeiko(root, `${lockfileDigest(root)}\n`);
      const run = vi.fn(() => ({ status: 0 }));
      const inherited = { ...env, KEIKO_PORTABLE_MANAGEMENT: "user-local" };

      expect(start(root, nodeDir, inherited, run)).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      const [node, args, options] = run.mock.calls[0];
      expect(node).toBe(process.execPath);
      expect(args).toEqual([
        keikoCliPath(root),
        ...startArgs(root, env),
        "--launch-order",
        expect.stringMatching(/^\d+$/u),
      ]);
      expect(options.env.KEIKO_PORTABLE_MANAGEMENT).toBe("organization-managed");
      // A Keiko that ended by a signal carries no exit code; the start reports a failure.
      expect(start(root, nodeDir, env, () => ({ status: null }))).toBe(1);
    });

    it("names why Keiko could not be started when the system refuses to run it", () => {
      // CodeRabbit on PR #4464: a refused spawn ended Start and Stop with exit code 1 and no reason.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      installKeiko(root, `${lockfileDigest(root)}\n`);
      const refused = (code) => () => ({
        status: null,
        error: Object.assign(new Error(`spawn ${root}`), code === undefined ? {} : { code }),
      });

      expect(start(root, nodeDir, env, refused("EACCES"))).toBe(1);
      expect(log).toHaveBeenCalledWith("Keiko could not be started (EACCES).");
      expect(stop(root, env, refused("ENOENT"))).toBe(1);
      expect(log).toHaveBeenCalledWith(
        'Keiko is incomplete: the Node.js runtime is missing in the folder "system". Unpack the folder again.',
      );
      expect(start(root, nodeDir, env, refused(undefined))).toBe(1);
      expect(log).toHaveBeenCalledWith("Keiko could not be started (unknown error).");
      expect(log.mock.calls.flat().join("\n")).not.toContain(root);
    });

    it("installs and then starts Keiko, releasing the folder's installation lock", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true);
      const run = vi.fn((node, args, options) =>
        args.includes("ci") ? npm.run(node, args, options) : { status: 0 },
      );

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][1]).toEqual([
        keikoCliPath(root),
        ...startArgs(root, env),
        "--launch-order",
        expect.stringMatching(/^\d+$/u),
      ]);
      expect(existsSync(installLockPath(root))).toBe(false);
      expect(lockLeftovers(root)).toEqual([]);
      // The start says itself that Keiko is open: the start file prints only a failure.
      expect(log).toHaveBeenCalledWith(
        "Keiko is running. The lines above say whether it opened in your browser. You can close this window; Keiko keeps running.",
      );
    });

    it("reports a failed first start and leaves the lock free for the next one", () => {
      quiet();
      const { root, nodeDir, env } = installFixture();

      expect(start(root, nodeDir, env, fakeNpm(root, false).run)).toBe(1);
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("lets one start of a folder install and tells a second start so", () => {
      // Review finding on PR #4464 (P2): two starts could both run `npm ci` on the same tree.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const lock = acquireInstallLock(root);
      expect(lock).toBeDefined();
      const run = vi.fn();

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(run).not.toHaveBeenCalled();
      // The second start says another one is opening Keiko, never that Keiko is open.
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^Another start of this folder is opening Keiko\./u),
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^Keiko is running\./u));
      expect(acquireInstallLock(root)).toBeUndefined();
      expect(releaseInstallLock(lock)).toBe(false);
      expect(existsSync(installLockPath(root))).toBe(false);
      expect(acquireInstallLock(root)).toBeDefined();
    });

    it("publishes the lock complete, so a start that comes meanwhile never finds it empty", () => {
      // Review finding on PR #4464 (P2): the lock file existed before its pid was written, and a
      // second start took that empty lock for a stale one; both starts installed.
      const { root } = installFixture();
      const seen = [];
      const first = acquireInstallLock(root, (step) => {
        // The first start's lock is prepared, not yet in place: the second start finds no lock at
        // all and takes it, and the first start then finds the second one holding it.
        if (step === "publish") seen.push(installerActive(root), acquireInstallLock(root));
      });

      expect(seen[0]).toBe(false);
      expect(seen[1]).toBeDefined();
      expect(first).toBeUndefined();
      expect(lockOwners(root)).toEqual([`owner-${seen[1].token}`]);
      expect(lockLeftovers(root)).toEqual([]);
    });

    it("lets one of two starts take over a lock whose start no longer runs", () => {
      const { root } = installFixture();
      const ended = endedPid();
      staleLock(root, ended);
      let second;
      const first = acquireInstallLock(root, (step) => {
        // Both starts read the stale lock; the second clears and takes it while the first waits.
        if (step === "clear" && second === undefined) second = acquireInstallLock(root);
      });

      expect(second).toBeDefined();
      expect(first).toBeUndefined();
      expect(lockOwners(root)).toEqual([`owner-${second.token}`]);
    });

    it("takes over the lock of a start that no longer runs, with what that start left", () => {
      const { root } = installFixture();
      const ended = endedPid();
      staleLock(root, ended, [`stop-${String(ended)}-ab`]);
      mkdirSync(join(root, "system", `keiko-npm-install.lock.${String(ended)}-cd.candidate`));
      mkdirSync(join(root, "system", `keiko-npm-install.lock.${String(ended)}-ef.released`));
      // A leftover of a start that still runs is still on its way and stays.
      const running = `keiko-npm-install.lock.${String(process.pid)}-12.candidate`;
      mkdirSync(join(root, "system", running));

      const lock = acquireInstallLock(root);
      expect(lock).toBeDefined();
      expect(readdirSync(installLockPath(root))).toEqual([`owner-${lock.token}`]);
      expect(lockLeftovers(root)).toEqual([running]);
      // The Stop that went to the start that ended does not cancel this one.
      expect(releaseInstallLock(lock)).toBe(false);
    });

    it("takes over a lock whose reused process number does not renew, once it was observed", () => {
      // Audit of PR #4464 (finding 2): a killed start's process number runs again, and the folder
      // stood for a day with "another start is opening Keiko". A holder proves itself by renewing.
      const { root } = installFixture();
      clock.renewing = false;
      staleLock(root, process.pid, [], "1\n");

      expect(requestStop(root)).toBe(false);
      const lock = acquireInstallLock(root);
      expect(lock).toBeDefined();
      // The observation took the whole window on the monotonic clock, and no more.
      expect(clock.now).toBeGreaterThanOrEqual(60_000);
      expect(clock.now).toBeLessThan(130_000);
      expect(lockOwners(root)).toEqual([`owner-${lock.token}`]);
      clock.renewing = true;
      expect(installerActive(root)).toBe(true);
      expect(acquireInstallLock(root)).toBeUndefined();
    });

    it("clears at once a lock none of whose entries has a running process number", () => {
      const { root } = installFixture();
      staleLock(root, endedPid());

      expect(acquireInstallLock(root)).toBeDefined();
      expect(clock.now).toBe(0);
    });

    it("keeps the lock of a renewing owner whatever its timestamps and the wall clock say", () => {
      // Audit of PR #4464 (finding 1): after a long suspend or a forward clock step every entry
      // looked written before the computer started, and a live npm's lock was cleared.
      const { root } = installFixture();
      staleLock(root, process.pid, [], "1\n");
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 30 * 24 * 60 * 60 * 1000);

      expect(installerActive(root)).toBe(true);
      expect(acquireInstallLock(root)).toBeUndefined();
      expect(requestStop(root)).toBe(true);
    });

    it("decides by renewal and not by wall-clock timestamps across processes", () => {
      const { root } = installFixture();
      const lock = acquireInstallLock(root);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() - 365 * 24 * 60 * 60 * 1000);
      expect(acquireInstallLock(root)).toBeUndefined();
      expect(releaseInstallLock(lock)).toBe(false);
    });

    it("leaves a lock another start took over to that start when it ends", () => {
      const { root } = installFixture();
      const lock = acquireInstallLock(root);
      // Another start judged this one's lock expired and took it over.
      rmSync(installLockPath(root), { recursive: true });
      const other = acquireInstallLock(root);
      requestStop(root);

      expect(releaseInstallLock(lock)).toBe(false);
      expect(lockOwners(root)).toEqual([`owner-${other.token}`]);
      expect(releaseInstallLock(other)).toBe(true);
    });

    it("ends quietly when another start took its lock over and has released it", () => {
      // Audit of PR #4464: the owner check and the rename were two steps, so a lock released in
      // between ended the start with ENOENT instead of its message.
      const { root } = installFixture();
      const lock = acquireInstallLock(root);
      rmSync(installLockPath(root), { recursive: true });
      releaseInstallLock(acquireInstallLock(root));

      expect(releaseInstallLock(lock)).toBe(false);
      expect(existsSync(installLockPath(root))).toBe(false);
      expect(
        readdirSync(dirname(installLockPath(root))).filter((name) => /released/u.test(name)),
      ).toEqual([]);
    });

    it("releases only the generation it acquired and never touches a replacement", () => {
      // Review finding on PR #4464 (P1): release moved the canonical lock first and read its owner
      // afterwards, so a replacement's live lock was moved, its slot was vacant for a moment and a
      // third start could take it.
      const { root } = installFixture();
      const dir = installLockPath(root);
      const lock = acquireInstallLock(root);
      rmSync(dir, { recursive: true });
      const other = acquireInstallLock(root);
      const changed = statSync(dir).ctimeMs;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);

      expect(releaseInstallLock(lock)).toBe(false);
      expect(statSync(dir).ctimeMs).toBe(changed);
      expect(lockOwners(root)).toEqual([`owner-${other.token}`]);
      expect(lockLeftovers(root)).toEqual([]);
      expect(acquireInstallLock(root)).toBeUndefined();
    });

    it("keeps the closing generation exclusive and refuses a Stop that comes after it closed", () => {
      // Review finding on PR #4464 (P2): a Stop accepted after the last read was acted on after the
      // lock was released, and stopped the Keiko a later start had opened.
      const { root } = installFixture();
      const lock = acquireInstallLock(root);
      expect(requestStop(root)).toBe(true);

      expect(closeInstallLock(lock)).toEqual({
        owned: true,
        stopRequested: true,
        pressedAt: expect.any(Number),
      });
      // Closed, not released: no other start takes the lock, and no further Stop is accepted by it.
      expect(acquireInstallLock(root)).toBeUndefined();
      expect(requestStop(root)).toBe(false);
      expect(readdirSync(installLockPath(root)).filter((n) => n.startsWith("stop-"))).toHaveLength(
        1,
      );
      removeInstallLock(lock);
      expect(existsSync(installLockPath(root))).toBe(false);
      expect(acquireInstallLock(root)).toBeDefined();
    });

    it("carries a Stop that arrives while the start closes out before the lock is released", () => {
      quiet();
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true);
      let lockHeldDuringStop;
      const run = vi.fn((node, args, options) => {
        if (args.includes("ci")) return npm.run(node, args, options);
        if (args[1] === "start") requestStop(root);
        if (args[1] === "stop") lockHeldDuringStop = existsSync(installLockPath(root));
        return { status: 0 };
      });

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(lockHeldDuringStop).toBe(true);
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("holds the lock also when Keiko is already loaded, so a Stop meanwhile is carried out", () => {
      // Audit of PR #4464 (P2): a start that installed nothing opened Keiko without the lock, and
      // a Stop in that time stopped nothing.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      installKeiko(root, `${lockfileDigest(root)}\n`);
      const stopRun = vi.fn();
      const stopped = [];
      const run = vi.fn((_node, args) => {
        if (args[1] === "start") stopped.push(stop(root, env, stopRun));
        return { status: 0 };
      });

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(stopped).toEqual([0]);
      expect(stopRun).not.toHaveBeenCalled();
      expect(run.mock.calls.map(commandOf)).toEqual(["start", "stop"]);
      expect(log).toHaveBeenCalledWith(
        "Keiko is still being loaded. It does not stay open: the start that loads it stops it.",
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^Keiko is running\./u));
    });

    it("keeps Keiko from opening when Stop comes while it is being loaded", () => {
      // Review finding on PR #4464 (P2): Stop reported success before the CLI existed while the
      // pending start still opened Keiko.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const stopRun = vi.fn();
      const stopped = [];
      const npm = fakeNpm(root, true, () => stopped.push(stop(root, env, stopRun)));
      const run = vi.fn((node, args, options) =>
        args.includes("ci") ? npm.run(node, args, options) : { status: 0 },
      );

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(stopped).toEqual([0]);
      expect(stopRun).not.toHaveBeenCalled();
      // npm ran and Keiko was not opened; the start carried the Stop out, so a Keiko an earlier
      // start of the folder opened stops as well.
      expect(run.mock.calls.map(commandOf)).toEqual(["ci", "stop"]);
      expect(log).toHaveBeenCalledWith(
        "Keiko was stopped while it was being loaded and does not start. You can close this window.",
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^Keiko is running\./u));
      expect(existsSync(installLockPath(root))).toBe(false);
      expect(lockLeftovers(root)).toEqual([]);
    });

    it("stops Keiko again when Stop comes while the loading start opens it", () => {
      // Review finding on PR #4464 (P2): the start let go of its lock before it opened Keiko, so a
      // Stop in between ran an ordinary stop of nothing and Keiko opened afterwards.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true);
      const stopRun = vi.fn();
      const stopped = [];
      const run = vi.fn((node, args, options) => {
        if (args.includes("ci")) return npm.run(node, args, options);
        // Keiko opens while the start still holds the lock; this Stop lands in it.
        if (args[1] === "start") stopped.push(stop(root, env, stopRun));
        return { status: 0 };
      });

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(stopped).toEqual([0]);
      expect(stopRun).not.toHaveBeenCalled();
      expect(run.mock.calls.map(commandOf)).toEqual(["ci", "start", "stop"]);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^Keiko was stopped again right after it opened/u),
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^Keiko is running\./u));
    });

    it("leaves a Stop after the loading start to stop the opened Keiko itself", () => {
      quiet();
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true);
      const run = vi.fn((node, args, options) =>
        args.includes("ci") ? npm.run(node, args, options) : { status: 0 },
      );
      expect(start(root, nodeDir, env, run)).toBe(0);

      // The start let go of its lock only once Keiko was open: this Stop finds no lock.
      expect(requestStop(root)).toBe(false);
      const stopRun = vi.fn(() => ({ status: 0 }));
      expect(stop(root, env, stopRun)).toBe(0);
      expect(stopRun.mock.calls.map(commandOf)).toEqual(["stop"]);
    });

    it("reports Keiko's own exit code when it fails to open after the installation", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true);
      const run = vi.fn((node, args, options) =>
        args.includes("ci") ? npm.run(node, args, options) : { status: 4 },
      );

      expect(start(root, nodeDir, env, run)).toBe(4);
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^Keiko is running\./u));
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("reports a Stop it could not carry out with the stop's exit code", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true, () => requestStop(root));
      const run = vi.fn((node, args, options) =>
        args.includes("ci") ? npm.run(node, args, options) : { status: 5 },
      );

      expect(start(root, nodeDir, env, run)).toBe(5);
      expect(run.mock.calls.map(commandOf)).toEqual(["ci", "stop"]);
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/was stopped/u));
    });

    it("holds the lock while it carries out a recorded Stop, so no other start opens Keiko in between", () => {
      // Review finding on PR #4464: the start let go of the lock before it ran the recorded Stop,
      // so a start in that moment opened Keiko, said so, and the Stop then ended it.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true, () => requestStop(root));
      const other = vi.fn(() => ({ status: 0 }));
      const duringStop = [];
      const run = vi.fn((node, args, options) => {
        if (args.includes("ci")) return npm.run(node, args, options);
        if (args[1] === "stop") {
          duringStop.push(existsSync(installLockPath(root)), start(root, nodeDir, env, other));
        }
        return { status: 0 };
      });

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(run.mock.calls.map(commandOf)).toEqual(["ci", "stop"]);
      // Owner finding L5 on PR #4464: the closing holder here only carries a Stop out and opens
      // nothing, so a start pressed meanwhile is told to try again (exit 1) instead of being told
      // that another window opens Keiko (exit 0). It still opens nothing and the lock stays held.
      expect(duringStop).toEqual([true, 1]);
      expect(other).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^Another start of this folder/u));
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Keiko is still being closed/u));
      expect(log).toHaveBeenCalledWith(
        "Keiko was stopped while it was being loaded and does not start. You can close this window.",
      );
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it.each([
      ["holds it", true],
      ["released it", false],
    ])(
      "neither reads nor carries out a Stop in a lock another start took over and %s",
      (_label, otherHolds) => {
        // Audit of PR #4464: the start read the Stop entries of a lock another start had taken
        // over, and failed with ENOENT when that start had released it meanwhile.
        quiet();
        const { root, nodeDir, env } = installFixture();
        let other;
        const npm = fakeNpm(root, true, () => {
          rmSync(installLockPath(root), { recursive: true });
          other = acquireInstallLock(root);
          requestStop(root);
          if (!otherHolds) releaseInstallLock(other);
        });
        const run = vi.fn((node, args, options) =>
          args.includes("ci") ? npm.run(node, args, options) : { status: 0 },
        );

        // Review finding on PR #4464 (P2): the old start used to dispatch `start` here, reopening
        // Keiko after the replacement's Stop. It now ends without opening Keiko or marking.
        expect(() => start(root, nodeDir, env, run)).toThrow(LauncherRefusal);
        expect(run.mock.calls.map(commandOf)).toEqual(["ci"]);
        expect(existsSync(join(root, "node_modules", ".keiko-npm-installed"))).toBe(false);
        expect(existsSync(installLockPath(root))).toBe(otherHolds);
        if (otherHolds) expect(lockOwners(root)).toEqual([`owner-${other.token}`]);
      },
    );

    it("ends a start that lost its lock before it opens Keiko when nothing needed installing", () => {
      quiet();
      const { root, nodeDir, env } = installFixture();
      installKeiko(root, `${lockfileDigest(root)}\n`);
      const run = vi.fn(() => ({ status: 0 }));
      // Another start replaces the lock right after this one published it.
      const replacement = `owner-${String(process.pid)}-0b`;
      lockRenewal.start.mockImplementation(() => {
        rmSync(installLockPath(root), { recursive: true });
        mkdirSync(installLockPath(root));
        writeFileSync(join(installLockPath(root), replacement), "");
        return () => undefined;
      });

      expect(() => start(root, nodeDir, env, run)).toThrow(LauncherRefusal);
      expect(run).not.toHaveBeenCalled();
      expect(lockOwners(root)).toEqual([replacement]);
    });

    it("lets a Stop that the closing lock turned away act only after that start let go", () => {
      // Review finding on PR #4464 (P2): the turned-away Stop ran the CLI with no lock, so a new
      // start could open Keiko just before the old Stop shut it down.
      quiet();
      const { root, env } = installFixture();
      installKeiko(root);
      const lock = acquireInstallLock(root);
      closeInstallLock(lock);
      const during = [];
      const run = vi.fn(() => {
        during.push(lockOwners(root).length === 1);
        return { status: 0 };
      });
      vi.spyOn(lockClock, "sleep").mockImplementation(() => removeInstallLock(lock));

      expect(stop(root, env, run)).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      // The Stop held the lock while it acted, so no start could open Keiko in between.
      expect(during).toEqual([true]);
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("leaves a later start's Keiko open instead of recording a waiting Stop in its lock", () => {
      // Coordinator refinement on PR #4464 (P2): a start that wins the lock after the closing one
      // let go reports Keiko running; the waiting Stop must not then end it behind that report.
      // That start began after the Stop was pressed, so the Stop is not recorded in its lock either
      // (owner recheck, thread GMvW): the start opens Keiko and the Stop leaves it open.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, env } = installFixture();
      installKeiko(root);
      const closing = acquireInstallLock(root);
      closeInstallLock(closing);
      const base = lockClock.sleep.getMockImplementation();
      const cli = lifecycleCli();
      let later;
      let closed;
      vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
        // Only once the Stop has been turned away and waits: the first observations are its own.
        if (later === undefined && clock.now >= 30_000) {
          removeInstallLock(closing);
          later = acquireInstallLock(root);
        } else if (later !== undefined && closed === undefined && clock.now >= 60_000) {
          cli.open(root, env, later);
          closed = closeInstallLock(later);
          removeInstallLock(later);
        }
        base(milliseconds, dir);
      });

      expect(stop(root, env, cli.run)).toBe(0);
      // The Stop asked that start's lock while it held it, and was not recorded there.
      expect(closed).toEqual({ owned: true, stopRequested: false });
      expect(cli.commands).toEqual(["start", "stop"]);
      expect(cli.running).toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^Keiko was started again while Stop/u),
      );
    });

    it("lets a start pressed while a Stop acts wait for that Stop and then open Keiko", () => {
      // Audit of PR #4464: a Stop holding the lock turned a start pressed meanwhile away as if
      // another start were opening Keiko, so Keiko stayed stopped although Start came last.
      quiet();
      const { root, nodeDir, env } = installFixture();
      installKeiko(root, `${lockfileDigest(root)}\n`);
      const commands = [];
      let started;
      const run = vi.fn((_node, args) => {
        commands.push(args[1]);
        if (args[1] === "stop") {
          // Start is pressed while the Stop runs the CLI under its renewing lock; the Stop lets
          // go of the lock only after that start has seen the lock held and waits.
          const base = lockClock.sleep.getMockImplementation();
          const pressed = clock.now;
          lockClock.sleep.mockImplementation((milliseconds, dir) => {
            if (clock.now - pressed >= 30_000) {
              rmSync(installLockPath(root), { recursive: true, force: true });
            }
            base(milliseconds, dir);
          });
          started = start(root, nodeDir, env, run);
          lockClock.sleep.mockImplementation(base);
        }
        return { status: 0 };
      });

      expect(stop(root, env, run)).toBe(0);
      expect(started).toBe(0);
      expect(commands).toEqual(["stop", "start"]);
    });

    it("stops Keiko at once when only npm of a start that already ended holds the lock", () => {
      // Audit of PR #4464: such a lock made the Stop wait 90 seconds and then not act.
      quiet();
      const { root, env } = installFixture();
      installKeiko(root);
      mkdirSync(installLockPath(root), { recursive: true });
      writeFileSync(join(installLockPath(root), `npm-${String(process.pid)}-0c`), "1\n");
      const base = lockClock.sleep.getMockImplementation();
      vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
        // npm keeps renewing its entry.
        writeFileSync(join(installLockPath(root), `npm-${String(process.pid)}-0c`), "2\n");
        base(milliseconds, dir);
      });
      const before = lockClock.now();
      const run = vi.fn(() => ({ status: 0 }));

      expect(stop(root, env, run)).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(lockClock.now() - before).toBeLessThanOrEqual(60_000);
    });

    it("says Stop did not act when the closing start never lets go of the lock", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, env } = installFixture();
      installKeiko(root);
      closeInstallLock(acquireInstallLock(root));
      const run = vi.fn(() => ({ status: 0 }));

      expect(stop(root, env, run)).toBe(1);
      expect(run).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^Another start of this folder is still/u),
      );
    });

    it("says it cannot stop Keiko when Stop was pressed and the installation failed", () => {
      // Review finding on PR #4464: a Stop recorded during a failed installation was dropped
      // silently while the Stop window had said the start would stop Keiko.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, false, () => requestStop(root));

      expect(start(root, nodeDir, env, npm.run)).toBe(1);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/this folder could not load Keiko and cannot stop it\./u),
      );
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("says the Stop was not carried out when the start ends with an error", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true, () => requestStop(root));
      const run = vi.fn((node, args, options) => {
        if (args.includes("ci")) return npm.run(node, args, options);
        throw new RangeError("the stop could not run");
      });

      expect(() => start(root, nodeDir, env, run)).toThrow(RangeError);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(
          /ended with an error before it stopped Keiko\. Double-click Stop Keiko again\./u,
        ),
      );
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("carries out a Stop also when Keiko reported a failure as it opened", () => {
      quiet();
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true);
      const run = vi.fn((node, args, options) => {
        if (args.includes("ci")) return npm.run(node, args, options);
        if (args[1] !== "start") return { status: 0 };
        requestStop(root);
        return { status: 6 };
      });

      // Whatever part of Keiko came up stops, and the start reports why Keiko did not open.
      expect(start(root, nodeDir, env, run)).toBe(6);
      expect(run.mock.calls.map(commandOf)).toEqual(["ci", "start", "stop"]);
    });

    it("refuses a lock it cannot take instead of waiting for it", () => {
      const { root } = installFixture();
      const dir = installLockPath(root);
      const ended = endedPid();
      staleLock(root, ended);
      let added = 0;
      // Every clearing finds one more entry, so the lock never empties.
      const pause = (step) => {
        if (step !== "clear") return;
        added += 1;
        writeFileSync(join(dir, `stop-${String(ended)}-${added.toString(16)}`), "");
      };

      expect(() => acquireInstallLock(root, pause)).toThrow(LauncherRefusal);
      expect(() => acquireInstallLock(root, pause)).toThrow(/cannot be taken/u);
      expect(lockLeftovers(root)).toEqual([]);
    });

    it("marks nothing installed when npm succeeds without installing this platform's runtime", () => {
      // Review finding on PR #4464 (P2): an inherited `omit=optional` left the Coding runtime out,
      // npm still exited 0, and the marker kept every later start from repairing it.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const runtime = `node_modules/@oscharko-dev/keiko-coding-runtime-${process.platform}-${process.arch}`;
      writeFileSync(
        join(root, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/@oscharko-dev/keiko": { version: "1.5.3" },
            [runtime]: { version: "1.5.3", optional: true, os: [process.platform] },
          },
        }),
      );
      const keikoOnly = fakeNpm(root, true, () => {
        writeFileSync(
          join(root, "node_modules", "@oscharko-dev", "keiko", "package.json"),
          '{"version":"1.5.3"}',
        );
      });
      // fakeNpm installs Keiko's command line after `during`; make the folder first.
      mkdirSync(join(root, "node_modules", "@oscharko-dev", "keiko"), { recursive: true });

      expect(ensureInstalled(root, nodeDir, env, keikoOnly.run)).toBe(false);
      expect(installationCurrent(root, lockfileDigest(root))).toBe(false);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(runtime.slice("node_modules/".length)),
      );

      const complete = fakeNpm(root, true, () => {
        writeFileSync(
          join(root, "node_modules", "@oscharko-dev", "keiko", "package.json"),
          '{"version":"1.5.3"}',
        );
        mkdirSync(join(root, ...runtime.split("/")), { recursive: true });
        writeFileSync(join(root, ...runtime.split("/"), "package.json"), '{"version":"1.5.3"}');
      });
      expect(ensureInstalled(root, nodeDir, env, complete.run)).toBe(true);
      expect(installationCurrent(root, lockfileDigest(root))).toBe(true);
    });

    it("refuses a competing npm-shrinkwrap.json before npm runs", () => {
      // Review finding on PR #4464 (P2): npm installs npm-shrinkwrap.json before package-lock.json,
      // while the marker records the shipped lockfile.
      const { root, nodeDir, env } = installFixture();
      writeFileSync(join(root, "npm-shrinkwrap.json"), '{"lockfileVersion":3}');
      const run = vi.fn();

      expect(() => start(root, nodeDir, env, run)).toThrow(/npm-shrinkwrap\.json/u);
      expect(run).not.toHaveBeenCalled();
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it.each(["dir", "junction"])(
      "refuses a node_modules that is a %s link before npm empties it",
      (type) => {
        // Review finding on PR #4464 (P2): npm ci deletes the entries of node_modules, and through
        // a link or junction those of a shared folder.
        const { root, nodeDir, env } = installFixture();
        const shared = join(tempDir(), "shared-modules");
        mkdirSync(join(shared, "kept"), { recursive: true });
        writeFileSync(join(shared, ".keiko-npm-installed"), "other\n");
        symlinkSync(shared, join(root, "node_modules"), type);
        const run = vi.fn();

        expect(() => start(root, nodeDir, env, run)).toThrow(/node_modules/u);
        expect(run).not.toHaveBeenCalled();
        expect(readdirSync(shared).sort()).toEqual([".keiko-npm-installed", "kept"]);
        expect(() => refuseForeignInstallTarget(root)).toThrow(LauncherRefusal);
      },
    );

    it("lets npm's own process hold the lock, so a start that ends early leaves it held", () => {
      // Review finding on PR #4464 (P2): the lock named only the start, and a start killed while
      // `npm ci` still ran let the next start install beside that npm.
      quiet();
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true);

      expect(ensureInstalled(root, nodeDir, env, npm.run)).toBe(true);
      expect(npm.calls[0].args.slice(0, 2)).toEqual(holdArgs(installLockPath(root)));

      // The start that ran npm ended; npm's own entry still holds the lock.
      staleLock(root, endedPid());
      const held = heldByTest(installLockPath(root)).entry;
      expect(acquireInstallLock(root)).toBeUndefined();
      // npm still runs but its start does not: the start that loads Keiko is gone, so a Stop is
      // not recorded (it would promise a stop nobody carries out) and stops Keiko itself.
      expect(requestStop(root)).toBe(false);
      expect(readdirSync(installLockPath(root)).filter((n) => n.startsWith("stop-"))).toEqual([]);
      rmSync(held);
      expect(acquireInstallLock(root)).toBeDefined();
    });

    it("tells npm which entry of the lock belongs to the start that runs it", () => {
      // Review finding on PR #4464 (Major): npm's process renews that entry, so it must be the
      // start's own, the one the lock holds while npm runs.
      quiet();
      const { root, nodeDir, env } = installFixture();
      let owners;
      const npm = fakeNpm(root, true, () => {
        owners = lockOwners(root);
      });
      // npm installs; Keiko's own command opens it.
      const run = (node, args, options) =>
        args.includes("ci") ? npm.run(node, args, options) : { status: 0 };

      expect(start(root, nodeDir, env, run)).toBe(0);
      const [ci] = npm.calls;
      const hold = new URL(ci.args[1]).searchParams;
      expect(owners).toEqual([hold.get("keep-install-lock-owner")]);
      expect(ci.args.slice(0, 2)).toEqual(
        holdArgs(installLockPath(root), hold.get("keep-install-lock-owner")),
      );
    });

    it("keeps the lock of an installation that runs for hours while it renews", () => {
      // Review finding on PR #4464 (Major): the lock expired after a fixed time while npm still
      // ran, and a second start ran `npm ci` beside it. Renewal, not age, keeps it.
      const { root } = installFixture();
      const dir = installLockPath(root);
      const lock = acquireInstallLock(root);
      const hold = heldByTest(dir, `owner-${lock.token}`);
      const longAgo = "1\n";
      writeFileSync(join(dir, `owner-${lock.token}`), longAgo);
      writeFileSync(hold.entry, longAgo);
      expect(installerActive(root)).toBe(true);
      expect(acquireInstallLock(root)).toBeUndefined();

      // npm ends: its entry goes and the lock stays with the start until it releases it.
      hold.exit();
      expect(hold.renew).toBeUndefined();
      expect(lockOwners(root)).toEqual([`owner-${lock.token}`]);
      expect(acquireInstallLock(root)).toBeUndefined();
      expect(releaseInstallLock(lock)).toBe(false);
      expect(acquireInstallLock(root)).toBeDefined();
    });

    it("renews the start's own entry from a worker while the start is blocked", () => {
      // Audit of PR #4464 (finding 2): the start renews itself for the whole time it holds the
      // lock, also while a synchronous npm run blocks it, and never recreates a removed entry.
      const { root } = installFixture();
      const dir = installLockPath(root);
      const lock = acquireInstallLock(root);
      const entry = join(dir, `owner-${lock.token}`);
      const before = readFileSync(entry, "utf8");
      lockRenewal.everyMs = 30;
      try {
        const stopRenewing = realRenewalStart(entry);
        const deadline = Date.now() + 10_000;
        // The main thread is blocked here, as it is while it waits for npm.
        while (readFileSync(entry, "utf8") === before && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
        expect(readFileSync(entry, "utf8")).not.toBe(before);
        expect(readFileSync(entry, "utf8")).toMatch(/^\d+\n$/u);
        rmSync(entry);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        expect(existsSync(entry)).toBe(false);
        stopRenewing();
      } finally {
        lockRenewal.everyMs = 15_000;
      }
    });

    it("renews the start's entry also when the start runs as an ES module eval", () => {
      // The start's worker is the only renewer of its entry (npm no longer renews it), and the
      // parent's `--input-type=module` must not turn the worker's CommonJS source into a failure.
      const dir = installLockPath(installFixture().root);
      mkdirSync(dir, { recursive: true });
      const entry = join(dir, "owner-1-0a");
      writeFileSync(entry, "1\n");
      const script = `
        import { readFileSync } from "node:fs";
        const launcher = await import(${JSON.stringify(
          pathToFileURL(join(import.meta.dirname, "..", "standalone", "npm", "keiko-npm.mjs")).href,
        )});
        launcher.lockRenewal.everyMs = 30;
        const stop = launcher.lockRenewal.start(${JSON.stringify(entry)});
        const until = Date.now() + 5000;
        while (readFileSync(${JSON.stringify(entry)}, "utf8") === "1\\n" && Date.now() < until) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
        stop();
        process.stdout.write(readFileSync(${JSON.stringify(entry)}, "utf8"));
      `;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      });

      expect(child.stdout).toMatch(/^\d{13}\n$/u);
      expect(child.stdout).not.toBe("1\n");
    });

    it("records a Stop only in a lock whose start runs and renews", () => {
      // Audit of PR #4464 (finding 3): a Stop was accepted by the lock of a dead start whose npm
      // still ran, which promised a stop nobody carried out.
      const { root } = installFixture();
      staleLock(root, endedPid());
      heldByTest(installLockPath(root));
      expect(requestStop(root)).toBe(false);

      clock.renewing = false;
      rmSync(installLockPath(root), { recursive: true });
      staleLock(root, process.pid);
      expect(requestStop(root)).toBe(false);

      // npm renews but the start's entry does not: the start is frozen or its number was reused.
      rmSync(installLockPath(root), { recursive: true });
      staleLock(root, process.pid);
      clock.renewing = true;
      clock.frozen.add(`owner-${String(process.pid)}-0a`);
      heldByTest(installLockPath(root));
      expect(requestStop(root)).toBe(false);

      clock.frozen.clear();
      expect(requestStop(root)).toBe(true);
    });

    it("ignores a closing entry that has no owner entry of its start beside it", () => {
      // Audit of PR #4464 (finding 4): a start killed after it added its closing entry left it in
      // a lock another start published, and every later Stop fell through.
      const { root } = installFixture();
      const lock = acquireInstallLock(root);
      writeFileSync(join(installLockPath(root), `closing-${String(endedPid())}-ab`), "");

      expect(requestStop(root)).toBe(true);
      // The start's own closing entry still closes the lock.
      expect(closeInstallLock(lock).owned).toBe(true);
      expect(requestStop(root)).toBe(false);
    });

    it("renews only entries still in the lock and nothing outside it", () => {
      quiet();
      const { root } = installFixture();
      const dir = installLockPath(root);
      mkdirSync(dir, { recursive: true });
      const outside = join(root, "system", "outside.txt");
      writeFileSync(outside, "kept\n");
      const start = `owner-${String(process.pid)}-ab`;
      writeFileSync(join(dir, start), "1\n");

      // A start whose entry was taken over after npm joined does not get it back, and npm ends.
      const onLost = vi.fn();
      const hold = heldByTest(dir, start, { onLost });
      rmSync(join(dir, start));
      hold.renew();
      expect(onLost).toHaveBeenCalledOnce();
      hold.exit();
      expect(readdirSync(dir)).toEqual([]);
      // A name that is no owner entry of this lock is never joined or written.
      expect(() => heldByTest(dir, "../outside.txt")).toThrow(/not the one of the start/u);
      expect(readFileSync(outside, "utf8")).toBe("kept\n");
      expect(readdirSync(dir)).toEqual([]);
    });

    it("never lets an owner entry stand empty or stale when a renewal fails", () => {
      // Review finding on PR #4464: renewal emptied the file before it wrote, so a failed write
      // left an owner without a timestamp, which never expired once its number was reused.
      quiet();
      const { root } = installFixture();
      const dir = installLockPath(root);
      const lock = acquireInstallLock(root);
      const entry = join(dir, `owner-${lock.token}`);
      const before = readFileSync(entry, "utf8");
      const sizes = [];
      let failing = true;
      const hold = heldByTest(dir, `owner-${lock.token}`, {
        write: (fd, bytes, offset, length, position) => {
          sizes.push(statSync(entry).size);
          if (failing) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          return writeSync(fd, bytes, offset, length, position);
        },
      });

      hold.renew();
      expect(readFileSync(entry, "utf8")).toBe(before);
      expect(sizes[0]).toBeGreaterThan(0);
      failing = false;
      hold.renew();
      expect(Number(readFileSync(entry, "utf8"))).toBeGreaterThanOrEqual(Number(before));
      expect(readFileSync(entry, "utf8")).toMatch(/^\d+\n$/u);
    });

    it("ends npm before it does anything when the lock is not its start's generation", () => {
      // Review findings on PR #4464: npm's preload returned quietly when the lock was gone and
      // joined a lock another start had published, so two npm processes could share a folder.
      quiet();
      const { root } = installFixture();
      const dir = installLockPath(root);
      const probe = "process.stdout.write('installed')";
      const run = (keep) =>
        spawnSync(process.execPath, [...holdArgs(dir, keep), "-e", probe], { encoding: "utf8" });
      const mine = `owner-${String(process.pid)}-ab`;

      // The lock is gone.
      expect(run(mine).status).toBe(1);
      expect(run(mine).stdout).not.toMatch(/installed/u);
      expect(run(mine).stdout).toMatch(/no longer the one of the start that ran npm/u);
      // Another start's lock: its generation holds no entry of the start that ran npm.
      const other = acquireInstallLock(root);
      const foreign = run(mine);
      expect(foreign.status).toBe(1);
      expect(foreign.stdout).not.toMatch(/installed/u);
      expect(lockOwners(root)).toEqual([`owner-${other.token}`]);
      // The generation that holds the start's entry is joined and npm runs.
      const joined = run(`owner-${other.token}`);
      expect(joined.status).toBe(0);
      expect(joined.stdout).toBe("installed");
      expect(lockOwners(root)).toEqual([`owner-${other.token}`]);
    });

    it("says once that it cannot renew the lock and never ends npm over it", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root } = installFixture();
      const dir = installLockPath(root);
      // The start's entry, and npm's own entry whose renewal cannot be written.
      const unwritable = `owner-${String(process.pid)}-cd`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, unwritable), "1\n");
      const hold = heldByTest(dir, unwritable, {
        write: () => {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        },
      });

      expect(() => hold.renew()).not.toThrow();
      expect(() => hold.renew()).not.toThrow();
      expect(() => hold.exit()).not.toThrow();
      expect(log.mock.calls.filter(([line]) => /could not renew/u.test(line))).toHaveLength(1);
      expect(readdirSync(dir)).toEqual([unwritable]);
    });

    it("adds npm's entry to the lock while npm runs and removes it when npm exits", () => {
      const { root } = installFixture();
      const dir = installLockPath(root);
      mkdirSync(dir, { recursive: true });
      // The entry of the start that runs npm, written long ago.
      const keep = `owner-${String(process.pid)}-ab`;
      writeFileSync(join(dir, keep), "1\n");
      const child = spawnSync(
        process.execPath,
        [
          ...holdArgs(dir, keep),
          "-e",
          "process.stdout.write(JSON.stringify(require('node:fs').readdirSync(process.argv[1]).sort()))",
          dir,
        ],
        { encoding: "utf8" },
      );

      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual([
        // npm's own entry carries its own kind, so a Stop never mistakes it for the start's.
        expect.stringMatching(new RegExp(`^npm-${String(child.pid)}-[0-9a-f]+$`, "u")),
        keep,
      ]);
      // npm's entry went with npm, and the start's entry stays the start's own signal: npm never
      // rewrites it (audit of PR #4464), so it changes only while the start's process renews it.
      expect(readdirSync(dir)).toEqual([keep]);
      expect(readFileSync(join(dir, keep), "utf8")).toBe("1\n");
      // Without a lock there is nothing to hold and nothing is created.
      rmSync(dir, { recursive: true });
      expect(heldByTest(dir).entry).toBeUndefined();
      expect(existsSync(dir)).toBe(false);
    });

    // Windows answers a path below a file with ENOENT, which means no lock to hold there.
    it.skipIf(process.platform === "win32")(
      "ends npm with the reason when it cannot hold the lock",
      () => {
        // Audit of PR #4464: a lock npm could not hold read as a network failure.
        const { root } = installFixture();
        const notAFolder = installLockPath(root);
        writeFileSync(notAFolder, "");
        const child = spawnSync(
          process.execPath,
          [...holdArgs(notAFolder), "-e", "process.stdout.write('installed')"],
          { encoding: "utf8" },
        );

        expect(child.status).toBe(1);
        expect(child.stdout).toMatch(/could not hold its installation lock \(ENOTDIR\)/u);
        expect(child.stdout).not.toMatch(/installed/u);
      },
    );

    it("records no Stop in the lock of a start that no longer runs", () => {
      quiet();
      const { root, env } = installFixture();
      staleLock(root, endedPid());
      installKeiko(root);
      const stopRun = vi.fn(() => ({ status: 0 }));

      expect(requestStop(root)).toBe(false);
      expect(stop(root, env, stopRun)).toBe(0);
      expect(stopRun).toHaveBeenCalledOnce();
    });

    it("does not stop the Keiko another start opened while its Stop waited for the lock", () => {
      // Audit of PR #4464 (finding 1): a Stop turned away by a closing start A slept while A let
      // go and start B opened Keiko, then took the free lock and stopped B's Keiko. B came after.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      installKeiko(root, `${lockfileDigest(root)}\n`);
      const closing = acquireInstallLock(root);
      closeInstallLock(closing);
      const base = lockClock.sleep.getMockImplementation();
      const cli = lifecycleCli();
      let started;
      vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
        if (started === undefined && clock.now >= 30_000) {
          removeInstallLock(closing);
          started = start(root, nodeDir, env, cli.run);
        }
        base(milliseconds, dir);
      });

      expect(stop(root, env, cli.run)).toBe(0);
      expect(started).toBe(0);
      // The Stop reaches the command line, whose fence leaves B's Keiko open.
      expect(cli.commands).toEqual(["start", "stop"]);
      expect(cli.running).toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^Keiko was started again while Stop/u),
      );
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("does not stop the Keiko of a start that finished while the Stop was still asking the lock", () => {
      // Independent audit of PR #4464: the Stop read the start record only after the lock had
      // turned it away, so a start B that opened Keiko during that very question became the
      // generation the Stop "saw", and the Stop then stopped B's Keiko although B came after it.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      installKeiko(root, `${lockfileDigest(root)}\n`);
      const closing = acquireInstallLock(root);
      closeInstallLock(closing);
      const base = lockClock.sleep.getMockImplementation();
      const cli = lifecycleCli();
      let pressed = false;
      let started;
      vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
        if (!pressed) {
          // The first wait is the Stop's own question to the lock: A lets go and B opens Keiko.
          pressed = true;
          removeInstallLock(closing);
          started = start(root, nodeDir, env, cli.run);
        }
        base(milliseconds, dir);
      });

      expect(stop(root, env, cli.run)).toBe(0);
      expect(started).toBe(0);
      expect(cli.commands).toEqual(["start", "stop"]);
      expect(cli.running).toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^Keiko was started again while Stop/u),
      );
    });

    // The owner findings on PR #4464 that order a Stop against the starts around it: by the time a
    // start began to take its lock and the time the Stop was pressed, decided by Keiko's command
    // line under its lifecycle guard, and by the lock (or a handoff a start must honour) it acts
    // under.
    describe("ordering of a Stop against the starts around it", () => {
      function stopFixture() {
        const fixture = installFixture();
        installKeiko(fixture.root, `${lockfileDigest(fixture.root)}\n`);
        const cli = lifecycleCli();
        return { ...fixture, cli, commands: cli.commands, run: cli.run };
      }

      // The stop handoffs a Stop left in system/.
      function handoffsOf(root) {
        return readdirSync(join(root, "system")).filter((name) =>
          name.startsWith("keiko-npm-stop-handoff-"),
        );
      }

      // The lock of an ended start that only npm of its window still holds, renewing.
      function npmOnlyLock(root) {
        staleLock(root, endedPid());
        writeFileSync(join(installLockPath(root), `npm-${String(process.pid)}-0c`), "1\n");
      }

      it("stops Keiko when the start that held the lock at the press opens it and lets go meanwhile", () => {
        // Owner finding L1 on PR #4464: the start that held the lock when Stop was pressed finished
        // during the Stop's observation and recorded its token, so the Stop took that earlier
        // start for a later one and did not stop Keiko.
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { root, env, cli } = stopFixture();
        const holder = acquireInstallLock(root);
        const base = lockClock.sleep.getMockImplementation();
        let finished = false;
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
          if (!finished) {
            finished = true;
            cli.open(root, env, holder);
            closeInstallLock(holder);
            removeInstallLock(holder);
          }
          base(milliseconds, dir);
        });

        expect(stop(root, env, cli.run)).toBe(0);
        expect(cli.commands).toEqual(["start", "stop"]);
        expect(cli.running).toBe(false);
        expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^Keiko was started again/u));
      });

      it("leaves Keiko open when a start that began after the press takes the lock before the Stop", () => {
        // Owner recheck on PR #4464 (thread GMvW), the reverse of the case above: nobody held the
        // lock when Stop was pressed, and a start that began later took the free lock, opened Keiko
        // and let go before the Stop took it. The Stop took that start for one it had seen and
        // stopped its Keiko.
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { root, nodeDir, env, cli } = stopFixture();
        let later;
        const pause = (step) => {
          // The Stop is about to publish its own lock: a start that began after the press wins.
          if (step !== "publish" || later !== undefined) return;
          later = start(root, nodeDir, env, cli.run);
        };

        expect(stop(root, env, cli.run, pause)).toBe(0);
        expect(later).toBe(0);
        expect(cli.commands).toEqual(["start", "stop"]);
        expect(cli.running).toBe(true);
        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(/^Keiko was started again while Stop/u),
        );
      });

      it("keeps a waiting Stop when a later start never launched Keiko", () => {
        // Owner finding L2 on PR #4464: the start record was durable before the CLI was spawned,
        // so a later start whose spawn failed still looked like Keiko had been started again.
        quiet();
        const { root, nodeDir, env, commands, run } = stopFixture();
        const closing = acquireInstallLock(root);
        closeInstallLock(closing);
        const base = lockClock.sleep.getMockImplementation();
        const refused = vi.fn(() => ({
          error: Object.assign(new Error("spawn"), { code: "EAGAIN" }),
        }));
        let later;
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
          if (later === undefined && clock.now >= 30_000) {
            removeInstallLock(closing);
            later = start(root, nodeDir, env, refused);
          }
          base(milliseconds, dir);
        });

        expect(stop(root, env, run)).toBe(0);
        expect(later).toBe(1);
        expect(commands).toEqual(["stop"]);
        expect(run.mock.calls[0][1]).toContain("--unless-launched-after");
      });

      it("lets a start that comes while a Stop acts on the npm-only lock wait for that Stop", () => {
        // Owner finding L3 on PR #4464: the npm-only observation was obsolete by the time the stop
        // took effect: npm ended, a later start opened Keiko, and the earlier stop then ended it.
        quiet();
        const { root, nodeDir, env } = stopFixture();
        const dir = installLockPath(root);
        staleLock(root, endedPid());
        writeFileSync(join(dir, `npm-${String(process.pid)}-0c`), "1\n");
        const order = [];
        let nested;
        const run = vi.fn((_node, args) => {
          if (args[1] !== "stop") {
            order.push(args[1]);
            return { status: 0 };
          }
          order.push("stop-begins");
          // npm ends and a start takes the free lock while the stop command still runs.
          rmSync(dir, { recursive: true, force: true });
          nested = start(root, nodeDir, env, run);
          order.push("stop-ends");
          return { status: 0 };
        });

        expect(stop(root, env, run)).toBe(0);
        expect(order).toEqual(["stop-begins", "stop-ends"]);
        expect(nested).toBe(1);
        // The handoff went with the Stop: the start pressed again afterwards opens Keiko.
        expect(start(root, nodeDir, env, run)).toBe(0);
        expect(order).toEqual(["stop-begins", "stop-ends", "start"]);
        expect(handoffsOf(root)).toEqual([]);
      });

      it("carries out a Stop whose request the closing start saw only provisionally under the lock", () => {
        // Owner finding L4 on PR #4464: the requester withdrew its provisional entry once it saw
        // the closing marker, and the start then dispatched the stop after it had let go of the
        // lock, so a new start could open Keiko in between.
        quiet();
        const { root, nodeDir, env } = installFixture();
        const npm = fakeNpm(root, true, () => requestStop(root));
        const withdraw = (step) => {
          if (step !== "closed") return;
          for (const name of readdirSync(installLockPath(root))) {
            if (name.startsWith("stop-")) rmSync(join(installLockPath(root), name));
          }
        };
        const during = [];
        const commands = [];
        const run = vi.fn((node, args, options) => {
          if (args.includes("ci")) return npm.run(node, args, options);
          commands.push(args[1]);
          if (args[1] === "stop") during.push(existsSync(installLockPath(root)));
          return { status: 0 };
        });

        expect(start(root, nodeDir, env, run, withdraw)).toBe(0);
        expect(commands).toEqual(["stop"]);
        expect(during).toEqual([true]);
        expect(existsSync(installLockPath(root))).toBe(false);
      });

      it("withdraws its handoff and acts under the lock when a start takes the lock meanwhile", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { root, env, cli } = stopFixture();
        npmOnlyLock(root);
        let later;
        const pause = (step) => {
          if (step !== "handoff") return;
          // npm ends and a start takes the free lock right after the handoff was written.
          expect(handoffsOf(root)).toHaveLength(1);
          rmSync(installLockPath(root), { recursive: true, force: true });
          later = acquireInstallLock(root);
        };
        const base = lockClock.sleep.getMockImplementation();
        let closed;
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
          // That start began after the press, so the Stop asks its lock in vain until it lets go.
          if (later !== undefined && closed === undefined && clock.now >= 45_000) {
            cli.open(root, env, later);
            closed = closeInstallLock(later);
            removeInstallLock(later);
          }
          base(milliseconds, dir);
        });

        expect(stop(root, env, cli.run, pause)).toBe(0);
        expect(handoffsOf(root)).toEqual([]);
        expect(closed).toEqual({ owned: true, stopRequested: false });
        expect(cli.commands).toEqual(["start", "stop"]);
        expect(cli.running).toBe(true);
        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(/^Keiko was started again while Stop/u),
        );
      });

      it("does not stop the Keiko a start opened after the press while the handoff was written", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { root, env, cli } = stopFixture();
        npmOnlyLock(root);
        const pause = (step) => {
          if (step !== "handoff") return;
          rmSync(installLockPath(root), { recursive: true, force: true });
          const later = acquireInstallLock(root);
          cli.open(root, env, later);
          removeInstallLock(later);
        };

        expect(stop(root, env, cli.run, pause)).toBe(0);
        expect(cli.commands).toEqual(["start", "stop"]);
        expect(cli.running).toBe(true);
        expect(handoffsOf(root)).toEqual([]);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Keiko was started again/u));
      });

      it("removes the handoff of a Stop that ended and opens Keiko", () => {
        quiet();
        const { root, nodeDir, env, commands, run } = stopFixture();
        writeFileSync(join(root, "system", `keiko-npm-stop-handoff-${String(endedPid())}-0a`), "");

        expect(start(root, nodeDir, env, run)).toBe(0);
        expect(commands).toEqual(["start"]);
        expect(handoffsOf(root)).toEqual([]);
      });

      it("waits for the handoff of a Stop that acts and opens Keiko as soon as it has ended", () => {
        // Owner finding on PR #4464 (thread OqMx): a handoff that went away normally was still
        // watched to the end of its own 60-second observation, because the folder it lies in stayed.
        quiet();
        const { root, nodeDir, env, commands, run } = stopFixture();
        const handoff = join(root, "system", `keiko-npm-stop-handoff-${String(process.pid)}-0a`);
        writeFileSync(handoff, "");
        const base = lockClock.sleep.getMockImplementation();
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
          // The Stop ends between two of its renewals.
          if (clock.now >= 20_000) rmSync(handoff, { force: true });
          base(milliseconds, dir);
        });

        expect(start(root, nodeDir, env, run)).toBe(0);
        expect(commands).toEqual(["start"]);
        expect(clock.now).toBeGreaterThanOrEqual(20_000);
        expect(clock.now).toBeLessThan(21_000);
      });

      it("does not open Keiko when a Stop pressed after the start began still acts under its handoff", () => {
        // Independent audit on PR #4464: a Stop pressed between a start's reading of its time and
        // the rename of its lock saw no start, acted under a handoff, and the start opened Keiko
        // once that handoff was gone, although the Stop was pressed after the start began.
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { root, nodeDir, env, commands, run } = stopFixture();
        let handoff;
        let pressedAt;
        const pause = (step) => {
          if (step !== "publish" || handoff !== undefined) return;
          pressedAt = wall.now + 1;
          const time = pressedAt.toString(16).padStart(12, "0");
          const name = `keiko-npm-stop-handoff-${String(process.pid)}-${time}${"0".repeat(16)}`;
          handoff = join(root, "system", name);
          writeFileSync(handoff, "");
        };
        const base = lockClock.sleep.getMockImplementation();
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
          if (clock.now >= 20_000) rmSync(handoff, { force: true });
          base(milliseconds, dir);
        });

        expect(start(root, nodeDir, env, run, pause)).toBe(0);
        expect(commands).toEqual(["stop"]);
        expect(flagValue(run.mock.calls[0][1], "--unless-launched-after")).toBe(String(pressedAt));
        expect(log).toHaveBeenCalledWith(
          "Keiko was stopped while it was being loaded and does not start. You can close this window.",
        );
        expect(existsSync(installLockPath(root))).toBe(false);
      });

      it("watches every handoff under the one wait and reclaims stale ones together", () => {
        // Owner finding on PR #4464 (thread OqMx): three handoffs that did not renew were each
        // watched for a minute in turn, so the start waited three minutes, beyond the 90 seconds a
        // Stop is given.
        quiet();
        const { root, nodeDir, env, commands, run } = stopFixture();
        for (const suffix of ["0a", "0b", "0c"]) {
          const name = `keiko-npm-stop-handoff-${String(process.pid)}-${suffix}`;
          writeFileSync(join(root, "system", name), "");
          clock.frozen.add(name);
        }

        expect(start(root, nodeDir, env, run)).toBe(0);
        expect(commands).toEqual(["start"]);
        expect(handoffsOf(root)).toEqual([]);
        expect(clock.now).toBeGreaterThanOrEqual(60_000);
        expect(clock.now).toBeLessThan(61_000);
      });

      it("ends a start with a retryable message when a Stop still acts after the wait", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { root, nodeDir, env, run } = stopFixture();
        writeFileSync(join(root, "system", `keiko-npm-stop-handoff-${String(process.pid)}-0a`), "");
        const base = lockClock.sleep.getMockImplementation();
        let recorded;
        let pressed = false;
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
          // A Stop pressed while this start waits is recorded in its lock.
          if (!pressed) {
            pressed = true;
            recorded = requestStop(root);
          }
          base(milliseconds, dir);
        });

        expect(start(root, nodeDir, env, run)).toBe(1);
        expect(recorded).toBe(true);
        expect(run).not.toHaveBeenCalled();
        expect(clock.now).toBeGreaterThanOrEqual(90_000);
        expect(existsSync(installLockPath(root))).toBe(false);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^A Stop of this folder is still/u));
        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(
            /^Stop was pressed while Keiko was being loaded, but this start ended/u,
          ),
        );
      });

      it("ends a start with a retryable message when a closing Stop still holds the lock", () => {
        // Owner finding L5 on PR #4464: a Stop that kept its closing lock beyond the wait was
        // renewing an owner entry, so the start took it for another start that opens Keiko, said
        // so, and exited 0 although nobody was going to open it.
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { root, nodeDir, env, run } = stopFixture();
        closeInstallLock(acquireInstallLock(root));

        expect(start(root, nodeDir, env, run)).toBe(1);
        expect(run).not.toHaveBeenCalled();
        expect(clock.now).toBeGreaterThanOrEqual(90_000);
        expect(log).not.toHaveBeenCalledWith(
          expect.stringMatching(/^Another start of this folder/u),
        );
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Keiko is still being closed/u));
        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(/^Keiko wird noch von einem anderen/u),
        );
      });

      it("keeps a waiting Stop when a later start's command line refuses before it opens anything", () => {
        // Owner finding on PR #4464 (thread GMvb): the command line was spawned but refused at
        // once (its lifecycle was busy) and ended with a failure. The launch was recorded because a
        // child existed, so the waiting Stop reported a restart and left the running Keiko alone.
        quiet();
        const { root, nodeDir, env, commands, run } = stopFixture();
        const closing = acquireInstallLock(root);
        closeInstallLock(closing);
        const base = lockClock.sleep.getMockImplementation();
        const busy = vi.fn(() => ({ status: 1 }));
        let later;
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
          if (later === undefined && clock.now >= 30_000) {
            removeInstallLock(closing);
            later = start(root, nodeDir, env, busy);
          }
          base(milliseconds, dir);
        });

        expect(stop(root, env, run)).toBe(0);
        expect(busy).toHaveBeenCalledOnce();
        expect(later).toBe(1);
        expect(commands).toEqual(["stop"]);
      });

      it("does not carry out a Stop request when the start lost its lock while it was closing it", () => {
        // Owner finding on PR #4464 (thread GMve): the lock was taken over while the old start was
        // closing it (`owned` false), and the start still dispatched the provisional request it saw
        // before. The replacement start had opened Keiko, so the old owner's Stop ended it.
        quiet();
        const { root, nodeDir, env } = installFixture();
        const npm = fakeNpm(root, true, () => requestStop(root));
        const replacement = `owner-${String(process.pid)}-0b`;
        let taken = false;
        const takeOver = (step) => {
          if (step !== "closed" || taken) return;
          taken = true;
          rmSync(installLockPath(root), { recursive: true, force: true });
          mkdirSync(installLockPath(root));
          writeFileSync(join(installLockPath(root), replacement), "");
        };
        const commands = [];
        const run = vi.fn((node, args, options) => {
          if (args.includes("ci")) return npm.run(node, args, options);
          commands.push(args[1]);
          return { status: 0 };
        });

        expect(() => start(root, nodeDir, env, run, takeOver)).toThrow(LauncherRefusal);
        expect(taken).toBe(true);
        expect(commands).toEqual([]);
        expect(lockOwners(root)).toEqual([replacement]);
      });

      it("leaves the Keiko of a start that took the lock over after the ownership check open", () => {
        // Owner recheck on PR #4464 (thread GMve): A had accepted a Stop and still owned its lock
        // when it checked. B then took the expired lock over and opened Keiko before A's stop ran,
        // and A's stop ended B's Keiko. The stop now carries the press, and B began after it.
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { root, nodeDir, env } = installFixture();
        const npm = fakeNpm(root, true, () => requestStop(root));
        let replacement;
        const cli = lifecycleCli({
          beforeStop: () => {
            if (replacement !== undefined) return;
            rmSync(installLockPath(root), { recursive: true, force: true });
            replacement = acquireInstallLock(root);
            cli.open(root, env, replacement);
            removeInstallLock(replacement);
          },
        });
        const run = vi.fn((node, args, options) =>
          args.includes("ci") ? npm.run(node, args, options) : cli.run(node, args, options),
        );

        expect(start(root, nodeDir, env, run)).toBe(0);
        expect(replacement).toBeDefined();
        expect(cli.commands).toEqual(["start", "stop"]);
        expect(cli.running).toBe(true);
        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(
            /^Stop was pressed while Keiko was being loaded, but Keiko was started again after that/u,
          ),
        );
      });

      it("opens Keiko after a Stop that closed the lock while a start observed an orphaned installation", () => {
        // Owner finding on PR #4464 (thread GMvg): the start watched for renewal of a start entry
        // while the orphaned installation ended and a Stop took and closed the lock. The Stop's new
        // owner entry satisfied the renewal, so the start reported that another start opens Keiko,
        // launched nothing and left a closing Stop as the only holder.
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { root, nodeDir, env } = installFixture();
        installKeiko(root, `${lockfileDigest(root)}\n`);
        const dir = installLockPath(root);
        // A frozen start entry whose number runs, and npm of its window still renewing.
        staleLock(root, process.pid);
        clock.frozen.add(`owner-${String(process.pid)}-0a`);
        writeFileSync(join(dir, `npm-${String(process.pid)}-0c`), "1\n");
        const base = lockClock.sleep.getMockImplementation();
        let stopLock;
        let released = false;
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, d) => {
          base(milliseconds, d);
          if (stopLock === undefined && clock.now >= 40_000) {
            // npm ends; a Stop takes the free lock and closes it.
            rmSync(dir, { recursive: true, force: true });
            stopLock = acquireInstallLock(root);
            closeInstallLock(stopLock);
          } else if (stopLock !== undefined && !released && clock.now >= 100_000) {
            removeInstallLock(stopLock);
            released = true;
          }
        });
        const run = vi.fn(() => ({ status: 0 }));

        expect(start(root, nodeDir, env, run)).toBe(0);
        expect(run).toHaveBeenCalledOnce();
        expect(run.mock.calls[0][1][1]).toBe("start");
        expect(log).not.toHaveBeenCalledWith(
          expect.stringMatching(/^Another start of this folder/u),
        );
      });

      it("reclaims the handoff of a Stop that ended and whose process number was reused", () => {
        // Owner finding on PR #4464 (thread M0FE): a Stop ended before it removed its handoff and
        // the system gave its number to another process, so the handoff looked alive for good. Each
        // start then waited the whole wait and ended without opening Keiko.
        quiet();
        const { root, nodeDir, env, commands, run } = stopFixture();
        const name = `keiko-npm-stop-handoff-${String(process.pid)}-0a`;
        writeFileSync(join(root, "system", name), "");
        // Nobody renews it: the number runs, the Stop does not.
        clock.frozen.add(name);

        expect(start(root, nodeDir, env, run)).toBe(0);
        expect(commands).toEqual(["start"]);
        expect(handoffsOf(root)).toEqual([]);
        expect(clock.now).toBeGreaterThanOrEqual(60_000);
        expect(clock.now).toBeLessThan(90_000);
      });

      it("renews its handoff for as long as the Stop acts and stops renewing when it ends", () => {
        // Owner finding on PR #4464 (thread M0FE): the handoff proves its Stop by renewal.
        quiet();
        const { root, env, run } = stopFixture();
        npmOnlyLock(root);
        const stopRenewing = vi.fn();
        const renewed = [];
        lockRenewal.start.mockImplementation((path) => {
          renewed.push(path);
          return stopRenewing;
        });

        expect(stop(root, env, run)).toBe(0);
        expect(renewed).toHaveLength(1);
        expect(renewed[0]).toMatch(/keiko-npm-stop-handoff-\d+-[0-9a-f]+$/u);
        expect(stopRenewing).toHaveBeenCalledOnce();
        expect(handoffsOf(root)).toEqual([]);
      });

      it("keeps the newer start's order when a former owner returns from its command line", () => {
        // Owner finding on PR #4464 (thread M0FQ): the launcher lost its lock while its command line
        // ran, a replacement start opened Keiko, and the old launcher's later write put its own
        // record back, so a waiting Stop ended the replacement's Keiko. The order is now written by
        // the command line under its lifecycle guard, which keeps the later one.
        quiet();
        const { root, nodeDir, env, state } = stopFixture();
        let replacement;
        let pressedBetween;
        const cli = lifecycleCli({
          beforeStart: () => {
            if (replacement !== undefined) return;
            // A Stop pressed after the former owner began and before the replacement began.
            pressedBetween = orderClock.now();
            rmSync(installLockPath(root), { recursive: true, force: true });
            replacement = acquireInstallLock(root);
            cli.open(root, env, replacement);
            removeInstallLock(replacement);
          },
        });

        expect(start(root, nodeDir, env, cli.run)).toBe(0);
        expect(cli.commands).toEqual(["start", "start"]);
        expect(checkStopFence(state, pressedBetween, undefined)).toBe("superseded");
      });

      it("does not stop the Keiko that a start of another folder opened while its Stop waited", () => {
        // Owner finding on PR #4464 (keiko-npm.mjs:1626): two extracted folders share one data
        // folder. Stop A waited for A's closing lock, start B then opened Keiko and recorded its
        // launch under B only, and the resumed Stop A read A's record alone and stopped B's Keiko.
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const a = stopFixture();
        const b = installFixture();
        installKeiko(b.root, `${lockfileDigest(b.root)}\n`);
        const closing = acquireInstallLock(a.root);
        closeInstallLock(closing);
        const base = lockClock.sleep.getMockImplementation();
        let started;
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
          if (started === undefined && clock.now >= 30_000) {
            removeInstallLock(closing);
            // Folder B shares A's data folder: both are given the same environment.
            started = start(b.root, b.nodeDir, a.env, a.run);
          }
          base(milliseconds, dir);
        });

        expect(stop(a.root, a.env, a.run)).toBe(0);
        expect(started).toBe(0);
        // B's start and A's Stop meet at the command line of the data folder both use.
        expect(a.commands).toEqual(["start", "stop"]);
        expect(a.cli.running).toBe(true);
        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(/^Keiko was started again while Stop/u),
        );
      });

      it("stops the Keiko a start of another folder opened while the Stop waited when it began first", () => {
        quiet();
        const a = stopFixture();
        const b = installFixture();
        installKeiko(b.root, `${lockfileDigest(b.root)}\n`);
        const closing = acquireInstallLock(a.root);
        closeInstallLock(closing);
        // B began to take its lock before the Stop was pressed and opens Keiko while it waits.
        const earlier = acquireInstallLock(b.root);
        const base = lockClock.sleep.getMockImplementation();
        let opened = false;
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
          if (!opened && clock.now >= 30_000) {
            opened = true;
            removeInstallLock(closing);
            a.cli.open(b.root, a.env, earlier);
            removeInstallLock(earlier);
          }
          base(milliseconds, dir);
        });

        expect(stop(a.root, a.env, a.run)).toBe(0);
        expect(opened).toBe(true);
        expect(a.commands).toEqual(["start", "stop"]);
        expect(a.cli.running).toBe(false);
      });

      it("stops Keiko when no start of another folder came while its Stop waited", () => {
        quiet();
        const a = stopFixture();
        const closing = acquireInstallLock(a.root);
        closeInstallLock(closing);
        const base = lockClock.sleep.getMockImplementation();
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
          if (clock.now >= 30_000) removeInstallLock(closing);
          base(milliseconds, dir);
        });

        expect(stop(a.root, a.env, a.run)).toBe(0);
        expect(a.commands).toEqual(["stop"]);
      });

      it("passes the time its lock was taken and the time Stop was pressed to the command line", () => {
        quiet();
        const { root, nodeDir, env, cli } = stopFixture();

        expect(start(root, nodeDir, env, cli.run)).toBe(0);
        const order = Number(flagValue(cli.run.mock.calls[0][1], "--launch-order"));
        // The Stop's first reading of the clock is its press.
        const pressed = wall.now + 1;
        expect(stop(root, env, cli.run)).toBe(0);
        const fence = Number(flagValue(cli.run.mock.calls[1][1], "--unless-launched-after"));

        expect(order).toBeLessThan(fence);
        expect(fence).toBe(pressed);
        expect(cli.commands).toEqual(["start", "stop"]);
        expect(cli.running).toBe(false);
        // The launcher reads the command line's "left open" answer as the command line defines it.
        expect(STOP_SUPERSEDED_EXIT_CODE).toBe(CLI_STOP_SUPERSEDED);
      });

      it("carries the time a start began to take its lock in the lock's own name", () => {
        const { root } = stopFixture();
        const lock = acquireInstallLock(root);
        const time = lock.orderedAt.toString(16).padStart(12, "0");

        expect(lock.token).toMatch(new RegExp(`^${String(process.pid)}-${time}[0-9a-f]{16}$`, "u"));
        expect(lockOwners(root)).toEqual([`owner-${lock.token}`]);
        removeInstallLock(lock);
      });

      it("records a Stop only in the lock of a start that began before it was pressed", () => {
        // Owner recheck on PR #4464 (thread GMvW): a Stop recorded in the lock of a start that came
        // after it would have that start stop the Keiko it opens.
        const { root } = stopFixture();
        const pressed = orderClock.now();
        const later = acquireInstallLock(root);
        expect(later.orderedAt).toBeGreaterThan(pressed);

        expect(requestStop(root, pressed)).toBe(false);
        expect(readdirSync(installLockPath(root)).filter((n) => n.startsWith("stop-"))).toEqual([]);
        const after = orderClock.now();
        expect(requestStop(root, after)).toBe(true);
        expect(closeInstallLock(later)).toEqual({
          owned: true,
          stopRequested: true,
          pressedAt: after,
        });
        removeInstallLock(later);
      });

      it("does not carry out the provisional entry of a Stop pressed before its start began", () => {
        // An entry the requester is about to withdraw, because the lock it landed in belongs to a
        // start that came after the Stop, is not that start's to carry out.
        const { root } = stopFixture();
        const pressed = orderClock.now();
        const later = acquireInstallLock(root);
        const time = pressed.toString(16).padStart(12, "0");
        writeFileSync(
          join(installLockPath(root), `stop-${String(process.pid)}-${time}${"0".repeat(16)}`),
          "",
        );

        expect(closeInstallLock(later)).toEqual({ owned: true, stopRequested: false });
        removeInstallLock(later);
      });

      it("never shows a Stop's lock as a start that is about to open Keiko", () => {
        // Audit of PR #4464 (thread GMvg): a Stop created its owner entry and its closing entry in
        // two steps, so a start that watched the lock between them took the Stop's renewing entry
        // for a start that opens Keiko, said so and exited 0 although nobody was going to open it.
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { root, nodeDir, env, commands, run } = stopFixture();
        const closing = acquireInstallLock(root);
        closeInstallLock(closing);
        const base = lockClock.sleep.getMockImplementation();
        vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
          if (clock.now >= 30_000) removeInstallLock(closing);
          base(milliseconds, dir);
        });
        let nested;
        lockRenewal.start.mockImplementation(() => {
          // The Stop's lock was just published and no later step has closed it yet.
          nested ??= start(root, nodeDir, env, run);
          return () => undefined;
        });

        expect(stop(root, env, run)).toBe(0);
        expect(nested).toBe(1);
        expect(commands).toEqual(["stop"]);
        expect(log).not.toHaveBeenCalledWith(
          expect.stringMatching(/^Another start of this folder/u),
        );
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Keiko is still being closed/u));
      });
    });

    it("stops the Keiko of the start that was closing when no other start came meanwhile", () => {
      quiet();
      const { root, nodeDir, env } = installFixture();
      installKeiko(root, `${lockfileDigest(root)}\n`);
      const commands = [];
      const run = vi.fn((_node, args) => {
        commands.push(args[1]);
        return { status: 0 };
      });
      // The start that opened Keiko records its generation before it closes its lock.
      expect(start(root, nodeDir, env, run)).toBe(0);
      const closing = acquireInstallLock(root);
      closeInstallLock(closing);
      vi.spyOn(lockClock, "sleep").mockImplementation(() => removeInstallLock(closing));

      expect(stop(root, env, run)).toBe(0);
      expect(commands).toEqual(["start", "stop"]);
    });

    it("does not stop Keiko when the lock it took was taken over before it closed it", () => {
      // Audit of PR #4464 (finding 1): the result of closing the lock was ignored.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, env } = installFixture();
      installKeiko(root);
      const closing = acquireInstallLock(root);
      closeInstallLock(closing);
      const base = lockClock.sleep.getMockImplementation();
      vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, dir) => {
        if (clock.now >= 30_000) removeInstallLock(closing);
        base(milliseconds, dir);
      });
      const replacement = `owner-${String(process.pid)}-0b`;
      lockRenewal.start.mockImplementation(() => {
        rmSync(installLockPath(root), { recursive: true });
        mkdirSync(installLockPath(root));
        writeFileSync(join(installLockPath(root), replacement), "");
        return () => undefined;
      });
      const run = vi.fn(() => ({ status: 0 }));

      expect(stop(root, env, run)).toBe(1);
      expect(run).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^Another start of this folder took/u),
      );
      expect(lockOwners(root)).toEqual([replacement]);
    });

    it("never renews the start's entry from npm, so a closed start cannot look alive behind npm", () => {
      // Audit of PR #4464 (finding 2): npm rewrote the start's entry too, so a start window that
      // was closed, whose process number was reused, looked alive for as long as npm ran and a
      // Stop was accepted that no launcher would carry out.
      quiet();
      const { root } = installFixture();
      const dir = installLockPath(root);
      const startEntry = `owner-${String(process.pid)}-0a`;
      staleLock(root, process.pid, [], "1\n");
      const hold = heldByTest(dir, startEntry);
      // Only npm renews, on every observation step; the start's own process is gone.
      clock.renewing = false;
      const base = lockClock.sleep.getMockImplementation();
      vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, d) => {
        base(milliseconds, d);
        hold.renew();
      });

      expect(requestStop(root)).toBe(false);
      expect(readFileSync(join(dir, startEntry), "utf8")).toBe("1\n");
      // npm's own entry is what keeps the lock held.
      expect(installerActive(root)).toBe(true);
    });

    it("never lets an npm entry stand empty or stale when its renewal fails", () => {
      quiet();
      const { root } = installFixture();
      const dir = installLockPath(root);
      const lock = acquireInstallLock(root);
      let failing = true;
      const hold = heldByTest(dir, `owner-${lock.token}`, {
        write: (fd, bytes, offset, length, position) => {
          if (failing) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          return writeSync(fd, bytes, offset, length, position);
        },
      });
      const before = readFileSync(hold.entry, "utf8");

      hold.renew();
      expect(readFileSync(hold.entry, "utf8")).toBe(before);
      failing = false;
      hold.renew();
      expect(readFileSync(hold.entry, "utf8")).toMatch(/^\d+\n$/u);
    });

    it("waits for the npm of a closed start window and then opens Keiko itself", () => {
      // Audit of PR #4464 (finding 3): the second start reported success for an installation whose
      // window was gone, and nobody opened Keiko.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      installKeiko(root, `${lockfileDigest(root)}\n`);
      const dir = installLockPath(root);
      staleLock(root, endedPid());
      writeFileSync(join(dir, `npm-${String(process.pid)}-0c`), "1\n");
      const base = lockClock.sleep.getMockImplementation();
      vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, d) => {
        base(milliseconds, d);
        // npm ends after two virtual minutes and takes the lock with it.
        if (clock.now >= 120_000) rmSync(dir, { recursive: true, force: true });
      });
      const run = vi.fn(() => ({ status: 0 }));

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0][1][1]).toBe("start");
      expect(log).toHaveBeenCalledWith(
        "Keiko is running. The lines above say whether it opened in your browser. You can close this window; Keiko keeps running.",
      );
      expect(existsSync(dir)).toBe(false);
    });

    it("waits for a later start that closes the lock while it waits for a closed window's npm", () => {
      // Audit of PR #4464: a start waiting for the npm of a closed window took the closing lock
      // of a later start that had just opened Keiko for a Stop that was still closing it. It
      // exited 1 and asked to start again although no Stop existed.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      installKeiko(root, `${lockfileDigest(root)}\n`);
      const dir = installLockPath(root);
      staleLock(root, endedPid());
      writeFileSync(join(dir, `npm-${String(process.pid)}-0c`), "1\n");
      const base = lockClock.sleep.getMockImplementation();
      let later;
      let released = false;
      vi.spyOn(lockClock, "sleep").mockImplementation((milliseconds, d) => {
        base(milliseconds, d);
        if (later === undefined && clock.now >= 120_000) {
          // npm ends; a later start takes the lock, opens Keiko and closes the lock.
          rmSync(dir, { recursive: true, force: true });
          later = acquireInstallLock(root);
          closeInstallLock(later);
        } else if (later !== undefined && !released && clock.now >= 150_000) {
          released = true;
          removeInstallLock(later);
        }
      });
      const run = vi.fn(() => ({ status: 0 }));

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0][1][1]).toBe("start");
      expect(clock.now).toBeGreaterThanOrEqual(150_000);
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^Keiko is still being closed/u));
    });

    it("ends with a retryable message when the npm of a closed start window never ends", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      installKeiko(root, `${lockfileDigest(root)}\n`);
      staleLock(root, endedPid());
      writeFileSync(join(installLockPath(root), `npm-${String(process.pid)}-0c`), "1\n");
      const run = vi.fn(() => ({ status: 0 }));

      expect(start(root, nodeDir, env, run)).toBe(1);
      expect(run).not.toHaveBeenCalled();
      expect(clock.now).toBeGreaterThanOrEqual(10 * 60 * 1000);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^An installation of Keiko in this folder is still running/u),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^In diesem Ordner laeuft noch eine Installation/u),
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^Keiko is running\./u));
    });
  });

  it("stops Keiko only in a folder it was loaded into", () => {
    quiet();
    const root = packageRoot();
    const env = homeEnv(root);
    const run = vi.fn(() => ({ status: 4 }));

    expect(stop(root, env, run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    installKeiko(root);
    expect(stop(root, env, run)).toBe(4);
    expect(run.mock.calls[0][1]).toEqual([
      keikoCliPath(root),
      "stop",
      "--state-dir",
      stateDir(env),
      "--unless-launched-after",
      expect.stringMatching(/^\d+$/u),
    ]);
  });

  it("starts when the folder is reached through a symbolic link", () => {
    const root = tempDir("keiko-npm-entry-");
    const real = join(root, "real");
    mkdirSync(real);
    const script = join(real, "keiko-npm.mjs");
    writeFileSync(script, "");
    symlinkSync(real, join(root, "link"), "dir");
    const moduleUrl = pathToFileURL(realpathSync(script)).href;

    expect(isEntryPoint(script, moduleUrl)).toBe(true);
    expect(isEntryPoint(join(root, "link", "keiko-npm.mjs"), moduleUrl)).toBe(true);
    expect(isEntryPoint(undefined, moduleUrl)).toBe(false);
    expect(isEntryPoint(join(root, "other.mjs"), moduleUrl)).toBe(false);
  });

  it("hands Keiko the folder's configuration only when the folder holds one", () => {
    const root = packageRoot();
    const env = homeEnv(root);
    const state = stateDir(env);

    expect(startArgs(root, env)).toEqual(["start", "--state-dir", state]);
    writeFileSync(join(root, "keiko.config.json"), "{}");
    expect(startArgs(root, env)).toEqual([
      "start",
      "--state-dir",
      state,
      "--provisioned-config",
      join(root, "keiko.config.json"),
    ]);
  });

  it("runs the command a start file names and turns a refusal into exit code 1", async () => {
    quiet();
    const root = packageRoot();
    const env = homeEnv(root);
    installKeiko(root, `${lockfileDigest(root)}\n`);
    const run = vi.fn(() => ({ status: 0 }));
    const context = { root, nodeDir: join(root, "system", "node"), env, run };

    await expect(main("start", context)).resolves.toBe(0);
    await expect(main("stop", context)).resolves.toBe(0);
    expect(run.mock.calls.map(commandOf)).toEqual(["start", "stop"]);
    await expect(main("save-config", context)).resolves.toBe(1);
    await expect(main("other", context)).resolves.toBe(2);
    const outside = { ...context, env: { ...env, KEIKO_STATE_DIR: tempDir() } };
    await expect(runCommand("start", outside)).resolves.toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^Keiko: KEIKO_STATE_DIR/u));
  });
});

describe("the administrator's access step", () => {
  const sealed = {
    modelId: "chat",
    baseUrl: "https://gw",
    apiKeySecretRef: "vault:1",
    timeoutMs: 1,
  };

  it("replaces the keys Gateway Setup sealed for its verified connection with the token", () => {
    const embed = {
      ...sealed,
      modelId: "embed",
      catalogOrigin: "discovered",
      credentialOrigin: "gateway-connection",
    };
    const config = { defaultModelId: "chat", providers: [sealed, embed] };

    expect(needsToken(config)).toBe(true);
    const result = teamConfig(config, "token");
    expect(result.defaultModelId).toBe("chat");
    expect(result.providers).toEqual([
      { modelId: "chat", baseUrl: "https://gw", timeoutMs: 1, apiKey: "token" },
      {
        modelId: "embed",
        baseUrl: "https://gw",
        timeoutMs: 1,
        catalogOrigin: "discovered",
        credentialOrigin: "gateway-connection",
        apiKey: "token",
      },
    ]);
    expect(needsToken(result)).toBe(false);
  });

  it("replaces the key of a reranker Gateway Setup wired on the gateway's connection", () => {
    const config = {
      providers: [{ modelId: "chat", baseUrl: "https://gw/", apiKey: "own" }],
      reranker: {
        modelId: "rerank",
        baseUrl: "https://gw",
        apiKeySecretRef: "vault:2",
        credentialOrigin: "gateway-connection",
      },
    };

    expect(needsToken(config)).toBe(true);
    expect(teamConfig(config, "token").reranker).toEqual({
      modelId: "rerank",
      baseUrl: "https://gw",
      credentialOrigin: "gateway-connection",
      apiKey: "token",
    });
  });

  it("refuses a reranker with its own sealed key on the gateway's endpoint and header", () => {
    // Review finding on PR #4464: address and header alone passed, so the team token replaced the
    // reranker's own key. Only Gateway Setup's mark shows that it shares the gateway's credential.
    const config = {
      providers: [sealed],
      reranker: { modelId: "own-rerank", baseUrl: "https://gw", apiKeySecretRef: "vault:2" },
    };

    expect(credentialScope(config).foreign).toEqual(["own-rerank"]);
    expect(() => teamConfig(config, "token")).toThrow(/own-rerank has its own connection/u);
  });

  it("replaces the key of a voice deployment Gateway Setup marked as sharing the gateway's credential", () => {
    const config = {
      providers: [
        sealed,
        {
          modelId: "stt",
          baseUrl: "https://gw",
          apiKeySecretRef: "vault:3",
          credentialOrigin: "gateway-connection",
        },
      ],
      capabilities: [{ id: "stt", kind: "voice", voiceProviderLocality: "gateway-managed" }],
    };

    expect(credentialScope(config).foreign).toEqual([]);
    expect(teamConfig(config, "token").providers[1]).toMatchObject({ apiKey: "token" });
  });

  it("refuses a voice deployment whose key was rotated alone, though its locality is gateway-managed", () => {
    // Review finding on PR #4464 (P1): the locality survives an independent voice-key rotation, so
    // it proved nothing and the team token replaced the voice provider's own sealed key.
    const config = {
      providers: [sealed, { modelId: "stt", baseUrl: "https://gw", apiKeySecretRef: "vault:3" }],
      capabilities: [{ id: "stt", kind: "voice", voiceProviderLocality: "gateway-managed" }],
    };

    expect(credentialScope(config).foreign).toEqual(["stt"]);
    expect(() => teamConfig(config, "token")).toThrow(/stt has its own connection/u);
  });

  it("reads a capability Gateway Setup stored on its provider, and a listed one first", () => {
    // Review finding on PR #4464 (P2): only the top-level list was read, so a gateway-managed
    // voice deployment stored on its provider was refused as another connection.
    const capability = {
      id: "stt",
      kind: "voice",
      supportsSpeechInput: true,
      voiceProviderLocality: "gateway-managed",
    };
    const voice = {
      modelId: "stt",
      baseUrl: "https://gw",
      apiKeySecretRef: "vault:3",
      credentialOrigin: "gateway-connection",
      capability,
    };
    const config = { providers: [sealed, voice] };

    expect(credentialScope(config).foreign).toEqual([]);
    expect(teamConfig(config, "token").providers[1]).toEqual({
      modelId: "stt",
      baseUrl: "https://gw",
      credentialOrigin: "gateway-connection",
      capability,
      apiKey: "token",
    });
    // A provider with its own credential stays its own connection, however its capability is stored.
    const speech = {
      modelId: "own-tts",
      baseUrl: "https://speech.example",
      apiKeySecretRef: "vault:5",
      capability: { kind: "voice", voiceProviderLocality: "gateway-managed" },
    };
    expect(credentialScope({ providers: [sealed, voice, speech] }).foreign).toEqual(["own-tts"]);
    // The stored kind decides the main connection: a voice model listed first is not it.
    expect(credentialScope({ providers: [speech, sealed] }).foreign).toEqual(["own-tts"]);
    // A listed capability wins over the provider's own, as the gateway's loader merges them, and
    // a marked voice provider the loader reaches outside the gateway is still its own connection.
    const listed = {
      ...config,
      capabilities: [{ id: "stt", kind: "voice", voiceProviderLocality: "azure-foundry" }],
    };
    expect(credentialScope(listed).foreign).toEqual(["stt"]);
  });

  it("reads the main connection from the first chat model, wherever it is listed", () => {
    const embedding = {
      modelId: "embed",
      baseUrl: "https://embeddings.example",
      apiKeySecretRef: "vault:4",
    };
    const config = {
      providers: [embedding, sealed],
      capabilities: [{ id: "embed", kind: "embedding" }],
    };

    expect(credentialScope(config).foreign).toEqual(["embed"]);
  });

  it.each([
    [
      "a reranker on another endpoint",
      {
        providers: [sealed],
        reranker: { modelId: "rerank-1", baseUrl: "https://rerank.example", apiKeySecretRef: "r" },
      },
      ["rerank-1"],
    ],
    [
      "a same-endpoint embedding with its own credential",
      {
        providers: [
          sealed,
          { modelId: "own-key-embedding", baseUrl: "https://gw", apiKeySecretRef: "e" },
        ],
        capabilities: [{ id: "own-key-embedding", kind: "embedding" }],
      },
      ["own-key-embedding"],
    ],
    [
      // Review finding on PR #4464: catalog provenance says who listed a model, never whose key it
      // holds, so neither value makes a same-endpoint model with its own credential the gateway's.
      "a same-endpoint embedding whose catalog origin is discovered but whose key is its own",
      {
        providers: [
          sealed,
          {
            modelId: "own-key-embedding",
            baseUrl: "https://gw",
            catalogOrigin: "discovered",
            apiKeySecretRef: "e",
          },
        ],
        capabilities: [{ id: "own-key-embedding", kind: "embedding" }],
      },
      ["own-key-embedding"],
    ],
    [
      "a same-endpoint embedding whose catalog origin is explicit but whose key is its own",
      {
        providers: [
          sealed,
          {
            modelId: "own-key-embedding",
            baseUrl: "https://gw",
            catalogOrigin: "explicit",
            apiKeySecretRef: "e",
          },
        ],
        capabilities: [{ id: "own-key-embedding", kind: "embedding" }],
      },
      ["own-key-embedding"],
    ],
    [
      "a model behind another header",
      {
        providers: [
          sealed,
          {
            modelId: "other-header",
            baseUrl: "https://gw",
            apiKeyHeaderName: "api-key",
            catalogOrigin: "explicit",
            apiKeySecretRef: "h",
          },
        ],
      },
      ["other-header"],
    ],
    [
      "a model speaking another protocol",
      {
        providers: [
          sealed,
          {
            modelId: "other-protocol",
            baseUrl: "https://gw",
            endpointStyle: "responses",
            catalogOrigin: "explicit",
            apiKeySecretRef: "p",
          },
        ],
      },
      ["other-protocol"],
    ],
  ])("never gives the token to %s", (_case, config, foreign) => {
    // Review finding on PR #4464 (P1): every sealed key became the token, so the gateway token
    // reached services and connections it was never verified for.
    expect(credentialScope(config).foreign).toEqual(foreign);
    expect(() => teamConfig(config, "token")).toThrow(LauncherRefusal);
    expect(() => teamConfig(config, "token")).toThrow(/more than one credential/u);
  });

  it("keeps a model that carries no sealed key as it is", () => {
    const open = { modelId: "chat", baseUrl: "https://gw", apiKey: "own" };

    expect(needsToken({ providers: [open] })).toBe(false);
    expect(teamConfig({ providers: [open] }, "token").providers[0]).toBe(open);
  });

  it("reads a pasted token and keeps keys that are not text out of it", () => {
    expect(tokenInput("", "sk-abc\r\n")).toMatchObject({ value: "sk-abc", end: "enter" });
    expect(tokenInput("sk", "-ab\u007fc")).toMatchObject({ value: "sk-ac", end: undefined });
    // An arrow key, the Delete key and Ctrl+D send no token characters.
    expect(tokenInput("", "a\u001b[Db\u001b[3~c\u0004")).toEqual({
      value: "abc",
      end: undefined,
      escape: "none",
    });
    expect(tokenInput("😀", "\b")).toMatchObject({ value: "", end: undefined });
    expect(tokenInput("secret", "\u0003")).toMatchObject({ value: "", end: "cancel" });
  });

  // A terminal may hand one key over in two reads; its tail must not reach the saved token.
  it.each([
    ["an arrow key", "\u001b[D"],
    ["the Delete key", "\u001b[3~"],
    ["an arrow key in application mode", "\u001bOD"],
  ])("keeps %s out of the token at every split", (_name, key) => {
    const typed = `a${key}b`;
    const expected = { value: "ab", end: undefined, escape: "none" };
    expect(tokenInput("", typed)).toEqual(expected);
    for (let cut = 1; cut < typed.length; cut += 1) {
      const first = tokenInput("", typed.slice(0, cut));
      expect(tokenInput(first.value, typed.slice(cut), first.escape)).toEqual(expected);
    }
    const byCharacter = [...typed].reduce(
      (step, character) => tokenInput(step.value, character, step.escape),
      { value: "", escape: "none" },
    );
    expect(byCharacter).toEqual(expected);
  });

  it("types what follows the Escape key pressed on its own", () => {
    const escaped = tokenInput("a", "\u001b");
    expect(escaped).toEqual({ value: "a", end: undefined, escape: "escape" });
    expect(tokenInput(escaped.value, "b", escaped.escape)).toEqual({
      value: "ab",
      end: undefined,
      escape: "none",
    });
    expect(tokenInput(escaped.value, "\r", escaped.escape)).toMatchObject({
      value: "a",
      end: "enter",
    });
  });

  // A read can end inside a key sequence; the next Enter or Ctrl+C must still end the input, or
  // the prompt would wait in raw mode for a key that never comes.
  it.each([
    ["an unfinished key", "\u001b["],
    ["an unfinished key with parameters", "\u001b[3"],
    ["an unfinished key in application mode", "\u001bO"],
  ])("ends the input with Enter or Ctrl+C after %s", (_name, unfinished) => {
    const first = tokenInput("sk", unfinished);
    expect(first).toMatchObject({ value: "sk", end: undefined });
    expect(first.escape).not.toBe("none");
    expect(tokenInput(first.value, "\r", first.escape)).toEqual({
      value: "sk",
      end: "enter",
      escape: "none",
    });
    expect(tokenInput(first.value, "\n", first.escape)).toMatchObject({ end: "enter" });
    expect(tokenInput(first.value, "\u0003", first.escape)).toEqual({
      value: "",
      end: "cancel",
      escape: "none",
    });
  });

  // What readHidden needs of process.stdin and process.stdout. `events` records the order of raw
  // mode changes and writes; `failPrompt` makes the first write throw.
  function fakeTerminal(isTTY = true, { failPrompt = false } = {}) {
    const events = [];
    const stdin = Object.assign(new EventEmitter(), {
      isTTY,
      rawModes: [],
      encoding: undefined,
      flowing: false,
      setRawMode(mode) {
        this.rawModes.push(mode);
        events.push(`raw:${String(mode)}`);
      },
      setEncoding(encoding) {
        this.encoding = encoding;
      },
      resume() {
        this.flowing = true;
      },
      pause() {
        this.flowing = false;
      },
    });
    const written = [];
    const write = (text) => {
      if (failPrompt && written.length === 0) {
        written.push(null);
        throw Object.assign(new Error("terminal gone"), { code: "EPIPE" });
      }
      written.push(text);
      events.push(`write:${text}`);
    };
    return { io: { stdin, stdout: { write } }, stdin, written, events };
  }

  it("turns terminal echo off before the prompt is shown", async () => {
    // Owner review on PR #4464: the prompt was written before raw mode, so a token typed or pasted
    // the moment it appeared was echoed into the transcript.
    const terminal = fakeTerminal();
    const token = readHidden("Token: ", terminal.io);
    expect(terminal.events.slice(0, 2)).toEqual(["raw:true", "write:Token: "]);
    expect(terminal.stdin.listenerCount("data")).toBe(1);
    terminal.stdin.emit("data", "sk-a\r");

    await expect(token).resolves.toBe("sk-a");
  });

  it("restores the terminal when the prompt cannot be shown", async () => {
    const terminal = fakeTerminal(true, { failPrompt: true });

    await expect(readHidden("Token: ", terminal.io)).rejects.toThrow(/terminal gone/u);
    expect(terminal.stdin.rawModes).toEqual([true, false]);
    expect(terminal.stdin.flowing).toBe(false);
    for (const name of ["data", "end", "close"]) {
      expect(terminal.stdin.listenerCount(name)).toBe(0);
    }
  });

  it("reads a token without showing it and leaves raw mode", async () => {
    const terminal = fakeTerminal();
    const token = readHidden("Token: ", terminal.io);
    expect(terminal.stdin).toMatchObject({ encoding: "utf8", flowing: true });
    terminal.stdin.emit("data", "sk-a");
    terminal.stdin.emit("data", "bc \r");

    await expect(token).resolves.toBe("sk-abc");
    expect(terminal.stdin.flowing).toBe(false);
    expect(terminal.stdin.rawModes).toEqual([true, false]);
    expect(terminal.written).toEqual(["Token: ", "\n"]);
    expect(terminal.stdin.listenerCount("data")).toBe(0);
  });

  it.each([
    ["an unfinished key", "\u001b["],
    ["an unfinished key in application mode", "\u001bO"],
  ])("ends a terminal read with Enter or Ctrl+C after %s", async (_name, unfinished) => {
    const entered = fakeTerminal();
    const token = readHidden("Token: ", entered.io);
    entered.stdin.emit("data", `sk${unfinished}`);
    entered.stdin.emit("data", "\r");
    await expect(token).resolves.toBe("sk");
    expect(entered.stdin.rawModes).toEqual([true, false]);

    const cancelled = fakeTerminal();
    const refused = readHidden("Token: ", cancelled.io);
    cancelled.stdin.emit("data", `sk${unfinished}`);
    cancelled.stdin.emit("data", "\u0003");
    await expect(refused).rejects.toThrow(/cancelled/u);
    expect(cancelled.stdin.rawModes).toEqual([true, false]);
  });

  it.each(["end", "close"])(
    "ends a terminal read when the terminal input emits %s before Enter",
    async (event) => {
      // CodeRabbit on PR #4464: a terminal that closed before Enter left the read pending, so the
      // access step hung without saving or saying anything.
      const terminal = fakeTerminal();
      const token = readHidden("Token: ", terminal.io);
      terminal.stdin.emit("data", "sk-a");
      terminal.stdin.emit(event);

      await expect(token).rejects.toThrow(/terminal closed/u);
      expect(terminal.stdin.rawModes).toEqual([true, false]);
      expect(terminal.stdin.flowing).toBe(false);
      for (const name of ["data", "end", "close"]) {
        expect(terminal.stdin.listenerCount(name)).toBe(0);
      }
    },
  );

  it("reads no token without a terminal", async () => {
    const terminal = fakeTerminal(false);

    await expect(readHidden("Token: ", terminal.io)).rejects.toThrow(/no terminal/u);
    expect(terminal.stdin.rawModes).toEqual([]);
  });

  describe("saving the team's configuration", () => {
    function savedConfig(config, extraEnv = {}) {
      const root = packageRoot();
      const env = homeEnv(root, extraEnv);
      if (config !== undefined) {
        const ui = join(stateDir(homeEnv(root)), "ui");
        mkdirSync(ui, { recursive: true });
        writeFileSync(join(ui, "keiko.config.json"), JSON.stringify(config));
      }
      return { root, env, target: join(root, "keiko.config.json") };
    }

    it("asks for Gateway Setup first when nothing was set up", async () => {
      quiet();
      const { root, env, target } = savedConfig();
      const readToken = vi.fn();

      await expect(saveConfig(root, env, { readToken })).resolves.toBe(1);
      expect(readToken).not.toHaveBeenCalled();
      expect(existsSync(target)).toBe(false);
    });

    it("writes the token in place of the sealed key, readable only by its owner", async () => {
      quiet();
      const { root, env, target } = savedConfig({ providers: [sealed] });

      await expect(saveConfig(root, env, { readToken: async () => "team-token" })).resolves.toBe(0);
      const written = JSON.parse(readFileSync(target, "utf8"));
      expect(written.providers[0]).toMatchObject({ modelId: "chat", apiKey: "team-token" });
      expect(written.providers[0].apiKeySecretRef).toBeUndefined();
      if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
    });

    it("saves the team's configuration through the shipped command from a terminal", async () => {
      // Coverage thread on PR #4464: a successful `main("save-config")` that reads the token from
      // the terminal and produces the expected file was the one launcher path no test drove.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const config = { defaultModelId: "chat", providers: [sealed] };
      const { root, env, target } = savedConfig(config);
      const terminal = fakeTerminal();
      const readToken = (prompt) => {
        const typed = readHidden(prompt, terminal.io);
        // The administrator types the token, hidden, and presses Enter.
        terminal.stdin.emit("data", "team-");
        terminal.stdin.emit("data", "token\r");
        return typed;
      };

      await expect(main("save-config", { root, env, io: { readToken } })).resolves.toBe(0);
      expect(readFileSync(target, "utf8")).toBe(
        `${JSON.stringify(teamConfig(config, "team-token"), null, 2)}\n`,
      );
      expect(JSON.parse(readFileSync(target, "utf8")).providers[0]).toMatchObject({
        modelId: "chat",
        apiKey: "team-token",
      });
      // The token was typed hidden and the terminal left raw mode.
      expect(terminal.written).toEqual([expect.stringMatching(/^API token/u), "\n"]);
      expect(terminal.stdin.rawModes).toEqual([true, false]);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Saved: keiko\.config\.json\./u));
      if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
    });

    it("replaces an existing, wider readable file with an owner-private one", async () => {
      // Review finding on PR #4464 (P2): writeFileSync kept an existing file's 0644 mode while
      // it wrote the token, and an interrupted write truncated the previous configuration.
      quiet();
      const { root, env, target } = savedConfig({ providers: [sealed] });
      writeFileSync(target, "old\n", { mode: 0o644 });
      chmodSync(target, 0o644);

      await expect(saveConfig(root, env, { readToken: async () => "team-token" })).resolves.toBe(0);
      expect(readFileSync(target, "utf8")).toContain("team-token");
      if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("keeps the previous file as it was when writing the new one fails", async () => {
      quiet();
      const { root, env, target } = savedConfig({ providers: [sealed] });
      writeFileSync(target, "previous\n");
      const writeNew = (path) => {
        writeFileSync(path, "partial");
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      };

      await expect(
        saveConfig(root, env, { readToken: async () => "team-token", writeNew }),
      ).rejects.toThrow(/no space left/u);
      expect(readFileSync(target, "utf8")).toBe("previous\n");
      expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("keeps the previous file as it was when the system writes only part of the new one", async () => {
      // Review finding on PR #4464 (P2): writeSync returned a short count without an error (a
      // file-size limit), and the truncated configuration replaced the previous one.
      quiet();
      const { root, env, target } = savedConfig({ providers: [sealed] });
      writeFileSync(target, "previous\n");
      let calls = 0;
      const short = (fd, bytes, offset, length) => {
        calls += 1;
        return calls === 1 ? writeSync(fd, bytes, offset, Math.min(length, 5)) : 0;
      };
      const writeNew = (path, text) => writeNewPrivateFile(path, text, short);

      await expect(
        saveConfig(root, env, { readToken: async () => "team-token", writeNew }),
      ).rejects.toThrow(/could not be written completely/u);
      expect(readFileSync(target, "utf8")).toBe("previous\n");
      expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it.each(["KEIKO_CONFIG_FILE", "KEIKO_UI_DATA_DIR"])(
      "refuses to export while %s points Keiko at another configuration",
      async (name) => {
        // Review finding on PR #4464 (P2): with an override Gateway Setup saved elsewhere, and the
        // step exported a stale default configuration.
        quiet();
        const stale = { providers: [{ modelId: "old", baseUrl: "https://old.example" }] };
        const { root, env, target } = savedConfig(stale, { [name]: join(tempDir(), "x") });
        const readToken = vi.fn();

        await expect(saveConfig(root, env, { readToken })).resolves.toBe(1);
        expect(readToken).not.toHaveBeenCalled();
        expect(existsSync(target)).toBe(false);
      },
    );

    it("refuses another connection's key before it asks for the token", async () => {
      const { root, env, target } = savedConfig({
        providers: [sealed],
        reranker: { modelId: "rerank-1", baseUrl: "https://rerank.example", apiKeySecretRef: "r" },
      });
      const readToken = vi.fn();

      await expect(saveConfig(root, env, { readToken })).rejects.toThrow(LauncherRefusal);
      expect(readToken).not.toHaveBeenCalled();
      expect(existsSync(target)).toBe(false);
    });

    it("asks for no token when no key was sealed", async () => {
      quiet();
      const open = { modelId: "chat", baseUrl: "https://gw" };
      const { root, env, target } = savedConfig({ providers: [open] });
      const readToken = vi.fn();

      await expect(saveConfig(root, env, { readToken })).resolves.toBe(0);
      expect(readToken).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(target, "utf8")).providers).toEqual([open]);
    });

    it.each([
      ["an empty address", { modelId: "chat", baseUrl: "", apiKeySecretRef: "cred:chat" }],
      ["a blank address", { modelId: "chat", baseUrl: "  ", apiKeySecretRef: "cred:chat" }],
      ["an empty model id", { modelId: "", baseUrl: "https://gw", apiKeySecretRef: "cred:" }],
    ])("refuses a model with %s before it asks for the token", async (_case, provider) => {
      // Review finding on PR #4464 (P3): an empty baseUrl passed, and the team got a file that
      // named no gateway.
      const { root, env, target } = savedConfig({ providers: [provider] });
      const readToken = vi.fn();

      await expect(saveConfig(root, env, { readToken })).rejects.toThrow(/modelId or baseUrl/u);
      expect(readToken).not.toHaveBeenCalled();
      expect(existsSync(target)).toBe(false);
    });

    it.each([
      ["KEIKO_DEFAULT_API_KEY", { providers: [{ modelId: "chat", baseUrl: "https://gw" }] }],
      ["KEIKO_MODEL_CHAT_1_API_KEY", { providers: [{ modelId: "chat-1", baseUrl: "https://gw" }] }],
      [
        "KEIKO_RERANKER_API_KEY",
        {
          providers: [{ modelId: "chat", baseUrl: "https://gw", apiKeySecretRef: "cred:chat" }],
          reranker: { modelId: "rerank", baseUrl: "https://gw" },
        },
      ],
    ])("refuses to export a key only %s of this computer holds", async (variable, config) => {
      // Review finding on PR #4464 (P2): Gateway Setup keeps a key from the environment out of
      // the file, and the export wrote a team file without any key.
      const { root, env, target } = savedConfig(config, { [variable]: "admin-only-key" });
      const readToken = vi.fn();

      await expect(saveConfig(root, env, { readToken })).rejects.toThrow(new RegExp(variable, "u"));
      expect(readToken).not.toHaveBeenCalled();
      expect(existsSync(target)).toBe(false);
    });

    // The key variable the gateway's own loader reads for a model, recorded as it reads it.
    function loaderKeyVariable(modelId) {
      const read = [];
      const env = new Proxy(
        {},
        {
          get: (_target, name) => {
            if (typeof name === "string") read.push(name);
            return undefined;
          },
        },
      );
      try {
        parseGatewayConfig({ providers: [{ modelId, baseUrl: "https://gw.example" }] }, env);
      } catch (error) {
        // A model without a key is refused after its variables were read.
        expect(error).toBeInstanceOf(Error);
      }
      return read.find((name) => /^KEIKO_MODEL_.*_API_KEY$/u.test(name));
    }

    it.each(["chat-1", "café", "m😀"])(
      "names the key variable of %s as the gateway reads it, a blank value included",
      (modelId) => {
        // Audit of PR #4464: the loader takes any value that is not empty and turns each UTF-16
        // code unit into `_`; the export skipped blank values and turned an emoji into one `_`.
        const variable = loaderKeyVariable(modelId);
        const config = { providers: [{ modelId, baseUrl: "https://gw" }] };

        expect(variable).toBeDefined();
        expect(environmentKeys(config, { [variable]: " " })).toEqual([{ name: modelId, variable }]);
        expect(environmentKeys(config, { KEIKO_DEFAULT_API_KEY: " " })).toEqual([
          { name: modelId, variable: "KEIKO_DEFAULT_API_KEY" },
        ]);
        expect(environmentKeys(config, { [variable]: "", KEIKO_DEFAULT_API_KEY: "" })).toEqual([]);
      },
    );

    it("keeps exporting keys the file holds while an environment variable is set", () => {
      const env = { KEIKO_DEFAULT_API_KEY: "x", KEIKO_MODEL_CHAT_API_KEY: "y" };
      const config = {
        providers: [
          { modelId: "chat", baseUrl: "https://gw", apiKeySecretRef: "cred:chat" },
          { modelId: "plain", baseUrl: "https://gw", apiKey: "file-key" },
          { modelId: "alias", baseUrl: "https://gw", apiKeySourceModelId: "chat" },
        ],
      };

      // A sealed key is replaced by the token, a key in the file stays, an alias follows its source.
      expect(environmentKeys(config, env)).toEqual([]);
      expect(
        environmentKeys({ providers: [{ modelId: "open", baseUrl: "https://gw" }] }, {}),
      ).toEqual([]);
    });

    it("refuses to save without the token a sealed key needs", async () => {
      const { root, env, target } = savedConfig({ providers: [sealed] });

      await expect(saveConfig(root, env, { readToken: async () => "" })).rejects.toThrow(
        /no token entered/u,
      );
      expect(existsSync(target)).toBe(false);
    });
  });

  it("finishes a write the system takes in parts", () => {
    const path = join(tempDir(), "file.json");
    const parts = [];
    writeNewPrivateFile(path, "Grüße, Keiko\n", (fd, bytes, offset, length) => {
      parts.push(length);
      return writeSync(fd, bytes, offset, Math.min(length, 3));
    });

    expect(readFileSync(path, "utf8")).toBe("Grüße, Keiko\n");
    expect(parts.length).toBeGreaterThan(1);
  });

  it("publishes a file in one step and leaves nothing behind", () => {
    const root = tempDir();
    const target = join(root, "file.json");

    publishPrivateFile(target, "one\n");
    publishPrivateFile(target, "two\n");
    expect(readFileSync(target, "utf8")).toBe("two\n");
    expect(readdirSync(root)).toEqual(["file.json"]);
  });

  it("limits the access file to the account before it writes a byte of the token", () => {
    // Review finding on PR #4464: on Windows the 0600 mode is not applied, and the file took the
    // permissions its folder hands down before the token was in it.
    const root = tempDir();
    const target = join(root, "file.json");
    const sizes = [];
    vi.spyOn(privateFileAccess, "restrict").mockImplementation((path) => {
      if (statSync(path).isFile()) sizes.push(statSync(path).size);
    });

    publishPrivateFile(target, "token\n");
    expect(sizes).toEqual([0]);
    expect(readFileSync(target, "utf8")).toBe("token\n");
  });

  it("limits the folder that will hold the stage file before the file exists", () => {
    // Review finding on PR #4464: on Windows the file took its folder's permissions between its
    // creation and its restriction, so another account could open it. The stage file is created
    // inside a folder that was already cut off from other accounts.
    const root = tempDir();
    const target = join(root, "file.json");
    const seen = [];
    vi.spyOn(privateFileAccess, "restrict").mockImplementation((path) => {
      const folder = statSync(path).isDirectory();
      seen.push({ folder, entries: folder ? readdirSync(path) : undefined });
    });

    publishPrivateFile(target, "token\n");
    expect(seen[0]).toEqual({ folder: true, entries: [] });
    expect(readdirSync(root)).toEqual(["file.json"]);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("writes no token and leaves nothing behind when the file cannot be limited", () => {
    const root = tempDir();
    const target = join(root, "file.json");
    vi.spyOn(privateFileAccess, "restrict").mockImplementation(() => {
      throw new LauncherRefusal("cannot be limited", "nicht beschraenkbar");
    });

    expect(() => publishPrivateFile(target, "token\n")).toThrow(LauncherRefusal);
    expect(readdirSync(root)).toEqual([]);
  });

  describe("the access file's permissions on Windows", () => {
    const env = { SystemRoot: "C:\\Windows" };
    const sid = "S-1-5-21-1004336348-1177238915-682003330-1001";

    function windows(whoami, icacls = { status: 0 }) {
      const calls = [];
      const run = vi.fn((program, args) => {
        calls.push([program, ...args]);
        return program.endsWith("whoami.exe") ? whoami : icacls;
      });
      return { calls, run };
    }

    it("cuts the file off from its folder and grants it to the running account alone", () => {
      const { calls, run } = windows({ status: 0, stdout: `"host\\admin","${sid}"\r\n` });

      restrictToCurrentAccount("C:\\Keiko\\.keiko.config.json.tmp", {
        platform: "win32",
        env,
        run,
      });
      expect(calls).toEqual([
        ["C:\\Windows\\System32\\whoami.exe", "/user", "/fo", "csv", "/nh"],
        [
          "C:\\Windows\\System32\\icacls.exe",
          "C:\\Keiko\\.keiko.config.json.tmp",
          "/inheritance:r",
          "/grant:r",
          `*${sid}:F`,
        ],
      ]);
    });

    it.each([
      ["whoami fails", { status: 1, stdout: "" }, { status: 0 }],
      ["whoami names no SID", { status: 0, stdout: '"host\\admin","admin"' }, { status: 0 }],
      ["icacls fails", { status: 0, stdout: `"host\\admin","${sid}"` }, { status: 5 }],
      [
        "icacls cannot run",
        { status: 0, stdout: `"host\\admin","${sid}"` },
        { error: new Error("ENOENT") },
      ],
    ])("refuses to go on when %s", (_, whoami, icacls) => {
      const { run } = windows(whoami, icacls);

      expect(() => restrictToCurrentAccount("C:\\f", { platform: "win32", env, run })).toThrow(
        /cannot be limited to your Windows account/u,
      );
    });

    it("refuses a system folder that is not a drive path, and leaves other systems alone", () => {
      const { run } = windows({ status: 0, stdout: `"h\\a","${sid}"` });

      expect(() =>
        restrictToCurrentAccount("C:\\f", { platform: "win32", env: { SystemRoot: "evil" }, run }),
      ).toThrow(LauncherRefusal);
      restrictToCurrentAccount("/tmp/f", { platform: "darwin", env, run });
      expect(run).not.toHaveBeenCalled();
    });
  });

  it("refuses a configuration that names no usable model", () => {
    expect(() => teamConfig({}, "t")).toThrow(/names no models/u);
    expect(() => teamConfig({ providers: [] }, "t")).toThrow(/names no models/u);
    expect(() => teamConfig({ providers: [{ baseUrl: "https://gw" }] }, "t")).toThrow(
      /no modelId or baseUrl/u,
    );
  });
});
