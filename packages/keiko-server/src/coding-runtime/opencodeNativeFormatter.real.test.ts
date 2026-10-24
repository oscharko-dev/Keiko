import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  nativeToolchainReadRoots,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import { buildOpenCodeLaunchProfile, openCodeConfigDirectory } from "./opencodeLaunchProfile.js";
import { openCodeNativeEgress } from "./opencodeNativeEgress.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";

/**
 * Original-runtime proof for the built-in formatter governance (#3897, parity row C07). The pinned
 * 2.1.4 producer runs a built-in formatter after its own `edit` and `write` tools as a plain child
 * process, consulting no permission, and runs none unless the configuration says `formatter: true`.
 * Keiko therefore sets the setting explicitly per launch mode (`openCodeNativeFormatterDisposition`).
 * The pinned executable runs under the real native Seatbelt wrapper with the profile
 * `buildOpenCodeLaunchProfile` produces. The formatter is the producer's `gofmt` built-in, which
 * needs only an executable of that name on the launcher's PATH, so a stand-in keeps the proof
 * hermetic; a repository that ships the real prettier is the control for the package-manager
 * formatters. Run with KEIKO_OPENCODE_REAL_BINARY and KEIKO_OPENCODE_REAL_RESOURCE_ROOT set;
 * otherwise it is skipped.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const GATEWAY_CAPABILITY = "fixture-gateway-capability";
const FACADE_CAPABILITY = "fixture-facade-capability";
const MAX_FIXTURE_BODY_BYTES = 4 * 1_024 * 1_024;

// The fixture `gofmt` collapses runs of spaces; prettier would also add the semicolon and braces.
const MIS_FORMATTED = "package   main\n";
const FORMATTED = "package main\n";
const EDIT_FORMATTED = "package renamed pkg\n";
const MIS_FORMATTED_JS = "const answer   =   {value:42}\n";
const FORMATTED_JS = "const answer = { value: 42 };\n";

interface Recorded {
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

type Mode = "governed-assist" | "supervised-coding" | "autonomous-delivery";

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
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
        const recorded = { body: parseJson(bytes.toString("utf8")) };
        requests.push(recorded);
        respond(stub as Stub, recorded, response);
      })
      .catch(() => response.writeHead(500).end());
  });
  stub.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture-listener-invalid");
  stub.port = address.port;
  return stub as Stub;
}

async function closeStub(stub: Stub): Promise<void> {
  stub.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    stub.server.close((error) => {
      if (error === undefined) resolve();
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
  const chunk = (payload: unknown, reason: string | null): string =>
    frame({
      id: "native-formatter",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: payload, finish_reason: reason }],
    });
  response.write(chunk(delta, null));
  response.end(
    frame({
      id: "native-formatter",
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
        id: `call_formatter_${String(self.requests.length)}`,
        type: "function",
        function: { name: gateway.call.name, arguments: JSON.stringify(gateway.call.arguments) },
      };
      streamedTurn(response, { tool_calls: [call] }, "tool_calls");
      return;
    }
    streamedTurn(response, { content: "Fixture turn completed." }, "stop");
  });
  const call: ScriptedCall = { name: "read", arguments: {} };
  return Object.assign(stub, { toolTurns: 0, call });
}

/** Allows every action the generated policy plugin asks about, as Full access would. */
async function startFacade(): Promise<Stub> {
  return await startStub((_self, _recorded, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"effect":"allow"}');
  });
}

/**
 * The host toolchain directory of the fixture launcher: a `gofmt` that collapses runs of spaces in
 * the file it is given, standing in for the host's real formatter so the proof is hermetic. The
 * producer's `gofmt` built-in needs nothing but an executable of that name on the launcher's PATH
 * (`gofmt -w $FILE`), which is how every PATH-resolved built-in finds its tool.
 */
