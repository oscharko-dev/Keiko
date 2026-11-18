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
  isEntryPoint,
  keikoCliPath,
  keikoEnv,
  lockfileDigest,
  main,
  needsToken,
  npmCliCandidates,
  npmEnv,
  npmLogsDir,
  publishPrivateFile,
  readHidden,
  runCommand,
  saveConfig,
  start,
  startArgs,
  stateDir,
  stop,
  stopRequestPath,
  teamConfig,
  tokenInput,
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

    it("installs and then starts Keiko, releasing the folder's installation lock", () => {
      quiet();
      const { root, nodeDir, env } = installFixture();
      const npm = fakeNpm(root, true);
      const run = vi.fn((node, args, options) =>
        args[1] === "ci" ? npm.run(node, args, options) : { status: 0 },
      );

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][1]).toEqual([keikoCliPath(root), ...startArgs(root, env)]);
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("reports a failed first start and leaves the lock free for the next one", () => {
      quiet();
      const { root, nodeDir, env } = installFixture();

      expect(start(root, nodeDir, env, fakeNpm(root, false).run)).toBe(1);
      expect(existsSync(installLockPath(root))).toBe(false);
    });

    it("lets one start of a folder install and tells a second start so", () => {
      // Review finding on PR #4464 (P2): two starts could both run `npm ci` on the same tree.
      quiet();
      const { root, nodeDir, env } = installFixture();
      expect(acquireInstallLock(root)).toBe(true);
      const run = vi.fn();

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(run).not.toHaveBeenCalled();
      expect(acquireInstallLock(root)).toBe(false);
      rmSync(installLockPath(root));
      expect(acquireInstallLock(root)).toBe(true);
    });

    it("takes over the lock of a start that no longer runs", () => {
      const { root } = installFixture();
      const ended = spawnSync(process.execPath, ["-e", ""]);
      writeFileSync(installLockPath(root), `${String(ended.pid)}\n`);

      expect(acquireInstallLock(root)).toBe(true);
      expect(readFileSync(installLockPath(root), "utf8")).toBe(`${String(process.pid)}\n`);
    });

    it("keeps Keiko from starting when Stop comes while it is being loaded", () => {
      // Review finding on PR #4464 (P2): Stop reported success before the CLI existed while the
      // pending start still opened Keiko.
      quiet();
      const { root, nodeDir, env } = installFixture();
      const stopRun = vi.fn();
      const stopped = [];
      const npm = fakeNpm(root, true, () => stopped.push(stop(root, env, stopRun)));
      const run = vi.fn((node, args, options) => npm.run(node, args, options));

      expect(start(root, nodeDir, env, run)).toBe(0);
      expect(stopped).toEqual([0]);
      expect(stopRun).not.toHaveBeenCalled();
      // Only npm ran: the start did not open Keiko.
      expect(run).toHaveBeenCalledOnce();
      expect(existsSync(stopRequestPath(root))).toBe(false);
      expect(existsSync(installLockPath(root))).toBe(false);
      // A Stop request left by an earlier start does not cancel the next one.
      writeFileSync(stopRequestPath(root), "1\n");
      rmSync(join(root, "node_modules", ".keiko-npm-installed"));
      const next = vi.fn((node, args, options) =>
        args[1] === "ci" ? fakeNpm(root, true).run(node, args, options) : { status: 0 },
      );
      expect(start(root, nodeDir, env, next)).toBe(0);
      expect(next).toHaveBeenCalledTimes(2);
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
