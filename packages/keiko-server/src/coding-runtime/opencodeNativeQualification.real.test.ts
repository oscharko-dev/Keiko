import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { McpServerDefinition, VerificationKind } from "@oscharko-dev/keiko-contracts";
import { isGatewayNativeToolAdvertisement } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  nativeToolchainReadRoots,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import { CodingRuntimeRunEffortLedger } from "./codingRuntimeRunEffort.js";
import type { CodingSafeActivitySignal } from "./codingSafeActivityProjection.js";
import { createCodingToolNativeSettlementFacet } from "./codingToolNativeEffect.js";
import {
  buildOpenCodeLaunchProfile,
  openCodeConfigDirectory,
  openCodePlanDirectory,
  openCodeRepositoryInstructionsPath,
} from "./opencodeLaunchProfile.js";
import { createCodingRuntimeRepositoryInstructionsPort } from "./codingRuntimeRepositoryInstructions.js";
import { resolveNativeExternalReadRoots } from "./opencodeNativeExternalRoots.js";
import { nativeLinkedFilesField } from "./opencodeNativeLinkedFiles.js";
import { resolveOpenCodeRipgrep } from "./opencodeRipgrepLaunch.js";
import type {
  SecureWorkspaceNativeFileIO,
  SecureWorkspaceTextReadPort,
} from "./secureWorkspaceTextRead.js";
import { globalOpenCodeConfigDirectory } from "./codingRuntimeInstructionSources.js";
import { OPENCODE_NATIVE_TOOL_DEFINITIONS } from "./opencodeNativeTools.js";
import {
  decideOpenCodeNativePolicy,
  openCodeNativeVerificationKind,
  parseOpenCodeNativePolicyRequest,
  type OpenCodeNativeMcpGrants,
} from "./opencodeNativePolicy.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import {
  openCodeNativeMcpAdmission,
  type OpenCodeNativeMcpAdmission,
} from "./opencodeNativeMcp.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";
import { createOpenCodeNativeToolAdvertisement } from "./opencodeToolSchemas.js";
import {
  admitNativeSessionLocation,
  createNativeTreeStatusPort,
  interruptNativeTree,
  type NativeSessionTreeRun,
} from "./opencodeNativeSessionTree.js";
import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";

/**
 * Original-runtime qualification of five native parity rows (#3897, docs/qa/opencode-capability-
 * parity.md): T02 (a directory read), T08 (`patch`), T13 (background and long-running shell
 * processes), T19 (the plan tool) and C07 (formatters). The pinned executable runs under the real
 * native Seatbelt wrapper with the profile `buildOpenCodeLaunchProfile` produces, behind a scripted
 * Model Gateway, and Keiko's own native policy (`decideOpenCodeNativePolicy`) answers every ask the
 * generated hook sends, so each result is what a run under Keiko's governance observes. A control
 * that departs from the production launch says so in its name: a model alias the producer treats
 * as an apply-patch model, the producer's opt-in switches. Run with KEIKO_OPENCODE_REAL_BINARY and
 * KEIKO_OPENCODE_REAL_RESOURCE_ROOT set; otherwise it is skipped.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const GATEWAY_CAPABILITY = "fixture-gateway-capability";
const FACADE_CAPABILITY = "fixture-facade-capability";
const RUN_ID = "run-native-qualification";
const MAX_FIXTURE_BODY_BYTES = 4 * 1_024 * 1_024;
const FIXTURE_FILE = "README.md";

type Mode = "governed-assist" | "supervised-coding" | "autonomous-delivery";

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
  /** Tool calls still to issue; each answers one request whose last message is the user's. */
  calls: ScriptedCall[];
}

/** What Keiko's native policy decided for one ask of the generated hook. */
interface PolicyDecision {
  readonly permission: string;
  readonly resources: readonly string[];
  readonly effect: "allow" | "ask" | "deny";
  readonly reason?: string;
  readonly patchBytes?: number;
}

interface FacadeStub extends Stub {
  readonly decisions: PolicyDecision[];
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
  if (response.destroyed) return;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    frame({
      id: "native-qualification",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: null }],
    }),
  );
  response.end(
    frame({
      id: "native-qualification",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }) + "data: [DONE]\n\n",
  );
}

async function startGateway(): Promise<GatewayStub> {
  const stub = await startStub((self, recorded, response) => {
    const gateway = self as GatewayStub;
    const next = lastRole(recorded.body) === "user" ? gateway.calls.shift() : undefined;
    if (next === undefined) {
      streamedTurn(response, { content: "Fixture turn completed." }, "stop");
      return;
    }
    const call = {
      index: 0,
      id: `call_qualification_${String(self.requests.length)}`,
      type: "function",
      function: { name: next.name, arguments: JSON.stringify(next.arguments) },
    };
    streamedTurn(response, { tool_calls: [call] }, "tool_calls");
  });
  return Object.assign(stub, { calls: [] as ScriptedCall[] });
}

interface Governance {
  readonly mode: Mode;
  readonly workspaceRoot: string;
  readonly planRoot: string;
  /** True answers an `ask` as the human would approve it; false refuses it. */
  readonly approveAsks: boolean;
  /** The MCP grants of the run's admitted registry servers (#3903). */
  readonly mcp?: OpenCodeNativeMcpGrants | undefined;
  /** The run's accepted external references (#3900 AC5). */
  readonly externalRoots?: readonly string[] | undefined;
}

/** Keiko's own native policy answers every ask the generated hook sends. */
async function startFacade(governance: Governance): Promise<FacadeStub> {
  const decisions: PolicyDecision[] = [];
  const stub = await startStub((_self, recorded, response) => {
    const request = parseOpenCodeNativePolicyRequest(recorded.body);
    let answer: Record<string, unknown> = { effect: "deny", message: "unparsable policy request" };
    if (request !== undefined) {
      const decision = decideOpenCodeNativePolicy({
        mode: governance.mode,
        workspaceRoot: governance.workspaceRoot,
        planRoot: governance.planRoot,
        request,
        nowMs: Date.now(),
        ...(governance.mcp === undefined ? {} : { mcp: governance.mcp }),
        ...(governance.externalRoots === undefined
          ? {}
          : { externalRoots: governance.externalRoots }),
      });
      decisions.push({
        permission: request.permission,
        resources: request.resources,
        effect: decision.effect,
        ...(decision.effect === "deny" ? { reason: decision.reason } : {}),
        ...(request.patchBytes === undefined ? {} : { patchBytes: request.patchBytes }),
      });
      const admitted =
        decision.effect === "allow" || (decision.effect === "ask" && governance.approveAsks);
      if (admitted) answer = { effect: "allow" };
      else
        answer = {
          effect: "deny",
          message: decision.effect === "deny" ? decision.message : "approval-required",
        };
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(answer));
  });
  return Object.assign(stub, { decisions });
}

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
}

function createFixture(files: Readonly<Record<string, string>>): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-qualification-")));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(workspace, name)), { recursive: true });
    writeFileSync(join(workspace, name), content);
  }
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

interface LaunchOptions {
  readonly mode: Mode;
  readonly approveAsks: boolean;
  /** Keys merged over the run's private configuration file (never over the server-owned binding). */
  readonly overlay: Readonly<Record<string, unknown>>;
  /** A different model alias, to observe a producer rule that depends on the model id. */
  readonly modelAlias: string | undefined;
  readonly files: Readonly<Record<string, string>>;
  /** Variables set after the production environment, for a control that changes one. */
  readonly env: Readonly<Record<string, string>>;
  /** Throwaway observation plugins (never product code); `{{STATE}}` names the run's state root. */
  readonly plugins: Readonly<Record<string, string>>;
  /** The operator's MCP registry servers for this run, admitted as production admits them. */
  readonly mcpServers?: ((fixture: Fixture) => readonly McpServerDefinition[]) | undefined;
  /**
   * A toolchain directory on the launcher's `PATH`, opened as production opens the launcher's
   * `PATH` (`nativeToolchainReadRoots`), so the agent runs the host's real executables (#3901 AC1).
   */
  readonly toolchainPath?: string | undefined;
  /**
   * The operator's raw `KEIKO_CODING_EXTERNAL_READ_ROOTS` for this run (#3900 AC5), resolved as
   * production resolves it and bound to the profile, the kernel allowlist and the policy alike.
   */
  readonly externalReadRoots?: ((fixture: Fixture) => string) | undefined;
  /** Provisions the workspace beyond plain text files (a project's installed packages). */
  readonly prepare?: ((fixture: Fixture) => void | Promise<void>) | undefined;
}

const PRODUCTION_LAUNCH: LaunchOptions = {
  mode: "supervised-coding",
  approveAsks: true,
  overlay: {},
  modelAlias: undefined,
  files: { [FIXTURE_FILE]: "native qualification fixture\n" },
  env: {},
  plugins: {},
};

/** The run's accepted external references, resolved by the production resolver (#3900 AC5). */
function acceptedExternalRoots(options: LaunchOptions, fixture: Fixture): readonly string[] {
  if (options.externalReadRoots === undefined) return [];
  return resolveNativeExternalReadRoots({
    value: options.externalReadRoots(fixture),
    kernelAllowlist: true,
    workspaceRoot: fixture.workspace,
    privateStateRoot: fixture.state,
    deniedRoots: [],
  }).roots;
}

function toolchainReadRoots(
  options: LaunchOptions,
  fixture: Fixture,
): { readonly toolchainReadRoots?: readonly string[] } {
  const paths = [
    ...(options.mcpServers?.(fixture) ?? []).flatMap((server) =>
      server.transport.kind === "local" ? [dirname(server.transport.command[0])] : [],
    ),
    ...(options.toolchainPath === undefined ? [] : [options.toolchainPath]),
  ];
  return paths.length === 0
    ? {}
    : { toolchainReadRoots: nativeToolchainReadRoots(paths.join(":"), homedir()) };
}

/** Renames the one model alias of a configuration document, leaving the rest untouched. */
function withModelAlias(document: Record<string, unknown>, alias: string): Record<string, unknown> {
  const providers = object(document.providers);
  const provider = object(providers?.["keiko-runtime"]);
  const models = object(provider?.models);
  if (providers === undefined || provider === undefined || models === undefined)
    throw new Error("fixture-config-invalid");
  return {
    ...document,
    model: `keiko-runtime/${alias}`,
    providers: {
      ...providers,
      "keiko-runtime": { ...provider, models: { [alias]: models.coding } },
    },
  };
}

