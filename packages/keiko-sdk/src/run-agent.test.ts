import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  persistEvidence: vi.fn(),
  resolveCostClass: vi.fn(),
}));

vi.mock("@oscharko-dev/keiko-evidence", () => ({
  persistEvidence: mocks.persistEvidence,
}));

vi.mock("@oscharko-dev/keiko-harness", () => ({
  createSession: mocks.createSession,
  DEFAULT_LIMITS: { maxSteps: 12, maxToolCalls: 40 },
  HARNESS_VERSION: "harness-test",
}));

vi.mock("@oscharko-dev/keiko-model-gateway", () => ({
  resolveCostClass: mocks.resolveCostClass,
}));

const { runAgent } = await import("./run-agent.js");

const task = {
  taskType: "unit-test",
  instructions: "exercise sdk evidence behavior",
} as never;

const result = {
  runId: "run-sdk-1",
  fingerprint: "fp-sdk-1",
  startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  events: [{ kind: "session-started" }],
} as never;

const deps = { model: {} } as never;

describe("runAgent", () => {
  beforeEach(() => {
    mocks.createSession.mockReset();
    mocks.persistEvidence.mockReset();
    mocks.resolveCostClass.mockReset();
    mocks.createSession.mockReturnValue({
      result: Promise.resolve(result),
      cancel: vi.fn(),
    });
  });

  it("delegates to the harness and persists evidence after the run completes", async () => {
    const config = {
      model: "gpt-test",
      workingDirectory: "/repo",
      limits: { maxSteps: 3 },
    } as never;

    const session = runAgent(task, config, deps);
    await expect(session.result).resolves.toBe(result);

    expect(mocks.createSession).toHaveBeenCalledWith(task, config, deps);
    expect(mocks.persistEvidence).toHaveBeenCalledTimes(1);
    expect(mocks.persistEvidence.mock.calls[0]?.[0]).toMatchObject({
      result,
      manifest: {
        runId: "run-sdk-1",
        fingerprint: "fp-sdk-1",
        harnessVersion: "harness-test",
        taskType: "unit-test",
        taskInput: task,
        limits: { maxSteps: 3, maxToolCalls: 40 },
        modelId: "gpt-test",
        workingDirectory: "/repo",
        dryRun: true,
        startedAt: "2026-01-02T03:04:05.000Z",
        events: [{ kind: "session-started" }],
      },
    });
    expect(mocks.persistEvidence.mock.calls[0]?.[1]).toMatchObject({
      costClassResolver: mocks.resolveCostClass,
    });
  });

  it("does not persist evidence when the caller opts out", async () => {
    const session = runAgent(
      task,
      { model: "gpt-test", workingDirectory: "/repo", evidence: { write: false } },
      deps,
    );

    await expect(session.result).resolves.toBe(result);
    expect(mocks.persistEvidence).not.toHaveBeenCalled();
  });

  it("passes evidence dependencies, retention, redaction, and build options through", async () => {
    const store = {} as EvidenceStore;
    const env = {} as EnvSource;
    const retention = { maxAgeDays: 7 } as never;
    const redaction = { mode: "strict" } as never;
    const options = { includeTelemetry: false } as never;

    const session = runAgent(
      task,
      {
        model: "gpt-test",
        workingDirectory: "/repo",
        dryRun: false,
        evidence: { store, env, retention, redaction, options },
      },
      deps,
    );

    await session.result;

    expect(mocks.persistEvidence.mock.calls[0]?.[0]).toMatchObject({
      redaction,
      options,
      manifest: { dryRun: false },
    });
    expect(mocks.persistEvidence.mock.calls[0]?.[1]).toMatchObject({
      store,
      env,
      costClassResolver: mocks.resolveCostClass,
    });
    expect(mocks.persistEvidence.mock.calls[0]?.[2]).toBe(retention);
  });
});
