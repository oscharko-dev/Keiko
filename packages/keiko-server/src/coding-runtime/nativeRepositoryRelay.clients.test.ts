import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCspHeader } from "../csp.js";
import { buildRedactor, createInMemoryUiStore, createRunRegistry } from "../index.js";
import {
  createRepositoryCredentialRelay,
  REPOSITORY_RELAY_PATH_PREFIX,
  type RepositoryCredentialRelay,
} from "../repository-relay/repositoryCredentialRelay.js";
import { createUiServer, UI_HOST } from "../server.js";
import {
  FUNCTIONAL_MAVEN_PASSWORD,
  mavenSettingsXml,
  startFunctionalMavenRepository,
  writeMavenPersonSettings,
  type FunctionalMavenRepository,
} from "../test-support/functional-maven-repository.js";
import {
  startFunctionalNpmRegistry,
  type FunctionalNpmRegistry,
} from "../test-support/functional-npm-registry.js";
import { javaToolOptions } from "./javaToolOptions.js";
import { prepareNativeBuildSettings } from "./nativeBuildSettings.js";

// #4522: the REAL Maven and the REAL npm against Keiko's repository credential relay, with exactly
// the settings the run binding writes. The upstream repositories answer only to the person's own
// login, which no file of the run carries; the run holds a capability. Needs Maven, a JDK and the
// provisioned acceptance cache (`npm run provision:acceptance-maven`), so it is opt-in:
//
//   KEIKO_REPOSITORY_RELAY_REAL_CLIENTS=1 npx vitest run \
//     packages/keiko-server/src/coding-runtime/nativeRepositoryRelay.clients.test.ts
//
// A missing client fails the suite when it is enabled; it never skips quietly. Maven 3.9 (resolver
// 1.9) and 3.10 (resolver 2) read different preemptive-auth properties (#4530 item 4): put the Maven
// to prove first on PATH and name it in KEIKO_REPOSITORY_RELAY_MAVEN_VERSION (`3.9`, `3.10`), so a
// run meant for one version fails on another instead of passing.
const ENABLED = process.env.KEIKO_REPOSITORY_RELAY_REAL_CLIENTS === "1";
const EXPECTED_MAVEN_VERSION = process.env.KEIKO_REPOSITORY_RELAY_MAVEN_VERSION;
const MAVEN_PROJECT = fileURLToPath(
  new URL(
    "../../../../tests/fixtures/coding-acceptance/maven-internal-repository",
    import.meta.url,
  ),
);
const NPM_TOKEN = "npm-registry-token-PLANTED-5521";
// Scoped, and the scope names the default registry's URL, as one Nexus group for everything does.
const NPM_PACKAGE = "@keiko-relay/fixture-pkg";
const NPM_TARBALL = `${NPM_PACKAGE}/-/fixture-pkg-1.0.0.tgz`;
const RUN_ID = "run-clients-1";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];

function temp(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-relay-clients-")));
  roots.push(root);
  return root;
}

function listen(server: Server, port = 0): Promise<number> {
  closers.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  );
  return new Promise((resolve) => {
    server.listen(port, UI_HOST, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

interface RelayServer {
  readonly origin: string;
  readonly relay: RepositoryCredentialRelay;
  /** Every request Keiko's server received, before any routing. */
  readonly received: Seen[];
  /** The status of every answer Keiko's server gave, in order. */
  readonly answered: number[];
}

/** The real server (router, host check, request log) with the relay mounted, as the run reaches it. */
async function startRelayServer(root: string): Promise<RelayServer> {
  const staticRoot = join(root, "static");
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<html></html>");
  const relay = createRepositoryCredentialRelay({ activityLog: () => undefined });
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((done) => {
    probe.close(() => {
      done();
    });
  });
  const server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      store: createInMemoryUiStore(),
      repositoryRelay: {
        relay,
        upstream: (url, init): Promise<Response> =>
          fetch(url, {
            method: init.method,
            headers: init.headers,
            redirect: "manual",
            signal: init.signal,
          }),
      },
    },
    activityLog: { write: () => undefined },
  });
  const received: Seen[] = [];
  const answered: number[] = [];
  server.prependListener("request", (request: IncomingMessage, response: ServerResponse) => {
    response.once("finish", () => {
      answered.push(response.statusCode);
    });
    received.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
    });
  });
  await listen(server, port);
  return { origin: `http://${UI_HOST}:${String(port)}`, relay, received, answered };
}

