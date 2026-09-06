import { createHash } from "node:crypto";
import { Script } from "node:vm";

import { describe, expect, it, vi } from "vitest";
import type { CodingSafeActivitySignal } from "./codingSafeActivityProjection.js";
import { OPENCODE_PINNED_BUILT_IN_TOOLS } from "./opencodeToolSchemas.js";
import { createGeneratedOpenCodeBundle } from "./opencodeRuntimeAdapter.js";
import { CODING_TOOL_MAX_BODY_BYTES, parseCodingToolRequest } from "./codingToolIpc.js";
import type { ServerLogEvent, ServerLogSink } from "../observability/server-log.js";

const DIGEST = "a".repeat(64);
const SECRET = "SENTINEL_OPENCODE_RUNTIME_SECRET";
const KEIKO_PRODUCER_TOOLS = [
  "keiko_workspace_discover",
  "keiko_workspace_read",
  "keiko_repository_search",
  "keiko_changeset_edit",
  "keiko_verification",
  "keiko_research_fetch",
  "keiko_skill",
  "keiko_child_agent",
  "keiko_git_status",
  "keiko_git_diff",
  "keiko_git_stage",
  "keiko_git_commit",
  "keiko_git_push",
  "keiko_pull_request",
  "keiko_git_execute",
  "keiko_ci_status",
] as const;
const MODEL_VISIBLE_TOOLS = ["question", "todowrite", ...KEIKO_PRODUCER_TOOLS] as const;
const READY_LINE = "opencode server listening on http://127.0.0.1:43123\n";

type ReadinessPhase =
  | "target-attestation"
  | "config-materialization"
  | "endpoint"
  | "authenticated-health"
  | "authenticated-health-version"
  | "unauthenticated-health"
  | "openapi-digest"
  | "gateway-challenge"
  | "tool-facade-challenge"
  | "sse-history-reconciliation"
  | "session-echo";

interface AdapterFailure {
  readonly ok: false;
  readonly phase: ReadinessPhase;
  readonly reason: "readiness-failed";
}

interface AdapterReady {
  readonly ok: true;
  readonly endpoint: string;
  readonly sessionId: string;
  readonly configDigest: string;
}

interface GovernedEvent {
  readonly id: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly digest: string;
  readonly kind:
    | "observation"
    | "permission"
    | "question"
    | "tool"
    | "terminal"
    | "terminal-control"
    | "terminal-failure";
  readonly compaction?:
    | {
        readonly event: "started";
        readonly compactionIdSha256: string;
        readonly auto: boolean;
        readonly overflow: boolean;
        readonly retainedTail: false;
      }
    | {
        readonly event: "tail-retained";
        readonly compactionIdSha256: string;
        readonly auto: boolean;
        readonly overflow: boolean;
        readonly retainedTail: true;
        readonly tailStartIdSha256: string;
      }
    | {
        readonly event: "completed";
        readonly compactionIdSha256: string;
      }
    | {
        readonly event: "failed";
        readonly compactionIdSha256: string;
        readonly errorKind: string;
        readonly finishReason: string;
      }
    | undefined;
}

type OpenCodeSyncHint =
  | { readonly id: string; readonly requiresHistoryIdentity?: true }
  | {
      readonly requiresHistoryIdentity: false;
      readonly control?: {
        readonly sessionId: string;
        readonly state: "activity" | "terminal";
      };
    };

interface OpenCodeRuntimeAdapter {
  readonly start: () => Promise<AdapterReady | AdapterFailure>;
  readonly reconcile: () => Promise<AdapterReady | AdapterFailure>;
  readonly monitor: (onFailure: () => void) => () => void;
  readonly close: () => Promise<void>;
  readonly armTurn: () => boolean;
  readonly cancelTurn: () => void;
  readonly waitForTerminal: (signal: AbortSignal) => Promise<boolean>;
}

interface OpenCodeRuntimeAdapterModule {
  readonly OPEN_CODE_MAX_TURN_WAIT_MS: number;
  readonly createOpenCodeRuntimeAdapter: (
    ports: OpenCodeRuntimeAdapterPorts,
  ) => OpenCodeRuntimeAdapter;
}

interface OpenCodeRuntimeAdapterPorts {
  readonly activityLog?: ServerLogSink;
  readonly correlationId?: string;
  readonly contextGeometry?: {
    readonly contextWindowTokens: number;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
  };
  readonly readiness: {
    readonly verifiedTarget: { readonly executable: string; readonly attestationDigest: string };
    readonly configDigest: string;
    readonly verifyTargetAttestation: () => Promise<boolean>;
    readonly materialize: (bundle: GeneratedOpenCodeBundle) => Promise<boolean>;
    readonly startupLine: () => Promise<string>;
    readonly health: (
      authorization: "basic" | "none",
    ) => Promise<{ readonly status: number; readonly version?: string }>;
    readonly openApiDigest: () => Promise<string>;
    gatewayChallenge: () => Promise<boolean>;
    readonly toolFacadeChallenge: () => Promise<boolean>;
    subscribe: (signal: AbortSignal) => AsyncIterable<OpenCodeSyncHint>;
    history: (
      checkpoints: Readonly<Record<string, number>>,
      signal: AbortSignal,
    ) => Promise<readonly GovernedEvent[]>;
    takeSafeActivity?: (identityKey: string) => CodingSafeActivitySignal | undefined;
    clearSafeActivity?: () => void;
    readonly sessionEcho: () => Promise<string>;
  };
  readonly governedSink: {
    readonly execute: (
      identityKey: string,
      event: GovernedEvent,
    ) => Promise<"applied" | "duplicate">;
  };
  safeActivitySink?: {
    readonly ingest: (signal: CodingSafeActivitySignal) => boolean;
    readonly recordDrops: (count: number) => void;
  };
  readonly control: {
    status: () => Promise<"activity" | "terminal" | undefined>;
  };
  readonly safety: {
    readonly revokeAudiences: () => void;
    readonly abortGovernedActions: () => void;
    readonly wipeEphemeralState: () => void;
    readonly requireManagerReap: () => void;
  };
}

interface GeneratedOpenCodeBundle {
  readonly config: {
    readonly snapshot: boolean;
    readonly model: string;
    readonly agent: Readonly<Record<string, { readonly prompt: string }>>;
    readonly provider: Readonly<Record<string, unknown>>;
    readonly compaction: Readonly<Record<string, boolean | number>>;
    readonly tool_output: { readonly max_bytes: number };
    readonly tools: Readonly<Record<string, boolean>>;
    readonly permission: Readonly<Record<string, string>>;
  };
  readonly toolSources: Readonly<Record<string, string>>;
}

describe("generated OpenCode bundle", () => {
  it("uses the governed response ceiling for native custom-tool output", () => {
    const bundle = createGeneratedOpenCodeBundle();
    expect(bundle.config.tool_output).toEqual({ max_bytes: CODING_TOOL_MAX_BODY_BYTES });
    expect(bundle.toolSources.keiko_verification).toContain(
      `const MAX_RESPONSE_BYTES = ${String(CODING_TOOL_MAX_BODY_BYTES)};`,
    );
  });
});