function materializePrivateConfiguration(
  fixture: Fixture,
  options: LaunchOptions,
  profileConfig: string,
): void {
  const document = {
    ...(JSON.parse(profileConfig) as Record<string, unknown>),
    ...options.overlay,
  };
  const configRoot = join(fixture.state, "config", "opencode");
  for (const path of [
    join(configRoot, "plugins"),
    join(fixture.state, "home"),
    join(fixture.state, "state"),
    join(fixture.state, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const alias = options.modelAlias;
  writeFileSync(
    join(configRoot, "opencode.json"),
    JSON.stringify(alias === undefined ? document : withModelAlias(document, alias)),
    { mode: 0o600 },
  );
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native")))
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
  for (const [name, source] of Object.entries(options.plugins))
    writeFileSync(
      join(configRoot, "plugins", `${name}.ts`),
      source.replaceAll("{{STATE}}", fixture.state),
      { mode: 0o600 },
    );
}

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
}

function launch(
  fixture: Fixture,
  binary: string,
  runtimeRoot: string,
  ports: { readonly gateway: number; readonly facade: number },
  options: LaunchOptions,
  mcp?: OpenCodeNativeMcpAdmission,
): Launched {
  const external = acceptedExternalRoots(options, fixture);
  const profile = buildOpenCodeLaunchProfile({
    executable: binary,
    stateRoot: fixture.state,
    toolProfile: "native",
    contextGeometry: {
      contextWindowTokens: 32_768,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_096,
    },
    ...(mcp === undefined ? {} : { mcp: mcp.config }),
    ...(external.length === 0 ? {} : { externalReadRoots: external }),
  });
  if (!profile.ok) throw new Error("fixture-profile-invalid");
  materializePrivateConfiguration(fixture, options, profile.config);
  // The server-owned binding is what the production launch passes in the environment.
  const content = profile.env.OPENCODE_CONFIG_CONTENT;
  if (content === undefined) throw new Error("fixture-config-content-missing");
  const bound = JSON.parse(content) as Record<string, unknown>;
  const git = resolveDarwinGitExecutable();
  const gatewayUrl = `http://127.0.0.1:${String(ports.gateway)}/v1`;
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl,
    runId: RUN_ID,
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
      protectedWriteRoots: [openCodeConfigDirectory(fixture.state)],
      // As production opens them: the admitted local MCP servers' install prefixes (#3903) and the
      // launcher's toolchain `PATH` (#3901 AC1).
      ...toolchainReadRoots(options, fixture),
      ...(external.length === 0 ? {} : { externalReadRoots: external }),
      // As production scans them at launch: the hard links that predate the run (PR #4064 review).
      ...nativeLinkedFilesField({ write: () => undefined }, RUN_ID, [
        fixture.workspace,
        ...external,
      ]),
    },
  });
  const command = buildRuntimeGatewaySeatbeltCommand(policy, binary, profile.args, git.path);
  const password = profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("fixture-password-missing");
  const alias = options.modelAlias;
  return {
    password,
    child: spawn(command.command, [...command.args], {
      cwd: fixture.workspace,
      env: {
        ...profile.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(
          alias === undefined ? bound : withModelAlias(bound, alias),
        ),
        PATH: [dirname(git.path), options.toolchainPath, "/usr/bin", "/bin"]
          .filter((entry) => entry !== undefined)
          .join(":"),
        KEIKO_MODEL_GATEWAY_URL: gatewayUrl,
        KEIKO_MODEL_GATEWAY_CAPABILITY: GATEWAY_CAPABILITY,
        KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(ports.facade)}/native-policy`,
        KEIKO_TOOL_FACADE_CAPABILITY: FACADE_CAPABILITY,
        KEIKO_CODING_RUN_ID: RUN_ID,
        KEIKO_CODING_MODE: options.mode,
        ...options.env,
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
        const endpoint = parseOpenCodeV2ChildEndpoint(`${line}\n`);
        if (endpoint === undefined) continue;
        clearTimeout(timeout);
        resolve(endpoint);
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

async function stopChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill(signal);
  });
}

interface Run {
  readonly fixture: Fixture;
  readonly gateway: GatewayStub;
  readonly facade: FacadeStub;
  readonly client: OpenCodeV2HttpClient;
  readonly sessionId: string;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  /** A GET of the runtime's own API for the run's location (`/api/mcp`, say). */
  readonly raw: (path: string) => Promise<unknown>;
}

async function withRun(
  overrides: Partial<LaunchOptions>,
  body: (run: Run) => Promise<void>,
): Promise<void> {
  const options = { ...PRODUCTION_LAUNCH, ...overrides };
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const fixture = createFixture(options.files);
  await options.prepare?.(fixture);
  const gateway = await startGateway();
  const mcp =
    options.mcpServers === undefined
      ? undefined
      : openCodeNativeMcpAdmission({
          servers: options.mcpServers(fixture),
          mode: options.mode,
          home: join(fixture.state, "home"),
        });
  const facade = await startFacade({
    mode: options.mode,
    workspaceRoot: fixture.workspace,
    planRoot: openCodePlanDirectory(fixture.state),
    approveAsks: options.approveAsks,
    ...(mcp === undefined ? {} : { mcp: mcp.grants }),
    ...(options.externalReadRoots === undefined
      ? {}
      : { externalRoots: acceptedExternalRoots(options, fixture) }),
  });
  const launched = launch(
    fixture,
    realpathSync(BINARY),
    realpathSync(RESOURCE_ROOT),
    { gateway: gateway.port, facade: facade.port },
    options,
    mcp,
  );
  try {
    const endpoint = await childEndpoint(launched.child);
    const client = createOpenCodeV2HttpClient({ endpoint, password: launched.password });
    expect((await client.info()).version).toBe(OPENCODE_PINNED_VERSION);
    const session = await client.createSession(fixture.workspace);
    if (typeof session.id !== "string") throw new Error("fixture-session-invalid");
    const raw: Run["raw"] = async (path) => {
      const location = `location%5Bdirectory%5D=${encodeURIComponent(fixture.workspace)}`;
      const authorization = `Basic ${Buffer.from(`opencode:${launched.password}`).toString("base64")}`;
      const response = await fetch(`${endpoint}${path}?${location}`, {
        headers: { Authorization: authorization },
      });
      return (await response.json()) as unknown;
    };
    await body({
      fixture,
      gateway,
      facade,
      client,
      sessionId: session.id,
      child: launched.child,
      raw,
    });
  } finally {
    await stopChild(launched.child);
    await Promise.all([closeStub(gateway), closeStub(facade)]);
    // The runtime may still be flushing its state when the child exits; retry the removal.
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** The tool names the runtime advertised to the model in its first request of the run. */
function advertisedToolNames(gateway: Stub): readonly string[] {
  const tools = object(gateway.requests[0]?.body)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool: unknown) => {
    const name = object(object(tool)?.function)?.name;
    return typeof name === "string" ? [name] : [];
  });
}

/** What the runtime sent back to the model as the result of the latest tool call. */
function lastToolResult(gateway: Stub): string {
  const messages = object(gateway.requests.at(-1)?.body)?.messages;
  if (!Array.isArray(messages)) return "";
  const result = messages
    .map(object)
    .filter((message) => message?.role === "tool")
    .at(-1);
  return typeof result?.content === "string" ? result.content : "";
}

/** Runs one scripted tool call as one model turn and returns what the model received. */
async function scriptedTurn(
  run: Run,
  call: ScriptedCall,
  prompt = "Run the scripted call.",
): Promise<string> {
  const before = run.gateway.requests.length;
  run.gateway.calls.push(call);
  await run.client.prompt(run.sessionId, prompt);
  await expect
    .poll(() => run.gateway.requests.length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before + 2);
  return lastToolResult(run.gateway);
}

const read = (path: string, extra: Readonly<Record<string, unknown>> = {}): ScriptedCall => ({
  name: "read",
  arguments: { path, ...extra },
});

const shell = (command: string, extra: Readonly<Record<string, unknown>> = {}): ScriptedCall => ({
  name: "shell",
  arguments: { command, ...extra },
});

/** The first line of a directory listing names it; the rest are its entries, one per line. */
function listedEntries(result: string): readonly string[] {
  return result
    .split("\n")
    .slice(1)
    .filter((line) => !line.startsWith("["));
}

// ─── processes the agent starts ────────────────────────────────────────────────────────────────

interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
}

/** The live processes whose command line carries `marker`, read from outside the sandbox. */
function processesCarrying(marker: string): readonly ProcessEntry[] {
  const listing = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error("fixture-ps-failed");
  return listing.stdout.split("\n").flatMap((line) => {
    const [, pid, ppid, command] = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line) ?? [];
    return pid !== undefined && ppid !== undefined && command?.includes(marker) === true
      ? [{ pid: Number(pid), ppid: Number(ppid) }]
      : [];
  });
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * Runs `body` with a marker no other process carries. Whatever the body leaves running is killed
 * afterwards, so a failed assertion cannot leak a process into the developer's machine.
 */
async function withProcessMarker(body: (marker: string) => Promise<void>): Promise<void> {
  const marker = `KEIKO_QUAL_${randomUUID().replaceAll("-", "")}`;
  try {
    await body(marker);
  } finally {
    for (const entry of processesCarrying(marker)) killProcess(entry.pid);
  }
}

const liveCount = (marker: string): number => processesCarrying(marker).length;

/**
 * A loopback HTTP server that records its port in the workspace, the shape of a dev server. macOS
 * ships the Ruby it runs on; the kernel proofs in `runtime-gateway.test.ts` rely on it as well.
 */
function loopbackServerCommand(marker: string): string {
  const program = [
    's=TCPServer.new("127.0.0.1",0);',
    'File.write("dev-server.port",s.addr[1].to_s);',
    "loop{c=s.accept;c.gets;",
    'c.write("HTTP/1.1 200 OK\\r\\nContent-Length: 15\\r\\nConnection: close\\r\\n\\r\\npong-dev-server");',
    "c.close}",
  ].join("");
  // Single quotes keep the shell from touching the program; Ruby reads the escapes in its strings.
  return `ruby -rsocket -e '${program}' ${marker}`;
}

const REACH_SERVER_COMMAND = "curl -s --max-time 5 http://127.0.0.1:$(cat dev-server.port)/";

/** A process that does nothing for `seconds`, identifiable by `marker`. */
const idleCommand = (seconds: number, marker: string): string =>
  `ruby -e 'sleep ${String(seconds)}' ${marker}`;

async function settledIdle(run: Run): Promise<void> {
  await expect
    .poll(async () => Object.keys(await run.client.active()).length, { timeout: 20_000 })
    .toBe(0);
}

// ─── the producer's tool registry ──────────────────────────────────────────────────────────────

/**
 * A throwaway observation plugin (never product code): when a tool is about to run it writes the
 * ids of every tool the runtime has registered, the producer's own `ctx.tool.list()`.
 */
function registryProbe(): string {
  return [
    'import { writeFileSync } from "node:fs";',
    "export default {",
    '  id: "keiko.registry-probe",',
    "  async setup(ctx) {",
    '    await ctx.tool.hook("execute.before", async () => {',
    '      writeFileSync("{{STATE}}/tmp/tool-registry.json", JSON.stringify((await ctx.tool.list()).map((tool) => tool.id)));',
    "    });",
    "  },",
    "};",
  ].join("\n");
}

const REGISTRY_PROBE = { keiko_registry_probe: registryProbe() };

function registeredToolIds(run: Run): readonly string[] {
  const written = readFileSync(join(run.fixture.state, "tmp", "tool-registry.json"), "utf8");
  return JSON.parse(written) as string[];
}

/** The ids the producer registers for a launch, read once a tool has run. */
async function registeredWith(overrides: Partial<LaunchOptions>): Promise<readonly string[]> {
  let ids: readonly string[] = [];
  await withRun({ ...overrides, plugins: REGISTRY_PROBE }, async (run) => {
    await scriptedTurn(run, read(FIXTURE_FILE));
    ids = registeredToolIds(run);
  });
  return ids;
}

// ─── T02: a directory read ─────────────────────────────────────────────────────────────────────

describe("pinned native OpenCode directory reads (T02)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const CANARY = "DIRECTORY-READ-CANARY-TOKEN";
  const files = {
    [FIXTURE_FILE]: "readme\n",
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 1;\n",
    "src/nested/c.ts": "export const c = 1;\n",
    "docs/guide.md": "guide\n",
    ".env": `TOKEN=${CANARY}\n`,
    ".gitignore": "ignored.log\n",
    "ignored.log": "ignored\n",
  };

  it.skipIf(skip)(
    "lists a directory through the native read tool, pages it and offers no list tool",
    async () => {
      await withRun({ files }, async (run) => {
        const root = await scriptedTurn(run, read("."));
        expect(root).toMatch(/^Read directory \., entries 1-\d+/u);
        // Directories first and marked with a slash; the immediate entries only.
        expect(listedEntries(root)).toEqual(
          expect.arrayContaining(["docs/", "src/", FIXTURE_FILE]),
        );
        expect(listedEntries(root)).not.toContain("a.ts");
        const src = await scriptedTurn(run, read("src"));
        expect(listedEntries(src)).toEqual(["nested/", "a.ts", "b.ts"]);
        const page = await scriptedTurn(run, read("src", { offset: 2, limit: 1 }));
        expect(page).toContain("entries 2-2");
        expect(listedEntries(page)).toEqual(["a.ts"]);
        expect(page).toContain("Continue reading with offset: 3");
        // `list` is a permission action only: no tool carries it, and a directory is a plain `read`.
        expect(advertisedToolNames(run.gateway)).toContain("read");
        expect(advertisedToolNames(run.gateway)).not.toContain("list");
        expect(run.facade.decisions).toEqual([
          { permission: "read", resources: ["."], effect: "allow" },
          { permission: "read", resources: ["src"], effect: "allow" },
          { permission: "read", resources: ["src"], effect: "allow" },
        ]);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "refuses a directory outside the workspace before the policy is asked and a protected one through it",
    async () => {
      await withRun({ files }, async (run) => {
        const outside = await scriptedTurn(run, read("/private/etc"));
        expect(JSON.parse(outside)).toEqual({
          error: { type: "permission.rejected", message: "Permission denied: external_directory" },
          content: [],
        });
        expect(run.facade.decisions).toEqual([]);
        for (const protectedPath of [".git", ".env"]) {
          const refused = await scriptedTurn(run, read(protectedPath));
          expect(refused).toContain("protected sensitive file");
          expect(refused).not.toContain(CANARY);
        }
        expect(run.facade.decisions).toEqual([
          { permission: "read", resources: [".git"], effect: "deny", reason: "sensitive-path" },
          { permission: "read", resources: [".env"], effect: "deny", reason: "sensitive-path" },
        ]);
        // The listing of the workspace names its entries, `.env` and an ignored file included;
        // reading one is what the policy governs, and no content of either reached the model.
        const listing = listedEntries(await scriptedTurn(run, read(".")));
        expect(listing).toEqual(expect.arrayContaining([".env", "ignored.log"]));
        expect(JSON.stringify(run.gateway.requests)).not.toContain(CANARY);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "answers a directory that does not exist with the producer's own error",
    async () => {
      await withRun({ files }, async (run) => {
        const missing = await scriptedTurn(run, read("no-such-directory/"));
        expect(JSON.parse(missing)).toMatchObject({
          error: { type: "tool.execution", message: "File not found: no-such-directory/" },
        });
      });
    },
    120_000,
  );
});

// ─── T08: patch ────────────────────────────────────────────────────────────────────────────────

// ─── PR #4064 review: hard links inside the workspace ─────────────────────────────────────────────

// #3900 AC2/AC5 (the auditor's original-binary counter, comment 4369915598): a hard link that
// already exists in the searched tree names a file outside every admitted root. The launch scan
// names it and the kernel profile denies its bytes, so the original search -- and every other
// reader of the run -- returns the ordinary match and none of the outside file, in every mode.
// The boundary is Keiko's own: nothing here depends on which reader the runtime uses.
describe("pinned native OpenCode search over a pre-existing hard link (#3900 AC2/AC5)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const CANARY = "HARD-LINK-SEARCH-CANARY";
  const files = {
    [FIXTURE_FILE]: "readme\n",
    "src/ordinary.ts": "export const harmless = 1;\n",
  };
  const grep = (pattern: string, extra: Readonly<Record<string, unknown>> = {}): ScriptedCall => ({
    name: "grep",
    arguments: { pattern, include: "*.ts", ...extra },
  });

  /** The pinned ripgrep's directory, verified as the production launch verifies it. */
  function verifiedRipgrepPath(): string {
    const resolution = resolveOpenCodeRipgrep({
      target: "macos-arm64",
      location: {
        kind: "checkout",
        checkoutRoot: fileURLToPath(new URL("../../../..", import.meta.url)),
      },
      env: {},
    });
    if (resolution.outcome !== "verified")
      throw new Error(`fixture-ripgrep-not-provisioned:${resolution.reason}`);
    return resolution.directory;
  }

  /** A synthetic outside file, hard-linked into `directory` before the run launches. */
  function linkBeforeLaunch(fixture: Fixture, directory: string, alias: string): void {
    const outside = join(fixture.root, `outside-${randomUUID()}.txt`);
    writeFileSync(outside, `export const leaked = "${CANARY}";\n`);
    mkdirSync(directory, { recursive: true });
    linkSync(outside, join(directory, alias));
  }

  it.skipIf(skip)(
    "finds the ordinary match and none of a linked file's bytes in all three modes",
    async () => {
      for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"] as const) {
        await withRun(
          {
            files,
            mode,
            toolchainPath: verifiedRipgrepPath(),
            prepare: (fixture) => {
              linkBeforeLaunch(fixture, join(fixture.workspace, "src"), "linked.ts");
            },
          },
          async (run) => {
            // Positive control: the original search still returns the ordinary source line.
            expect(await scriptedTurn(run, grep("harmless")), mode).toContain("harmless");
            const searched = await scriptedTurn(run, grep("HARD-LINK"));
            expect(searched, mode).not.toContain(CANARY);
            expect(
              run.facade.decisions.filter((decision) => decision.permission === "grep"),
              mode,
            ).toEqual([
              expect.objectContaining({ effect: "allow" }),
              expect.objectContaining({ effect: "allow" }),
            ]);
            expect(JSON.stringify(run.gateway.requests), mode).not.toContain(CANARY);
          },
        );
      }
    },
    600_000,
  );

  it.skipIf(skip)(
    "gives a Full access shell child none of the linked file's bytes either",
    async () => {
      await withRun(
        {
          files,
          mode: "autonomous-delivery",
          prepare: (fixture) => {
            linkBeforeLaunch(fixture, join(fixture.workspace, "src"), "linked.ts");
          },
        },
        async (run) => {
          const output = await scriptedTurn(
            run,
            shell("cat src/linked.ts; cp src/linked.ts copy.ts; mv src/linked.ts moved.ts"),
          );
          expect(output).toContain("Operation not permitted");
          expect(output).not.toContain(CANARY);
          expect(existsSync(join(run.fixture.workspace, "copy.ts"))).toBe(false);
          expect(JSON.stringify(run.gateway.requests)).not.toContain(CANARY);
        },
      );
    },
    240_000,
  );

  it.skipIf(skip)(
    "finds an accepted reference's ordinary match and none of its linked file's bytes",
    async () => {
      const reference = (fixture: Fixture): string => join(fixture.root, "reference", "src");
      await withRun(
        {
          files,
          mode: "autonomous-delivery",
          toolchainPath: verifiedRipgrepPath(),
          externalReadRoots: reference,
          prepare: (fixture) => {
            mkdirSync(reference(fixture), { recursive: true });
            writeFileSync(join(reference(fixture), "guide.ts"), "export const harmless = 2;\n");
            linkBeforeLaunch(fixture, reference(fixture), "aliased.ts");
          },
        },
        async (run) => {
          const path = reference(run.fixture);
          expect(await scriptedTurn(run, grep("harmless", { path }))).toContain("harmless = 2");
          const searched = await scriptedTurn(run, grep("HARD-LINK", { path }));
          expect(searched).not.toContain(CANARY);
          expect(JSON.stringify(run.gateway.requests)).not.toContain(CANARY);
        },
      );
    },
    240_000,
  );
});

// #3900 AC1: the original Write and Edit keep their own schemas and results -- create, overwrite,
// replace and replace-all -- while every write reaches Keiko's one native policy owner. Move and
// delete run through the shell for this model, as in standalone OpenCode (patch is the producer's
// gpt-model variant, T08). Read paging and the Glob/Grep semantics are pinned beside the verified
// ripgrep in `opencodeRipgrep.real.test.ts`.
describe("pinned native OpenCode file tools keep their original semantics (T01-T07, #3900 AC1)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const notes = Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`).join("\n");
  const matrixFiles = {
    "notes.txt": `${notes}\n`,
    "src/app.ts": "export const APP_NAME = 'Keiko';\n",
    "src/repeat.ts": "x = 1;\nx = 2;\n",
    "src/nested/deep.ts": "export const deep = 'needle';\n",
    "docs/guide.md": "# Guide\nA NEEDLE in the docs.\n",
    ".hidden/tool.ts": "export const hidden = 'needle';\n",
  };
  const call = (name: string, args: Readonly<Record<string, unknown>>): ScriptedCall => ({
    name,
    arguments: args,
  });

  it.skipIf(skip)(
    "creates, overwrites and replaces through write and edit, and moves and deletes through the shell",
    async () => {
      await withRun({ files: matrixFiles }, async (run) => {
        const workspaceFile = (name: string): string =>
          readFileSync(join(run.fixture.workspace, name), "utf8");
        await scriptedTurn(
          run,
          call("write", { path: "src/created.ts", content: "export const created = true;\n" }),
        );
        expect(workspaceFile("src/created.ts")).toBe("export const created = true;\n");

        await scriptedTurn(run, read("notes.txt"));
        await scriptedTurn(run, call("write", { path: "notes.txt", content: "overwritten\n" }));
        expect(workspaceFile("notes.txt")).toBe("overwritten\n");

        await scriptedTurn(run, read("src/app.ts"));
        await scriptedTurn(
          run,
          call("edit", { path: "src/app.ts", oldString: "'Keiko'", newString: "'KeikoNative'" }),
        );
        expect(workspaceFile("src/app.ts")).toBe("export const APP_NAME = 'KeikoNative';\n");
        await scriptedTurn(run, read("src/repeat.ts"));
        await scriptedTurn(
          run,
          call("edit", { path: "src/repeat.ts", oldString: "x", newString: "y", replaceAll: true }),
        );
        expect(workspaceFile("src/repeat.ts")).toBe("y = 1;\ny = 2;\n");

        await scriptedTurn(run, shell("mv src/created.ts src/renamed.ts && rm docs/guide.md"));
        expect(existsSync(join(run.fixture.workspace, "src/renamed.ts"))).toBe(true);
        expect(existsSync(join(run.fixture.workspace, "src/created.ts"))).toBe(false);
        expect(existsSync(join(run.fixture.workspace, "docs/guide.md"))).toBe(false);

        // Writes went through Keiko's policy as edits, the shell as a shell command.
        const asked = run.facade.decisions.map((decision) => decision.permission);
        expect(asked.filter((permission) => permission === "edit")).toHaveLength(4);
        expect(asked).toContain("shell");
      });
    },
    240_000,
  );
});

