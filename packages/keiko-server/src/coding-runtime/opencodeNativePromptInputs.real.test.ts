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
import { buildOpenCodeLaunchProfile, openCodeConfigDirectory } from "./opencodeLaunchProfile.js";
import { resolvePromptReferences } from "./opencodePromptInputs.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";
import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";
import type { CodingHistoryMessage } from "./codingRuntimeHistory.js";

/**
 * Original-runtime proof of the two prompt inputs a native run takes beyond its text (#3897,
 * ADR-0137 D10, parity rows S07 and S15): a message sent while a turn runs (`delivery: "steer"` or
 * `"queue"`) and a workspace file the human referenced (`files`). The pinned executable runs under
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
    await body({ fixture, gateway, client, sessionId: session.id, events, raw });
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

  // S15: a referenced file reaches the model request. The attachment is the one Keiko's resolver
  // produces (a `file://` URI of the real path inside the workspace), including a name that needs
  // percent-encoding; the typed text stays the user's visible message in the runtime's history and
  // in Keiko's timeline projection, and the file's content stays out of both.
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

        await run.client.prompt(run.sessionId, typed, undefined, undefined, {
          files: resolved.files,
        });
        await settled(run);

        expect(run.gateway.requests).toHaveLength(1);
        const modelSaw = lastUserContent(run.gateway.requests[0]);
        expect(modelSaw).toContain(typed);
        expect(modelSaw).toContain(`Attached file: ${NOTES_FILE}`);
        expect(modelSaw).toContain(NOTES_CANARY);
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

  // The pinned runtime itself answers a refused attachment with a 400 and starts nothing, which the
  // Keiko client surfaces as a rejected prompt (`opencode-v2-response-invalid`): a file it cannot
  // read, an image it cannot decode (Keiko's resolver never sends one: it admits UTF-8 text only),
  // and a delivery outside the closed vocabulary.
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
        ).rejects.toThrow("opencode-v2-response-invalid");
      });
    },
    120_000,
  );
});