async function adapterModule(): Promise<OpenCodeRuntimeAdapterModule> {
  return await import("./opencodeRuntimeAdapter.js");
}

function event(sequence: number, kind: GovernedEvent["kind"] = "observation"): GovernedEvent {
  return {
    id: `evt_${String(sequence)}`,
    aggregateId: "ses_1",
    sequence,
    digest: createHash("sha256").update(String(sequence)).digest("hex"),
    kind,
  };
}

function eventFor(
  aggregateId: string,
  sequence: number,
  kind: GovernedEvent["kind"],
): GovernedEvent {
  return {
    id: `evt_${aggregateId}_${String(sequence)}`,
    aggregateId,
    sequence,
    digest: createHash("sha256")
      .update(`${aggregateId}:${String(sequence)}`)
      .digest("hex"),
    kind,
  };
}

async function* hints(
  values: readonly OpenCodeSyncHint[],
  signal: AbortSignal,
): AsyncIterable<OpenCodeSyncHint> {
  for (const value of values) yield value;
  if (values.length === 0) return;
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

async function* finiteHints(values: readonly OpenCodeSyncHint[]): AsyncIterable<OpenCodeSyncHint> {
  await Promise.resolve();
  for (const value of values) yield value;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function readinessPorts(failAt?: ReadinessPhase): {
  readonly ports: OpenCodeRuntimeAdapterPorts;
  readonly effects: string[];
  readonly materialized: GeneratedOpenCodeBundle[];
} {
  const effects: string[] = [];
  const materialized: GeneratedOpenCodeBundle[] = [];
  const failed = (phase: ReadinessPhase): boolean => failAt !== phase;
  return {
    ports: {
      contextGeometry: {
        contextWindowTokens: 32_768,
        maxInputTokens: 28_672,
        maxOutputTokens: 4_096,
      },
      readiness: {
        verifiedTarget: { executable: "/verified/opencode", attestationDigest: DIGEST },
        configDigest: DIGEST,
        verifyTargetAttestation: (): Promise<boolean> =>
          Promise.resolve(failed("target-attestation")),
        materialize: (bundle: GeneratedOpenCodeBundle): Promise<boolean> => {
          materialized.push(bundle);
          return Promise.resolve(failed("config-materialization"));
        },
        startupLine: (): Promise<string> =>
          Promise.resolve(failed("endpoint") ? READY_LINE : "untrusted endpoint\n"),
        health: (
          authorization: "basic" | "none",
        ): Promise<{ readonly status: number; readonly version?: string }> => {
          if (authorization === "basic") {
            if (!failed("authenticated-health")) return Promise.resolve({ status: 500 });
            return Promise.resolve(
              failed("authenticated-health-version")
                ? { status: 200, version: "1.17.17" }
                : { status: 200, version: "wrong-version" },
            );
          }
          return Promise.resolve({ status: failed("unauthenticated-health") ? 401 : 200 });
        },
        openApiDigest: (): Promise<string> =>
          Promise.resolve(failed("openapi-digest") ? DIGEST : "b".repeat(64)),
        gatewayChallenge: (): Promise<boolean> => Promise.resolve(failed("gateway-challenge")),
        toolFacadeChallenge: (): Promise<boolean> =>
          Promise.resolve(failed("tool-facade-challenge")),
        subscribe: (signal): AsyncIterable<OpenCodeSyncHint> =>
          hints(failed("sse-history-reconciliation") ? [{ id: "evt_0" }] : [], signal),
        history: (): Promise<readonly GovernedEvent[]> =>
          Promise.resolve(failed("sse-history-reconciliation") ? [event(0, "terminal")] : []),
        sessionEcho: (): Promise<string> =>
          Promise.resolve(failed("session-echo") ? "ses_1" : "other"),
      },
      governedSink: {
        execute: (_identityKey, value): Promise<"applied"> => {
          effects.push(value.id);
          return Promise.resolve("applied");
        },
      },
      control: { status: (): Promise<undefined> => Promise.resolve(undefined) },
      safety: {
        revokeAudiences: () => effects.push("revoke-audiences"),
        abortGovernedActions: () => effects.push("abort-governed-actions"),
        wipeEphemeralState: () => effects.push("wipe-ephemeral-state"),
        requireManagerReap: () => effects.push("require-manager-reap"),
      },
    },
    effects,
    materialized,
  };
}

describe("OpenCode runtime adapter readiness", () => {
  it("records the entered phase while the real readiness operation is still pending", async () => {
    const harness = readinessPorts();
    const events: ServerLogEvent[] = [];
    let resolvePending: ((result: IteratorResult<OpenCodeSyncHint>) => void) | undefined;
    const pending = new Promise<IteratorResult<OpenCodeSyncHint>>((resolve) => {
      resolvePending = resolve;
    });
    const next = vi.fn((): Promise<IteratorResult<OpenCodeSyncHint>> => pending);
    harness.ports.readiness.subscribe = (): AsyncIterable<OpenCodeSyncHint> => ({
      [Symbol.asyncIterator]: (): AsyncIterator<OpenCodeSyncHint> => ({ next }),
    });
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter({
      ...harness.ports,
      correlationId: "run-pending-handshake",
      activityLog: {
        write: (entry): void => {
          events.push(entry);
        },
      },
    });
    const starting = adapter.start();
    try {
      await vi.waitFor(() => {
        expect(next).toHaveBeenCalledOnce();
      });
      expect(events.at(-1)).toMatchObject({
        op: "coding-runtime.readiness.phase",
        correlationId: "run-pending-handshake",
        extra: { phase: "sse-history-reconciliation" },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          op: "coding-runtime.readiness.phase",
          correlationId: "run-pending-handshake",
          extra: {
            phase: "config-materialization",
            dependencyInstallPolicy: "offline",
            contextWindowTokens: 32_768,
            maxInputTokens: 28_672,
            maxOutputTokens: 4_096,
            compactionAuto: true,
            compactionPrune: true,
          },
        }),
      );
      expect(JSON.stringify(events)).not.toContain(SECRET);
    } finally {
      resolvePending?.({ done: true, value: undefined });
      await starting;
      await adapter.close();
    }
  });

  it("records the failing readiness phase and body-free cause before cleanup", async () => {
    const harness = readinessPorts();
    const events: ServerLogEvent[] = [];
    harness.ports.readiness.subscribe = (): AsyncIterable<OpenCodeSyncHint> => ({
      [Symbol.asyncIterator]: (): AsyncIterator<OpenCodeSyncHint> => ({
        next: (): Promise<IteratorResult<OpenCodeSyncHint>> =>
          Promise.reject(new TypeError(SECRET)),
      }),
    });
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter({
      ...harness.ports,
      correlationId: "run-handshake-1",
      activityLog: {
        write: (entry): void => {
          events.push(entry);
        },
      },
    });
    await expect(adapter.start()).resolves.toMatchObject({
      ok: false,
      phase: "sse-history-reconciliation",
    });
    const failures = events.filter((event) => event.op === "coding-runtime.readiness.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      op: "coding-runtime.readiness.failed",
      correlationId: "run-handshake-1",
      errorKind: "internal",
      extra: {
        phase: "sse-history-reconciliation",
        errorClass: "TypeError",
      },
    });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(harness.effects).toContain("require-manager-reap");
  });

  it("bounds a turn at thirty minutes while allowing caller cancellation to shorten it", async () => {
    expect((await adapterModule()).OPEN_CODE_MAX_TURN_WAIT_MS).toBe(30 * 60_000);
  });

  it("orders attested readiness through history before exposing a fixed session", async () => {
    const harness = readinessPorts();
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toEqual({
      ok: true,
      endpoint: "http://127.0.0.1:43123",
      sessionId: "ses_1",
      configDigest: DIGEST,
    });
    expect(harness.effects).toEqual(["evt_0"]);
    expect(harness.materialized).toHaveLength(1);
    const bundle = harness.materialized[0];
    if (bundle === undefined) throw new Error("expected generated config bundle");
    expect(bundle.config.snapshot).toBe(false);
    expect(bundle.config.model).toBe("keiko-runtime/coding");
    expect(Object.keys(bundle.config.agent)).toEqual(["build", "compaction"]);
    expect(bundle.config.agent.build?.prompt).toContain("keiko_workspace_read");
    expect(bundle.config.agent.build?.prompt).toContain("must never be called");
    expect(bundle.config.agent.compaction?.prompt).toContain("acceptance criteria");
    const provider = record(bundle.config.provider["keiko-runtime"]);
    const options = record(provider.options);
    const headers = record(options.headers);
    expect(typeof provider.npm).toBe("string");
    expect(provider.name).toBe("Keiko Governed Coding Gateway");
    expect(provider.env).toEqual([]);
    expect(Object.keys(record(provider.models))).toEqual(["coding"]);
    expect(record(record(provider.models).coding)).toEqual({
      name: "Keiko Governed Coding",
      tool_call: true,
      limit: { context: 32_768, input: 28_672, output: 4_096 },
      cost: { input: 0, output: 0 },
    });
    expect(bundle.config.compaction).toMatchObject({ auto: true, prune: true, tail_turns: 2 });
    expect(options.baseURL).toBe("{env:KEIKO_MODEL_GATEWAY_URL}");
    expect(options.chunkTimeout).toBe(30 * 60_000);
    expect(Object.keys(options)).toEqual(["baseURL", "chunkTimeout", "headers"]);
    expect(headers.Authorization).toBe("Bearer {env:KEIKO_MODEL_GATEWAY_CAPABILITY}");
    expect(bundle.config.tools).toMatchObject({
      question: true,
      todowrite: true,
      keiko_workspace_read: true,
      keiko_changeset_edit: true,
      bash: false,
      edit: false,
      git: false,
    });
    expect(
      Object.entries(bundle.config.tools)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
        .sort(),
    ).toEqual([...MODEL_VISIBLE_TOOLS].sort());
    expect(bundle.config.permission).toMatchObject({
      "*": "deny",
      keiko_governed_action: "ask",
      question: "allow",
      todowrite: "allow",
      keiko_workspace_read: "allow",
      keiko_changeset_edit: "allow",
    });
    for (const tool of OPENCODE_PINNED_BUILT_IN_TOOLS) {
      expect(bundle.config.permission[tool]).toBe("deny");
    }
    expect(Object.keys(bundle.toolSources).sort()).toEqual([...KEIKO_PRODUCER_TOOLS].sort());
    expect(JSON.stringify(bundle.toolSources)).not.toMatch(/\b(?:import|require)\b/u);
    expect(JSON.stringify(bundle.toolSources)).not.toContain(SECRET);
    const approvalWaitTools = new Set([
      "keiko_git_stage",
      "keiko_git_commit",
      "keiko_git_push",
      "keiko_pull_request",
    ]);
    for (const [name, source] of Object.entries(bundle.toolSources)) {
      expect(source).toContain(
        approvalWaitTools.has(name)
          ? "const TIMEOUT_MS = 305000;"
          : "const TIMEOUT_MS = 35000;",
      );
      expect(source).toContain('redirect: "manual"');
      expect(source).toContain("signal:");
      expect(source).toMatch(/timeout|AbortController/u);
      expect(source).toMatch(/TextDecoder|utf-8/u);
      expect(source).toContain("askForGovernedPermission");
    }
    expect(bundle.toolSources.keiko_changeset_edit).toContain("context.ask");
    expect(bundle.toolSources.keiko_changeset_edit).toContain(
      "const mode = process.env.KEIKO_CODING_MODE;",
    );
    expect(bundle.toolSources.keiko_changeset_edit).toContain(
      'if (mode === "governed-assist" && action === "edit") request = editPermission(args);',
    );
    const verificationSource = bundle.toolSources.keiko_verification;
    if (verificationSource === undefined) throw new TypeError("verification source missing");
    expect(verificationSource).toContain('actionClass: "command-execution"');
    expect(verificationSource).toContain('crypto.subtle.digest("SHA-256"');
    expect(verificationSource).toContain("includes(request.action)");
    expect(verificationSource).toContain("actionId: request.actionId");
    expect(verificationSource).toContain(
      "request.approvalProof = { approvalId: approvalProof.approvalId",
    );
    expect(verificationSource.indexOf("await askForGovernedPermission")).toBeLessThan(
      verificationSource.indexOf("fetch(endpoint"),
    );
    // #2473 large-file read window: the child-side source forwards the optional window arguments
    // and validates the transient pagination facts the bridge returns.
    expect(bundle.toolSources.keiko_workspace_read).toContain('"startLine"');
    expect(bundle.toolSources.keiko_workspace_read).toContain('"maxLines"');
    expect(bundle.toolSources.keiko_workspace_read).toContain("totalLines");
    expect(bundle.toolSources.keiko_workspace_read).toContain("nextStartLine");
    expect(Object.values(bundle.toolSources).join("\n")).toMatch(/changeset/u);
    // #3386/#3387/#3388: each propose-phase Git/delivery tool posts its fixed wire action/intent
    // literal, never a model-supplied one; the model never commits, pushes or opens a pull
    // request directly, it only proposes.
    expect(bundle.toolSources.keiko_git_status).toContain('const wireAction = "git";');
    expect(bundle.toolSources.keiko_git_status).toContain('"operation":"status"');
    expect(bundle.toolSources.keiko_git_diff).toContain('"operation":"diff"');
    expect(bundle.toolSources.keiko_git_stage).toContain('"operation":"stage","phase":"propose"');
    expect(bundle.toolSources.keiko_git_commit).toContain('const wireAction = "delivery";');
    expect(bundle.toolSources.keiko_git_commit).toContain('"intent":"commit","phase":"propose"');
    expect(bundle.toolSources.keiko_git_push).toContain('"intent":"push","phase":"propose"');
    expect(bundle.toolSources.keiko_pull_request).toContain(
      '"intent":"pull-request","phase":"propose"',
    );
    expect(bundle.toolSources.keiko_ci_status).toContain('"operation":"ci"');
    const deliverySources = [
      bundle.toolSources.keiko_git_stage,
      bundle.toolSources.keiko_git_commit,
      bundle.toolSources.keiko_git_push,
      bundle.toolSources.keiko_pull_request,
      bundle.toolSources.keiko_git_execute,
    ].join("\n");
    expect(deliverySources).not.toContain("A human must approve");
    expect(deliverySources).toContain("status is ready");
    expect(deliverySources).toContain("status is approval-required");
    expect(deliverySources).toContain("A denied proposal authorizes no effect");
    // keiko_git_execute is the one tool whose wire action/operation/intent is computed from the
    // model-supplied `kind` at call time, never a fixed literal.
    const execute = bundle.toolSources.keiko_git_execute;
    if (execute === undefined) throw new TypeError("keiko_git_execute source missing");
    expect(execute).toContain('args.kind === "stage" ? "git" : "delivery"');
    expect(execute).toContain("delete request.kind;");
    expect(JSON.stringify(harness.materialized)).toContain("{env:");
    expect(
      JSON.stringify({ result: await adapter.reconcile(), effects: harness.effects }),
    ).not.toContain(SECRET);
  });

  it.each([
    "target-attestation",
    "config-materialization",
    "endpoint",
    "authenticated-health",
    "authenticated-health-version",
    "unauthenticated-health",
    "openapi-digest",
    "gateway-challenge",
    "tool-facade-challenge",
    "sse-history-reconciliation",
    "session-echo",
  ] as const)("fails closed at %s without signalling a process", async (phase) => {
    const harness = readinessPorts(phase);
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toEqual({
      ok: false,
      phase,
      reason: "readiness-failed",
    });
    expect(harness.effects).toEqual([
      ...((["gateway-challenge", "tool-facade-challenge"] as readonly ReadinessPhase[]).includes(
        phase,
      )
        ? ["evt_0"]
        : []),
      "revoke-audiences",
      "abort-governed-actions",
      "wipe-ephemeral-state",
      "require-manager-reap",
    ]);
  });

  it("keeps readiness closed until pending history covers a live identity", async () => {
    const harness = readinessPorts();
    let releaseHistory: ((events: readonly GovernedEvent[]) => void) | undefined;
    let historyCalls = 0;
    harness.ports.readiness.subscribe = (signal): AsyncIterable<OpenCodeSyncHint> =>
      hints([{ id: "evt_0" }], signal);
    harness.ports.readiness.history = (): Promise<readonly GovernedEvent[]> => {
      historyCalls += 1;
      if (historyCalls > 1) return Promise.resolve([]);
      return new Promise((resolve) => {
        releaseHistory = resolve;
      });
    };
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    let settled = false;
    const starting = adapter.start().finally(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(releaseHistory).toBeTypeOf("function");
    });

    expect(settled).toBe(false);
    releaseHistory?.([event(0, "terminal")]);
    await expect(starting).resolves.toMatchObject({ ok: true, sessionId: "ses_1" });
  });

  it("syncs once for an ephemeral server hint without requiring its identity in history", async () => {
    const harness = readinessPorts();
    const historyCheckpoints: Readonly<Record<string, number>>[] = [];
    harness.ports.readiness.subscribe = (signal): AsyncIterable<OpenCodeSyncHint> =>
      hints([{ requiresHistoryIdentity: false }], signal);
    harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> => {
      historyCheckpoints.push(checkpoints);
      return Promise.resolve([event(0, "terminal")]);
    };
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true, sessionId: "ses_1" });
    expect(historyCheckpoints).toEqual([{}, { ses_1: 0 }]);
    expect(harness.effects).toEqual(["evt_0"]);
  });

  it("rate-limits a 1,000-event observation burst while never dropping critical projections", async () => {
    const burst = Array.from({ length: 1_000 }, (_, index) =>
      event(
        index,
        index === 100
          ? "permission"
          : index === 300
            ? "question"
            : index === 500
              ? "tool"
              : index === 700
                ? "terminal"
                : "observation",
      ),
    );
    const historyPages = [
      burst.slice(0, 256),
      burst.slice(250, 506),
      burst.slice(500, 756),
      burst.slice(750, 1_000),
    ] as const;
    let historyPage = 0;
    const historyCheckpoints: (Readonly<Record<string, number>> | undefined)[] = [];
    const harness = readinessPorts();
    harness.ports.readiness.history = (
      checkpoints?: Readonly<Record<string, number>>,
    ): Promise<readonly GovernedEvent[]> => {
      historyCheckpoints.push(checkpoints);
      const page = historyPages[historyPage] ?? [];
      historyPage += 1;
      return Promise.resolve(page);
    };
    harness.ports.readiness.subscribe = (signal): AsyncIterable<OpenCodeSyncHint> =>
      hints([{ id: "evt_0" }, { id: "evt_700" }, { id: "evt_999" }], signal);
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    await expect(adapter.reconcile()).resolves.toMatchObject({ ok: true });
    await expect(adapter.reconcile()).resolves.toMatchObject({ ok: true });
    await expect(adapter.reconcile()).resolves.toMatchObject({ ok: true });
    expect(historyPages.every((page) => page.length <= 256)).toBe(true);
    expect(harness.effects.length).toBeLessThanOrEqual(44);
    expect(harness.effects).toEqual(
      expect.arrayContaining(["evt_100", "evt_300", "evt_500", "evt_700"]),
    );
    expect(new Set(harness.effects).size).toBe(harness.effects.length);
    // #2254: SSE only indicates that history may have advanced. Every reconnect must resume
    // from the reconciler's last committed checkpoint, never from an implicit empty cursor.
    expect(historyCheckpoints).toEqual([
      {},
      { ses_1: 255 },
      { ses_1: 505 },
      { ses_1: 755 },
      { ses_1: 999 },
    ]);
  });

  it("bounds aggregate checkpoint copies across paged churn while preserving fixed-session terminal authority", async () => {
    let aggregate = 0;
    const churnPages = [64, 64, 64, 63].map((length) =>
      Array.from({ length }, () => {
        const result = eventFor(`ses_churn_${String(aggregate)}`, 0, "observation");
        aggregate += 1;
        return result;
      }),
    );
    const recent = churnPages.at(-1)?.at(-1);
    if (recent === undefined) throw new Error("missing churn fixture");
    const setupPages: readonly (readonly GovernedEvent[])[] = [
      [event(0, "terminal")],
      [],
      ...churnPages,
      [recent],
      [event(1, "observation"), event(2, "terminal")],
    ];
    const returnedPages: (readonly GovernedEvent[])[] = [];
    const historyCheckpoints: Readonly<Record<string, number>>[] = [];
    let page = 0;
    const harness = readinessPorts();
    harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> => {
      historyCheckpoints.push({ ...checkpoints });
      const result = setupPages[page] ?? [
        eventFor(`ses_overflow_${String(page - setupPages.length)}`, 0, "observation"),
      ];
      page += 1;
      returnedPages.push(result);
      return Promise.resolve(result);
    };
    harness.ports.control.status = (): Promise<"terminal"> => Promise.resolve("terminal");
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true, sessionId: "ses_1" });
    for (const pageEvents of churnPages) {
      expect(pageEvents.length).toBeGreaterThan(0);
      await expect(adapter.reconcile()).resolves.toMatchObject({ ok: true });
    }
    const effectsBeforeDuplicate = harness.effects.length;
    await expect(adapter.reconcile()).resolves.toMatchObject({ ok: true });
    expect(harness.effects).toHaveLength(effectsBeforeDuplicate);

    expect(adapter.armTurn()).toBe(true);
    await expect(adapter.waitForTerminal(new AbortController().signal)).resolves.toBe(true);
    const terminalResume = historyCheckpoints.at(-1);
    expect(terminalResume).toBeDefined();
    expect(Object.keys(terminalResume ?? {})).toHaveLength(256);
    expect(terminalResume?.ses_1).toBe(0);

    const effectsBeforeOverflow = harness.effects.length;
    const overflowHistoryStart = historyCheckpoints.length;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      await expect(adapter.reconcile()).resolves.toEqual({
        ok: false,
        phase: "sse-history-reconciliation",
        reason: "readiness-failed",
      });
    }
    expect(harness.effects).toHaveLength(effectsBeforeOverflow + 4);
    expect(returnedPages.every((events) => events.length <= 1_024)).toBe(true);
    expect(
      returnedPages.every(
        (events) => Buffer.byteLength(JSON.stringify(events), "utf8") <= 1024 * 1024,
      ),
    ).toBe(true);
    expect(historyCheckpoints.every((checkpoints) => Object.keys(checkpoints).length <= 256)).toBe(
      true,
    );
    const overflowSnapshots = historyCheckpoints.slice(overflowHistoryStart);
    expect(overflowSnapshots).toHaveLength(1_000);
    expect(overflowSnapshots.every((checkpoints) => checkpoints.ses_1 === 2)).toBe(true);
    expect(overflowSnapshots.every((checkpoints) => Object.keys(checkpoints).length === 256)).toBe(
      true,
    );
    await adapter.close();
  });

  it("delivers every freshly admitted safe mutation even when observation projection is throttled", async () => {
    const harness = readinessPorts();
    const signals = new Map<string, CodingSafeActivitySignal>([
      [
        "ses_1\u00000",
        {
          kind: "message",
          messageId: "msg_user",
          role: "user",
          occurredAt: "2026-07-18T17:00:00.000Z",
        },
      ],
      [
        "ses_1\u00001",
        {
          kind: "text",
          messageId: "msg_user",
          text: "Visible",
          occurredAt: "2026-07-18T17:00:00.001Z",
        },
      ],
      [
        "ses_1\u00002",
        {
          kind: "message",
          messageId: "msg_assistant",
          role: "assistant",
          parentMessageId: "msg_user",
          occurredAt: "2026-07-18T17:00:00.002Z",
        },
      ],
    ]);
    harness.ports.readiness.history = (): Promise<readonly GovernedEvent[]> =>
      Promise.resolve([event(0), event(1), event(2)]);
    harness.ports.readiness.takeSafeActivity = (
      identityKey,
    ): CodingSafeActivitySignal | undefined => {
      const signal = signals.get(identityKey);
      signals.delete(identityKey);
      return signal;
    };
    const ingested: CodingSafeActivitySignal[] = [];
    harness.ports.safeActivitySink = {
      ingest: (signal): boolean => {
        ingested.push(signal);
        return true;
      },
      recordDrops: vi.fn(),
    };
    harness.ports.readiness.clearSafeActivity = vi.fn(() => {
      signals.clear();
    });
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(harness.effects.filter((value) => value.startsWith("evt_"))).toEqual(["evt_0"]);
    expect(ingested.map(({ kind }) => kind)).toEqual(["message", "text", "message"]);
    expect(harness.ports.readiness.clearSafeActivity).toHaveBeenCalledTimes(2);
    await expect(adapter.reconcile()).resolves.toMatchObject({ ok: true });
    expect(harness.ports.readiness.clearSafeActivity).toHaveBeenCalledTimes(3);
    await adapter.close();
  });

  it("does not double-count a safe-activity rejection already recorded by the projection", async () => {
    const harness = readinessPorts();
    const signal: CodingSafeActivitySignal = {
      kind: "text",
      messageId: "msg_missing",
      text: "Visible",
      occurredAt: "2026-07-18T17:00:00.001Z",
    };
    harness.ports.readiness.history = (): Promise<readonly GovernedEvent[]> =>
      Promise.resolve([event(0)]);
    harness.ports.readiness.takeSafeActivity = (): CodingSafeActivitySignal => signal;
    const recordDrops = vi.fn();
    harness.ports.safeActivitySink = {
      ingest: vi.fn(() => false),
      recordDrops,
    };
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(harness.ports.safeActivitySink.ingest).toHaveBeenCalledOnce();
    expect(recordDrops).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("records committed native compaction lifecycle projections once with run correlation", async () => {
    const harness = readinessPorts();
    const log: ServerLogEvent[] = [];
    const compactionIdSha256 = "b".repeat(64);
    const failedCompactionIdSha256 = "d".repeat(64);
    const tailStartIdSha256 = "c".repeat(64);
    const lifecycle: readonly GovernedEvent[] = [
      {
        ...event(1),
        compaction: {
          event: "started",
          compactionIdSha256,
          auto: true,
          overflow: true,
          retainedTail: false,
        },
      },
      {
        ...event(2),
        compaction: { event: "completed", compactionIdSha256 },
      },
      {
        ...event(3),
        compaction: {
          event: "tail-retained",
          compactionIdSha256,
          tailStartIdSha256,
          auto: true,
          overflow: true,
          retainedTail: true,
        },
      },
      {
        ...event(4),
        compaction: {
          event: "started",
          compactionIdSha256: failedCompactionIdSha256,
          auto: true,
          overflow: false,
          retainedTail: false,
        },
      },
      {
        ...event(5),
        kind: "terminal-failure",
        compaction: {
          event: "failed",
          compactionIdSha256: failedCompactionIdSha256,
          errorKind: "ContextOverflowError",
          finishReason: "error",
        },
      },
    ];
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter({
      ...harness.ports,
      correlationId: "run-native-compaction",
      activityLog: {
        write: (event): void => {
          log.push(event);
        },
      },
    });

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    harness.ports.readiness.history = (): Promise<readonly GovernedEvent[]> =>
      Promise.resolve(lifecycle);
    await expect(adapter.reconcile()).resolves.toMatchObject({ ok: true });
    await expect(adapter.reconcile()).resolves.toMatchObject({ ok: true });

    expect(log.filter(({ op }) => op === "coding-runtime.compaction")).toEqual([
      expect.objectContaining({
        correlationId: "run-native-compaction",
        extra: {
          event: "started",
          compactionIdSha256,
          auto: true,
          overflow: true,
          retainedTail: false,
        },
      }),
      expect.objectContaining({
        correlationId: "run-native-compaction",
        extra: { event: "completed", compactionIdSha256 },
      }),
      expect.objectContaining({
        correlationId: "run-native-compaction",
        extra: {
          event: "tail-retained",
          compactionIdSha256,
          tailStartIdSha256,
          auto: true,
          overflow: true,
          retainedTail: true,
        },
      }),
      expect.objectContaining({
        correlationId: "run-native-compaction",
        extra: {
          event: "started",
          compactionIdSha256: failedCompactionIdSha256,
          auto: true,
          overflow: false,
          retainedTail: false,
        },
      }),
      expect.objectContaining({
        level: "error",
        correlationId: "run-native-compaction",
        errorKind: "ContextOverflowError",
        extra: {
          event: "failed",
          compactionIdSha256: failedCompactionIdSha256,
          finishReason: "error",
        },
      }),
    ]);
    expect(JSON.stringify(log)).not.toMatch(/msg_|provider body/u);
    await adapter.close();
  });

  it("fails closed when a critical-only reconciliation page exceeds bounded staging", async () => {
    const harness = readinessPorts();
    harness.ports.readiness.history = (): Promise<readonly GovernedEvent[]> =>
      Promise.resolve(Array.from({ length: 257 }, (_, index) => event(index, "permission")));
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toEqual({
      ok: false,
      phase: "sse-history-reconciliation",
      reason: "readiness-failed",
    });
    expect(harness.effects.filter((value) => value.startsWith("evt_"))).toEqual([]);
  });

  it("does not repeat an already prepared governed effect after a later effect fails and retry runs", async () => {
    const harness = readinessPorts();
    let failSecond = true;
    let historyCalls = 0;
    harness.ports.readiness.history = (): Promise<readonly GovernedEvent[]> => {
      historyCalls += 1;
      return Promise.resolve([event(0, "permission"), event(1, "tool")]);
    };
    const applied = new Set<string>();
    const sink = harness.ports.governedSink as {
      execute: (identityKey: string, value: GovernedEvent) => Promise<"applied" | "duplicate">;
    };
    sink.execute = (identityKey, value): Promise<"applied" | "duplicate"> => {
      if (value.id === "evt_1" && failSecond) {
        failSecond = false;
        return Promise.reject(new Error("sink-failed"));
      }
      if (applied.has(identityKey)) return Promise.resolve("duplicate");
      applied.add(identityKey);
      harness.effects.push(value.id);
      return Promise.resolve("applied");
    };
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: false });
    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(historyCalls).toBeGreaterThanOrEqual(2);
    expect(harness.effects.filter((value) => value === "evt_0")).toHaveLength(1);
  });

  it("reconnects a failed live stream three times and reports one terminal monitor failure", async () => {
    const harness = readinessPorts();
    let subscriptions = 0;
    harness.ports.readiness.subscribe = (_signal): AsyncIterable<OpenCodeSyncHint> => {
      subscriptions += 1;
      return subscriptions === 1 ? finiteHints([{ id: "evt_0" }]) : finiteHints([]);
    };
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);
    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    const failures: string[] = [];
    const dispose = adapter.monitor(() => failures.push("failed"));

    await vi.waitFor(() => {
      expect(subscriptions).toBe(4);
      expect(failures).toEqual(["failed"]);
    });
    dispose();
    await adapter.close();
  });

  it("resets the reconnect budget after each successful live reconciliation", async () => {
    const harness = readinessPorts();
    let subscriptions = 0;
    harness.ports.readiness.subscribe = (signal): AsyncIterable<OpenCodeSyncHint> => {
      subscriptions += 1;
      if (subscriptions === 1) return finiteHints([{ id: "evt_0" }]);
      if (subscriptions <= 4) return finiteHints([{ requiresHistoryIdentity: false }]);
      return hints([{ requiresHistoryIdentity: false }], signal);
    };
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);
    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    const failures: string[] = [];
    const dispose = adapter.monitor(() => failures.push("failed"));

    await vi.waitFor(() => {
      expect(subscriptions).toBe(5);
    });
    expect(failures).toEqual([]);
    dispose();
    await adapter.close();
  });

  it("arms before live activity and accepts terminal only after matching-session activity", async () => {
    const harness = readinessPorts();
    let postArmHistory = false;
    harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> =>
      Promise.resolve(
        checkpoints.ses_1 === undefined
          ? [event(0, "terminal")]
          : postArmHistory && checkpoints.ses_1 === 0
            ? [event(1, "observation"), event(2, "terminal")]
            : [],
      );
    let subscriptions = 0;
    harness.ports.readiness.subscribe = (signal): AsyncIterable<OpenCodeSyncHint> => {
      subscriptions += 1;
      return subscriptions === 1
        ? finiteHints([
            { requiresHistoryIdentity: false },
            {
              requiresHistoryIdentity: false,
              control: { sessionId: "ses_other", state: "terminal" },
            },
            {
              requiresHistoryIdentity: false,
              control: { sessionId: "ses_1", state: "activity" },
            },
            {
              requiresHistoryIdentity: false,
              control: { sessionId: "ses_1", state: "terminal" },
            },
          ])
        : hints([{ requiresHistoryIdentity: false }], signal);
    };
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);
    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    postArmHistory = true;
    expect(adapter.armTurn()).toBe(true);
    const dispose = adapter.monitor(() => undefined);
    await expect(adapter.waitForTerminal(new AbortController().signal)).resolves.toBe(true);
    dispose();
    await adapter.close();
  });

  it("reconciles the readiness challenge terminal before exposing ready", async () => {
    const harness = readinessPorts();
    let challenged = false;
    harness.ports.readiness.gatewayChallenge = (): Promise<boolean> => {
      challenged = true;
      return Promise.resolve(true);
    };
    harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> =>
      Promise.resolve(
        checkpoints.ses_1 === undefined
          ? [event(0)]
          : challenged && checkpoints.ses_1 === 0
            ? [event(1, "terminal")]
            : [],
      );
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(harness.effects).toEqual(["evt_0", "evt_1"]);
    await adapter.close();
  });

  it("accepts causally ordered post-arm evidence and terminal history when live status was missed", async () => {
    const harness = readinessPorts();
    harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> =>
      Promise.resolve(
        checkpoints.ses_1 === undefined
          ? [event(0)]
          : checkpoints.ses_1 === 0
            ? [event(1, "terminal")]
            : checkpoints.ses_1 === 1
              ? [event(2, "observation")]
              : checkpoints.ses_1 === 2
                ? [event(3, "terminal"), event(4, "observation")]
                : [],
      );
    harness.ports.control.status = (): Promise<"terminal"> => Promise.resolve("terminal");
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(adapter.armTurn()).toBe(true);
    await expect(adapter.waitForTerminal(AbortSignal.timeout(750))).resolves.toBe(true);
    await adapter.close();
  });

  it("returns failure for a causally ordered failed assistant completion", async () => {
    const harness = readinessPorts();
    let postArmHistory = false;
    harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> =>
      Promise.resolve(
        checkpoints.ses_1 === undefined
          ? [event(0, "terminal")]
          : postArmHistory && checkpoints.ses_1 === 0
            ? [event(1, "observation"), event(2, "terminal-failure")]
            : [],
      );
    harness.ports.control.status = (): Promise<"terminal"> => Promise.resolve("terminal");
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    postArmHistory = true;
    expect(adapter.armTurn()).toBe(true);
    await expect(adapter.waitForTerminal(AbortSignal.timeout(750))).resolves.toBe(false);
    await adapter.close();
  });

  it("keeps history reconciliation live across terminal-control and terminal-failure events (#2644)", async () => {
    const harness = readinessPorts();
    let postReady = false;
    harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> =>
      Promise.resolve(
        checkpoints.ses_1 === undefined
          ? [event(0, "terminal")]
          : postReady && checkpoints.ses_1 === 0
            ? [event(1, "terminal-control"), event(2, "terminal-failure"), event(3, "observation")]
            : [],
      );
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    postReady = true;
    // The classifier emits session.idle as terminal-control and a non-stop assistant completion
    // as terminal-failure; both must reconcile as history, not collapse the whole plan.
    await expect(adapter.reconcile()).resolves.toMatchObject({ ok: true });
    expect(harness.effects).toEqual(expect.arrayContaining(["evt_1", "evt_2", "evt_3"]));
    await adapter.close();
  });

  it("waits for terminal status after fresh post-arm completion arrives while status is busy", async () => {
    vi.useFakeTimers();
    try {
      const harness = readinessPorts();
      let postArmHistory = false;
      harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> =>
        Promise.resolve(
          checkpoints.ses_1 === undefined
            ? [event(0)]
            : postArmHistory && checkpoints.ses_1 === 0
              ? [event(1, "observation")]
              : checkpoints.ses_1 === 1
                ? [event(2, "terminal")]
                : [],
        );
      let statusCalls = 0;
      harness.ports.control.status = (): Promise<"activity" | "terminal"> => {
        statusCalls += 1;
        return Promise.resolve(statusCalls === 1 ? "activity" : "terminal");
      };
      const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

      await expect(adapter.start()).resolves.toMatchObject({ ok: true });
      postArmHistory = true;
      expect(adapter.armTurn()).toBe(true);
      await expect(adapter.reconcile()).resolves.toMatchObject({ ok: true });
      let settled: boolean | undefined;
      const waiting = adapter.waitForTerminal(new AbortController().signal).then((result) => {
        settled = result;
        return result;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(statusCalls).toBe(1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
      await expect(waiting).resolves.toBe(true);
      expect(statusCalls).toBe(2);
      await adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a pre-task terminal status when activity follows before durable completion", async () => {
    vi.useFakeTimers();
    try {
      const harness = readinessPorts();
      let freshAvailable = false;
      let postArmHistory = false;
      harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> =>
        Promise.resolve(
          checkpoints.ses_1 === undefined
            ? [event(0)]
            : postArmHistory && checkpoints.ses_1 === 0
              ? [event(1, "observation")]
              : freshAvailable && checkpoints.ses_1 === 1
                ? [event(2, "terminal")]
                : [],
        );
      let statusCalls = 0;
      harness.ports.control.status = (): Promise<"activity" | "terminal"> => {
        statusCalls += 1;
        return Promise.resolve(statusCalls === 2 ? "activity" : "terminal");
      };
      const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

      await expect(adapter.start()).resolves.toMatchObject({ ok: true });
      postArmHistory = true;
      expect(adapter.armTurn()).toBe(true);
      let settled: boolean | undefined;
      const waiting = adapter.waitForTerminal(new AbortController().signal).then((result) => {
        settled = result;
        return result;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(statusCalls).toBe(1);
      expect(settled).toBeUndefined();

      await vi.advanceTimersByTimeAsync(250);
      expect(statusCalls).toBe(2);
      freshAvailable = true;
      await expect(adapter.reconcile()).resolves.toMatchObject({ ok: true });
      await Promise.resolve();
      expect(settled).toBeUndefined();

      await vi.advanceTimersByTimeAsync(250);
      await expect(waiting).resolves.toBe(true);
      expect(statusCalls).toBe(3);
      await adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a readiness terminal that is not newer than the armed checkpoint", async () => {
    const harness = readinessPorts();
    let historyCalls = 0;
    harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> => {
      historyCalls += 1;
      return Promise.resolve(
        checkpoints.ses_1 === undefined
          ? [event(0)]
          : checkpoints.ses_1 === 0
            ? [event(1, "terminal")]
            : [],
      );
    };
    harness.ports.control.status = (): Promise<"terminal"> => Promise.resolve("terminal");
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(adapter.armTurn()).toBe(true);
    const caller = new AbortController();
    const waiting = adapter.waitForTerminal(caller.signal);
    await vi.waitFor(() => {
      expect(historyCalls).toBeGreaterThanOrEqual(3);
    });
    caller.abort();
    await expect(waiting).resolves.toBe(false);
    await adapter.close();
  });

  it("rejects a fresh terminal history event for a different session", async () => {
    const harness = readinessPorts();
    const otherTerminal = eventFor("ses_other", 0, "terminal");
    harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> =>
      Promise.resolve(
        checkpoints.ses_1 === undefined
          ? [event(0)]
          : checkpoints.ses_1 === 0
            ? [event(1, "terminal")]
            : checkpoints.ses_other === undefined
              ? [otherTerminal]
              : [],
      );
    harness.ports.control.status = (): Promise<"terminal"> => Promise.resolve("terminal");
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(adapter.armTurn()).toBe(true);
    const caller = new AbortController();
    const waiting = adapter.waitForTerminal(caller.signal);
    await vi.waitFor(() => {
      expect(harness.effects).toContain(otherTerminal.id);
    });
    caller.abort();
    await expect(waiting).resolves.toBe(false);
    await adapter.close();
  });

  it("waits for the bounded poll interval after activity before requesting status again", async () => {
    vi.useFakeTimers();
    try {
      const harness = readinessPorts();
      let statusCalls = 0;
      let releaseSecondStatus: ((value: undefined) => void) | undefined;
      harness.ports.control.status = (): Promise<"activity" | undefined> => {
        statusCalls += 1;
        if (statusCalls === 1) return Promise.resolve("activity");
        return new Promise((resolve) => {
          releaseSecondStatus = resolve;
        });
      };
      const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

      await expect(adapter.start()).resolves.toMatchObject({ ok: true });
      expect(adapter.armTurn()).toBe(true);
      const waiting = adapter.waitForTerminal(new AbortController().signal);
      await Promise.resolve();
      await Promise.resolve();
      expect(statusCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(250);
      expect(statusCalls).toBe(2);
      adapter.cancelTurn();
      releaseSecondStatus?.(undefined);
      await expect(waiting).resolves.toBe(false);
      await adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: PR #3099 P2 follow-up. `waitForTerminal` has an outer guard that returns before
  // entering the poll loop when the caller signal is already aborted. The turn-settlement
  // finally must sit OUTSIDE that guard so the already-aborted path also clears turnArmed —
  // otherwise the next armTurn() short-circuits and no further turn can ever run.
  it("KEIKO-0240 (early-abort): settles the turn when waitForTerminal receives an already-aborted signal", async () => {
    const harness = readinessPorts();
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);
    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(adapter.armTurn()).toBe(true);
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(adapter.waitForTerminal(preAborted.signal)).resolves.toBe(false);
    // Before the fix: turnArmed remained true → next armTurn returned false.
    expect(adapter.armTurn()).toBe(true);
    await adapter.close();
  });

  // Regression: KEIKO-0240. Before this fix, when waitForTerminal exited via caller abort or
  // its own 30-minute deadline WITHOUT the turn ever settling, `turnArmed` stayed true — every
  // subsequent armTurn() on the same adapter instance short-circuited to `false` and no further
  // turns could run. Any unsettled exit must now settle the turn as failed so armTurn() can
  // succeed again. Exercised here through the caller-signal abort seam because the mock
  // control.status signature this suite uses does not accept a signal parameter (a fake-timer
  // path against the internal 30-minute deadline needs a signal-aware status mock, which the
  // test-local Ports type does not model).
  it("KEIKO-0240: settles the turn on caller abort so a subsequent armTurn() can succeed", async () => {
    const harness = readinessPorts();
    let releaseStatus: (() => void) | undefined;
    harness.ports.control.status = (): Promise<undefined> =>
      new Promise<undefined>((resolve) => {
        releaseStatus = (): void => {
          resolve(undefined);
        };
      });
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);
    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(adapter.armTurn()).toBe(true);
    const caller = new AbortController();
    const waiting = adapter.waitForTerminal(caller.signal);
    // Give the poll loop a microtask to reach the awaiting-status state, then abort the caller.
    await Promise.resolve();
    caller.abort();
    releaseStatus?.();
    await expect(waiting).resolves.toBe(false);
    // Before the fix, this returned false because turnArmed was still true from the leaked turn.
    expect(adapter.armTurn()).toBe(true);
    await adapter.close();
  });
});

// #3406/#3414: dispatches the model-visible keiko_repository_search tool through the same
// generated-source mechanism every other governed tool uses (GeneratedToolAction/toolSource),
// consuming #3386's already-mounted H1 handler rather than adding a second dispatch path.
describe("keiko_repository_search generated tool dispatch", () => {
  interface GeneratedRepositorySearchContext {
    readonly sessionID: string;
    readonly callID: string;
    readonly abort: AbortSignal;
    readonly ask: (request: Record<string, unknown>) => Promise<void>;
  }
  interface GeneratedRepositorySearchTool {
    readonly execute: (
      args: Record<string, unknown>,
      context: GeneratedRepositorySearchContext,
    ) => Promise<{ readonly title: string; readonly output: string; readonly metadata: unknown }>;
  }

  /** Executes the repository-owned generated shim in isolation, never model- or workspace-supplied source. */
  function loadRepositorySearchTool(fetchImpl: typeof fetch): GeneratedRepositorySearchTool {
    const source = createGeneratedOpenCodeBundle().toolSources.keiko_repository_search;
    if (source === undefined) throw new Error("keiko_repository_search tool source missing");
    const script = new Script(
      `${source.replace("export default", "const generated =")}\ngenerated;`,
    );
    const value: unknown = script.runInNewContext(
      {
        process: {
          env: {
            KEIKO_TOOL_FACADE_URL: "https://tool-facade.internal/invoke",
            KEIKO_TOOL_FACADE_CAPABILITY: "capability-token",
          },
        },
        fetch: fetchImpl,
        AbortController,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        setTimeout,
        clearTimeout,
      },
      { timeout: 1000 },
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("execute" in value) ||
      typeof value.execute !== "function"
    ) {
      throw new Error("generated repository-search tool invalid");
    }
    return value as GeneratedRepositorySearchTool;
  }

  function boundedCompletedSearchResponse(): Response {
    return new Response(
      JSON.stringify({
        status: "completed",
        evidence: [{ kind: "governed-delegate", code: "completed" }],
        search: {
          ok: true,
          kind: "search",
          hits: [
            {
              path: "src/a.ts",
              startLine: 1,
              endLine: 2,
              snippet: "const a = 1;",
              redacted: false,
              snippetTruncated: false,
            },
          ],
          truncationReasons: [],
          metrics: { candidatesDiscovered: 1, filesScanned: 1, skippedFiles: 0, durationMs: 1 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  // Fails before #3414: without a `keiko_repository_search` entry in
  // OPENCODE_TOOL_SOURCE_DEFINITIONS, createGeneratedOpenCodeBundle().toolSources never has this
  // key, so the real pinned OpenCode runtime would have no generated tool to expose at all.
  it("is present in the generated bundle", () => {
    expect(createGeneratedOpenCodeBundle().toolSources.keiko_repository_search).toBeDefined();
  });

  it("nests the model's arguments under repositoryRequest so the real production parser accepts the request, and returns the bounded result", async () => {
    let capturedBody: string | undefined;
    const tool = loadRepositorySearchTool((_input: unknown, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : undefined;
      return Promise.resolve(boundedCompletedSearchResponse());
    });

    const result = await tool.execute(
      {
        mode: "lexical",
        query: "safeActivity",
        caseSensitive: false,
        includeGlobs: [],
        excludeGlobs: [],
        maxResults: 10,
      },
      {
        sessionID: "ses_1",
        callID: "call_1",
        abort: new AbortController().signal,
        ask: (): Promise<void> => Promise.resolve(),
      },
    );

    if (capturedBody === undefined) throw new Error("expected the generated tool to call fetch");
    // Reaches the handler: codingToolIpc.ts's real `searchRequest` parser (the exact production
    // entry point productionManagedWorktreeTools.ts's repositorySearch port dispatches from) must
    // accept the generated wire body as a "search" action with the model's arguments intact.
    const parsed = parseCodingToolRequest(capturedBody, CODING_TOOL_MAX_BODY_BYTES);
    if (parsed?.action !== "search")
      throw new Error("expected the real production parser to accept a search action request");
    expect(parsed.repositoryRequest).toEqual({
      kind: "search",
      mode: "lexical",
      query: "safeActivity",
      caseSensitive: false,
      includeGlobs: [],
      excludeGlobs: [],
      maxResults: 10,
    });
    expect(result.title).toBe("repository-search");
    const output: unknown = JSON.parse(result.output);
    expect(output).toMatchObject({ status: "completed" });
    const hits = (output as { search: { hits: readonly unknown[] } }).search.hits;
    // Bounded per #3414: never more than the handler's own returnedHits ceiling.
    expect(hits.length).toBeLessThanOrEqual(50);
  });

  it("accepts the canonical timeout result from the server without collapsing it", async () => {
    const tool = loadRepositorySearchTool(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "timeout", evidence: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await tool.execute(
      {
        mode: "lexical",
        query: "safeActivity",
        caseSensitive: false,
        includeGlobs: [],
        excludeGlobs: [],
        maxResults: 10,
      },
      {
        sessionID: "ses_1",
        callID: "call_timeout",
        abort: new AbortController().signal,
        ask: (): Promise<void> => Promise.resolve(),
      },
    );

    expect(JSON.parse(result.output)).toEqual({ status: "timeout", evidence: [] });
  });

  it("rejects a flat, unnested wire body the same real parser would reject (proves the nesting is load-bearing)", () => {
    const flatBody = JSON.stringify({
      action: "search",
      actionId: "ses_1:call_1",
      idempotencyKey: "ses_1:call_1",
      mode: "lexical",
      query: "safeActivity",
      caseSensitive: false,
      includeGlobs: [],
      excludeGlobs: [],
      maxResults: 10,
    });
    expect(parseCodingToolRequest(flatBody, CODING_TOOL_MAX_BODY_BYTES)).toBeUndefined();
  });
});
