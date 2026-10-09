import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import { buildOpenCodeLaunchProfile } from "./opencodeLaunchProfile.js";
import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
} from "./opencodeV2HttpClient.js";
import { readBoundedBody } from "./opencodeRuntimeComposition.js";

const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const PINNED_ARM64_SHA256 = "f2dfe9ad5851219a6bd97b2e3cd2081c0964b5f120530f578d3da3aefc5ccc5a";
const CONTAINED_SENTINEL = "native-contained-read-fixture";
const EXTERNAL_SENTINEL = "native-external-read-must-remain-denied";

interface ProviderFacts {
  calls: number;
  nativeReadAdvertised: boolean;
  containedReadObserved: boolean;
  escapedContentObserved: boolean;
  rejectedReadObserved: boolean;
}

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
}

function filesystemFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-filesystem-")));
  const workspace = join(root, "workspace");
  const state = join(workspace, ".keiko", "native-run");
  mkdirSync(join(workspace, "nested", "deep"), { recursive: true });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, "nested", "deep", "component.tsx"), CONTAINED_SENTINEL);
  writeFileSync(join(root, "outside.tsx"), EXTERNAL_SENTINEL);
  symlinkSync(join(root, "outside.tsx"), join(workspace, "escape.tsx"));
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

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function observeProviderRequest(body: unknown, facts: ProviderFacts): void {
  const request = object(body);
  const tools = Array.isArray(request?.tools) ? request.tools : [];
  facts.nativeReadAdvertised ||= tools.some(
    (tool: unknown) => object(object(tool)?.function)?.name === "read",
  );
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const results = messages.filter((message: unknown) => object(message)?.role === "tool");
  const content = JSON.stringify(results);
  facts.containedReadObserved ||= content.includes(CONTAINED_SENTINEL);
  facts.escapedContentObserved ||= content.includes(EXTERNAL_SENTINEL);
  facts.rejectedReadObserved ||= results.some((message: unknown) => {
    const result = object(message);
    return (
      result?.tool_call_id === "call_native_read_2" &&
      JSON.stringify(result.content).includes("Unable to read escape.tsx")
    );
  });
}

function respondProvider(response: ServerResponse, call: number): void {
  const delta =
    call <= 2
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call_native_read_${String(call)}`,
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({
                  path: call === 1 ? "nested/deep/component.tsx" : "escape.tsx",
                  offset: 1,
                  limit: 20,
                }),
              },
            },
          ],
        }
      : { content: "Read-only fixture completed." };
  const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    frame({
      id: "native-filesystem",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: null }],
    }),
  );
  response.end(
    frame({
      id: "native-filesystem",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: call <= 2 ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }) + "data: [DONE]\n\n",
  );
}

async function handleProvider(
  request: IncomingMessage,
  response: ServerResponse,
  facts: ProviderFacts,
): Promise<void> {
  const body: unknown = JSON.parse(
    (await readBoundedBody(request, new AbortController().signal)).toString("utf8"),
  );
  observeProviderRequest(body, facts);
  facts.calls += 1;
  respondProvider(response, facts.calls);
}

async function startProvider(
  facts: ProviderFacts,
): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer((request, response) => {
    void handleProvider(request, response, facts).catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture-listener-invalid");
  return { server, port: address.port };
}

function launchFixture(
  fixture: Fixture,
  binary: string,
  runtimeRoot: string,
  port: number,
): {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
} {
  const profile = buildOpenCodeLaunchProfile({
    executable: binary,
    stateRoot: fixture.state,
    contextGeometry: {
      contextWindowTokens: 32_768,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_096,
    },
  });
  if (!profile.ok) throw new Error("fixture-profile-invalid");
  const configRoot = join(fixture.state, "config", "opencode");
  for (const path of [
    configRoot,
    join(fixture.state, "home"),
    join(fixture.state, "state"),
    join(fixture.state, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  // Fixture-only permission: exercise the original pinned native Read executor. Production rules
  // remain unchanged until canonical sensitive/private-state access enforcement is implemented.
  writeFileSync(
    join(configRoot, "opencode.json"),
    JSON.stringify({
      ...profile.configValue,
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ],
    }),
    { mode: 0o600 },
  );
  const git = resolveDarwinGitExecutable();
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl: `http://127.0.0.1:${String(port)}/v1`,
    runId: "run-native-filesystem",
    treeBindingId: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    runtimeArtifactDigest: "c".repeat(64),
    modelProfileDigest: "d".repeat(64),
    filesystem: {
      workspaceRoot: fixture.workspace,
      workspaceAccess: "read-only",
      privateStateRoot: fixture.state,
      runtimeReadRoot: runtimeRoot,
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
        PATH: dirname(git.path),
        KEIKO_MODEL_GATEWAY_URL: `http://127.0.0.1:${String(port)}/v1`,
        KEIKO_MODEL_GATEWAY_CAPABILITY: "fixture-only",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

async function childEndpoint(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let diagnostic = "";
    const timeout = setTimeout(() => {
      reject(new Error("fixture-startup-timeout"));
    }, 15_000);
    const onData = (bytes: Buffer): void => {
      diagnostic += bytes.toString("utf8").slice(0, 4096 - diagnostic.length);
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
      const code =
        /\b(?:EACCES|EPERM|ENOENT|EINVAL|SyntaxError|ConfigInvalid|error)\b/u.exec(
          diagnostic,
        )?.[0] ?? "unknown";
      reject(new Error(`fixture-child-exited:${code}:bytes=${String(diagnostic.length)}`));
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

describe("pinned native OpenCode filesystem service foundation", () => {
  it.skipIf(BINARY === undefined && RESOURCE_ROOT === undefined)(
    "retains native handshake and Read while kernel containment refuses an external symlink",
    async () => {
      expect(process.platform).toBe("darwin");
      expect(process.arch).toBe("arm64");
      if (BINARY === undefined || RESOURCE_ROOT === undefined)
        throw new Error("fixture-binary-missing");
      expect(createHash("sha256").update(readFileSync(BINARY)).digest("hex")).toBe(
        PINNED_ARM64_SHA256,
      );
      const fixture = filesystemFixture();
      const facts: ProviderFacts = {
        calls: 0,
        nativeReadAdvertised: false,
        containedReadObserved: false,
        escapedContentObserved: false,
        rejectedReadObserved: false,
      };
      const provider = await startProvider(facts);
      const launched = launchFixture(
        fixture,
        realpathSync(BINARY),
        realpathSync(RESOURCE_ROOT),
        provider.port,
      );
      try {
        const client = createOpenCodeV2HttpClient({
          endpoint: await childEndpoint(launched.child),
          password: launched.password,
        });
        expect((await client.info()).version).toBe("2.0.10");
        const session = await client.createSession(fixture.workspace);
        if (typeof session.id !== "string") throw new Error("fixture-session-invalid");
        await client.prompt(session.id, "Read the two fixture paths without modifying files.");
        await expect.poll(() => facts.calls, { timeout: 20_000 }).toBe(3);
        expect(facts).toEqual({
          calls: 3,
          nativeReadAdvertised: true,
          containedReadObserved: true,
          escapedContentObserved: false,
          rejectedReadObserved: true,
        });
        expect(
          readFileSync(join(fixture.workspace, "nested", "deep", "component.tsx"), "utf8"),
        ).toBe(CONTAINED_SENTINEL);
      } finally {
        await stopChild(launched.child);
        provider.server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          provider.server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          }),
        );
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
