import { afterEach, describe, expect, it, vi } from "vitest";
import { Gateway, type Clock } from "@oscharko-dev/keiko-model-gateway";
import { createSession, GatewayModelPort, MemoryEventSink } from "@oscharko-dev/keiko-harness";
import { WorkspaceToolHost } from "@oscharko-dev/keiko-tools";
import { createToolInvocationNormalizer } from "@oscharko-dev/keiko-tool-catalog";
import type {
  CatalogToolPort,
  GovernedToolCallRequest,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type { CatalogActionIdentity } from "./catalogToolPorts.js";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
import { createNativeCatalogToolPort } from "./nativeCatalogToolPort.js";
import { catalogRuntimeFixture } from "./__fixtures__/catalogRuntimeFixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function clock(now: () => number): Clock {
  return {
    now,
    sleep: (_ms, signal): Promise<void> =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      }),
  };
}
function providerResponse(tool: boolean): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: tool ? "tool_calls" : "stop",
          message: tool
            ? {
                content: "",
                tool_calls: [
                  {
                    id: "provider-call-1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "fixture.ts" }),
                    },
                  },
                ],
              }
            : { content: "Read completed" },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
function workspace(root: string): ConstructorParameters<typeof WorkspaceToolHost>[0]["workspace"] {
  return {
    root,
    selectedRoot: root,
    name: "fixture",
    version: "1",
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: ["typescript"],
    ignoreLines: [],
  };
}
describe("native catalog composition through genuine runtime owners", () => {
  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "runs real Gateway -> harness -> binder -> workspace read in %s",
    async (mode) => {
      const fixture = catalogRuntimeFixture(mode);
      cleanups.push(fixture.dispose);
      const host = new WorkspaceToolHost({ workspace: workspace(fixture.root), now: fixture.now });
      const descriptor = fixture.options.catalog.descriptors.find(
        (entry) => entry.toolRef.canonicalId === "keiko.file.read",
      );
      if (descriptor === undefined) throw new TypeError("Missing canonical read descriptor");
      const seenBodies: unknown[] = [];
      const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
        if (typeof init?.body !== "string") throw new TypeError("Expected provider request");
        seenBodies.push(JSON.parse(init.body) as unknown);
        return Promise.resolve(providerResponse(seenBodies.length === 1));
      });
      const gateway = new Gateway(
        {
          providers: [
            {
              modelId: "native-test",
              baseUrl: "https://provider.example/v1",
              apiKey: "native-test-provider-credential",
              timeoutMs: 1000,
              maxRetries: 0,
              retryBaseDelayMs: 1,
            },
          ],
          circuitBreaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenProbes: 1 },
        },
        { fetchImpl, clock: clock(fixture.now) },
      );
      const admit = vi.spyOn(fixture.input.authorityPort, "admit");
      const session = createSession(
        { taskType: "investigate-bug", input: { description: "Read accepted workspace" } },
        {
          model: "native-test",
          workingDirectory: fixture.root,
          dryRun: false,
          limits: { maxToolCalls: 1 },
        },
        {
          model: new GatewayModelPort(gateway),
          tools: host,
          sink: new MemoryEventSink(),
          clock: clock(fixture.now),
          idSource: { newRunId: () => "run-1" },
          bindToolCatalog: (context) =>
            createNativeCatalogToolPort({
              host,
              actions: [
                {
                  descriptor,
                  preview: (identity): CodingToolActionRequest => ({
                    action: "read",
                    relativePath: "fixture.ts",
                    ...identity,
                  }),
                  resolve: (args, identity): CodingToolActionRequest => {
                    if (
                      typeof args !== "object" ||
                      args === null ||
                      !("path" in args) ||
                      typeof args.path !== "string"
                    )
                      throw new TypeError("Expected canonical read arguments");
                    return { action: "read", relativePath: args.path, ...identity };
                  },
                },
              ],
              binder: { ...fixture.input, budgetPort: context.budgetPort },
              options: {
                ...fixture.options,
                context: () => ({ ...fixture.options.context(), signal: context.signal }),
              },
              nextIdentity: () => ({
                actionId: "trusted-action-1",
                idempotencyKey: "trusted-key-1",
              }),
              observeExecution: context.observeExecution,
            }),
        },
      );
      const result = await session.result;
      expect(result.outcome, JSON.stringify(result.failure)).toBe("completed");
      expect(admit).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(seenBodies[0]).toMatchObject({ tools: [{ function: { name: "read_file" } }] });
      expect(JSON.stringify(seenBodies[1])).toContain("export const valid = true");
      expect(
        fixture.primary.events.filter((event) => event.op === "tool-catalog.invocation-settled"),
      ).toHaveLength(1);
      expect(JSON.stringify(fixture.primary.events)).not.toContain("export const valid = true");
      expect(result.events.filter((event) => event.type === "tool:call:completed")).toHaveLength(1);
    },
  );
});

