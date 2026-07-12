import { createHash } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import type {
  GatewayConfig,
  GatewayRequest,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";

import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import { buildRedactor, type UiHandlerDeps } from "../deps.js";
import {
  createOpenCodeGatewayReadinessRegistry,
  handleCodingSidecarGatewayChatCompletions,
} from "../coding-sidecar-gateway.js";
import { STREAMING, type RouteContext, type RouteResult } from "../routes.js";
import { createRunRegistry } from "../runs.js";
import { createInMemoryUiStore } from "../store/index.js";
import { createCodingToolFacade } from "./codingToolFacade.js";
import type { CodingToolFacade } from "./codingToolFacadePorts.js";
import type { CodingToolResult } from "./codingToolIpc.js";
import { createOpenCodeRuntimeComposition } from "./opencodeRuntimeComposition.js";
import { hasExactOpenCodeVisibleToolContract } from "./opencodeToolSchemas.js";
import {
  createRuntimeProcessSupervisor,
  type RuntimeProcessBackend,
  type RuntimeQualificationIdentity,
  type RuntimeProcessTree,
  type RuntimeSupervisorLaunchRequest,
  type RuntimeTreeSignal,
} from "./runtimeProcessSupervisor.js";

const FUNCTIONAL_BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const FUNCTIONAL_RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const FUNCTIONAL_ENABLED =
  FUNCTIONAL_BINARY !== undefined || FUNCTIONAL_RESOURCE_ROOT !== undefined;
const TEST_TIMEOUT_MS = 60_000;
const RUN_ID = "run-2254";
const TREE_BINDING_ID = "f".repeat(64);
const MODEL_CAPABILITY = "m".repeat(43);
const TOOL_CAPABILITY = "t".repeat(43);
const PROTOCOL_SCHEMA_SHA256 = "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de";
const PROTOCOL_HANDSHAKE_DIGEST =
  "e1db492f2ac661f2b44da6ef3d7e58ed34856621a2c58de4610640e1291266f6";
const PROTOCOL_HANDSHAKE_ALGORITHM = "keiko-opencode-protocol-surface-v1" as const;
// Structural sentinel required only by the manager's test seam; it is not a native release receipt.
const FUNCTIONAL_TEST_QUALIFICATION_RECEIPT = `sha256:${"0".repeat(64)}`;

interface GatewayHarness {
  readonly endpoint: string;
  readonly readiness: ReturnType<typeof createOpenCodeGatewayReadinessRegistry>;
  readonly requests: GatewayRequest[];
  readonly calls: () => number;
  readonly responses: () => readonly string[];
  readonly summaries: () => readonly string[];
  readonly terminalFrames: () => readonly string[];
  readonly responseFinishes: () => number;
  readonly responseCloses: () => number;
  close(): Promise<void>;
}

type GatewayResponseScript = (
  request: GatewayRequest,
  callIndex: number,
) => Promise<NormalizedResponse>;

interface ProductiveResponseControl {
  readonly script: GatewayResponseScript;
  readonly held: () => boolean;
  release(): void;
}

interface TestQuestionRunPort {
  readonly listQuestions: (runId: string) => Promise<
    readonly {
      readonly id: string;
      readonly questions: readonly {
        readonly question: string;
        readonly header: string;
        readonly options: readonly { readonly label: string; readonly description: string }[];
      }[];
    }[]
  >;
  readonly answerQuestion: (
    runId: string,
    requestId: string,
    answers: readonly (readonly string[])[],
  ) => Promise<boolean>;
}

interface DirectTree extends RuntimeProcessTree {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly exits: Set<(code: number | null) => void>;
  exited: boolean;
  exitCode: number | null;
}

/**
 * Functional-only harness: directly owns one child for local protocol conformance. It is not a
 * native release, containment, or sandbox qualification backend.
 */
class DirectChildRuntimeBackend implements RuntimeProcessBackend {
  public readonly identity: RuntimeProcessBackend["identity"];
  private nextTreeId = 0;
  private lastEnv: Readonly<Record<string, string>> | undefined;
  private stderr = "";

  public constructor(qualification: RuntimeProcessBackend["identity"]) {
    this.identity = qualification;
  }

  public spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeProcessTree {
    this.lastEnv = { ...request.env };
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      request.executable,
      request.args,
      {
        cwd: request.cwd,
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"] as const,
      },
    );
    const tree: DirectTree = {
      treeId: `functional-opencode-${String(this.nextTreeId++)}`,
      child,
      stdout: child.stdout,
      stderr: child.stderr,
      exits: new Set(),
      exited: false,
      exitCode: null,
      onTreeExit(callback): void {
        if (tree.exited) callback(tree.exitCode);
        else tree.exits.add(callback);
      },
    };
    const settle = (code: number | null): void => {
      if (tree.exited) return;
      tree.exited = true;
      tree.exitCode = code;
      for (const callback of tree.exits) callback(code);
      tree.exits.clear();
    };
    child.once("exit", settle);
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (this.stderr.length >= 4096) return;
      this.stderr += String(chunk).slice(0, 4096 - this.stderr.length);
    });
    child.once("error", () => {
      settle(null);
    });
    return tree;
  }

  public signalTree(tree: RuntimeProcessTree, signal: RuntimeTreeSignal): void {
    const direct = directTree(tree);
    if (!direct.exited && !direct.child.kill(signal === "graceful" ? "SIGTERM" : "SIGKILL")) {
      throw new Error("functional-child-signal-failed");
    }
  }

  public async waitForCompleteTreeExit(
    tree: RuntimeProcessTree,
    timeoutMs: number,
  ): Promise<boolean> {
    const direct = directTree(tree);
    if (direct.exited) return true;
    return await new Promise<boolean>((resolveWait) => {
      const timeout = setTimeout(() => {
        direct.exits.delete(onExit);
        resolveWait(direct.exited);
      }, timeoutMs);
      timeout.unref();
      const onExit = (): void => {
        clearTimeout(timeout);
        resolveWait(true);
      };
      direct.exits.add(onExit);
    });
  }

  public reconcileTreeExit(tree: RuntimeProcessTree): Promise<boolean> {
    return Promise.resolve(directTree(tree).exited);
  }

  public launchEnvironment(): Readonly<Record<string, string>> | undefined {
    return this.lastEnv;
  }

  public redactedStderr(): string {
    return this.stderr.replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]");
  }
}