describe("pinned native OpenCode hard links inside the workspace (PR #4064 review)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const CANARY = "HARD-LINK-OUTSIDE-CANARY";
  const files = {
    [FIXTURE_FILE]: "readme\n",
    "src/file.ts": "export const harmless = 1;\n",
  };

  /** A synthetic file outside the workspace, linked into it under `alias` before the run reads. */
  function linkOutside(run: Run, alias: string): string {
    const outside = join(run.fixture.root, `outside-${randomUUID()}.txt`);
    writeFileSync(outside, `${CANARY}\n`);
    linkSync(outside, join(run.fixture.workspace, alias));
    return outside;
  }

  it.skipIf(skip)(
    "refuses an ordinary read that would load a hard-linked AGENTS.md, and no canary reaches the model",
    async () => {
      for (const mode of ["supervised-coding", "autonomous-delivery"] as const) {
        await withRun({ files, mode }, async (run) => {
          linkOutside(run, "src/AGENTS.md");
          const refused = await scriptedTurn(run, read("src/file.ts"));
          expect(refused).toContain("hard link");
          expect(run.facade.decisions).toEqual([
            {
              permission: "read",
              resources: ["src/file.ts"],
              effect: "deny",
              reason: "linked-file",
            },
          ]);
          expect(JSON.stringify(run.gateway.requests)).not.toContain(CANARY);
        });
      }
    },
    240_000,
  );

  it.skipIf(skip)(
    "refuses a native edit of a hard link and leaves the outside file unchanged",
    async () => {
      for (const mode of ["supervised-coding", "autonomous-delivery"] as const) {
        await withRun({ files, mode }, async (run) => {
          const outside = linkOutside(run, "alias.txt");
          const refused = await scriptedTurn(run, {
            name: "edit",
            arguments: { path: "alias.txt", oldString: CANARY, newString: "CHANGED" },
          });
          expect(refused).toContain("hard link");
          expect(readFileSync(outside, "utf8")).toBe(`${CANARY}\n`);
          expect(run.facade.decisions.map((decision) => decision.reason)).toEqual(["linked-file"]);
        });
      }
    },
    240_000,
  );

  it.skipIf(skip)(
    "lets no shell child of the run create a hard link to a file outside the workspace",
    async () => {
      await withRun({ files, mode: "autonomous-delivery" }, async (run) => {
        const outside = join(run.fixture.root, "outside-target.txt");
        writeFileSync(outside, `${CANARY}\n`);
        const output = await scriptedTurn(
          run,
          shell(`ln '${outside}' made-alias.txt; cat made-alias.txt`),
        );
        // The policy let the command run; the kernel refused the link to a file the run may not
        // read, so an alias inside the workspace can only predate the run.
        expect(run.facade.decisions.map((decision) => decision.effect)).toEqual(["allow"]);
        expect(output).toContain("Operation not permitted");
        expect(existsSync(join(run.fixture.workspace, "made-alias.txt"))).toBe(false);
        expect(output).not.toContain(CANARY);
        expect(JSON.stringify(run.gateway.requests)).not.toContain(CANARY);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "keeps reading and editing ordinary files beside a regular AGENTS.md",
    async () => {
      await withRun(
        { files: { ...files, "src/AGENTS.md": "Use tabs.\n" }, mode: "autonomous-delivery" },
        async (run) => {
          expect(await scriptedTurn(run, read("src/file.ts"))).toContain("harmless");
          await scriptedTurn(run, {
            name: "edit",
            arguments: {
              path: "src/file.ts",
              oldString: "harmless = 1",
              newString: "harmless = 2",
            },
          });
          expect(readFileSync(join(run.fixture.workspace, "src/file.ts"), "utf8")).toContain(
            "harmless = 2",
          );
          expect(run.facade.decisions.map((decision) => decision.effect)).toEqual([
            "allow",
            "allow",
          ]);
        },
      );
    },
    120_000,
  );
});

describe("pinned native OpenCode patch (T08)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const files = {
    [FIXTURE_FILE]: "readme\n",
    "src/a.ts": "export const a = 1;\n",
    "src/move-me.ts": "export const m = 1;\n",
    "delete-me.txt": "gone\n",
  };
  const patchOf = (...hunks: readonly string[]): ScriptedCall => ({
    name: "patch",
    arguments: { patchText: ["*** Begin Patch", ...hunks, "*** End Patch"].join("\n") },
  });
  const ALL_FOUR_OPERATIONS = patchOf(
    "*** Add File: added.txt",
    "+added line",
    "*** Update File: src/a.ts",
    "@@",
    "-export const a = 1;",
    "+export const a = 2;",
    "*** Update File: src/move-me.ts",
    "*** Move to: src/moved.ts",
    "@@",
    "-export const m = 1;",
    "+export const m = 2;",
    "*** Delete File: delete-me.txt",
  );
  const FILE_EDITING_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "patch"]);
  const contentOf = (run: Run, name: string): string | undefined => {
    const path = join(run.fixture.workspace, name);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };

  it.skipIf(skip)(
    "offers edit and write, not patch, to the coding alias although the runtime registers patch",
    async () => {
      await withRun({ plugins: REGISTRY_PROBE }, async (run) => {
        await scriptedTurn(run, read(FIXTURE_FILE));
        expect(object(run.gateway.requests[0]?.body)?.model).toBe("coding");
        expect(advertisedToolNames(run.gateway)).toEqual(expect.arrayContaining(["edit", "write"]));
        expect(advertisedToolNames(run.gateway)).not.toContain("patch");
        expect(registeredToolIds(run)).toContain("patch");
      });
    },
    120_000,
  );

  // The producer removes `patch` from the tools of every model whose id lacks `gpt-`, and `edit` and
  // `write` from those whose id has it, except `gpt-4` and `oss` ids. Keiko's alias is fixed to
  // `coding`, and its gateway refuses any other model id, so the rule never offers patch there.
  it.skipIf(skip)(
    "control: a model id containing gpt- (not gpt-4, not oss) swaps edit and write for patch",
    async () => {
      const offered: Record<string, readonly string[]> = {};
      for (const alias of ["gpt-5-fixture", "gpt-4o-fixture", "gpt-oss-fixture"]) {
        await withRun({ modelAlias: alias }, async (run) => {
          await scriptedTurn(run, read(FIXTURE_FILE));
          offered[alias] = advertisedToolNames(run.gateway).filter((name) =>
            FILE_EDITING_TOOLS.has(name),
          );
        });
      }
      expect(offered).toEqual({
        "gpt-5-fixture": ["patch"],
        "gpt-4o-fixture": ["edit", "write"],
        "gpt-oss-fixture": ["edit", "write"],
      });
    },
    240_000,
  );

  it.skipIf(skip)(
    "control: patch adds, updates, moves and deletes files under the edit policy and charges its diff",
    async () => {
      await withRun({ modelAlias: "gpt-5-fixture", files }, async (run) => {
        const result = await scriptedTurn(run, ALL_FOUR_OPERATIONS);
        expect(result).toContain("Success. Updated the following files:");
        expect(contentOf(run, "added.txt")).toBe("added line\n");
        expect(contentOf(run, "src/a.ts")).toBe("export const a = 2;\n");
        expect(contentOf(run, "src/moved.ts")).toBe("export const m = 2;\n");
        expect(contentOf(run, "src/move-me.ts")).toBeUndefined();
        expect(contentOf(run, "delete-me.txt")).toBeUndefined();
        // One edit ask for the whole patch, the move's source and target both named, and the size of
        // the producer's own diff forwarded for the patch budget exactly as an `edit` forwards it.
        expect(run.facade.decisions).toEqual([
          {
            permission: "edit",
            resources: ["added.txt", "src/a.ts", "src/move-me.ts", "src/moved.ts", "delete-me.txt"],
            effect: "allow",
            patchBytes: expect.any(Number) as number,
          },
        ]);
        expect(run.facade.decisions[0]?.patchBytes).toBeGreaterThan(0);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "control: patch cannot write outside the workspace or a protected file, and asks where edit asks",
    async () => {
      await withRun({ modelAlias: "gpt-5-fixture", files }, async (run) => {
        const escape = patchOf(
          "*** Add File: inside.txt",
          "+inside",
          "*** Add File: ../escape.txt",
          "+out",
        );
        expect(JSON.parse(await scriptedTurn(run, escape))).toMatchObject({
          error: { type: "permission.rejected", message: "Permission denied: external_directory" },
        });
        expect(run.facade.decisions).toEqual([]);
        expect(contentOf(run, "inside.txt")).toBeUndefined();
        expect(existsSync(join(run.fixture.root, "escape.txt"))).toBe(false);
        await scriptedTurn(run, patchOf("*** Add File: .env", "+TOKEN=1"));
        expect(contentOf(run, ".env")).toBeUndefined();
        expect(run.facade.decisions).toEqual([
          expect.objectContaining({ permission: "edit", effect: "deny", reason: "sensitive-path" }),
        ]);
      });
      await withRun(
        { modelAlias: "gpt-5-fixture", mode: "governed-assist", approveAsks: false, files },
        async (run) => {
          await scriptedTurn(run, patchOf("*** Add File: asked.txt", "+asked"));
          expect(run.facade.decisions).toEqual([
            expect.objectContaining({ permission: "edit", effect: "ask" }),
          ]);
          expect(contentOf(run, "asked.txt")).toBeUndefined();
        },
      );
    },
    240_000,
  );
});

// ─── T19: the plan tool ────────────────────────────────────────────────────────────────────────

function isPlanOrTool(signal: CodingSafeActivitySignal): boolean {
  return signal.kind === "plan" || signal.kind === "tool";
}

describe("pinned native OpenCode plan tool (T19)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const PLAN_CALL: ScriptedCall = {
    name: "todowrite",
    arguments: {
      todos: [
        { content: "Step one", status: "in_progress", priority: "high" },
        { content: "Step two", status: "pending", priority: "low" },
      ],
    },
  };

  // Owner decision of 2026-10-24: Keiko sets the producer's `experimental.todo`, which is the only
  // way 2.1.4 offers its plan tool. The control shows what the switch decides.
  it.skipIf(skip)(
    "control: without the experimental.todo switch the producer offers no plan tool and refuses a call",
    async () => {
      await withRun({ overlay: { experimental: { todo: false } } }, async (run) => {
        const result = await scriptedTurn(run, PLAN_CALL);
        expect(advertisedToolNames(run.gateway)).not.toContain("todowrite");
        expect(advertisedToolNames(run.gateway)).not.toContain("todo");
        expect(JSON.parse(result)).toMatchObject({
          error: {
            type: "tool.execution",
            message: expect.stringContaining("todowrite") as string,
          },
        });
        expect(run.facade.decisions).toEqual([]);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "offers the plan tool; its update is a read in Ask for approval and projects as the plan card",
    async () => {
      // Ask for approval refuses every effect without a human, so an allowed plan update proves it
      // is classified as a read in the strictest mode.
      await withRun({ mode: "governed-assist", approveAsks: false }, async (run) => {
        const result = await scriptedTurn(run, PLAN_CALL);
        expect(advertisedToolNames(run.gateway)).toContain("todowrite");
        expect(advertisedToolNames(run.gateway)).not.toContain("todo");
        expect(result).toBe(
          'Todos updated: 0/2 completed, 1 in progress, 1 pending. In progress: "Step one"',
        );
        expect(run.facade.decisions).toEqual([
          { permission: "todowrite", resources: ["*"], effect: "allow" },
        ]);
        const projection = createOpenCodeV2HistoryProjection({
          runId: RUN_ID,
          activityLog: undefined,
          toolProfile: "native",
        });
        const signals = projection
          .project(run.sessionId, await run.client.messages(run.sessionId), undefined)
          .flatMap((event) => projection.takeSignal(event) ?? []);
        // A plan snapshot and no productive tool activity for the plan tool.
        expect(signals.filter(isPlanOrTool)).toEqual([
          {
            kind: "plan",
            anchorMessageId: expect.stringMatching(/^msg_/u) as string,
            steps: [
              { text: "Step one", state: "active" },
              { text: "Step two", state: "pending" },
            ],
            occurredAt: expect.any(String) as string,
          },
        ]);
      });
    },
    120_000,
  );

  // #3908 AC4: the model-visible tool schemas of the pinned producer are a committed fixture, so a
  // producer change to any tool's parameters is a reviewed diff before admission, and the gateway
  // admits exactly that advertisement. `KEIKO_WRITE_OPENCODE_TOOL_SCHEMAS=1` rewrites the fixture.
  it.skipIf(skip)(
    "advertises exactly the committed 2.1.4 tool schemas, and the gateway admits them",
    async () => {
      await withRun({}, async (run) => {
        await scriptedTurn(run, PLAN_CALL);
        const tools = (object(run.gateway.requests[0]?.body)?.tools as unknown[]).map((tool) => {
          const definition = object(object(tool)?.function) ?? {};
          return {
            name: String(definition.name),
            description: String(definition.description),
            parameters: object(definition.parameters) ?? {},
          };
        });
        const advertised = tools
          .map(({ name, parameters }) => ({ name, parameters }))
          .sort((left, right) => left.name.localeCompare(right.name));
        const fixture = new URL(
          "./opencodeToolSchemas.opencode-2.1.4-advertised.fixture.json",
          import.meta.url,
        );
        if (process.env.KEIKO_WRITE_OPENCODE_TOOL_SCHEMAS === "1")
          writeFileSync(fixture, `${JSON.stringify(advertised, null, 2)}\n`);
        expect(advertised).toEqual(JSON.parse(readFileSync(fixture, "utf8")));
        const offer = createOpenCodeNativeToolAdvertisement(tools, Date.now(), 60_000);
        expect(isGatewayNativeToolAdvertisement(offer)).toBe(true);
      });
    },
    120_000,
  );

  // The inventory Keiko classifies is derived from the producer, so it must name what the producer
  // registers: the plan tool was recorded as `todo` while the executable registers `todowrite`,
  // which the policy then refused as an unclassified action.
  it.skipIf(skip)(
    "registers every native tool id Keiko's inventory names, the plan tool through its switch",
    async () => {
      const production = await registeredWith({});
      // `execute` is the Code Mode runner; the producer adds it to a request, not to the registry.
      const named = OPENCODE_NATIVE_TOOL_DEFINITIONS.filter((tool) => tool.id !== "execute");
      expect(production).toEqual(expect.arrayContaining(named.map((tool) => tool.id)));
      expect(await registeredWith({ overlay: { experimental: { todo: false } } })).not.toContain(
        "todowrite",
      );
    },
    120_000,
  );
});

// ─── T13: processes the agent starts ───────────────────────────────────────────────────────────

describe("pinned native OpenCode shell processes (T13)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "runs a dev server in the background and reaches it from a second shell call on loopback",
    async () => {
      await withProcessMarker(async (marker) => {
        await withRun({ mode: "supervised-coding", approveAsks: true }, async (run) => {
          const started = await scriptedTurn(
            run,
            shell(loopbackServerCommand(marker), { background: true, description: "dev server" }),
          );
          // The call returned at once with a shell id and an output file; the server keeps running.
          expect(started).toContain("Command moved to the background (shell ID: sh_");
          expect(started).toContain("Output is streaming to:");
          // The server announces its port in the workspace once it listens.
          const portFile = join(run.fixture.workspace, "dev-server.port");
          await expect.poll(() => existsSync(portFile), { timeout: 20_000 }).toBe(true);
          // The server is a direct child of the runtime process, so the tree owns it.
          expect(processesCarrying(marker).map((entry) => entry.ppid)).toContain(run.child.pid);
          // Below Full access the kernel allows loopback, and a later call of the same run reaches it.
          expect(await scriptedTurn(run, shell(REACH_SERVER_COMMAND))).toBe("pong-dev-server");
          // Both commands are unvetted: Supervised asked, and the human's approval let them run.
          expect(run.facade.decisions.map((decision) => decision.effect)).toEqual(["ask", "ask"]);
        });
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "cancels a long-running foreground command when the turn is interrupted, leaving no process",
    async () => {
      await withProcessMarker(async (marker) => {
        await withRun({ mode: "autonomous-delivery" }, async (run) => {
          run.gateway.calls.push(shell(idleCommand(60, marker), { description: "watcher" }));
          await run.client.prompt(run.sessionId, "Run the foreground watcher.");
          await expect.poll(() => liveCount(marker), { timeout: 20_000 }).toBeGreaterThan(0);
          await run.client.interrupt(run.sessionId);
          await expect.poll(() => liveCount(marker), { timeout: 20_000 }).toBe(0);
          await settledIdle(run);
        });
      });
    },
    120_000,
  );

  // The producer treats a background job as work that outlives the turn it was started in, so an
  // interrupt ends the turn and not the job. Keiko's Stop first interrupts the session tree and then
  // ends the run's complete process tree (ADR-0137 D5): the runtime reaps its jobs on a graceful stop.
  it.skipIf(skip)(
    "keeps a background job through a turn interrupt and reaps it when the runtime is stopped",
    async () => {
      await withProcessMarker(async (marker) => {
        await withRun({ mode: "autonomous-delivery" }, async (run) => {
          await scriptedTurn(run, shell(idleCommand(120, marker), { background: true }));
          await expect.poll(() => liveCount(marker), { timeout: 20_000 }).toBeGreaterThan(0);
          await settledIdle(run);
          await run.client.interrupt(run.sessionId);
          await settledIdle(run);
          expect(liveCount(marker)).toBeGreaterThan(0);
          await stopChild(run.child, "SIGTERM");
          await expect.poll(() => liveCount(marker), { timeout: 20_000 }).toBe(0);
        });
      });
    },
    120_000,
  );

  // The control shows what only Keiko's native supervisor can cover: a runtime that is killed
  // instead of stopped leaves its background job running as an orphan of launchd. The supervisor
  // reaps such a process by its kernel resource coalition (`native/runtime-supervisor`), which a test
  // without the launchd job cannot reproduce.
  it.skipIf(skip)(
    "control: a runtime killed without its supervisor leaves the background job as an orphan",
    async () => {
      await withProcessMarker(async (marker) => {
        await withRun({ mode: "autonomous-delivery" }, async (run) => {
          await scriptedTurn(run, shell(idleCommand(120, marker), { background: true }));
          await expect.poll(() => liveCount(marker), { timeout: 20_000 }).toBeGreaterThan(0);
          await stopChild(run.child, "SIGKILL");
          const orphans = processesCarrying(marker);
          expect(orphans.length).toBeGreaterThan(0);
          expect(orphans.every((entry) => entry.ppid === 1)).toBe(true);
        });
      });
    },
    120_000,
  );

  // #3901 AC3: Keiko reads the run's background jobs through the producer's own `shell.list`, so the
  // run is held while one runs and a turn interrupt stops it with `shell.remove`.
  const runTree = (run: Run): NativeSessionTreeRun => ({
    sessionId: run.sessionId,
    workspaceRoot: run.fixture.workspace,
    children: new Set(),
  });

  it.skipIf(skip)(
    "holds the run's tree while its background job runs and releases it once the job ended",
    async () => {
      await withProcessMarker(async (marker) => {
        await withRun({ mode: "autonomous-delivery" }, async (run) => {
          await scriptedTurn(run, shell(idleCommand(3, marker), { background: true }));
          await settledIdle(run);
          const status = createNativeTreeStatusPort({
            runId: RUN_ID,
            client: run.client,
            tree: () => runTree(run),
            activityLog: undefined,
          });
          const signal = AbortSignal.timeout(60_000);
          await expect(status(run.sessionId, signal)).resolves.toBe("held");
          await expect
            .poll(() => status(run.sessionId, signal), { timeout: 45_000, interval: 250 })
            .toBe("terminal");
          await expect(run.client.shells(run.fixture.workspace)).resolves.toEqual([]);
        });
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "stops the run's background job when its turn is interrupted, leaving no process",
    async () => {
      await withProcessMarker(async (marker) => {
        await withRun({ mode: "autonomous-delivery" }, async (run) => {
          await scriptedTurn(run, shell(idleCommand(120, marker), { background: true }));
          await settledIdle(run);
          await expect(run.client.shells(run.fixture.workspace)).resolves.toHaveLength(1);
          expect(processesCarrying(marker).length).toBeGreaterThan(0);

          const outcome = await interruptNativeTree(run.client, runTree(run), {
            signal: AbortSignal.timeout(20_000),
            pause: (signal) =>
              new Promise((resolve) => {
                const timer = setTimeout(() => {
                  resolve(!signal.aborted);
                }, 200);
                signal.addEventListener("abort", () => {
                  clearTimeout(timer);
                  resolve(false);
                });
              }),
            runId: RUN_ID,
            activityLog: undefined,
          });

          expect(outcome).toMatchObject({ stoppedShells: 1, settled: true });
          await expect(run.client.shells(run.fixture.workspace)).resolves.toEqual([]);
          await expect.poll(() => processesCarrying(marker).length, { timeout: 10_000 }).toBe(0);
        });
      });
    },
    120_000,
  );

  // A background job that ends after its turn posts a synthetic message and the runtime starts a
  // model turn on its own. The run's session-tree status lists sessions only, so a pending shell
  // job is invisible to it: the turn this starts is the producer's, not one Keiko armed.
  it.skipIf(skip)(
    "starts a model turn of its own when a background job ends after the turn",
    async () => {
      await withProcessMarker(async (marker) => {
        await withRun({ mode: "autonomous-delivery" }, async (run) => {
          await scriptedTurn(run, shell(idleCommand(2, marker), { background: true }));
          await settledIdle(run);
          const requestsAtIdle = run.gateway.requests.length;
          await expect
            .poll(() => run.gateway.requests.length, { timeout: 30_000 })
            .toBeGreaterThan(requestsAtIdle);
          const messages = await run.client.messages(run.sessionId);
          expect(messages.map((message) => message.type)).toContain("synthetic");
        });
      });
    },
    120_000,
  );
});

// ─── C07: formatters ───────────────────────────────────────────────────────────────────────────

// #3901 (T10): the pinned runtime completes every shell call and reports the command's own exit
// status in the part's metadata; Keiko's history reads it, so a failing project check is a failed
// call and the run's verification evidence, never a success by default.
describe("pinned native OpenCode project checks (T10, #3901)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "reports a failing and a passing project test run with their exit status",
    async () => {
      await withRun({ mode: "autonomous-delivery", approveAsks: true }, async (run) => {
        // A stand-in for the project's test runner (the harness's PATH carries no toolchain): it is
        // read as `npm test` by Keiko's classifier and exits as a real runner would.
        const runner = join(run.fixture.workspace, "bin", "npm");
        mkdirSync(dirname(runner), { recursive: true });
        writeFileSync(
          runner,
          '#!/bin/sh\nif [ "$FAIL" = 1 ]; then echo "1 failing"; exit 1; fi\necho "1 passing"\n',
          { mode: 0o755 },
        );
        expect(await scriptedTurn(run, shell("FAIL=1 ./bin/npm test"))).toMatch(
          /Exited with code 1$/u,
        );
        expect(await scriptedTurn(run, shell("./bin/npm test"))).toContain("1 passing");
        expect(openCodeNativeVerificationKind(["FAIL=1 ./bin/npm test"])).toBe("test");
        const projection = createOpenCodeV2HistoryProjection({
          runId: RUN_ID,
          activityLog: undefined,
          toolProfile: "native",
        });
        const tools = projection
          .project(run.sessionId, await run.client.messages(run.sessionId), undefined)
          .flatMap((event) => projection.takeSignal(event) ?? [])
          .filter((signal) => signal.kind === "tool" && signal.tool === "shell");
        expect(tools).toEqual([
          expect.objectContaining({ state: "failed", exitCode: 1 }),
          expect.objectContaining({ state: "succeeded", exitCode: 0 }),
        ]);
      });
    },
    120_000,
  );

  // #3897 review: the runtime reports one exit status for the whole line. A failing check followed
  // by `; cd .`, `|| cd .` or `| cat` exits zero. The permission check sees the line split into its
  // commands, so only the finished line can show whether that status is the check's own; the run's
  // ledger must stay unverified after an edit until a line whose status is the check's own passes.
  it.skipIf(skip)(
    "counts a line as verification only when its exit status is the check's own",
    async () => {
      await withRun({ mode: "autonomous-delivery", approveAsks: true }, async (run) => {
        const runner = join(run.fixture.workspace, "bin", "npm");
        mkdirSync(dirname(runner), { recursive: true });
        writeFileSync(
          runner,
          '#!/bin/sh\nif [ "$PASS" = 1 ]; then echo "1 passing"; exit 0; fi\necho "1 failing"\nexit 7\n',
          { mode: 0o755 },
        );
        const lines = [
          "./bin/npm test; cd .",
          "./bin/npm test || cd .",
          "./bin/npm test | cat",
          "cd . && ./bin/npm test",
          "./bin/npm test 2>&1",
          "PASS=1 ./bin/npm test",
        ];
        const admitted: (VerificationKind | undefined)[] = [];
        for (const line of lines) {
          const before = run.facade.decisions.length;
          await scriptedTurn(run, shell(line));
          const asked = run.facade.decisions
            .slice(before)
            .filter((decision) => decision.permission === "shell");
          expect(asked).toHaveLength(1);
          admitted.push(openCodeNativeVerificationKind(asked[0]?.resources ?? []));
        }
        // The cause: split into commands, the first two lines look like a plain test run.
        expect(admitted).toEqual(["test", "test", undefined, "test", "test", "test"]);
        const projection = createOpenCodeV2HistoryProjection({
          runId: RUN_ID,
          activityLog: undefined,
          toolProfile: "native",
        });
        const shells = projection
          .project(run.sessionId, await run.client.messages(run.sessionId), undefined)
          .flatMap((event) => projection.takeSignal(event) ?? [])
          .flatMap((signal) => (signal.kind === "tool" && signal.tool === "shell" ? [signal] : []));
        expect(shells.map((signal) => [signal.exitCode, signal.exitStatusCheck])).toEqual([
          [0, undefined],
          [0, undefined],
          [0, undefined],
          [7, "test"],
          [7, "test"],
          [0, "test"],
        ]);
        // The producer's own facts through the native settlement facet into the run's ledger.
        const ledger = new CodingRuntimeRunEffortLedger();
        ledger.begin(RUN_ID);
        const facet = createCodingToolNativeSettlementFacet(undefined, {
          observeEditOutcome: (outcome): void => {
            if (outcome.kind === "applied") ledger.edit(RUN_ID);
          },
          verification: {
            revision: () => ledger.verificationRevision(RUN_ID),
            publish: (result): void => {
              ledger.verification(RUN_ID, result.passed, result.kind, result.editRevision);
            },
          },
        });
        facet.settled({
          messageId: "msg_edit",
          callId: "call_edit",
          tool: "edit",
          state: "succeeded",
        });
        const needs: boolean[] = [];
        shells.forEach((signal, index) => {
          const call = { messageId: signal.messageId ?? "", callId: signal.callId };
          const kind = admitted[index];
          if (kind !== undefined) facet.verificationAdmitted?.(call, kind);
          facet.settled({
            ...call,
            tool: "shell",
            state: signal.state === "failed" ? "failed" : "succeeded",
            ...(signal.exitCode === undefined ? {} : { exitCode: signal.exitCode }),
            ...(signal.exitStatusCheck === undefined
              ? {}
              : { exitStatusCheck: signal.exitStatusCheck }),
          });
          needs.push(ledger.needsVerification(RUN_ID));
        });
        expect(needs).toEqual([true, true, true, true, true, false]);
      });
    },
    120_000,
  );
});

// ─── T10/T11: the project's own toolchain (#3901 AC1) ──────────────────────────────────────────

// The native shell runs the host's real executables when the launcher's `PATH` names them, opened
// as production opens that `PATH`. In Full access a dependency install reaches the project's
// registry (on loopback here) and a generation script runs with what it installed; below Full the
// runtime's package manager stays offline, so the same install fails at once instead of reaching
// out. The project's own Vitest fails, is repaired through a native edit and passes.
describe("pinned native OpenCode with the project's own toolchain (#3901 AC1)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const NODE_BIN = dirname(process.execPath);
  const REPOSITORY_MODULES = fileURLToPath(new URL("../../../../node_modules", import.meta.url));
  const DEPENDENCY = "keiko-fixture-dep";
  const TARBALL = `/${DEPENDENCY}/-/${DEPENDENCY}-1.0.0.tgz`;

  /** The one package the project's registry serves, packed as npm packs it. */
  function packedDependency(): Buffer {
    const root = mkdtempSync(join(tmpdir(), "keiko-native-registry-"));
    try {
      mkdirSync(join(root, "package"));
      writeFileSync(
        join(root, "package", "package.json"),
        JSON.stringify({ name: DEPENDENCY, version: "1.0.0", type: "module", main: "index.js" }),
      );
      writeFileSync(
        join(root, "package", "index.js"),
        'export const greeting = "hello from the registry";\n',
      );
      const packed = spawnSync("/usr/bin/tar", ["-czf", "package.tgz", "package"], { cwd: root });
      if (packed.status !== 0) throw new Error("fixture-pack-failed");
      return readFileSync(join(root, "package.tgz"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function startRegistry(): Promise<Stub> {
    const tarball = packedDependency();
    return startStub((self, recorded, response) => {
      if (recorded.url === `/${DEPENDENCY}`) {
        const base = `http://127.0.0.1:${String(self.port)}`;
        const version = {
          name: DEPENDENCY,
          version: "1.0.0",
          type: "module",
          main: "index.js",
          dist: {
            tarball: `${base}${TARBALL}`,
            integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
            shasum: createHash("sha1").update(tarball).digest("hex"),
          },
        };
        const packument = { name: DEPENDENCY, "dist-tags": { latest: "1.0.0" } };
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ...packument, versions: { "1.0.0": version } }));
      } else if (recorded.url === TARBALL) {
        response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(tarball);
      } else {
        response.writeHead(404, { "Content-Type": "application/json" }).end("{}");
      }
    });
  }

  /** The packages the repository installed for Vitest, copied as a project's own install. */
  function provisionVitest(fixture: Fixture): void {
    const target = join(fixture.workspace, "node_modules");
    for (const relative of vitestClosure())
      cpSync(join(REPOSITORY_MODULES, relative), join(target, relative), {
        recursive: true,
        verbatimSymlinks: true,
      });
    mkdirSync(join(target, ".bin"), { recursive: true });
    symlinkSync("../vitest/vitest.mjs", join(target, ".bin", "vitest"));
  }

  /** Vitest and every package it needs, as top-level paths under `node_modules`. */
  function vitestClosure(): readonly string[] {
    const seen = new Set<string>();
    const visit = (directory: string): void => {
      if (seen.has(directory)) return;
      seen.add(directory);
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly optionalDependencies?: Readonly<Record<string, string>>;
      };
      for (const name of Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      })) {
        const found = installedPackage(name, directory);
        if (found !== undefined) visit(found);
      }
    };
    visit(join(REPOSITORY_MODULES, "vitest"));
    return [...seen]
      .map((directory) => directory.slice(REPOSITORY_MODULES.length + 1))
      .filter((relative) => !relative.includes("/node_modules/"));
  }

  function installedPackage(name: string, from: string): string | undefined {
    for (let directory = from; directory.startsWith(REPOSITORY_MODULES);) {
      const candidate = join(directory, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return candidate;
      directory = dirname(directory);
    }
    const top = join(REPOSITORY_MODULES, name);
    return existsSync(join(top, "package.json")) ? top : undefined;
  }

  /** A project with a generation script that imports the dependency it installs. */
  function generatingProject(): Readonly<Record<string, string>> {
    return {
      "package.json": JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        private: true,
        scripts: { generate: "node scripts/generate.mjs" },
      }),
      "scripts/generate.mjs": [
        `import { greeting } from "${DEPENDENCY}";`,
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(`src/generated.js`, `export const greeting = ${JSON.stringify(greeting)};\\n`);",
        "",
      ].join("\n"),
      "src/index.js": "export {};\n",
    };
  }

  /** The install line: a project's `.npmrc` is a denied sensitive file, so the registry is named. */
  function installLine(registry: Stub): string {
    const url = `http://127.0.0.1:${String(registry.port)}/`;
    return `npm install --no-audit --no-fund --registry=${url} ${DEPENDENCY}@1.0.0`;
  }

  it.skipIf(skip)(
    "installs a dependency in Full access and runs a generation script with it",
    async () => {
      const registry = await startRegistry();
      try {
        const files = generatingProject();
        await withRun(
          { mode: "autonomous-delivery", toolchainPath: NODE_BIN, files },
          async (run) => {
            const workspace = run.fixture.workspace;
            await scriptedTurn(run, shell(installLine(registry)));
            expect(
              (
                JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")) as {
                  readonly dependencies?: unknown;
                }
              ).dependencies,
            ).toEqual({ [DEPENDENCY]: "^1.0.0" });
            expect(existsSync(join(workspace, "node_modules", DEPENDENCY, "index.js"))).toBe(true);
            expect(registry.requests.map((request) => request.url)).toEqual(
              expect.arrayContaining([`/${DEPENDENCY}`, TARBALL]),
            );
            await scriptedTurn(run, shell("npm run generate"));
            expect(readFileSync(join(workspace, "src", "generated.js"), "utf8")).toBe(
              'export const greeting = "hello from the registry";\n',
            );
            // Full access runs both without a per-action approval.
            expect(
              run.facade.decisions
                .filter((decision) => decision.permission === "shell")
                .map((decision) => decision.effect),
            ).toEqual(["allow", "allow"]);
          },
        );
      } finally {
        await closeStub(registry);
      }
    },
    180_000,
  );

  it.skipIf(skip)(
    "keeps the package manager offline below Full access, so an install fails without a request",
    async () => {
      const registry = await startRegistry();
      try {
        await withRun({ toolchainPath: NODE_BIN, files: generatingProject() }, async (run) => {
          const result = await scriptedTurn(run, shell(installLine(registry)));
          expect(result).toContain("ENOTCACHED");
          expect(existsSync(join(run.fixture.workspace, "node_modules", DEPENDENCY))).toBe(false);
          // Only npm's own update check may ask; the dependency was never fetched.
          expect(registry.requests.map((request) => request.url)).not.toEqual(
            expect.arrayContaining([`/${DEPENDENCY}`]),
          );
          expect(registry.requests.map((request) => request.url)).not.toContain(TARBALL);
        });
      } finally {
        await closeStub(registry);
      }
    },
    180_000,
  );

  it.skipIf(skip)(
    "runs the project's own Vitest, repairs the failure through a native edit and passes on the rerun",
    async () => {
      const vitest = JSON.parse(
        readFileSync(join(REPOSITORY_MODULES, "vitest", "package.json"), "utf8"),
      ) as { readonly version: string };
      const files = {
        "package.json": JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          private: true,
          type: "module",
          scripts: { test: "vitest run" },
          devDependencies: { vitest: vitest.version },
        }),
        "src/sum.js": "export const sum = (a, b) => a - b;\n",
        "src/sum.test.js": [
          'import { expect, it } from "vitest";',
          'import { sum } from "./sum.js";',
          'it("adds", () => {',
          "  expect(sum(2, 3)).toBe(5);",
          "});",
          "",
        ].join("\n"),
      };
      await withRun({ toolchainPath: NODE_BIN, prepare: provisionVitest, files }, async (run) => {
        const red = await scriptedTurn(run, shell("npm test"));
        expect(red).toMatch(/Tests\s+1 failed/u);
        await scriptedTurn(run, {
          name: "edit",
          arguments: { path: "src/sum.js", oldString: "a - b", newString: "a + b" },
        });
        const green = await scriptedTurn(run, shell("npm test"));
        expect(green).toMatch(/Tests\s+1 passed/u);
        // Keiko reads both runs as the project's test check, the evidence its ledger weighs.
        const checks = run.facade.decisions
          .filter((decision) => decision.permission === "shell")
          .map((decision) => openCodeNativeVerificationKind(decision.resources));
        expect(checks).toEqual(["test", "test"]);
      });
    },
    240_000,
  );
});

