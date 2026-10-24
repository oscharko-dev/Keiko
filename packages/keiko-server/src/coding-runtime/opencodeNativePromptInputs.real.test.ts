import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_BUILT_IN_COMMAND_NAMES,
  validateCodingWorkbenchRuntimeCommandsChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import { buildOpenCodeLaunchProfile, openCodeConfigDirectory } from "./opencodeLaunchProfile.js";
import {
  commandDisplayText,
  createOpenCodeCommandPresentation,
  createOpenCodeCommandsRunPort,
  projectCommands,
} from "./opencodeCommands.js";
import {
  createOpenCodePromptInputsRunPort,
  openCodePromptInputs,
  resolvePromptReferences,
  type PromptInputsRun,
} from "./opencodePromptInputs.js";
import {
  createProductionRuntimeOperationGuard,
  createProductionRuntimeTaskDispatcher,
} from "./productionCodingRuntimePorts.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";
import {
  OpenCodeV2HttpStatusError,
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
  type OpenCodeV2Command,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";
import type { CodingHistoryMessage } from "./codingRuntimeHistory.js";

/**
 * Original-runtime proof of the prompt inputs a native run takes beyond its text (#3897, ADR-0137
 * D10, parity rows S07, S15 and C02): a message sent while a turn runs (`delivery: "steer"` or
 * `"queue"`), a workspace file the human referenced (`files`) on a follow-up and on the first prompt,
 * and a turn run as one of the runtime's slash commands (`session.command`). The pinned executable runs under
 * the real native Seatbelt wrapper with the profile `buildOpenCodeLaunchProfile` produces, behind
 * a scripted Model Gateway stub that records every model request; the prompts are sent through
 * Keiko's own V2 client, and the attachments are the ones Keiko's own resolver produces.
 * Run with KEIKO_OPENCODE_REAL_BINARY and KEIKO_OPENCODE_REAL_RESOURCE_ROOT set; otherwise it is
 * skipped.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const GATEWAY_CAPABILITY = "fixture-gateway-capability";
const FACADE_CAPABILITY = "fixture-facade-capability";
const NOTES_FILE = "NOTES.md";
const NOTES_CANARY = "NOTES-CANARY-CONTENT";
const AWKWARD_FILE = "my notes #1 100%.md";
const AWKWARD_CANARY = "AWKWARD-CANARY-CONTENT";
const OUTSIDE_CANARY = "OUTSIDE-CANARY-THAT-MUST-NOT-REACH-THE-MODEL";
const MAX_FIXTURE_BODY_BYTES = 4 * 1_024 * 1_024;

/** What the scripted model answers the Nth request with. */
type ModelStep = "tool" | "tool-held" | "text" | "text-held";

interface GatewayStub {
  readonly server: Server;
  port: number;
  /** The decoded body of every model request, in arrival order. */
  readonly requests: unknown[];
  /** Answers the requests that were held, in arrival order. */
  release(): void;
  script: readonly ModelStep[];
}

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

function chunk(delta: unknown, finish: string | null, usage?: unknown): string {
  return frame({
    id: "prompt-inputs",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage === undefined ? {} : { usage }),
  });
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function answer(response: ServerResponse, step: ModelStep, ordinal: number): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  if (step === "tool" || step === "tool-held") {
    const call = {
      index: 0,
      id: `call_prompt_inputs_${String(ordinal)}`,
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: NOTES_FILE }) },
    };
    response.write(chunk({ tool_calls: [call] }, null));
    response.end(chunk({}, "tool_calls", USAGE) + "data: [DONE]\n\n");
    return;
  }
  response.write(chunk({ content: `Answer ${String(ordinal)}.` }, null));
  response.end(chunk({}, "stop", USAGE) + "data: [DONE]\n\n");
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const part of request as AsyncIterable<Buffer>) {
    total += part.length;
    if (total > MAX_FIXTURE_BODY_BYTES) throw new Error("fixture-body-oversized");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture-listener-invalid");
  return address.port;
}

async function startGateway(): Promise<GatewayStub> {
  const requests: unknown[] = [];
  const held: (() => void)[] = [];
  const stub: GatewayStub = {
    server: createServer((request, response) => {
      void readBody(request)
        .then((body) => {
          requests.push(body);
          const ordinal = requests.length;
          const step = stub.script[ordinal - 1] ?? "text";
          if (step.endsWith("-held")) {
            held.push(() => {
              answer(response, step, ordinal);
            });
          } else {
            answer(response, step, ordinal);
          }
        })
        .catch(() => response.writeHead(500).end());
    }),
    port: 0,
    requests,
    release: (): void => {
      for (const respond of held.splice(0)) respond();
    },
    script: [],
  };
  stub.port = await listen(stub.server);
  return stub;
}

