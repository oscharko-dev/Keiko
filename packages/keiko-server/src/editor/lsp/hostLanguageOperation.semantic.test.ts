import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import { MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS } from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities";

import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogLossCounters,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { resetServerLogFailureNotices } from "../../../../keiko-activity-log/dist/server-log.js";
import {
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  type ServerDiagnosticRecord,
} from "../../diagnostics-log.js";
import type { LspSpawnFn } from "./lspNodeAdapter.js";
import {
  runHostLanguageSemanticTokens,
  runHostLanguageSemanticTokensDetailed,
  shutdownHostLspPool,
  type HostLanguageOperationOptions,
  type HostSemanticTokenDocument,
  type HostSemanticTokenResult,
} from "./hostLanguageOperation.js";
import { createFakeLspProcess } from "./testing/fakeLspProcess.js";

let bin = "";
let root = "";
let semanticDiagnostics: ServerDiagnosticRecord[] = [];
const semanticDiagnosticBinding = {
  correlationId: "semantic-host-request",
  diagnosticSink: {
    record(record: ServerDiagnosticRecord): void {
      semanticDiagnostics.push(record);
    },
  },
};

beforeEach(() => {
  semanticDiagnostics = [];
  bin = mkdtempSync(join(tmpdir(), "keiko-semantic-bin-"));
  root = mkdtempSync(join(tmpdir(), "keiko-semantic-root-"));
  for (const name of ["cargo", "rust-analyzer", "rustc", "rustfmt"]) {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  writeFileSync(join(root, "Cargo.toml"), "[package]\nname='safe'\nversion='0.1.0'\n");
  writeFileSync(join(root, "lib.rs"), "struct Value;\n");
});

afterEach(async () => {
  await shutdownHostLspPool();
  rmSync(bin, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function workspace(): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: ["rust"],
    ignoreLines: [],
  };
}

function options(
  spawn: LspSpawnFn,
  signal = new AbortController().signal,
): HostLanguageOperationOptions {
  return {
    ...semanticDiagnosticBinding,
    workspace: workspace(),
    processEnv: { PATH: bin },
    commandRules: ["cargo", "rust-analyzer", "rustc", "rustfmt"].map((executable) => ({
      executable,
    })),
    overlayAbsolutePath: join(root, "lib.rs"),
    signal,
    spawn,
    prepareSpawn: (input) => ({ ...input, executable: "/usr/bin/true" }),
    activationAuthorized: true,
    activationStillAuthorized: (): boolean => true,
    protocolConfiguration: { revision: 1, settings: {}, initializationOptions: {} },
  };
}

function fake(data: readonly number[]): ReturnType<typeof createFakeLspProcess> {
  return createFakeLspProcess({
    initializeResult: {
      capabilities: {
        textDocumentSync: 2,
        semanticTokensProvider: {
          full: true,
          legend: { tokenTypes: ["struct"], tokenModifiers: ["declaration"] },
        },
      },
    },
    results: { "textDocument/semanticTokens/full": { data } },
  });
}

describe("managed host semantic tokens", () => {
  it("returns bounded versioned Rust tokens only after live legend negotiation", async () => {
    const process = fake([0, 0, 6, 0, 1]);
    const result = await runHostLanguageSemanticTokens(
      { path: "lib.rs", languageId: "rust", text: "struct Value;\n", version: 11 },
      options(() => process.handle),
    );

    expect(result?.data).toMatchObject({ documentVersion: 11, returnedTokenCount: 1 });
    expect(result?.legend.tokenTypes).toContain("struct");
  });

  it("reopens semantic-token documents after a crash while retaining same-child incremental sync", async () => {
    const processes: ReturnType<typeof createFakeLspProcess>[] = [];
    const spawn: LspSpawnFn = () => {
      const process = fake([0, 0, 6, 0, 1]);
      processes.push(process);
      return process.handle;
    };

    await runHostLanguageSemanticTokens(
      { path: "lib.rs", languageId: "rust", text: "struct Value;\n", version: 11 },
      options(spawn),
    );
    await runHostLanguageSemanticTokens(
      { path: "lib.rs", languageId: "rust", text: "struct Other;\n", version: 12 },
      options(spawn),
    );
    processes[0]?.emitError();
    const restarted = await runHostLanguageSemanticTokens(
      { path: "lib.rs", languageId: "rust", text: "struct Final;\n", version: 13 },
      options(spawn),
    );

    expect(restarted?.data).toMatchObject({ documentVersion: 13, returnedTokenCount: 1 });
    const initialMethods = processes[0]?.receivedMethods() ?? [];
    expect(initialMethods.filter((method) => method === "textDocument/didOpen")).toHaveLength(1);
    expect(initialMethods.filter((method) => method === "textDocument/didChange")).toHaveLength(1);
    const replacementMethods = processes[1]?.receivedMethods() ?? [];
    expect(replacementMethods.filter((method) => method === "textDocument/didOpen")).toHaveLength(
      1,
    );
    expect(replacementMethods).not.toContain("textDocument/didChange");
    expect(replacementMethods.indexOf("textDocument/didOpen")).toBeLessThan(
      replacementMethods.indexOf("textDocument/semanticTokens/full"),
    );
  });

  it("returns fallback for malformed token indices and cancellation", async () => {
    const malformed = fake([0, 0, 6, 8, 0]);
    const document = { path: "lib.rs", languageId: "rust", text: "struct Value;\n", version: 2 };
    expect(
      await runHostLanguageSemanticTokens(
        document,
        options(() => malformed.handle),
      ),
    ).toBeUndefined();
    await shutdownHostLspPool();
    const controller = new AbortController();
    controller.abort();
    expect(
      await runHostLanguageSemanticTokens(
        document,
        options(() => fake([]).handle, controller.signal),
      ),
    ).toBeUndefined();
  });
});

function detailedTokenDocument(version = 11): HostSemanticTokenDocument {
  return { path: "lib.rs", languageId: "rust", text: "struct Value;\n", version };
}

function observedSemanticProcess(
  onMessage: (method: string) => void,
): ReturnType<typeof createFakeLspProcess> {
  return createFakeLspProcess({
    initializeResult: {
      capabilities: {
        textDocumentSync: 2,
        semanticTokensProvider: {
          full: true,
          legend: { tokenTypes: ["struct"], tokenModifiers: ["declaration"] },
        },
      },
    },
    results: { "textDocument/semanticTokens/full": { data: [0, 0, 6, 0, 1] } },
    onMessage,
  });
}

function excessiveSemanticData(): readonly number[] {
  return Array.from(
    { length: MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS + 1 },
    (_entry, index): number[] => [0, index === 0 ? 0 : 1, 1, 0, 0],
  ).flat();
}

interface SemanticThrownValueState {
  requested: boolean;
  failureObserved: boolean;
  signalReads: number;
}

function revokedSemanticDocument(state: SemanticThrownValueState): HostSemanticTokenDocument {
  const revocable = Proxy.revocable(new TypeError("synthetic semantic document refusal"), {});
  const failure: Error = revocable.proxy;
  revocable.revoke();
  return {
    path: "lib.rs",
    languageId: "rust",
    version: 11,
    get text(): string {
      if (state.requested) {
        state.failureObserved = true;
        throw failure;
      }
      return "struct Value;\n";
    },
  };
}

function observeSemanticFailureSignal(
  signal: AbortSignal,
  state: SemanticThrownValueState,
): () => void {
  const previous = Object.getOwnPropertyDescriptor(signal, "aborted");
  Object.defineProperty(signal, "aborted", {
    configurable: true,
    get(): boolean {
      if (state.failureObserved) state.signalReads += 1;
      return false;
    },
  });
  return (): void => {
    if (previous === undefined) Reflect.deleteProperty(signal, "aborted");
    else Object.defineProperty(signal, "aborted", previous);
  };
}

// New detailed API controls are Same-only; the three legacy cases above remain Original controls.
describe("managed host semantic-token dispositions (#3918)", (): void => {
  it("retains served references and serialized same-child document observations", async (): Promise<void> => {
    const process = fake([0, 0, 6, 0, 1]);
    const configured = options(() => process.handle);
    const first = await runHostLanguageSemanticTokensDetailed(
      detailedTokenDocument(11),
      configured,
    );
    const legacy = await runHostLanguageSemanticTokens(detailedTokenDocument(12), configured);
    const last = await runHostLanguageSemanticTokensDetailed(detailedTokenDocument(13), configured);
    if (first.disposition !== "served" || last.disposition !== "served" || legacy === undefined) {
      throw new TypeError("Expected served semantic-token controls");
    }
    expect(first.result.legend).toBe(legacy.legend);
    expect(last.result.legend).toBe(first.result.legend);
    expect(first.result.data).toMatchObject({ documentVersion: 11, returnedTokenCount: 1 });
    expect(legacy.data).toMatchObject({ documentVersion: 12, returnedTokenCount: 1 });
    expect(last.result.data).toMatchObject({ documentVersion: 13, returnedTokenCount: 1 });
    expect(last.result.data).not.toBe(first.result.data);
    expect(
      process.receivedMethods().filter((method) => method.startsWith("textDocument/")),
    ).toEqual([
      "textDocument/didOpen",
      "textDocument/semanticTokens/full",
      "textDocument/didChange",
      "textDocument/semanticTokens/full",
      "textDocument/didChange",
      "textDocument/semanticTokens/full",
    ]);
  });

  it("observes malformed provider JSON as one sanitizer refusal without invented subreasons", async (): Promise<void> => {
    const process = fake([0, 0, 6, 8, 0]);
    const result = await runHostLanguageSemanticTokensDetailed(
      detailedTokenDocument(),
      options(() => process.handle),
    );
    expect(result).toEqual({ disposition: "sanitizer-refused" });
    expect(
      process.receivedMethods().filter((method) => method === "textDocument/semanticTokens/full"),
    ).toHaveLength(1);
  });

  it("retains whole-response refusal for excessive provider JSON rather than a partial overlay", async (): Promise<void> => {
    const process = fake(excessiveSemanticData());
    const document = {
      ...detailedTokenDocument(),
      text: "x".repeat(MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS + 2),
    };
    expect(
      await runHostLanguageSemanticTokensDetailed(
        document,
        options(() => process.handle),
      ),
    ).toEqual({
      disposition: "sanitizer-refused",
    });
    expect(
      process.receivedMethods().filter((method) => method === "textDocument/semanticTokens/full"),
    ).toHaveLength(1);
  });

  it("keeps unsupported language and unavailable activation out of the provider request path", async (): Promise<void> => {
    let spawns = 0;
    const configured = options(() => {
      spawns += 1;
      return fake([]).handle;
    });
    const unsupported = { ...detailedTokenDocument(), languageId: "go" };
    const unavailable = { ...configured, activationStillAuthorized: (): boolean => false };
    expect(await runHostLanguageSemanticTokensDetailed(unsupported, configured)).toEqual({
      disposition: "unavailable",
    });
    expect(
      await runHostLanguageSemanticTokensDetailed(detailedTokenDocument(), unavailable),
    ).toEqual({ disposition: "unavailable" });
    expect(await runHostLanguageSemanticTokens(unsupported, configured)).toBeUndefined();
    expect(
      await runHostLanguageSemanticTokens(detailedTokenDocument(), unavailable),
    ).toBeUndefined();
    expect(spawns).toBe(0);
  });

  it("distinguishes absent live negotiation without issuing a semantic-token request", async (): Promise<void> => {
    const process = createFakeLspProcess({
      initializeResult: { capabilities: { textDocumentSync: 2 } },
    });
    expect(
      await runHostLanguageSemanticTokensDetailed(
        detailedTokenDocument(),
        options(() => process.handle),
      ),
    ).toEqual({
      disposition: "not-negotiated",
    });
    expect(process.receivedMethods()).toContain("initialize");
    expect(process.receivedMethods()).not.toContain("textDocument/semanticTokens/full");
  });

  it("reports cancellation observed at the actual semantic request", async (): Promise<void> => {
    const controller = new AbortController();
    const process = observedSemanticProcess((method): void => {
      if (method === "textDocument/semanticTokens/full") controller.abort();
    });
    const result = await runHostLanguageSemanticTokensDetailed(
      detailedTokenDocument(),
      options(() => process.handle, controller.signal),
    );
    expect(result).toEqual({ disposition: "cancelled" });
    expect(
      process.receivedMethods().filter((method) => method === "textDocument/semanticTokens/full"),
    ).toHaveLength(1);
  });

  it("distinguishes an actual request transport failure from sanitizer refusal", async (): Promise<void> => {
    const failure: Error = Object.freeze(new TypeError("synthetic semantic transport refusal"));
    const process = observedSemanticProcess((method): void => {
      if (method === "textDocument/semanticTokens/full") process.emitError(failure);
    });
    const configured = {
      ...options(() => process.handle),
      lspProcessConfig: { maxRestartsInWindow: 0 },
    };
    const result = await runHostLanguageSemanticTokensDetailed(detailedTokenDocument(), configured);
    expect(result).toEqual({ disposition: "request-failed" });
    expect(
      process.receivedMethods().filter((method) => method === "textDocument/semanticTokens/full"),
    ).toHaveLength(1);
  });

  for (const surface of [
    { name: "legacy", run: runHostLanguageSemanticTokens },
    { name: "detailed", run: runHostLanguageSemanticTokensDetailed },
  ]) {
    it(`${surface.name} preserves acquisition exception identity before a request can be queued`, async (): Promise<void> => {
      const failure: Error = Object.freeze(new TypeError("synthetic semantic acquisition refusal"));
      const trace: string[] = [];
      const configured: HostLanguageOperationOptions = {
        ...options(() => fake([]).handle),
        activationStillAuthorized(): boolean {
          trace.push("activation");
          return true;
        },
        get prepareSpawn(): HostLanguageOperationOptions["prepareSpawn"] {
          trace.push("acquire");
          throw failure;
        },
      };
      await expect(surface.run(detailedTokenDocument(), configured)).rejects.toBe(failure);
      expect(trace).toEqual(["activation", "acquire"]);
    });
  }

  for (const surface of [
    { name: "legacy", run: runHostLanguageSemanticTokens },
    { name: "detailed", run: runHostLanguageSemanticTokensDetailed },
  ]) {
    it(`${surface.name} contains a revoked thrown value without inspecting it`, async (): Promise<void> => {
      const controller = new AbortController();
      const state: SemanticThrownValueState = {
        requested: false,
        failureObserved: false,
        signalReads: 0,
      };
      const process = observedSemanticProcess((method): void => {
        if (method === "textDocument/semanticTokens/full") state.requested = true;
      });
      const restore = observeSemanticFailureSignal(controller.signal, state);
      let actual: unknown;
      try {
        actual = await surface.run(
          revokedSemanticDocument(state),
          options(() => process.handle, controller.signal),
        );
      } finally {
        restore();
      }
      expect(state.requested).toBe(true);
      expect(state.failureObserved).toBe(true);
      expect(state.signalReads).toBe(1);
      if (surface.name === "legacy") expect(actual).toBeUndefined();
      else expect(actual).toEqual({ disposition: "request-failed" });
    });
  }

  it("retains the exact two-argument legacy result contract", (): void => {
    expectTypeOf<Parameters<typeof runHostLanguageSemanticTokens>>().toEqualTypeOf<
      [HostSemanticTokenDocument, HostLanguageOperationOptions]
    >();
    expectTypeOf<ReturnType<typeof runHostLanguageSemanticTokens>>().toEqualTypeOf<
      Promise<HostSemanticTokenResult | undefined>
    >();
  });
});

function failedSemanticDocument(
  failure: Error,
  requested: { value: boolean },
): HostSemanticTokenDocument {
  return {
    path: "lib.rs",
    languageId: "rust",
    version: 11,
    get text(): string {
      if (requested.value) throw failure;
      return "struct Value;\n";
    },
  };
}

function diagnosticSemanticFailure(): Error {
  return Object.freeze(
    new TypeError("private-semantic-failure-canary", {
      cause: new RangeError("private-semantic-cause-canary"),
    }),
  );
}

function semanticDiagnosticSurfaceResult(name: string, result: unknown): void {
  if (name === "legacy") expect(result).toBeUndefined();
  else expect(result).toEqual({ disposition: "request-failed" });
}

// These controls use the already-existing H1 detailed API, so Root can overlay them before H2.
describe("semantic-token request diagnostics (#3918)", (): void => {
  for (const surface of [
    { name: "legacy", run: runHostLanguageSemanticTokens },
    { name: "detailed", run: runHostLanguageSemanticTokensDetailed },
  ]) {
    it(`${surface.name} preserves correlated canonical frames and causes`, async (): Promise<void> => {
      const failure = diagnosticSemanticFailure();
      const expectedFrames = keikoStackFrames(failure);
      const expectedCauses = causeChain(failure);
      const requested = { value: false };
      const process = observedSemanticProcess((method): void => {
        if (method === "textDocument/semanticTokens/full") requested.value = true;
      });
      const result = await surface.run(
        failedSemanticDocument(failure, requested),
        options(() => process.handle),
      );
      semanticDiagnosticSurfaceResult(surface.name, result);
      expect(requested.value).toBe(true);
      expect(expectedFrames.length).toBeGreaterThan(0);
      expect(expectedCauses).toEqual(["RangeError"]);
      expect(semanticDiagnostics).toHaveLength(1);
      expect(semanticDiagnostics[0]).toMatchObject({
        correlationId: "semantic-host-request",
        operation: "editor.semantic-tokens",
        source: "editor.hostLanguageOperation",
        diagnosticOutcome: "request-failed",
        message: DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
        errorClass: "TypeError",
        frames: expectedFrames,
        causeChain: expectedCauses,
      });
      const evidence = JSON.stringify(semanticDiagnostics);
      expect(evidence).not.toContain("private-semantic-failure-canary");
      expect(evidence).not.toContain("private-semantic-cause-canary");
      expect(evidence).not.toContain(root);
    });

    it(`${surface.name} diagnoses a revoked thrown value without escaping`, async (): Promise<void> => {
      const state: SemanticThrownValueState = {
        requested: false,
        failureObserved: false,
        signalReads: 0,
      };
      const process = observedSemanticProcess((method): void => {
        if (method === "textDocument/semanticTokens/full") state.requested = true;
      });
      const result = await surface.run(
        revokedSemanticDocument(state),
        options(() => process.handle),
      );
      semanticDiagnosticSurfaceResult(surface.name, result);
      expect(state.failureObserved).toBe(true);
      expect(semanticDiagnostics).toHaveLength(1);
      expect(semanticDiagnostics[0]).toMatchObject({
        correlationId: "semantic-host-request",
        errorClass: "Error",
        diagnosticOutcome: "request-failed",
        message: DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
      });
      expect(semanticDiagnostics[0]).not.toHaveProperty("frames");
      expect(semanticDiagnostics[0]).not.toHaveProperty("causeChain");
    });

    it(`${surface.name} retains fallback when the diagnostic port throws`, async (): Promise<void> => {
      const requested = { value: false };
      const process = observedSemanticProcess((method): void => {
        if (method === "textDocument/semanticTokens/full") requested.value = true;
      });
      const sinkFailure: Error = Object.freeze(new TypeError("private-diagnostic-sink-canary"));
      let attempted = 0;
      const configured = {
        ...options(() => process.handle),
        diagnosticSink: {
          record(): never {
            attempted += 1;
            throw sinkFailure;
          },
        },
      };
      const stderr = vi.spyOn(globalThis.process.stderr, "write").mockReturnValue(true);
      let result: unknown;
      let loss: number;
      let notices: string;
      try {
        resetActivityLogLossCountersForTests();
        resetServerLogFailureNotices();
        result = await surface.run(
          failedSemanticDocument(diagnosticSemanticFailure(), requested),
          configured,
        );
        loss = activityLogLossCounters()["diagnostic-sink-failed"];
        notices = stderr.mock.calls.map((call) => String(call[0])).join("\n");
      } finally {
        try {
          resetServerLogFailureNotices();
        } finally {
          resetActivityLogLossCountersForTests();
          stderr.mockRestore();
        }
      }
      semanticDiagnosticSurfaceResult(surface.name, result);
      expect(attempted).toBe(1);
      expect(loss).toBe(1);
      expect(notices).toContain("semantic-host-request");
      expect(notices).not.toContain("private-diagnostic-sink-canary");
    });
  }

  it("does not turn healthy, refused or cancelled work into a technical diagnostic", async (): Promise<void> => {
    const served = fake([0, 0, 6, 0, 1]);
    expect(
      await runHostLanguageSemanticTokensDetailed(
        detailedTokenDocument(),
        options(() => served.handle),
      ),
    ).toMatchObject({ disposition: "served" });
    await shutdownHostLspPool();
    const refused = fake([0, 0, 6, 8, 0]);
    expect(
      await runHostLanguageSemanticTokensDetailed(
        detailedTokenDocument(),
        options(() => refused.handle),
      ),
    ).toEqual({ disposition: "sanitizer-refused" });
    await shutdownHostLspPool();
    const controller = new AbortController();
    const cancelled = observedSemanticProcess((method): void => {
      if (method === "textDocument/semanticTokens/full") controller.abort();
    });
    expect(
      await runHostLanguageSemanticTokensDetailed(
        detailedTokenDocument(),
        options(() => cancelled.handle, controller.signal),
      ),
    ).toEqual({ disposition: "cancelled" });
    expect(semanticDiagnostics).toEqual([]);
  });
});