// ─── C03: repository instructions (#3900 AC3) ──────────────────────────────────────────────────

// The project layer stays off, so the producer does not discover the workspace's AGENTS.md itself.
// Keiko's bounded copy of it sits in the producer's own global instruction slot, which its
// instruction plugin watches from launch, so a refreshed or newly created copy reaches the next
// turn, and the original read tool still adds a nested AGENTS.md it walks past.
describe("pinned native OpenCode repository instructions (C03, #3900 AC3)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  /** What production's secure read answers for the run's own workspace, read plainly here. */
  function workspaceSource(fixture: Fixture): SecureWorkspaceTextReadPort {
    return {
      readText: ({ relativePath }) =>
        Promise.resolve({
          ok: true,
          text: readFileSync(join(fixture.workspace, relativePath), "utf8"),
        }),
    };
  }

  function instructionsPort(
    fixture: Fixture,
  ): ReturnType<typeof createCodingRuntimeRepositoryInstructionsPort> {
    return createCodingRuntimeRepositoryInstructionsPort({
      enabled: true,
      delivery: "native-instructions",
      source: workspaceSource(fixture),
      activityLog: undefined,
    });
  }

  // Credential canaries (r4369385467), split so no contiguous literal sits in the source.
  const CANARY = "ghp_" + "QUALIFICATIONCANARY0123456789ABCDEFGH";
  const SECOND_CANARY = "AKIA" + "QUALCANARY000042";

  function copyText(run: Run): string {
    return readFileSync(openCodeRepositoryInstructionsPath(run.fixture.state), "utf8");
  }

  function requestText(run: Run, from: number): string {
    return JSON.stringify(run.gateway.requests.slice(from).map((request) => request.body));
  }

  it.skipIf(skip)(
    "loads Keiko's copy, refreshes it before the next turn and adds a nested AGENTS.md the read reaches",
    async () => {
      let materialize = (): Promise<boolean> => Promise.resolve(false);
      const files = {
        "AGENTS.md": `ROOT-RULE-ONE\nGITHUB_TOKEN=${CANARY}\n`,
        "src/AGENTS.md": "NESTED-RULE\n",
        "src/a.ts": "export const a = 1;\n",
      };
      await withRun(
        {
          files,
          prepare: async (fixture) => {
            const port = instructionsPort(fixture);
            const request = {
              runId: RUN_ID,
              isRunWorkspace: (): boolean => true,
              targetPath: openCodeRepositoryInstructionsPath(fixture.state),
            };
            materialize = (): Promise<boolean> => port.materializeForRun(request);
            expect(await materialize()).toBe(true);
          },
        },
        async (run) => {
          await scriptedTurn(run, read("src/a.ts"));
          const first = JSON.stringify(run.gateway.requests[0]?.body);
          // Exactly Keiko's copy, once: the producer did not discover the workspace file itself.
          expect(first.split("ROOT-RULE-ONE").length - 1).toBe(1);
          expect(first).toContain("copied by Keiko");
          // The read of src/a.ts walked past src/AGENTS.md: a later call of the turn carries it.
          expect(requestText(run, 1)).toContain("NESTED-RULE");

          expect(copyText(run)).not.toContain(CANARY);
          writeFileSync(
            join(run.fixture.workspace, "AGENTS.md"),
            `ROOT-RULE-TWO\naws_access_key_id = ${SECOND_CANARY}\n`,
          );
          // What the composition does before every turn.
          expect(await materialize()).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const before = run.gateway.requests.length;
          await scriptedTurn(run, read("src/a.ts"));
          // The producer keeps its system prompt stable and announces the change as its own
          // system update carrying the new copy.
          const messages =
            (run.gateway.requests[before]?.body as { messages?: { content: unknown }[] })
              .messages ?? [];
          const update = messages
            .map((message) => JSON.stringify(message.content))
            .find((content) => content.includes("The instructions changed"));
          expect(update).toContain("ROOT-RULE-TWO");
          expect(update).not.toContain("ROOT-RULE-ONE");
          // Neither credential left the run: not in the copy, not in any outgoing model request.
          expect(copyText(run)).not.toContain(SECOND_CANARY);
          expect(requestText(run, 0)).not.toContain(CANARY);
          expect(requestText(run, 0)).not.toContain(SECOND_CANARY);
        },
      );
    },
    180_000,
  );

  // `/init` (C02) writes the workspace's first AGENTS.md during a run: the copy Keiko writes before
  // the next turn lands in the slot the producer has watched since launch.
  it.skipIf(skip)(
    "loads an AGENTS.md created during the run once Keiko copies it before the next turn",
    async () => {
      let materialize = (): Promise<boolean> => Promise.resolve(false);
      await withRun(
        {
          files: { "src/a.ts": "export const a = 1;\n" },
          prepare: async (fixture) => {
            const port = createCodingRuntimeRepositoryInstructionsPort({
              enabled: true,
              delivery: "native-instructions",
              source: {
                readText: ({ relativePath }) => {
                  const path = join(fixture.workspace, relativePath);
                  return Promise.resolve(
                    existsSync(path)
                      ? { ok: true, text: readFileSync(path, "utf8") }
                      : { ok: false, reason: "not-found" },
                  );
                },
              },
              activityLog: undefined,
            });
            const request = {
              runId: RUN_ID,
              isRunWorkspace: (): boolean => true,
              targetPath: openCodeRepositoryInstructionsPath(fixture.state),
            };
            materialize = (): Promise<boolean> => port.materializeForRun(request);
            expect(await materialize()).toBe(false);
          },
        },
        async (run) => {
          await scriptedTurn(run, read("src/a.ts"));
          expect(requestText(run, 0)).not.toContain("CREATED-RULE");
          writeFileSync(
            join(run.fixture.workspace, "AGENTS.md"),
            `CREATED-RULE\nGITHUB_TOKEN=${CANARY}\n`,
          );
          expect(await materialize()).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const before = run.gateway.requests.length;
          await scriptedTurn(run, read("src/a.ts"));
          expect(requestText(run, before)).toContain("CREATED-RULE");
          expect(copyText(run)).not.toContain(CANARY);
          expect(requestText(run, 0)).not.toContain(CANARY);
        },
      );
    },
    180_000,
  );

  /** Production's secure read for the run's workspace, with the native listing the patterns use. */
  function listingWorkspaceSource(fixture: Fixture): SecureWorkspaceTextReadPort {
    const nativeFileIO: SecureWorkspaceNativeFileIO = {
      readBytes: () => Promise.reject(new Error("fixture-unused")),
      stat: () => Promise.reject(new Error("fixture-unused")),
      list: ({ relativePath }) => {
        const directory = join(fixture.workspace, relativePath);
        if (!existsSync(directory)) return Promise.resolve({ ok: false, reason: "not-found" });
        const info = statSync(directory);
        return Promise.resolve({
          ok: true,
          entries: readdirSync(directory, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
          })),
          info: { type: "directory", size: info.size, mtimeMs: info.mtimeMs },
        } as Awaited<ReturnType<SecureWorkspaceNativeFileIO["list"]>>);
      },
    };
    return {
      nativeFileIO,
      readText: ({ relativePath }): ReturnType<SecureWorkspaceTextReadPort["readText"]> => {
        const path = join(fixture.workspace, relativePath);
        return Promise.resolve(
          existsSync(path)
            ? { ok: true, text: readFileSync(path, "utf8") }
            : { ok: false, reason: "not-found" },
        );
      },
    };
  }

  /** The port production composes for a native run, its home being the fixture's root. */
  function discoveringPort(
    fixture: Fixture,
  ): ReturnType<typeof createCodingRuntimeRepositoryInstructionsPort> {
    return createCodingRuntimeRepositoryInstructionsPort({
      enabled: true,
      delivery: "native-instructions",
      source: listingWorkspaceSource(fixture),
      activityLog: undefined,
      discovery: {
        workspaceRoot: fixture.workspace,
        home: fixture.root,
        globalConfigDirectory: globalOpenCodeConfigDirectory({}, fixture.root),
      },
    });
  }

  function copyRequest(fixture: Fixture): {
    readonly runId: string;
    readonly isRunWorkspace: () => boolean;
    readonly targetPath: string;
  } {
    return {
      runId: RUN_ID,
      isRunWorkspace: (): boolean => true,
      targetPath: openCodeRepositoryInstructionsPath(fixture.state),
    };
  }

  // #3900 AC3 (auditor 6395392347): the global, ancestor and configured sources a standalone run
  // loads reach the original runtime's model call, each named, in the producer's own order, with
  // credentials masked; a repository-named path outside the workspace stays out.
  it.skipIf(skip)(
    "loads the user's global, the ancestor and the configured instructions Keiko copies",
    async () => {
      await withRun(
        {
          files: {
            "AGENTS.md": "ROOT-RULE\n",
            "docs/style.md": `STYLE-RULE\nGITHUB_TOKEN=${CANARY}\n`,
            "docs/deep/nested.md": "NESTED-RULE\n",
            "opencode.json": JSON.stringify({
              instructions: ["docs/*.md", "docs/**/nested.md", "../outside.md"],
            }),
            "src/a.ts": "export const a = 1;\n",
          },
          prepare: async (fixture) => {
            const config = globalOpenCodeConfigDirectory({}, fixture.root);
            mkdirSync(config, { recursive: true });
            writeFileSync(join(config, "AGENTS.md"), "GLOBAL-RULE\n");
            writeFileSync(join(fixture.root, "AGENTS.md"), "ANCESTOR-RULE\n");
            writeFileSync(join(fixture.root, "outside.md"), "OUTSIDE-CANARY\n");
            expect(await discoveringPort(fixture).materializeForRun(copyRequest(fixture))).toBe(
              true,
            );
          },
        },
        async (run) => {
          await scriptedTurn(run, read("src/a.ts"));
          const first = JSON.stringify(run.gateway.requests[0]?.body);
          const order = ["GLOBAL-RULE", "ROOT-RULE", "ANCESTOR-RULE", "STYLE-RULE", "NESTED-RULE"];
          const positions = order.map((rule) => first.indexOf(rule));
          expect(
            positions.every((position) => position >= 0),
            first,
          ).toBe(true);
          expect([...positions].sort((a, b) => a - b)).toEqual(positions);
          expect(first).toContain("copied by Keiko");
          expect(first).toContain("docs/style.md, named by an instructions setting");
          expect(requestText(run, 0)).not.toContain(CANARY);
          expect(requestText(run, 0)).not.toContain("OUTSIDE-CANARY");
        },
      );
    },
    180_000,
  );

  // #3900 AC3: the original `init` command writes the workspace's AGENTS.md through the native
  // write tool; Keiko's refresh before the next turn copies it into the slot the producer has
  // watched since launch, and that next native turn carries it.
  it.skipIf(skip)(
    "runs init, which creates AGENTS.md, and the next native turn carries the new instructions",
    async () => {
      let materialize = (): Promise<boolean> => Promise.resolve(false);
      await withRun(
        {
          mode: "autonomous-delivery",
          files: { "src/a.ts": "export const a = 1;\n" },
          prepare: async (fixture) => {
            const port = discoveringPort(fixture);
            materialize = (): Promise<boolean> => port.materializeForRun(copyRequest(fixture));
            expect(await materialize()).toBe(false);
          },
        },
        async (run) => {
          run.gateway.calls.push({
            name: "write",
            arguments: { path: "AGENTS.md", content: "INIT-CREATED-RULE\n" },
          });
          const before = run.gateway.requests.length;
          await run.client.command(run.sessionId, "init", "");
          await expect
            .poll(() => run.gateway.requests.length, { timeout: 60_000 })
            .toBeGreaterThanOrEqual(before + 2);
          await settledIdle(run);
          // The init template reached the model, and the native write created the file.
          expect(requestText(run, before)).toContain("AGENTS.md");
          expect(readFileSync(join(run.fixture.workspace, "AGENTS.md"), "utf8")).toBe(
            "INIT-CREATED-RULE\n",
          );
          expect(requestText(run, before)).not.toContain("copied by Keiko");
          // What the composition does before every turn.
          expect(await materialize()).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const next = run.gateway.requests.length;
          await scriptedTurn(run, read("src/a.ts"));
          expect(requestText(run, next)).toContain("INIT-CREATED-RULE");
        },
      );
    },
    180_000,
  );
});