function standaloneNative(): {
  fixture: ReturnType<typeof catalogRuntimeFixture>;
  host: WorkspaceToolHost;
  port: CatalogToolPort;
  request: GovernedToolCallRequest;
  observed: ReturnType<typeof vi.fn>;
} {
  const fixture = catalogRuntimeFixture("autonomous-delivery");
  cleanups.push(fixture.dispose);
  const host = new WorkspaceToolHost({ workspace: workspace(fixture.root), now: fixture.now });
  const descriptor = fixture.options.catalog.descriptors.find(
    (entry) => entry.toolRef.canonicalId === "keiko.file.read",
  );
  if (descriptor === undefined) throw new TypeError("Missing read descriptor");
  const action = (identity: CatalogActionIdentity): CodingToolActionRequest => ({
    action: "read",
    relativePath: "fixture.ts",
    actionId: identity.actionId,
    idempotencyKey: identity.idempotencyKey,
  });
  const observed = vi.fn();
  const port = createNativeCatalogToolPort({
    host,
    actions: [
      {
        descriptor,
        preview: (identity): CodingToolActionRequest => action(identity),
        resolve: (_args, identity): CodingToolActionRequest => action(identity),
      },
    ],
    binder: fixture.input,
    options: fixture.options,
    nextIdentity: () => ({ actionId: "trusted-action", idempotencyKey: "trusted-key" }),
    observeExecution: observed,
  });
  const { catalog, projection, offered } = port.offer();
  const invocation = createToolInvocationNormalizer({ catalog, projection, offered }).bindAlias(
    "read_file",
    { path: "fixture.ts" },
    fixture.now(),
  );
  return {
    fixture,
    host,
    port,
    observed,
    request: { toolCallId: "provider-call", invocation, signal: new AbortController().signal },
  };
}
describe("native server port boundaries", () => {
  it("omits a descriptor whose actual host implementation identity no longer matches", () => {
    const f = standaloneNative();
    const other = f.fixture.options.catalog.descriptors.find(
      (entry) => entry.toolRef.canonicalId === "keiko.command.run",
    );
    if (other === undefined) throw new TypeError("Missing command descriptor");
    vi.spyOn(f.host, "catalogDescriptor").mockReturnValue(other);
    const { catalog, projection, offered } = f.port.offer();
    expect(offered.binding.readiness).toBe("unavailable");
    expect(offered.toolRefs).toEqual([]);
    expect(
      createToolInvocationNormalizer({ catalog, projection, offered }).tools(f.fixture.now()),
    ).toEqual([]);
  });
  it("retains body-free receipt replay without executing the real host again", async () => {
    const f = standaloneNative();
    const execute = vi.spyOn(f.host, "executeCatalog");
    const first = await f.port.execute(f.request);
    const replay = await f.port.execute(f.request);
    expect(first.kind).toBe("settled");
    expect(replay).toEqual({ kind: "replayed", receipt: first.receipt });
    expect(execute).toHaveBeenCalledOnce();
    expect(f.observed).toHaveBeenCalledOnce();
    expect(JSON.stringify(replay)).not.toContain("export const valid");
  });
  it("rejects a forged offered identity and revoked authority before the real host", async () => {
    const f = standaloneNative();
    const execute = vi.spyOn(f.host, "executeCatalog");
    // `f.request.invocation` is already `BoundToolInvocation`, whose `kind` is the single literal
    // "bound" -- a `kind !== "bound"` narrowing guard here would be unreachable by construction
    // (sonarjs/no-unnecessary-condition), so the spread below carries `kind` through unchanged.
    const forged = await f.port.execute({
      ...f.request,
      invocation: { ...f.request.invocation, offerId: "forged-offer" },
    });
    expect(forged.kind === "settled" && forged.result).toMatchObject({
      status: "invalid",
      reason: "unoffered-tool",
    });
    f.fixture.registry.revoke(f.fixture.minted.authorityRef);
    expect(f.port.offer().offered.toolRefs).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
  it("combines the actual invocation abort signal and denies late effects and observations", async () => {
    const f = standaloneNative();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (value: Awaited<ReturnType<WorkspaceToolHost["executeCatalog"]>>) => void;
    let captured: Parameters<WorkspaceToolHost["executeCatalog"]>[0] | undefined;
    vi.spyOn(f.host, "executeCatalog").mockImplementation((request) => {
      captured = request;
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const controller = new AbortController();
    const pending = f.port.execute({ ...f.request, signal: controller.signal });
    await ready;
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.kind === "settled" && cancelled.result).toMatchObject({
      status: "cancelled",
      effectStarted: false,
    });
    expect(captured?.signal.aborted).toBe(true);
    expect(captured?.beforeEffect()).toBe(false);
    if (captured === undefined) throw new TypeError("Expected captured handler call");
    const completedCall = captured;
    expect(() => {
      completedCall.observeExecution({
        toolRef: completedCall.toolRef,
        toolCallId: completedCall.toolCallId,
        durationMs: 0,
        commandExecuted: false,
      });
    }).toThrow("after settlement");
    finish({ toolCallId: "late", output: "late-body", durationMs: 0 });
    expect(f.observed).not.toHaveBeenCalled();
  });
});
