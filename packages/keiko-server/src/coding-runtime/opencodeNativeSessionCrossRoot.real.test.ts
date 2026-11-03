import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import { createCodingSessionContinuity } from "./codingSessionContinuity.js";
import { buildOpenCodeLaunchProfile, openCodeConfigDirectory } from "./opencodeLaunchProfile.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import {
  bindContinuedSession,
  continuationWorkspaceKey,
  retainSettledRun,
  seedContinuation,
  type SessionContinuationContext,
} from "./opencodeSessionContinuation.js";
import {
  createRetainedSessionStore,
  retainedSessionKey,
  type RetainedSessionStore,
} from "./opencodeSessionRetention.js";
import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";

/**
 * Original-runtime proof of a governed continuation into a new managed workspace (#3903 AC4, #3902
 * AC3, ADR-0137 D10). A task's run settles in its workspace and is retained; a second workspace is
 * provisioned from it as a git worktree of its task branch. A new run in that workspace forks the
 * task: Keiko's retention store admits the entry only for the target's exact provisioning source,
 * audits the copy at the source location, and the pinned runtime's own `session.move` places the
 * session at the new root before the fork. The source entry stays resumable in its own workspace;
 * an unrelated workspace or a mismatched source is refused with nothing changed. Run with
 * KEIKO_OPENCODE_REAL_BINARY and KEIKO_OPENCODE_REAL_RESOURCE_ROOT set; otherwise it is skipped.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const TASK_ID = "task-native-cross-root";
const SOURCE_WORKSPACE_ID = "workspace-source";
const TARGET_WORKSPACE_ID = "workspace-target";
const MAX_FIXTURE_BODY_BYTES = 4 * 1_024 * 1_024;

interface Stub {
  readonly server: Server;
  port: number;
  /** The user texts of every model request, in order. */
  readonly userTexts: string[][];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function userTextsOf(body: unknown): string[] {
  const messages = object(body)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: unknown) => {
    const entry = object(message);
    if (entry?.role !== "user") return [];
    const content = entry.content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part: unknown) => {
      const text = object(part)?.text;
      return typeof text === "string" ? [text] : [];
    });
  });
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function startStub(answer: (response: ServerResponse, body: unknown) => void): Promise<Stub> {
  const stub: Stub = { server: createServer(), port: 0, userTexts: [] };
  stub.server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    void readRequestBody(request)
      .then((bytes) => {
        const body = JSON.parse(bytes.toString("utf8") || "{}") as unknown;
        stub.userTexts.push(userTextsOf(body));
        answer(response, body);
      })
      .catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const address = stub.server.address();
  if (address === null || typeof address === "string") throw new Error("fixture-listener-invalid");
  stub.port = address.port;
  return stub;
}

async function startGateway(): Promise<Stub> {
  return startStub((response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      frame({
        id: "cross-root",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "Noted." }, finish_reason: null }],
      }),
    );
    response.end(
      frame({
        id: "cross-root",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }) + "data: [DONE]\n\n",
    );
  });
}

async function startFacade(): Promise<Stub> {
  return startStub((response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"effect":"allow"}');
  });
}

async function closeStub(stub: Stub): Promise<void> {
  stub.server.closeAllConnections();
  await new Promise<void>((resolve) => {
    stub.server.close(() => {
      resolve();
    });
  });
}

interface Fixture {
  readonly root: string;
  /** The task's workspace: a repository on its task branch. */
  readonly source: string;
  /** A managed workspace provisioned from it: a worktree of a branch made from its task branch. */
  readonly target: string;
  /** A repository unrelated to either. */
  readonly unrelated: string;
}

function git(root: string, args: readonly string[]): void {
  const executable = resolveDarwinGitExecutable().path;
  const env = {
    HOME: root,
    PATH: dirname(executable),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const identity = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];
  if (spawnSync(executable, [...identity, ...args], { env }).status !== 0)
    throw new Error("fixture-git-failed");
}

