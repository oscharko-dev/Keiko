import { describe, expect, it } from "vitest";

import type { LanguageServiceOperation } from "@oscharko-dev/keiko-contracts";

import { LspServerRequestError } from "./lspJsonRpcClient.js";
import { createLspProtocolSession, type LspProtocolSession } from "./lspProtocolSession.js";

const CANDIDATES: readonly LanguageServiceOperation[] = [
  "diagnostics",
  "completion",
  "hover",
  "symbols",
  "formatting",
];

function session(configuration: Readonly<Record<string, unknown>> = {}): LspProtocolSession {
  return createLspProtocolSession({
    language: "python",
    candidateOperations: CANDIDATES,
    semanticTokensCandidate: true,
    configurationRevision: 4,
    processId: 42,
    workspaceRoot: "/workspace/project",
    configuration,
  });
}

describe("managed LSP 3.18 protocol session", () => {
  it("negotiates push diagnostics from document synchronization without a pull provider", () => {
    const protocol = session();
    protocol.acceptInitializeResult({ capabilities: { textDocumentSync: 2 } });
    expect(protocol.snapshot().negotiatedOperations).toContain("diagnostics");
  });
  it("builds bounded initialize parameters without granting server mutation authority", () => {
    const params = session().initializeParams();
    expect(params).toMatchObject({
      processId: 42,
      clientInfo: { name: "Keiko" },
      rootUri: "file:///workspace/project",
      workspaceFolders: [{ uri: "file:///workspace/project", name: "workspace" }],
      trace: "off",
    });
    expect(JSON.stringify(params)).not.toContain("applyEdit");
    expect(JSON.stringify(params)).not.toContain("executeCommand");
  });

  it("advertises no executable operations when the server returns empty capabilities", () => {
    const protocol = session();
    protocol.acceptInitializeResult({ capabilities: {} });
    expect(protocol.snapshot().negotiatedOperations).toEqual([]);
    expect(protocol.snapshot()).toMatchObject({
      positionEncoding: "utf-16",
      textSync: "none",
      configurationRevision: 4,
    });
  });

  it("intersects server capabilities with Keiko candidates", () => {
    const protocol = session();
    protocol.acceptInitializeResult({
      capabilities: {
        textDocumentSync: 2,
        hoverProvider: true,
        completionProvider: {},
        definitionProvider: true,
        positionEncoding: "utf-8",
      },
    });
    expect(protocol.snapshot()).toMatchObject({
      negotiatedOperations: ["completion", "diagnostics", "hover"],
      positionEncoding: "utf-8",
      textSync: "incremental",
    });
  });

  it("registers and unregisters known capabilities atomically", () => {
    const protocol = session();
    protocol.acceptInitializeResult({ capabilities: {} });
    protocol.handleServerRequest("client/registerCapability", {
      registrations: [
        { id: "hover-1", method: "textDocument/hover" },
        { id: "completion-1", method: "textDocument/completion" },
      ],
    });
    expect(protocol.snapshot().negotiatedOperations).toEqual(["completion", "hover"]);

    expect(() =>
      protocol.handleServerRequest("client/registerCapability", {
        registrations: [
          { id: "symbols-1", method: "textDocument/documentSymbol" },
          { id: "unknown-1", method: "workspace/executeCommand" },
        ],
      }),
    ).toThrow(LspServerRequestError);
    expect(protocol.snapshot().negotiatedOperations).toEqual(["completion", "hover"]);

    protocol.handleServerRequest("client/unregisterCapability", {
      unregisterations: [{ id: "hover-1", method: "textDocument/hover" }],
    });
    expect(protocol.snapshot().negotiatedOperations).toEqual(["completion"]);
    expect(protocol.snapshot().dynamicallyUnregisteredOperations).toEqual(["hover"]);
  });

  it.each([
    "workspace/applyEdit",
    "window/showDocument",
    "workspace/executeCommand",
    "workspace/executeClientCommand",
  ])("denies mutating server request %s without echoing its body", (method) => {
    const protocol = session();
    let caught: unknown;
    try {
      protocol.handleServerRequest(method, { sentinel: "SENTINEL_SECRET_MUTATION" });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LspServerRequestError);
    expect(JSON.stringify(caught)).not.toContain("SENTINEL_SECRET");
  });

  it("returns only validated, allowlisted workspace configuration", () => {
    const protocol = session({
      "python.analysis": { typeCheckingMode: "strict", diagnosticMode: "openFilesOnly" },
      secret: { token: "SENTINEL_SECRET_TOKEN" },
      unsafeRuntime: { executablePath: "/usr/bin/python" },
    });
    const result = protocol.handleServerRequest("workspace/configuration", {
      items: [
        { section: "python.analysis" },
        { section: "secret" },
        { section: "unsafeRuntime" },
        { section: "unrelated" },
      ],
    });
    expect(result).toEqual([
      { typeCheckingMode: "strict", diagnosticMode: "openFilesOnly" },
      null,
      null,
      null,
    ]);
    expect(JSON.stringify(result)).not.toContain("SENTINEL_SECRET");
  });

  it("counts only allowlisted notifications without retaining their bodies", () => {
    const protocol = session();
    protocol.handleServerNotification("$/progress", { sentinel: "SENTINEL_SECRET_PROGRESS" });
    protocol.handleServerNotification("window/logMessage", {
      message: "SENTINEL_SECRET_LOG",
    });
    protocol.handleServerNotification("future/log", { sentinel: "SENTINEL_SECRET_UNKNOWN" });

    expect(protocol.notificationCounts()).toEqual({ "$/progress": 1, "window/logMessage": 1 });
    expect(JSON.stringify(protocol.notificationCounts())).not.toContain("SENTINEL_SECRET");
  });

  it("bounds configuration fan-out and treats unknown requests as denied", () => {
    const protocol = session();
    expect(() =>
      protocol.handleServerRequest("workspace/configuration", {
        items: Array.from({ length: 17 }, () => ({ section: "python.analysis" })),
      }),
    ).toThrow(LspServerRequestError);
    expect(() => protocol.handleServerRequest("future/mutation", {})).toThrow(
      LspServerRequestError,
    );
  });
});
