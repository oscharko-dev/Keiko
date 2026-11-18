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
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// The two readers of the declaration: the CLI's (Windows gateway service setup) and the server's
// (update preflight).
import { managedOutsideApp } from "../../packages/keiko-cli/src/portable-management.ts";
import {
  externallyManagedInstallMode,
  portableManagementFromEnv,
} from "../../packages/keiko-server/src/update-portable-install-mode.ts";

import {
  LauncherRefusal,
  acquireInstallLock,
  credentialScope,
  ensureInstalled,
  folderRegistry,
  homeOf,
  installArgs,
  installLockPath,
  installationCurrent,
  installerActive,
  isEntryPoint,
  keikoCliPath,
  keikoEnv,
  lockfileDigest,
  main,
  needsToken,
  npmCliCandidates,
  npmEnv,
  npmLogsDir,
  ownerExpired,
  publishPrivateFile,
  readHidden,
  releaseInstallLock,
  requestStop,
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

afterEach(() => {
  vi.restoreAllMocks();
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

function endedPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
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
      expect(args).toEqual([keikoCliPath(root), ...startArgs(root, env)]);
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
        args[1] === "ci" ? npm.run(node, args, options) : { status: 0 },
      );

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][1]).toEqual([keikoCliPath(root), ...startArgs(root, env)]);
      expect(existsSync(installLockPath(root))).toBe(false);
      expect(lockLeftovers(root)).toEqual([]);
      // The start says itself that Keiko is open: the start file prints only a failure.
      expect(log).toHaveBeenCalledWith(
        "Keiko is running in your browser. You can close this window.",
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
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/running in your browser/u));
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

    it("takes over a lock written before the computer started, though its number runs again", () => {
      // Audit of PR #4464 (P2): the system gives an ended start's process number to a new process,
      // and that process held the lock for every later start and Stop.
      const { root } = installFixture();
      staleLock(root, process.pid, [], "1\n");

      expect(installerActive(root)).toBe(false);
      expect(requestStop(root)).toBe(false);
      const lock = acquireInstallLock(root);
      expect(lock).toBeDefined();
      expect(lockOwners(root)).toEqual([`owner-${lock.token}`]);
      // The lock this start wrote names its own time, so it holds against the next start.
      expect(installerActive(root)).toBe(true);
      expect(acquireInstallLock(root)).toBeUndefined();
    });

    it("lets an owner hold the lock only within the computer's run and one hour", () => {
      const now = 10_000_000_000;
      const up = 5 * 60 * 60 * 1000;
      const minute = 60 * 1000;

      expect(ownerExpired(now - minute, now, up)).toBe(false);
      // A clock set back after the owner was written does not end it.
      expect(ownerExpired(now + minute, now, up)).toBe(false);
      // Written before the computer started, beyond what a clock correction explains.
      expect(ownerExpired(now - up - 11 * minute, now, up)).toBe(true);
      expect(ownerExpired(now - minute, now, 4 * minute)).toBe(false);
      expect(ownerExpired(now - 61 * minute, now, up)).toBe(true);
      expect(ownerExpired(now - 59 * minute, now, up)).toBe(false);
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
      expect(run.mock.calls.map((call) => call[1][1])).toEqual(["start", "stop"]);
      expect(log).toHaveBeenCalledWith(
        "Keiko is still being loaded. It does not stay open: the start that loads it stops it.",
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/running in your browser/u));
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
        args[1] === "ci" ? npm.run(node, args, options) : { status: 0 },
      );

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(stopped).toEqual([0]);
      expect(stopRun).not.toHaveBeenCalled();
      // npm ran and Keiko was not opened; the start carried the Stop out, so a Keiko an earlier
      // start of the folder opened stops as well.
      expect(run.mock.calls.map((call) => call[1][1])).toEqual(["ci", "stop"]);
      expect(log).toHaveBeenCalledWith(
        "Keiko was stopped while it was being loaded and does not start. You can close this window.",
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/running in your browser/u));
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
        if (args[1] === "ci") return npm.run(node, args, options);
        // Keiko opens while the start still holds the lock; this Stop lands in it.
        if (args[1] === "start") stopped.push(stop(root, env, stopRun));
        return { status: 0 };
      });

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(stopped).toEqual([0]);
      expect(stopRun).not.toHaveBeenCalled();
      expect(run.mock.calls.map((call) => call[1][1])).toEqual(["ci", "start", "stop"]);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^Keiko was stopped again right after it opened/u),
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/running in your browser/u));
    });

    it("leaves a Stop after the loading start to stop the opened Keiko itself", () => {
      quiet();
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true);
      const run = vi.fn((node, args, options) =>
        args[1] === "ci" ? npm.run(node, args, options) : { status: 0 },
      );
      expect(start(root, nodeDir, env, run)).toBe(0);

      // The start let go of its lock only once Keiko was open: this Stop finds no lock.
      expect(requestStop(root)).toBe(false);
      const stopRun = vi.fn(() => ({ status: 0 }));
      expect(stop(root, env, stopRun)).toBe(0);
      expect(stopRun.mock.calls.map((call) => call[1][1])).toEqual(["stop"]);
    });

    it("reports Keiko's own exit code when it fails to open after the installation", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true);
      const run = vi.fn((node, args, options) =>
        args[1] === "ci" ? npm.run(node, args, options) : { status: 4 },
      );

      expect(start(root, nodeDir, env, run)).toBe(4);
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/running in your browser/u));
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("reports a Stop it could not carry out with the stop's exit code", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true, () => requestStop(root));
      const run = vi.fn((node, args, options) =>
        args[1] === "ci" ? npm.run(node, args, options) : { status: 5 },
      );

      expect(start(root, nodeDir, env, run)).toBe(5);
      expect(run.mock.calls.map((call) => call[1][1])).toEqual(["ci", "stop"]);
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/was stopped/u));
    });

    it("carries out a Stop also when Keiko reported a failure as it opened", () => {
      quiet();
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true);
      const run = vi.fn((node, args, options) => {
        if (args[1] === "ci") return npm.run(node, args, options);
        if (args[1] !== "start") return { status: 0 };
        requestStop(root);
        return { status: 6 };
      });

      // Whatever part of Keiko came up stops, and the start reports why Keiko did not open.
      expect(start(root, nodeDir, env, run)).toBe(6);
      expect(run.mock.calls.map((call) => call[1][1])).toEqual(["ci", "start", "stop"]);
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
  });

  it("stops Keiko only in a folder it was loaded into", () => {
    quiet();
    const root = packageRoot();
    const env = homeEnv(root);
    const run = vi.fn(() => ({ status: 3 }));

    expect(stop(root, env, run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    installKeiko(root);
    expect(stop(root, env, run)).toBe(3);
    expect(run.mock.calls[0][1]).toEqual([
      keikoCliPath(root),
      "stop",
      "--state-dir",
      stateDir(env),
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
    expect(run.mock.calls.map((call) => call[1][1])).toEqual(["start", "stop"]);
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
    const embed = { ...sealed, modelId: "embed", catalogOrigin: "discovered" };
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
        apiKey: "token",
      },
    ]);
    expect(needsToken(result)).toBe(false);
  });

  it("replaces the key of a reranker on the gateway's own endpoint and header", () => {
    const config = {
      providers: [{ modelId: "chat", baseUrl: "https://gw/", apiKey: "own" }],
      reranker: { modelId: "rerank", baseUrl: "https://gw", apiKeySecretRef: "vault:2" },
    };

    expect(needsToken(config)).toBe(true);
    expect(teamConfig(config, "token").reranker).toEqual({
      modelId: "rerank",
      baseUrl: "https://gw",
      apiKey: "token",
    });
  });

  it("replaces the key of a voice deployment Gateway Setup found on the gateway", () => {
    const config = {
      providers: [sealed, { modelId: "stt", baseUrl: "https://gw", apiKeySecretRef: "vault:3" }],
      capabilities: [{ id: "stt", kind: "voice", voiceProviderLocality: "gateway-managed" }],
    };

    expect(credentialScope(config).foreign).toEqual([]);
    expect(teamConfig(config, "token").providers[1]).toMatchObject({ apiKey: "token" });
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
    const voice = { modelId: "stt", baseUrl: "https://gw", apiKeySecretRef: "vault:3", capability };
    const config = { providers: [sealed, voice] };

    expect(credentialScope(config).foreign).toEqual([]);
    expect(teamConfig(config, "token").providers[1]).toEqual({
      modelId: "stt",
      baseUrl: "https://gw",
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
    // A listed capability wins over the provider's own, as the gateway's loader merges them.
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

  // What readHidden needs of process.stdin and process.stdout.
  function fakeTerminal(isTTY = true) {
    const stdin = Object.assign(new EventEmitter(), {
      isTTY,
      rawModes: [],
      encoding: undefined,
      flowing: false,
      setRawMode(mode) {
        this.rawModes.push(mode);
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
    return { io: { stdin, stdout: { write: (text) => written.push(text) } }, stdin, written };
  }

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

  it("refuses a configuration that names no usable model", () => {
    expect(() => teamConfig({}, "t")).toThrow(/names no models/u);
    expect(() => teamConfig({ providers: [] }, "t")).toThrow(/names no models/u);
    expect(() => teamConfig({ providers: [{ baseUrl: "https://gw" }] }, "t")).toThrow(
      /no modelId or baseUrl/u,
    );
  });
});