function repository(root: string, workspace: string): void {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "notes.txt"), "cross-root fixture\n");
  git(root, ["init", "-q", "-b", "keiko/task-source", workspace]);
  git(root, ["-C", workspace, "add", "-A"]);
  git(root, ["-C", workspace, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"]);
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-cross-root-")));
  const source = join(root, "source");
  const target = join(root, "target");
  const unrelated = join(root, "unrelated");
  repository(root, source);
  git(root, ["-C", source, "worktree", "add", "-q", "-b", "keiko/task-target", target]);
  repository(root, unrelated);
  return { root, source, target, unrelated };
}

interface World {
  readonly fixture: Fixture;
  readonly gateway: Stub;
  readonly facade: Stub;
  readonly binary: string;
  readonly runtimeRoot: string;
  readonly store: RetainedSessionStore;
}

function launch(
  world: World,
  workspace: string,
  stateRoot: string,
): { readonly child: ChildProcessByStdio<null, Readable, Readable>; readonly password: string } {
  const profile = buildOpenCodeLaunchProfile({
    executable: world.binary,
    stateRoot,
    toolProfile: "native",
    contextGeometry: {
      contextWindowTokens: 32_768,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_096,
    },
  });
  if (!profile.ok) throw new Error("fixture-profile-invalid");
  const configRoot = openCodeConfigDirectory(stateRoot);
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
  const gitExecutable = resolveDarwinGitExecutable();
  const gatewayUrl = `http://127.0.0.1:${String(world.gateway.port)}/v1`;
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl,
    runId: "run-native-cross-root",
    treeBindingId: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    runtimeArtifactDigest: "c".repeat(64),
    modelProfileDigest: "d".repeat(64),
    profile: "keiko-native",
    filesystem: {
      workspaceRoot: workspace,
      workspaceAccess: "read-write",
      privateStateRoot: stateRoot,
      runtimeReadRoot: world.runtimeRoot,
      protectedWriteRoots: [configRoot],
    },
  });
  const command = buildRuntimeGatewaySeatbeltCommand(
    policy,
    world.binary,
    profile.args,
    gitExecutable.path,
  );
  const password = profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("fixture-password-missing");
  return {
    password,
    child: spawn(command.command, [...command.args], {
      cwd: workspace,
      env: {
        ...profile.env,
        PATH: `${dirname(gitExecutable.path)}:/usr/bin:/bin`,
        KEIKO_MODEL_GATEWAY_URL: gatewayUrl,
        KEIKO_MODEL_GATEWAY_CAPABILITY: "fixture-gateway-capability",
        KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(world.facade.port)}/native-policy`,
        KEIKO_TOOL_FACADE_CAPABILITY: "fixture-facade-capability",
        KEIKO_CODING_RUN_ID: "run-native-cross-root",
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
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("fixture-child-exited"));
    });
  });
}

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

/** One runtime in `workspace` on its own private state, seeded before it starts. */
async function withRuntime(
  world: World,
  workspace: string,
  name: string,
  seed: (() => void) | undefined,
  body: (client: OpenCodeV2HttpClient) => Promise<void>,
): Promise<void> {
  const stateRoot = join(world.fixture.root, name);
  mkdirSync(join(stateRoot, "state"), { recursive: true, mode: 0o700 });
  seed?.();
  const launched = launch(world, workspace, stateRoot);
  try {
    const endpoint = await childEndpoint(launched.child);
    await body(createOpenCodeV2HttpClient({ endpoint, password: launched.password }));
  } finally {
    await stopChild(launched.child);
  }
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
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

async function turn(client: OpenCodeV2HttpClient, sessionId: string, text: string): Promise<void> {
  await client.prompt(sessionId, text);
  await expect
    .poll(async () => !Object.hasOwn(await client.active(), sessionId), { timeout: 30_000 })
    .toBe(true);
}

function context(
  world: World,
  workspaceId: string,
  events: ServerLogEvent[],
  source?: SessionContinuationContext["forkSource"],
): SessionContinuationContext {
  return {
    service: createCodingSessionContinuity({ store: world.store, taskOfRun: () => TASK_ID }),
    workspaceId,
    runtimeVersion: OPENCODE_PINNED_VERSION,
    maxInputTokens: 24_000,
    activityLog: { write: (event) => void events.push(event) },
    ...(source === undefined ? {} : { forkSource: source }),
  };
}

/** The task's first run settles in its own workspace and its session is retained there. */
async function settledSourceRun(world: World, events: ServerLogEvent[]): Promise<void> {
  let sessionId = "";
  await withRuntime(world, world.fixture.source, "source-run", undefined, async (client) => {
    sessionId = String((await client.createSession(world.fixture.source)).id);
    await turn(client, sessionId, "FIRST-QUESTION");
  });
  retainSettledRun(
    context(world, SOURCE_WORKSPACE_ID, events),
    {
      runId: "run-100000001",
      runRoot: join(world.fixture.root, "source-run"),
      workspaceRoot: world.fixture.source,
      sessionId,
    },
    "succeeded",
  );
  expect(existsSync(join(world.fixture.root, "retained", retainedSessionKey(TASK_ID)))).toBe(true);
}

const SOURCE =
  (world: World): NonNullable<SessionContinuationContext["forkSource"]> =>
  () => ({
    workspaceKey: continuationWorkspaceKey(SOURCE_WORKSPACE_ID, world.fixture.source),
    directory: world.fixture.source,
  });

describe("native continuation into a managed workspace provisioned from the task's own", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "forks the task into the new root through the runtime's own move and keeps the source resumable",
    async () => {
      await withWorld(async (world) => {
        const events: ServerLogEvent[] = [];
        await settledSourceRun(world, events);
        const target = context(world, TARGET_WORKSPACE_ID, events, SOURCE(world));
        const runId = "run-100000002";
        target.service.declare(runId, {
          kind: "fork",
          sourceTaskId: TASK_ID,
          boundary: { kind: "end" },
        });
        const location = {
          runId,
          runRoot: join(world.fixture.root, "target-run"),
          workspaceRoot: world.fixture.target,
        };
        let continued: ReturnType<typeof seedContinuation>;
        await withRuntime(
          world,
          world.fixture.target,
          "target-run",
          () => {
            continued = seedContinuation(target, location);
          },
          async (client) => {
            if (continued === undefined) throw new Error("fixture-cross-root-not-seeded");
            const bound = await bindContinuedSession(
              client,
              continued,
              world.fixture.target,
              undefined,
            );
            if (!bound.ok) throw new Error(`fixture-bind-refused:${bound.reason}`);
            const sessions = await client.sessions();
            expect(sessions.map((session) => session.id)).toEqual([bound.sessionId]);
            expect(object(sessions[0]?.location)?.directory).toBe(world.fixture.target);
            await turn(client, bound.sessionId, "SECOND-QUESTION");
            // The continued session carries the task's history into the new root.
            const last = world.gateway.userTexts.at(-1) ?? [];
            expect(last.some((text) => text.includes("FIRST-QUESTION"))).toBe(true);
            expect(last.some((text) => text.includes("SECOND-QUESTION"))).toBe(true);
          },
        );
        // The source task's own entry is untouched: its next run resumes it in its own workspace.
        const source = context(world, SOURCE_WORKSPACE_ID, events);
        source.service.declare("run-100000003", { kind: "resume", taskId: TASK_ID });
        mkdirSync(join(world.fixture.root, "resume-run", "state"), {
          recursive: true,
          mode: 0o700,
        });
        const resumed = seedContinuation(source, {
          runId: "run-100000003",
          runRoot: join(world.fixture.root, "resume-run"),
          workspaceRoot: world.fixture.source,
        });
        expect(resumed).toMatchObject({ taskId: TASK_ID, intent: { kind: "resume" } });
        expect(source.service.outcome("run-100000003")).toBeUndefined();
        expect(resumed?.sourceDirectory).toBeUndefined();
        expect(
          events.some(
            (event) =>
              event.op === "coding-runtime.session-continuity" && event.extra?.outcome === "fresh",
          ),
        ).toBe(false);
      });
    },
    240_000,
  );

  it.skipIf(skip)(
    "refuses an unrelated workspace or a mismatched source and leaves the entry as it was",
    async () => {
      await withWorld(async (world) => {
        const events: ServerLogEvent[] = [];
        await settledSourceRun(world, events);
        const fork = { kind: "fork", sourceTaskId: TASK_ID, boundary: { kind: "end" } } as const;
        // No provisioning source: the target's own binding does not match the entry.
        const unrelated = context(world, "workspace-unrelated", events);
        unrelated.service.declare("run-100000004", fork);
        expect(
          seedContinuation(unrelated, {
            runId: "run-100000004",
            runRoot: join(world.fixture.root, "unrelated-run"),
            workspaceRoot: world.fixture.unrelated,
          }),
        ).toBeUndefined();
        expect(unrelated.service.outcome("run-100000004")).toEqual({
          kind: "fresh",
          reason: "workspace-changed",
        });
        // A named source that is not the entry's own workspace is refused the same way.
        const mismatched = context(world, TARGET_WORKSPACE_ID, events, () => ({
          workspaceKey: continuationWorkspaceKey("workspace-elsewhere", world.fixture.source),
          directory: world.fixture.source,
        }));
        mismatched.service.declare("run-100000005", fork);
        expect(
          seedContinuation(mismatched, {
            runId: "run-100000005",
            runRoot: join(world.fixture.root, "mismatched-run"),
            workspaceRoot: world.fixture.target,
          }),
        ).toBeUndefined();
        expect(mismatched.service.outcome("run-100000005")).toEqual({
          kind: "fresh",
          reason: "workspace-changed",
        });
        expect(existsSync(join(world.fixture.root, "unrelated-run", "state", "opencode.db"))).toBe(
          false,
        );
        expect(existsSync(join(world.fixture.root, "retained", retainedSessionKey(TASK_ID)))).toBe(
          true,
        );
      });
    },
    240_000,
  );
});