async function startFacade(): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"effect":"allow"}');
    });
  });
  return { server, port: await listen(server) };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-prompt-inputs-")));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, NOTES_FILE), `${NOTES_CANARY}\n`);
  writeFileSync(join(workspace, AWKWARD_FILE), `${AWKWARD_CANARY}\n`);
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
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native"))) {
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
  }
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
  materializePrivateConfiguration(fixture.state, profile.config);
  const git = resolveDarwinGitExecutable();
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl: `http://127.0.0.1:${String(ports.gateway)}/v1`,
    runId: "run-prompt-inputs",
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
        KEIKO_MODEL_GATEWAY_URL: `http://127.0.0.1:${String(ports.gateway)}/v1`,
        KEIKO_MODEL_GATEWAY_CAPABILITY: GATEWAY_CAPABILITY,
        KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(ports.facade)}/native-policy`,
        KEIKO_TOOL_FACADE_CAPABILITY: FACADE_CAPABILITY,
        KEIKO_CODING_RUN_ID: "run-prompt-inputs",
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
  readonly client: OpenCodeV2HttpClient;
  /** The running service, for a second client whose transport the test controls. */
  readonly endpoint: string;
  readonly password: string;
  readonly sessionId: string;
  /** The type of every runtime event observed on the event stream, in order. */
  readonly events: string[];
  /** A raw request, for the refusals the Keiko client would not even send. */
  raw(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
}

async function withRun(
  script: readonly ModelStep[],
  body: (run: Run) => Promise<void>,
): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const fixture = createFixture();
  const [gateway, facade] = [await startGateway(), await startFacade()];
  gateway.script = script;
  const launched = launch(fixture, realpathSync(BINARY), realpathSync(RESOURCE_ROOT), {
    gateway: gateway.port,
    facade: facade.port,
  });
  const stream = new AbortController();
  try {
    const endpoint = await childEndpoint(launched.child);
    const client = createOpenCodeV2HttpClient({ endpoint, password: launched.password });
    expect((await client.info()).version).toBe(OPENCODE_PINNED_VERSION);
    const session = await client.createSession(fixture.workspace);
    if (typeof session.id !== "string") throw new Error("fixture-session-invalid");
    const events: string[] = [];
    void (async (): Promise<void> => {
      try {
        for await (const event of client.events(stream.signal)) events.push(String(event.type));
      } catch {
        // The stream ends when the run is torn down.
      }
    })();
    const authorization = `Basic ${Buffer.from(`opencode:${launched.password}`, "utf8").toString("base64")}`;
    const raw: Run["raw"] = async (method, path, payload) => {
      const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    };
    await body({
      fixture,
      gateway,
      client,
      endpoint,
      password: launched.password,
      sessionId: session.id,
      events,
      raw,
    });
  } finally {
    stream.abort();
    await stopChild(launched.child);
    await Promise.all([closeServer(gateway.server), closeServer(facade.server)]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

const count = (events: readonly string[], type: string): number =>
  events.filter((event) => event === type).length;

/** The role and content of every message the model received, after the system prompt. */
function conversation(request: unknown): readonly { role: unknown; content: string }[] {
  const messages = object(request)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.slice(1).map((message: unknown) => ({
    role: object(message)?.role,
    content: JSON.stringify(object(message)?.content ?? null),
  }));
}

function lastUserContent(request: unknown): string {
  return (
    conversation(request)
      .filter((message) => message.role === "user")
      .at(-1)?.content ?? ""
  );
}

async function settled(run: Run): Promise<void> {
  await expect
    .poll(() => count(run.events, "session.execution.succeeded"), { timeout: 30_000 })
    .toBe(1);
}

const RUN_ID = "run-prompt-inputs";

/**
 * A transport that loses the acknowledgement of the first `delivery` post AFTER the producer has
 * answered it in full: the request went out, the producer stored the input, and the answer never
 * reaches the caller. This is the failure the operator's retry has to resolve without a second input.
 */
function acknowledgementLosingFetch(state: { lost: number }): typeof globalThis.fetch {
  return async (input, init): Promise<Response> => {
    const response = await fetch(input, init);
    const sent = typeof init?.body === "string" ? init.body : "";
    if (response.url.endsWith("/prompt") && sent.includes('"delivery"') && state.lost === 0) {
      state.lost += 1;
      await response.arrayBuffer();
      throw new TypeError("fetch failed");
    }
    return response;
  };
}

/**
 * Keiko's own delivery path over the real session: the run port that binds the operator request to
 * the producer's message id, behind the production task dispatcher and its operation guard, which
 * give the stale-revision, single-use request id and cancellation semantics of a Workbench request.
 */
interface DeliveryPath {
  readonly port: ReturnType<typeof createOpenCodePromptInputsRunPort>;
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
  readonly controller: AbortController;
  readonly deliver: (
    requestId: string,
    expectedRevision: number,
    taskIntent: string,
    delivery?: "steer" | "queue",
  ) => Promise<{ readonly ok: boolean; readonly reason?: string | undefined }>;
}

function deliveryPath(
  run: Run,
  client: OpenCodeV2HttpClient,
  turnInFlight: () => boolean = (): boolean => true,
): DeliveryPath {
  const sink = createBufferedServerLogSink();
  const promptRun: PromptInputsRun = {
    runId: RUN_ID,
    workspaceRoot: run.fixture.workspace,
    sessionId: run.sessionId,
    client,
    runtimeAdapter: { turnInFlight },
    ready: true,
  };
  const port = createOpenCodePromptInputsRunPort({
    readyRun: (): PromptInputsRun => promptRun,
    capabilities: openCodePromptInputs("native"),
    activityLog: sink,
    recordPostFailure: (): void => undefined,
  });
  const controller = new AbortController();
  const dispatcher = createProductionRuntimeTaskDispatcher(
    new Map([
      [
        RUN_ID,
        {
          turnPort: {
            submitTurn: (): Promise<boolean> => Promise.resolve(false),
            abortTurn: (): Promise<boolean> => Promise.resolve(true),
            waitForTerminal: (): Promise<"succeeded"> => Promise.resolve("succeeded" as const),
            admitPromptInputs: port.admitPromptInputs,
            deliverPrompt: port.deliverPrompt,
          },
          controller,
          operationGuard: createProductionRuntimeOperationGuard(RUN_ID, (): boolean => true),
        },
      ],
    ]),
    { record: (): void => undefined },
  );
  const deliver = dispatcher.deliver;
  if (deliver === undefined) throw new Error("fixture-deliver-missing");
  return {
    port,
    sink,
    controller,
    deliver: (requestId, expectedRevision, taskIntent, delivery = "queue") =>
      deliver({ runId: RUN_ID, requestId, expectedRevision, taskIntent, delivery }),
  };
}

/** The user messages of the session's history that carry exactly this text. */
async function userMessagesWith(run: Run, text: string): Promise<readonly string[]> {
  const messages = await run.client.messages(run.sessionId);
  return messages
    .filter((message) => message.type === "user" && message.text === text)
    .map((message) => String(message.id));
}

describe("pinned native OpenCode prompt inputs", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  // S07: `steer` injects the message into the turn that is running. The model's first answer is a
  // tool call held at the gateway; the message arrives meanwhile and is part of the very next model
  // request, the one that carries the tool result, within one execution.
  it.skipIf(skip)(
    "steers a message into the running turn at its next step",
    async () => {
      await withRun(["tool-held", "text"], async (run) => {
        await run.client.prompt(run.sessionId, "First prompt");
        await expect.poll(() => run.gateway.requests.length, { timeout: 30_000 }).toBe(1);

        await run.client.prompt(run.sessionId, "Steered message", undefined, undefined, {
          delivery: "steer",
        });
        expect(run.gateway.requests, "the held model call is not interrupted").toHaveLength(1);
        run.gateway.release();
        await settled(run);

        expect(run.gateway.requests).toHaveLength(2);
        expect(conversation(run.gateway.requests[0]).map((message) => message.role)).toEqual([
          "user",
        ]);
        const second = conversation(run.gateway.requests[1]).map((message) => message.role);
        expect(second).toEqual(["user", "assistant", "tool", "user"]);
        expect(lastUserContent(run.gateway.requests[1])).toContain("Steered message");
        // One execution served both messages: the steer joined the turn, it started none.
        expect(count(run.events, "session.execution.started")).toBe(1);
        expect(count(run.events, "session.inbox.enqueued")).toBe(2);
      });
    },
    120_000,
  );

  // S07: `queue` delivers the message after the running turn. The model's tool-call step completes
  // without it; the queued message reaches the model only after the turn's final answer, still
  // within the same execution, so the single settlement Keiko waits for covers it.
  it.skipIf(skip)(
    "queues a message behind the running turn within the same execution",
    async () => {
      await withRun(["tool-held", "text", "text"], async (run) => {
        await run.client.prompt(run.sessionId, "First prompt");
        await expect.poll(() => run.gateway.requests.length, { timeout: 30_000 }).toBe(1);

        await run.client.prompt(run.sessionId, "Queued message", undefined, undefined, {
          delivery: "queue",
        });
        run.gateway.release();
        await settled(run);

        expect(run.gateway.requests).toHaveLength(3);
        const afterTool = conversation(run.gateway.requests[1]).map((message) => message.role);
        expect(afterTool, "the tool step finished without the queued message").toEqual([
          "user",
          "assistant",
          "tool",
        ]);
        const last = conversation(run.gateway.requests[2]);
        expect(last.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "tool",
          "assistant",
          "user",
        ]);
        expect(last.at(-1)?.content).toContain("Queued message");
        expect(count(run.events, "session.execution.started")).toBe(1);
        expect(count(run.events, "session.execution.succeeded")).toBe(1);
      });
    },
    120_000,
  );

  // The reason Keiko admits a delivery only for a turn it tracks: sent to an idle session, a
  // delivered message is an ordinary prompt and starts an execution nothing in Keiko's turn
  // accounting would settle.
  it.skipIf(skip)(
    "starts an execution when a delivered message reaches an idle session",
    async () => {
      await withRun(["text"], async (run) => {
        await run.client.prompt(run.sessionId, "Idle delivery", undefined, undefined, {
          delivery: "queue",
        });
        await settled(run);
        expect(run.gateway.requests).toHaveLength(1);
        expect(count(run.events, "session.execution.started")).toBe(1);
      });
    },
    120_000,
  );

  // PR #4064 review (ADR-0137 D10): the producer stores ONE input per supported `Session.Message.ID`.
  // The control proves the hazard the binding removes; the tests after it prove Keiko's path.
  it.skipIf(skip)(
    "control: a post resent without an id stores a second input, one resent with the id does not",
    async () => {
      await withRun(["tool-held", "text", "text", "text"], async (run) => {
        await run.client.prompt(run.sessionId, "First prompt");
        await expect.poll(() => run.gateway.requests.length, { timeout: 30_000 }).toBe(1);
        const queue = { delivery: "queue" } as const;

        await run.client.prompt(run.sessionId, "Unbound", undefined, undefined, queue);
        await run.client.prompt(run.sessionId, "Unbound", undefined, undefined, queue);
        const id = "msg_16b08469d001DaT0xxHG2PAKe6";
        await run.client.prompt(run.sessionId, "Bound", undefined, undefined, { ...queue, id });
        await run.client.prompt(run.sessionId, "Bound", undefined, undefined, { ...queue, id });
        run.gateway.release();
        await settled(run);

        expect(await userMessagesWith(run, "Unbound")).toHaveLength(2);
        expect(await userMessagesWith(run, "Bound")).toEqual([id]);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "keeps one productive queued input when the acknowledgement is lost and the same request is retried",
    async () => {
      await withRun(["tool-held", "text", "text"], async (run) => {
        await run.client.prompt(run.sessionId, "First prompt");
        await expect.poll(() => run.gateway.requests.length, { timeout: 30_000 }).toBe(1);
        const lost = { lost: 0 };
        const lossy = createOpenCodeV2HttpClient({
          endpoint: run.endpoint,
          password: run.password,
          fetch: acknowledgementLosingFetch(lost),
        });
        const path = deliveryPath(run, lossy);

        // The producer accepted the message; its answer was lost, so Keiko cannot tell.
        await expect(path.deliver("req-1", 4, "Queued message")).resolves.toEqual({ ok: false });
        expect(lost.lost).toBe(1);
        // The human retries the same request at the same revision.
        await expect(path.deliver("req-1", 4, "Queued message")).resolves.toEqual({ ok: true });
        // A third replay after the known success is refused and sends nothing.
        await expect(path.deliver("req-1", 4, "Queued message")).resolves.toEqual({ ok: false });
        await expect(path.deliver("req-1", 5, "Queued message")).resolves.toEqual({ ok: false });

        run.gateway.release();
        await settled(run);

        expect(await userMessagesWith(run, "Queued message")).toHaveLength(1);
        // The tool step finished without the message; it reached the model once, after the answer.
        expect(run.gateway.requests).toHaveLength(3);
        const last = conversation(run.gateway.requests[2]);
        expect(last.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "tool",
          "assistant",
          "user",
        ]);
        expect(last.at(-1)?.content).toContain("Queued message");
        // Terminal ordering is the producer's: one execution served the first prompt and the queued
        // input, and it settled once, after the queued input was answered.
        expect(count(run.events, "session.execution.started")).toBe(1);
        expect(count(run.events, "session.execution.succeeded")).toBe(1);
        expect(count(run.events, "session.inbox.enqueued"), "the retry stored no second copy").toBe(
          2,
        );
        const lines = path.sink.events.map((event) => (event as { extra?: unknown }).extra);
        expect(lines).toMatchObject([
          { outcome: "refused", reason: "delivery-unconfirmed", inputBinding: "bound" },
          { outcome: "accepted", inputBinding: "reused", requestId: "req-1" },
        ]);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "keeps one productive steered input when the retry arrives after the running turn consumed it",
    async () => {
      await withRun(["tool-held", "text-held", "text"], async (run) => {
        await run.client.prompt(run.sessionId, "First prompt");
        await expect.poll(() => run.gateway.requests.length, { timeout: 30_000 }).toBe(1);
        const lost = { lost: 0 };
        const path = deliveryPath(
          run,
          createOpenCodeV2HttpClient({
            endpoint: run.endpoint,
            password: run.password,
            fetch: acknowledgementLosingFetch(lost),
          }),
        );

        await expect(path.deliver("req-1", 4, "Steered message", "steer")).resolves.toEqual({
          ok: false,
        });
        // The running turn takes the steered message with its next model request, which stays held
        // so the turn is still running when the retry arrives.
        run.gateway.release();
        await expect.poll(() => run.gateway.requests.length, { timeout: 30_000 }).toBe(2);
        expect(lastUserContent(run.gateway.requests[1])).toContain("Steered message");

        await expect(path.deliver("req-1", 4, "Steered message", "steer")).resolves.toEqual({
          ok: true,
        });
        run.gateway.release();
        await settled(run);

        expect(await userMessagesWith(run, "Steered message")).toHaveLength(1);
        expect(
          run.gateway.requests,
          "the retry did not reach the model a second time",
        ).toHaveLength(2);
        expect(count(run.events, "session.execution.started")).toBe(1);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "stores distinct requests as distinct inputs under ascending ids that follow the producer's own",
    async () => {
      await withRun(["tool-held", "text", "text", "text"], async (run) => {
        await run.client.prompt(run.sessionId, "First prompt");
        await expect.poll(() => run.gateway.requests.length, { timeout: 30_000 }).toBe(1);
        const path = deliveryPath(run, run.client);

        await expect(path.deliver("req-1", 4, "Queued one")).resolves.toEqual({ ok: true });
        await expect(path.deliver("req-2", 5, "Queued two")).resolves.toEqual({ ok: true });
        run.gateway.release();
        await settled(run);

        const [first] = await userMessagesWith(run, "First prompt");
        const [one] = await userMessagesWith(run, "Queued one");
        const [two] = await userMessagesWith(run, "Queued two");
        expect(
          [first, one, two].every((id) => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u.test(id ?? "")),
        ).toBe(true);
        expect((one ?? "") > (first ?? ""), "after the session's earlier message").toBe(true);
        expect((two ?? "") > (one ?? ""), "after the earlier request").toBe(true);
        expect(run.gateway.requests).toHaveLength(4);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "frees the request when the producer itself refused the message, and the retry stores one input",
    async () => {
      await withRun(["tool-held", "text", "text"], async (run) => {
        await run.client.prompt(run.sessionId, "First prompt");
        await expect.poll(() => run.gateway.requests.length, { timeout: 30_000 }).toBe(1);
        // The producer itself refuses the first send: it holds no session under the id that send
        // names (a declared 404), and stores nothing. The admitted bytes travel inline, so a file
        // that changes after admission no longer provokes a refusal (#3897 review).
        let refuse = true;
        const client: OpenCodeV2HttpClient = {
          ...run.client,
          prompt: (sessionId, ...rest) =>
            run.client.prompt(refuse ? "ses_not_held_by_the_producer" : sessionId, ...rest),
        };
        const path = deliveryPath(run, client);
        const request = {
          delivery: "queue" as const,
          references: [{ path: NOTES_FILE }],
          requestId: "req-1",
        };
        const admitted = path.port.admitPromptInputs(RUN_ID, request);
        if (!admitted.ok) throw new Error("expected admission");

        await expect(
          path.port.deliverPrompt(RUN_ID, "See the notes", admitted.inputs),
        ).resolves.toBe(false);
        expect(await userMessagesWith(run, "See the notes")).toHaveLength(0);

        refuse = false;
        await expect(
          path.port.deliverPrompt(RUN_ID, "See the notes", admitted.inputs),
        ).resolves.toBe(true);
        run.gateway.release();
        await settled(run);

        expect(await userMessagesWith(run, "See the notes")).toHaveLength(1);
        const lines = path.sink.events.map((event) => (event as { extra?: unknown }).extra);
        expect(lines).toMatchObject([
          { outcome: "refused", reason: "delivery-refused", inputBinding: "bound" },
          { outcome: "accepted", inputBinding: "bound" },
        ]);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "sends nothing for a retry once the turn was cancelled, and leaves the settled turn alone",
    async () => {
      await withRun(["tool-held", "text", "text"], async (run) => {
        await run.client.prompt(run.sessionId, "First prompt");
        await expect.poll(() => run.gateway.requests.length, { timeout: 30_000 }).toBe(1);
        const lost = { lost: 0 };
        const inFlight = { value: true };
        const path = deliveryPath(
          run,
          createOpenCodeV2HttpClient({
            endpoint: run.endpoint,
            password: run.password,
            fetch: acknowledgementLosingFetch(lost),
          }),
          () => inFlight.value,
        );

        await expect(path.deliver("req-1", 4, "Queued message")).resolves.toEqual({ ok: false });
        inFlight.value = false;
        path.controller.abort();
        await expect(path.deliver("req-1", 4, "Queued message")).resolves.toMatchObject({
          ok: false,
        });
        run.gateway.release();
        await settled(run);

        expect(await userMessagesWith(run, "Queued message")).toHaveLength(1);
        expect(count(run.events, "session.execution.started")).toBe(1);
      });
    },
    120_000,
  );

  // S15: a referenced file reaches the model request. The attachment is the one Keiko's resolver
  // produces: the bytes it admitted, inline as a `data:` URI, under the file's own name, so the
  // runtime never reopens the path (a hard link swapped in after admission is not what the model
  // reads, #3897 review). The typed text stays the user's visible message in the runtime's history
  // and in Keiko's timeline projection, and the file's content stays out of both.
  it.skipIf(skip)(
    "reads a referenced workspace file into the model request and keeps the message text visible",
    async () => {
      await withRun(["text"], async (run) => {
        const resolved = resolvePromptReferences({
          workspaceRoot: run.fixture.workspace,
          references: [{ path: NOTES_FILE }, { path: AWKWARD_FILE }],
          remainingRunBytes: 1_000_000,
        });
        if (!resolved.ok) throw new Error("expected the references to resolve");
        const typed = `Summarize @${NOTES_FILE} and @${AWKWARD_FILE}`;
        // After admission the path names an outside file through a hard link.
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "keiko-reference-outside-")));
        writeFileSync(join(outside, "canary.md"), OUTSIDE_CANARY);
        rmSync(join(run.fixture.workspace, NOTES_FILE));
        linkSync(join(outside, "canary.md"), join(run.fixture.workspace, NOTES_FILE));

        await run.client.prompt(run.sessionId, typed, undefined, undefined, {
          files: resolved.files,
        });
        await settled(run);

        expect(run.gateway.requests).toHaveLength(1);
        const modelSaw = lastUserContent(run.gateway.requests[0]);
        expect(modelSaw).toContain(typed);
        expect(modelSaw).toContain(`Attached file: ${NOTES_FILE}`);
        expect(modelSaw).toContain(NOTES_CANARY);
        expect(modelSaw).not.toContain(OUTSIDE_CANARY);
        expect(modelSaw).toContain(`Attached file: ${AWKWARD_FILE}`);
        expect(modelSaw).toContain(AWKWARD_CANARY);

        // The runtime keeps the typed text as the message; the bytes ride in `files` alone.
        const messages = await run.client.messages(run.sessionId);
        const user = messages.find((message) => message.type === "user");
        expect(user?.text).toBe(typed);
        expect(Array.isArray(user?.files)).toBe(true);

        // Keiko's own history projection accepts a user message with attachments and shows the
        // typed text, not the file content, to the timeline and to Coding History.
        const captured: CodingHistoryMessage[] = [];
        const projection = createOpenCodeV2HistoryProjection({
          runId: "run-prompt-inputs",
          activityLog: undefined,
          toolProfile: "native",
          captureMessages: (conversationMessages): boolean => {
            captured.splice(0, captured.length, ...conversationMessages);
            return true;
          },
        });
        const events = projection.project(run.sessionId, messages, undefined);
        const signals = events.flatMap((event) => {
          const signal = projection.takeSignal(event);
          return signal === undefined ? [] : [signal];
        });
        expect(JSON.stringify(signals)).toContain(typed);
        expect(JSON.stringify(signals)).not.toContain(NOTES_CANARY);
        expect(captured.find((message) => message.role === "user")?.content).toBe(typed);
        expect(JSON.stringify(captured)).not.toContain(AWKWARD_CANARY);
      });
    },
    120_000,
  );

  // The pinned runtime itself answers a refused attachment with a 400 and starts nothing: a file it
  // cannot read, an image it cannot decode (Keiko's resolver never sends one: it admits UTF-8 text
  // only), and a delivery outside the closed vocabulary. The Keiko client sends no path at all: a
  // `file://` attachment is refused before a byte leaves (`opencode-v2-prompt-file-invalid`).
  it.skipIf(skip)(
    "refuses an unreadable attachment, an undecodable image and an unknown delivery with a 400",
    async () => {
      await withRun(["text"], async (run) => {
        // A PNG signature with nothing behind it: recognised as an image, which cannot be decoded.
        const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        writeFileSync(join(run.fixture.workspace, "fake.png"), Buffer.from(pngSignature));
        const attempt = (
          files: readonly unknown[],
          extra: Record<string, unknown> = {},
        ): ReturnType<Run["raw"]> =>
          run.raw("POST", `/api/session/${run.sessionId}/prompt`, { text: "t", files, ...extra });
        const missing = join(run.fixture.workspace, "missing.md");
        const refusals = [
          await attempt([{ uri: `file://${missing}`, name: "missing.md" }]),
          await attempt([{ uri: `file://${join(run.fixture.workspace, "fake.png")}` }]),
          await attempt([], { delivery: "interrupt" }),
        ];
        expect(refusals.map((refusal) => refusal.status)).toEqual([400, 400, 400]);
        expect(run.gateway.requests).toHaveLength(0);
        expect(count(run.events, "session.execution.started")).toBe(0);
        await expect(
          run.client.prompt(run.sessionId, "t", undefined, undefined, {
            files: [{ uri: `file://${missing}`, name: "missing.md" }],
          }),
        ).rejects.toThrow("opencode-v2-prompt-file-invalid");
        expect(count(run.events, "session.execution.started")).toBe(0);
      });
    },
    120_000,
  );
});

