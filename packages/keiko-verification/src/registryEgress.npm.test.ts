// The proxy and the npm configuration confine the install only if npm honours them. This spawns the
// real npm with the install's own argv and egress configuration against manifests naming the kinds
// of source a registry package can declare transitively, past every pre-install check: a URL, a
// tarball file, a folder and each Git form npm resolves. Every install must fail for its own reason
// (EALLOWGIT before git runs, EALLOWREMOTE before a URL is fetched, EALLOWFILE and EALLOWDIRECTORY
// before npm reads the file or folder, and E403 at the proxy for an npm that fetches a URL anyway)
// without one connection reaching the loopback listener, while the links npm makes for a
// workspace's own members still install (PR #3452 review, CWE-918).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPENDENCY_APPROVED_REGISTRY, DEPENDENCY_INSTALL_ARGS } from "./dependencies.js";
import {
  registryEgressEnv,
  startRegistryEgressProxy,
  type RegistryEgressProxy,
} from "./registryEgress.js";

interface Lane {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly proxy: RegistryEgressProxy;
  readonly loopback: string;
  readonly connections: () => number;
  readonly dialled: () => number;
  readonly close: () => Promise<void>;
}

async function startLane(): Promise<Lane> {
  const root = mkdtempSync(join(tmpdir(), "keiko-registry-egress-"));
  const home = join(root, "home");
  mkdirSync(home);
  let connections = 0;
  const listener: Server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  let dialled = 0;
  const proxy = await startRegistryEgressProxy({
    registry: DEPENDENCY_APPROVED_REGISTRY,
    // No manifest here needs the registry. A dial would mean npm went somewhere unexpected, and it
    // lands on the recording listener, so the assertions catch it either way.
    connectUpstream: () => {
      dialled += 1;
      return connect({ host: "127.0.0.1", port: address.port });
    },
  });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    npm_config_cache: join(root, "cache"),
    npm_config_update_notifier: "false",
    // A refused fetch is final; npm's default retries would only make this suite slow.
    npm_config_fetch_retries: "0",
    ...registryEgressEnv(proxy.url, DEPENDENCY_APPROVED_REGISTRY),
  };
  return {
    root,
    env,
    proxy,
    loopback: `127.0.0.1:${String(address.port)}`,
    connections: () => connections,
    dialled: () => dialled,
    close: async (): Promise<void> => {
      await proxy.close();
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface Installed {
  readonly code: number;
  readonly output: string;
  readonly workspace: string;
}

// Installs a fresh workspace made of `files`, each a JSON document at its relative path, and returns
// npm's exit code and output. `env` overrides the lane's configuration for this one install.
async function npmInstallTree(
  lane: Lane,
  files: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv = {},
): Promise<Installed> {
  const workspace = mkdtempSync(join(lane.root, "workspace-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), JSON.stringify(content));
  }
  const child = spawn("npm", [...DEPENDENCY_INSTALL_ARGS], {
    cwd: workspace,
    env: { ...lane.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-65_536);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const [code] = (await once(child, "close")) as [number | null];
  return { code: code ?? -1, output, workspace };
}

// Installs one dependency in a fresh workspace.
function npmInstall(
  lane: Lane,
  dependency: string,
  env: NodeJS.ProcessEnv = {},
): Promise<Installed> {
  const manifest = { name: "egress-probe", version: "1.0.0", dependencies: { probe: dependency } };
  return npmInstallTree(lane, { "package.json": manifest }, env);
}

// npm is `npm.cmd` on Windows and cannot be spawned without a shell; the Linux and macOS lanes run it.
describe.skipIf(process.platform === "win32")("npm under the registry egress configuration", () => {
  let lane: Lane;

  beforeAll(async () => {
    lane = await startLane();
  });

  afterAll(async () => {
    await lane.close();
  });

  it("refuses a URL dependency before fetching it", async () => {
    const before = lane.proxy.counts();

    const { code, output } = await npmInstall(lane, `http://${lane.loopback}/probe.tgz`);

    expect(code).not.toBe(0);
    expect(output).toContain("EALLOWREMOTE");
    expect(lane.proxy.counts()).toEqual(before);
    expect(lane.connections()).toBe(0);
    expect(lane.dialled()).toBe(0);
  }, 60_000);

  // An npm that fetches the URL anyway, as one without the gate would, still cannot reach it.
  it("fails a loopback tarball at the proxy when npm fetches the URL anyway", async () => {
    const before = lane.proxy.counts();

    const { code, output } = await npmInstall(lane, `http://${lane.loopback}/probe.tgz`, {
      npm_config_allow_remote: "all",
    });

    expect(code).not.toBe(0);
    expect(output).toMatch(/E403|403 Forbidden/u);
    expect(lane.proxy.counts()).toEqual({ allowed: before.allowed, refused: before.refused + 1 });
    expect(lane.connections()).toBe(0);
    expect(lane.dialled()).toBe(0);
  }, 60_000);

  it("refuses a tarball file before reading it", async () => {
    const before = lane.proxy.counts();

    const { code, output } = await npmInstall(lane, "file:./probe.tgz");

    expect(code).not.toBe(0);
    expect(output).toContain("EALLOWFILE");
    expect(lane.proxy.counts()).toEqual(before);
    expect(lane.dialled()).toBe(0);
  }, 60_000);

  // The root may name a folder, which the pre-install check refuses before npm runs; a package in
  // the tree may not, and npm refuses it itself.
  it("refuses a folder that a package in the tree names", async () => {
    const { code, output } = await npmInstallTree(lane, {
      "package.json": {
        name: "egress-probe",
        version: "1.0.0",
        dependencies: { a: "file:./vendor/a" },
      },
      "vendor/a/package.json": { name: "a", version: "1.0.0", dependencies: { b: "file:../b" } },
      "vendor/b/package.json": { name: "b", version: "1.0.0" },
    });

    expect(code).not.toBe(0);
    expect(output).toContain("EALLOWDIRECTORY");
  }, 60_000);

  // npm holds the links it makes for a workspace's members to the same folder gate: with
  // `allow-directory=none` this install fails with EALLOWDIRECTORY.
  it("installs the links npm makes for the workspace's own members", async () => {
    const before = lane.proxy.counts();

    const { code, workspace } = await npmInstallTree(lane, {
      "package.json": { name: "egress-probe", private: true, workspaces: ["packages/*"] },
      "packages/a/package.json": { name: "a", version: "1.0.0" },
      "packages/b/package.json": { name: "b", version: "1.0.0", dependencies: { a: "1.0.0" } },
    });

    expect(code).toBe(0);
    expect(lstatSync(join(workspace, "node_modules", "a")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(workspace, "node_modules", "b")).isSymbolicLink()).toBe(true);
    expect(lane.proxy.counts()).toEqual(before);
    expect(lane.dialled()).toBe(0);
  }, 60_000);

  it.each([
    ["git+https", (loopback: string): string => `git+https://${loopback}/probe.git`],
    ["git+http", (loopback: string): string => `git+http://${loopback}/probe.git`],
    ["git+ssh", (loopback: string): string => `git+ssh://git@${loopback}/probe.git`],
    ["git://", (loopback: string): string => `git://${loopback}/probe.git`],
    ["github: shorthand", (): string => "github:keiko-egress-probe/probe"],
    ["owner/repo shorthand", (): string => "keiko-egress-probe/probe"],
    ["gitlab: shorthand", (): string => "gitlab:keiko-egress-probe/probe"],
    ["bitbucket: shorthand", (): string => "bitbucket:keiko-egress-probe/probe"],
  ])(
    "refuses a %s dependency before git runs",
    async (_form, spec) => {
      const before = lane.proxy.counts();

      const { code, output } = await npmInstall(lane, spec(lane.loopback));

      expect(code).not.toBe(0);
      expect(output).toContain("EALLOWGIT");
      expect(lane.proxy.counts()).toEqual(before);
      expect(lane.connections()).toBe(0);
      expect(lane.dialled()).toBe(0);
    },
    60_000,
  );
});
