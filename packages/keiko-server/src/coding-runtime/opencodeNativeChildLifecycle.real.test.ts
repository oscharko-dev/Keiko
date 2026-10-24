import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { buildOpenCodeLaunchProfile, openCodeConfigDirectory } from "./opencodeLaunchProfile.js";
import { createNativeQuestionPort, type NativeQuestionPort } from "./opencodeNativeQuestions.js";
import {
  createNativeTreeStatusPort,
  interruptNativeTree,
  type NativeSessionTreeRun,
} from "./opencodeNativeSessionTree.js";
import {
  createGeneratedOpenCodeV2Plugins,
  createOpenCodeRuntimeAdapter,
  type OpenCodeRuntimeAdapter,
} from "./opencodeRuntimeAdapter.js";
import { coalescedSyncHints, v2SyncHint } from "./opencodeRuntimeComposition.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";
import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";

/**
 * Original-runtime proof of the native session tree (#3897 review, PR #4064): the pinned OpenCode
 * 2.1.4 runs under the real native Seatbelt wrapper with the profile `buildOpenCodeLaunchProfile`
 * produces, behind a scripted Model Gateway. Keiko's own production owners are driven against it:
 * the runtime adapter with the history projection, the live-event hints and the session-tree status
 * port wired as the composition wires them, the session-tree interrupt fan-out, and the native
 * question port. A subagent launched in the background outlives its parent's idle message and its
 * report restarts the parent; a child can fail, be cancelled or ask the human a question; a question
 * the human refuses ends the turn without an idle message. Run with KEIKO_OPENCODE_REAL_BINARY and
 * KEIKO_OPENCODE_REAL_RESOURCE_ROOT set; otherwise it is skipped.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const GATEWAY_CAPABILITY = "fixture-gateway-capability";
const FACADE_CAPABILITY = "fixture-facade-capability";
const RUN_ID = "run-child-lifecycle";
const DIGEST = "a".repeat(64);
const SUBAGENT_REPORT = "<subagent sessionID=";

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── the scripted Model Gateway ────────────────────────────────────────────────────────────────

/** Which session a model request belongs to, read from the task text its prompt carries. */
type Role = "parent" | "child" | "stranger";

interface ModelContext {
  readonly role: Role;
  readonly lastRole: string;
  readonly lastText: string;
}

type ModelPlan =
  | { readonly kind: "tool"; readonly name: string; readonly arguments: unknown }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "deny" }
  | {
      readonly kind: "delay";
      readonly ms: number;
      readonly then: ModelPlan;
      readonly released?: () => void;
    };