// ─── T20: code intelligence (#3900 AC4) ────────────────────────────────────────────────────────

// The pinned producer carries the `lsp` configuration schema but no language-server client and no
// `lsp` tool, so a configured server is a legacy setting, not a capability Keiko withholds: in Full
// access, the widest mode, a configured server never starts around native writes, edits and reads.
describe("pinned native OpenCode code intelligence (T20, #3900 AC4)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const MARKER = "lsp-started.marker";
  const START = `echo started >> ${MARKER}`;

  it.skipIf(skip)(
    "starts no configured language server and registers no lsp tool, while the command itself runs",
    async () => {
      await withRun(
        {
          mode: "autonomous-delivery",
          plugins: REGISTRY_PROBE,
          overlay: {
            lsp: { probe: { command: ["/bin/sh", "-c", START], extensions: [".ts"] } },
          },
        },
        async (run) => {
          const marker = join(run.fixture.workspace, MARKER);
          const results = [
            await scriptedTurn(run, {
              name: "write",
              arguments: { path: "src/probe.ts", content: "export const probe: number = 1;\n" },
            }),
            await scriptedTurn(run, {
              name: "edit",
              arguments: { path: "src/probe.ts", oldString: "= 1", newString: "= 2" },
            }),
            await scriptedTurn(run, read("src/probe.ts")),
          ];
          for (const result of results) expect(result).not.toMatch(/diagnostic|lsp/iu);
          expect(registeredToolIds(run)).not.toContain("lsp");
          expect(existsSync(marker)).toBe(false);
          // Positive control: the same command runs under this mode's confinement when asked to.
          await scriptedTurn(run, shell(`/bin/sh -c '${START}'`));
          expect(readFileSync(marker, "utf8")).toBe("started\n");
        },
      );
    },
    120_000,
  );
});

