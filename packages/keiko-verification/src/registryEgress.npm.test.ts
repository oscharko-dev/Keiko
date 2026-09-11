// The proxy and the npm configuration confine the install only if npm honours them. This spawns the
// real npm with the install's own argv and egress configuration against manifests naming the kinds
// of source a registry package can declare transitively, past every pre-install check: a tarball on
// a loopback address and each Git form npm resolves. Every install must fail for its own reason
// (EALLOWGIT before git runs, E403 at the proxy) without one connection reaching the loopback
// listener (PR #3452 review, CWE-918).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Installs one dependency in a fresh workspace and returns npm's exit code and output.
async function npmInstall(
  lane: Lane,
  dependency: string,
): Promise<{ readonly code: number; readonly output: string }> {
  const workspace = mkdtempSync(join(lane.root, "workspace-"));
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "egress-probe", version: "1.0.0", dependencies: { probe: dependency } }),
  );
  const child = spawn("npm", [...DEPENDENCY_INSTALL_ARGS], {
    cwd: workspace,
    env: lane.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-65_536);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const [code] = (await once(child, "close")) as [number | null];
  return { code: code ?? -1, output };
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

  it("fails a loopback tarball at the proxy without reaching it", async () => {
    const before = lane.proxy.counts();

    const { code, output } = await npmInstall(lane, `http://${lane.loopback}/probe.tgz`);

    expect(code).not.toBe(0);
    expect(output).toMatch(/E403|403 Forbidden/u);
    expect(lane.proxy.counts()).toEqual({ allowed: before.allowed, refused: before.refused + 1 });
    expect(lane.connections()).toBe(0);
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