interface Scene {
  readonly maven: FunctionalMavenRepository;
  readonly npm: FunctionalNpmRegistry;
  readonly server: RelayServer;
  readonly prepared: ReturnType<typeof prepareNativeBuildSettings>;
  readonly stateRoot: string;
  readonly home: string;
  readonly root: string;
}

let scene: Scene;

beforeAll(async () => {
  if (!ENABLED) return;
  const root = temp();
  const maven = await startFunctionalMavenRepository();
  closers.push(maven.close);
  // Served under a Nexus-style group path, as an internal registry usually is (#4491).
  const npm = await startFunctionalNpmRegistry({
    packageName: NPM_PACKAGE,
    token: NPM_TOKEN,
    basePath: "/repository/npm-group",
  });
  closers.push(npm.close);
  const server = await startRelayServer(root);
  const personHome = join(root, "person-home");
  writeMavenPersonSettings(personHome, mavenSettingsXml({ url: maven.url }));
  writeFileSync(
    join(personHome, ".npmrc"),
    `registry=${npm.url}/\n@keiko-relay:registry=${npm.url}/\n//${new URL(npm.url).host}/repository/npm-group/:_authToken=${NPM_TOKEN}\n`,
  );
  const stateRoot = join(root, "run");
  mkdirSync(stateRoot, { recursive: true });
  const prepared = prepareNativeBuildSettings({
    runId: RUN_ID,
    mode: "supervised-coding",
    realHome: personHome,
    stateRoot,
    repositoryRelay: { relay: server.relay, origin: server.origin, env: {} },
    activityLog: { write: () => undefined },
  });
  scene = { maven, npm, server, prepared, stateRoot, home: join(stateRoot, "home"), root };
}, 120_000);

afterAll(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runEnvironment(): Record<string, string> {
  const { prepared, home, root } = scene;
  const globalConfig = join(root, "global-npmrc");
  writeFileSync(globalConfig, "");
  return {
    PATH: process.env.PATH ?? "",
    ...(process.env.JAVA_HOME === undefined ? {} : { JAVA_HOME: process.env.JAVA_HOME }),
    HOME: home,
    ...prepared.env,
    JAVA_TOOL_OPTIONS: javaToolOptions(undefined, {
      "java.io.tmpdir": join(scene.stateRoot, "tmp"),
      ...prepared.javaProperties,
    }),
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: join(home, ".npm-cache"),
    // No NPM_CONFIG_UPDATE_NOTIFIER: the run's own npm config switches the update check off (#4491).
  };
}

interface Finished {
  readonly status: number | null;
  readonly output: string;
}

/**
 * The client runs asynchronously: the relay answers it from this very process, which a synchronous
 * spawn would block until the client gave up.
 */
function runClient(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: runEnvironment(), timeout: timeoutMs });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({ status, output });
    });
  });
}

async function mavenVersion(project: string): Promise<string> {
  const result = await runClient("mvn", ["-v"], project, 60_000);
  return /Apache Maven (\d+\.\d+\.\d+)/u.exec(result.output)?.[1] ?? "unknown";
}

function isExpectedMaven(version: string): boolean {
  if (EXPECTED_MAVEN_VERSION === undefined) return true;
  return version === EXPECTED_MAVEN_VERSION || version.startsWith(`${EXPECTED_MAVEN_VERSION}.`);
}

function mavenBuild(project: string): Promise<Finished> {
  return runClient("mvn", ["-B", "-q", "test-compile"], project, 170_000);
}

