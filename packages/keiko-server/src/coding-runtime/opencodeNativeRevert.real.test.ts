import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
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
import { buildOpenCodeLaunchProfile, openCodeConfigDirectory } from "./opencodeLaunchProfile.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import {
  createOpenCodeRevertRunPort,
  noteOpenCodeEditTargets,
  openCodeNativeCallKey,
  recordOpenCodeEditSettled,
  recordOpenCodeTurnImage,
  type OpenCodeRevertRun,
} from "./opencodeRevert.js";
import { auditDatabase } from "./opencodeSessionRetention.js";
import { openCodeV2StepChanges } from "./opencodeV2History.js";
import {
  OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256,
  projectOpenCodeV2ProtocolSurface,
} from "./opencodeProtocolSurface.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import { createOpenCodeV2HttpClient, type OpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

import {
  nativeHttpToolCall,
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
 * Original-runtime proof of the undo semantics Keiko maps onto (B3, S04): the pinned native
 * OpenCode records a snapshot per turn (`snapshots: true`), `session.diff` reports what the newest
 * turn changed, `session.revert.stage` restores the workspace files and rewinds the session to a
 * user message, `session.revert.commit` makes that final, and `session.revert.clear` re-applies the
 * files. The pinned executable runs under the real native Seatbelt wrapper with the profile
 * `buildOpenCodeLaunchProfile` produces, against a scripted model gateway. Run with
 * KEIKO_OPENCODE_REAL_BINARY and KEIKO_OPENCODE_REAL_RESOURCE_ROOT set; otherwise it is skipped.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const GATEWAY_CAPABILITY = "fixture-gateway-capability";
const FACADE_CAPABILITY = "fixture-facade-capability";
const FIXTURE_FILE = "notes.txt";
const ORIGINAL_CONTENT = "revert fixture original\n";

interface ScriptedCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface GatewayStub extends Stub {
  /** While set, a request whose last message is the user's is held open instead of answered. */
  hold: boolean;
  /** While set, the request that carries a tool result is held open: the turn stays busy. */
  holdAfterTool: boolean;
  /** Rejects the model continuation after a real tool result; the SDK records a failed turn. */
  failAfterTool: boolean;
  /** Tool-call turns still to script; each answers one request whose last message is the user's. */
  toolTurns: number;
  /** The tool call a scripted turn issues. */
  call: ScriptedCall;
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

function lastRole(body: unknown): unknown {
  const messages = object(body)?.messages;
  return Array.isArray(messages) ? object(messages.at(-1))?.role : undefined;
}

function streamedTurn(response: ServerResponse, delta: unknown, finish: string): void {
  writeNativeHttpStreamedTurn(response, delta, finish, "native-revert");
}

async function startGateway(): Promise<GatewayStub> {
  const stub = await startStub((self, recorded, response) => {
    const gateway = self as GatewayStub;
    const role = lastRole(recorded.body);
    if (gateway.failAfterTool && role === "tool") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Synthetic rejected continuation", type: "invalid_request_error" },
        }),
      );
      return;
    }
    if ((gateway.hold && role === "user") || (gateway.holdAfterTool && role === "tool")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": held\n\n");
      return;
    }
    if (gateway.toolTurns > 0 && lastRole(recorded.body) === "user") {
      gateway.toolTurns -= 1;
      const call = nativeHttpToolCall(
        `call_revert_${String(self.requests.length)}`,
        gateway.call.name,
        gateway.call.arguments,
      );
      streamedTurn(response, { tool_calls: [call] }, "tool_calls");
      return;
    }
    streamedTurn(response, { content: "Fixture turn completed." }, "stop");
  });
  return Object.assign(stub, {
    hold: false,
    holdAfterTool: false,
    failAfterTool: false,
    toolTurns: 0,
    call: { name: "read", arguments: {} },
  });
}

async function startFacade(): Promise<Stub> {
  return await startStub((_self, _recorded, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"effect":"allow"}');
  });
}

