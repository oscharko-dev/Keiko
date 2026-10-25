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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import {
  buildOpenCodeLaunchProfile,
  openCodeConfigDirectory,
  OPENCODE_RUNTIME_READINESS_PROMPT,
} from "./opencodeLaunchProfile.js";
import { OPENCODE_PERSISTENCE_SCHEMAS } from "./opencodePersistenceContract.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { projectOpenCodeV2ProtocolSurface } from "./opencodeProtocolSurface.js";
import { OPENCODE_PINNED_VERSION, openCodeRuntimeVersionPin } from "./opencodeRuntimeVersions.js";
import { createCodingSessionContinuity } from "./codingSessionContinuity.js";
import {
  bindContinuedSession,
  retainSettledRun,
  seedContinuation,
  withoutBaseline,
  type RunContinuation,
  type SessionContinuationContext,
} from "./opencodeSessionContinuation.js";
import {
  auditDatabase,
  createRetainedSessionStore,
  retainedSessionKey,
  type RetainedSessionBinding,
  type RetainedSessionStore,
} from "./opencodeSessionRetention.js";
import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";
import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";
import type { CodingHistoryMessage } from "./codingRuntimeHistory.js";

/**
 * Original-runtime proof of native session continuity (S02, S03, #3904, ADR-0137 D10). The pinned
 * executable runs under the real native Seatbelt wrapper with the profile `buildOpenCodeLaunchProfile`
 * produces, behind a scripted Model Gateway stub that records every model request. A run's real
 * runtime database is retained through Keiko's store, a second runtime is started on a copy of it,
 * and the session is resumed or forked through Keiko's own binding. Run with
 * KEIKO_OPENCODE_REAL_BINARY and KEIKO_OPENCODE_REAL_RESOURCE_ROOT set; otherwise it is skipped.
 * KEIKO_OPENCODE_REAL_VERSION selects another admitted version, such as the published 2.0.10 lane;
 * its actual protocol digest and persistence schema must match that version's own contracts.
 */
const RUNTIME_VERSION = process.env.KEIKO_OPENCODE_REAL_VERSION ?? OPENCODE_PINNED_VERSION;
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const GATEWAY_CAPABILITY = "fixture-gateway-capability";
const FACADE_CAPABILITY = "fixture-facade-capability";
const MAX_FIXTURE_BODY_BYTES = 4 * 1_024 * 1_024;
const WORKSPACE_KEY = "a".repeat(64);
const TASK_ID = "task-native-resume";

interface Recorded {
  readonly url: string;
  readonly body: unknown;
}

interface Stub {
  replyText?: string | undefined;
  readonly server: Server;
  port: number;
  readonly requests: Recorded[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function startStub(
  respond: (stub: Stub, recorded: Recorded, response: ServerResponse) => void,
): Promise<Stub> {
  const requests: Recorded[] = [];
  const stub: { server?: Server; port: number; requests: Recorded[] } = { port: 0, requests };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void readRequestBody(request)
      .then((bytes) => {
        let body: unknown;
        try {
          body = JSON.parse(bytes.toString("utf8")) as unknown;
        } catch {
          // A non-JSON body is recorded as text; the assertions only read JSON bodies.
          body = bytes.toString("utf8");
        }
        const recorded = { url: request.url ?? "", body };
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

async function closeStub(stub: Stub): Promise<void> {
  stub.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    stub.server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function streamedText(response: ServerResponse, text: string): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    frame({
      id: "native-resume",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    }),
  );
  response.end(
    frame({
      id: "native-resume",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }) + "data: [DONE]\n\n",
  );
}

/** Answers every model request with a plain text turn that names how many it has seen. */
async function startGateway(): Promise<Stub> {
  return await startStub((self, recorded, response) => {
    const lastUser = userTexts(recorded).at(-1);
    if (lastUser === "FIXTURE-FAILED-TERMINAL-TURN") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end('{"error":{"type":"invalid_request_error","message":"fixture-rejection"}}');
      return;
    }
    if (lastUser === "FIXTURE-CANCELLED-TERMINAL-TURN") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      return;
    }
    streamedText(response, self.replyText ?? `Answer number ${String(self.requests.length)}.`);
  });
}

async function startFacade(): Promise<Stub> {
  return await startStub((_self, _recorded, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"effect":"allow"}');
  });
}

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly otherWorkspace: string;
}

