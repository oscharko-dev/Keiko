import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { packageJsonText } from "../build-standalone-npm-package.mjs";
import {
  ensureInstalled,
  keikoCliPath,
  npmCliCandidates,
  stateDir,
} from "../standalone/npm/keiko-npm.mjs";

// The first start of an npm package with the real npm (ADR-0121 D9): Keiko is a small stand-in
// package served by loopback registries, so nothing leaves the machine. These tests prove where
// npm installs and which registry it asks, which no stand-in for npm can show.

const LAUNCHER = fileURLToPath(new URL("../standalone/npm/keiko-npm.mjs", import.meta.url));
const VERSION = "1.2.3";
const PUBLIC_TARBALL = `https://registry.npmjs.org/@oscharko-dev/keiko/-/keiko-${VERSION}.tgz`;
// A registry that serves the stand-in tarball for every .tgz request and records every request.
const REGISTRY_SOURCE = `
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
const [tarball, log] = process.argv.slice(1);
const server = createServer((request, response) => {
  appendFileSync(log, request.url + "\\n");
  if (request.url.endsWith(".tgz")) {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(readFileSync(tarball));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(0, "127.0.0.1", () => console.log(String(server.address().port)));
`;

const cleanups = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// The npm of the Node.js that runs the tests: beside it, the one `npm test` names, or on PATH.
// The npm CLI script an npm on PATH runs: npm.cmd beside its node_modules, or a link to it.
function npmCliOnPath(folder) {
  const windows = join(folder, "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(join(folder, "npm.cmd")) && existsSync(windows)) return windows;
  const link = join(folder, "npm");
  return existsSync(link) && realpathSync(link).endsWith("npm-cli.js")
    ? realpathSync(link)
    : undefined;
}

function locateNpmCli() {
  const named = process.env.npm_execpath;
  if (named !== undefined && named.endsWith("npm-cli.js") && existsSync(named)) return named;
  const beside = npmCliCandidates(dirname(process.execPath)).find((path) => existsSync(path));
  if (beside !== undefined) return beside;
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    const found = npmCliOnPath(folder);
    if (found !== undefined) return found;
  }
  throw new Error("no npm found for the Node.js that runs these tests");
}

// A Node.js folder whose npm is the real one, laid out as the macOS package keeps it.
function nodeDirWithNpm(root) {
  const npmPackage = dirname(dirname(locateNpmCli()));
  const prefix = join(root, "node");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
  symlinkSync(
    npmPackage,
    join(prefix, "lib", "node_modules", "npm"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return join(prefix, "bin");
}

// What npm needs of the environment, and nothing of the person who runs the tests: no proxy, no
// registry and no npm configuration of theirs.
function isolatedEnv(home, extra = {}) {
  const kept = Object.entries(process.env).filter(([name]) =>
    ["path", "systemroot", "temp", "tmp", "tmpdir", "comspec"].includes(name.toLowerCase()),
  );
  return { ...Object.fromEntries(kept), HOME: home, USERPROFILE: home, ...extra };
}

function standInTarball(root, npmCli, cli) {
  const source = join(root, "stand-in");
  mkdirSync(join(source, "dist", "cli"), { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "@oscharko-dev/keiko", version: VERSION }),
  );
  writeFileSync(join(source, "dist", "cli", "index.js"), cli);
  const out = join(root, "tarball");
  mkdirSync(out);
  const packed = spawnSync(
    process.execPath,
    [npmCli, "pack", "--ignore-scripts", "--pack-destination", out],
    { cwd: source, encoding: "utf8", env: isolatedEnv(join(root, "pack-home")) },
  );
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
  const [name] = readdirSync(out);
  const tarball = join(out, name);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  return { tarball, integrity };
}

function writePackage(root, integrity, registry) {
  mkdirSync(join(root, "system"), { recursive: true });
  copyFileSync(LAUNCHER, join(root, "system", "keiko-npm.mjs"));
  writeFileSync(join(root, "package.json"), packageJsonText(VERSION));
  const lock = {
    name: "keiko-npm-package",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "keiko-npm-package", dependencies: { "@oscharko-dev/keiko": VERSION } },
      "node_modules/@oscharko-dev/keiko": { version: VERSION, resolved: PUBLIC_TARBALL, integrity },
    },
  };
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(join(root, ".npmrc"), `registry=${registry}\n`);
}

// A loopback registry in its own process: spawnSync of npm blocks this test's event loop.
async function startRegistry(tarball, log) {
  writeFileSync(log, "");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", REGISTRY_SOURCE, tarball, log],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  cleanups.push(() => child.kill());
  const port = await new Promise((resolvePort, rejectPort) => {
    child.once("error", rejectPort);
    child.once("exit", (code) => rejectPort(new Error(`registry exited with ${String(code)}`)));
    child.stdout.once("data", (chunk) => resolvePort(String(chunk).trim()));
  });
  return { url: `http://127.0.0.1:${port}/`, requests: () => readFileSync(log, "utf8") };
}