function writeHostToolchain(state: string): string {
  const bin = join(state, "toolchain", "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(bin, "gofmt"),
    [
      "#!/bin/sh",
      '[ "$1" = "-w" ] || exit 2',
      'tmp="$2.gofmt.$$"',
      '/usr/bin/sed -e "s/  */ /g" "$2" > "$tmp" && /bin/mv "$tmp" "$2"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

/**
 * A repository that ships its own prettier: the package declares the dependency (the producer's
 * detection rule for it) and `node_modules/.bin/prettier` is the real executable from this checkout.
 */
function installRepositoryPrettier(workspace: string): void {
  mkdirSync(join(workspace, "node_modules", ".bin"), { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({
      name: "formatter-fixture",
      private: true,
      devDependencies: { prettier: "*" },
    }),
  );
  const prettier = dirname(createRequire(import.meta.url).resolve("prettier/package.json"));
  cpSync(prettier, join(workspace, "node_modules", "prettier"), { recursive: true });
  symlinkSync("../prettier/bin/prettier.cjs", join(workspace, "node_modules", ".bin", "prettier"));
}

function createFixture(prettier: boolean): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-formatter-")));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (prettier) installRepositoryPrettier(workspace);
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

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
}

interface LaunchOptions {
  readonly mode: Mode;
  /** Narrows the kernel egress below the mode's own, so a fixture never reaches a registry. */
  readonly egress?: "loopback-only";
  /** The repository ships its own prettier (the control for the package-manager formatters). */
  readonly repositoryPrettier?: true;
  /** `absent` is the control: the binding says nothing about formatters, so the producer decides. */
  readonly formatterKey: "bound" | "absent";
}

/** The production profile for a mode, optionally without the formatter key (the control only). */
function profileFor(
  fixture: Fixture,
  binary: string,
  options: LaunchOptions,
): { readonly config: string; readonly env: Record<string, string>; readonly args: string[] } {
  const profile = buildOpenCodeLaunchProfile({
    executable: binary,
    stateRoot: fixture.state,
    toolProfile: "native",
    mode: options.mode,
    contextGeometry: {
      contextWindowTokens: 32_768,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_096,
    },
  });
  if (!profile.ok) throw new Error("fixture-profile-invalid");
  const strip = (json: string): string => {
    const value = JSON.parse(json) as Record<string, unknown>;
    delete value.formatter;
    return JSON.stringify(value);
  };
  if (options.formatterKey === "bound")
    return { config: profile.config, env: { ...profile.env }, args: [...profile.args] };
  return {
    config: strip(profile.config),
    env: {
      ...profile.env,
      OPENCODE_CONFIG_CONTENT: strip(profile.env.OPENCODE_CONFIG_CONTENT ?? ""),
    },
    args: [...profile.args],
  };
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

function launch(
  fixture: Fixture,
  binary: string,
  runtimeRoot: string,
  stubs: { readonly gateway: Stub; readonly facade: Stub },
  options: LaunchOptions,
): Launched {
  const profile = profileFor(fixture, binary, options);
  materializePrivateConfiguration(fixture.state, profile.config);
  const git = resolveDarwinGitExecutable();
  // The production derivation: the launcher's PATH feeds the child and the kernel read allowlist.
  // It carries the host toolchain and the interpreter running this suite, which a repository's
  // prettier would need if the producer ever ran it.
  const toolchain = writeHostToolchain(fixture.state);
  const path = `${toolchain}:${dirname(process.execPath)}:${dirname(git.path)}:/usr/bin:/bin`;
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
    runId: "run-native-formatter",
    treeBindingId: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    runtimeArtifactDigest: "c".repeat(64),
    modelProfileDigest: "d".repeat(64),
    profile: "keiko-native",
    egress: options.egress ?? openCodeNativeEgress(options.mode),
    filesystem: {
      workspaceRoot: fixture.workspace,
      workspaceAccess: "read-write",
      privateStateRoot: fixture.state,
      runtimeReadRoot: runtimeRoot,
      toolchainReadRoots: nativeToolchainReadRoots(path, homedir()),
      protectedWriteRoots: [openCodeConfigDirectory(fixture.state)],
    },
  });
  const command = buildRuntimeGatewaySeatbeltCommand(policy, binary, profile.args, git.path);
  const password = profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("fixture-password-missing");
  return {
    password,
    child: spawn(command.command, [...command.args], {
      cwd: fixture.workspace,
      env: {
        ...profile.env,
        PATH: path,
        KEIKO_MODEL_GATEWAY_URL: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
        KEIKO_MODEL_GATEWAY_CAPABILITY: GATEWAY_CAPABILITY,
        KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(stubs.facade.port)}/native-policy`,
        KEIKO_TOOL_FACADE_CAPABILITY: FACADE_CAPABILITY,
        KEIKO_CODING_RUN_ID: "run-native-formatter",
        KEIKO_CODING_MODE: options.mode,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

async function childEndpoint(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("fixture-startup-timeout"));
    }, 20_000);
    const onData = (bytes: Buffer): void => {
      for (const line of bytes.toString("utf8").split("\n")) {
        const endpoint = parseOpenCodeV2ChildEndpoint(line + "\n");
        if (endpoint !== undefined) {
          clearTimeout(timeout);
          resolve(endpoint);
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
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGKILL");
  });
}

interface Run {
  readonly fixture: Fixture;
  readonly gateway: GatewayStub;
  readonly facade: Stub;
  readonly client: OpenCodeV2HttpClient;
  readonly sessionId: string;
}

async function withRun(options: LaunchOptions, body: (run: Run) => Promise<void>): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const fixture = createFixture(options.repositoryPrettier === true);
  const [gateway, facade] = [await startGateway(), await startFacade()];
  const launched = launch(
    fixture,
    realpathSync(BINARY),
    realpathSync(RESOURCE_ROOT),
    { gateway, facade },
    options,
  );
  try {
    const client = createOpenCodeV2HttpClient({
      endpoint: await childEndpoint(launched.child),
      password: launched.password,
    });
    expect((await client.info()).version).toBe(OPENCODE_PINNED_VERSION);
    const session = await client.createSession(fixture.workspace);
    if (typeof session.id !== "string") throw new Error("fixture-session-invalid");
    await body({ fixture, gateway, facade, client, sessionId: session.id });
  } finally {
    await stopChild(launched.child);
    await Promise.all([closeStub(gateway), closeStub(facade)]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

/** Runs one scripted native tool call and waits for the follow-up request that carries its result. */
async function scriptedTurn(run: Run, call: ScriptedCall): Promise<void> {
  const before = run.gateway.requests.length;
  run.gateway.call = call;
  run.gateway.toolTurns = 1;
  await run.client.prompt(run.sessionId, "Run the scripted call.");
  await expect
    .poll(() => run.gateway.requests.length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before + 2);
}

function read(run: Run, name: string): string {
  return readFileSync(join(run.fixture.workspace, name), "utf8");
}

/** Every permission the generated policy plugin asked the server-owned policy about, in order. */
function askedPermissions(run: Run): readonly unknown[] {
  return run.facade.requests.map((recorded) => object(recorded.body)?.permission);
}

function writeCall(name: string, content: string): ScriptedCall {
  return { name: "write", arguments: { path: name, content } };
}

function editCall(name: string, oldString: string, newString: string): ScriptedCall {
  return { name: "edit", arguments: { path: name, oldString, newString } };
}

describe("pinned native OpenCode built-in formatter governance", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "Full access: runs the PATH-resolved built-in after a native write and a native edit, asking no permission for it",
    async () => {
      await withRun({ mode: "autonomous-delivery", formatterKey: "bound" }, async (run) => {
        await scriptedTurn(run, writeCall("main.go", MIS_FORMATTED));
        expect(read(run, "main.go")).toBe(FORMATTED);
        await scriptedTurn(run, editCall("main.go", "main", "renamed   pkg"));
        expect(read(run, "main.go")).toBe(EDIT_FORMATTED);
        // The hook was asked about the edits and nothing else: the formatter is a plain child
        // process of the runtime that no permission sees, which is why the mode must decide.
        expect(new Set(askedPermissions(run))).toEqual(new Set(["edit"]));
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "Ask for approval and Supervised workspace: the same write and edit land verbatim, no formatter runs",
    async () => {
      for (const mode of ["governed-assist", "supervised-coding"] as const) {
        await withRun({ mode, formatterKey: "bound" }, async (run) => {
          await scriptedTurn(run, writeCall("main.go", MIS_FORMATTED));
          expect(read(run, "main.go")).toBe(MIS_FORMATTED);
          await scriptedTurn(run, editCall("main.go", "main", "renamed   pkg"));
          expect(read(run, "main.go")).toBe("package   renamed   pkg\n");
        });
      }
    },
    240_000,
  );

  // The control shows the producer's own default, and that the binding is what turns it on: without
  // the key even a Full access tree runs no formatter, so the positive proof above cannot be an
  // accident of the fixture, and the negative proof cannot be a fixture that never formats.
  it.skipIf(skip)(
    "control: without the formatter setting the producer runs no formatter, even in Full access",
    async () => {
      await withRun({ mode: "autonomous-delivery", formatterKey: "absent" }, async (run) => {
        await scriptedTurn(run, writeCall("main.go", MIS_FORMATTED));
        expect(read(run, "main.go")).toBe(MIS_FORMATTED);
      });
    },
    120_000,
  );

  // The producer resolves prettier (like oxfmt and biome) through its own package manager and
  // package cache, not through the repository's `node_modules/.bin`, and Keiko keeps that package
  // manager offline. With the formatter enabled and the real prettier installed in the repository,
  // the file is therefore left alone: a repository's own executable is never what a built-in
  // formatter runs. This pins that fact; if a producer release changed it, a repository could run
  // code without any permission, and the mode rule above would no longer be enough.
  it.skipIf(skip)(
    "control: a repository's own prettier is never run, even with the formatter enabled",
    async () => {
      const options = {
        mode: "autonomous-delivery",
        formatterKey: "bound",
        egress: "loopback-only",
        repositoryPrettier: true,
      } as const;
      await withRun(options, async (run) => {
        await scriptedTurn(run, writeCall("module.js", MIS_FORMATTED_JS));
        expect(read(run, "module.js")).toBe(MIS_FORMATTED_JS);
        // The positive control: the repository's prettier works, so it was left unused.
        const prettier = join(run.fixture.workspace, "node_modules", ".bin", "prettier");
        const file = join(run.fixture.workspace, "module.js");
        expect(spawnSync(process.execPath, [prettier, "--write", file]).status).toBe(0);
        expect(read(run, "module.js")).toBe(FORMATTED_JS);
      });
    },
    120_000,
  );
});
