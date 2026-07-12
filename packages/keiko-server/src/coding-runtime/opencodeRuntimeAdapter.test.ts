import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { OPENCODE_PINNED_BUILT_IN_TOOLS } from "./opencodeToolSchemas.js";

const DIGEST = "a".repeat(64);
const SECRET = "SENTINEL_OPENCODE_RUNTIME_SECRET";
const KEIKO_PRODUCER_TOOLS = ["keiko_workspace_read", "keiko_changeset_edit"] as const;
const MODEL_VISIBLE_TOOLS = ["question", ...KEIKO_PRODUCER_TOOLS] as const;
const READY_LINE = "opencode server listening on http://127.0.0.1:43123\n";

type ReadinessPhase =
  | "target-attestation"
  | "config-materialization"
  | "endpoint"
  | "authenticated-health"
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
  readonly kind: "observation" | "permission" | "question" | "tool" | "terminal";
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
    readonly sessionEcho: () => Promise<string>;
  };
  readonly governedSink: {
    readonly execute: (
      identityKey: string,
      event: GovernedEvent,
    ) => Promise<"applied" | "duplicate">;
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
    readonly provider: Readonly<Record<string, unknown>>;
    readonly tools: Readonly<Record<string, boolean>>;
    readonly permission: Readonly<Record<string, string>>;
  };
  readonly toolSources: Readonly<Record<string, string>>;
}

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
            return Promise.resolve(
              failed("authenticated-health")
                ? { status: 200, version: "1.17.17" }
                : { status: 500 },
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
      limit: { context: 32_768, output: 4_096 },
      cost: { input: 0, output: 0 },
    });
    expect(options.baseURL).toBe("{env:KEIKO_MODEL_GATEWAY_URL}");
    expect(Object.keys(options)).toEqual(["baseURL", "headers"]);
    expect(headers.Authorization).toBe("Bearer {env:KEIKO_MODEL_GATEWAY_CAPABILITY}");
    expect(bundle.config.tools).toMatchObject({
      question: true,
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
      question: "allow",
      keiko_workspace_read: "allow",
      keiko_changeset_edit: "allow",
    });
    for (const tool of OPENCODE_PINNED_BUILT_IN_TOOLS) {
      expect(bundle.config.permission[tool]).toBe("deny");
    }
    expect(Object.keys(bundle.toolSources).sort()).toEqual([...KEIKO_PRODUCER_TOOLS].sort());
    expect(JSON.stringify(bundle.toolSources)).not.toMatch(/\b(?:import|require)\b/u);
    expect(JSON.stringify(bundle.toolSources)).not.toContain(SECRET);
    for (const source of Object.values(bundle.toolSources)) {
      expect(source).toContain('redirect: "manual"');
      expect(source).toContain("signal:");
      expect(source).toMatch(/timeout|AbortController/u);
      expect(source).toMatch(/TextDecoder|utf-8/u);
    }
    expect(Object.values(bundle.toolSources).join("\n")).toMatch(/changeset/u);
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
      [event(1, "terminal")],
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
    const overflowSnapshots = historyCheckpoints.slice(setupPages.length);
    expect(overflowSnapshots).toHaveLength(1_000);
    expect(overflowSnapshots.every((checkpoints) => checkpoints.ses_1 === 1)).toBe(true);
    expect(overflowSnapshots.every((checkpoints) => Object.keys(checkpoints).length === 256)).toBe(
      true,
    );
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
    harness.ports.readiness.subscribe = (_signal): AsyncIterable<OpenCodeSyncHint> =>
      finiteHints([
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
      ]);
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);
    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
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

  it("accepts a fresh post-arm terminal history event when live busy and idle were missed", async () => {
    const harness = readinessPorts();
    harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> =>
      Promise.resolve(
        checkpoints.ses_1 === undefined
          ? [event(0)]
          : checkpoints.ses_1 === 0
            ? [event(1, "terminal")]
            : checkpoints.ses_1 === 1
              ? [event(2, "terminal")]
              : [],
      );
    harness.ports.control.status = (): Promise<"terminal"> => Promise.resolve("terminal");
    const adapter = (await adapterModule()).createOpenCodeRuntimeAdapter(harness.ports);

    await expect(adapter.start()).resolves.toMatchObject({ ok: true });
    expect(adapter.armTurn()).toBe(true);
    await expect(adapter.waitForTerminal(AbortSignal.timeout(750))).resolves.toBe(true);
    await adapter.close();
  });

  it("waits for terminal status after fresh post-arm completion arrives while status is busy", async () => {
    vi.useFakeTimers();
    try {
      const harness = readinessPorts();
      harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> =>
        Promise.resolve(
          checkpoints.ses_1 === undefined
            ? [event(0)]
            : checkpoints.ses_1 === 0
              ? [event(1, "terminal")]
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
      harness.ports.readiness.history = (checkpoints): Promise<readonly GovernedEvent[]> =>
        Promise.resolve(
          checkpoints.ses_1 === undefined
            ? [event(0)]
            : checkpoints.ses_1 === 0
              ? [event(1, "terminal")]
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
});