function directTree(tree: RuntimeProcessTree): DirectTree {
  return tree as DirectTree;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashPayload(root: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) hash.update(`${file}\0${sha256(join(root, file))}\0`);
  return hash.digest("hex");
}

function functionalPlatform(): {
  readonly target: UpdatePortableTarget;
  readonly qualification: RuntimeQualificationIdentity;
  readonly executableRelativePath: string;
} {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      target: "macos-arm64",
      qualification: {
        platform: "darwin",
        arch: "arm64",
        backend: "macos-app-sandbox",
        releaseReceipt: FUNCTIONAL_TEST_QUALIFICATION_RECEIPT,
      },
      executableRelativePath: "runtime/sidecars/opencode-compatible/bin/opencode",
    };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return {
      target: "macos-x64",
      qualification: {
        platform: "darwin",
        arch: "x64",
        backend: "macos-app-sandbox",
        releaseReceipt: FUNCTIONAL_TEST_QUALIFICATION_RECEIPT,
      },
      executableRelativePath: "runtime/sidecars/opencode-compatible/bin/opencode",
    };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return {
      target: "windows-x64",
      qualification: {
        platform: "win32",
        arch: "x64",
        backend: "windows-job-object",
        releaseReceipt: FUNCTIONAL_TEST_QUALIFICATION_RECEIPT,
      },
      executableRelativePath: "runtime/sidecars/opencode-compatible/opencode.exe",
    };
  }
  throw new Error("functional-opencode-platform-unsupported");
}

function requiredEnvironment(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0)
    throw new Error(`functional-opencode-env-missing:${name}`);
  return value;
}