interface Gateway {
  readonly server: Server;
  port: number;
  readonly requests: { readonly at: number; readonly role: Role; readonly lastText: string }[];
  script: (context: ModelContext) => ModelPlan;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function modelContext(body: unknown): ModelContext {
  const raw = object(body)?.messages;
  const messages = Array.isArray(raw) ? raw.map(object) : [];
  const all = JSON.stringify(messages);
  let role: Role = "child";
  if (all.includes("PARENT_TASK")) role = "parent";
  else if (all.includes("STRANGER_TASK")) role = "stranger";
  const last = messages.at(-1);
  const content = last?.content;
  return {
    role,
    lastRole: typeof last?.role === "string" ? last.role : "",
    lastText: typeof content === "string" ? content : JSON.stringify(content ?? ""),
  };
}

function planDelta(plan: ModelPlan): unknown {
  if (plan.kind === "tool") {
    return {
      tool_calls: [
        {
          index: 0,
          id: `call_${String(Date.now())}`,
          type: "function",
          function: { name: plan.name, arguments: JSON.stringify(plan.arguments) },
        },
      ],
    };
  }
  return { content: plan.kind === "text" ? plan.text : "" };
}

function writePlan(plan: ModelPlan, response: ServerResponse): void {
  if (plan.kind === "deny") {
    response
      .writeHead(401, { "Content-Type": "application/json" })
      .end(
        JSON.stringify({ error: { type: "authentication_error", message: "SYNTHETIC_DENIED" } }),
      );
    return;
  }
  const chunk = (delta: unknown, finish: string | null, usage?: unknown): string =>
    frame({
      id: "child-lifecycle",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(chunk(planDelta(plan), null));
  response.end(
    chunk({}, plan.kind === "tool" ? "tool_calls" : "stop", {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    }) + "data: [DONE]\n\n",
  );
}

async function respond(plan: ModelPlan, response: ServerResponse): Promise<void> {
  if (plan.kind !== "delay") {
    writePlan(plan, response);
    return;
  }
  await sleep(plan.ms);
  plan.released?.();
  await respond(plan.then, response);
}

async function startGateway(): Promise<Gateway> {
  const gateway: Gateway = {
    server: createServer(),
    port: 0,
    requests: [],
    script: () => ({ kind: "text", text: "done" }),
  };
  gateway.server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    void readBody(request).then(async (text) => {
      const context = modelContext(JSON.parse(text) as unknown);
      gateway.requests.push({ at: Date.now(), role: context.role, lastText: context.lastText });
      await respond(gateway.script(context), response);
    });
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  gateway.port = (gateway.server.address() as { port: number }).port;
  return gateway;
}

/** The policy hook's answer: every action is allowed; the tree is under test, not the policy. */
async function startFacade(): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer((request, response) => {
    void readBody(request).then(() => {
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"effect":"allow"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

// ─── the pinned runtime under the native Seatbelt ──────────────────────────────────────────────

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-child-lifecycle-")));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, "README.md"), "child lifecycle fixture\n");
  const git = resolveDarwinGitExecutable();
  spawnSync(git.path, ["init", "-q", workspace], {
    env: {
      HOME: state,
      PATH: dirname(git.path),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  return { root, workspace, state };
}

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
}

/**
 * The producer's own General and Explore agents cannot ask a question, so the fixture adds one
 * subagent whose rules allow it: the shape of any agent a configuration lets ask.
 */
function fixtureConfiguration(profileConfig: string): string {
  return JSON.stringify({
    ...(JSON.parse(profileConfig) as Record<string, unknown>),
    agents: {
      asker: {
        mode: "subagent",
        description: "Asks the operator one question and reports the answer.",
        permissions: [{ action: "question", resource: "*", effect: "allow" }],
      },
    },
  });
}

function materializePrivateConfiguration(fixture: Fixture, config: string): void {
  const configRoot = join(fixture.state, "config", "opencode");
  for (const path of [
    join(configRoot, "plugins"),
    join(fixture.state, "home"),
    join(fixture.state, "state"),
    join(fixture.state, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(configRoot, "opencode.json"), fixtureConfiguration(config), { mode: 0o600 });
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native")))
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
}

function launch(
  fixture: Fixture,
  binary: string,
  runtimeRoot: string,
  ports: { readonly gateway: number; readonly facade: number },
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
  materializePrivateConfiguration(fixture, profile.config);
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
        KEIKO_MODEL_GATEWAY_URL: gatewayUrl,
        KEIKO_MODEL_GATEWAY_CAPABILITY: GATEWAY_CAPABILITY,
        KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(ports.facade)}/native-policy`,
        KEIKO_TOOL_FACADE_CAPABILITY: FACADE_CAPABILITY,
        KEIKO_CODING_RUN_ID: RUN_ID,
        KEIKO_CODING_MODE: "autonomous-delivery",
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
  readonly gateway: Gateway;
  readonly client: OpenCodeV2HttpClient;
  readonly endpoint: string;
  readonly sessionId: string;
  /** A raw request to the runtime, for what the governed client does not offer (other sessions). */
  readonly raw: (method: string, path: string, payload?: unknown) => Promise<unknown>;
}

async function withRun(body: (run: Run) => Promise<void>): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const fixture = createFixture();
  const gateway = await startGateway();
  const facade = await startFacade();
  const launched = launch(fixture, realpathSync(BINARY), realpathSync(RESOURCE_ROOT), {
    gateway: gateway.port,
    facade: facade.port,
  });
  try {
    const endpoint = await childEndpoint(launched.child);
    const client = createOpenCodeV2HttpClient({ endpoint, password: launched.password });
    expect((await client.info()).version).toBe(OPENCODE_PINNED_VERSION);
    const authorization = `Basic ${Buffer.from(`opencode:${launched.password}`).toString("base64")}`;
    const raw = async (method: string, path: string, payload?: unknown): Promise<unknown> => {
      const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      return response.status === 204 ? undefined : ((await response.json()) as unknown);
    };
    const session = await client.createSession(fixture.workspace);
    if (typeof session.id !== "string") throw new TypeError("fixture-session-invalid");
    await body({ fixture, gateway, client, endpoint, sessionId: session.id, raw });
  } finally {
    await stopChild(launched.child);
    await Promise.all([closeServer(gateway.server), closeServer(facade.server)]);
    // The runtime may still be flushing its state when the child exits; retry the removal.
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// ─── Keiko's production owners wired against the runtime, as the composition wires them ────────

interface Owners {
  readonly adapter: OpenCodeRuntimeAdapter;
  readonly tree: NativeSessionTreeRun;
  readonly activityLog: ReturnType<typeof createBufferedServerLogSink>;
  readonly questions: NativeQuestionPort;
  readonly stop: () => Promise<void>;
}

async function startOwners(run: Run): Promise<Owners> {
  const { client, sessionId } = run;
  const activityLog = createBufferedServerLogSink();
  const tree: NativeSessionTreeRun = {
    sessionId,
    workspaceRoot: run.fixture.workspace,
    children: new Set(),
  };
  const projection = createOpenCodeV2HistoryProjection({
    toolProfile: "native",
    runId: RUN_ID,
    activityLog,
  });
  const adapter = createOpenCodeRuntimeAdapter({
    correlationId: RUN_ID,
    activityLog,
    maxTurnWaitMs: 90_000,
    readiness: {
      verifiedTarget: {
        executable: "/verified/opencode",
        attestationDigest: DIGEST,
        version: OPENCODE_PINNED_VERSION,
      },
      configDigest: DIGEST,
      verifyTargetAttestation: () => Promise.resolve(true),
      materialize: () => Promise.resolve(true),
      startupLine: () => Promise.resolve(`server listening on ${run.endpoint}\n`),
      health: (authorization) =>
        Promise.resolve(
          authorization === "basic"
            ? { status: 200, version: OPENCODE_PINNED_VERSION }
            : { status: 401 },
        ),
      openApiDigest: () => Promise.resolve(DIGEST),
      gatewayChallenge: () => Promise.resolve(true),
      toolFacadeChallenge: () => Promise.resolve(true),
      subscribe: (signal) =>
        coalescedSyncHints(
          client.events(signal),
          (event) => {
            projection.observeLiveEvent(sessionId, event);
            return v2SyncHint(event, sessionId, undefined);
          },
          undefined,
          100,
        ),
      history: async (checkpoints, signal) =>
        projection.project(
          sessionId,
          await client.messages(sessionId, signal),
          checkpoints[sessionId],
        ),
      sessionEcho: () => Promise.resolve(sessionId),
    },
    governedSink: { execute: () => Promise.resolve("applied") },
    control: {
      status: createNativeTreeStatusPort({
        runId: RUN_ID,
        client,
        tree: () => tree,
        activityLog,
      }),
    },
    safety: {
      revokeAudiences: (): void => undefined,
      abortGovernedActions: (): void => undefined,
      wipeEphemeralState: (): void => undefined,
      requireManagerReap: (): void => undefined,
    },
  });
  await expect(adapter.start()).resolves.toMatchObject({ ok: true });
  const stopMonitor = adapter.monitor(() => undefined);
  const questions = createNativeQuestionPort({
    runId: RUN_ID,
    client,
    tree,
    open: () => true,
    activityLog,
    onFailure: () => undefined,
    listed: {},
  });
  return {
    adapter,
    tree,
    activityLog,
    questions,
    stop: async (): Promise<void> => {
      stopMonitor();
      await adapter.close();
    },
  };
}

interface Turn {
  readonly settled: Promise<boolean | "interrupted">;
  /** When the wait ended, once it has. */
  readonly at: () => number | undefined;
}

/** Arms the turn, sends the prompt and returns the wait for the turn's end. */
function startTurn(run: Run, owners: Owners, prompt: string): Turn {
  expect(owners.adapter.armTurn()).toBe(true);
  let settledAt: number | undefined;
  const settled = owners.adapter.waitForTerminal(AbortSignal.timeout(80_000)).then((outcome) => {
    settledAt = Date.now();
    return outcome;
  });
  void run.client.prompt(run.sessionId, prompt);
  return { settled, at: () => settledAt };
}

async function until<Value>(
  read: () => Promise<Value | undefined>,
  timeoutMs = 20_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(40);
  }
  throw new Error("fixture-condition-timeout");
}

/** When the idle messages of a session were written. */
async function idleTimes(run: Run, sessionId = run.sessionId): Promise<readonly number[]> {
  const messages = await run.client.messages(sessionId);
  return messages.flatMap((message) => {
    const created = object(message.time)?.created;
    return message.type === "idle" && typeof created === "number" ? [created] : [];
  });
}

async function firstIdle(run: Run): Promise<number> {
  return await until(async () => (await idleTimes(run))[0]);
}

async function messageSummary(run: Run, sessionId: string): Promise<readonly string[]> {
  return (await run.client.messages(sessionId)).map((message) => {
    const detail = typeof message.outcome === "string" ? message.outcome : undefined;
    const state = object(message.metadata)?.state;
    const label = detail ?? (typeof state === "string" ? state : undefined);
    return label === undefined ? String(message.type) : `${String(message.type)}:${label}`;
  });
}

async function activeIds(run: Run): Promise<readonly string[]> {
  return Object.keys(await run.client.active());
}

async function childSessionId(run: Run): Promise<string> {
  return await until(async () => {
    const child = (await run.client.sessions()).find((entry) => entry.parentID === run.sessionId);
    return typeof child?.id === "string" ? child.id : undefined;
  });
}

async function sessionOutcome(run: Run, sessionId: string): Promise<unknown> {
  return (await run.client.sessions()).find((entry) => entry.id === sessionId)?.outcome;
}

function treeLines(owners: Owners, phase?: string): readonly Record<string, unknown>[] {
  return owners.activityLog.events
    .filter((event) => event.op === "coding-runtime.native-session-tree.observed")
    .flatMap((event) =>
      event.extra !== undefined && (phase === undefined || event.extra.phase === phase)
        ? [event.extra]
        : [],
    );
}

// ─── scripts ───────────────────────────────────────────────────────────────────────────────────

/** The parent launches one subagent and answers once it knows the outcome (result or report). */
function launchingParent(background: boolean, agent: string): (context: ModelContext) => ModelPlan {
  return (context) => {
    if (context.lastText.includes(SUBAGENT_REPORT))
      return { kind: "text", text: "The parent read the subagent's outcome." };
    if (context.lastRole === "tool") return { kind: "text", text: "The parent continued." };
    return {
      kind: "tool",
      name: "subagent",
      arguments: {
        background,
        agent,
        description: "Synthetic child",
        prompt: "CHILD_TASK do the synthetic work.",
      },
    };
  };
}

/** A script for a launching parent whose child reads once, then does `finish` after `delayMs`. */
function backgroundScript(
  delayMs: number,
  finish: ModelPlan,
  released?: () => void,
): (context: ModelContext) => ModelPlan {
  const parent = launchingParent(true, "explore");
  return (context) => {
    if (context.role === "parent") return parent(context);
    if (context.lastRole !== "tool")
      return { kind: "tool", name: "read", arguments: { path: "README.md" } };
    return {
      kind: "delay",
      ms: delayMs,
      then: finish,
      ...(released === undefined ? {} : { released }),
    };
  };
}

const ASK_ARGUMENTS = {
  questions: [
    {
      header: "Colour",
      question: "Which synthetic colour?",
      options: [
        { label: "Blue", description: "First" },
        { label: "Green", description: "Second" },
      ],
    },
  ],
};

const asking = (context: ModelContext): ModelPlan =>
  context.lastRole === "tool"
    ? { kind: "text", text: "Continued after the question." }
    : { kind: "tool", name: "question", arguments: ASK_ARGUMENTS };

const pause = (signal: AbortSignal): Promise<boolean> =>
  signal.aborted ? Promise.resolve(false) : sleep(10).then(() => true);

// ─── the tests ─────────────────────────────────────────────────────────────────────────────────

describe("pinned native OpenCode session tree: background subagents", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;
  const CHILD_DELAY_MS = 4_000;

  it.skipIf(skip)(
    "holds the run until a delayed background child reported back and its parent read the report",
    async () => {
      await withRun(async (run) => {
        let childReleasedAt = 0;
        const owners = await startOwners(run);
        try {
          run.gateway.script = backgroundScript(
            CHILD_DELAY_MS,
            { kind: "text", text: "CHILD_DONE" },
            () => {
              childReleasedAt = Date.now();
            },
          );
          const turn = startTurn(run, owners, "PARENT_TASK launch a background child");
          // The parent answers at once and goes idle; its subagent keeps working.
          const parentIdleAt = await firstIdle(run);
          expect(await activeIds(run)).toHaveLength(1);
          await expect(turn.settled).resolves.toBe(true);
          // Keiko did not consider the run over at the parent's idle message: it waited for the
          // child, and for the parent to read the child's report.
          expect(childReleasedAt).toBeGreaterThan(0);
          expect(turn.at() ?? 0).toBeGreaterThanOrEqual(childReleasedAt);
          expect((turn.at() ?? 0) - parentIdleAt).toBeGreaterThanOrEqual(CHILD_DELAY_MS / 2);
          const reportTurn = run.gateway.requests.find(
            (request) => request.role === "parent" && request.lastText.includes(SUBAGENT_REPORT),
          );
          expect(reportTurn?.at).toBeGreaterThanOrEqual(childReleasedAt);
          expect(await messageSummary(run, run.sessionId)).toEqual([
            "user",
            "assistant",
            "assistant",
            "idle:succeeded",
            "synthetic:completed",
            "assistant",
            "idle:succeeded",
          ]);
          expect(await activeIds(run)).toEqual([]);
          expect(treeLines(owners).map((line) => line.phase)).toEqual(["held", "released"]);
          const projected = owners.activityLog.events.filter(
            (event) => event.op === "coding-runtime.history-projection",
          );
          expect(projected.some((event) => event.extra?.heldIdleCount === 1)).toBe(true);
        } finally {
          await owners.stop();
        }
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "settles once the parent read the report of a child that failed",
    async () => {
      await withRun(async (run) => {
        const owners = await startOwners(run);
        try {
          run.gateway.script = backgroundScript(1_500, { kind: "deny" });
          const turn = startTurn(run, owners, "PARENT_TASK launch a failing background child");
          await expect(turn.settled).resolves.toBe(true);
          const child = await childSessionId(run);
          expect(await messageSummary(run, run.sessionId)).toContain("synthetic:error");
          expect(await sessionOutcome(run, child)).toBe("failed");
          expect(await activeIds(run)).toEqual([]);
        } finally {
          await owners.stop();
        }
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "reaps the whole tree when the turn is stopped: the child is interrupted, not left running",
    async () => {
      await withRun(async (run) => {
        const owners = await startOwners(run);
        try {
          run.gateway.script = backgroundScript(30_000, { kind: "text", text: "never" });
          const turn = startTurn(run, owners, "PARENT_TASK launch a long background child");
          await firstIdle(run);
          const child = await childSessionId(run);
          expect(await activeIds(run)).toContain(child);
          const stoppedAt = Date.now();
          const stopped = await interruptNativeTree(run.client, owners.tree, {
            signal: AbortSignal.timeout(20_000),
            pause,
            runId: RUN_ID,
            activityLog: owners.activityLog,
          });
          expect(stopped).toEqual({ interruptedChildren: 1, settled: true });
          expect(await activeIds(run)).toEqual([]);
          expect(await sessionOutcome(run, child)).toBe("interrupted");
          // The stop took a moment, not the child's scripted thirty seconds.
          expect(Date.now() - stoppedAt).toBeLessThan(10_000);
          await turn.settled;
          expect(treeLines(owners, "interrupted")).toEqual([
            expect.objectContaining({ activeChildCount: 1, ownedChildCount: 1 }),
          ]);
        } finally {
          await owners.stop();
        }
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "is not kept open by a session that is not the run's",
    async () => {
      await withRun(async (run) => {
        const owners = await startOwners(run);
        try {
          const stranger = (await run.raw("POST", "/api/session", {
            location: { directory: run.fixture.workspace },
            agent: "build",
            title: "A session of someone else",
          })) as { readonly data: { readonly id: string } };
          run.gateway.script = (context): ModelPlan =>
            context.role === "stranger"
              ? { kind: "delay", ms: 8_000, then: { kind: "text", text: "stranger done" } }
              : { kind: "text", text: "The parent answered." };
          await run.raw("POST", `/api/session/${stranger.data.id}/prompt`, {
            text: "STRANGER_TASK keep working",
          });
          await until(async () =>
            (await activeIds(run)).includes(stranger.data.id) ? true : undefined,
          );
          const started = Date.now();
          const turn = startTurn(run, owners, "PARENT_TASK answer at once");
          await expect(turn.settled).resolves.toBe(true);
          // The other session was still running when the run ended, and never held it.
          expect(await activeIds(run)).toContain(stranger.data.id);
          expect(Date.now() - started).toBeLessThan(6_000);
          expect(owners.tree.children.size).toBe(0);
        } finally {
          await owners.stop();
        }
      });
    },
    120_000,
  );
});

describe("pinned native OpenCode session tree: questions", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  async function pending(owners: Owners): Promise<Awaited<ReturnType<NativeQuestionPort["list"]>>> {
    return await until(async () => {
      const questions = await owners.questions.list();
      return questions.length > 0 ? questions : undefined;
    });
  }

  it.skipIf(skip)(
    "routes a child's question to the human, answers it through the child and lets both continue",
    async () => {
      await withRun(async (run) => {
        const owners = await startOwners(run);
        try {
          const launching = launchingParent(false, "asker");
          run.gateway.script = (context): ModelPlan =>
            context.role === "parent" ? launching(context) : asking(context);
          const turn = startTurn(run, owners, "PARENT_TASK launch a foreground child that asks");
          const [question] = await pending(owners);
          const child = await childSessionId(run);
          // The form belongs to the child, which a primary-only filter never listed.
          expect(question?.sessionID).toBe(child);
          expect(question?.sessionID).not.toBe(run.sessionId);
          await expect(owners.questions.answer(question?.id ?? "", [["Blue"]])).resolves.toBe(true);
          await expect(turn.settled).resolves.toBe(true);
          // The child received the answer; both sessions ended their turns.
          expect(await messageSummary(run, child)).toEqual([
            "user",
            "assistant",
            "assistant",
            "idle:succeeded",
          ]);
          expect(await messageSummary(run, run.sessionId)).toContain("idle:succeeded");
          expect(await run.client.forms()).toEqual([]);
          const routed = owners.activityLog.events
            .filter((event) => event.op === "coding-runtime.native-question.routed")
            .map((event) => event.extra);
          expect(routed).toEqual([
            expect.objectContaining({ action: "list", childFormCount: 1 }),
            expect.objectContaining({
              action: "answer",
              outcome: "answered",
              sessionRelation: "child",
            }),
          ]);
        } finally {
          await owners.stop();
        }
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "lets the parent continue when the human refuses a child's question",
    async () => {
      await withRun(async (run) => {
        const owners = await startOwners(run);
        try {
          const launching = launchingParent(false, "asker");
          run.gateway.script = (context): ModelPlan =>
            context.role === "parent"
              ? launching(context)
              : { kind: "tool", name: "question", arguments: ASK_ARGUMENTS };
          const turn = startTurn(run, owners, "PARENT_TASK launch a foreground child that asks");
          const [question] = await pending(owners);
          await expect(owners.questions.reject(question?.id ?? "")).resolves.toBe(true);
          // The child's turn is interrupted; the parent reads the failed subagent call and goes on.
          await expect(turn.settled).resolves.toBe(true);
          expect(await activeIds(run)).toEqual([]);
        } finally {
          await owners.stop();
        }
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "denies the forms of a session that is not the run's, whichever way it is reached",
    async () => {
      await withRun(async (run) => {
        const owners = await startOwners(run);
        try {
          run.gateway.script = (context): ModelPlan =>
            context.role === "stranger" ? asking(context) : { kind: "text", text: "unused" };
          // The runtime keeps every session in the run's workspace, so a foreign session is one whose
          // parent chain does not reach the primary: a session of its own, and a child of that one.
          const stranger = (await run.raw("POST", "/api/session", {
            location: { directory: run.fixture.workspace },
            agent: "build",
          })) as { readonly data: { readonly id: string } };
          const strangersChild = (await run.raw("POST", "/api/session", {
            parentID: stranger.data.id,
            location: { directory: run.fixture.workspace },
            agent: "build",
          })) as { readonly data: { readonly id: string } };
          const strangers = [stranger, strangersChild];
          for (const stranger of strangers)
            await run.raw("POST", `/api/session/${stranger.data.id}/prompt`, {
              text: "STRANGER_TASK ask the operator",
            });
          const foreign = await until(async () => {
            const forms = await run.client.forms();
            return forms.length === 2 ? forms : undefined;
          });
          // Nothing of theirs is listed, answered or rejected; the forms stay pending in the runtime.
          await expect(owners.questions.list()).resolves.toEqual([]);
          for (const id of foreign.flatMap((form) =>
            typeof form.id === "string" ? [form.id] : [],
          )) {
            const questionId = `que_${id.slice(4)}`;
            await expect(owners.questions.answer(questionId, [["Blue"]])).resolves.toBe(false);
            await expect(owners.questions.reject(questionId)).resolves.toBe(false);
          }
          expect(await run.client.forms()).toHaveLength(2);
          expect(owners.tree.children.size).toBe(0);
          const routed = owners.activityLog.events
            .filter((event) => event.op === "coding-runtime.native-question.routed")
            .map((event) => event.extra);
          // The list line says the runtime holds two forms and the run owns none of them.
          expect(routed[0]).toMatchObject({ action: "list", formCount: 2, childFormCount: 0 });
          const refusals = routed.flatMap((extra) =>
            extra?.outcome === "refused" ? [extra.refusal] : [],
          );
          expect(refusals).toEqual(Array.from({ length: 4 }, () => "foreign-session"));
        } finally {
          await owners.stop();
        }
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "answers the primary's own question and finishes the turn",
    async () => {
      await withRun(async (run) => {
        const owners = await startOwners(run);
        try {
          run.gateway.script = asking;
          const turn = startTurn(run, owners, "PARENT_TASK ask one question");
          const [question] = await pending(owners);
          expect(question?.sessionID).toBe(run.sessionId);
          await expect(owners.questions.answer(question?.id ?? "", [["Green"]])).resolves.toBe(
            true,
          );
          await expect(turn.settled).resolves.toBe(true);
        } finally {
          await owners.stop();
        }
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "settles a refused primary question at once and releases the next turn",
    async () => {
      await withRun(async (run) => {
        const owners = await startOwners(run);
        try {
          run.gateway.script = (context): ModelPlan =>
            context.lastText.includes("plain follow-up")
              ? { kind: "text", text: "The follow-up is done." }
              : asking(context);
          const turn = startTurn(run, owners, "PARENT_TASK ask one question");
          const [question] = await pending(owners);
          const refusedAt = Date.now();
          await expect(owners.questions.reject(question?.id ?? "")).resolves.toBe(true);
          // The runtime interrupts the turn and writes no idle message: Keiko settles it from the
          // runtime's own interruption, in a fraction of a second, not at the run's deadline.
          await expect(turn.settled).resolves.toBe("interrupted");
          expect((turn.at() ?? Infinity) - refusedAt).toBeLessThan(5_000);
          expect(await idleTimes(run)).toEqual([]);
          expect(await activeIds(run)).toEqual([]);
          expect(
            owners.activityLog.events.filter(
              (event) => event.op === "coding-runtime.native-turn.interrupted",
            ),
          ).toHaveLength(1);
          // The next turn is armed and ends normally: nothing of the refusal is left over.
          const second = startTurn(run, owners, "PARENT_TASK plain follow-up");
          await expect(second.settled).resolves.toBe(true);
        } finally {
          await owners.stop();
        }
      });
    },
    120_000,
  );
});