describe("pinned native OpenCode formatters (C07)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const files = {
    "package.json": JSON.stringify({ name: "fixture", devDependencies: { prettier: "3.0.0" } }),
    "src/messy.ts": "const   a  =  {b:1}\n",
    // A prettier a formatter could pick up from the project, were it to look there.
    "node_modules/.bin/prettier": '#!/bin/sh\necho LOCAL-PRETTIER-RAN > "$2"\n',
  };
  const EDIT: ScriptedCall = {
    name: "edit",
    arguments: { path: "src/messy.ts", oldString: "b:1", newString: "b:2" },
  };

  interface EditOutcome {
    readonly content: string;
    readonly registryRequests: readonly string[];
    readonly ms: number;
  }

  /** Runs the one native edit with a registry stub on loopback and reports what it did. */
  async function editWith(overrides: Partial<LaunchOptions>): Promise<EditOutcome> {
    const registry = await startStub((_self, _recorded, response) => {
      response.writeHead(404, { "Content-Type": "application/json" }).end("{}");
    });
    try {
      let outcome = { content: "", ms: 0 };
      await withRun(
        {
          ...overrides,
          files,
          env: { npm_config_registry: `http://127.0.0.1:${String(registry.port)}/` },
        },
        async (run) => {
          const started = Date.now();
          expect(await scriptedTurn(run, EDIT)).toBe("Edited src/messy.ts (1 replacement)");
          outcome = {
            content: readFileSync(join(run.fixture.workspace, "src/messy.ts"), "utf8"),
            ms: Date.now() - started,
          };
        },
      );
      return { ...outcome, registryRequests: registry.requests.map((request) => request.url) };
    } finally {
      await closeStub(registry);
    }
  }

  // The setting itself is the server's, by launch mode: `opencodeNativeFormatter.real.test.ts` proves
  // Full access (a built-in runs, a repository's own prettier never does, with its positive control)
  // and the two narrower modes. Supervised, the production launch here, runs none.
  it.skipIf(skip)(
    "runs no formatter after a native edit in Supervised workspace and asks no registry",
    async () => {
      const edited = await editWith({});
      expect(edited.content).toBe("const   a  =  {b:2}\n");
      expect(edited.registryRequests).toEqual([]);
    },
    120_000,
  );
});

