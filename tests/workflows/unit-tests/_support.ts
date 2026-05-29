// Shared deterministic fixtures for the unit-test workflow tests: WorkspaceInfo/ContextPack
// builders, a scripted ModelPort, a recording WorkspaceWriter, a recording event sink, and a
// canned NormalizedResponse. No real timers, network, or fs.

import type { NormalizedResponse } from "../../../src/gateway/types.js";
import type { ModelPort } from "../../../src/harness/ports.js";
import type { ContextEntry, ContextPack, WorkspaceInfo } from "../../../src/workspace/index.js";
import type { WorkspaceWriter } from "../../../src/tools/index.js";
import type { WorkflowEvent, WorkflowEventSink } from "../../../src/workflows/unit-tests/events.js";

export function makeWorkspaceInfo(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    root: "/repo",
    name: "demo",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
    ...overrides,
  };
}

export function makeEntry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return {
    path: "src/add.ts",
    sizeBytes: 32,
    excerptBytes: 32,
    selectionReason: "source",
    truncated: false,
    excerpt: "export const add = (a, b) => a + b;",
    ...overrides,
  };
}

export function makePack(
  selected: readonly ContextEntry[],
  overrides: Partial<ContextPack> = {},
): ContextPack {
  const usedBytes = selected.reduce((sum, e) => sum + e.excerptBytes, 0);
  return {
    workspaceRoot: "/repo",
    totalCandidates: selected.length,
    selected,
    usedBytes,
    budgetBytes: 65_536,
    droppedForBudget: 0,
    ...overrides,
  };
}

export function response(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
  return {
    modelId: "m",
    content: "",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "r",
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 3,
      costClass: "low",
    },
    ...overrides,
  };
}

// A model port returning scripted responses (one per call, last repeats), or throwing scripted
// errors. Records every request so callers can assert the appended rejection-reason on retries.
export function scriptedModel(script: readonly (NormalizedResponse | Error)[]): {
  readonly port: ModelPort;
  readonly calls: () => number;
  readonly lastMessages: () => readonly { role: string; content: string }[];
} {
  let i = 0;
  let last: readonly { role: string; content: string }[] = [];
  return {
    calls: (): number => i,
    lastMessages: () => last,
    port: {
      call: (request): Promise<NormalizedResponse> => {
        last = request.messages.map((m) => ({ role: m.role, content: m.content }));
        const item = script[Math.min(i, script.length - 1)];
        i += 1;
        if (item instanceof Error) {
          return Promise.reject(item);
        }
        return Promise.resolve(item ?? response());
      },
    },
  };
}

export interface RecordingWriter extends WorkspaceWriter {
  readonly writes: () => readonly { path: string; content: string }[];
}

export function recordingWriter(): RecordingWriter {
  const writes: { path: string; content: string }[] = [];
  return {
    writes: () => writes,
    writeFileUtf8: (absolutePath, content): void =>
      void writes.push({ path: absolutePath, content }),
    mkdirp: (): void => undefined,
    remove: (): void => undefined,
    rename: (): void => undefined,
  };
}

export function recordingSink(): {
  readonly sink: WorkflowEventSink;
  readonly events: () => readonly WorkflowEvent[];
} {
  const events: WorkflowEvent[] = [];
  return {
    events: () => events,
    sink: { emit: (event): void => void events.push(event) },
  };
}
