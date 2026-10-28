import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { isGatewayNativeToolAdvertisement } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import {
  buildOpenCodeLaunchProfile,
  openCodeConfigDirectory,
  openCodePlanDirectory,
} from "./opencodeLaunchProfile.js";
import {
  OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE,
  OPENCODE_NATIVE_DELIVERY_REFUSAL_MESSAGE,
  OPENCODE_NATIVE_DELIVERY_TOOL_NAMES,
} from "./opencodeNativeDeliveryTools.js";
import {
  decideOpenCodeNativePolicy,
  parseOpenCodeNativePolicyRequest,
  type OpenCodeNativePolicyDecision,
} from "./opencodeNativePolicy.js";
import { awaitOpenCodeNativePlugins } from "./opencodeNativePluginReadiness.js";
import { mintProposalId } from "../gitDelivery/proposalId.js";
import { CODING_TOOL_MAX_BODY_BYTES, parseCodingToolRequest } from "./codingToolIpc.js";
import {
  createOpenCodeNativeToolAdvertisement,
  hasExactOpenCodeVisibleToolContract,
} from "./opencodeToolSchemas.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import { createOpenCodeV2HttpClient, type OpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

import {
  writeNativeHttpStreamedTurn,
  startNativeHttpStub as startStub,
  withNativeHttpStub,
  type NativeHttpStub as Stub,
} from "../../../../tests/support/opencode-native-http.js";
import {
  nativeChildEndpoint as childEndpoint,
  withNativeChild,
} from "../../../../tests/support/opencode-native-child.js";

/**
 * Original-runtime proof of Git delivery for native runs (#3897, T12/B1): the pinned OpenCode loads
 * Keiko's generated delivery plugin beside the policy and context plugins, advertises exactly
 * Keiko's delivery tools to the model, runs a scripted delivery call through the tool facade with
 * the identical wire body a mapped run sends, and still refuses a shell `git commit` with the
 * message that points the model to those tools. The facade is a fixture listener that answers the
 * policy hook with the REAL server-owned policy (`decideOpenCodeNativePolicy`), so every verdict
 * below is the production verdict. The pinned executable runs under the real native Seatbelt
 * wrapper with the profile `buildOpenCodeLaunchProfile` produces. Run with
 * KEIKO_OPENCODE_REAL_BINARY and KEIKO_OPENCODE_REAL_RESOURCE_ROOT set; otherwise it is skipped.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const GATEWAY_CAPABILITY = "fixture-gateway-capability";
const FACADE_CAPABILITY = "fixture-facade-capability";
const RUN_ID = "run-native-delivery";
const FIXTURE_FILE = "README.md";

interface ScriptedCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface GatewayStub extends Stub {
  toolTurns: number;
  call: ScriptedCall;
}

interface FacadeStub extends Stub {
  mode: CodingWorkbenchMode;
  workspace: string;
  planRoot: string;
  /** The server-owned policy's decision for each native permission the hook asked about. */
  readonly decisions: OpenCodeNativePolicyDecision[];
  readonly asked: { readonly permission: string; readonly resources: readonly string[] }[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function lastRole(body: unknown): unknown {
  const messages = object(body)?.messages;
  return Array.isArray(messages) ? object(messages.at(-1))?.role : undefined;
}

function streamedTurn(response: ServerResponse, delta: unknown, finish: string): void {
  writeNativeHttpStreamedTurn(response, delta, finish, "native-delivery");
}

async function startGateway(): Promise<GatewayStub> {
  const stub = await startStub((self, recorded, response) => {
    const gateway = self as GatewayStub;
    if (gateway.toolTurns > 0 && lastRole(recorded.body) === "user") {
      gateway.toolTurns -= 1;
      const call = {
        index: 0,
        id: `call_delivery_${String(self.requests.length)}`,
        type: "function",
        function: { name: gateway.call.name, arguments: JSON.stringify(gateway.call.arguments) },
      };
      streamedTurn(response, { tool_calls: [call] }, "tool_calls");
      return;
    }
    streamedTurn(response, { content: "Fixture turn completed." }, "stop");
  });
  return Object.assign(stub, { toolTurns: 0, call: { name: "read", arguments: {} } });
}

/** What the fixture facade returns for a delivery request: the canonical result envelope. */
const FACADE_TOOL_RESULT = {
  status: "completed",
  evidence: [{ kind: "fixture-delivery", code: "recorded" }],
} as const;

function answerPolicy(facade: FacadeStub, body: unknown, response: ServerResponse): void {
  const request = parseOpenCodeNativePolicyRequest(body);
  const json = (value: unknown): void => {
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  };
  if (request === undefined) {
    json({ effect: "deny", message: "fixture: malformed policy request" });
    return;
  }
  facade.asked.push({ permission: request.permission, resources: request.resources });
  const decision = decideOpenCodeNativePolicy({
    mode: facade.mode,
    workspaceRoot: facade.workspace,
    planRoot: facade.planRoot,
    request,
    nowMs: Date.now(),
  });
  facade.decisions.push(decision);
  // An `ask` would wait for the operator in production; the fixture records it and lets it pass
  // so a test can tell an unexpected approval from a verdict.
  json(
    decision.effect === "deny"
      ? { effect: "deny", message: decision.message }
      : { effect: "allow" },
  );
}

async function startFacade(fixture: Fixture, mode: CodingWorkbenchMode): Promise<FacadeStub> {
  const stub = await startStub((self, recorded, response) => {
    const facade = self as FacadeStub;
    const action = object(recorded.body)?.action;
    if (action === "native-policy") {
      answerPolicy(facade, recorded.body, response);
      return;
    }
    // A governed approval ask (`permission-request`) and a delivery request both answer 200.
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(action === "permission-request" ? {} : FACADE_TOOL_RESULT));
  });
  return Object.assign(stub, {
    mode,
    workspace: fixture.workspace,
    planRoot: openCodePlanDirectory(fixture.state),
    decisions: [],
    asked: [],
  });
}

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
}