// C02 (ADR-0137 D10): the runtime's slash commands. `command.list` names them, `session.command` runs
// one as a turn: the runtime expands its own template around the text and runs the execution the
// way it runs a prompt. The body has no message id and no metadata, which is why a command turn
// carries no hidden context and is shown by Keiko's own presentation of what the operator typed.
describe("pinned native OpenCode slash commands", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  /** The runtime registers its built-ins asynchronously after the instance boots. */
  async function listed(run: Run): Promise<readonly OpenCodeV2Command[]> {
    await expect
      .poll(async () => (await run.client.commands()).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    return await run.client.commands();
  }

  it.skipIf(skip)(
    "lists exactly the built-in commands the contract names, with the producer's descriptions",
    async () => {
      await withRun([], async (run) => {
        const commands = await listed(run);

        expect(commands.map(({ name }) => name).sort()).toEqual([
          ...CODING_WORKBENCH_BUILT_IN_COMMAND_NAMES,
        ]);
        expect(commands).toEqual([
          { name: "init", description: "guided AGENTS.md setup" },
          {
            name: "review",
            description: "review changes [commit|branch|pr], defaults to uncommitted",
          },
        ]);
        // The raw route carries the location beside the list and the client reads only the list.
        const raw = await run.raw("GET", "/api/command");
        expect(raw.status).toBe(200);
        expect(Object.keys(raw.body as object).sort()).toEqual(["data", "location"]);
        // What Keiko hands the browser is a listing its own contract accepts.
        const projection = projectCommands(commands);
        expect(projection.skippedCount).toBe(0);
        expect(
          validateCodingWorkbenchRuntimeCommandsChannelPayload({
            session: "active",
            commands: projection.commands,
          }).ok,
        ).toBe(true);
      });
    },
    120_000,
  );

  // The producer's review template reaches the model request and the execution ends idle, exactly
  // like a prompt turn: Keiko's one settlement covers it.
  it.skipIf(skip)(
    "runs review as a turn: the model receives the producer's review template and the execution ends idle",
    async () => {
      await withRun(["text"], async (run) => {
        await listed(run);

        await run.client.command(run.sessionId, "review", "the main branch");
        await settled(run);

        expect(run.gateway.requests).toHaveLength(1);
        const modelSaw = lastUserContent(run.gateway.requests[0]);
        expect(modelSaw).toContain("You are a code reviewer");
        expect(modelSaw).toContain("Review all uncommitted changes");
        // The text after the command is the template's input.
        expect(modelSaw).toContain("Input: the main branch");
        expect(count(run.events, "session.execution.started")).toBe(1);
        expect(count(run.events, "session.execution.succeeded")).toBe(1);

        const messages = await run.client.messages(run.sessionId);
        expect(messages.map((message) => message.type)).toEqual(["user", "assistant", "idle"]);
        expect(messages.at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" });
        // The runtime stores the expanded template as the user message and marks no command on it.
        const user = messages.find((message) => message.type === "user");
        expect(String(user?.text)).toContain("You are a code reviewer");
        expect(Object.keys(user ?? {}).sort()).toEqual(["id", "text", "time", "type"]);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "runs init with no arguments and neither built-in template substitutes a shell command",
    async () => {
      await withRun(["text", "text"], async (run) => {
        await listed(run);

        await run.client.command(run.sessionId, "init", "");
        await settled(run);
        const initSaw = lastUserContent(run.gateway.requests[0]);
        expect(initSaw).toContain("Create or update");
        expect(initSaw).toContain("AGENTS.md");

        await run.client.command(run.sessionId, "review", "");
        await expect
          .poll(() => count(run.events, "session.execution.succeeded"), { timeout: 30_000 })
          .toBe(2);
        // A template that substituted a shell command would run it in the runtime, outside the
        // native policy hook. The pinned built-ins do not; the list above is what pins that.
        const templates = (await run.client.messages(run.sessionId))
          .filter((message) => message.type === "user")
          .map((message) => String(message.text));
        expect(templates).toHaveLength(2);
        for (const template of templates) expect(template).not.toMatch(/![`]/u);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "answers an unknown command with 404 and starts nothing",
    async () => {
      await withRun(["text"], async (run) => {
        await listed(run);

        const failure: unknown = await run.client
          .command(run.sessionId, "no-such-command", "")
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(OpenCodeV2HttpStatusError);
        expect((failure as OpenCodeV2HttpStatusError).status).toBe(404);
        const raw = await run.raw("POST", `/api/session/${run.sessionId}/command`, {
          name: "no-such-command",
          text: "",
        });
        expect(raw).toMatchObject({ status: 404, body: { _tag: "CommandNotFoundError" } });
        expect(run.gateway.requests).toHaveLength(0);
        expect(count(run.events, "session.execution.started")).toBe(0);
      });
    },
    120_000,
  );

  // Why Keiko dispatches a command only as the start of a turn: sent while a turn runs, the runtime
  // takes it into the running execution at the next step, like a steered message, where it would
  // steer a turn Keiko's accounting believes it is not waiting on.
  it.skipIf(skip)(
    "takes a command sent to a running turn into that execution instead of starting another",
    async () => {
      await withRun(["tool-held", "text"], async (run) => {
        await listed(run);
        await run.client.prompt(run.sessionId, "First prompt");
        await expect.poll(() => run.gateway.requests.length, { timeout: 30_000 }).toBe(1);

        await run.client.command(run.sessionId, "review", "");
        run.gateway.release();
        await settled(run);

        expect(count(run.events, "session.execution.started")).toBe(1);
        expect(run.gateway.requests).toHaveLength(2);
        expect(conversation(run.gateway.requests[1]).map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "tool",
          "user",
        ]);
        expect(lastUserContent(run.gateway.requests[1])).toContain("You are a code reviewer");
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "attaches a referenced file to a command turn like it does to a prompt",
    async () => {
      await withRun(["text"], async (run) => {
        await listed(run);
        const resolved = resolvePromptReferences({
          workspaceRoot: run.fixture.workspace,
          references: [{ path: NOTES_FILE }],
          remainingRunBytes: 1_000_000,
        });
        if (!resolved.ok) throw new Error("expected the reference to resolve");

        await run.client.command(run.sessionId, "review", `@${NOTES_FILE}`, undefined, {
          files: resolved.files,
        });
        await settled(run);

        const modelSaw = lastUserContent(run.gateway.requests[0]);
        expect(modelSaw).toContain("You are a code reviewer");
        expect(modelSaw).toContain(`Attached file: ${NOTES_FILE}`);
        expect(modelSaw).toContain(NOTES_CANARY);
      });
    },
    120_000,
  );

  // The runtime marks no command on the stored message, so Keiko presents the turn by what the
  // operator typed: the armed presentation binds the first new user message after the post.
  it.skipIf(skip)(
    "presents a command turn by what was typed in the timeline and in Coding History, never the template",
    async () => {
      await withRun(["text"], async (run) => {
        await listed(run);
        const presentation = createOpenCodeCommandPresentation();
        const captured: CodingHistoryMessage[] = [];
        const projection = createOpenCodeV2HistoryProjection({
          runId: RUN_ID,
          activityLog: undefined,
          toolProfile: "native",
          userMessageDisplay: presentation.displayFor,
          captureMessages: (messages): boolean => {
            captured.splice(0, captured.length, ...messages);
            return true;
          },
        });
        const project = async (): Promise<string> => {
          const events = projection.project(
            run.sessionId,
            await run.client.messages(run.sessionId),
            undefined,
          );
          return JSON.stringify(
            events.flatMap((event) => {
              const signal = projection.takeSignal(event);
              return signal === undefined ? [] : [signal];
            }),
          );
        };

        presentation.arm(commandDisplayText("review", "the main branch"));
        await run.client.command(run.sessionId, "review", "the main branch");
        await settled(run);
        const shown = await project();

        expect(shown).toContain("/review the main branch");
        expect(shown).not.toContain("You are a code reviewer");
        expect(captured.find((message) => message.role === "user")?.content).toBe(
          "/review the main branch",
        );
        expect(JSON.stringify(captured)).not.toContain("You are a code reviewer");
        // The same projection read again keeps the presentation.
        expect(await project()).toContain("/review the main branch");
      });
    },
    120_000,
  );
});

/**
 * Keiko's own admission over the real session: the production task dispatcher with the run's real
 * prompt-input and command ports, and a turn port whose submission is the call the composition makes
 * for a turn's admitted inputs (a prompt with the attachments, or the session command). The dispatcher
 * gives the stale-revision, single-use request id and refusal semantics of a Workbench request; the
 * composition's own mapping from inputs to the HTTP call is pinned in `opencodeRuntimeComposition.test.ts`.
 */
interface TurnPath {
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
  readonly dispatch: (operation: {
    readonly requestId: string;
    readonly expectedRevision: number;
    readonly taskIntent: string;
    readonly command?: { readonly name: string };
    readonly references?: readonly { readonly path: string }[];
  }) => Promise<{ readonly ok: boolean; readonly reason?: string | undefined }>;
}

function turnPath(run: Run): TurnPath {
  const sink = createBufferedServerLogSink();
  const promptRun: PromptInputsRun = {
    runId: RUN_ID,
    workspaceRoot: run.fixture.workspace,
    sessionId: run.sessionId,
    client: run.client,
    runtimeAdapter: { turnInFlight: (): boolean => false },
    ready: true,
  };
  const capabilities = openCodePromptInputs("native");
  const inputs = createOpenCodePromptInputsRunPort({
    readyRun: (): PromptInputsRun => promptRun,
    capabilities,
    activityLog: sink,
    recordPostFailure: (): void => undefined,
  });
  const commands = createOpenCodeCommandsRunPort({
    readyRun: () => ({ runId: RUN_ID, client: run.client }),
    capabilities,
    activityLog: sink,
  });
  const dispatcher = createProductionRuntimeTaskDispatcher(
    new Map([
      [
        RUN_ID,
        {
          turnPort: {
            submitTurn: async (_runId, text, _context, _agent, admitted): Promise<boolean> => {
              const files = admitted?.files ?? [];
              const withFiles = files.length === 0 ? undefined : { files };
              if (admitted?.command !== undefined) {
                await run.client.command(
                  run.sessionId,
                  admitted.command.name,
                  text,
                  undefined,
                  withFiles,
                );
              } else {
                await run.client.prompt(run.sessionId, text, undefined, undefined, withFiles);
              }
              return true;
            },
            abortTurn: (): Promise<boolean> => Promise.resolve(true),
            waitForTerminal: (): Promise<"succeeded"> => Promise.resolve("succeeded" as const),
            admitPromptInputs: inputs.admitPromptInputs,
            deliverPrompt: inputs.deliverPrompt,
            listCommands: commands.listCommands,
            admitCommand: commands.admitCommand,
          },
          controller: new AbortController(),
          operationGuard: createProductionRuntimeOperationGuard(RUN_ID, (): boolean => true),
        },
      ],
    ]),
    { record: (): void => undefined },
  );
  return {
    sink,
    dispatch: (operation) => dispatcher.dispatch({ runId: RUN_ID, ...operation }),
  };
}

const lineOf = (event: unknown): Record<string, unknown> =>
  (event as { extra: Record<string, unknown> }).extra;

describe("pinned native OpenCode commands and first-prompt references through Keiko's admission", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "starts a turn as review through the production dispatcher and records the command body-free",
    async () => {
      await withRun(["text"], async (run) => {
        await expect
          .poll(async () => (await run.client.commands()).length, { timeout: 30_000 })
          .toBeGreaterThan(0);
        const path = turnPath(run);

        await expect(
          path.dispatch({
            requestId: "req-1",
            expectedRevision: 1,
            taskIntent: "the main branch",
            command: { name: "review" },
          }),
        ).resolves.toMatchObject({ ok: true });
        await settled(run);

        expect(lastUserContent(run.gateway.requests[0])).toContain("Input: the main branch");
        expect(lastUserContent(run.gateway.requests[0])).toContain("You are a code reviewer");
        expect(path.sink.events).toHaveLength(0);
        // A replay of the settled request is refused and sends nothing.
        await expect(
          path.dispatch({
            requestId: "req-1",
            expectedRevision: 1,
            taskIntent: "the main branch",
            command: { name: "review" },
          }),
        ).resolves.toEqual({ ok: false });
        expect(run.gateway.requests).toHaveLength(1);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "refuses a command the runtime does not list before anything is reserved, and the request id stays usable",
    async () => {
      await withRun(["text"], async (run) => {
        await expect
          .poll(async () => (await run.client.commands()).length, { timeout: 30_000 })
          .toBeGreaterThan(0);
        const path = turnPath(run);

        await expect(
          path.dispatch({
            requestId: "req-1",
            expectedRevision: 1,
            taskIntent: "",
            command: { name: "no-such-command" },
          }),
        ).resolves.toEqual({ ok: false, reason: "inputs-refused" });
        expect(run.gateway.requests).toHaveLength(0);
        expect(count(run.events, "session.inbox.enqueued")).toBe(0);
        expect(path.sink.events.map(lineOf)).toMatchObject([
          {
            outcome: "refused",
            reason: "command-unknown",
            command: "other",
            commandArgumentBytes: 0,
          },
        ]);

        // Nothing was reserved: the same request id and revision run a listed command.
        await expect(
          path.dispatch({
            requestId: "req-1",
            expectedRevision: 1,
            taskIntent: "",
            command: { name: "init" },
          }),
        ).resolves.toMatchObject({ ok: true });
        await settled(run);
        expect(lastUserContent(run.gateway.requests[0])).toContain("AGENTS.md");
      });
    },
    120_000,
  );

  // S15: the first prompt resolves its references against the run's own workspace when the turn is
  // dispatched, through the same admission as a follow-up's, and the producer attaches the file.
  it.skipIf(skip)(
    "attaches a file referenced by the first prompt to the first model request",
    async () => {
      await withRun(["text"], async (run) => {
        const path = turnPath(run);

        await expect(
          path.dispatch({
            requestId: "start-1",
            expectedRevision: 1,
            taskIntent: `Summarize @${NOTES_FILE}`,
            references: [{ path: NOTES_FILE }],
          }),
        ).resolves.toMatchObject({ ok: true });
        await settled(run);

        expect(run.gateway.requests).toHaveLength(1);
        const modelSaw = lastUserContent(run.gateway.requests[0]);
        expect(modelSaw).toContain(`Summarize @${NOTES_FILE}`);
        expect(modelSaw).toContain(`Attached file: ${NOTES_FILE}`);
        expect(modelSaw).toContain(NOTES_CANARY);
        // The typed text stays the visible first message; the bytes ride in `files` alone.
        const user = (await run.client.messages(run.sessionId)).find(
          (message) => message.type === "user",
        );
        expect(user?.text).toBe(`Summarize @${NOTES_FILE}`);
        expect(path.sink.events.map(lineOf)).toEqual([]);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "refuses the first prompt for a hostile reference and sends nothing, rather than starting without it",
    async () => {
      await withRun(["text"], async (run) => {
        writeFileSync(join(run.fixture.workspace, ".env"), "TOKEN=SENSITIVE-CANARY\n");
        const path = turnPath(run);

        for (const [requestId, reference, reason] of [
          ["start-1", ".env", "reference-sensitive"],
          ["start-2", "missing.md", "reference-unreadable"],
          ["start-3", "../outside.md", "reference-invalid"],
        ] as const) {
          await expect(
            path.dispatch({
              requestId,
              expectedRevision: 1,
              taskIntent: `Look at @${reference}`,
              references: [{ path: NOTES_FILE }, { path: reference }],
            }),
          ).resolves.toEqual({ ok: false, reason: "inputs-refused" });
          expect(path.sink.events.map(lineOf).at(-1)).toMatchObject({ outcome: "refused", reason });
        }

        expect(run.gateway.requests).toHaveLength(0);
        expect(count(run.events, "session.inbox.enqueued")).toBe(0);
        expect(JSON.stringify(path.sink.events)).not.toMatch(/SENSITIVE|\.env|missing\.md/u);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "starts a turn that is both a command and carries a file, attaching the file to the command's message",
    async () => {
      await withRun(["text"], async (run) => {
        await expect
          .poll(async () => (await run.client.commands()).length, { timeout: 30_000 })
          .toBeGreaterThan(0);
        const path = turnPath(run);

        await expect(
          path.dispatch({
            requestId: "start-1",
            expectedRevision: 1,
            taskIntent: `@${NOTES_FILE}`,
            command: { name: "review" },
            references: [{ path: NOTES_FILE }],
          }),
        ).resolves.toMatchObject({ ok: true });
        await settled(run);

        const modelSaw = lastUserContent(run.gateway.requests[0]);
        expect(modelSaw).toContain("You are a code reviewer");
        expect(modelSaw).toContain(NOTES_CANARY);
      });
    },
    120_000,
  );
});