// ─── C04: MCP servers from the operator's registry ─────────────────────────────────────────────

// A stdio MCP server: `echo` answers, `wipe` writes a marker (it must never run unadmitted), and at
// start it records the names of the environment it was given.
const MCP_FIXTURE_SERVER = String.raw`
const { writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
writeFileSync("mcp-env.json", JSON.stringify(Object.keys(process.env).sort()));
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const tools = [
  { name: "echo", description: "Echoes text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "wipe", description: "Writes a marker", inputSchema: { type: "object", properties: {} } },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
  else if (msg.method === "tools/list") out({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  else if (msg.method === "prompts/list") out({ jsonrpc: "2.0", id: msg.id, result: { prompts: [{ name: "triage", description: "Triage the workspace" }] } });
  else if (msg.method === "prompts/get") out({ jsonrpc: "2.0", id: msg.id, result: { messages: [{ role: "user", content: { type: "text", text: "MCP-PROMPT-CANARY triage the workspace" } }] } });
  else if (msg.method === "tools/call" && msg.params.name === "wipe") { writeFileSync("WIPED", "x"); out({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "wiped" }] } }); }
  else if (msg.method === "tools/call") out({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ECHO:" + msg.params.arguments.text }] } });
  else if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`;

describe("pinned native OpenCode MCP servers from the operator's registry (C04, #3903)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const server = (fixture: Fixture): readonly McpServerDefinition[] => [
    {
      name: "fixture",
      description: undefined,
      enabled: true,
      transport: {
        kind: "local",
        command: [process.execPath, join(fixture.workspace, "mcp-server.cjs")],
        environment: { FIXTURE_MODE: "qualification" },
      },
      // `wipe` is deliberately not named: the registry admits `echo` alone.
      tools: { echo: "read" },
    },
  ];
  const mcpLaunch = (mode: Mode, approveAsks: boolean): Partial<LaunchOptions> => ({
    mode,
    approveAsks,
    files: {
      [FIXTURE_FILE]: "native qualification fixture\n",
      "mcp-server.cjs": MCP_FIXTURE_SERVER,
    },
    mcpServers: server,
  });
  const viaCodeMode = (code: string): ScriptedCall => ({ name: "execute", arguments: { code } });
  // The runtime starts a location's MCP servers lazily, on its first use, and registers their tools
  // shortly after it reports them connected: wait until Code Mode itself lists the server.
  async function connected(run: Run): Promise<void> {
    await expect
      .poll(
        async () => {
          const listed = object(await run.raw("/api/mcp"))?.data;
          return Array.isArray(listed) ? JSON.stringify(listed) : "";
        },
        { timeout: 20_000 },
      )
      .toContain('"connected"');
    await expect
      .poll(
        async () => await scriptedTurn(run, viaCodeMode("return Object.keys(tools).join(',');")),
        { timeout: 20_000, interval: 250 },
      )
      .toContain("fixture");
    run.facade.decisions.length = 0;
  }

  it.skipIf(skip)(
    "admits a registry-named MCP tool through Code Mode from an emptied environment",
    async () => {
      await withRun(mcpLaunch("autonomous-delivery", true), async (run) => {
        await connected(run);
        const result = await scriptedTurn(
          run,
          viaCodeMode('return await tools.fixture.echo({ text: "hello" });'),
        );
        expect(result).toContain("ECHO:hello");
        expect(run.facade.decisions).toContainEqual(
          expect.objectContaining({ permission: "fixture_echo", effect: "allow" }),
        );
        // The server started from `env -i`: none of Keiko's capabilities or the service password,
        // only its own variables (macOS adds `__CF_USER_TEXT_ENCODING` to every process).
        const names = JSON.parse(
          readFileSync(join(run.fixture.workspace, "mcp-env.json"), "utf8"),
        ) as string[];
        expect(names.filter((name) => name !== "__CF_USER_TEXT_ENCODING")).toEqual([
          "FIXTURE_MODE",
          "HOME",
          "PATH",
        ]);
      });
    },
    120_000,
  );

  // C02/C04, #3903 AC3: an admitted server's prompt is one of the runtime's own commands, and it
  // runs as a turn whose model request carries the server's prompt text.
  it.skipIf(skip)(
    "lists an admitted server's prompt as a command and runs it as a turn",
    async () => {
      await withRun(mcpLaunch("autonomous-delivery", true), async (run) => {
        await connected(run);
        const listed = (await run.client.commands()).map((command) => command.name);
        const prompt = listed.find((name) => name.includes("triage"));
        expect(prompt, listed.join(",")).toBeDefined();
        const before = run.gateway.requests.length;
        run.gateway.calls.push({ name: "read", arguments: { path: FIXTURE_FILE } });
        await run.client.command(run.sessionId, prompt ?? "", "");
        await expect
          .poll(() => run.gateway.requests.length, { timeout: 60_000 })
          .toBeGreaterThan(before);
        expect(JSON.stringify(run.gateway.requests[before]?.body)).toContain("MCP-PROMPT-CANARY");
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "refuses an MCP tool the registry does not name, and the server never runs it",
    async () => {
      await withRun(mcpLaunch("autonomous-delivery", true), async (run) => {
        await connected(run);
        await scriptedTurn(run, viaCodeMode("return await tools.fixture.wipe({});"));
        expect(run.facade.decisions).toContainEqual(
          expect.objectContaining({
            permission: "fixture_wipe",
            effect: "deny",
            reason: "unsupported-action",
          }),
        );
        expect(existsSync(join(run.fixture.workspace, "WIPED"))).toBe(false);
      });
    },
    120_000,
  );

  // Ask for approval asks before Code Mode itself and again before the MCP tool; the human here
  // approves both, so the tool's own ask is what the run shows.
  it.skipIf(skip)(
    "asks before an admitted MCP read tool in Ask for approval",
    async () => {
      await withRun(mcpLaunch("governed-assist", true), async (run) => {
        await connected(run);
        const result = await scriptedTurn(
          run,
          viaCodeMode('return await tools.fixture.echo({ text: "hello" });'),
        );
        expect(run.facade.decisions).toContainEqual(
          expect.objectContaining({ permission: "fixture_echo", effect: "ask" }),
        );
        expect(result).toContain("ECHO:hello");
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "control: without the registry the same server is not configured at all",
    async () => {
      await withRun(
        {
          mode: "autonomous-delivery",
          approveAsks: true,
          files: { "mcp-server.cjs": MCP_FIXTURE_SERVER },
        },
        async (run) => {
          await run.raw("/api/mcp");
          await expect
            .poll(async () => JSON.stringify(object(await run.raw("/api/mcp"))?.data), {
              timeout: 3_000,
            })
            .toBe("[]");
          expect(existsSync(join(run.fixture.workspace, "mcp-env.json"))).toBe(false);
        },
      );
    },
    120_000,
  );
});

// ─── Code Mode session move (#3903 AC4) ────────────────────────────────────────────────────────

// Code Mode's `session_move` with Keiko's policy present: the run's own session may move inside the
// task workspace, and the run's tree follows it there, so a background job the moved session starts
// is still the run's and stops with its turn. Every other target is refused and moves nothing.
describe("pinned native OpenCode Code Mode session move and worktree creation (#3903 AC4)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const move = (input: Readonly<Record<string, unknown>>): ScriptedCall => ({
    name: "execute",
    arguments: { code: `return await tools.opencode.session_move(${JSON.stringify(input)});` },
  });
  const files = { "src/a.ts": "export const a = 1;\n" };

  function workspaceGit(fixture: Fixture, ...args: string[]): string {
    const git = resolveDarwinGitExecutable();
    const result = spawnSync(git.path, ["-C", fixture.workspace, ...args], {
      encoding: "utf8",
      env: {
        HOME: fixture.state,
        PATH: dirname(git.path),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
    if (result.status !== 0) throw new Error("fixture-git-failed");
    return result.stdout;
  }

  function commitWorkspace(fixture: Fixture): void {
    workspaceGit(fixture, "add", "-A");
    workspaceGit(fixture, "commit", "-q", "-m", "fixture");
  }

  /** Every worktree of the fixture repository, the main one first. */
  function worktreeList(fixture: Fixture): readonly string[] {
    return workspaceGit(fixture, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => realpathSync(line.slice("worktree ".length)));
  }

  async function directoryOf(run: Run, sessionId = run.sessionId): Promise<unknown> {
    const session = (await run.client.sessions()).find((entry) => entry.id === sessionId);
    return object(object(session)?.location)?.directory;
  }

  const pause = (signal: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(!signal.aborted);
      }, 200);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

  it.skipIf(skip)(
    "moves the run's own session inside the workspace, and the tree stops the job it starts there",
    async () => {
      await withProcessMarker(async (marker) => {
        await withRun({ mode: "autonomous-delivery", files }, async (run) => {
          const src = join(run.fixture.workspace, "src");
          await scriptedTurn(run, move({ directory: src }));
          expect(run.facade.decisions).toContainEqual(
            expect.objectContaining({
              permission: "opencode_session_move",
              resources: [src],
              effect: "allow",
            }),
          );
          await settledIdle(run);
          await expect.poll(() => directoryOf(run), { timeout: 10_000 }).toBe(src);
          // What the composition does with that allow (`admittedSessionMove`).
          const tree: NativeSessionTreeRun = {
            sessionId: run.sessionId,
            workspaceRoot: run.fixture.workspace,
            children: new Set(),
            locations: new Set(),
          };
          expect(admitNativeSessionLocation(tree, src)).toBe(true);
          // A relative path now resolves in the session's new directory.
          expect(await scriptedTurn(run, read("a.ts"))).toContain("export const a = 1;");
          await scriptedTurn(run, shell(idleCommand(120, marker), { background: true }));
          await settledIdle(run);
          // The runtime lists the job under the moved directory alone: without the tree following
          // the move, the run would not find it.
          await expect(run.client.shells(run.fixture.workspace)).resolves.toEqual([]);
          await expect(run.client.shells(src)).resolves.toHaveLength(1);

          const outcome = await interruptNativeTree(run.client, tree, {
            signal: AbortSignal.timeout(20_000),
            pause,
            runId: RUN_ID,
            activityLog: undefined,
          });

          expect(outcome).toMatchObject({ stoppedShells: 1, settled: true });
          await expect(run.client.shells(src)).resolves.toEqual([]);
          await expect.poll(() => processesCarrying(marker).length, { timeout: 10_000 }).toBe(0);
        });
      });
    },
    180_000,
  );

  // `worktree_create` (#3903 AC4) is a delivery-scoped ask in every mode: the hook hands the policy
  // its name, and a refusal keeps the producer from adding any worktree. An approved one is
  // provisioned by the managed owner, never by this call (composition test, "Code Mode worktree
  // creation through the managed owner").
  it.skipIf(skip)(
    "asks before a new worktree, even in Full access, and a refusal adds no worktree",
    async () => {
      await withRun({ mode: "autonomous-delivery", approveAsks: false, files }, async (run) => {
        commitWorkspace(run.fixture);
        const result = await scriptedTurn(run, {
          name: "execute",
          arguments: {
            code: 'return await tools.opencode.worktree_create({ name: "feature-x" });',
          },
        });
        expect(run.facade.decisions).toContainEqual(
          expect.objectContaining({
            permission: "opencode_worktree_create",
            resources: ["feature-x"],
            effect: "ask",
          }),
        );
        expect(result).toContain("approval-required");
        expect(worktreeList(run.fixture)).toEqual([run.fixture.workspace]);
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "refuses another session, a place outside, a link, a missing or relative directory, and moves nothing",
    async () => {
      await withRun(
        {
          mode: "autonomous-delivery",
          files,
          prepare: (fixture): void => {
            mkdirSync(join(fixture.root, "outside"));
            symlinkSync(join(fixture.root, "outside"), join(fixture.workspace, "escape"));
          },
        },
        async (run) => {
          const src = join(run.fixture.workspace, "src");
          const other = await run.client.createSession(run.fixture.workspace);
          if (typeof other.id !== "string") throw new TypeError("fixture-session-invalid");
          const refusals: readonly [Readonly<Record<string, unknown>>, string][] = [
            [{ sessionID: other.id, directory: src }, "unsupported-action"],
            [{ directory: join(run.fixture.root, "outside") }, "workspace-escape"],
            [{ directory: join(run.fixture.workspace, "escape") }, "workspace-escape"],
            [{ directory: join(run.fixture.workspace, "gone") }, "workspace-escape"],
            [{ directory: "src" }, "unsupported-action"],
          ];
          for (const [input, reason] of refusals) {
            run.facade.decisions.length = 0;
            const result = await scriptedTurn(run, move(input));
            expect(result, JSON.stringify(input)).toContain("Keiko refused this action");
            expect(run.facade.decisions).toContainEqual(
              expect.objectContaining({
                permission: "opencode_session_move",
                effect: "deny",
                reason,
              }),
            );
            await settledIdle(run);
          }
          expect(await directoryOf(run)).toBe(run.fixture.workspace);
          expect(await directoryOf(run, other.id)).toBe(run.fixture.workspace);
        },
      );
    },
    180_000,
  );
});

// ─── accepted external references (#3900 AC5) ──────────────────────────────────────────────────

// A directory the operator accepted (`KEIKO_CODING_EXTERNAL_READ_ROOTS`) is readable through the
// original read tool as an `external-file` action of the run's mode, never writable; its credential
// files, a hard link in it and a symlink out of it stay unreadable, and nothing else outside the
// workspace opens.
describe("pinned native OpenCode accepted external references (C08, #3900 AC5)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  function reference(fixture: Fixture): string {
    return join(fixture.root, "reference", "docs");
  }

  function prepareReference(fixture: Fixture): void {
    const root = reference(fixture);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "guide.md"), "EXTERNAL-GUIDE-CANARY\n");
    writeFileSync(join(root, ".env"), "TOKEN=EXTERNAL-CREDENTIAL-CANARY\n");
    writeFileSync(join(fixture.root, "secret.txt"), "OUTSIDE-REFERENCE-CANARY\n");
    symlinkSync(join(fixture.root, "secret.txt"), join(root, "escape.txt"));
    linkSync(join(fixture.root, "secret.txt"), join(root, "aliased.txt"));
  }

  it.skipIf(skip)(
    "reads an accepted reference in Full access and nothing it must not read or write",
    async () => {
      await withRun(
        {
          mode: "autonomous-delivery",
          prepare: prepareReference,
          externalReadRoots: reference,
        },
        async (run) => {
          const root = reference(run.fixture);
          expect(await scriptedTurn(run, read(join(root, "guide.md")))).toContain(
            "EXTERNAL-GUIDE-CANARY",
          );
          // The producer's own reference feature names it, in its listing and to the model.
          const listed = JSON.stringify(await run.raw("/api/reference"));
          expect(listed).toContain("external-1");
          expect(listed).toContain(root);
          const told = JSON.stringify(run.gateway.requests[0]?.body);
          expect(told).toContain("external-1");
          expect(told).toContain(root);
          expect(run.facade.decisions).toContainEqual(
            expect.objectContaining({ permission: "external_directory", effect: "allow" }),
          );
          for (const name of [".env", "escape.txt", "aliased.txt"]) {
            const result = await scriptedTurn(run, read(join(root, name)));
            expect(result, name).not.toContain("CANARY");
          }
          run.facade.decisions.length = 0;
          await scriptedTurn(run, {
            name: "write",
            arguments: { path: join(root, "new.md"), content: "written\n" },
          });
          expect(existsSync(join(root, "new.md"))).toBe(false);
          // The write reached the policy and was refused there, not lost to a malformed call.
          expect(run.facade.decisions.some((decision) => decision.effect === "deny")).toBe(true);
          expect(await scriptedTurn(run, read(join(run.fixture.root, "secret.txt")))).not.toContain(
            "OUTSIDE-REFERENCE-CANARY",
          );
        },
      );
    },
    240_000,
  );

  it.skipIf(skip)(
    "asks before an external read in Supervised workspace, and a refusal reads nothing",
    async () => {
      await withRun(
        {
          mode: "supervised-coding",
          approveAsks: false,
          prepare: prepareReference,
          externalReadRoots: reference,
        },
        async (run) => {
          const result = await scriptedTurn(run, read(join(reference(run.fixture), "guide.md")));
          expect(result).not.toContain("EXTERNAL-GUIDE-CANARY");
          expect(run.facade.decisions).toContainEqual(
            expect.objectContaining({ permission: "external_directory", effect: "ask" }),
          );
        },
      );
    },
    240_000,
  );

  it.skipIf(skip)(
    "control: without an accepted reference the same read stays outside the workspace",
    async () => {
      await withRun({ mode: "autonomous-delivery", prepare: prepareReference }, async (run) => {
        const result = await scriptedTurn(run, read(join(reference(run.fixture), "guide.md")));
        expect(result).not.toContain("EXTERNAL-GUIDE-CANARY");
      });
    },
    240_000,
  );
});

// ─── original webfetch and websearch (T14, T15, #3903 AC3) ──────────────────────────────────────

// The original `webfetch` is internet use: in Full access the policy allows it with inherited egress
// and the producer fetches; below Full access the policy refuses at once with an explanation and the
// kernel reaches loopback only. The page here is a fixture-owned loopback listener.
describe("pinned native OpenCode webfetch and websearch (T14, T15, #3903 AC3)", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  async function withPage(body: (url: string, page: Stub) => Promise<void>): Promise<void> {
    const page = await startStub((_self, _recorded, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" }).end("WEBFETCH-PAGE-CANARY\n");
    });
    try {
      await body(`http://127.0.0.1:${String(page.port)}/notes.txt`, page);
    } finally {
      await closeStub(page);
    }
  }

  it.skipIf(skip)(
    "fetches a page in Full access through the policy, as the original tool",
    async () => {
      await withPage(async (url, page) => {
        await withRun({ mode: "autonomous-delivery" }, async (run) => {
          const result = await scriptedTurn(run, {
            name: "webfetch",
            arguments: { url, format: "text" },
          });
          expect(result).toContain("WEBFETCH-PAGE-CANARY");
          expect(page.requests).toHaveLength(1);
          expect(run.facade.decisions).toContainEqual(
            expect.objectContaining({ permission: "webfetch", resources: [url], effect: "allow" }),
          );
        });
      });
    },
    180_000,
  );

  // T15: without a search integration the original websearch would wait on a provider it cannot
  // reach (measured); Keiko refuses it at once, and the turn goes on with the alternative named.
  it.skipIf(skip)(
    "refuses web search at once in Full access, naming webfetch, and the turn goes on",
    async () => {
      await withRun({ mode: "autonomous-delivery" }, async (run) => {
        const result = await scriptedTurn(run, {
          name: "websearch",
          arguments: { query: "keiko coding workbench" },
        });
        expect(result).toContain("web search needs a search integration");
        expect(result).toContain("webfetch");
        expect(run.facade.decisions).toContainEqual(
          expect.objectContaining({
            permission: "websearch",
            effect: "deny",
            reason: "unsupported-action",
          }),
        );
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "refuses a page below Full access with an explanation, and nothing is fetched",
    async () => {
      await withPage(async (url, page) => {
        await withRun({ mode: "supervised-coding" }, async (run) => {
          const result = await scriptedTurn(run, {
            name: "webfetch",
            arguments: { url, format: "text" },
          });
          expect(result).not.toContain("WEBFETCH-PAGE-CANARY");
          expect(result).toContain("only available in Full access");
          expect(page.requests).toHaveLength(0);
          expect(run.facade.decisions).toContainEqual(
            expect.objectContaining({
              permission: "webfetch",
              effect: "deny",
              reason: "mode-denied",
            }),
          );
        });
      });
    },
    180_000,
  );
});