function npmInstall(project: string): Promise<Finished> {
  return runClient("npm", ["install", "--ignore-scripts", "--no-fund"], project, 120_000);
}

function npmCi(project: string): Promise<Finished> {
  return runClient("npm", ["ci", "--ignore-scripts", "--no-fund"], project, 120_000);
}

/** The tarball's integrity as the registry states it, read with the person's own token. */
async function registryIntegrity(): Promise<string> {
  const response = await fetch(`${scene.npm.url}/${NPM_PACKAGE}`, {
    headers: { authorization: `Bearer ${NPM_TOKEN}` },
  });
  const packument = (await response.json()) as {
    versions: Record<string, { dist: { integrity: string } }>;
  };
  return packument.versions["1.0.0"]?.dist.integrity ?? "";
}

/** A project whose lockfile pins the tarball on the registry's own URL, as `npm install` wrote it. */
async function lockedProject(): Promise<string> {
  const project = join(temp(), "npm-locked-project");
  mkdirSync(project, { recursive: true });
  const dependencies = { [NPM_PACKAGE]: "1.0.0" };
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "consumer", version: "1.0.0", dependencies }),
  );
  const lock = {
    name: "consumer",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "consumer", version: "1.0.0", dependencies },
      [`node_modules/${NPM_PACKAGE}`]: {
        version: "1.0.0",
        resolved: `${scene.npm.url}/${NPM_TARBALL}`,
        integrity: await registryIntegrity(),
      },
    },
  };
  writeFileSync(join(project, "package-lock.json"), JSON.stringify(lock, null, 2));
  return project;
}

function relayRequests(received: readonly Seen[]): Seen[] {
  return received.filter((request) => request.url.startsWith(REPOSITORY_RELAY_PATH_PREFIX));
}

function basicPassword(authorization: string | undefined): string | undefined {
  if (authorization?.startsWith("Basic ") !== true) return undefined;
  return Buffer.from(authorization.slice(6), "base64")
    .toString("utf8")
    .split(":")
    .slice(1)
    .join(":");
}