function hermeticGitEnvironment(home: string, git: string): Record<string, string> {
  return {
    HOME: home,
    PATH: dirname(git),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

/** A committed repository: the project identity the runtime derives its snapshots from. */
function createFixture(): Fixture {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "keiko-native-revert-"));
  try {
    const root = realpathSync(temporaryRoot);
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, FIXTURE_FILE), ORIGINAL_CONTENT);
    const git = resolveDarwinGitExecutable();
    const env = hermeticGitEnvironment(state, git.path);
    const identity = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];
    for (const args of [
      ["init", "-q", workspace],
      ["-C", workspace, ...identity, "add", "-A"],
      ["-C", workspace, ...identity, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"],
    ]) {
      if (spawnSync(git.path, args, { env }).status !== 0) {
        throw new Error("fixture-git-failed");
      }
    }
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

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
}

function launch(
  fixture: Fixture,
  binary: string,
  runtimeRoot: string,
  stubs: { readonly gateway: Stub; readonly facade: Stub },
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
  const configRoot = join(fixture.state, "config", "opencode");
  for (const path of [
    join(configRoot, "plugins"),
    join(fixture.state, "home"),
    join(fixture.state, "state"),
    join(fixture.state, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(configRoot, "opencode.json"), profile.config, { mode: 0o600 });
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native")))
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
  const git = resolveDarwinGitExecutable();
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
    runId: "run-native-revert",
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
        KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(stubs.facade.port)}/native-policy`,
        KEIKO_TOOL_FACADE_CAPABILITY: FACADE_CAPABILITY,
        KEIKO_CODING_RUN_ID: "run-native-revert",
        KEIKO_CODING_MODE: "governed-assist",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

interface Service {
  readonly client: OpenCodeV2HttpClient;
  /** A raw call for the shapes the client deliberately does not expose. */
  raw(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown>;
}

function serviceAt(endpoint: string, password: string): Service {
  const authorization = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
  return {
    client: createOpenCodeV2HttpClient({ endpoint, password }),
    raw: async (method, path, body): Promise<unknown> => {
      const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`fixture-request-failed:${String(response.status)}`);
      return response.status === 204 ? undefined : ((await response.json()) as unknown);
    },
  };
}

interface Run {
  readonly fixture: Fixture;
  readonly gateway: GatewayStub;
  readonly service: Service;
  readonly sessionId: string;
}

async function withRun(body: (run: Run) => Promise<void>): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const binary = BINARY;
  const resourceRoot = RESOURCE_ROOT;
  const fixture = createFixture();
  try {
    const gateway = await startGateway();
    await withNativeHttpStub(gateway, async (): Promise<void> => {
      const facade = await startFacade();
      await withNativeHttpStub(facade, async (): Promise<void> => {
        const launched = launch(fixture, realpathSync(binary), realpathSync(resourceRoot), {
          gateway,
          facade,
        });
        await withNativeChild(launched.child, async (): Promise<void> => {
          const service = serviceAt(await childEndpoint(launched.child), launched.password);
          expect((await service.client.info()).version).toBe(OPENCODE_PINNED_VERSION);
          const session = await service.client.createSession(fixture.workspace);
          if (typeof session.id !== "string") throw new Error("fixture-session-invalid");
          await body({ fixture, gateway, service, sessionId: session.id });
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

function workspaceFile(run: Run, name = FIXTURE_FILE): string {
  return readFileSync(join(run.fixture.workspace, name), "utf8");
}

async function sessionIsIdle(run: Run): Promise<boolean> {
  return !Object.hasOwn(await run.service.client.active(), run.sessionId);
}

/** One scripted tool call, then the model's closing answer; resolves once the session is idle. */
async function scriptedTurn(run: Run, call: ScriptedCall, prompt: string): Promise<void> {
  const before = run.gateway.requests.length;
  run.gateway.call = call;
  run.gateway.toolTurns = 1;
  await run.service.client.prompt(run.sessionId, prompt);
  await expect
    .poll(() => run.gateway.requests.length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before + 2);
  await expect.poll(() => sessionIsIdle(run), { timeout: 30_000 }).toBe(true);
}

function editCall(oldString: string, newString: string): ScriptedCall {
  return { name: "edit", arguments: { path: FIXTURE_FILE, oldString, newString } };
}

async function userMessageIds(run: Run): Promise<readonly string[]> {
  const messages = await run.service.client.messages(run.sessionId);
  return messages.flatMap((message) =>
    message.type === "user" && typeof message.id === "string" ? [message.id] : [],
  );
}

/** Keiko's revert port over the real service, with an interrupt that settles like `abortTask`. */
function keikoRevertPort(run: Run): {
  readonly port: ReturnType<typeof createOpenCodeRevertRunPort>;
  readonly state: OpenCodeRevertRun;
  readonly aborts: number[];
} {
  const state: OpenCodeRevertRun = {
    runId: "run-native-revert",
    workspaceRoot: run.fixture.workspace,
    sessionId: run.sessionId,
    client: run.service.client,
  };
  const aborts: number[] = [];
  const port = createOpenCodeRevertRunPort({
    readyRun: () => state,
    abortTask: async (): Promise<boolean> => {
      aborts.push(aborts.length);
      await run.service.client.interrupt(run.sessionId);
      await expect.poll(() => sessionIsIdle(run), { timeout: 15_000 }).toBe(true);
      return true;
    },
    activityLog: undefined,
  });
  return { port, state, aborts };
}

/** A turn that settles, followed by the image the composition records as it settles. */
async function settledTurn(
  run: Run,
  state: OpenCodeRevertRun,
  call: ScriptedCall,
  prompt: string,
): Promise<void> {
  await scriptedTurn(run, call, prompt);
  recordOpenCodeTurnImage(state, undefined);
  await state.turnImage;
}

/**
 * What the composition records when the runtime reports a native edit call completed: the call's
 * admitted target, fingerprinted as the edit left it.
 */
async function agentWrote(state: OpenCodeRevertRun, file = FIXTURE_FILE): Promise<void> {
  const key = openCodeNativeCallKey("msg_native_edit", `call_${file}`);
  noteOpenCodeEditTargets(state, key, [file]);
  recordOpenCodeEditSettled(state, key, undefined);
  await state.agentImages?.work;
}

async function sessionRevert(run: Run): Promise<unknown> {
  const sessions = await run.service.client.sessions();
  return sessions.find((session) => session.id === run.sessionId)?.revert;
}

describe("pinned native OpenCode undo semantics", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "serves exactly the admitted protocol surface, including the revert, diff and command operations",
    async () => {
      await withRun(async (run) => {
        const { digest, projection } = projectOpenCodeV2ProtocolSurface(
          await run.service.client.document(),
        );
        expect(digest).toBe(OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256);
        const paths = Object.keys((projection as { readonly paths: object }).paths);
        expect(paths).toEqual(
          expect.arrayContaining([
            "/api/session/{sessionID}/diff",
            "/api/session/{sessionID}/revert",
            "/api/session/{sessionID}/revert/stage",
            "/api/session/{sessionID}/revert/commit",
            "/api/command",
            "/api/session/{sessionID}/command",
          ]),
        );
      });
    },
    120_000,
  );

  // #3901: the verification evidence weighs a shell step's writes through the step's own snapshot.
  it.skipIf(skip)(
    "names a shell step's written files on that step's snapshot, with the step's tool call",
    async () => {
      await withRun(async (run) => {
        await scriptedTurn(
          run,
          {
            name: "shell",
            arguments: {
              command: `echo shelled >> ${FIXTURE_FILE} && mkdir -p gen && echo x > gen/new.txt`,
              description: "Write two files",
            },
          },
          "Write the files.",
        );
        const raw = (await run.service.raw("GET", `/api/session/${run.sessionId}/message`)) as {
          readonly data: readonly Readonly<Record<string, unknown>>[];
        };
        const changes = openCodeV2StepChanges(raw.data);
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ truncated: false });
        expect([...(changes[0]?.files ?? [])].sort()).toEqual(["gen/new.txt", FIXTURE_FILE]);
        expect(changes[0]?.callIds).toHaveLength(1);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "reports the file a turn changed through the diff endpoint, without the client keeping the patch",
    async () => {
      await withRun(async (run) => {
        expect(await run.service.client.sessionDiff(run.sessionId)).toEqual([]);
        await scriptedTurn(run, editCall("original", "edited"), "Edit the notes file.");
        const raw = (await run.service.raw("GET", `/api/session/${run.sessionId}/diff`)) as {
          readonly data: readonly Record<string, unknown>[];
        };
        expect(raw.data).toHaveLength(1);
        expect(raw.data[0]).toMatchObject({
          file: FIXTURE_FILE,
          status: "modified",
          additions: 1,
          deletions: 1,
        });
        expect(typeof raw.data[0]?.patch).toBe("string");
        const projected = await run.service.client.sessionDiff(run.sessionId);
        expect(projected).toEqual([
          { file: FIXTURE_FILE, status: "modified", additions: 1, deletions: 1 },
        ]);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "stage then commit restores the original content and removes the rewound messages",
    async () => {
      await withRun(async (run) => {
        await scriptedTurn(run, editCall("original", "edited"), "Edit the notes file.");
        expect(workspaceFile(run)).toBe("revert fixture edited\n");
        const [boundary] = await userMessageIds(run);
        const staged = await run.service.client.stageRevert(run.sessionId, boundary ?? "");
        expect(staged.messageId).toBe(boundary);
        expect(staged.files).toEqual([
          { file: FIXTURE_FILE, status: "modified", additions: 1, deletions: 1 },
        ]);
        // Staged: the files are back, the history is intact and the session names the revert.
        expect(workspaceFile(run)).toBe(ORIGINAL_CONTENT);
        expect(await run.service.client.messages(run.sessionId)).not.toEqual([]);
        expect(await sessionRevert(run)).toMatchObject({ messageID: boundary });
        await run.service.client.commitRevert(run.sessionId);
        expect(workspaceFile(run)).toBe(ORIGINAL_CONTENT);
        expect(await sessionRevert(run)).toBeUndefined();
        // Final: the messages from the boundary on are gone (the reason Keiko never commits).
        expect(await run.service.client.messages(run.sessionId)).toEqual([]);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "stage then clear brings the turn's change back and leaves the history untouched",
    async () => {
      await withRun(async (run) => {
        await scriptedTurn(run, editCall("original", "edited"), "Edit the notes file.");
        const before = (await run.service.client.messages(run.sessionId)).length;
        const [boundary] = await userMessageIds(run);
        await run.service.client.stageRevert(run.sessionId, boundary ?? "");
        expect(workspaceFile(run)).toBe(ORIGINAL_CONTENT);
        await run.service.client.clearRevert(run.sessionId);
        expect(workspaceFile(run)).toBe("revert fixture edited\n");
        expect(await sessionRevert(run)).toBeUndefined();
        // Append-only: clearing adds a marker and removes nothing.
        expect((await run.service.client.messages(run.sessionId)).length).toBeGreaterThanOrEqual(
          before,
        );
        // Neither call needs a staged revert: both are no-ops without one.
        await run.service.client.clearRevert(run.sessionId);
        await run.service.client.commitRevert(run.sessionId);
        expect(workspaceFile(run)).toBe("revert fixture edited\n");
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "refuses to stage while the session is busy and rewrites history when a prompt follows a staged revert",
    async () => {
      await withRun(async (run) => {
        await scriptedTurn(run, editCall("original", "edited"), "Edit the notes file.");
        const [boundary] = await userMessageIds(run);
        run.gateway.hold = true;
        await run.service.client.prompt(run.sessionId, "A turn that stays busy.");
        await expect.poll(() => sessionIsIdle(run), { timeout: 15_000 }).toBe(false);
        await expect(run.service.client.stageRevert(run.sessionId, boundary ?? "")).rejects.toThrow(
          "opencode-v2-response-invalid",
        );
        await run.service.client.interrupt(run.sessionId);
        await expect.poll(() => sessionIsIdle(run), { timeout: 15_000 }).toBe(true);
        run.gateway.hold = false;
        await run.service.client.stageRevert(run.sessionId, boundary ?? "");
        const beforePrompt = await userMessageIds(run);
        await scriptedTurn(run, editCall("original", "second"), "Edit it once more.");
        // The next prompt finalized the staged revert: the rewound turn's messages are gone.
        const afterPrompt = await userMessageIds(run);
        expect(beforePrompt.length).toBeGreaterThan(afterPrompt.length);
        expect(afterPrompt).not.toContain(boundary);
        expect(await sessionRevert(run)).toBeUndefined();
      });
    },
    180_000,
  );

  // r4368344091: Keiko's automatic verification continuation runs as a native turn of its own after
  // the human's edit turn and changes nothing, so the producer's newest-turn diff is empty. The undo
  // must still reach the human's edit: the continuation is marked as continuing that request.
  it.skipIf(skip)(
    "Keiko undoes and restores the human's edit across its own verification continuation",
    async () => {
      await withRun(async (run) => {
        const { port, state } = keikoRevertPort(run);
        await settledTurn(run, state, editCall("original", "human"), "Edit the notes file.");
        await agentWrote(state);
        const before = run.gateway.requests.length;
        run.gateway.call = { name: "read", arguments: { path: FIXTURE_FILE } };
        run.gateway.toolTurns = 1;
        await run.service.client.prompt(run.sessionId, "Verify.", undefined, undefined, {
          origin: "verification-continuation",
        });
        await expect
          .poll(() => run.gateway.requests.length, { timeout: 60_000 })
          .toBeGreaterThanOrEqual(before + 2);
        await expect.poll(() => sessionIsIdle(run), { timeout: 30_000 }).toBe(true);
        recordOpenCodeTurnImage(state, undefined);
        await state.turnImage;
        // The producer's own newest turn is the continuation, which changed nothing.
        expect(await run.service.client.sessionDiff(run.sessionId)).toEqual([]);
        const [human, continuation] = await userMessageIds(run);
        expect(continuation).toBeDefined();
        expect(await port.revertState("run")).toEqual({
          staged: false,
          fileCount: 1,
          additions: 1,
          deletions: 1,
        });
        expect(await port.revertTurn("run", "undo")).toMatchObject({ ok: true, fileCount: 1 });
        expect(workspaceFile(run)).toBe(ORIGINAL_CONTENT);
        expect(await sessionRevert(run)).toMatchObject({ messageID: human });
        expect(await port.revertTurn("run", "restore")).toMatchObject({ ok: true, fileCount: 1 });
        expect(workspaceFile(run)).toBe("revert fixture human\n");
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "Keiko undoes only the newest turn and restores it, counting files without reading content",
    async () => {
      await withRun(async (run) => {
        const { port, state, aborts } = keikoRevertPort(run);
        await settledTurn(run, state, editCall("original", "first"), "First edit.");
        await settledTurn(run, state, editCall("first", "second"), "Second edit.");
        expect(await port.revertState("run")).toEqual({
          staged: false,
          fileCount: 1,
          additions: 1,
          deletions: 1,
        });
        expect(await port.revertTurn("run", "undo")).toEqual({
          ok: true,
          fileCount: 1,
          additions: 1,
          deletions: 1,
        });
        // Only the newest turn: the first turn's edit stays.
        expect(workspaceFile(run)).toBe("revert fixture first\n");
        expect(state.revert).toBeDefined();
        expect(aborts).toEqual([]);
        expect(await port.revertState("run")).toMatchObject({ staged: true, fileCount: 1 });
        expect(await port.revertTurn("run", "undo")).toEqual({
          ok: false,
          reason: "already-staged",
        });
        expect(await port.revertTurn("run", "restore")).toMatchObject({ ok: true, fileCount: 1 });
        expect(workspaceFile(run)).toBe("revert fixture second\n");
        expect(state.revert).toBeUndefined();
        expect(await port.revertTurn("run", "restore")).toEqual({
          ok: false,
          reason: "nothing-staged",
        });
      });
    },
    180_000,
  );

  // #3904 AC3 (owner decision 2026-10-24): after the run settled, its runtime is held for the
  // post-completion undo window. The human undoes and restores the settled turn through Keiko's port,
  // and an undo left staged is committed when the window closes, so the session that is retained
  // matches the workspace and passes the retention audit.
  it.skipIf(skip)(
    "commits an undo left staged when the undo window closes, and the session then passes the retention audit",
    async () => {
      await withRun(async (run) => {
        const { port, state } = keikoRevertPort(run);
        await settledTurn(run, state, editCall("original", "first"), "First edit.");
        await settledTurn(run, state, editCall("first", "second"), "Second edit.");

        // The window: undo, restore and undo again, all against the settled turn.
        expect(await port.revertTurn("run", "undo")).toMatchObject({ ok: true, fileCount: 1 });
        expect(workspaceFile(run)).toBe("revert fixture first\n");
        expect(await port.revertTurn("run", "restore")).toMatchObject({ ok: true, fileCount: 1 });
        expect(workspaceFile(run)).toBe("revert fixture second\n");
        expect(await port.revertTurn("run", "undo")).toMatchObject({ ok: true, fileCount: 1 });

        // The window closes with the undo staged: the runtime makes it final.
        await expect(port.commitStagedRevert("run")).resolves.toBe("committed");
        expect(state.revert).toBeUndefined();
        expect(await sessionRevert(run)).toBeUndefined();
        expect(workspaceFile(run)).toBe("revert fixture first\n");
        // Only the undone turn's messages are gone; the first turn stays in the session.
        expect(await userMessageIds(run)).toHaveLength(1);
        await expect(port.commitStagedRevert("run")).resolves.toBe("none");

        // The database the run would retain passes the audit a retained entry must pass.
        const copy = join(run.fixture.root, "window-closed.db");
        const live = new DatabaseSync(join(run.fixture.state, "state", "opencode.db"), {
          readOnly: true,
        });
        live.prepare("VACUUM INTO ?").run(copy);
        live.close();
        expect(
          auditDatabase(copy, {
            sessionId: run.sessionId,
            directory: run.fixture.workspace,
            version: OPENCODE_PINNED_VERSION,
          }),
        ).toMatchObject({ ok: true });
      });
    },
    240_000,
  );

  it.skipIf(skip)(
    "Keiko stops a turn in flight before it undoes the turn's edit",
    async () => {
      await withRun(async (run) => {
        const { port, state, aborts } = keikoRevertPort(run);
        run.gateway.holdAfterTool = true;
        run.gateway.call = editCall("original", "edited");
        run.gateway.toolTurns = 1;
        await run.service.client.prompt(run.sessionId, "Edit the notes file.");
        await expect
          .poll(() => workspaceFile(run), { timeout: 30_000 })
          .toBe("revert fixture edited\n");
        await agentWrote(state);
        expect(await sessionIsIdle(run)).toBe(false);
        expect(await port.revertTurn("run", "undo")).toMatchObject({ ok: true, fileCount: 1 });
        expect(aborts).toHaveLength(1);
        expect(workspaceFile(run)).toBe(ORIGINAL_CONTENT);
        expect(await sessionIsIdle(run)).toBe(true);
        expect(await port.revertTurn("run", "restore")).toMatchObject({ ok: true, fileCount: 1 });
        expect(workspaceFile(run)).toBe("revert fixture edited\n");
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "Keiko never overwrites a human edit made while the turn waits for its next model reply",
    async () => {
      await withRun(async (run) => {
        const { port, state, aborts } = keikoRevertPort(run);
        run.gateway.holdAfterTool = true;
        run.gateway.call = editCall("original", "edited");
        run.gateway.toolTurns = 1;
        await run.service.client.prompt(run.sessionId, "Edit the notes file.");
        await expect
          .poll(() => workspaceFile(run), { timeout: 30_000 })
          .toBe("revert fixture edited\n");
        await agentWrote(state);
        // The model's final reply is held; meanwhile a human changes the file the turn edited.
        writeFileSync(join(run.fixture.workspace, FIXTURE_FILE), "a human edit while it runs\n");
        expect(await port.revertTurn("run", "undo")).toEqual({
          ok: false,
          reason: "workspace-changed",
        });
        expect(workspaceFile(run)).toBe("a human edit while it runs\n");
        expect(aborts).toEqual([]);
        expect(await sessionIsIdle(run)).toBe(false);
        expect(state.revert).toBeUndefined();
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "Keiko refuses to restore over a human edit that the runtime itself would overwrite",
    async () => {
      await withRun(async (run) => {
        const { port, state } = keikoRevertPort(run);
        await settledTurn(run, state, editCall("original", "edited"), "Edit the notes file.");
        expect(await port.revertTurn("run", "undo")).toMatchObject({ ok: true });
        writeFileSync(join(run.fixture.workspace, FIXTURE_FILE), "human edit after the undo\n");
        expect(await port.revertTurn("run", "restore")).toEqual({
          ok: false,
          reason: "workspace-changed",
        });
        expect(workspaceFile(run)).toBe("human edit after the undo\n");
        expect(state.revert).toBeDefined();
        // The producer alone would have overwritten it: the guard is Keiko's, not the runtime's.
        await run.service.client.clearRevert(run.sessionId);
        expect(workspaceFile(run)).toBe("revert fixture edited\n");
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "Keiko refuses to restore over same-size human bytes that put the old modification time back",
    async () => {
      await withRun(async (run) => {
        const { port, state } = keikoRevertPort(run);
        const target = join(run.fixture.workspace, FIXTURE_FILE);
        const reference = join(dirname(run.fixture.workspace), "mtime-reference");
        await settledTurn(run, state, editCall("original", "edited"), "Edit the notes file.");
        expect(await port.revertTurn("run", "undo")).toMatchObject({ ok: true });
        expect(workspaceFile(run)).toBe(ORIGINAL_CONTENT);
        // `cp -p` and `touch -r` carry the timestamp to the nanosecond, which Node's utimes cannot.
        expect(spawnSync("cp", ["-p", target, reference]).status).toBe(0);
        const before = statSync(target, { bigint: true });
        const human = "revert fixture HUMAN!!!\n";
        expect(BigInt(Buffer.byteLength(human))).toBe(before.size);
        writeFileSync(target, human);
        expect(spawnSync("touch", ["-r", reference, target]).status).toBe(0);
        const after = statSync(target, { bigint: true });
        expect([after.size, after.mtimeNs]).toEqual([before.size, before.mtimeNs]);
        expect(await port.revertTurn("run", "restore")).toEqual({
          ok: false,
          reason: "workspace-changed",
        });
        expect(workspaceFile(run)).toBe(human);
        expect(state.revert).toBeDefined();
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "Keiko refuses to undo a settled turn over a human edit made after it, and undoes it untouched",
    async () => {
      await withRun(async (run) => {
        const { port, state } = keikoRevertPort(run);
        const target = join(run.fixture.workspace, FIXTURE_FILE);
        await settledTurn(run, state, editCall("original", "edited"), "Edit the notes file.");
        writeFileSync(target, "human edit after the turn\n");
        expect(await port.revertTurn("run", "undo")).toEqual({
          ok: false,
          reason: "workspace-changed",
        });
        expect(workspaceFile(run)).toBe("human edit after the turn\n");
        expect(state.revert).toBeUndefined();
        // Healthy control: once the file is as the turn left it, undo and restore both apply.
        writeFileSync(target, "revert fixture edited\n");
        expect(await port.revertTurn("run", "undo")).toMatchObject({ ok: true, fileCount: 1 });
        expect(workspaceFile(run)).toBe(ORIGINAL_CONTENT);
        expect(await port.revertTurn("run", "restore")).toMatchObject({ ok: true, fileCount: 1 });
        expect(workspaceFile(run)).toBe("revert fixture edited\n");
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "a failed model continuation retains usable native undo",
    async () => {
      await withRun(async (run) => {
        const { port, state } = keikoRevertPort(run);
        run.gateway.failAfterTool = true;
        run.gateway.call = editCall("original", "edited");
        run.gateway.toolTurns = 1;
        await run.service.client.prompt(run.sessionId, "Edit the notes file.");
        await expect
          .poll(() => workspaceFile(run), { timeout: 30_000 })
          .toBe("revert fixture edited\n");
        await agentWrote(state);
        await expect.poll(() => sessionIsIdle(run), { timeout: 30_000 }).toBe(true);
        const messages = await run.service.client.messages(run.sessionId);
        expect(
          messages.some((m) => m.type === "assistant" && "error" in m && m.error !== undefined),
        ).toBe(true);
        recordOpenCodeTurnImage(state, undefined);
        await state.turnImage;
        expect(await port.revertTurn("run", "undo")).toMatchObject({ ok: true, fileCount: 1 });
        expect(workspaceFile(run)).toBe(ORIGINAL_CONTENT);
        expect(await port.revertTurn("run", "restore")).toMatchObject({ ok: true, fileCount: 1 });
        expect(workspaceFile(run)).toBe("revert fixture edited\n");
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "Keiko reports nothing to undo for a turn that changed no file, without stopping it",
    async () => {
      await withRun(async (run) => {
        const { port, aborts } = keikoRevertPort(run);
        run.gateway.hold = true;
        await run.service.client.prompt(run.sessionId, "A turn that only thinks.");
        await expect.poll(() => sessionIsIdle(run), { timeout: 15_000 }).toBe(false);
        expect(await port.revertTurn("run", "undo")).toEqual({
          ok: false,
          reason: "nothing-to-undo",
        });
        expect(aborts).toEqual([]);
        expect(await sessionIsIdle(run)).toBe(false);
      });
    },
    120_000,
  );
});
