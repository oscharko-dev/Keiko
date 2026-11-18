import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureInstalled,
  installArgs,
  installationCurrent,
  isEntryPoint,
  keikoCliPath,
  keikoEnv,
  lockfileDigest,
  needsToken,
  npmCacheDir,
  npmCliCandidates,
  npmEnv,
  startArgs,
  stateDir,
  teamConfig,
  tokenInput,
} from "../standalone/npm/keiko-npm.mjs";

// The start logic that ships inside an npm package (system/keiko-npm.mjs). It runs with Node.js
// built-ins only, before Keiko is installed.

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-npm-runtime-"));
  tempRoots.push(root);
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  return root;
}

function installKeiko(root, marker) {
  mkdirSync(join(root, "node_modules", "@oscharko-dev", "keiko", "dist", "cli"), {
    recursive: true,
  });
  writeFileSync(keikoCliPath(root), "");
  if (marker !== undefined)
    writeFileSync(join(root, "node_modules", ".keiko-npm-installed"), marker);
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

  it("keeps Keiko's data in the user's .keiko-standalone folder unless one is named", () => {
    expect(stateDir({}, "/home/a")).toBe(join("/home/a", ".keiko-standalone"));
    expect(stateDir({ KEIKO_STATE_DIR: "" }, "/home/a")).toBe(join("/home/a", ".keiko-standalone"));
    expect(stateDir({ KEIKO_STATE_DIR: "/s" }, "/home/a")).toBe("/s");
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

  it("declares Keiko managed outside the app unless a declaration is already set", () => {
    expect(keikoEnv({}).KEIKO_PORTABLE_MANAGEMENT).toBe("organization-managed");
    expect(
      keikoEnv({ KEIKO_PORTABLE_MANAGEMENT: "machine-managed" }).KEIKO_PORTABLE_MANAGEMENT,
    ).toBe("machine-managed");
  });

  it("runs npm without install scripts and with its cache in Keiko's data folder", () => {
    const cache = npmCacheDir({}, "/home/a");
    expect(cache).toBe(join("/home/a", ".keiko-standalone", "npm-cache"));

    const args = installArgs("/n/npm-cli.js", cache);
    expect(args.slice(0, 2)).toEqual(["/n/npm-cli.js", "ci"]);
    expect(args).toContain("--ignore-scripts");
    expect(args).toContain("--no-update-notifier");
    // npm keeps its logs in <cache>/_logs, so nothing lands in the person's ~/.npm.
    expect(args[args.indexOf("--cache") + 1]).toBe(cache);
    // Set on the command line, so neither an npm_config_* variable nor an .npmrc moves the log.
    expect(args[args.indexOf("--logs-dir") + 1]).toBe(join(cache, "_logs"));
  });

  describe("the installation", () => {
    // A stand-in for `npm ci`: it writes into the cache it was given and, when it succeeds,
    // installs Keiko's command line.
    function fakeNpm(root, succeeds) {
      const calls = [];
      const run = (_node, args) => {
        calls.push(args);
        const cache = args[args.indexOf("--cache") + 1];
        mkdirSync(join(cache, "_logs"), { recursive: true });
        writeFileSync(join(cache, "_logs", "debug.log"), "log");
        writeFileSync(join(cache, "keiko.tgz"), "tarball");
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
      const env = { KEIKO_STATE_DIR: join(root, "state") };
      return { root, nodeDir, env, cache: npmCacheDir(env) };
    }

    it("creates the data folder owner-private, marks the lockfile and removes npm's cache", () => {
      const { root, nodeDir, env, cache } = installFixture();
      const npm = fakeNpm(root, true);

      expect(ensureInstalled(root, nodeDir, env, npm.run)).toBe(true);
      expect(statSync(env.KEIKO_STATE_DIR).mode & 0o777).toBe(0o700);
      expect(existsSync(cache)).toBe(false);
      expect(installationCurrent(root, lockfileDigest(root))).toBe(true);
      // A current installation is not repeated.
      expect(ensureInstalled(root, nodeDir, env, npm.run)).toBe(true);
      expect(npm.calls).toHaveLength(1);
    });

    it("keeps only npm's log of a failed attempt and marks nothing", () => {
      const { root, nodeDir, env, cache } = installFixture();

      expect(ensureInstalled(root, nodeDir, env, fakeNpm(root, false).run)).toBe(false);
      expect(readdirSync(cache)).toEqual(["_logs"]);
      expect(existsSync(join(root, "node_modules", ".keiko-npm-installed"))).toBe(false);
    });
  });

  it("starts when the folder is reached through a symbolic link", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-npm-entry-"));
    tempRoots.push(root);
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
    const env = { KEIKO_STATE_DIR: "/s" };

    expect(startArgs(root, env)).toEqual(["start", "--state-dir", "/s"]);
    writeFileSync(join(root, "keiko.config.json"), "{}");
    expect(startArgs(root, env)).toEqual([
      "start",
      "--state-dir",
      "/s",
      "--provisioned-config",
      join(root, "keiko.config.json"),
    ]);
  });
});

describe("the administrator's access step", () => {
  const sealed = {
    modelId: "chat",
    baseUrl: "https://gw",
    apiKeySecretRef: "vault:1",
    timeoutMs: 1,
  };

  it("replaces every key sealed on this computer with the team's token", () => {
    const config = { defaultModelId: "chat", providers: [sealed, { ...sealed, modelId: "embed" }] };

    expect(needsToken(config)).toBe(true);
    const result = teamConfig(config, "token");
    expect(result.defaultModelId).toBe("chat");
    expect(result.providers).toEqual([
      { modelId: "chat", baseUrl: "https://gw", timeoutMs: 1, apiKey: "token" },
      { modelId: "embed", baseUrl: "https://gw", timeoutMs: 1, apiKey: "token" },
    ]);
    expect(needsToken(result)).toBe(false);
  });

  it("replaces the reranker's sealed key too", () => {
    const config = {
      providers: [{ modelId: "chat", baseUrl: "https://gw", apiKey: "own" }],
      reranker: { modelId: "rerank", baseUrl: "https://gw", apiKeySecretRef: "vault:2" },
    };

    expect(needsToken(config)).toBe(true);
    expect(teamConfig(config, "token").reranker).toEqual({
      modelId: "rerank",
      baseUrl: "https://gw",
      apiKey: "token",
    });
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

  it("refuses a configuration that names no usable model", () => {
    expect(() => teamConfig({}, "t")).toThrow(/names no models/u);
    expect(() => teamConfig({ providers: [] }, "t")).toThrow(/names no models/u);
    expect(() => teamConfig({ providers: [{ baseUrl: "https://gw" }] }, "t")).toThrow(
      /no modelId or baseUrl/u,
    );
  });
});