function committedRepository(root: string, workspace: string): void {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "notes.txt"), "resume fixture\n");
  const git = resolveDarwinGitExecutable();
  const env = {
    HOME: root,
    PATH: dirname(git.path),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const identity = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];
  for (const args of [
    ["init", "-q", workspace],
    ["-C", workspace, ...identity, "add", "-A"],
    ["-C", workspace, ...identity, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"],
  ]) {
    if (spawnSync(git.path, args, { env }).status !== 0) throw new Error("fixture-git-failed");
  }
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-resume-")));
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other-workspace");
  committedRepository(root, workspace);
  committedRepository(root, otherWorkspace);
  return { root, workspace, otherWorkspace };
}

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
}

function launch(
  fixture: Fixture,
  stateRoot: string,
  binary: string,
  runtimeRoot: string,
  stubs: { readonly gateway: Stub; readonly facade: Stub },
): Launched {
  const profile = buildOpenCodeLaunchProfile({
    executable: binary,
    stateRoot,
    toolProfile: "native",
    contextGeometry: {
      contextWindowTokens: 32_768,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_096,
    },
  });
  if (!profile.ok) throw new Error("fixture-profile-invalid");
  const configRoot = join(stateRoot, "config", "opencode");
  for (const path of [
    join(configRoot, "plugins"),
    join(stateRoot, "home"),
    join(stateRoot, "state"),
    join(stateRoot, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(configRoot, "opencode.json"), profile.config, { mode: 0o600 });
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native")))
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
  const git = resolveDarwinGitExecutable();
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
    runId: "run-native-resume",
    treeBindingId: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    runtimeArtifactDigest: "c".repeat(64),
    modelProfileDigest: "d".repeat(64),
    profile: "keiko-native",
    filesystem: {
      workspaceRoot: fixture.workspace,
      workspaceAccess: "read-write",
      privateStateRoot: stateRoot,
      runtimeReadRoot: runtimeRoot,
      protectedWriteRoots: [openCodeConfigDirectory(stateRoot)],
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
        KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(stubs.facade.port)}/native-policy`,
        KEIKO_TOOL_FACADE_CAPABILITY: FACADE_CAPABILITY,
        KEIKO_CODING_RUN_ID: "run-native-resume",
        KEIKO_CODING_MODE: "governed-assist",
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

/** An orderly stop, like the supervisor's graceful termination; the database is then quiescent. */
async function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

interface Runtime {
  readonly compact: (sessionId: string) => Promise<number>;
  readonly client: OpenCodeV2HttpClient;
  readonly gateway: Stub;
  readonly stateRoot: string;
  readonly database: string;
}

interface World {
  readonly fixture: Fixture;
  readonly gateway: Stub;
  readonly facade: Stub;
  readonly binary: string;
  readonly runtimeRoot: string;
  readonly store: RetainedSessionStore;
}

/** One runtime on its own private state, optionally seeded with a database copy. */
async function withRuntime(
  world: World,
  name: string,
  seed: ((database: string) => void) | undefined,
  body: (runtime: Runtime) => Promise<void>,
): Promise<void> {
  const stateRoot = join(world.fixture.root, name);
  const database = join(stateRoot, "state", "opencode.db");
  mkdirSync(join(stateRoot, "state"), { recursive: true, mode: 0o700 });
  seed?.(database);
  const launched = launch(world.fixture, stateRoot, world.binary, world.runtimeRoot, world);
  try {
    const endpoint = await childEndpoint(launched.child);
    const client = createOpenCodeV2HttpClient({ endpoint, password: launched.password });
    expect((await client.info()).version).toBe(RUNTIME_VERSION);
    await body({
      client,
      gateway: world.gateway,
      stateRoot,
      database,
      compact: async (sessionId: string): Promise<number> => {
        const response = await fetch(
          new URL(`/api/session/${encodeURIComponent(sessionId)}/compact`, endpoint),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${Buffer.from(`opencode:${launched.password}`).toString("base64")}`,
            },
            body: "{}",
            signal: AbortSignal.timeout(30_000),
          },
        );
        await response.arrayBuffer();
        return response.status;
      },
    });
  } finally {
    await stopChild(launched.child);
  }
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const fixture = createFixture();
  const [gateway, facade] = [await startGateway(), await startFacade()];
  try {
    await body({
      fixture,
      gateway,
      facade,
      binary: realpathSync(BINARY),
      runtimeRoot: realpathSync(RESOURCE_ROOT),
      store: createRetainedSessionStore({ root: join(fixture.root, "retained") }),
    });
  } finally {
    await Promise.all([closeStub(gateway), closeStub(facade)]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function idle(client: OpenCodeV2HttpClient, sessionId: string): Promise<void> {
  await expect
    .poll(async () => !Object.hasOwn(await client.active(), sessionId), { timeout: 30_000 })
    .toBe(true);
}

/** One plain turn, awaited until the session is idle again. */
async function turn(client: OpenCodeV2HttpClient, sessionId: string, text: string): Promise<void> {
  await client.prompt(sessionId, text);
  await idle(client, sessionId);
}

function binding(overrides: Partial<RetainedSessionBinding> = {}): RetainedSessionBinding {
  return {
    taskId: TASK_ID,
    workspaceKey: WORKSPACE_KEY,
    runtimeVersion: RUNTIME_VERSION,
    maxInputTokens: 24_000,
    ...overrides,
  };
}

/** The run that settled: a new session, the given user turns, a stopped runtime, a retained entry. */
async function settledRun(
  world: World,
  turns: readonly string[],
): Promise<{ readonly sessionId: string; readonly messageCount: number }> {
  let sessionId = "";
  await withRuntime(world, "first-run", undefined, async ({ client }) => {
    const created = await client.createSession(world.fixture.workspace);
    sessionId = String(created.id);
    for (const text of turns) await turn(client, sessionId, text);
  });
  const retained = world.store.retain({
    binding: binding(),
    sessionId,
    directory: world.fixture.workspace,
    sourceDatabase: join(world.fixture.root, "first-run", "state", "opencode.db"),
  });
  if (!retained.ok) throw new Error(`fixture-retain-refused:${retained.reason}`);
  return { sessionId, messageCount: retained.messageCount };
}

async function terminalHistoryRun(
  world: World,
  status: "succeeded" | "failed" | "cancelled",
  beforeTerminal?: (runtime: Runtime, sessionId: string) => Promise<void>,
): Promise<{ readonly sessionId: string; readonly context: SessionContinuationContext }> {
  let sessionId = "";
  const name = `terminal-${status}`;
  const marker = `FIXTURE-${status.toUpperCase()}-TERMINAL-TURN`;
  await withRuntime(world, name, undefined, async (runtime) => {
    const { client, gateway } = runtime;
    sessionId = String((await client.createSession(world.fixture.workspace)).id);
    await turn(client, sessionId, "BEFORE-TERMINAL-TURN");
    await beforeTerminal?.(runtime, sessionId);
    await client.prompt(sessionId, marker);
    if (status === "cancelled") {
      await expect.poll(() => userTexts(gateway.requests.at(-1)).at(-1)).toBe(marker);
      await client.interrupt(sessionId);
    }
    await idle(client, sessionId);
    const messages = await client.messages(sessionId);
    expect(messages.length).toBeGreaterThanOrEqual(4);
    if (status === "failed") {
      expect(
        messages.some((message) => message.type === "assistant" && message.error !== undefined),
      ).toBe(true);
    }
  });
  const context: SessionContinuationContext = {
    service: createCodingSessionContinuity({ store: world.store, taskOfRun: () => TASK_ID }),
    workspaceId: "workspace-terminal-history",
    native: true,
    runtimeVersion: RUNTIME_VERSION,
    maxInputTokens: 24_000,
    activityLog: undefined,
  };
  retainSettledRun(
    context,
    {
      runId: "run-100000001",
      runRoot: join(world.fixture.root, name),
      workspaceRoot: world.fixture.workspace,
      sessionId,
    },
    status,
  );
  expect(existsSync(join(world.fixture.root, "retained", retainedSessionKey(TASK_ID)))).toBe(true);
  return { sessionId, context };
}

/** The original compactor requires its summary envelope, not an arbitrary assistant answer. */
async function compactCheckpoint(runtime: Runtime, sessionId: string): Promise<void> {
  runtime.gateway.replyText =
    "<summary>\n## Objective\nKeep COMPACTED_RECEIPT_4064.\n\n## Next Move\nContinue the accepted task.\n</summary>";
  try {
    expect(await runtime.compact(sessionId)).toBe(200);
    await expect
      .poll(
        async () =>
          (await runtime.client.messages(sessionId)).some(
            (message) => message.type === "compaction" && message.status === "completed",
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await idle(runtime.client, sessionId);
  } finally {
    runtime.gateway.replyText = undefined;
  }
}

function seedCompactedRun(
  world: World,
  context: SessionContinuationContext,
  name: string,
): RunContinuation {
  const runId = "run-100000003";
  context.service.declare(runId, { kind: "resume", taskId: TASK_ID });
  const continued = seedContinuation(context, {
    runId,
    runRoot: join(world.fixture.root, name),
    workspaceRoot: world.fixture.workspace,
  });
  if (continued === undefined) throw new Error("fixture-compacted-session-not-retained");
  return continued;
}

function continuation(sessionId: string, intent: RunContinuation["intent"]): RunContinuation {
  return {
    intent,
    taskId: TASK_ID,
    sessionId,
    databaseBytes: 1,
    messageCount: 1,
    ageMs: 0,
  };
}

function checkoutInto(
  world: World,
  database: string,
  overrides?: Partial<RetainedSessionBinding>,
): ReturnType<RetainedSessionStore["checkout"]> {
  return world.store.checkout({
    binding: binding(overrides),
    directory: world.fixture.workspace,
    destinationDatabase: database,
  });
}

function modelMessages(
  request: Recorded | undefined,
): readonly { role: unknown; content: unknown }[] {
  const messages = object(request?.body)?.messages;
  return Array.isArray(messages)
    ? messages.map((message) => {
        const entry = object(message);
        return { role: entry?.role, content: entry?.content };
      })
    : [];
}

/**
 * The user turns of a model request. The runtime adds an environment notice of its own, as a user
 * message, when the working directories of a database's earlier runs are not this run's; it is the
 * runtime's, not a turn.
 */
function userTexts(request: Recorded | undefined): readonly unknown[] {
  return modelMessages(request)
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .filter((content) => typeof content !== "string" || !content.startsWith("<system-update>"));
}

function requestHasUserText(request: Recorded | undefined, text: string): boolean {
  return userTexts(request).some((content) => {
    if (typeof content === "string") return content.includes(text);
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      const value = object(part)?.text;
      return typeof value === "string" && value.includes(text);
    });
  });
}

interface ProjectedRun {
  readonly events: readonly unknown[];
  readonly signals: string;
  readonly captured: string;
}

describe("native session continuity on the pinned OpenCode runtime", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip).each(["succeeded", "failed", "cancelled"] as const)(
    "resumes a native compaction checkpoint after a %s terminal turn and process restart",
    async (status) => {
      await withWorld(async (world) => {
        const { sessionId, context } = await terminalHistoryRun(world, status, compactCheckpoint);
        const name = `compacted-resume-${status}`;
        let continued: RunContinuation | undefined;
        await withRuntime(
          world,
          name,
          () => {
            continued = seedCompactedRun(world, context, name);
            expect(continued.sessionId).toBe(sessionId);
          },
          async ({ client, gateway }) => {
            if (continued === undefined) throw new Error("fixture-compaction-checkout-missing");
            expect(
              await bindContinuedSession(client, continued, world.fixture.workspace, undefined),
            ).toMatchObject({ ok: true, sessionId });
            expect(await client.messages(sessionId)).toContainEqual(
              expect.objectContaining({ type: "compaction", status: "completed" }),
            );
            await turn(client, sessionId, "AFTER-COMPACTION-RESTART");
            const request = gateway.requests.find((entry) =>
              requestHasUserText(entry, "AFTER-COMPACTION-RESTART"),
            );
            expect(request).toBeDefined();
            // This marker occurs only in the compactor's response, never in a user prompt.
            expect(
              modelMessages(request).some((message) =>
                JSON.stringify(message.content).includes("COMPACTED_RECEIPT_4064"),
              ),
            ).toBe(true);
          },
        );
      });
    },
    120_000,
  );

  it.skipIf(skip).each(["failed", "cancelled"] as const)(
    "retains a real %s turn after reaping and resumes its earlier native history",
    async (status) => {
      await withWorld(async (world) => {
        const { sessionId, context } = await terminalHistoryRun(world, status);
        const name = `resumed-${status}`;
        const runId = "run-100000002";
        context.service.declare(runId, { kind: "resume", taskId: TASK_ID });
        let continued: RunContinuation | undefined;
        await withRuntime(
          world,
          name,
          () => {
            continued = seedContinuation(context, {
              runId,
              runRoot: join(world.fixture.root, name),
              workspaceRoot: world.fixture.workspace,
            });
            expect(continued?.sessionId).toBe(sessionId);
          },
          async ({ client, gateway }) => {
            if (continued === undefined) throw new Error("fixture-terminal-history-not-retained");
            expect(
              await bindContinuedSession(client, continued, world.fixture.workspace, undefined),
            ).toMatchObject({ ok: true, sessionId });
            await turn(client, sessionId, "AFTER-TERMINAL-TURN");
            const users = userTexts(gateway.requests.at(-1));
            expect(users).toContain("BEFORE-TERMINAL-TURN");
            expect(
              requestHasUserText(
                gateway.requests.at(-1),
                `FIXTURE-${status.toUpperCase()}-TERMINAL-TURN`,
              ),
            ).toBe(true);
            expect(users).toContain("AFTER-TERMINAL-TURN");
          },
        );
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "serves exactly the admitted protocol surface, including session fork and removal",
    async () => {
      await withWorld(async (world) => {
        await withRuntime(world, "surface", undefined, async ({ client }) => {
          const { digest, projection } = projectOpenCodeV2ProtocolSurface(await client.document());
          expect(digest).toBe(openCodeRuntimeVersionPin(RUNTIME_VERSION)?.protocolSurfaceSha256);
          const paths = (projection as { readonly paths: Record<string, object> }).paths;
          expect(Object.keys(paths["/api/session/{sessionID}"] ?? {})).toEqual(["delete"]);
          expect(Object.keys(paths["/api/session/{sessionID}/fork"] ?? {})).toEqual(["post"]);
        });
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "retains an audited database from a real run and resumes the session with its earlier turns in the model request",
    async () => {
      await withWorld(async (world) => {
        const { sessionId, messageCount } = await settledRun(world, [
          "FIRST-QUESTION",
          "SECOND-QUESTION",
        ]);
        // A real runtime database passes the audit: no grant, credential, queued input or undo.
        expect(messageCount).toBeGreaterThanOrEqual(6);
        expect(existsSync(join(world.fixture.root, "retained", retainedSessionKey(TASK_ID)))).toBe(
          true,
        );

        await withRuntime(
          world,
          "second-run",
          (database) => {
            const checkout = checkoutInto(world, database);
            expect(checkout).toMatchObject({ ok: true, sessionId, messageCount });
          },
          async ({ client, gateway }) => {
            const bound = await bindContinuedSession(
              client,
              continuation(sessionId, { kind: "resume", taskId: TASK_ID }),
              world.fixture.workspace,
              undefined,
            );
            expect(bound).toMatchObject({ ok: true, sessionId });
            const before = gateway.requests.length;

            await turn(client, sessionId, "THIRD-QUESTION");

            expect(gateway.requests).toHaveLength(before + 1);
            const request = gateway.requests.at(-1);
            const conversation = modelMessages(request)
              .filter((message) => message.role !== "system")
              .map((message) => message.content);
            // The runtime replays its own earlier turns, answers included, then the new one.
            expect(conversation).toContain("FIRST-QUESTION");
            expect(conversation).toContain("SECOND-QUESTION");
            expect(userTexts(request).at(-1)).toBe("THIRD-QUESTION");
            expect(
              conversation.filter(
                (content) => typeof content === "string" && content.startsWith("Answer number"),
              ),
            ).toHaveLength(2);
          },
        );
      });
    },
    240_000,
  );

  it.skipIf(skip)(
    "proves the gateway route in a scratch session and leaves the continued database with one session",
    async () => {
      await withWorld(async (world) => {
        const { sessionId } = await settledRun(world, ["FIRST-QUESTION"]);
        await withRuntime(
          world,
          "second-run",
          (database) => {
            expect(checkoutInto(world, database)).toMatchObject({ ok: true });
          },
          async ({ client, gateway }) => {
            await bindContinuedSession(
              client,
              continuation(sessionId, { kind: "resume", taskId: TASK_ID }),
              world.fixture.workspace,
              undefined,
            );
            const before = gateway.requests.length;

            const scratch = String((await client.createSession(world.fixture.workspace)).id);
            await turn(client, scratch, OPENCODE_RUNTIME_READINESS_PROMPT);

            // What `isRuntimeReadinessProbe` of the gateway requires: nothing but system messages
            // ahead of the probe, which holds in a scratch session and not in the continued one.
            const probe = modelMessages(gateway.requests[before]);
            expect(probe.at(-1)).toEqual({
              role: "user",
              content: OPENCODE_RUNTIME_READINESS_PROMPT,
            });
            expect(probe.slice(0, -1).every((message) => message.role === "system")).toBe(true);
            await client.removeSession(scratch);
            expect((await client.sessions()).map((session) => session.id)).toEqual([sessionId]);

            await turn(client, sessionId, "SECOND-QUESTION");
            const continued = modelMessages(gateway.requests.at(-1));
            expect(
              continued.some((message) => message.content === OPENCODE_RUNTIME_READINESS_PROMPT),
            ).toBe(false);
            expect(continued.slice(0, -1).every((message) => message.role === "system")).toBe(
              false,
            );
          },
        );
      });
    },
    240_000,
  );

  it.skipIf(skip)(
    "keeps the earlier runs' messages out of the projection and the captured history",
    async () => {
      await withWorld(async (world) => {
        const { sessionId } = await settledRun(world, ["FIRST-QUESTION", "SECOND-QUESTION"]);
        await withRuntime(
          world,
          "second-run",
          (database) => {
            expect(checkoutInto(world, database)).toMatchObject({ ok: true });
          },
          async ({ client }) => {
            const bound = await bindContinuedSession(
              client,
              continuation(sessionId, { kind: "resume", taskId: TASK_ID }),
              world.fixture.workspace,
              undefined,
            );
            if (!bound.ok) throw new Error("fixture-bind-refused");
            await turn(client, sessionId, "THIRD-QUESTION");
            const all = await client.messages(sessionId);

            const project = (baseline: ReadonlySet<string> | undefined): ProjectedRun => {
              const captured: CodingHistoryMessage[][] = [];
              const projection = createOpenCodeV2HistoryProjection({
                toolProfile: "native",
                runId: "run-native-resume-b",
                activityLog: undefined,
                captureMessages: (messages): boolean => {
                  captured.push([...messages]);
                  return true;
                },
              });
              const events = projection.project(
                sessionId,
                withoutBaseline(all, baseline),
                undefined,
              );
              const signals = events.flatMap((event) => {
                const signal = projection.takeSignal(event);
                return signal === undefined ? [] : [signal];
              });
              return {
                events,
                signals: JSON.stringify(signals),
                captured: JSON.stringify(captured.at(-1)),
              };
            };

            const continued = project(bound.baselineIds);
            expect(continued.signals).toContain("THIRD-QUESTION");
            expect(continued.captured).toContain("THIRD-QUESTION");
            for (const earlier of ["FIRST-QUESTION", "SECOND-QUESTION"]) {
              expect(continued.signals).not.toContain(earlier);
              expect(continued.captured).not.toContain(earlier);
            }
            // The control proves the filter is what keeps them out: the same messages unfiltered
            // would have been shown and stored again under the new run.
            const control = project(undefined);
            expect(control.signals).toContain("FIRST-QUESTION");
            expect(control.captured).toContain("FIRST-QUESTION");
            expect(control.events.length).toBeGreaterThan(continued.events.length);
          },
        );
      });
    },
    240_000,
  );

  it.skipIf(skip)(
    "forks before a user turn: the copy carries the history before it and not after, and the source is removed",
    async () => {
      await withWorld(async (world) => {
        const { sessionId } = await settledRun(world, [
          "FIRST-QUESTION",
          "SECOND-QUESTION",
          "THIRD-QUESTION",
        ]);
        const entry = join(world.fixture.root, "retained", retainedSessionKey(TASK_ID));
        const entryBefore = readFileSync(join(entry, "opencode.db"));
        await withRuntime(
          world,
          "fork-run",
          (database) => {
            expect(checkoutInto(world, database)).toMatchObject({ ok: true });
          },
          async ({ client, gateway, database }) => {
            const bound = await bindContinuedSession(
              client,
              continuation(sessionId, {
                kind: "fork",
                sourceTaskId: TASK_ID,
                // The second of the three user turns; the runtime's handshake is not one of them.
                boundary: { kind: "turn", ordinal: 1, userTurnCount: 3 },
              }),
              world.fixture.workspace,
              undefined,
            );
            if (!bound.ok) throw new Error(`fixture-fork-refused:${bound.reason}`);
            expect(bound.sessionId).not.toBe(sessionId);
            expect((await client.sessions()).map((session) => session.id)).toEqual([
              bound.sessionId,
            ]);
            const forkText = (await client.messages(bound.sessionId)).flatMap((message) =>
              typeof message.text === "string" ? [message.text] : [],
            );
            expect(forkText).toEqual(["FIRST-QUESTION"]);

            await turn(client, bound.sessionId, "FORK-QUESTION");
            const asked = userTexts(gateway.requests.at(-1));
            expect(asked).toEqual(["FIRST-QUESTION", "FORK-QUESTION"]);

            // Nothing after the boundary survives in the run's database, not even as free pages.
            await stopRuntimeDatabase(client);
            const compact = join(world.fixture.root, "fork-compact.db");
            const source = new DatabaseSync(database, { readOnly: true });
            source.prepare("VACUUM INTO ?").run(compact);
            source.close();
            const bytes = readFileSync(compact);
            expect(bytes.includes("FORK-QUESTION")).toBe(true);
            expect(bytes.includes("SECOND-QUESTION")).toBe(false);
            expect(bytes.includes("THIRD-QUESTION")).toBe(false);
            // The fork's database passes the same audit a retained entry must.
            expect(
              auditDatabase(compact, {
                sessionId: bound.sessionId,
                directory: world.fixture.workspace,
                version: RUNTIME_VERSION,
              }),
            ).toMatchObject({ ok: true });
          },
        );
        // The source task's retained entry is exactly as it was and can be taken again.
        expect(readFileSync(join(entry, "opencode.db")).equals(entryBefore)).toBe(true);
        expect(checkoutInto(world, join(world.fixture.root, "again.db"))).toMatchObject({
          ok: true,
          sessionId,
        });
      });
    },
    300_000,
  );

  it.skipIf(skip)(
    "forks through the end of the session and refuses a boundary the runtime's turns do not match",
    async () => {
      await withWorld(async (world) => {
        const { sessionId } = await settledRun(world, ["FIRST-QUESTION", "SECOND-QUESTION"]);
        await withRuntime(
          world,
          "fork-run",
          (database) => {
            expect(checkoutInto(world, database)).toMatchObject({ ok: true });
          },
          async ({ client, gateway }) => {
            // Coding History counts three user turns, the runtime two: no boundary is guessed.
            const mismatched = await bindContinuedSession(
              client,
              continuation(sessionId, {
                kind: "fork",
                sourceTaskId: TASK_ID,
                boundary: { kind: "turn", ordinal: 1, userTurnCount: 3 },
              }),
              world.fixture.workspace,
              undefined,
            );
            expect(mismatched).toMatchObject({ ok: false, reason: "fork-boundary-unresolved" });
            expect((await client.sessions()).map((session) => session.id)).toEqual([sessionId]);

            const whole = await bindContinuedSession(
              client,
              continuation(sessionId, {
                kind: "fork",
                sourceTaskId: TASK_ID,
                boundary: { kind: "end" },
              }),
              world.fixture.workspace,
              undefined,
            );
            if (!whole.ok) throw new Error(`fixture-fork-refused:${whole.reason}`);
            await turn(client, whole.sessionId, "FORK-QUESTION");
            expect(userTexts(gateway.requests.at(-1))).toEqual([
              "FIRST-QUESTION",
              "SECOND-QUESTION",
              "FORK-QUESTION",
            ]);
          },
        );
      });
    },
    300_000,
  );

  // #3908 AC4: the whole database crosses the retention boundary, so its schema is bound to the
  // producer's persistence contract. A real run's database has exactly that schema, and a table
  // or a session column beyond it is refused even with identity, version and known state intact.
  it.skipIf(skip)(
    "binds retained state to the producer's persistence contract and refuses schema additions",
    async () => {
      await withWorld(async (world) => {
        const { sessionId } = await settledRun(world, ["FIRST-QUESTION"]);
        const source = join(world.fixture.root, "first-run", "state", "opencode.db");
        const contract = OPENCODE_PERSISTENCE_SCHEMAS[RUNTIME_VERSION];
        expect(contract).toBeDefined();
        expect(persistenceSchema(source)).toEqual(
          Object.fromEntries(
            Object.entries(contract ?? {}).map(([table, columns]) => [table, [...columns].sort()]),
          ),
        );

        const retainCopy = (database: string): ReturnType<RetainedSessionStore["retain"]> =>
          world.store.retain({
            binding: binding(),
            sessionId,
            directory: world.fixture.workspace,
            sourceDatabase: database,
          });
        const addedTable = driftedCopy(
          world,
          "added-table",
          'CREATE TABLE "extra_state" ("value"); INSERT INTO "extra_state" VALUES (1);',
        );
        const addedColumn = driftedCopy(
          world,
          "added-column",
          "ALTER TABLE session_v2 ADD COLUMN extra_grant TEXT; UPDATE session_v2 SET extra_grant = 'x';",
        );
        const entry = join(world.fixture.root, "retained", retainedSessionKey(TASK_ID));
        const entryBefore = readFileSync(join(entry, "opencode.db"));
        for (const drifted of [addedTable, addedColumn]) {
          const before = readFileSync(drifted);
          expect(retainCopy(drifted)).toEqual({
            ok: false,
            reason: "schema-unknown",
            check: "schema-drift",
          });
          // The drifted state is not carried forward: the task keeps its earlier audited entry,
          // and the refused source is left exactly as it was.
          expect(readFileSync(join(entry, "opencode.db")).equals(entryBefore)).toBe(true);
          expect(readFileSync(drifted).equals(before)).toBe(true);
        }

        // Positive control: the unaltered database of the same run is retained.
        expect(retainCopy(source)).toMatchObject({ ok: true });
      });
    },
    240_000,
  );

  it.skipIf(skip)(
    "refuses a retained state of another workspace, another runtime version or a state the runtime does not see that way",
    async () => {
      await withWorld(async (world) => {
        const { sessionId } = await settledRun(world, ["FIRST-QUESTION"]);
        const destination = (name: string): string => join(world.fixture.root, `${name}.db`);

        expect(
          checkoutInto(world, destination("workspace"), { workspaceKey: "b".repeat(64) }),
        ).toMatchObject({ ok: false, reason: "workspace-changed", removed: true });
        expect(existsSync(destination("workspace"))).toBe(false);
        // The entry is gone for good once its workspace binding is refused.
        expect(checkoutInto(world, destination("again"))).toMatchObject({
          ok: false,
          reason: "no-retained-state",
        });

        // A second entry, then a runtime version the entry was not built under.
        world.store.retain({
          binding: binding(),
          sessionId,
          directory: world.fixture.workspace,
          sourceDatabase: join(world.fixture.root, "first-run", "state", "opencode.db"),
        });
        expect(
          checkoutInto(world, destination("version"), { runtimeVersion: "2.1.5" }),
        ).toMatchObject({ ok: false, reason: "version-changed", removed: true });

        // The same bytes are refused for a run in another workspace directory.
        world.store.retain({
          binding: binding(),
          sessionId,
          directory: world.fixture.workspace,
          sourceDatabase: join(world.fixture.root, "first-run", "state", "opencode.db"),
        });
        expect(
          world.store.checkout({
            binding: binding(),
            directory: world.fixture.otherWorkspace,
            destinationDatabase: destination("directory"),
          }),
        ).toMatchObject({ ok: false, reason: "session-mismatch", removed: true });
      });
    },
    240_000,
  );
});

/** Every producer table (SQLite's own excepted) with its sorted column names. */
function persistenceSchema(path: string): Record<string, readonly string[]> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database
      .prepare(
        String.raw`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\' ORDER BY name`,
      )
      .all() as { readonly name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (database.prepare("SELECT name FROM pragma_table_xinfo(?)").all(name) as { name: string }[])
          .map((column) => column.name)
          .sort(),
      ]),
    );
  } finally {
    database.close();
  }
}

/** A consistent copy of the settled run's database with one schema change applied. */
function driftedCopy(world: World, name: string, change: string): string {
  const copy = join(world.fixture.root, `${name}.db`);
  const source = new DatabaseSync(join(world.fixture.root, "first-run", "state", "opencode.db"), {
    readOnly: true,
  });
  source.prepare("VACUUM INTO ?").run(copy);
  source.close();
  const target = new DatabaseSync(copy);
  target.exec(change);
  target.close();
  return copy;
}

/** The runtime keeps writing its database while it lives; compacting is done once it is idle. */
async function stopRuntimeDatabase(client: OpenCodeV2HttpClient): Promise<void> {
  await expect
    .poll(async () => Object.keys(await client.active()).length, { timeout: 30_000 })
    .toBe(0);
}
