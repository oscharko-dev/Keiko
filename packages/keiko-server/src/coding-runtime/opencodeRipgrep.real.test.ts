import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  nativeToolchainReadRoots,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import { buildSandboxEnv } from "@oscharko-dev/keiko-tools";
import { buildOpenCodeLaunchProfile, openCodeConfigDirectory } from "./opencodeLaunchProfile.js";
import {
  resolveOpenCodeRipgrep,
  ripgrepLaunchEnvironment,
  ripgrepNativePath,
  type OpenCodeRipgrepResolution,
} from "./opencodeRipgrepLaunch.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";
import { RIPGREP_RUNTIME_MANIFEST } from "./ripgrepRuntime.js";

/**
 * Original-runtime proof that the pinned OpenCode finds ripgrep OFFLINE and only where Keiko puts
 * it (#3897). The pinned executable runs under the real native Seatbelt wrapper with the profile
 * `buildOpenCodeLaunchProfile` produces and the child PATH and kernel read allowlist the
 * production launch derives (`resolveOpenCodeRipgrep`, `ripgrepLaunchEnvironment`,
 * `ripgrepNativePath`). Network is loopback-only, so any attempt to download ripgrep cannot
 * succeed, and the runtime's own cache directory is inspected afterwards. Needs the pinned
 * ripgrep provisioned (`npm run provision:ripgrep`) and, like the other real suites,
 * KEIKO_OPENCODE_REAL_BINARY and KEIKO_OPENCODE_REAL_RESOURCE_ROOT; without the latter two it is
 * skipped, and with them a missing provisioned ripgrep FAILS rather than hiding the gap.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");
const GATEWAY_CAPABILITY = "fixture-gateway-capability";
const FACADE_CAPABILITY = "fixture-facade-capability";
const NEEDLE = "needle-token-for-ripgrep";
const MAX_FIXTURE_BODY_BYTES = 4 * 1_024 * 1_024;

interface Recorded {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface Stub {
  readonly server: Server;
  port: number;
  readonly requests: Recorded[];
}

interface ScriptedCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface GatewayStub extends Stub {
  toolTurns: number;
  call: ScriptedCall;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_FIXTURE_BODY_BYTES) throw new Error("fixture-body-oversized");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A non-JSON body is recorded as text; the assertions only read JSON bodies.
    return text;
  }
}

async function startStub(
  respond: (stub: Stub, recorded: Recorded, response: ServerResponse) => void,
): Promise<Stub> {
  const requests: Recorded[] = [];
  const stub: { server?: Server; port: number; requests: Recorded[] } = { port: 0, requests };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void readRequestBody(request)
      .then((bytes) => {
        const recorded = {
          url: request.url ?? "",
          authorization: request.headers.authorization,
          body: parseJson(bytes.toString("utf8")),
        };
        requests.push(recorded);
        respond(stub as Stub, recorded, response);
      })
      .catch(() => response.writeHead(500).end());
  });
  stub.server = server;
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture-listener-invalid");
  stub.port = address.port;
  return stub as Stub;
}

async function closeStub(stub: Stub): Promise<void> {
  stub.server.closeAllConnections();
  await new Promise<void>((resolveClosed, reject) => {
    stub.server.close((error) => {
      if (error === undefined) resolveClosed();
      else reject(error);
    });
  });
}

function lastRole(body: unknown): unknown {
  const messages = object(body)?.messages;
  return Array.isArray(messages) ? object(messages.at(-1))?.role : undefined;
}

function streamedTurn(response: ServerResponse, delta: unknown, finish: string): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    frame({
      id: "ripgrep-real",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: null }],
    }),
  );
  response.end(
    frame({
      id: "ripgrep-real",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }) + "data: [DONE]\n\n",
  );
}

async function startGateway(): Promise<GatewayStub> {
  const stub = await startStub((self, recorded, response) => {
    const gateway = self as GatewayStub;
    if (gateway.toolTurns > 0 && lastRole(recorded.body) === "user") {
      gateway.toolTurns -= 1;
      const call = {
        index: 0,
        id: `call_ripgrep_${String(self.requests.length)}`,
        type: "function",
        function: { name: gateway.call.name, arguments: JSON.stringify(gateway.call.arguments) },
      };
      streamedTurn(response, { tool_calls: [call] }, "tool_calls");
      return;
    }
    streamedTurn(response, { content: "Fixture turn completed." }, "stop");
  });
  return Object.assign(stub, { toolTurns: 0, call: { name: "glob", arguments: {} } });
}

async function startFacade(): Promise<Stub> {
  return await startStub((_self, _recorded, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"effect":"allow"}');
  });
}

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-ripgrep-real-")));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, "README.md"), "ripgrep launch fixture\n");
  writeFileSync(join(workspace, "src", "notes.txt"), `alpha\n${NEEDLE} beta\n`);
  const git = resolveDarwinGitExecutable();
  const initialized = spawnSync(git.path, ["init", "-q", workspace], {
    env: {
      HOME: state,
      PATH: dirname(git.path),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (initialized.status !== 0) throw new Error("fixture-git-initialization-failed");
  return { root, workspace, state };
}

function materializePrivateConfiguration(state: string, config: string): void {
  const configRoot = join(state, "config", "opencode");
  for (const path of [
    join(configRoot, "plugins"),
    join(state, "home"),
    join(state, "state"),
    join(state, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(configRoot, "opencode.json"), config, { mode: 0o600 });
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native")))
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
}

/** `child-path` is production: the kernel opens what the child PATH names. The other is a control. */
type KernelAllowlist = "child-path" | "launcher-path-only";

