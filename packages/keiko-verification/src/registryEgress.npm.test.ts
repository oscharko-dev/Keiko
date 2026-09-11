// The proxy and the npm configuration confine the install only if npm honours them. This spawns the
// real npm with the install's own argv and egress configuration against manifests naming the two
// kinds of source a registry package can declare transitively, past every pre-install check: a
// tarball on a loopback address and a Git remote. npm must fail both installs without a single
// connection reaching the loopback listener (PR #3452 review, CWE-918).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEPENDENCY_APPROVED_REGISTRY, DEPENDENCY_INSTALL_ARGS } from "./dependencies.js";
import { registryEgressEnv, startRegistryEgressProxy } from "./registryEgress.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function recordingListener(): Promise<{ port: number; connections: () => number }> {
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return { port: address.port, connections: () => connections };
}

function npmInstall(root: string, dependency: string, env: NodeJS.ProcessEnv): Promise<number> {
  const workspace = mkdtempSync(join(root, "workspace-"));
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "egress-probe", version: "1.0.0", dependencies: { probe: dependency } }),
  );
  const child = spawn("npm", [...DEPENDENCY_INSTALL_ARGS], {
    cwd: workspace,
    env,
    stdio: "ignore",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? -1);
    });
  });
}

// npm is `npm.cmd` on Windows and cannot be spawned without a shell; the Linux and macOS lanes run it.
describe.skipIf(process.platform === "win32")("npm under the registry egress configuration", () => {
  it("fails a loopback tarball and a Git dependency without reaching either", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-registry-egress-"));
    cleanups.push(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const home = join(root, "home");
    mkdirSync(home);
    const listener = await recordingListener();
    let dialled = 0;
    const proxy = await startRegistryEgressProxy({
      registry: DEPENDENCY_APPROVED_REGISTRY,
      // Neither manifest needs the registry. A dial would mean npm went somewhere unexpected, and it
      // lands on the recording listener, so the assertions below catch it either way.
      connectUpstream: () => {
        dialled += 1;
        return connect({ host: "127.0.0.1", port: listener.port });
      },
    });
    cleanups.push(() => proxy.close());
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      npm_config_cache: join(root, "cache"),
      npm_config_update_notifier: "false",
      // A refused fetch is final; npm's default retries would only make this test slow.
      npm_config_fetch_retries: "0",
      ...registryEgressEnv(proxy.url, DEPENDENCY_APPROVED_REGISTRY),
    };
    const loopback = `127.0.0.1:${String(listener.port)}`;

    const tarball = await npmInstall(root, `http://${loopback}/probe.tgz`, env);
    const git = await npmInstall(root, `git+https://${loopback}/probe.git`, env);

    expect(tarball).not.toBe(0);
    expect(git).not.toBe(0);
    expect(listener.connections()).toBe(0);
    // The tarball request reached the proxy and was refused there; Git never reached it.
    expect(proxy.counts()).toEqual({ allowed: 0, refused: 1 });
    expect(dialled).toBe(0);
  }, 60_000);
});