describe.skipIf(!ENABLED)("the real Maven and npm against the repository relay (#4522)", () => {
  it("builds a Maven project whose parent POM and plugins only the credentialed repository serves", async () => {
    const project = join(temp(), "project");
    cpSync(MAVEN_PROJECT, project, { recursive: true });
    const version = await mavenVersion(project);
    expect(isExpectedMaven(version), `mvn on PATH is ${version}`).toBe(true);
    const before = scene.server.received.length;
    const result = await mavenBuild(project);
    expect(result.status, result.output).toBe(0);
    const requests = relayRequests(scene.server.received.slice(before));
    expect(requests.length).toBeGreaterThan(5);
    // Everything Maven fetched came through the relay, which is the only holder of the login: a
    // request that bypassed it would have been answered 401 by the repository.
    expect(scene.server.received.slice(before)).toHaveLength(requests.length);
    // The clients' own parallelism stays below the relay's concurrency caps: never a `relay-busy`.
    expect(scene.server.answered.filter((status) => status === 503 || status === 429)).toEqual([]);
    expect(scene.maven.statusCounts()["401"]).toBeUndefined();
    expect(scene.maven.statusCounts()["200"]).toBeGreaterThan(5);
    // Preemptive authentication: the very first request already carries the capability, and no
    // request of the build was ever sent without one.
    expect(requests[0]?.authorization).toMatch(/^Basic /u);
    expect(requests.every((request) => request.authorization !== undefined)).toBe(true);
    for (const request of requests) {
      expect(basicPassword(request.authorization)).not.toBe(FUNCTIONAL_MAVEN_PASSWORD);
    }
  }, 180_000);

  it("installs an npm package from a registry that answers only to the person's token", async () => {
    const project = join(temp(), "npm-project");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({
        name: "consumer",
        version: "1.0.0",
        dependencies: { [NPM_PACKAGE]: "1.0.0" },
      }),
    );
    const before = scene.server.received.length;
    const result = await npmInstall(project);
    expect(result.status, result.output).toBe(0);
    expect(existsSync(join(project, "node_modules", NPM_PACKAGE, "index.js"))).toBe(true);
    const requests = relayRequests(scene.server.received.slice(before));
    expect(scene.server.received.slice(before)).toHaveLength(requests.length);
    expect(requests.map((request) => request.method).sort()).toEqual(["GET", "GET"]);
    expect(requests.every((request) => request.authorization?.startsWith("Bearer ") === true)).toBe(
      true,
    );
    expect(requests.some((request) => request.authorization?.includes(NPM_TOKEN))).toBe(false);
    expect(scene.npm.seen.every((request) => request.authorization === `Bearer ${NPM_TOKEN}`)).toBe(
      true,
    );
    expect(scene.npm.seen.every((request) => request.method === "GET")).toBe(true);
    // #4491: the scope's packument came through the scope's binding, and npm moved its tarball onto
    // the default registry's binding, under the registry's own path.
    expect(requests[1]?.url).toMatch(/\/repository\/npm-group\/@keiko-relay\/fixture-pkg\/-\//u);
    // The lockfile pins the person's registry, as their own npm writes it, never the relay's
    // address, which lasts one run: a later run, a colleague and CI install from it unchanged.
    const lock = JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8")) as {
      packages: Record<string, { resolved?: string }>;
    };
    expect(lock.packages[`node_modules/${NPM_PACKAGE}`]?.resolved).toBe(
      `${scene.npm.url}/${NPM_TARBALL}`,
    );
  }, 150_000);

  // #4491: a lockfile pins each tarball on the registry's own URL. Without the run's
  // `replace-registry-host`, npm fetched it from there directly, without the person's token.
  it("installs from a lockfile that pins its tarball on the registry's own URL", async () => {
    const project = await lockedProject();
    rmSync(join(scene.home, ".npm-cache"), { recursive: true, force: true });
    const seenBefore = scene.npm.seen.length;
    const before = scene.server.received.length;
    const result = await npmCi(project);
    expect(result.status, result.output).toBe(0);
    expect(existsSync(join(project, "node_modules", NPM_PACKAGE, "index.js"))).toBe(true);
    const requests = relayRequests(scene.server.received.slice(before));
    expect(requests.map((request) => request.url)).toEqual([
      expect.stringMatching(
        /\/repository\/npm-group\/@keiko-relay\/fixture-pkg\/-\/[\w.-]+\.tgz$/u,
      ),
    ]);
    const upstream = scene.npm.seen.slice(seenBefore);
    expect(upstream.map((request) => request.url)).toEqual([
      `/repository/npm-group/${NPM_TARBALL}`,
    ]);
    expect(upstream.every((request) => request.authorization === `Bearer ${NPM_TOKEN}`)).toBe(true);
  }, 150_000);

  it("fails both builds once the run's relay bindings are released", async () => {
    scene.server.relay.releaseRun(RUN_ID);
    rmSync(join(scene.home, ".m2", "repository"), { recursive: true, force: true });
    rmSync(join(scene.home, ".npm-cache"), { recursive: true, force: true });
    const mavenProject = join(temp(), "project");
    cpSync(MAVEN_PROJECT, mavenProject, { recursive: true });
    const maven = await mavenBuild(mavenProject);
    expect(maven.status).not.toBe(0);
    const npmProject = join(temp(), "npm-project");
    mkdirSync(npmProject, { recursive: true });
    writeFileSync(
      join(npmProject, "package.json"),
      JSON.stringify({
        name: "consumer",
        version: "1.0.0",
        dependencies: { [NPM_PACKAGE]: "1.0.0" },
      }),
    );
    const npm = await npmInstall(npmProject);
    expect(npm.status).not.toBe(0);
    expect(existsSync(join(npmProject, "node_modules", NPM_PACKAGE))).toBe(false);
  }, 200_000);
});