function createFixture(): Fixture {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "keiko-native-delivery-"));
  try {
    const root = realpathSync(temporaryRoot);
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, FIXTURE_FILE), "native delivery fixture\n");
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
  } catch (error) {
    try {
      rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture-root-cleanup-failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

/** Runs Git in the fixture workspace with a hermetic identity; returns status and output. */
function workspaceGit(
  fixture: Fixture,
  ...args: string[]
): { readonly status: number | null; readonly stdout: string } {
  const git = resolveDarwinGitExecutable();
  const result = spawnSync(git.path, ["-C", fixture.workspace, ...args], {
    env: {
      HOME: fixture.state,
      PATH: dirname(git.path),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout };
}

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
}

interface LaunchOptions {
  /** `on` loads a throwaway observation plugin beside the generated ones (never product code). */
  readonly probe: "on" | "off";
  /** `absent` is the negative control: the delivery plugin is never written. */
  readonly deliveryPlugin: "present" | "absent";
}

function materializePrivateConfiguration(
  state: string,
  config: string,
  options: LaunchOptions,
): void {
  const configRoot = join(state, "config", "opencode");
  for (const path of [
    join(configRoot, "plugins"),
    join(state, "home"),
    join(state, "state"),
    join(state, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(configRoot, "opencode.json"), config, { mode: 0o600 });
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native"))) {
    if (name === OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE && options.deliveryPlugin === "absent")
      continue;
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
  }
  if (options.probe === "on")
    writeFileSync(join(configRoot, "plugins", "keiko_probe.ts"), probePluginSource(state), {
      mode: 0o600,
    });
}

function launch(
  fixture: Fixture,
  binary: string,
  runtimeRoot: string,
  stubs: { readonly gateway: Stub; readonly facade: FacadeStub },
  options: LaunchOptions,
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
  materializePrivateConfiguration(fixture.state, profile.config, options);
  const git = resolveDarwinGitExecutable();
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
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
        PATH: `${dirname(git.path)}:/usr/bin:/bin`,
        KEIKO_MODEL_GATEWAY_URL: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
        KEIKO_MODEL_GATEWAY_CAPABILITY: GATEWAY_CAPABILITY,
        KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(stubs.facade.port)}/facade`,
        KEIKO_TOOL_FACADE_CAPABILITY: FACADE_CAPABILITY,
        KEIKO_CODING_RUN_ID: RUN_ID,
        KEIKO_CODING_MODE: stubs.facade.mode,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

interface Service {
  readonly client: OpenCodeV2HttpClient;
  request(method: "GET" | "POST", path: string): Promise<unknown>;
}

function serviceAt(endpoint: string, password: string): Service {
  const authorization = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
  return {
    client: createOpenCodeV2HttpClient({ endpoint, password }),
    request: async (method, path): Promise<unknown> => {
      const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: { Authorization: authorization },
      });
      if (!response.ok) throw new Error(`fixture-request-failed:${String(response.status)}`);
      return response.status === 204 ? undefined : ((await response.json()) as unknown);
    },
  };
}

/**
 * A throwaway observation plugin (never product code): it records what the supported hooks
 * receive for a call, ahead of Keiko's policy plugin, so a test can name the permission the
 * producer evaluates for a plugin tool.
 */
function probePluginSource(state: string): string {
  const log = JSON.stringify(join(state, "tmp", "probe.jsonl"));
  return [
    'import { appendFileSync } from "node:fs";',
    `const LOG = ${log};`,
    "function record(entry) { appendFileSync(LOG, JSON.stringify(entry) + String.fromCharCode(10)); }",
    "export default {",
    '  id: "keiko.probe",',
    "  async setup(ctx) {",
    '    await ctx.permission.hook("evaluate", (event) => {',
    '      record({ hook: "permission.evaluate", action: event.action, resources: event.resources, configured: event.effect, agent: event.agent ?? null, metadata: event.metadata ?? null });',
    "    });",
    '    await ctx.tool.hook("execute.before", (event) => {',
    '      record({ hook: "tool.execute.before", tool: event.tool, agent: event.agent ?? null, input: event.input });',
    "    });",
    "  },",
    "};",
  ].join("\n");
}

interface ProbeEntry {
  readonly hook: string;
  readonly tool?: string;
  readonly action?: string;
  readonly [key: string]: unknown;
}

interface Run {
  readonly fixture: Fixture;
  readonly gateway: GatewayStub;
  readonly facade: FacadeStub;
  readonly service: Service;
  readonly sessionId: string;
}

function probeLog(run: Run): readonly ProbeEntry[] {
  try {
    return readFileSync(join(run.fixture.state, "tmp", "probe.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ProbeEntry);
  } catch {
    return [];
  }
}

async function withRun(
  overrides: Partial<LaunchOptions> & { readonly mode?: CodingWorkbenchMode },
  body: (run: Run) => Promise<void>,
): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const options: LaunchOptions = { probe: "off", deliveryPlugin: "present", ...overrides };
  const binary = BINARY;
  const resourceRoot = RESOURCE_ROOT;
  const fixture = createFixture();
  try {
    const gateway = await startGateway();
    await withNativeHttpStub(gateway, async (): Promise<void> => {
      const facade = await startFacade(fixture, overrides.mode ?? "governed-assist");
      await withNativeHttpStub(facade, async (): Promise<void> => {
        const launched = launch(
          fixture,
          realpathSync(binary),
          realpathSync(resourceRoot),
          { gateway, facade },
          options,
        );
        await withNativeChild(launched.child, async (): Promise<void> => {
          const service = serviceAt(await childEndpoint(launched.child), launched.password);
          expect((await service.client.info()).version).toBe(OPENCODE_PINNED_VERSION);
          const session = await service.client.createSession(fixture.workspace);
          if (typeof session.id !== "string") throw new Error("fixture-session-invalid");
          await body({ fixture, gateway, facade, service, sessionId: session.id });
        });
      });
    });
  } catch (error) {
    try {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture-root-cleanup-failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  // The runtime may still be flushing its state when the child exits; retry the removal.
  rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** The tool names the runtime advertised to the model in its first request of the run. */
function advertisedTools(gateway: Stub): readonly Record<string, unknown>[] {
  const tools = object(gateway.requests[0]?.body)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool: unknown) => {
    const declaration = object(object(tool)?.function);
    return declaration === undefined ? [] : [declaration];
  });
}

function advertisedToolNames(gateway: Stub): readonly string[] {
  return advertisedTools(gateway).flatMap((tool) =>
    typeof tool.name === "string" ? [tool.name] : [],
  );
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

/** Runs one scripted turn and returns what the model received as the tool result. */
async function scriptedTurn(run: Run, call: ScriptedCall, prompt: string): Promise<string> {
  const before = run.gateway.requests.length;
  run.gateway.call = call;
  run.gateway.toolTurns = 1;
  await run.service.client.prompt(run.sessionId, prompt);
  await expect
    .poll(() => run.gateway.requests.length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before + 2);
  return lastToolResult(run.gateway);
}

/** A scripted call to a delivery tool, with the arguments a model would send. */
const COMMIT_PROPOSAL: ScriptedCall = {
  name: "keiko_git_commit",
  arguments: { message: "feat: add delivery" },
};

function deliveryNames(names: readonly string[]): readonly string[] {
  return names.filter((name) => name.startsWith("keiko_")).sort();
}

/** The definitions the gateway received for the run's first provider request. */
function advertisedDefinitions(
  gateway: Stub,
): readonly { name: string; description: string; parameters: Record<string, unknown> }[] {
  return advertisedTools(gateway).flatMap((tool) => {
    const { name, description, parameters } = tool;
    const schema = object(parameters);
    return typeof name === "string" && typeof description === "string" && schema !== undefined
      ? [{ name, description, parameters: schema }]
      : [];
  });
}

/** The system prompt of the model's first request. */
function firstSystemPrompt(gateway: Stub): string {
  const messages = object(gateway.requests[0]?.body)?.messages;
  if (!Array.isArray(messages)) return "";
  const system = object(messages[0]);
  return system?.role === "system" && typeof system.content === "string" ? system.content : "";
}

/** The tools of every provider request issued since `from`, by request. */
function toolListsSince(gateway: Stub, from: number): readonly (readonly string[])[] {
  return gateway.requests.slice(from).map((recorded) => {
    const tools = object(recorded.body)?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool: unknown) => {
      const name = object(object(tool)?.function)?.name;
      return typeof name === "string" ? [name] : [];
    });
  });
}

describe("pinned native OpenCode Git delivery tools", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "loads the delivery plugin and advertises exactly Keiko's delivery tools beside OpenCode's own",
    async () => {
      await withRun({}, async (run) => {
        const ready = await awaitOpenCodeNativePlugins(
          (signal) => run.service.client.plugins(signal),
          join(openCodeConfigDirectory(run.fixture.state), "plugins"),
          undefined,
          25,
        );
        expect(ready).toBe(true);
        await scriptedTurn(run, { name: "read", arguments: { path: FIXTURE_FILE } }, "Read it.");
        const names = advertisedToolNames(run.gateway);
        expect(deliveryNames(names)).toEqual([...OPENCODE_NATIVE_DELIVERY_TOOL_NAMES].sort());
        expect(names).toEqual(expect.arrayContaining(["read", "edit", "shell", "execute"]));
        // The tool contract the gateway admits for this very advertisement (ADR-0175 D2).
        const definitions = advertisedDefinitions(run.gateway);
        expect(hasExactOpenCodeVisibleToolContract(definitions, "native")).toBe(true);
        const advertisement = createOpenCodeNativeToolAdvertisement(
          definitions,
          Date.now(),
          60_000,
        );
        expect(advertisement.tools.map((tool) => tool.name)).toEqual(names);
        expect(isGatewayNativeToolAdvertisement(advertisement)).toBe(true);
        const commit = definitions.find((tool) => tool.name === "keiko_git_commit");
        expect(commit?.parameters).toMatchObject({
          type: "object",
          required: ["message"],
          properties: { message: { type: "string" } },
        });
        // Code Mode keeps none of them: the model reaches Keiko's tools only as top-level calls.
        const prompt = firstSystemPrompt(run.gateway);
        expect(prompt).toContain("tools.opencode.");
        expect(prompt).not.toContain("tools.keiko_");
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "control: without the delivery plugin the run is not ready and the model is offered no Keiko tool",
    async () => {
      await withRun({ deliveryPlugin: "absent" }, async (run) => {
        const ready = await awaitOpenCodeNativePlugins(
          (signal) => run.service.client.plugins(signal),
          join(openCodeConfigDirectory(run.fixture.state), "plugins"),
          undefined,
          25,
        );
        expect(ready).toBe(false);
        await scriptedTurn(run, { name: "read", arguments: { path: FIXTURE_FILE } }, "Read it.");
        expect(deliveryNames(advertisedToolNames(run.gateway))).toEqual([]);
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "sends a scripted delivery call to the facade as the mapped wire body, with no permission asked",
    async () => {
      await withRun({ probe: "on" }, async (run) => {
        const result = await scriptedTurn(run, COMMIT_PROPOSAL, "Propose the commit.");
        expect(JSON.parse(result)).toEqual(FACADE_TOOL_RESULT);
        const delivery = run.facade.requests.filter(
          (recorded) => object(recorded.body)?.action !== "native-policy",
        );
        expect(delivery).toHaveLength(1);
        const [sent] = delivery;
        expect(sent?.url).toBe("/facade");
        expect(sent?.authorization).toBe(`Bearer ${FACADE_CAPABILITY}`);
        const body = object(sent?.body);
        const callId = body?.actionId;
        expect(callId).toMatch(new RegExp(`^${run.sessionId}:call_delivery_\\d+$`, "u"));
        expect(body).toEqual({
          action: "delivery",
          actionId: callId,
          idempotencyKey: callId,
          intent: "commit",
          phase: "propose",
          message: "feat: add delivery",
        });
        expect(
          parseCodingToolRequest(JSON.stringify(body), CODING_TOOL_MAX_BODY_BYTES)?.action,
        ).toBe("delivery");
        // The producer asserted no permission for the plugin tool, so the policy hook was never
        // asked and cannot have added an approval of its own; authority is the facade's alone.
        expect(run.facade.asked).toEqual([]);
        expect(probeLog(run).some((entry) => entry.hook === "permission.evaluate")).toBe(false);
        expect(probeLog(run)).toEqual([
          expect.objectContaining({ hook: "tool.execute.before", tool: "keiko_git_commit" }),
        ]);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "redeems a proposal and observes CI through the same facade, one request per call",
    async () => {
      await withRun({ mode: "autonomous-delivery" }, async (run) => {
        const proposalId = mintProposalId("commit");
        await scriptedTurn(
          run,
          { name: "keiko_git_execute", arguments: { kind: "commit", proposalId } },
          "Redeem the commit.",
        );
        await scriptedTurn(
          run,
          {
            name: "keiko_git_execute",
            arguments: { kind: "stage", proposalId: mintProposalId("stage") },
          },
          "Redeem the staging.",
        );
        await scriptedTurn(
          run,
          { name: "keiko_ci_status", arguments: { forceFresh: false } },
          "Observe CI.",
        );
        const bodies = run.facade.requests
          .map((recorded) => object(recorded.body))
          .filter((body) => body?.action !== "native-policy");
        expect(bodies).toMatchObject([
          { action: "delivery", intent: "commit", phase: "execute", proposalId },
          { action: "git", operation: "stage", phase: "execute" },
          { action: "git", operation: "ci", forceFresh: false },
        ]);
        expect(run.facade.asked).toEqual([]);
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "still refuses a shell Git write in the real policy and points the model to the delivery tools",
    async () => {
      await withRun({ mode: "supervised-coding" }, async (run) => {
        for (const command of [
          'git commit --allow-empty -m "shell commit"',
          "git push origin HEAD",
          "gh pr create --fill",
        ]) {
          const result = await scriptedTurn(
            run,
            { name: "shell", arguments: { command, description: "Deliver the change" } },
            "Run the command.",
          );
          expect(result).toContain(OPENCODE_NATIVE_DELIVERY_REFUSAL_MESSAGE);
        }
        // Nothing ran: the repository has no commit, and no delivery request reached the facade.
        expect(workspaceGit(run.fixture, "rev-parse", "--verify", "HEAD").status).not.toBe(0);
        expect(existsSync(join(run.fixture.workspace, ".git", "COMMIT_EDITMSG"))).toBe(false);
        expect(
          run.facade.decisions.filter(
            (decision) => decision.effect === "deny" && decision.reason === "delivery-reserved",
          ),
        ).toHaveLength(3);
        expect(
          run.facade.requests.filter((r) => object(r.body)?.action !== "native-policy"),
        ).toEqual([]);
        // The read-only form of the same program stays available.
        const status = await scriptedTurn(
          run,
          { name: "shell", arguments: { command: "git status --short", description: "Status" } },
          "Show the status.",
        );
        expect(status).toContain(FIXTURE_FILE);
        expect(status).not.toContain("Keiko refused");
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "keeps Keiko's tools out of Code Mode and away from the read-only explore subagent",
    async () => {
      await withRun({ mode: "autonomous-delivery" }, async (run) => {
        const program = await scriptedTurn(
          run,
          {
            name: "execute",
            arguments: { code: "return await tools.keiko_git_status({});" },
          },
          "Run the program.",
        );
        expect(program).toContain("Unknown tool");
        expect(run.facade.requests.filter((r) => object(r.body)?.action === "git")).toEqual([]);
        const before = run.gateway.requests.length;
        await scriptedTurn(
          run,
          {
            name: "subagent",
            arguments: { agent: "explore", description: "Look around", prompt: "List the files." },
          },
          "Delegate.",
        );
        await expect
          .poll(() => toolListsSince(run.gateway, before).length, { timeout: 30_000 })
          .toBeGreaterThanOrEqual(3);
        const lists = toolListsSince(run.gateway, before);
        const child = lists.find((tools) => tools.length > 0 && !tools.includes("subagent"));
        // The explore agent's `*` denial hides the plugin tools it was never granted.
        expect(child).toEqual(expect.arrayContaining(["read", "grep"]));
        expect(deliveryNames(child ?? [])).toEqual([]);
        expect(deliveryNames(lists[0] ?? [])).toEqual(
          [...OPENCODE_NATIVE_DELIVERY_TOOL_NAMES].sort(),
        );
      });
    },
    180_000,
  );
});