function realPortableRuntime(testRoot: string): {
  readonly resourceRoot: string;
  readonly verification: PortableSidecarRuntimeVerification;
  readonly target: UpdatePortableTarget;
} {
  const stagedRoot = resolve(
    requiredEnvironment("KEIKO_OPENCODE_REAL_RESOURCE_ROOT", FUNCTIONAL_RESOURCE_ROOT),
  );
  const stagedExecutable = resolve(
    requiredEnvironment("KEIKO_OPENCODE_REAL_BINARY", FUNCTIONAL_BINARY),
  );
  const platform = functionalPlatform();
  const payloadRootPath = "payload";
  const executablePath = `${payloadRootPath}/bin/opencode`;
  const licenseEvidencePath = `${payloadRootPath}/evidence/LICENSE`;
  const sbomEvidencePath = `${payloadRootPath}/evidence/sbom.cdx.json`;
  const expectedExecutable = join(stagedRoot, executablePath);
  if (
    !isAbsolute(stagedRoot) ||
    !isAbsolute(stagedExecutable) ||
    stagedExecutable !== expectedExecutable
  ) {
    throw new Error("functional-opencode-binary-not-staged");
  }
  for (const path of [
    stagedExecutable,
    join(stagedRoot, licenseEvidencePath),
    join(stagedRoot, sbomEvidencePath),
  ]) {
    if (!existsSync(path) || !statSync(path).isFile())
      throw new Error("functional-opencode-staged-proof-missing");
  }
  const resourceRoot = join(testRoot, "portable-resource");
  for (const relativePath of [executablePath, licenseEvidencePath, sbomEvidencePath]) {
    const source = join(stagedRoot, relativePath);
    const destination = join(resourceRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    chmodSync(destination, statSync(source).mode & 0o777);
  }
  const executable = join(resourceRoot, executablePath);
  if (sha256(stagedExecutable) !== sha256(executable)) {
    throw new Error("functional-opencode-binary-copy-mismatch");
  }
  const payloadRoot = join(resourceRoot, payloadRootPath);
  const executableRelativeToPayload = relative(payloadRoot, executable).split("\\").join("/");
  const executableDigest = sha256(executable);
  const payloadSha256 = hashPayload(payloadRoot, [
    executableRelativeToPayload,
    "evidence/LICENSE",
    "evidence/sbom.cdx.json",
  ]);
  const verification: PortableSidecarRuntimeVerification = {
    payloadRootPath,
    executablePath,
    shippedExecutableSha256: executableDigest,
    executableTreeSha256: createHash("sha256")
      .update(`${executableRelativeToPayload}\0${executableDigest}\0`, "utf8")
      .digest("hex"),
    licenseEvidencePath,
    licenseEvidenceSha256: sha256(join(resourceRoot, licenseEvidencePath)),
    sbomEvidencePath,
    sbomEvidenceSha256: sha256(join(resourceRoot, sbomEvidencePath)),
    protocolSchemaRawSha256: PROTOCOL_SCHEMA_SHA256,
    protocolHandshakeDigest: PROTOCOL_HANDSHAKE_DIGEST,
    protocolHandshakeAlgorithm: PROTOCOL_HANDSHAKE_ALGORITHM,
    availability: {
      redistributionApproved: true,
      payloadPresent: true,
      archiveDigestVerified: true,
      executableTreeDigestVerified: true,
      runtimeVersionVerified: true,
      protocolSchemaVerified: true,
      signatureVerified: true,
      qualificationVerified: true,
    },
    summary: {
      name: "opencode-compatible",
      kind: "coding-runtime",
      upstreamName: "opencode",
      upstreamVersion: "1.17.17",
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      protocolVersion: "http-sse",
      platformTarget: platform.target,
      payloadSha256,
      payloadSha256Prefix: payloadSha256.slice(0, 12),
      sizeBytes: statSync(executable).size,
      status: "verified",
    },
  };
  return { resourceRoot, verification, target: platform.target };
}

function gatewayConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: "functional-coding-model",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "functional-provider-secret",
        apiKeyHeaderName: "api-key",
        endpointStyle: "azure-openai-deployment",
        apiVersion: "2024-06-01",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: "functional-coding-model",
        kind: "chat",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: true,
        costClass: "low",
        latencyClass: "standard",
        throughputHint: "functional",
        preferredUseCases: ["Coding"],
        knownLimitations: [],
      },
    ],
  };
}

function normalResponse(): NormalizedResponse {
  return {
    modelId: "functional-coding-model",
    content: "",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "functional-gateway-request",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      costClass: "low",
    },
  };
}

function toolResponse(
  id: string,
  name: "keiko_workspace_read" | "keiko_changeset_edit" | "question",
  args: Record<string, unknown>,
): NormalizedResponse {
  return {
    ...normalResponse(),
    finishReason: "tool_calls",
    toolCalls: [{ id, name, arguments: args }],
  };
}

