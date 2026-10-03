import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalDockerEndpointUnavailableError,
  resolveLocalDockerEndpoint,
} from "./local-docker-endpoint.js";

let parent: string;
let root: string;
let directory: string;
let socket: string;
let server: Server;

async function writeContext(name: string, host: string): Promise<void> {
  const key = createHash("sha256").update(name).digest("hex");
  const meta = join(directory, "contexts", "meta", key);
  await mkdir(meta, { recursive: true });
  await writeFile(
    join(meta, "meta.json"),
    JSON.stringify({ Endpoints: { docker: { Host: host } } }),
  );
}

describe.skipIf(process.platform === "win32")("resolveLocalDockerEndpoint Unix sockets", () => {
  beforeEach(async () => {
    parent = await realpath(await mkdtemp(join(tmpdir(), "keiko-local-docker-")));
    root = join(parent, "workspace");
    directory = join(parent, "docker");
    socket = join(parent, "engine.sock");
    await mkdir(root);
    await mkdir(directory);
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await rm(parent, { recursive: true, force: true });
  });

  it("projects only a canonical Unix socket from a selected context", async () => {
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        currentContext: "local",
        auths: { private: { auth: "credential-sentinel" } },
      }),
    );
    await writeContext("local", `unix://${socket}`);
    expect(resolveLocalDockerEndpoint({ DOCKER_CONFIG: directory }, root)).toEqual({
      kind: "available",
      host: `unix://${socket}`,
    });
  });

  it("gives DOCKER_CONTEXT precedence over DOCKER_HOST and the saved current context", async () => {
    await writeContext("local", `unix://${socket}`);
    const endpoint = resolveLocalDockerEndpoint(
      { DOCKER_CONFIG: directory, DOCKER_CONTEXT: "local", DOCKER_HOST: "tcp://remote:2375" },
      root,
    );
    expect(endpoint).toEqual({ kind: "available", host: `unix://${socket}` });
  });

  it("accepts a local DOCKER_HOST without reading credential configuration", () => {
    const endpoint = resolveLocalDockerEndpoint(
      { DOCKER_CONFIG: root, DOCKER_HOST: `unix://${socket}` },
      root,
    );
    expect(endpoint).toEqual({ kind: "available", host: `unix://${socket}` });
  });

  it.each(["tcp://remote:2375", "ssh://private-host", "npipe:////./pipe/docker_engine"])(
    "rejects unsupported endpoint %s without returning its address",
    (host) => {
      expect(resolveLocalDockerEndpoint({ DOCKER_HOST: host }, root)).toEqual({
        kind: "unavailable",
        reason: "docker-context-unsupported",
      });
    },
  );

  it("rejects an unsupported saved context", async () => {
    await writeContext("remote", "ssh://private-host");
    expect(
      resolveLocalDockerEndpoint({ DOCKER_CONFIG: directory, DOCKER_CONTEXT: "remote" }, root),
    ).toEqual({ kind: "unavailable", reason: "docker-context-unsupported" });
  });

  it("rejects configuration rooted in the untrusted workspace, including symlinks", async () => {
    await symlink(root, join(parent, "configuration-link"));
    expect(() =>
      resolveLocalDockerEndpoint({ DOCKER_CONFIG: join(parent, "configuration-link") }, root),
    ).toThrow(LocalDockerEndpointUnavailableError);
  });

  it("rejects a workspace socket alias and a regular file masquerading as a socket", async () => {
    await writeFile(join(parent, "regular-file"), "socket-sentinel");
    expect(() =>
      resolveLocalDockerEndpoint({ DOCKER_HOST: `unix://${join(parent, "regular-file")}` }, root),
    ).toThrow(LocalDockerEndpointUnavailableError);
    // A socket actually inside the execution root is controlled by repository code.
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    socket = join(root, "engine.sock");
    server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    expect(() => resolveLocalDockerEndpoint({ DOCKER_HOST: `unix://${socket}` }, root)).toThrow(
      LocalDockerEndpointUnavailableError,
    );
  });

  it.each(["not-json", "null", "x".repeat(65_537)])(
    "fails closed on malformed or oversized context metadata",
    async (contents) => {
      await writeFile(join(directory, "config.json"), contents);
      expect(() => resolveLocalDockerEndpoint({ DOCKER_CONFIG: directory }, root)).toThrow(
        new LocalDockerEndpointUnavailableError(),
      );
    },
  );
});

it.each(["tcp://remote:2375", "ssh://private-host"])(
  "rejects remote endpoint %s on every platform",
  (host) => {
    expect(resolveLocalDockerEndpoint({ DOCKER_HOST: host }, process.cwd())).toEqual({
      kind: "unavailable",
      reason: "docker-context-unsupported",
    });
  },
);

it("preserves only Docker's exact Windows local named-pipe fallback", () => {
  expect(resolveLocalDockerEndpoint({}, process.cwd(), "win32")).toEqual({
    kind: "available",
    host: "npipe:////./pipe/docker_engine",
  });
  expect(
    resolveLocalDockerEndpoint(
      { DOCKER_HOST: "npipe:////remote/pipe/docker_engine" },
      process.cwd(),
      "win32",
    ),
  ).toEqual({
    kind: "unavailable",
    reason: "docker-context-unsupported",
  });
});
