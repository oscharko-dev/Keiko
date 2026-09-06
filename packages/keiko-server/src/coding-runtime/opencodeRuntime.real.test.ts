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
import {
  toolCallingConfigurationFingerprint,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayStreamChunk,
  type NormalizedResponse,
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
import { CODING_TOOL_MAX_BODY_BYTES, type CodingToolResult } from "./codingToolIpc.js";
import {
  createOpenCodeRuntimeComposition,
  incomingHeaders,
  readBoundedBody,
  type OpenCodeToolBridge,
} from "./opencodeRuntimeComposition.js";
import { createOpenCodeGatewayToolCatalogAdvertisement } from "./opencodeToolSchemas.js";
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
  const provider = {
    modelId: "functional-coding-model",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "functional-provider-secret",
    apiKeyHeaderName: "api-key",
    endpointStyle: "azure-openai-deployment" as const,
    apiVersion: "2024-06-01",
    timeoutMs: 30_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  return {
    providers: [provider],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: "functional-coding-model",
        kind: "chat",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        toolCallingVerification: {
          status: "verified",
          checkedAt: new Date().toISOString(),
          probe: "gateway-tool-calling-v1",
          configurationFingerprint: toolCallingConfigurationFingerprint(provider),
        },
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
    script: (request): Promise<NormalizedResponse> => {
      if (requestContainsText(request, "Continue after the prepared change.")) {
        return new Promise<NormalizedResponse>((resolve) => {
          held = true;
          releaseResponse = (): void => {
            resolve({ ...normalResponse(), content: "Cancelled turn settled." });
          };
        });
      }
      if (requestContainsToolCall(request, "keiko_changeset_edit")) {
        return Promise.resolve({ ...normalResponse(), content: "Completed." });
      }
      if (requestContainsToolCall(request, "question")) {
        return Promise.resolve(toolResponse("call-edit", "keiko_changeset_edit", { changeset }));
      }
      if (requestContainsToolCall(request, "keiko_workspace_read")) {
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
      }
      if (!requestContainsTitleGeneration(request)) {
        return Promise.resolve(
          toolResponse("call-read", "keiko_workspace_read", { relativePath: "src/example.ts" }),
        );
      }
      return Promise.resolve({ ...normalResponse(), content: "Prepared change" });
    },
  };
}

function requestContainsText(request: GatewayRequest, text: string): boolean {
  return request.messages.some((message) => message.content.includes(text));
}

function requestContainsTitleGeneration(request: GatewayRequest): boolean {
  return request.messages.some((message) =>
    message.content.startsWith("Generate a title for this conversation:"),
  );
}

function requestContainsToolCall(request: GatewayRequest, name: string): boolean {
  return request.messages.some((message) => message.toolCalls?.some((call) => call.name === name));
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
    // The real v1.17.17 child issues streaming chats; without this scripted stream factory the
    // gateway falls back to the default provider path and every post-handshake turn dies.
    codingSidecarGatewayChatStreamFactory:
      (): ((request: GatewayRequest) => AsyncIterable<GatewayStreamChunk>) =>
      (request): AsyncIterable<GatewayStreamChunk> => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<GatewayStreamChunk> {
          requests.push(request);
          const callIndex = providerCalls;
          providerCalls += 1;
          // Establish the same streaming response lifecycle a real provider does before a
          // scripted final response is deliberately held for the native abort proof.
          yield { type: "delta", token: "" };
          yield { type: "done", response: await script(request, callIndex) };
        },
      }),
    runtimeCapabilityAuthenticator: {
      authenticate: (capability: string, audience: "model-gateway" | "tool-facade"): unknown =>
        capability === MODEL_CAPABILITY && audience === "model-gateway"
          ? { ok: true, binding: { runId: RUN_ID } }
          : { ok: false },
      reservePromptTokens: () => ({ ok: true, runId: RUN_ID }),
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

interface ToolFacadeHarness {
  readonly endpoint: string;
  /** Binds the composition's real bridge once `createOpenCodeRuntimeComposition` has returned it
   * -- the harness must bind and listen on a port BEFORE the composition exists, so requests that
   * arrive before `bind` is called are refused 503, the same "no run active" shape `handle()`
   * itself returns before a run starts. */
  bind(handle: OpenCodeToolBridge["handle"]): void;
  close(): Promise<void>;
}

/**
 * ADR-0043 D11-D14 (#3390): production never opens a second loopback listener for the tool
 * facade -- the sandboxed sidecar reaches it through the BFF's `/api/coding-sidecar/tool` route,
 * which dispatches directly to the run's bridge (`OpenCodeToolBridge.handle`). This real-binary
 * suite spawns an ACTUAL OpenCode child that only speaks HTTP, so it needs a real socket to POST
 * to; unlike production it owns that socket itself (mirroring `createGatewayHarness` above for
 * the model gateway) instead of routing through the full BFF route stack, and wraps the SAME
 * `handle` the production route calls -- never a second facade implementation.
 */
async function createToolFacadeHarness(): Promise<ToolFacadeHarness> {
  let handle: OpenCodeToolBridge["handle"] | undefined;
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      if (handle === undefined) {
        res.writeHead(503).end();
        return;
      }
      // Reuses the SAME byte-budget-bounded body reader `handle()`'s own retired listener used
      // (see opencodeRuntimeComposition.ts's comment on `readBoundedBody`) -- never a second body
      // reader for this one still-allowed real HTTP endpoint around `handle`.
      const body = await readBoundedBody(req, new AbortController().signal);
      const result = await handle({
        method: "POST",
        headers: incomingHeaders(req.headers),
        body: body.toString("utf8"),
      });
      res.writeHead(result.status, { "Content-Type": "application/json" }).end(result.body);
    })();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("functional-tool-facade-bind-failed");
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/api/coding-sidecar/tool`,
    bind: (boundHandle): void => {
      handle = boundHandle;
    },
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
        correlationId: undefined,
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

function statusCapturingFetch(
  statuses: string[],
  histories: string[] = [],
): typeof globalThis.fetch {
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
    if (url.pathname === "/sync/history")
      histories.push(await historyEventSummary(response.clone()));
    return response;
  };
}

async function historyEventSummary(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (!Array.isArray(value)) return "history=invalid";
    return value
      .map((entry) => {
        if (!isRecord(entry) || !isRecord(entry.data)) return "invalid";
        const part = isRecord(entry.data.part) ? entry.data.part : undefined;
        const state = part !== undefined && isRecord(part.state) ? part.state : undefined;
        return [entry.type, part?.type, part?.tool, state?.status]
          .filter((field): field is string => typeof field === "string")
          .join(":");
      })
      .join("|");
  } catch {
    return "history=unavailable";
  }
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

function runtimeDatabasePartTypes(databasePath: string): readonly string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT DISTINCT json_extract(data, '$.type') AS type FROM part ORDER BY type")
      .all() as readonly Record<string, unknown>[];
    return rows.flatMap((row) => (typeof row.type === "string" ? [row.type] : []));
  } finally {
    database.close();
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

interface NativeCompactionState {
  rounds: number;
  roundsInTurn: number;
  readonly assistantContentChars: number;
  readonly turnSize: number;
  readonly compactionMessageCounts: number[];
  readonly recoveryMessageCounts: number[];
}

function batchedReadResponse(round: number, assistantContentChars: number): NormalizedResponse {
  return {
    ...normalResponse(),
    content: "x".repeat(assistantContentChars),
    finishReason: "tool_calls",
    toolCalls: [
      {
        id: `call-${String(round)}`,
        name: "keiko_workspace_read",
        arguments: { relativePath: `src/fixture-${String(round)}.ts` },
      },
    ],
  };
}

function nativeCompactionResponseScript(state: NativeCompactionState): GatewayResponseScript {
  return (request): Promise<NormalizedResponse> => {
    if (requestContainsTitleGeneration(request)) {
      return Promise.resolve({ ...normalResponse(), content: "Compaction proof" });
    }
    if (request.toolCatalog === undefined) {
      state.compactionMessageCounts.push(request.messages.length);
      return Promise.resolve({ ...normalResponse(), content: "Retained verified task state." });
    }
    if (state.compactionMessageCounts.length > 0) {
      state.recoveryMessageCounts.push(request.messages.length);
      return Promise.resolve({ ...normalResponse(), content: "Recovered after compaction." });
    }
    state.rounds += 1;
    state.roundsInTurn += 1;
    if (state.roundsInTurn === state.turnSize) {
      state.roundsInTurn = 0;
      return Promise.resolve({ ...normalResponse(), content: "Turn checkpoint complete." });
    }
    return Promise.resolve(batchedReadResponse(state.rounds, state.assistantContentChars));
  };
}

interface NativeCompactionHarness {
  readonly root: string;
  readonly runRoot: string;
  readonly runtime: ReturnType<typeof createOpenCodeRuntimeComposition>;
  readonly gateway: GatewayHarness;
  readonly toolFacade: ToolFacadeHarness;
  readonly backend: DirectChildRuntimeBackend;
  readonly productiveActions: string[];
}

async function createNativeCompactionHarness(
  script: GatewayResponseScript,
): Promise<NativeCompactionHarness> {
  const root = mkdtempSync(join(tmpdir(), "keiko-opencode-compaction-"));
  const workspaceRoot = join(root, "workspace");
  const stateBaseRoot = join(root, "state");
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const portable = realPortableRuntime(root);
  const gateway = await createGatewayHarness(script);
  const toolFacade = await createToolFacadeHarness();
  const productiveActions: string[] = [];
  const backend = new DirectChildRuntimeBackend(functionalPlatform().qualification);
  const runtime = createOpenCodeRuntimeComposition({
    portable,
    stateBaseRoot,
    contextGeometry: {
      contextWindowTokens: 65_536,
      maxInputTokens: 61_440,
      maxOutputTokens: 4_096,
    },
    capabilities: {
      modelGatewayCapability: MODEL_CAPABILITY,
      toolFacadeCapability: TOOL_CAPABILITY,
    },
    toolFacadeOrigin: toolFacade.endpoint,
    toolFacade: functionalToolFacade(productiveActions, []),
    governedEventSink: { execute: () => Promise.resolve("applied") },
    gatewayReadiness: gateway.readiness,
    fetch: globalThis.fetch,
    supervisor: createRuntimeProcessSupervisor({
      backend,
      qualifications: [functionalPlatform().qualification],
    }),
    authorityLifecycle: {
      revokeRuntime: () => true,
      abortInFlightActions: () => true,
      markRuntimeRecoveryRequired: () => true,
      releaseRuntimeAfterReap: () => true,
    },
  });
  toolFacade.bind((request) => runtime.toolBridge.handle(request));
  return {
    root,
    runRoot: join(stateBaseRoot, RUN_ID),
    runtime,
    gateway,
    toolFacade,
    backend,
    productiveActions,
  };
}

async function startNativeCompactionHarness(harness: NativeCompactionHarness): Promise<void> {
  const started = await harness.runtime.manager.start({
    runId: RUN_ID,
    treeBindingId: TREE_BINDING_ID,
    taskRef: "issue-3384-message-limit",
    workspaceRoot: join(harness.root, "workspace"),
    adapterKind: "opencode-compatible",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
    executablePath: join(harness.root, "portable-resource/payload/bin/opencode"),
    managedRoot: join(harness.root, "portable-resource/payload"),
    gatewayUrl: harness.gateway.endpoint,
    modelProfileId: "coding-safe-openai-compatible",
    args: [],
    inheritedEnvAllowlist: [],
    shutdownTimeoutMs: 5_000,
    startTimeoutMs: 20_000,
    confinement: functionalPlatform().qualification,
  });
  if (!started.ok) {
    throw new Error(
      `native-compaction-start-failed:${started.failureCode}:${harness.backend.redactedStderr()}`,
    );
  }
}

async function closeNativeCompactionHarness(harness: NativeCompactionHarness): Promise<void> {
  await harness.runtime.manager.stop(RUN_ID);
  await harness.gateway.close();
  await harness.toolFacade.close();
  rmSync(harness.root, { recursive: true, force: true });
}

function requestMessageCount(summary: string): number | undefined {
  const value = /:messages=(\d+):/u.exec(summary)?.[1];
  return value === undefined ? undefined : Number(value);
}

describe("[functional-only] real staged OpenCode runtime", () => {
  it.skipIf(!FUNCTIONAL_ENABLED)(
    "decodes a 513-message overflow, compacts natively, and completes the retry",
    async () => {
      const state: NativeCompactionState = {
        rounds: 0,
        roundsInTurn: 0,
        assistantContentChars: 0,
        turnSize: 100,
        compactionMessageCounts: [],
        recoveryMessageCounts: [],
      };
      const harness = await createNativeCompactionHarness(nativeCompactionResponseScript(state));
      try {
        await startNativeCompactionHarness(harness);
        const terminals: boolean[] = [];
        for (let turn = 1; turn <= 3; turn += 1) {
          await expect(
            harness.runtime.runPort.submitTask(
              RUN_ID,
              `Exercise bounded native compaction turn ${String(turn)}.`,
            ),
          ).resolves.toBe(true);
          terminals.push(
            await harness.runtime.runPort.waitForTerminal(RUN_ID, AbortSignal.timeout(60_000)),
          );
        }

        const messageCounts = harness.gateway.summaries().flatMap((summary) => {
          const count = requestMessageCount(summary);
          return count === undefined ? [] : [count];
        });
        expect(
          terminals,
          `state=${JSON.stringify(state)}:max-messages=${String(Math.max(...messageCounts))}:http-400=${String(harness.gateway.responses().filter((response) => response.endsWith(" 400")).length)}`,
        ).toEqual([true, true, true]);
        expect(
          messageCounts.includes(513),
          `rounds=${String(state.rounds)}:max-messages=${String(Math.max(...messageCounts))}`,
        ).toBe(true);
        expect(harness.gateway.responses().some((response) => response.endsWith(" 400"))).toBe(
          true,
        );
        expect(state.compactionMessageCounts).toHaveLength(1);
        expect(state.compactionMessageCounts[0]).toBeLessThanOrEqual(512);
        expect(state.recoveryMessageCounts).toHaveLength(1);
        expect(state.recoveryMessageCounts[0]).toBeLessThanOrEqual(512);
        expect(state.rounds).toBeGreaterThan(1);
        expect(harness.productiveActions.length).toBeGreaterThan(0);
        expect(runtimeDatabasePartTypes(join(harness.runRoot, "state", "opencode.db"))).toContain(
          "compaction",
        );
      } finally {
        await closeNativeCompactionHarness(harness);
      }
    },
    120_000,
  );

  it.skipIf(!FUNCTIONAL_ENABLED)(
    "stops after the native compactor rejects an uncompactable long turn",
    async () => {
      const state: NativeCompactionState = {
        rounds: 0,
        roundsInTurn: 0,
        assistantContentChars: 100_000,
        turnSize: Number.MAX_SAFE_INTEGER,
        compactionMessageCounts: [],
        recoveryMessageCounts: [],
      };
      const harness = await createNativeCompactionHarness(nativeCompactionResponseScript(state));
      try {
        await startNativeCompactionHarness(harness);
        await expect(
          harness.runtime.runPort.submitTask(RUN_ID, "Exercise bounded uncompactable history."),
        ).resolves.toBe(true);
        const terminal = await harness.runtime.runPort.waitForTerminal(
          RUN_ID,
          AbortSignal.timeout(60_000),
        );

        const messageCounts = harness.gateway.summaries().flatMap((summary) => {
          const count = requestMessageCount(summary);
          return count === undefined ? [] : [count];
        });
        expect(Math.max(...messageCounts)).toBeLessThanOrEqual(512);
        expect(
          harness.gateway.responses().filter((response) => response.endsWith(" 400")),
        ).toHaveLength(2);
        expect(state.compactionMessageCounts).toEqual([]);
        expect(state.recoveryMessageCounts).toEqual([]);
        expect(state.rounds).toBeGreaterThan(1);
        const databasePath = join(harness.runRoot, "state", "opencode.db");
        expect(runtimeDatabasePartTypes(databasePath)).toContain("compaction");
        expect(runtimeDatabaseProjection(databasePath)).toContain("ContextOverflowError");
        expect(terminal).toBe(false);
      } finally {
        await closeNativeCompactionHarness(harness);
      }
    },
    120_000,
  );

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
      const toolFacade = await createToolFacadeHarness();
      const productiveActions: string[] = [];
      const toolStatuses: string[] = [];
      const sessionStatuses: string[] = [];
      const historyEvents: string[] = [];
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
        contextGeometry: {
          contextWindowTokens: 65_536,
          maxInputTokens: 61_440,
          maxOutputTokens: 4_096,
        },
        capabilities: {
          modelGatewayCapability: MODEL_CAPABILITY,
          toolFacadeCapability: TOOL_CAPABILITY,
        },
        toolFacadeOrigin: toolFacade.endpoint,
        toolFacade: functionalToolFacade(productiveActions, toolStatuses),
        governedEventSink: {
          execute: (identityKey): Promise<"applied"> => {
            if (governedIdentityKeys.has(identityKey)) duplicateGovernedEffects += 1;
            governedIdentityKeys.add(identityKey);
            return Promise.resolve("applied");
          },
        },
        gatewayReadiness: gateway.readiness,
        fetch: statusCapturingFetch(sessionStatuses, historyEvents),
        supervisor,
        authorityLifecycle: {
          revokeRuntime: () => true,
          abortInFlightActions: () => true,
          markRuntimeRecoveryRequired: () => true,
          releaseRuntimeAfterReap: () => true,
        },
      });
      toolFacade.bind((request) => runtime.toolBridge.handle(request));
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
            `functional-opencode-start-failed:${started.failureCode}:gateway-calls=${String(gateway.calls())}:gateway-responses=${gateway.responses().join(",")}:gateway-summaries=${gateway.summaries().join(",")}:tool-statuses=${toolStatuses.join(",")}:history-events=${historyEvents.join(",")}:stderr=${backend.redactedStderr()}`,
          );
        }
        expect(started).toMatchObject({ runId: RUN_ID, status: "ready" });
        const nativeAcceptedConfig = JSON.parse(
          readFileSync(join(runRoot, "config", "opencode", "opencode.json"), "utf8"),
        ) as { readonly tool_output?: { readonly max_bytes?: number } };
        expect(nativeAcceptedConfig.tool_output).toEqual({
          max_bytes: CODING_TOOL_MAX_BODY_BYTES,
        });
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
        expect(productiveActions, gateway.summaries().join("|")).toEqual(["read", "edit"]);
        expect(gateway.requests).toHaveLength(4);
        const expectedProjection = createOpenCodeGatewayToolCatalogAdvertisement(
          Date.parse("2026-09-05T00:00:00.000Z"),
        ).projection;
        expect(
          gateway.requests.every(
            (request) =>
              request.toolCatalog?.kind === "bound" &&
              request.toolCatalog.projection.projectionDigest ===
                expectedProjection.projectionDigest,
          ),
        ).toBe(true);
        expect(gateway.calls() - gateway.requests.length).toBe(1);
        expect(duplicateGovernedEffects).toBe(0);

        const secondPrompt = "Continue after the prepared change.";
        const databasePath = join(runRoot, "state", "opencode.db");
        const statusBeforeSecondSubmit = sessionStatuses.at(-1) ?? "status=unobserved";
        const statusSampleOffset = sessionStatuses.length;
        const secondAccepted = await runtime.runPort.submitTask(RUN_ID, secondPrompt);
        expect(secondAccepted).toBe(true);
        const heldWaitStarted = Date.now();
        const held = await waitForCondition(responseControl.held, AbortSignal.timeout(5_000));
        const heldArrivalLatencyMs = Date.now() - heldWaitStarted;
        if (!held) {
          throw new Error(
            `functional-opencode-second-turn-dispatch-missing:accepted=${String(secondAccepted)}:status-before-submit=${statusBeforeSecondSubmit}:arrival-latency-ms=${String(heldArrivalLatencyMs)}:gateway-calls=${String(gateway.calls())}:gateway-requests=${String(gateway.requests.length)}:gateway-summaries=${gateway.summaries().join(",")}:status-after-submit=${sessionStatuses.slice(statusSampleOffset).join(",")}:manager-health=${runtime.manager.health().status}:stderr=${backend.redactedStderr()}:${runtimeDatabaseProjection(databasePath)}`,
          );
        }
        // The live idle control may settle the turn before a final status poll samples the
        // cleared entry, so the last observation is either already empty or the stale busy
        // sample; the accepted second submit and the fresh busy observation below carry the
        // actual settled-session proof.
        expect(["status=", "status=busy"]).toContain(statusBeforeSecondSubmit);
        await expect(
          waitForCondition(
            () =>
              sessionStatuses.slice(statusSampleOffset).some((status) => status.includes("busy")),
            AbortSignal.timeout(5_000),
          ),
        ).resolves.toBe(true);
        expect(gateway.requests).toHaveLength(5);
        expect(gateway.requests.at(-1)?.toolCatalog?.projection.projectionDigest).toBe(
          expectedProjection.projectionDigest,
        );
        const aborted = await runtime.runPort.abortTask(RUN_ID);
        expect(
          aborted,
          `statuses=${sessionStatuses.join(",")}:gateway=${gateway.summaries().join("|")}`,
        ).toBe(true);
        responseControl.release();
        await expect(
          runtime.runPort.waitForTerminal(RUN_ID, AbortSignal.timeout(20_000)),
        ).resolves.toBe(true);
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
        await toolFacade.close();
        diagnostic.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
