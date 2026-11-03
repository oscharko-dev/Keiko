import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateRuntimeState } from "@oscharko-dev/keiko-contracts";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { createUpdateLocalStateManager, UpdateRuntimeStateError } from "./update-local-state.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const roots: string[] = [];
const PEER = `
  import { pathToFileURL } from 'node:url';
  const { createUpdateLocalStateManager } = await import(pathToFileURL(process.argv[1]).href);
  const manager = createUpdateLocalStateManager({ stateDir: process.argv[2] });
  const release = manager.acquireRemediationLease('local-knowledge-reindex:local-knowledge');
  if (!release) throw Error('Independent action lease was not admitted');
  try {
    const current = manager.readRuntimeState();
    try {
      const written = manager.writeRuntimeState({ ...current,
        remediations: current.remediations.map(item => item.store === 'local-knowledge'
          ? { ...item, status: 'running', warningCode: 'remediation-outcome-uncertain' } : item),
      });
      process.stdout.write(JSON.stringify({ written: true, revision: written.revision }));
    } catch (error) {
      if (error.kind !== 'unwritable') throw error;
      process.stdout.write(JSON.stringify({ written: false, kind: error.kind }));
    }
  } finally { release(); }
`;

function peerWrite(stateDir: string): unknown {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      PEER,
      fileURLToPath(new URL("../dist/update-local-state.js", import.meta.url)),
      stateDir,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

function setup(): {
  stateDir: string;
  manager: ReturnType<typeof createUpdateLocalStateManager>;
  initial: UpdateRuntimeState;
} {
  const stateDir = fs.mkdtempSync(join(tmpdir(), "keiko-update-revision-"));
  roots.push(stateDir);
  fs.chmodSync(stateDir, 0o700);
  const manager = createUpdateLocalStateManager({ stateDir });
  const initial = manager.writeRuntimeState({
    ...manager.readRuntimeState(),
    remediations: [
      {
        store: "ui-layout",
        remediation: "repair-required",
        status: "pending",
        updatedAt: new Date().toISOString(),
      },
      {
        store: "local-knowledge",
        remediation: "local-knowledge-reindex-required",
        status: "pending",
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  return { stateDir, manager, initial };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("aggregate runtime-state publication ownership", () => {
  it("records actual successful and stale publication outcomes without state bodies", () => {
    const { stateDir } = setup();
    const events: SecurityLogEvent[] = [];
    const manager = createUpdateLocalStateManager({
      stateDir,
      activityLog: {
        write: (event): void => {
          events.push(event);
        },
      },
    });
    const stale = manager.readRuntimeState();
    manager.writeRuntimeState(stale, "publication-request");
    expect(() => manager.writeRuntimeState(stale, "stale-request")).toThrow(
      UpdateRuntimeStateError,
    );
    expect(
      events.map((event) => ({
        op: event.op,
        correlationId: event.correlationId,
        state: event.extra?.state,
      })),
    ).toEqual([
      { op: "update.runtime.state-write", correlationId: "publication-request", state: "written" },
      { op: "update.runtime.state-write", correlationId: "stale-request", state: "failed" },
    ]);
    for (const event of events)
      expect(Object.keys(event.extra ?? {}).sort()).toEqual([
        "completeness",
        "loss",
        "state",
        "writeId",
      ]);
  });

  it("contains a diagnostic sink failure after the genuine publication and releases its guard", () => {
    const { stateDir } = setup();
    const diagnostics: ServerDiagnosticRecord[] = [];
    const manager = createUpdateLocalStateManager({
      stateDir,
      activityLog: {
        write: (): never => {
          throw new Error("controlled sink refusal");
        },
      },
      diagnostics: {
        record: (record): void => {
          diagnostics.push(record);
        },
      },
    });
    const first = manager.writeRuntimeState(manager.readRuntimeState(), "failed-sink-request");
    const peer = createUpdateLocalStateManager({ stateDir });
    expect(peer.writeRuntimeState(peer.readRuntimeState()).revision).toBe(first.revision + 1);
    expect(diagnostics).toMatchObject([
      {
        correlationId: "failed-sink-request",
        operation: "update.runtime.state-write",
        source: "update-local-state",
      },
    ]);
  });

  it("excludes a real distinct-action writer until publication completes, then preserves both updates", async () => {
    const { stateDir, manager, initial } = setup();
    const release = manager.acquireRemediationLease("local-state-repair:ui-layout");
    expect(release).toBeTypeOf("function");
    const rename = (await vi.importActual<typeof import("node:fs")>("node:fs")).renameSync;
    let competing: unknown;
    const hook = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === join(stateDir, "updates", "runtime-state.json")) competing = peerWrite(stateDir);
      rename(from, to);
    });
    try {
      const first = manager.writeRuntimeState({
        ...initial,
        remediations: initial.remediations.map((item) =>
          item.store === "ui-layout" ? { ...item, status: "completed" } : item,
        ),
      });
      expect(first.revision).toBe(2);
    } finally {
      hook.mockRestore();
      release?.();
    }
    expect(competing).toEqual({ written: false, kind: "unwritable" });
    expect(peerWrite(stateDir)).toEqual({ written: true, revision: 3 });
    expect(manager.readRuntimeState().remediations).toMatchObject([
      { store: "ui-layout", status: "completed" },
      { store: "local-knowledge", status: "running", warningCode: "remediation-outcome-uncertain" },
    ]);
    expect(() => manager.writeRuntimeState(initial)).toThrow(UpdateRuntimeStateError);
  });
});