function scriptedProductiveResponse(): ProductiveResponseControl {
  const changeset = {
    patch: "--- a/src/example.ts\n+++ b/src/example.ts\n@@\n-old\n+new\n",
    files: [{ file: "src/example.ts", expectedContentHash: "a".repeat(64) }],
  };
  let held = false;
  let releaseResponse: (() => void) | undefined;
  return {
    held: (): boolean => held,
    release: (): void => {
      releaseResponse?.();
      releaseResponse = undefined;
    },
    script: (_request, callIndex): Promise<NormalizedResponse> => {
      if (callIndex === 0)
        return Promise.resolve(
          toolResponse("call-read", "keiko_workspace_read", { relativePath: "src/example.ts" }),
        );
      if (callIndex === 1)
        return Promise.resolve(
          toolResponse("call-question", "question", {
            questions: [
              {
                question: "Approve the prepared bounded edit?",
                header: "Approval",
                options: [{ label: "Approve", description: "Continue safely" }],
              },
            ],
          }),
        );
      if (callIndex === 2)
        return Promise.resolve(toolResponse("call-edit", "keiko_changeset_edit", { changeset }));
      if (callIndex === 3) return Promise.resolve({ ...normalResponse(), content: "Completed." });
      return new Promise<NormalizedResponse>((resolve) => {
        held = true;
        releaseResponse = (): void => {
          resolve({ ...normalResponse(), content: "Cancelled turn settled." });
        };
      });
    },
  };
}