interface Stubs {
  readonly gateway: Stub;
  readonly facade: Stub;
}

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** The launcher's own PATH: the toolchain a standalone shell would see, with no ripgrep on it. */
function launcherPath(): string {
  return [dirname(resolveDarwinGitExecutable().path), "/usr/bin", "/bin"].join(delimiter);
}

function launch(
  fixture: Fixture,
  binary: string,
  runtimeRoot: string,
  stubs: Stubs,
  resolution: OpenCodeRipgrepResolution,
  allowlist: KernelAllowlist,
): Launched {
  const profile = buildOpenCodeLaunchProfile({
    executable: binary,
    stateRoot: fixture.state,
    toolProfile: "native",
    contextGeometry: {
      contextWindowTokens: 32_768,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_096,
    },
  });
  if (!profile.ok) throw new Error("fixture-profile-invalid");
  materializePrivateConfiguration(fixture.state, profile.config);
  const git = resolveDarwinGitExecutable();
  const launcher = launcherPath();
  // The production derivation: the same PATH string feeds the child and the kernel allowlist.
  const inherited = ripgrepLaunchEnvironment({ PATH: launcher }, resolution, true);
  const childPath = buildSandboxEnv(inherited ?? {}, ["PATH"]).PATH;
  if (childPath === undefined) throw new Error("fixture-path-missing");
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
    runId: "run-ripgrep-real",
    treeBindingId: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    runtimeArtifactDigest: "c".repeat(64),
    modelProfileDigest: "d".repeat(64),
    profile: "keiko-native",
    filesystem: {
      workspaceRoot: fixture.workspace,
      workspaceAccess: "read-write",
      privateStateRoot: fixture.state,
      runtimeReadRoot: runtimeRoot,
      toolchainReadRoots: nativeToolchainReadRoots(
        allowlist === "child-path"
          ? (ripgrepNativePath(launcher, resolution) ?? launcher)
          : launcher,
        homedir(),
      ),
      protectedWriteRoots: [openCodeConfigDirectory(fixture.state)],
    },
  });
  const command = buildRuntimeGatewaySeatbeltCommand(policy, binary, profile.args, git.path);
  const password = profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("fixture-password-missing");
  const environment: Record<string, string> = {
    ...profile.env,
    PATH: childPath,
    KEIKO_MODEL_GATEWAY_URL: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
    KEIKO_MODEL_GATEWAY_CAPABILITY: GATEWAY_CAPABILITY,
    KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(stubs.facade.port)}/native-policy`,
    KEIKO_TOOL_FACADE_CAPABILITY: FACADE_CAPABILITY,
    KEIKO_CODING_RUN_ID: "run-ripgrep-real",
    KEIKO_CODING_MODE: "governed-assist",
  };
  return {
    password,
    environment,
    child: spawn(command.command, [...command.args], {
      cwd: fixture.workspace,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

async function childEndpoint(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<string> {
  return await new Promise<string>((resolveEndpoint, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("fixture-startup-timeout"));
    }, 20_000);
    const onData = (bytes: Buffer): void => {
      for (const line of bytes.toString("utf8").split("\n")) {
        const endpoint = parseOpenCodeV2ChildEndpoint(line + "\n");
        if (endpoint !== undefined) {
          clearTimeout(timeout);
          resolveEndpoint(endpoint);
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("fixture-startup-failed"));
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("fixture-child-exited"));
    });
  });
}

async function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    child.once("exit", () => {
      resolveExit();
    });
    child.kill("SIGKILL");
  });
}

/** What the runtime sent back to the model as the result of the scripted tool call. */
function lastToolResult(gateway: Stub): string {
  const messages = object(gateway.requests.at(-1)?.body)?.messages;
  if (!Array.isArray(messages)) return "";
  const result = messages
    .map(object)
    .filter((message) => message?.role === "tool")
    .at(-1);
  return typeof result?.content === "string" ? result.content : "";
}

interface Run {
  readonly fixture: Fixture;
  readonly gateway: GatewayStub;
  readonly client: OpenCodeV2HttpClient;
  readonly sessionId: string;
}

async function scriptedTurn(run: Run, call: ScriptedCall): Promise<string> {
  const before = run.gateway.requests.length;
  run.gateway.call = call;
  run.gateway.toolTurns = 1;
  await run.client.prompt(run.sessionId, "Run the scripted search.");
  await expect
    .poll(() => run.gateway.requests.length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before + 2);
  return lastToolResult(run.gateway);
}

/** The pinned ripgrep, verified exactly as the production launch verifies it. */
function provisionedResolution(): OpenCodeRipgrepResolution {
  const resolution = resolveOpenCodeRipgrep({
    target: "macos-arm64",
    location: { kind: "checkout", checkoutRoot: REPOSITORY_ROOT },
    env: {},
  });
  if (resolution.outcome !== "verified")
    throw new Error(
      `fixture-ripgrep-not-provisioned:${resolution.reason}; run npm run provision:ripgrep`,
    );
  return resolution;
}

/** A tampered copy at the provisioned location of a throwaway checkout: never verified. */
function tamperedResolution(root: string): OpenCodeRipgrepResolution {
  const directory = join(root, ".ripgrep", RIPGREP_RUNTIME_MANIFEST.version, "darwin-arm64");
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  writeFileSync(join(directory, "rg"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const resolution = resolveOpenCodeRipgrep({
    target: "macos-arm64",
    location: { kind: "checkout", checkoutRoot: root },
    env: {},
  });
  if (resolution.outcome !== "unverified") throw new Error("fixture-tampered-ripgrep-verified");
  return resolution;
}

async function withRun(
  resolution: () => OpenCodeRipgrepResolution,
  body: (run: Run, launched: Launched) => Promise<void>,
  allowlist: KernelAllowlist = "child-path",
): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const fixture = createFixture();
  const stubs = { gateway: await startGateway(), facade: await startFacade() };
  const launched = launch(
    fixture,
    realpathSync(BINARY),
    realpathSync(RESOURCE_ROOT),
    stubs,
    resolution(),
    allowlist,
  );
  try {
    const endpoint = await childEndpoint(launched.child);
    const client = createOpenCodeV2HttpClient({ endpoint, password: launched.password });
    expect((await client.info()).version).toBe(OPENCODE_PINNED_VERSION);
    const session = await client.createSession(fixture.workspace);
    if (typeof session.id !== "string") throw new Error("fixture-session-invalid");
    await body({ fixture, gateway: stubs.gateway, client, sessionId: session.id }, launched);
  } finally {
    await stopChild(launched.child);
    await Promise.all([closeStub(stubs.gateway), closeStub(stubs.facade)]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

/**
 * What sits in the runtime's own binary cache, the one place it downloads ripgrep to when it finds
 * none. The runtime creates the directory itself; a download would leave an executable in it.
 */
function downloadedBinaries(fixture: Fixture): readonly string[] {
  const cache = join(fixture.state, "home", ".cache", "opencode", "bin");
  return existsSync(cache) ? readdirSync(cache) : [];
}

describe("pinned native OpenCode and the verified ripgrep", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "finds files and text with no network and ripgrep only from the verified directory",
    async () => {
      const resolution = provisionedResolution();
      await withRun(
        () => resolution,
        async (run, launched) => {
          const directory = resolution.outcome === "verified" ? resolution.directory : "";
          // The child sees the verified directory first and no other ripgrep anywhere on its PATH.
          const entries = (launched.environment.PATH ?? "").split(delimiter);
          expect(entries[0]).toBe(directory);
          for (const entry of entries.slice(1)) expect(existsSync(join(entry, "rg"))).toBe(false);

          const files = await scriptedTurn(run, { name: "glob", arguments: { pattern: "*.md" } });
          expect(files.split("\n").some((line) => line.trim().endsWith("README.md"))).toBe(true);

          const text = await scriptedTurn(run, { name: "grep", arguments: { pattern: NEEDLE } });
          expect(text).toContain("notes.txt");
          expect(text).toContain(NEEDLE);

          // Resolved through PATH, never fetched: the runtime's own download target stays empty.
          expect(downloadedBinaries(run.fixture)).toEqual([]);
        },
      );
    },
    180_000,
  );

  it.skipIf(skip)(
    "control: without a verified ripgrep the run starts, search degrades and nothing is downloaded",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-ripgrep-real-checkout-")));
      try {
        const resolution = tamperedResolution(root);
        expect(resolution).toMatchObject({ outcome: "unverified", reason: "digest-mismatch" });
        await withRun(
          () => resolution,
          async (run, launched) => {
            // Nothing was put in front of the launcher's PATH.
            expect(launched.environment.PATH).toBe(launcherPath());

            const files = await scriptedTurn(run, { name: "glob", arguments: { pattern: "*.md" } });
            expect(files.split("\n").some((line) => line.trim().endsWith("README.md"))).toBe(false);
            expect(downloadedBinaries(run.fixture)).toEqual([]);
          },
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );

  // Not production: the same verified directory on the child PATH, but the kernel read allowlist
  // derived from the launcher PATH alone. The kernel then refuses to run it, which is why the
  // production launch derives the allowlist from the very PATH the child receives.
  it.skipIf(skip)(
    "control: a verified directory on the PATH that the kernel does not open is still unusable",
    async () => {
      const resolution = provisionedResolution();
      await withRun(
        () => resolution,
        async (run) => {
          const files = await scriptedTurn(run, { name: "glob", arguments: { pattern: "*.md" } });
          expect(files.split("\n").some((line) => line.trim().endsWith("README.md"))).toBe(false);
        },
        "launcher-path-only",
      );
    },
    180_000,
  );
});