describe("the first start with the real npm", () => {
  it("installs into the folder, asks only the folder's registry and leaves other trees alone", async () => {
    // Review findings on PR #4464 (P1): with npm 11, a folder above the package that declared it a
    // workspace became npm's project, and its CI install removed unrelated files; an inherited
    // npm_config_registry outranked the folder's registry.
    const root = tempDir("keiko-npm-install-");
    const npmCli = locateNpmCli();
    const { tarball, integrity } = standInTarball(root, npmCli, "");
    const mirror = await startRegistry(tarball, join(root, "mirror.log"));
    const other = await startRegistry(tarball, join(root, "other.log"));

    const ancestor = join(root, "projects");
    mkdirSync(join(ancestor, "node_modules", "unrelated"), { recursive: true });
    writeFileSync(join(ancestor, "node_modules", "unrelated", "index.js"), "kept");
    mkdirSync(join(ancestor, "sibling", "node_modules", "dependency"), { recursive: true });
    writeFileSync(join(ancestor, "sibling", "node_modules", "dependency", "index.js"), "kept");
    writeFileSync(
      join(ancestor, "package.json"),
      JSON.stringify({ name: "projects", private: true, workspaces: ["Keiko", "sibling"] }),
    );
    writeFileSync(join(ancestor, ".npmrc"), `registry=${other.url}\n`);
    const folder = join(ancestor, "Keiko");
    writePackage(folder, integrity, mirror.url);

    const home = join(root, "home");
    mkdirSync(join(home, ".keiko-standalone", "npm-cache"), { recursive: true });
    writeFileSync(join(home, ".keiko-standalone", "npm-cache", "kept"), "kept");
    const env = isolatedEnv(home, { npm_config_registry: other.url });

    expect(ensureInstalled(folder, nodeDirWithNpm(root), env)).toBe(true);
    expect(existsSync(keikoCliPath(folder))).toBe(true);
    expect(readFileSync(join(ancestor, "node_modules", "unrelated", "index.js"), "utf8")).toBe(
      "kept",
    );
    expect(existsSync(join(ancestor, "sibling", "node_modules", "dependency", "index.js"))).toBe(
      true,
    );
    expect(existsSync(join(ancestor, "node_modules", "@oscharko-dev"))).toBe(false);
    expect(mirror.requests()).toContain(`/@oscharko-dev/keiko/-/keiko-${VERSION}.tgz`);
    expect(other.requests()).toBe("");
    const state = stateDir(env);
    expect(readFileSync(join(state, "npm-cache", "kept"), "utf8")).toBe("kept");
    expect(readdirSync(state).filter((name) => name.startsWith("npm-cache-"))).toEqual([]);
    expect(statSync(join(state, "npm-logs")).isDirectory()).toBe(true);
  }, 120_000);

  it("installs once when two first starts run at the same time", async () => {
    // Review finding on PR #4464 (P2): two starts could both see no installation and run `npm ci`
    // on the same tree, one removing what the other was installing.
    const root = tempDir("keiko-npm-concurrent-");
    const npmCli = locateNpmCli();
    const started = join(root, "started.log");
    const cli = `require("node:fs").appendFileSync(${JSON.stringify(started)}, process.argv[2] + "\\n");`;
    const { tarball, integrity } = standInTarball(root, npmCli, cli);
    const mirror = await startRegistry(tarball, join(root, "mirror.log"));
    const folder = join(root, "Keiko");
    writePackage(folder, integrity, mirror.url);
    // Two processes that each run the package's own launcher, with npm where the package keeps it.
    const context = JSON.stringify({ root: folder, nodeDir: nodeDirWithNpm(root) });
    const script = `import(${JSON.stringify(pathToFileURL(join(folder, "system", "keiko-npm.mjs")).href)})
      .then((launcher) => launcher.runCommand("start", ${context}))
      .then((code) => { process.exitCode = code; });`;
    const env = isolatedEnv(join(root, "home"));

    const launch = () =>
      new Promise((resolveRun) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          cwd: folder,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += String(chunk)));
        child.stderr.on("data", (chunk) => (output += String(chunk)));
        child.on("exit", (code) => resolveRun({ code, output }));
      });
    const runs = await Promise.all([launch(), launch()]);

    expect(runs.map((run) => run.code)).toEqual([0, 0]);
    const tarballRequests = mirror
      .requests()
      .split("\n")
      .filter((line) => line.endsWith(".tgz"));
    // npm ran once, or the second start found the first one's complete installation.
    expect(tarballRequests).toHaveLength(1);
    expect(readFileSync(started, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(folder, "system", "keiko-npm-install.lock"))).toBe(false);
  }, 120_000);
});