async function createGatewayHarness(
  script: GatewayResponseScript = (): Promise<NormalizedResponse> =>
    Promise.resolve(normalResponse()),
): Promise<GatewayHarness> {
  const readiness = createOpenCodeGatewayReadinessRegistry();
  const requests: GatewayRequest[] = [];
  let calls = 0;
  let providerCalls = 0;
  let responseFinishes = 0;
  let responseCloses = 0;
  const responses: string[] = [];
  const summaries: string[] = [];
  const terminalFrames: string[] = [];
  const config = gatewayConfig();
  const deps = {
    config,
    configPresent: true,
    evidenceStore: {
      put: (): string => "",
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
    env: {},
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    codingSidecarGatewayChatFactory:
      (): ((request: GatewayRequest) => Promise<NormalizedResponse>) =>
      (request): Promise<NormalizedResponse> => {
        requests.push(request);
        const callIndex = providerCalls;
        providerCalls += 1;
        return script(request, callIndex);
      },
    runtimeCapabilityAuthenticator: {
      authenticate: (capability: string, audience: "model-gateway" | "tool-facade"): unknown =>
        capability === MODEL_CAPABILITY && audience === "model-gateway"
          ? { ok: true, binding: { runId: RUN_ID } }
          : { ok: false },
    },
    openCodeGatewayReadinessRegistry: readiness,
    codingWorkbenchEvidenceStore: {
      put: (): string => "",
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
  } as unknown as UiHandlerDeps;
  const server = createServer((req, res) => {
    calls += 1;
    captureGatewayTerminalFrames(res, terminalFrames);
    res.once("finish", () => {
      responseFinishes += 1;
    });
    res.once("close", () => {
      responseCloses += 1;
    });
    captureGatewayRequestSummary(req, summaries);
    void serveGatewayRequest(req, res, deps, responses);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("functional-gateway-bind-failed");
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/api/coding-sidecar/gateway`,
    readiness,
    requests,
    calls: (): number => calls,
    responses: (): readonly string[] => responses,
    summaries: (): readonly string[] => summaries,
    terminalFrames: (): readonly string[] => terminalFrames,
    responseFinishes: (): number => responseFinishes,
    responseCloses: (): number => responseCloses,
    close: (): Promise<void> =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) resolveClose();
          else rejectClose(error);
        });
      }),
  };
}

async function serveGatewayRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  deps: UiHandlerDeps,
  responses: string[],
): Promise<void> {
  try {
    const result = await handleCodingSidecarGatewayChatCompletions(
      {
        req,
        res,
        params: {},
        url: new URL(req.url ?? "/", "http://127.0.0.1"),
      } satisfies RouteContext,
      deps,
    );
    if (result !== STREAMING) writeGatewayResult(res, result);
    responses.push(`${req.method ?? "?"} ${req.url ?? "?"} ${String(res.statusCode)}`);
  } catch {
    res.writeHead(500).end();
    responses.push(`${req.method ?? "?"} ${req.url ?? "?"} 500`);
  }
}

function writeGatewayResult(res: import("node:http").ServerResponse, result: RouteResult): void {
  res.writeHead(result.status, { "Content-Type": "application/json", ...result.headers });
  res.end(JSON.stringify(result.body));
}

function captureGatewayRequestSummary(
  req: import("node:http").IncomingMessage,
  summaries: string[],
): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    if (bytes >= 1_048_576) return;
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    chunks.push(value);
  });
  req.once("end", () => {
    const summary = gatewayRequestSummary(Buffer.concat(chunks));
    summaries.push(
      `authorization=${String(req.headers.authorization === `Bearer ${MODEL_CAPABILITY}`)}:${summary}`,
    );
  });
}

function captureGatewayTerminalFrames(
  res: import("node:http").ServerResponse,
  frames: string[],
): void {
  const write = res.write.bind(res);
  res.write = ((...args: Parameters<typeof res.write>): ReturnType<typeof res.write> => {
    captureGatewayTerminalFrame(args[0], frames);
    return write(...args);
  }) as typeof res.write;
}

function captureGatewayTerminalFrame(chunk: unknown, frames: string[]): void {
  const text = gatewayChunkText(chunk);
  if (text === undefined) return;
  for (const line of text.split("\n")) {
    const summary = gatewayTerminalFrameSummary(line);
    if (summary !== undefined) frames.push(summary);
  }
}

function gatewayChunkText(chunk: unknown): string | undefined {
  if (typeof chunk === "string") return chunk;
  return chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : undefined;
}

function gatewayTerminalFrameSummary(line: string): string | undefined {
  if (!line.startsWith("data: ") || line === "data: [DONE]") return undefined;
  try {
    const value: unknown = JSON.parse(line.slice("data: ".length));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (!("usage" in record)) return undefined;
    return `choices=${String(Array.isArray(record.choices))}:usage=${String(isRecord(record.usage))}`;
  } catch {
    return "invalid";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gatewayRequestSummary(body: Buffer): string {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "body=invalid";
    const record = value as Record<string, unknown>;
    const model = typeof record.model === "string" ? record.model : "missing";
    const tools = Array.isArray(record.tools)
      ? record.tools
          .map((item) => {
            const tool = item as { function?: { name?: unknown } };
            return typeof tool.function?.name === "string" ? tool.function.name : "invalid";
          })
          .join("|")
      : "missing";
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const roles = messages
      .map((message) => {
        const value = message as { role?: unknown };
        return typeof value.role === "string" ? value.role : "invalid";
      })
      .join("|");
    const titleGeneration = messages.some((message) => {
      const value = message as { content?: unknown };
      return (
        typeof value.content === "string" &&
        value.content.startsWith("Generate a title for this conversation:")
      );
    });
    const streamOptions = record.stream_options;
    const includeUsage = streamOptionsIncludeUsage(streamOptions);
    return `model=${model}:tools=${tools}:messages=${String(messages.length)}:roles=${roles}:title-generation=${String(titleGeneration)}:stream-options-include-usage=${String(includeUsage)}`;
  } catch {
    return "body=invalid";
  }
}

function streamOptionsIncludeUsage(value: unknown): boolean {
  return isRecord(value) && value.include_usage === true;
}

function functionalToolFacade(ledger: string[], statuses: string[]): CodingToolFacade {
  const facade = createCodingToolFacade({
    authority: {
      admit: (capability, request) =>
        capability === TOOL_CAPABILITY
          ? { ok: true as const, mutationGuard: { check: (): true => true } }
          : { ok: false as const, reason: `capability-denied:${request.action}` },
    },
    delegate: {
      execute: (request): Promise<unknown> => {
        ledger.push(request.action);
        return Promise.resolve(
          request.action === "read"
            ? { outcome: "completed", read: { text: "fixture", byteCount: 7 } }
            : { outcome: "completed" },
        );
      },
    },
  });
  return {
    execute: async (input): Promise<CodingToolResult> => {
      const result = await facade.execute(input);
      statuses.push(result.status);
      return result;
    },
  };
}

function statusCapturingFetch(statuses: string[]): typeof globalThis.fetch {
  return async (input, init): Promise<Response> => {
    const response = await globalThis.fetch(input, init);
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    if (url.pathname === "/session/status")
      statuses.push(await sessionStatusSummary(response.clone()));
    return response;
  };
}

async function sessionStatusSummary(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return "status=invalid";
    const states = Object.values(value as Record<string, unknown>)
      .map((entry) => {
        const record = entry as { type?: unknown };
        return typeof record.type === "string" ? record.type : "invalid";
      })
      .join("|");
    return `status=${states}`;
  } catch {
    return "status=invalid";
  }
}

/**
 * Failure-only, read-only DB diagnostic. SQL projects only lifecycle fields; it never reads or
 * reports prompt text, message content, tool arguments, paths, or identifiers.
 */
function runtimeDatabaseProjection(databasePath: string): string {
  if (!existsSync(databasePath)) return "database=missing";
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const messages = database
        .prepare(
          "SELECT json_extract(data, '$.role') AS role, json_extract(data, '$.finish') AS finish, json_extract(data, '$.error.name') AS error_name FROM message ORDER BY time_created",
        )
        .all() as readonly Record<string, unknown>[];
      const parts = database
        .prepare(
          "WITH message_ordinals AS (SELECT id, json_extract(data, '$.role') AS role, SUM(CASE WHEN json_extract(data, '$.role') = 'assistant' THEN 1 ELSE 0 END) OVER (ORDER BY time_created, id) AS assistant_ordinal FROM message) SELECT message_ordinals.assistant_ordinal AS assistant_ordinal, json_extract(part.data, '$.type') AS type, json_extract(part.data, '$.reason') AS reason, json_extract(part.data, '$.tool') AS tool, json_extract(part.data, '$.state.status') AS state_status, json_extract(part.data, '$.metadata.providerExecuted') AS provider_executed FROM part JOIN message_ordinals ON message_ordinals.id = part.message_id WHERE message_ordinals.role = 'assistant' ORDER BY part.time_created",
        )
        .all() as readonly Record<string, unknown>[];
      return `messages=${messages.map(runtimeDatabaseMessageSummary).join("|")}:parts=${parts.map(runtimeDatabasePartSummary).join("|")}`;
    } finally {
      database.close();
    }
  } catch {
    return "database=unavailable";
  }
}

function runtimeDatabaseMessageSummary(row: Readonly<Record<string, unknown>>): string {
  return `role=${runtimeDatabaseScalar(row.role)}:finish=${runtimeDatabaseScalar(row.finish)}:error=${runtimeDatabaseScalar(row.error_name)}`;
}

function runtimeDatabasePartSummary(row: Readonly<Record<string, unknown>>): string {
  return `assistant=${runtimeDatabaseScalar(row.assistant_ordinal)}:type=${runtimeDatabaseScalar(row.type)}:reason=${runtimeDatabaseScalar(row.reason)}:tool=${runtimeDatabaseScalar(row.tool)}:status=${runtimeDatabaseScalar(row.state_status)}:provider-executed=${runtimeDatabaseScalar(row.provider_executed)}`;
}

function runtimeDatabaseScalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "none";
}

async function waitForCondition(condition: () => boolean, signal: AbortSignal): Promise<boolean> {
  while (!signal.aborted) {
    if (condition()) return true;
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 25);
    });
  }
  return condition();
}

async function waitForQuestions(
  port: TestQuestionRunPort,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<TestQuestionRunPort["listQuestions"]>>> {
  while (!signal.aborted) {
    const pending = await port.listQuestions(RUN_ID);
    if (pending.length > 0) return pending;
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 25);
    });
  }
  return [];
}

describe("[functional-only] real staged OpenCode runtime", () => {
  it.skipIf(!FUNCTIONAL_ENABLED)(
    "starts and reaps the explicit staged v1.17.17 binary without native qualification claims",
    // eslint-disable-next-line complexity -- the real question and abort lifecycle keeps all gates visible.
    async () => {
      const root = mkdtempSync(join(tmpdir(), "keiko-opencode-functional-"));
      const workspaceRoot = join(root, "workspace");
      const stateBaseRoot = join(root, "state");
      mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
      mkdirSync(join(workspaceRoot, ".opencode"), { recursive: true, mode: 0o700 });
      writeFileSync(join(workspaceRoot, "opencode.json"), '{"tools":{"bash":true}}\n');
      writeFileSync(join(workspaceRoot, ".opencode", "hostile.ts"), "export default {};\n");
      const portable = realPortableRuntime(root);
      const responseControl = scriptedProductiveResponse();
      const gateway = await createGatewayHarness(responseControl.script);
      const productiveActions: string[] = [];
      const toolStatuses: string[] = [];
      const sessionStatuses: string[] = [];
      const governedIdentityKeys = new Set<string>();
      let duplicateGovernedEffects = 0;
      const backend = new DirectChildRuntimeBackend(functionalPlatform().qualification);
      const supervisor = createRuntimeProcessSupervisor({
        backend,
        qualifications: [functionalPlatform().qualification],
      });
      const diagnostic = vi.spyOn(console, "error").mockImplementation((): void => undefined);
      const runtime = createOpenCodeRuntimeComposition({
        portable,
        stateBaseRoot,
        capabilities: {
          modelGatewayCapability: MODEL_CAPABILITY,
          toolFacadeCapability: TOOL_CAPABILITY,
        },
        toolFacade: functionalToolFacade(productiveActions, toolStatuses),
        governedEventSink: {
          execute: (identityKey): Promise<"applied"> => {
            if (governedIdentityKeys.has(identityKey)) duplicateGovernedEffects += 1;
            governedIdentityKeys.add(identityKey);
            return Promise.resolve("applied");
          },
        },
        gatewayReadiness: gateway.readiness,
        fetch: statusCapturingFetch(sessionStatuses),
        supervisor,
        authorityLifecycle: {
          revokeRuntime: () => true,
          abortInFlightActions: () => true,
          markRuntimeRecoveryRequired: () => true,
          releaseRuntimeAfterReap: () => true,
        },
      });
      const runRoot = join(stateBaseRoot, RUN_ID);
      try {
        const started = await Promise.resolve(
          runtime.manager.start({
            runId: RUN_ID,
            treeBindingId: TREE_BINDING_ID,
            taskRef: "issue-2254",
            workspaceRoot,
            adapterKind: "opencode-compatible",
            runtimeSource: "keiko-sidecar",
            modelSource: "keiko-model-gateway",
            requestedMode: "supervised-coding",
            effectiveMode: "supervised-coding",
            executablePath: join(portable.resourceRoot, portable.verification.executablePath),
            managedRoot: join(portable.resourceRoot, portable.verification.payloadRootPath),
            gatewayUrl: gateway.endpoint,
            modelProfileId: "coding-safe-openai-compatible",
            args: [],
            inheritedEnvAllowlist: [],
            shutdownTimeoutMs: 5_000,
            startTimeoutMs: 20_000,
            confinement: functionalPlatform().qualification,
          }),
        );
        expect(backend.launchEnvironment()).toMatchObject({
          OPENCODE_CONFIG_DIR: join(runRoot, "config", "opencode"),
          OPENCODE_DISABLE_PROJECT_CONFIG: "true",
          KEIKO_MODEL_GATEWAY_URL: gateway.endpoint,
          KEIKO_MODEL_GATEWAY_CAPABILITY: MODEL_CAPABILITY,
        });
        if (!started.ok) {
          throw new Error(
            `functional-opencode-start-failed:${started.failureCode}:gateway-calls=${String(gateway.calls())}:gateway-responses=${gateway.responses().join(",")}:gateway-summaries=${gateway.summaries().join(",")}:tool-statuses=${toolStatuses.join(",")}:stderr=${backend.redactedStderr()}`,
          );
        }
        expect(started).toMatchObject({ runId: RUN_ID, status: "ready" });
        expect(gateway.calls()).toBeGreaterThan(0);
        expect(productiveActions).toEqual([]);
        expect(runtime.manager.health()).toEqual({ status: "ready", activeRunId: RUN_ID });
        const firstPrompt = "Apply the prepared change.";
        await expect(runtime.runPort.submitTask(RUN_ID, firstPrompt)).resolves.toBe(true);
        const questionPort = runtime.runPort as unknown as TestQuestionRunPort;
        const pendingQuestions = await waitForQuestions(questionPort, AbortSignal.timeout(5_000));
        expect(pendingQuestions).toHaveLength(1);
        expect(pendingQuestions[0]?.questions).toEqual([
          {
            question: "Approve the prepared bounded edit?",
            header: "Approval",
            options: [{ label: "Approve", description: "Continue safely" }],
          },
        ]);
        await expect(
          questionPort.answerQuestion(RUN_ID, pendingQuestions[0]?.id ?? "", [["Approve"]]),
        ).resolves.toBe(true);
        const pendingAfterAnswer = (await questionPort.listQuestions(RUN_ID)).length;
        expect(pendingAfterAnswer).toBe(0);
        const terminal = await runtime.runPort.waitForTerminal(RUN_ID, AbortSignal.timeout(20_000));
        const pendingAfterFinal = (await questionPort.listQuestions(RUN_ID)).length;
        if (!terminal || pendingAfterFinal !== 0) {
          throw new Error(
            `functional-opencode-terminal-missing:terminal=${String(terminal)}:pending-after-answer=${String(pendingAfterAnswer)}:pending-after-final=${String(pendingAfterFinal)}:actions=${productiveActions.join(",")}:tool-statuses=${toolStatuses.join(",")}:gateway-requests=${String(gateway.requests.length)}:session-statuses=${sessionStatuses.join(",")}:stderr=${backend.redactedStderr()}:${runtimeDatabaseProjection(join(runRoot, "state", "opencode.db"))}`,
          );
        }
        expect(productiveActions).toEqual(["read", "edit"]);
        expect(gateway.requests).toHaveLength(4);
        expect(
          gateway.requests.every((request) => hasExactOpenCodeVisibleToolContract(request.tools)),
        ).toBe(true);
        expect(gateway.calls() - gateway.requests.length).toBe(1);
        expect(duplicateGovernedEffects).toBe(0);

        const secondPrompt = "Continue after the prepared change.";
        const databasePath = join(runRoot, "state", "opencode.db");
        const statusBeforeSecondSubmit = sessionStatuses.at(-1) ?? "status=unobserved";
        const statusSampleOffset = sessionStatuses.length;
        const secondAccepted = await runtime.runPort.submitTask(RUN_ID, secondPrompt);
        expect(secondAccepted).toBe(true);
        const abortedTerminal = runtime.runPort.waitForTerminal(
          RUN_ID,
          AbortSignal.timeout(20_000),
        );
        const heldWaitStarted = Date.now();
        const held = await waitForCondition(responseControl.held, AbortSignal.timeout(5_000));
        const heldArrivalLatencyMs = Date.now() - heldWaitStarted;
        if (!held) {
          throw new Error(
            `functional-opencode-second-turn-dispatch-missing:accepted=${String(secondAccepted)}:status-before-submit=${statusBeforeSecondSubmit}:arrival-latency-ms=${String(heldArrivalLatencyMs)}:gateway-calls=${String(gateway.calls())}:gateway-requests=${String(gateway.requests.length)}:gateway-summaries=${gateway.summaries().join(",")}:status-after-submit=${sessionStatuses.slice(statusSampleOffset).join(",")}:manager-health=${runtime.manager.health().status}:stderr=${backend.redactedStderr()}:${runtimeDatabaseProjection(databasePath)}`,
          );
        }
        expect(statusBeforeSecondSubmit).toBe("status=");
        await expect(
          waitForCondition(
            () => sessionStatuses.some((status) => status.includes("busy")),
            AbortSignal.timeout(5_000),
          ),
        ).resolves.toBe(true);
        expect(gateway.requests).toHaveLength(5);
        expect(hasExactOpenCodeVisibleToolContract(gateway.requests.at(-1)?.tools)).toBe(true);
        await expect(runtime.runPort.abortTask(RUN_ID)).resolves.toBe(true);
        responseControl.release();
        await expect(abortedTerminal).resolves.toBe(true);
        await expect(
          waitForCondition(
            () => gateway.responseCloses() === gateway.calls(),
            AbortSignal.timeout(5_000),
          ),
        ).resolves.toBe(true);
        expect(productiveActions).toEqual(["read", "edit"]);
        expect(toolStatuses).toEqual(["observed", "completed", "completed"]);
        expect(gateway.calls() - gateway.requests.length).toBe(1);
        expect(duplicateGovernedEffects).toBe(0);
        expect(sessionStatuses).toContain("status=");
        expect(sessionStatuses.some((status) => status.includes("busy"))).toBe(true);
        const contentFreeRetention = JSON.stringify({
          productiveActions,
          toolStatuses,
          sessionStatuses,
          gatewaySummaries: gateway.summaries(),
          terminalFrames: gateway.terminalFrames(),
          governedEffectCount: governedIdentityKeys.size,
        });
        for (const forbidden of [
          firstPrompt,
          secondPrompt,
          MODEL_CAPABILITY,
          TOOL_CAPABILITY,
          "functional-provider-secret",
        ]) {
          expect(contentFreeRetention).not.toContain(forbidden);
        }
        await expect(runtime.manager.stop(RUN_ID)).resolves.toEqual({
          ok: true,
          status: "stopped",
        });
        expect(runtime.manager.health()).toEqual({ status: "stopped" });
        expect(existsSync(runRoot)).toBe(false);
        expect(diagnostic).not.toHaveBeenCalled();
      } finally {
        responseControl.release();
        await runtime.manager.stop(RUN_ID);
        await gateway.close();
        diagnostic.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
