import { describe, expect, it, vi } from "vitest";
import type { EvidenceAtom, RetrievalQuery, SelectedScope } from "@oscharko-dev/keiko-contracts";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
} from "@oscharko-dev/keiko-contracts/runtime/connected-context";
import { extractAnchors, rankCandidates } from "@oscharko-dev/keiko-workflows";
import type {
  SearchScope,
  WorkspaceFs,
  WorkspaceInfo,
  WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";
import { WorkspaceDescriptorReadError } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  createStructuralAdapterRequestContext,
  buildMatcher,
  repositorySourceLines,
  repositorySourceMaxLineScore,
  type CodeIntelligenceIndex,
} from "@oscharko-dev/keiko-workspace/code-intelligence";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import {
  endpointContractAdapter,
  evidenceAtomStableId,
  PathDeniedError,
} from "@oscharko-dev/keiko-workspace";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  _readKeptExcerptsForTests,
  retrieveConnectedContextPack,
} from "./grounded-orchestrator.js";
import { buildGroundedGatewayMessages } from "./grounded-qa.js";

import {
  collectDiscoveredSymbolTraceEvidence,
  collectFollowSymbolTraceEvidence,
  GROUNDED_TRACE_SEARCH_LIMITS,
} from "./grounded-symbol-trace.js";

const NOW = 1_784_653_600_000;
const WORKSPACE_ROOT = "/workspace";
const ROUTE_PATH = "src/routes.ts";
const ROUTE_CONTENT =
  'import { handlePostItem } from "./implementation.js";\nrouter.post("/api/items", handlePostItem);\n';
const ROUTE_FILE_IDENTITY = `symbol-trace-probe:${WORKSPACE_ROOT}/${ROUTE_PATH}`;

const CONTEXTUAL_CONVERTER_BODY = [
  "export function prepareContent(value: string): Uint8Array {",
  '  return new TextEncoder().encode(value.normalize("NFKD"));',
  "}",
].join("\n");

function contextualReceiptQuery(): RetrievalQuery {
  return {
    ...routeQuery(),
    text: "Explain the receipt source pipeline: which routine creates the receipt, what Unicode normalization and byte encoding happen before the digest, and how the digest becomes printable text? Cite the conversion and digest implementation.",
  };
}

function contextualReceiptFiles(): Record<string, string> {
  return {
    "lib/receipt.ts": [
      'import { createHash } from "node:crypto";',
      'import { prepareContent as inputBytes } from "./format.js";',
      "export function issueReceipt(receipt: string): string {",
      '  return createHash("sha512").update(inputBytes(receipt)).digest("hex");',
      "}",
    ].join("\n"),
    "lib/format.ts": CONTEXTUAL_CONVERTER_BODY,
    "main.ts":
      'import { issueReceipt } from "./lib/receipt.js";\nexport const sampleReceipt = issueReceipt("sample");',
  };
}

async function contextualTraceFixture(
  files: Record<string, string>,
  query: RetrievalQuery = contextualReceiptQuery(),
  projection?: (index: CodeIntelligenceIndex) => CodeIntelligenceIndex,
  stalePath?: string,
): Promise<Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>> {
  const fs = memFs(WORKSPACE_ROOT, files);
  const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
  const requestContext = createStructuralAdapterRequestContext(
    searchScope,
    GROUNDED_TRACE_SEARCH_LIMITS,
    fs,
    { nowMs: () => NOW },
  );
  if (projection !== undefined) {
    const index = requestContext.codeIntelligenceIndex.bind(requestContext);
    vi.spyOn(requestContext, "codeIntelligenceIndex").mockImplementation(async () =>
      projection(await index()),
    );
  }
  const observed = await requestContext.searchText(query, GROUNDED_TRACE_SEARCH_LIMITS);
  if (stalePath !== undefined) {
    const current = requestContext.isCodeIntelligenceSourceCurrent.bind(requestContext);
    vi.spyOn(requestContext, "isCodeIntelligenceSourceCurrent").mockImplementation(
      (path) => path !== stalePath && current(path),
    );
  }
  return collectDiscoveredSymbolTraceEvidence({
    scope: selectedScope(),
    query,
    anchors: extractAnchors({ text: query.text, maxAnchors: query.text.length }).anchors,
    retrievalIntent: "targeted-code-search",
    searchScope,
    fs,
    nowMs: () => NOW,
    atoms: observed.atoms,
    requestContext,
  });
}

function receiptDelegationFiles(body: string): Record<string, string> {
  return {
    "lib/receipt.ts":
      'import { prepareContent as inputBytes } from "./format.js";\n' +
      `export function issueReceipt(receipt: string, key: string) { ${body} }`,
    "lib/format.ts": CONTEXTUAL_CONVERTER_BODY,
  };
}

function receiptDelegationQuery(): RetrievalQuery {
  return { ...routeQuery(), text: "Explain the receipt source pipeline and its implementation." };
}

function contextualCallableFiles(declaration: string): Record<string, string> {
  return {
    ...contextualReceiptFiles(),
    "lib/receipt.ts": [
      'import { createHash } from "node:crypto";',
      'import { prepareContent as inputBytes } from "./format.js";',
      declaration,
      '  return createHash("sha512").update(inputBytes(receipt)).digest("hex");',
      "};",
    ].join("\n"),
  };
}

const LITERAL_CONVERTER_BODY = [
  "export function toText(value: string): Uint8Array {",
  '  return new TextEncoder().encode(value.normalize("NFKC"));',
  "}",
].join("\n");

function contextualLiteralQuery(): RetrievalQuery {
  return { ...routeQuery(), text: "Explain the cobalt marker handling pipeline." };
}

function contextualLiteralFiles(commentOnly = false): Record<string, string> {
  return {
    "src/operation.ts": [
      'import { toText } from "../lib/output.js";',
      "export function make(value: string): Uint8Array {",
      commentOnly
        ? "  // cobalt-marker: handling pipeline"
        : '  return toText("cobalt-marker:" + value);',
      ...(commentOnly ? ["  return toText(value);"] : []),
      "}",
    ].join("\n"),
    "lib/output.ts": LITERAL_CONVERTER_BODY,
    "reference-notes.md": "Background archive entry.\n".repeat(6000),
  };
}

async function contextualReadFailureTrace(
  failure?: Error,
): Promise<Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>> {
  const storage = memFs(WORKSPACE_ROOT, contextualLiteralFiles());
  let unavailable = false;
  const fs: WorkspaceFs = { ...storage };
  Object.defineProperty(fs, "readFileUtf8SameDescriptor", {
    get(): WorkspaceFs["readFileUtf8SameDescriptor"] {
      if (unavailable && failure !== undefined) throw failure;
      return unavailable ? undefined : storage.readFileUtf8SameDescriptor;
    },
  });
  const query = contextualLiteralQuery();
  const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
  const requestContext = createStructuralAdapterRequestContext(
    searchScope,
    GROUNDED_TRACE_SEARCH_LIMITS,
    fs,
    { nowMs: () => NOW },
  );
  const observed = await requestContext.searchText(query, GROUNDED_TRACE_SEARCH_LIMITS);
  const index = await requestContext.codeIntelligenceIndex();
  expect(
    index.calls.some(
      (call) =>
        call.calleeName === "toText" &&
        call.binding === "lexical" &&
        call.callerDefinition?.name === "make",
    ),
  ).toBe(true);
  unavailable = true;
  return collectDiscoveredSymbolTraceEvidence({
    scope: selectedScope(),
    query,
    anchors: extractAnchors({ text: query.text, maxAnchors: query.text.length }).anchors,
    retrievalIntent: "targeted-code-search",
    searchScope,
    fs,
    nowMs: () => NOW,
    atoms: observed.atoms,
    requestContext,
  });
}

describe("contextual source-definition discovery", () => {
  it("follows a converter from a literal-only contextual source hit in the public pack and numbered prompt", async () => {
    const query = contextualLiteralQuery();
    const log = createBufferedServerLogSink();
    const result = await retrieveConnectedContextPack(
      {
        scope: selectedScope(),
        query,
        workspaceRoot: WORKSPACE_ROOT,
        budget: DEFAULT_EXPLORATION_BUDGET,
      },
      {
        correlationId: "contextual-literal-source-proof",
        fs: memFs(WORKSPACE_ROOT, contextualLiteralFiles()),
        nowMs: () => NOW,
        detectWorkspace: workspaceInfo,
        activityLog: log,
        answerer: { answer: () => Promise.resolve("observed source") },
      },
    );
    expect(
      result.pack.files
        .find((file) => file.scopePath === "src/operation.ts")
        ?.excerpts.some((excerpt) => excerpt.content.includes('toText("cobalt-marker:" + value)')),
    ).toBe(true);
    const converter = result.pack.files.find((file) => file.scopePath === "lib/output.ts");
    expect(converter).toBeDefined();
    expect(converter?.excerpts.map((excerpt) => excerpt.content).join("\n") ?? "").toContain(
      LITERAL_CONVERTER_BODY,
    );
    expect(
      buildGroundedGatewayMessages(query.text, result.pack, (value) => value)
        .map((message) => message.content)
        .join("\n"),
    ).toContain('2 |   return new TextEncoder().encode(value.normalize("NFKC"));');
    expect(
      log.events.find((event) => event.op === "search.connected-context.selection-details")?.extra
        ?.contextualDefinitionSeedCount,
    ).toBeGreaterThan(0);
  });

  it("does not use a comment-only marker as a contextual callable hit", async () => {
    const result = await contextualTraceFixture(
      contextualLiteralFiles(true),
      contextualLiteralQuery(),
    );
    expect(result.contextualDefinitionSeedCount).toBe(0);
    expect(result.atoms).toEqual([]);
  });

  it("retains uncertainty when an observed nonterminal source becomes unreadable", async () => {
    const result = await contextualReadFailureTrace();
    expect(result.atoms).toEqual([]);
    expect(result.uncertainty.some((marker) => marker.kind === "tool-unavailable")).toBe(true);
  });

  it.each([
    new PathDeniedError("Source evidence denied", "src/operation.ts"),
    new CancelledError("Source read cancelled"),
  ])("propagates contextual read authority or cancellation failures: $name", async (failure) => {
    await expect(contextualReadFailureTrace(failure)).rejects.toBe(failure);
  });

  it.each([
    ["arrow", "export const issueReceipt = (receipt: string): string => {"],
    ["function expression", "export const issueReceipt = function (receipt: string): string {"],
  ])(
    "follows an imported converter from a certified named %s contextual root",
    async (_shape, declaration) => {
      const files = contextualCallableFiles(declaration);
      const result = await contextualTraceFixture(files, receiptDelegationQuery(), (index) => {
        const definition = index.symbols.find(
          (symbol) => symbol.scopePath === "lib/receipt.ts" && symbol.name === "issueReceipt",
        );
        const owner = index.calls.find(
          (call) => call.callerPath === "lib/receipt.ts" && call.calleeName === "inputBytes",
        )?.callerDefinition;
        expect(definition?.kind).toBe("constant");
        expect(owner).toEqual({
          name: definition?.name,
          lineRange: definition?.lineRange,
          declarationSpan: definition?.declarationSpan,
        });
        return index;
      });
      expect(result.contextualDefinitionSeedCount).toBeGreaterThan(0);
      const converter = result.routeCoverage?.entries.find(
        (entry) => entry.atom.scopePath === "lib/format.ts",
      );
      expect(converter?.parentWitness?.ownedSourceCall).toBe(true);
      expect(converter?.parentWitness?.lineRange.startLine).toBe(4);
      const root = result.routeCoverage?.entries.find(
        (entry) => entry.atom.scopePath === "lib/receipt.ts",
      );
      expect(root).toBeDefined();
      expect(converter?.parentIdentity).toBe(root?.definitionIdentity);
      const retrieved = await retrieveConnectedContextPack(
        {
          scope: selectedScope(),
          query: contextualReceiptQuery(),
          workspaceRoot: WORKSPACE_ROOT,
          budget: DEFAULT_EXPLORATION_BUDGET,
        },
        {
          correlationId: undefined,
          fs: memFs(WORKSPACE_ROOT, files),
          nowMs: () => NOW,
          detectWorkspace: workspaceInfo,
          answerer: { answer: () => Promise.resolve("observed source") },
        },
      );
      expect(
        retrieved.pack.files
          .find((file) => file.scopePath === "lib/format.ts")
          ?.excerpts.map((excerpt) => excerpt.content)
          .join("\n"),
      ).toContain(CONTEXTUAL_CONVERTER_BODY);
      expect(
        buildGroundedGatewayMessages(
          contextualReceiptQuery().text,
          retrieved.pack,
          (value) => value,
        )
          .map((message) => message.content)
          .join("\n"),
      ).toContain('2 |   return new TextEncoder().encode(value.normalize("NFKD"));');
    },
  );

  it.each([
    'export const issueReceipt = inputBytes("receipt");',
    'export const issueReceipt = "receipt";',
    "export const issueReceipt = (receipt: string) => { const dormant = () => inputBytes(receipt); return receipt; };",
  ])("does not promote an uncertified or overlapping constant owner: %s", async (declaration) => {
    const files = {
      "lib/receipt.ts":
        'import { prepareContent as inputBytes } from "./format.js";\n' + declaration,
      "lib/format.ts": CONTEXTUAL_CONVERTER_BODY,
    };
    const result = await contextualTraceFixture(files, receiptDelegationQuery());
    expect(result.contextualDefinitionSeedCount).toBe(0);
    expect(result.atoms).toEqual([]);
  });

  it.each(["missing", "mismatched", "ambiguous"] as const)(
    "refuses %s callable owner certification for a named arrow",
    async (mode) => {
      const files = contextualCallableFiles(
        "export const issueReceipt = (receipt: string): string => {",
      );
      const result = await contextualTraceFixture(files, receiptDelegationQuery(), (index) => {
        const symbols = mode === "ambiguous" ? [...index.symbols, ...index.symbols] : index.symbols;
        const owner = (
          definition: CodeIntelligenceIndex["calls"][number]["callerDefinition"],
        ): CodeIntelligenceIndex["calls"][number]["callerDefinition"] =>
          mode === "missing" || definition === undefined
            ? undefined
            : mode === "mismatched"
              ? { ...definition, name: definition.name + "Other" }
              : definition;
        return {
          ...index,
          symbols,
          calls: index.calls.map((call) => ({
            ...call,
            callerDefinition: owner(call.callerDefinition),
          })),
          references: index.references.map((reference) => ({
            ...reference,
            referencerDefinition: owner(reference.referencerDefinition),
          })),
        };
      });
      expect(result.contextualDefinitionSeedCount).toBe(0);
      expect(result.atoms).toEqual([]);
    },
  );

  it("retains a lexically discovered caller's imported argument converter in the public pack and numbered prompt", async () => {
    const query = contextualReceiptQuery();
    expect(
      extractAnchors({ text: query.text, maxAnchors: query.text.length }).anchors.every(
        (anchor) => anchor.kind === "literal",
      ),
    ).toBe(true);
    const log = createBufferedServerLogSink();
    const result = await retrieveConnectedContextPack(
      {
        scope: selectedScope(),
        query,
        workspaceRoot: WORKSPACE_ROOT,
        budget: DEFAULT_EXPLORATION_BUDGET,
      },
      {
        correlationId: "contextual-source-definition-proof",
        fs: memFs(WORKSPACE_ROOT, contextualReceiptFiles()),
        nowMs: () => NOW,
        detectWorkspace: workspaceInfo,
        answerer: { answer: () => Promise.resolve("observed source") },
        activityLog: log,
      },
    );
    const caller = result.pack.files.find((file) => file.scopePath === "lib/receipt.ts");
    expect(
      caller?.excerpts.some((excerpt) => excerpt.content.includes("inputBytes(receipt)")),
    ).toBe(true);
    const converter = result.pack.files.find((file) => file.scopePath === "lib/format.ts");
    expect(converter?.excerpts.map((excerpt) => excerpt.content).join("\n")).toContain(
      CONTEXTUAL_CONVERTER_BODY,
    );
    const prompt = buildGroundedGatewayMessages(query.text, result.pack, (value) => value)
      .map((message) => message.content)
      .join("\n");
    expect(prompt).toContain('2 |   return new TextEncoder().encode(value.normalize("NFKD"));');
    const selection = log.events.find(
      (event) => event.op === "search.connected-context.selection-details",
    );
    expect(selection?.extra?.contextualDefinitionSeedCount).toBeGreaterThan(0);
    if (selection === undefined) throw new TypeError("Selection details are required.");
    const line = formatActivityLogProofLine(selection);
    expectActivityLogProof("search.connected-context.selection-details.line", line);
    expect(line).not.toContain("lib/format.ts");
    expect(line).not.toContain("NFKD");
  });

  it("certifies the actual imported argument call from a current contextual owner", async () => {
    const result = await contextualTraceFixture(contextualReceiptFiles(), receiptDelegationQuery());
    expect(result.contextualDefinitionSeedCount).toBeGreaterThan(0);
    const converter = result.routeCoverage?.entries.find(
      (entry) => entry.atom.scopePath === "lib/format.ts",
    );
    expect(converter?.parentWitness?.ownedSourceCall).toBe(true);
    expect(converter?.parentWitness?.targetIdentity).toBe(converter?.definitionIdentity);
    expect(converter?.parentWitness?.lineRange.startLine).toBe(4);
  });

  it.each([
    [
      "shadowed",
      "function inputBytes(value: string) { return value; } return inputBytes(receipt);",
    ],
    ["uninvoked nested", 'function dormant() { return inputBytes("other"); } return receipt;'],
    ["dynamic", "return namespace[key](receipt);"],
  ])("does not follow a %s converter reference", async (_name, body) => {
    const files = receiptDelegationFiles(body);
    if (_name === "dynamic")
      files["lib/receipt.ts"] =
        'import * as namespace from "./format.js";\n' +
        `export function issueReceipt(receipt: string, key: string) { ${body} }`;
    const result = await contextualTraceFixture(files, receiptDelegationQuery());
    expect(result.atoms.some((atom) => atom.scopePath === "lib/format.ts")).toBe(false);
  });

  it("refuses ambiguous imported bindings instead of guessing a target", async () => {
    const files = receiptDelegationFiles("return inputBytes(receipt);");
    files["lib/receipt.ts"] =
      'import { prepareContent as inputBytes } from "./format.js";\n' +
      'import { prepareContent as inputBytes } from "./other.js";\n' +
      "export function issueReceipt(receipt: string) { return inputBytes(receipt); }";
    files["lib/other.ts"] = CONTEXTUAL_CONVERTER_BODY;
    const result = await contextualTraceFixture(files, receiptDelegationQuery());
    expect(result.atoms.some((atom) => atom.scopePath !== "lib/receipt.ts")).toBe(false);
  });

  it("refuses overlapping callable owners on the same physical hit line", async () => {
    const files = receiptDelegationFiles(
      'function dormant() { return inputBytes("other"); } return receipt;',
    );
    const result = await contextualTraceFixture(files, receiptDelegationQuery());
    expect(result.contextualDefinitionSeedCount).toBe(0);
    expect(result.atoms).toEqual([]);
  });

  it("does not use missing declaration spans or stale current owners", async () => {
    const files = receiptDelegationFiles("return inputBytes(receipt);");
    const missing = await contextualTraceFixture(files, receiptDelegationQuery(), (index) => ({
      ...index,
      symbols: index.symbols.map((symbol) => ({ ...symbol, declarationSpan: undefined })),
    }));
    const stale = await contextualTraceFixture(
      files,
      receiptDelegationQuery(),
      undefined,
      "lib/receipt.ts",
    );
    expect(missing.contextualDefinitionSeedCount).toBe(0);
    expect(stale.contextualDefinitionSeedCount).toBe(0);
    expect(missing.atoms).toEqual([]);
    expect(stale.atoms).toEqual([]);
  });

  it("reaches an actually invoked nested continuation without promoting its surrounding context", async () => {
    const files = {
      "lib/receipt.ts": [
        'import { prepareContent as inputBytes } from "./format.js";',
        "export function issueReceipt(receipt: string) {",
        "  function invoked() { return inputBytes(receipt); }",
        "  return invoked();",
        "}",
      ].join("\n"),
      "lib/format.ts": CONTEXTUAL_CONVERTER_BODY,
    };
    const result = await contextualTraceFixture(files, receiptDelegationQuery());
    expect(result.contextualDefinitionSeedCount).toBe(1);
    const converter = result.routeCoverage?.entries.find(
      (entry) => entry.atom.scopePath === "lib/format.ts",
    );
    expect(converter?.parentWitness?.ownedSourceCall).toBe(true);
    expect(converter?.parentWitness?.lineRange.startLine).toBe(3);
  });

  it.each(["literal", "exact-symbol"] as const)(
    "keeps %s queries isolated from contextual intake",
    async (kind) => {
      const result = await contextualTraceFixture(contextualReceiptFiles(), {
        ...routeQuery(),
        kind: kind === "literal" ? "natural-language" : kind,
        text: kind === "literal" ? 'Find "receipt"' : "issueReceipt",
      });
      expect(result.contextualDefinitionSeedCount).toBeUndefined();
      expect(result.atoms).toEqual([]);
    },
  );

  it("does not build a code index for documentation-only lexical hits", async () => {
    let indexCalls = 0;
    const result = await contextualTraceFixture(
      {
        "README.md": "Explain the receipt source pipeline and its implementation.",
      },
      receiptDelegationQuery(),
      (index) => {
        indexCalls += 1;
        return index;
      },
    );
    expect(indexCalls).toBe(0);
    expect(result.contextualDefinitionSeedCount).toBe(0);
  });

  it("does not promote unmatched code around a comment-only lexical hit", async () => {
    const files = {
      "lib/receipt.ts": [
        'import { prepareContent as inputBytes } from "./format.js";',
        "export function unrelated(value: string) {",
        "  // Receipt source pipeline implementation.",
        "  return inputBytes(value);",
        "}",
      ].join("\n"),
      "lib/format.ts": CONTEXTUAL_CONVERTER_BODY,
    };
    const result = await contextualTraceFixture(files, receiptDelegationQuery());
    expect(result.contextualDefinitionSeedCount).toBe(0);
    expect(result.atoms).toEqual([]);
  });
});

interface FsProbe {
  readonly fs: WorkspaceFs;
  readonly accessCount: () => number;
}

function workspaceInfo(): WorkspaceInfo {
  return {
    root: WORKSPACE_ROOT,
    selectedRoot: WORKSPACE_ROOT,
    name: "workspace",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function routeStat(): WorkspaceStat {
  return {
    size: Buffer.byteLength(ROUTE_CONTENT),
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    hardLinkCount: 1,
    mtimeMs: NOW,
    // Production's `fileIdentity` is `dev:ino`: stable per path, independent of content. The
    // bounded reader below re-proves it, so the probe has to publish one.
    fileIdentity: ROUTE_FILE_IDENTITY,
  };
}

// ADR-0005 D1: discovery's read lane uses the bounded same-descriptor primitive when the port
// provides it and reports the read as unavailable when it does not -- the unbounded
// `readFileUtf8` fallback that used to sit beside the byte cap was removed. A probe that omits
// this method therefore loses every excerpt read instead of exercising the reservation and
// deadline paths under test. Mirrors `readFileUtf8SameDescriptor` in keiko-workspace's node port:
// refuse a hard-linked alias, re-prove the caller's expected snapshot, and refuse a file that does
// not fit the cap rather than truncating it.
function routeDescriptorReader(
  touch: () => void,
): NonNullable<WorkspaceFs["readFileUtf8SameDescriptor"]> {
  return (_absolutePath, maxBytes, hardLinkPolicy, expected) => {
    touch();
    const observed = routeStat();
    if (hardLinkPolicy === "reject" && (observed.hardLinkCount ?? 1) > 1) {
      throw new WorkspaceDescriptorReadError("hard-link");
    }
    if (expected.fileIdentity !== observed.fileIdentity || expected.size !== observed.size) {
      throw new WorkspaceDescriptorReadError("changed");
    }
    const sizeBytes = Buffer.byteLength(ROUTE_CONTENT);
    if (sizeBytes > Math.max(0, Math.floor(maxBytes))) {
      throw new WorkspaceDescriptorReadError("too-large", sizeBytes);
    }
    return { rawText: ROUTE_CONTENT, sizeBytes, stat: observed };
  };
}

function fsProbe(): FsProbe {
  let accesses = 0;
  const touch = (): void => {
    accesses += 1;
  };
  const stat = (): WorkspaceStat => {
    touch();
    return routeStat();
  };
  return {
    fs: {
      readFileUtf8: (): string => {
        touch();
        return ROUTE_CONTENT;
      },
      readFileUtf8SameDescriptor: routeDescriptorReader(touch),
      stat,
      readDir: (): readonly never[] => {
        touch();
        return [];
      },
      realPath: (absolutePath): string => {
        touch();
        return absolutePath;
      },
      exists: (): boolean => {
        touch();
        return true;
      },
      readFileBytes: (_absolutePath, maxBytes): Promise<Uint8Array> => {
        touch();
        return Promise.resolve(new TextEncoder().encode(ROUTE_CONTENT).subarray(0, maxBytes));
      },
    },
    accessCount: (): number => accesses,
  };
}

function selectedScope(): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "scope-route",
    workspaceRoot: WORKSPACE_ROOT,
    kind: "workspace-root",
    relativePaths: [],
    conversationId: undefined,
    connectedAtMs: NOW,
    explicitConnection: true,
  };
}

function routeQuery(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "Trace POST /api/items from route to handler",
    caseSensitive: false,
    maxResults: 20,
    emittedAtMs: NOW,
  };
}

function routeAtom(): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "route-atom",
    scopePath: ROUTE_PATH,
    lineRange: { startLine: 2, endLine: 2 },
    score: 1,
    provenance: {
      kind: "lexical-search",
      tool: "repo.searchText",
      queryFingerprint: "route-query",
    },
    redactionState: "redacted",
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

function registeredHandlerFs(): WorkspaceFs {
  return memFs(WORKSPACE_ROOT, {
    [ROUTE_PATH]: ROUTE_CONTENT,
    "src/implementation.ts": "export function handlePostItem() { return true; }",
  });
}

function deadlineTrackedFs(nowMs: () => number, observedLateRead: () => void): WorkspaceFs {
  const baseFs = registeredHandlerFs();
  const reader = baseFs.readFileUtf8SameDescriptor;
  if (reader === undefined) throw new TypeError("fixture descriptor reader missing");
  return {
    ...baseFs,
    readFileUtf8SameDescriptor: (
      path,
      maxBytes,
      policy,
      expected,
    ): ReturnType<NonNullable<WorkspaceFs["readFileUtf8SameDescriptor"]>> => {
      if (nowMs() >= 10) observedLateRead();
      return reader(path, maxBytes, policy, expected);
    },
  };
}

describe("collectDiscoveredSymbolTraceEvidence", () => {
  it("forwards cancellation before reading discovery excerpts", async () => {
    const probe = fsProbe();
    const controller = new AbortController();
    controller.abort();
    const searchScope: SearchScope = {
      workspace: workspaceInfo(),
      scopeId: "scope-route",
      relativePaths: [],
    };

    await expect(
      collectDiscoveredSymbolTraceEvidence({
        scope: selectedScope(),
        query: routeQuery(),
        anchors: [],
        retrievalIntent: "targeted-code-search",
        searchScope,
        fs: probe.fs,
        nowMs: () => NOW,
        atoms: [routeAtom()],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(probe.accessCount()).toBe(0);
  });

  it("does not start a discovered-symbol search without a reserved search call", async () => {
    const fs = registeredHandlerFs();
    const searchScope: SearchScope = {
      workspace: workspaceInfo(),
      scopeId: "scope-route",
      relativePaths: [],
    };
    const requestContext = createStructuralAdapterRequestContext(
      searchScope,
      GROUNDED_TRACE_SEARCH_LIMITS,
      fs,
      { nowMs: () => NOW },
    );
    let reservations = 0;

    const result = await collectDiscoveredSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs: fs,
      nowMs: () => NOW,
      atoms: [routeAtom()],
      requestContext,
      tryReserveSearchCall: () => {
        reservations += 1;
        return false;
      },
    });

    expect(reservations).toBe(1);
    expect(requestContext.diagnostics().textSearchCount).toBe(0);
    expect(result.atoms).toEqual([]);
    expect(result.uncertainty).toHaveLength(1);
    expect(result.uncertainty[0]?.claim).toContain("search-budget");
  });

  it("surfaces incomplete discovered-symbol searches after the shared deadline expires", async () => {
    let currentMs = 0;
    let lateReads = 0;
    const fs = deadlineTrackedFs(
      () => currentMs,
      () => {
        lateReads += 1;
      },
    );
    const searchScope: SearchScope = {
      workspace: workspaceInfo(),
      scopeId: "scope-route",
      relativePaths: [],
    };
    const requestContext = createStructuralAdapterRequestContext(
      searchScope,
      GROUNDED_TRACE_SEARCH_LIMITS,
      fs,
      { nowMs: () => currentMs, deadlineAtMs: 10 },
    );

    const result = await collectDiscoveredSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs: fs,
      nowMs: () => currentMs,
      atoms: [routeAtom()],
      requestContext,
      tryReserveSearchCall: () => {
        currentMs = 11;
        return true;
      },
    });

    expect(lateReads).toBe(0);
    expect(requestContext.diagnostics().textSearchCount).toBe(1);
    expect(result.atoms).toEqual([]);
    expect(result.uncertainty).toHaveLength(1);
    expect(result.uncertainty[0]?.kind).toBe("budget-clipped");
    expect(result.uncertainty[0]?.claim).toContain("Discovered-symbol trace search was incomplete");
    expect(JSON.stringify(result.uncertainty)).not.toContain(ROUTE_CONTENT);
  });
});

describe("collectFollowSymbolTraceEvidence", () => {
  it("does not reserve graph work for directly requested implementation facts", async () => {
    const probe = fsProbe();
    let reservations = 0;
    const result = await collectFollowSymbolTraceEvidence({
      scope: selectedScope(),
      query: {
        ...routeQuery(),
        text: "Where are WindowFrame and ChatPanel implemented, and what values do they return?",
      },
      anchors: [
        { term: "windowframe", weight: 0.85, kind: "identifier" },
        { term: "chatpanel", weight: 0.85, kind: "identifier" },
      ],
      retrievalIntent: "targeted-code-search",
      searchScope: { workspace: workspaceInfo(), scopeId: "direct-facts", relativePaths: [] },
      fs: probe.fs,
      nowMs: () => NOW,
      tryReserveSearchCall: () => {
        reservations += 1;
        return false;
      },
    });
    expect(result).toEqual({ atoms: [], uncertainty: [] });
    expect(reservations).toBe(0);
    expect(probe.accessCount()).toBe(0);
  });

  it("does not start the trace when its search call cannot be reserved", async () => {
    const probe = fsProbe();
    const searchScope: SearchScope = {
      workspace: workspaceInfo(),
      scopeId: "scope-route",
      relativePaths: [],
    };
    let reservations = 0;

    const result = await collectFollowSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [{ term: "handlePostItem", weight: 0.9, kind: "identifier" }],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs: probe.fs,
      nowMs: () => NOW,
      tryReserveSearchCall: () => {
        reservations += 1;
        return false;
      },
    });

    expect(result).toEqual({ atoms: [], uncertainty: [] });
    expect(reservations).toBe(1);
    expect(probe.accessCount()).toBe(0);
  });
});

describe("registered endpoint handler frontier", () => {
  it.each([0, 12])(
    "uses the exact registration with %i client calls before unrelated api/http filenames",
    async (clientCalls) => {
      const files = {
        "src/entry.ts": [
          'import { handleItem } from "./implementation.js";',
          'const routes = [{ method: "GET", pattern: "/api/items", handler: wrongMethod },',
          ' { method: "POST", pattern: "/api/other", handler: wrongPath },',
          ' { method: "POST", pattern: "/api/items", handler: handleItem }];',
        ].join("\n"),
        "src/implementation.ts": [
          "export function handleItem() { return admitItem(); }",
          "function admitItem() { return 1; }",
        ].join("\n"),
        "src/api.ts": Array.from({ length: 12 }, () =>
          clientCalls > 0
            ? 'fetch("/api/items", { method: "POST" });'
            : "export const unrelated = 1;",
        ).join("\n"),
      };
      const fs = memFs(WORKSPACE_ROOT, files);
      const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
      const requestContext = createStructuralAdapterRequestContext(
        searchScope,
        GROUNDED_TRACE_SEARCH_LIMITS,
        fs,
        { nowMs: () => NOW },
      );
      const endpointAtoms = await endpointContractAdapter.lookup(
        searchScope,
        { ...routeQuery(), maxResults: 100 },
        GROUNDED_TRACE_SEARCH_LIMITS,
        fs,
        { requestContext },
      );
      const unrelated = Array.from({ length: 12 }, (_value, index) => ({
        ...routeAtom(),
        stableId: `unrelated-${String(index)}`,
        scopePath: "src/api.ts",
        lineRange: { startLine: index + 1, endLine: index + 1 },
        score: 1,
      }));
      let reservations = 0;
      const result = await collectDiscoveredSymbolTraceEvidence({
        scope: selectedScope(),
        query: routeQuery(),
        anchors: [],
        retrievalIntent: "targeted-code-search",
        searchScope,
        fs,
        nowMs: () => NOW,
        atoms: [...unrelated, ...endpointAtoms],
        requestContext,
        tryReserveSearchCall: () => {
          reservations += 1;
          return true;
        },
      });
      expect(
        result.atoms.some(
          (atom) =>
            atom.scopePath === "src/implementation.ts" &&
            atom.provenance.tool === "discovered-symbol-definition",
        ),
      ).toBe(true);
      expect(
        result.atoms
          .filter((atom) => atom.scopePath === "src/entry.ts")
          .every((atom) => atom.lineRange?.startLine === 4),
      ).toBe(true);
      expect(
        endpointAtoms.some(
          (atom) => atom.scopePath === "src/entry.ts" && atom.lineRange?.startLine === 4,
        ),
      ).toBe(true);
      expect(reservations).toBeGreaterThan(0);
      expect(reservations).toBeLessThanOrEqual(8);
    },
  );
});

describe("fluent endpoint handler certification", () => {
  it.each(["factory()", "handlers.other"])(
    "does not promote a dynamic fluent handler: %s",
    async (handler) => {
      const fs = memFs(WORKSPACE_ROOT, {
        "src/routes.ts": `router.post("/api/items", ${handler});`,
      });
      const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
      let reservations = 0;
      const result = await collectDiscoveredSymbolTraceEvidence({
        scope: selectedScope(),
        query: routeQuery(),
        anchors: [],
        retrievalIntent: "targeted-code-search",
        searchScope,
        fs,
        nowMs: () => NOW,
        atoms: [routeAtom()],
        tryReserveSearchCall: () => {
          reservations += 1;
          return false;
        },
      });
      expect(result.atoms).toEqual([]);
      expect(reservations).toBe(0);
    },
  );
});

describe("admitted multiline handler definitions", () => {
  it("traces actual body calls while excluding comment and string examples", async () => {
    const fs = memFs(WORKSPACE_ROOT, {
      "src/routes.ts": ROUTE_CONTENT,
      "src/implementation.ts": [
        "export function handlePostItem(",
        "  input: unknown,",
        ") {",
        "  // fakeOne(); fakeTwo(); fakeThree(); fakeFour();",
        '  const example = "fakeOne(); fakeTwo(); fakeThree(); fakeFour();";',
        "  return admitItem(input);",
        "}",
        "export function admitItem(input: unknown) { return input; }",
        "function fakeOne() {}",
        "function fakeTwo() {}",
        "function fakeThree() {}",
        "function fakeFour() {}",
      ].join("\n"),
    });
    const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
    const requestContext = createStructuralAdapterRequestContext(
      searchScope,
      GROUNDED_TRACE_SEARCH_LIMITS,
      fs,
      { nowMs: () => NOW },
    );
    const result = await collectDiscoveredSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs,
      nowMs: () => NOW,
      atoms: [routeAtom()],
      requestContext,
    });
    const definitions = result.atoms.filter(
      (atom) => atom.provenance.tool === "discovered-symbol-definition",
    );
    expect(
      definitions.some((atom) => atom.lineRange?.startLine === 1 && atom.lineRange.endLine === 7),
    ).toBe(true);
    expect(definitions.some((atom) => atom.lineRange?.startLine === 8)).toBe(true);
    expect(definitions.some((atom) => (atom.lineRange?.startLine ?? 0) >= 9)).toBe(false);
    expect(requestContext.diagnostics().textSearchCount).toBe(1);
    expect(requestContext.diagnostics().codeIndexBuildCount).toBe(1);
  });
});

describe("symbol declaration source binding", () => {
  it("does not reuse an old AST extent after the indexed file changes", async () => {
    const files = {
      "src/routes.ts": ROUTE_CONTENT,
      "src/implementation.ts": [
        "export function handlePostItem(input: unknown) {",
        " const first = input;",
        " const second = first;",
        " const third = second;",
        " return admitItem(third);",
        "}",
        "export function admitItem(input: unknown) { return input; }",
      ].join("\n"),
      "src/other.ts": "export function unrelatedOperation() { return false; }",
    };
    const fs = memFs(WORKSPACE_ROOT, files);
    const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
    const requestContext = createStructuralAdapterRequestContext(
      searchScope,
      GROUNDED_TRACE_SEARCH_LIMITS,
      fs,
      { nowMs: () => NOW },
    );
    await requestContext.codeIntelligenceIndex();
    files["src/implementation.ts"] = [
      "export function handlePostItem(input: unknown) {",
      " return input;",
      "}",
      "export function otherHandler() {",
      " return unrelatedOperation();",
      "}",
      "export function admitItem(input: unknown) { return input; }",
    ].join("\n");
    const result = await collectDiscoveredSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs,
      nowMs: () => NOW,
      atoms: [routeAtom()],
      requestContext,
    });
    expect(
      result.atoms.some(
        (atom) =>
          atom.scopePath === "src/other.ts" &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toBe(false);
    expect(requestContext.diagnostics().codeIndexBuildCount).toBe(1);
  });

  it("does not certify declarations contained only in comments or quoted examples", async () => {
    const files: Record<string, string> = {
      "src/routes.ts": ROUTE_CONTENT.replace("./implementation.js", "./zz-implementation.js"),
      "src/zz-implementation.ts": "export function handlePostItem() { return true; }",
      "src/aa-string.ts":
        'export const example = "function handlePostItem() { return fakeCall(); }";',
    };
    files["src/ab-comment-decoy.go"] = "// func handlePostItem() { fakeCall() }";
    files["src/ab-comment-decoy.py"] = "# def handlePostItem(): fakeCall()";
    files["src/ab-comment-block.ts"] = "/*\nfunction handlePostItem() { fakeCall(); }\n*/";
    files["src/ab-comment-template.ts"] =
      "const example = `\nfunction handlePostItem() { fakeCall(); }\n`;";
    for (let index = 0; index < 12; index += 1)
      files[`src/ab-comment-${String(index)}.ts`] =
        "// function handlePostItem() { return fakeCall(); }";
    const fs = memFs(WORKSPACE_ROOT, files);
    const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
    const requestContext = createStructuralAdapterRequestContext(
      searchScope,
      GROUNDED_TRACE_SEARCH_LIMITS,
      fs,
      { nowMs: () => NOW },
    );
    const result = await collectDiscoveredSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs,
      nowMs: () => NOW,
      atoms: [routeAtom()],
      requestContext,
    });
    expect(
      result.atoms.some(
        (atom) =>
          atom.scopePath === "src/zz-implementation.ts" &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toBe(true);
    expect(
      result.atoms.filter(
        (atom) =>
          (atom.scopePath.includes("comment-") || atom.scopePath.endsWith("aa-string.ts")) &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toEqual([]);
  });
});

async function traceFixture(
  files: Record<string, string>,
  reserve: () => boolean = () => true,
  withContext = true,
  query: RetrievalQuery = routeQuery(),
  indexProjection?: (index: CodeIntelligenceIndex) => CodeIntelligenceIndex,
): Promise<Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>> {
  const fs = memFs(WORKSPACE_ROOT, { "src/routes.ts": ROUTE_CONTENT, ...files });
  const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
  const requestContext = withContext
    ? createStructuralAdapterRequestContext(searchScope, GROUNDED_TRACE_SEARCH_LIMITS, fs, {
        nowMs: () => NOW,
      })
    : undefined;
  if (requestContext !== undefined && indexProjection !== undefined) {
    const originalIndex = requestContext.codeIntelligenceIndex.bind(requestContext);
    vi.spyOn(requestContext, "codeIntelligenceIndex").mockImplementation(async () =>
      indexProjection(await originalIndex()),
    );
  }
  return collectDiscoveredSymbolTraceEvidence({
    scope: selectedScope(),
    query,
    anchors: [],
    retrievalIntent: "targeted-code-search",
    searchScope,
    fs,
    nowMs: () => NOW,
    atoms: [routeAtom()],
    requestContext,
    tryReserveSearchCall: reserve,
  });
}

async function actualRouteTrace(
  registration: string,
  implementations: Record<string, string>,
): Promise<Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>> {
  const fs = memFs(WORKSPACE_ROOT, { "src/routes.ts": registration, ...implementations });
  const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
  const requestContext = createStructuralAdapterRequestContext(
    searchScope,
    GROUNDED_TRACE_SEARCH_LIMITS,
    fs,
    { nowMs: () => NOW },
  );
  const observed = await requestContext.searchText(routeQuery(), GROUNDED_TRACE_SEARCH_LIMITS);
  return collectDiscoveredSymbolTraceEvidence({
    scope: selectedScope(),
    query: routeQuery(),
    anchors: [],
    retrievalIntent: "targeted-code-search",
    searchScope,
    fs,
    nowMs: () => NOW,
    atoms: observed.atoms,
    requestContext,
  });
}

const DECOY_ROUTE_IMPLEMENTATIONS = {
  "src/actual.ts": "export function handlePostItem() { return true; }",
  "src/decoy.ts":
    "export function handlePostItem() { return unrelatedDelegate(); }\nfunction unrelatedDelegate() { return false; }",
};

function certifiedPaths(
  result: Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>,
): readonly string[] {
  return result.atoms
    .filter((atom) => atom.provenance.tool === "discovered-symbol-definition")
    .map((atom) => atom.scopePath);
}

describe("source-bound actual route handler identity", () => {
  it.each([
    'import { handlePostItem } from "./actual.js";\nrouter.post("/api/items", handlePostItem);',
    'import { handlePostItem } from "./actual.js";\nconst table = [{ method: "POST", path: "/api/items", handler: handlePostItem }];',
    'function handlePostItem() { return true; }\nrouter.post("/api/items", handlePostItem);',
  ])("does not attribute an unrelated same-named handler: %s", async (registration) => {
    const result = await actualRouteTrace(registration, DECOY_ROUTE_IMPLEMENTATIONS);
    expect(certifiedPaths(result)).not.toContain("src/decoy.ts");
    expect(certifiedPaths(result)).toContain(
      registration.startsWith("import") ? "src/actual.ts" : "src/routes.ts",
    );
  });

  it("resolves the actual imported alias and excludes the local-name decoy", async () => {
    const result = await actualRouteTrace(
      'import { actualHandler as handlePostItem } from "./actual.js";\nrouter.post("/api/items", handlePostItem);',
      {
        ...DECOY_ROUTE_IMPLEMENTATIONS,
        "src/actual.ts": "export function actualHandler() { return true; }",
      },
    );
    expect(certifiedPaths(result)).toContain("src/actual.ts");
    expect(certifiedPaths(result)).not.toContain("src/decoy.ts");
  });

  it.each([
    'import { handlePostItem } from "./actual.js";\nfunction register(handlePostItem: unknown) { router.post("/api/items", handlePostItem); }',
    'router.post("/api/items", handlePostItem);',
  ])("does not certify an unresolved or shadowed route identifier: %s", async (registration) => {
    const result = await actualRouteTrace(registration, DECOY_ROUTE_IMPLEMENTATIONS);
    expect(certifiedPaths(result)).toEqual([]);
  });

  it("does not follow a never-invoked nested definition on the same physical line", async () => {
    const result = await actualRouteTrace(
      'import { handlePostItem } from "./actual.js";\nrouter.post("/api/items", handlePostItem);',
      {
        "src/actual.ts":
          'import { actualDelegate, unrelatedDelegate } from "./delegates.js";\nexport function handlePostItem() { function neverCalled() { unrelatedDelegate(); } return actualDelegate(); }',
        "src/delegates.ts":
          "export function actualDelegate() { return true; }\nexport function unrelatedDelegate() { return false; }",
      },
    );
    const delegates = result.atoms.filter(
      (atom) =>
        atom.scopePath === "src/delegates.ts" &&
        atom.provenance.tool === "discovered-symbol-definition",
    );
    expect(delegates.some((atom) => atom.lineRange?.startLine === 1)).toBe(true);
    expect(delegates.some((atom) => atom.lineRange?.startLine === 2)).toBe(false);
    expect(
      result.atoms.some(
        (atom) => atom.scopePath === "src/delegates.ts" && atom.lineRange?.startLine === 2,
      ),
    ).toBe(false);
  });

  it("follows an actually invoked nested definition on the same physical line", async () => {
    const result = await actualRouteTrace(
      'import { handlePostItem } from "./actual.js";\nrouter.post("/api/items", handlePostItem);',
      {
        "src/actual.ts":
          'import { actualDelegate } from "./delegates.js";\nexport function handlePostItem() { function actualNested() { return actualDelegate(); } return actualNested(); }',
        "src/delegates.ts": "export function actualDelegate() { return true; }",
      },
    );
    expect(certifiedPaths(result)).toContain("src/delegates.ts");
  });
});

const REFERENCE_SCOPE_FACT = "const selectedScopeGuard = true; return selectedScopeGuard;";
const REFERENCE_SCOPE_BODY = `export function observedScopeAdmission() { ${REFERENCE_SCOPE_FACT} }`;

async function referenceSelectionFixture(referenceOnlyCrowding = false): Promise<{
  readonly fs: WorkspaceFs;
  readonly searchScope: SearchScope;
  readonly result: Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>;
}> {
  const fs = memFs(WORKSPACE_ROOT, {
    "src/routes.ts": ROUTE_CONTENT,
    "src/implementation.ts":
      'import { earlyBookkeeping, observedScopeAdmission } from "./helpers.js";\nexport function handlePostItem() { ' +
      (referenceOnlyCrowding
        ? "return () => { earlyBookkeeping(); return observedScopeAdmission(); };"
        : "earlyBookkeeping(); return () => observedScopeAdmission();") +
      " }",
    "src/helpers.ts": [
      `export function earlyBookkeeping() { const detail = "${"x".repeat(600)}"; return detail; }`,
      ...Array.from({ length: referenceOnlyCrowding ? 18 : 38 }, () => ""),
      REFERENCE_SCOPE_BODY,
    ].join("\n"),
  });
  const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
  const requestContext = createStructuralAdapterRequestContext(
    searchScope,
    GROUNDED_TRACE_SEARCH_LIMITS,
    fs,
    { nowMs: () => NOW },
  );
  const result = await collectDiscoveredSymbolTraceEvidence({
    scope: selectedScope(),
    query: { ...routeQuery(), text: "Trace POST /api/items through scope admission" },
    anchors: [],
    retrievalIntent: "targeted-code-search",
    searchScope,
    fs,
    nowMs: () => NOW,
    atoms: [routeAtom()],
    requestContext,
  });
  return { fs, searchScope, result };
}

async function readReferenceSelectionFixture(
  referenceOnlyCrowding = false,
  representation: "current" | "missing" | "heuristic" | "wrong-target" = "current",
): Promise<Awaited<ReturnType<typeof _readKeptExcerptsForTests>>> {
  const { fs, searchScope, result } = await referenceSelectionFixture(referenceOnlyCrowding);
  return _readKeptExcerptsForTests(["src/helpers.ts"], {
    searchScope,
    fs,
    budget: {
      ...DEFAULT_EXPLORATION_BUDGET,
      excerptBytesMax: Buffer.byteLength(REFERENCE_SCOPE_BODY) + 1,
    },
    initialUsage: {
      searchCalls: 0,
      filesRead: 0,
      excerptBytes: 0,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 0,
      rerankCalls: 0,
    },
    atomsByPath: new Map([
      [
        "src/helpers.ts",
        result.atoms
          .filter((atom) => atom.scopePath === "src/helpers.ts")
          .map((atom) => referenceRepresentation(atom, representation)),
      ],
    ]),
    nowMs: () => NOW,
    deadlineAtMs: Number.POSITIVE_INFINITY,
  });
}

function referenceRepresentation(
  atom: EvidenceAtom,
  representation: "current" | "missing" | "heuristic" | "wrong-target",
): EvidenceAtom {
  if (representation === "current" || atom.edge?.kind !== "reference") return atom;
  if (representation === "missing") return { ...atom, edge: undefined };
  if (representation === "heuristic")
    return { ...atom, edge: { ...atom.edge, confidence: "heuristic" } };
  return {
    ...atom,
    edge: { ...atom.edge, target: { ...atom.edge.target, scopePath: "src/unrelated.ts" } },
  };
}

function expectReferenceStableIdentity(atom: EvidenceAtom): void {
  expect(atom.stableId).toBe(
    evidenceAtomStableId({
      scopeId: selectedScope().scopeId,
      scopePath: atom.scopePath,
      lineRange: atom.lineRange,
      edge: atom.edge,
      provenanceKind: atom.provenance.kind,
      provenanceTool: atom.provenance.tool,
      queryFingerprint: atom.provenance.queryFingerprint,
    }),
  );
}

describe("source-bound AST route continuation", () => {
  it("retains an actual reference-target declaration in the existing definition ranking signal", async () => {
    const { result } = await referenceSelectionFixture();
    const references = result.atoms.filter(
      (atom) => atom.scopePath === "src/helpers.ts" && atom.lineRange?.startLine === 40,
    );
    expect(references).not.toEqual([]);
    const ranking = rankCandidates({
      atoms: references,
      anchors: [],
      context: { retrievalIntent: "targeted-code-search" },
    });
    expect(
      ranking.kept
        .find((candidate) => candidate.scopePath === "src/helpers.ts")
        ?.signals.some((signal) => signal.name === "symbol-definition"),
    ).toBe(true);
    expect(
      result.uncertainty.some((marker) => marker.claim.includes("source-graph-incomplete")),
    ).toBe(true);
  });

  it("reads the actual late reference-target scope fact before unrelated invoked bookkeeping under the same byte grant", async () => {
    const reads = await readReferenceSelectionFixture();
    expect(
      reads.excerpts
        .get("src/helpers.ts")
        ?.some((window) => window.content.includes(REFERENCE_SCOPE_FACT)),
    ).toBe(true);
    expect(
      reads.excerpts
        .get("src/helpers.ts")
        ?.reduce((bytes, window) => bytes + Buffer.byteLength(window.content), 0),
    ).toBeLessThanOrEqual(Buffer.byteLength(REFERENCE_SCOPE_BODY) + 1);
  });

  it("reads a complete reference-target scope body without coalescing unrelated padded declaration context", async () => {
    const reads = await readReferenceSelectionFixture(true);
    expect(
      reads.excerpts
        .get("src/helpers.ts")
        ?.some((window) => window.content.includes(REFERENCE_SCOPE_FACT)),
    ).toBe(true);
  });

  it.each(["missing", "heuristic", "wrong-target"] as const)(
    "preserves legacy trailing context for a %s reference representation",
    async (representation) => {
      const reads = await readReferenceSelectionFixture(true, representation);
      expect(
        reads.excerpts
          .get("src/helpers.ts")
          ?.some((window) => window.content.includes(REFERENCE_SCOPE_FACT)),
      ).toBe(false);
    },
  );

  it("binds an observed reference's source location in its canonical stable identity", async () => {
    const trace = (
      separator: string,
    ): Promise<Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>> =>
      traceFixture({
        "src/implementation.ts": `import { actualDelegate } from "./actual.js";\n${separator}export function handlePostItem() { return () => actualDelegate(); }`,
        "src/actual.ts": "export function actualDelegate() { return true; }",
      });
    const first = (await trace("")).atoms.find((atom) => atom.scopePath === "src/actual.ts");
    const moved = (await trace("\n")).atoms.find((atom) => atom.scopePath === "src/actual.ts");
    expect(first).toBeDefined();
    expect(moved).toBeDefined();
    expect(first?.edge?.source.lineRange?.startLine).toBe(2);
    expect(moved?.edge?.source.lineRange?.startLine).toBe(3);
    expect(first?.stableId).not.toBe(moved?.stableId);
  });

  it("preserves observed query relevance for a current source-reference body", async () => {
    const relevant =
      "export function observedScopeAdmission() { const admittedScope = selectedScope; return admittedScope; }";
    const unrelated = "export function otherOperation() { return false; }";
    const query = {
      ...routeQuery(),
      text: "Trace a connected-folder question from POST /api/items through scope admission, recursive candidate discovery and prompt fitting. Cite implementation files and lines. Keep the answer under 200 words.",
    };
    const matcher = buildMatcher(query);
    const observedScore = (body: string): number =>
      repositorySourceMaxLineScore(
        repositorySourceLines(body, "src/helpers.ts").map((line) => ({
          score: matcher.match(line.raw, line),
        })),
      );
    expect(observedScore(relevant)).toBeGreaterThan(observedScore(unrelated));
    const result = await traceFixture(
      {
        "src/implementation.ts":
          'import { observedScopeAdmission, otherOperation } from "./helpers.js";\nexport function handlePostItem() { return () => { otherOperation(); return observedScopeAdmission(); }; }',
        "src/helpers.ts": `${unrelated}\n${relevant}`,
      },
      () => true,
      true,
      query,
    );
    const references = result.atoms.filter((atom) => atom.scopePath === "src/helpers.ts");
    const relevantAtom = references.find((atom) => atom.lineRange?.startLine === 2);
    const unrelatedAtom = references.find((atom) => atom.lineRange?.startLine === 1);
    expect(relevantAtom).toBeDefined();
    expect(unrelatedAtom).toBeDefined();
    expect(relevantAtom?.score).toBeGreaterThan(unrelatedAtom?.score ?? Infinity);
  });

  it.each([
    "export function handlePostItem() { return serialize(() => actualDelegate()); }\nfunction serialize(operation: () => unknown) { return operation(); }",
    "export function handlePostItem() { return () => actualDelegate(); }",
  ])("retains an observed inline callable as a source reference: %s", async (body) => {
    const result = await traceFixture({
      "src/implementation.ts": `import { actualDelegate } from "./actual.js";\n${body}`,
      "src/actual.ts":
        'import { finalDelegate } from "./final.js";\nexport function actualDelegate() { return finalDelegate(); }',
      "src/final.ts": "export function finalDelegate() { return true; }",
      "src/decoy.ts": "export function actualDelegate() { return false; }",
    });
    const references = result.atoms.filter((atom) => atom.scopePath === "src/actual.ts");
    expect(references).not.toEqual([]);
    expect(
      references.every((atom) => atom.provenance.tool === "discovered-symbol-definition"),
    ).toBe(true);
    expect(references.every((atom) => atom.edge?.kind === "reference")).toBe(true);
    expect(references.every((atom) => atom.edge?.confidence === "resolved")).toBe(true);
    references.forEach(expectReferenceStableIdentity);
    expect(references[0]?.edge?.source).toEqual({
      scopePath: "src/implementation.ts",
      lineRange: { startLine: 2, endLine: 2 },
      symbol: "actualDelegate",
    });
    expect(references[0]?.edge?.target).toEqual({
      scopePath: "src/actual.ts",
      lineRange: { startLine: 2, endLine: 2 },
      symbol: "actualDelegate",
    });
    expect(
      result.atoms
        .filter((atom) => atom.scopePath === "src/final.ts")
        .every((atom) => atom.edge?.kind === "reference"),
    ).toBe(true);
    expect(result.atoms.some((atom) => atom.scopePath === "src/final.ts")).toBe(true);
    expect(result.atoms.some((atom) => atom.scopePath === "src/decoy.ts")).toBe(false);
    expect(
      result.uncertainty.some((marker) => marker.claim.includes("source-graph-incomplete")),
    ).toBe(true);
  });

  it("counts a source-reference target inside the existing total query capacity", async () => {
    const result = await traceFixture(
      {
        "src/implementation.ts":
          'import { actualDelegate } from "./actual.js";\nexport function handlePostItem() { return () => actualDelegate(); }',
        "src/actual.ts": "export function actualDelegate() { return true; }",
      },
      () => true,
      true,
      { ...routeQuery(), maxResults: 1 },
    );
    expect(result.atoms.some((atom) => atom.scopePath === "src/actual.ts")).toBe(false);
    expect(result.uncertainty.some((marker) => marker.claim.includes("frontier-width"))).toBe(true);
  });

  it("does not discover a reference outside the actual byte-clipped callback body", async () => {
    const result = await traceFixture({
      "src/implementation.ts":
        'import { actualDelegate } from "./actual.js";\n' +
        `export function handlePostItem() { return () => { const example = "${"x".repeat(16000)}"; return actualDelegate(); }; }`,
      "src/actual.ts": "export function actualDelegate() { return true; }",
    });
    expect(result.atoms.some((atom) => atom.scopePath === "src/actual.ts")).toBe(false);
    expect(result.uncertainty.some((marker) => marker.claim.includes("excerpt-clipped"))).toBe(
      true,
    );
  });

  it("reuses an actual resolved alias target without certifying a same-named decoy", async () => {
    const result = await traceFixture({
      "src/implementation.ts":
        'import { executeItem as ask } from "./actual.js";\nexport function handlePostItem() { const result = ask(); return result; }',
      "src/actual.ts": "export function executeItem() { return true; }",
      "src/decoy.ts": "export function executeItem() { return false; }",
    });
    const paths = result.atoms
      .filter((atom) => atom.provenance.tool === "discovered-symbol-definition")
      .map((atom) => atom.scopePath);
    expect(paths).toContain("src/actual.ts");
    expect(paths).not.toContain("src/decoy.ts");
  });

  it("does not traverse a call after the byte-clipped tail of a single physical line", async () => {
    const result = await traceFixture({
      "src/implementation.ts": `export function handlePostItem() { const example = "${"x".repeat(16000)}"; return hiddenTail(); }`,
      "src/hidden.ts": "export function hiddenTail() { return true; }",
    });
    expect(
      result.atoms.some(
        (atom) =>
          atom.scopePath === "src/hidden.ts" &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toBe(false);
    expect(result.uncertainty.some((marker) => marker.claim.includes("excerpt-clipped"))).toBe(
      true,
    );
  });

  it("reports the unsearched handler frontier when its existing search grant is refused", async () => {
    const result = await traceFixture(
      { "src/implementation.ts": "export function handlePostItem() { return true; }" },
      () => false,
    );
    expect(result.atoms).toEqual([]);
    expect(result.uncertainty.some((marker) => marker.claim.includes("search-budget"))).toBe(true);
  });

  it("keeps fragment-only declarations uncertified without an admitted AST context", async () => {
    const result = await traceFixture(
      {
        "src/comment.ts": "/*\nfunction handlePostItem() { fakeCall(); }\n*/",
        "src/template.ts": "const example = `\nfunction handlePostItem() { fakeCall(); }\n`;",
        "src/implementation.ts": "export function handlePostItem() { return true; }",
      },
      () => true,
      false,
    );
    expect(result.atoms.every((atom) => atom.provenance.tool === "structural-edge-target")).toBe(
      true,
    );
  });
});

describe("bounded sibling delegation frontier", () => {
  it("keeps a real delegate when another handler sibling contains many early-return helpers", async () => {
    const failures = Array.from(
      { length: 20 },
      (_value, index) => `if (Math.random()) return refused${String(index)}();`,
    );
    const declarations = Array.from(
      { length: 20 },
      (_value, index) => `function refused${String(index)}() { return undefined; }`,
    );
    const result = await traceFixture({
      "src/implementation.ts": [
        'import { actualDelegate } from "./actual.js";',
        "export function handlePostItem() { const prepared = prepareItem(); const result = executeItem(prepared); return result; }",
        `function prepareItem() { ${failures.join(" ")} return {}; }`,
        "function executeItem(input: unknown) { return actualDelegate(input); }",
        ...declarations,
      ].join("\n"),
      "src/actual.ts": "export function actualDelegate(input: unknown) { return input; }",
    });
    expect(
      result.atoms.some(
        (atom) =>
          atom.scopePath === "src/actual.ts" &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toBe(true);
  });

  it("binds compact connector observations to the actual multiline parent and target spans", async () => {
    const result = await traceFixture({
      "src/implementation.ts": [
        'import { actualDelegate } from "./actual.js";',
        "export function handlePostItem() {",
        "  return () => actualDelegate(",
        '    "observed 🐱 source",',
        "  );",
        "}",
      ].join("\n"),
      "src/actual.ts": "export function actualDelegate(value) { return value; }",
    });
    expectCompactConnectorEvidence(result);
  });

  it("does not compact an accepted call inside a physically clipped source line", async () => {
    const result = await traceFixture({
      "src/implementation.ts":
        'import { actualDelegate } from "./actual.js";\n' +
        `export function handlePostItem() { return actualDelegate(); const ignored = "${"x".repeat(16000)}"; }`,
      "src/actual.ts": "export function actualDelegate() { return true; }",
    });
    const target = result.routeCoverage?.entries.find(
      (entry) => entry.atom.scopePath === "src/actual.ts",
    );
    expect(target).toBeDefined();
    expect(target?.parentIdentity).toBeDefined();
    expect(target?.parentWitness).toBeUndefined();
    expect(result.uncertainty.some((marker) => marker.claim.includes("excerpt-clipped"))).toBe(
      true,
    );
  });
});

describe("bounded awaited delegation frontier", () => {
  it("keeps the guarded awaited dispatch ahead of synchronous refusal siblings", async () => {
    const failures = Array.from(
      { length: 10 },
      (_value, index) => `if (Math.random()) return refused${String(index)}();`,
    );
    const declarations = Array.from(
      { length: 10 },
      (_value, index) => `function refused${String(index)}() { return undefined; }`,
    );
    const result = await traceFixture({
      "src/implementation.ts": [
        'import { actualDelegate } from "./actual.js";',
        `export async function handlePostItem() { ${failures.join(" ")} const result = await actualDelegate(); return result; }`,
        ...declarations,
      ].join("\n"),
      "src/actual.ts": "export async function actualDelegate() { return true; }",
    });
    expect(
      result.atoms.some(
        (atom) =>
          atom.scopePath === "src/actual.ts" &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toBe(true);
  });
});

describe("bounded compiler-certified continuation completeness", () => {
  it("rejects six unrelated same-name declarations beside the actual registered handler", async () => {
    const unrelated = Object.fromEntries(
      Array.from({ length: 6 }, (_value, index) => [
        `src/handler${String(index)}.ts`,
        "export function handlePostItem() { return false; }",
      ]),
    );
    const result = await traceFixture(
      {
        ...unrelated,
        "src/implementation.ts": "export function handlePostItem() { return true; }",
      },
      () => true,
      true,
      { ...routeQuery(), maxResults: 4 },
    );
    expect(certifiedPaths(result)).toEqual(["src/implementation.ts"]);
  });

  it("counts certified seeds inside the total accepted query capacity", async () => {
    const registration = [
      'import { first, second, third, fourth } from "./implementation.js";',
      'const table = [{ method: "POST", path: "/api/items", handler: first }, { method: "POST", path: "/api/items", handler: second }, { method: "POST", path: "/api/items", handler: third }, { method: "POST", path: "/api/items", handler: fourth }];',
    ].join("\n");
    const result = await traceFixture(
      {
        "src/routes.ts": registration,
        "src/implementation.ts": ["first", "second", "third", "fourth"]
          .map((name) => `export function ${name}() { return true; }`)
          .join("\n"),
      },
      () => true,
      true,
      { ...routeQuery(), maxResults: 2 },
    );
    expect(
      result.atoms.filter((atom) => atom.provenance.tool === "discovered-symbol-definition"),
    ).toHaveLength(2);
    expect(result.uncertainty.some((marker) => marker.claim.includes("frontier-width"))).toBe(true);
  });

  it("reaches a matching descendant beyond twelve definitions through unmatched current delegates", async () => {
    const names = Array.from({ length: 18 }, (_value, index) => `delegate${String(index)}`);
    const result = await traceFixture(
      {
        "src/implementation.ts": [
          `export function handlePostItem() { return ${names[0] ?? ""}(); }`,
          ...names.map(
            (name, index) =>
              `function ${name}() { return ${names[index + 1] === undefined ? "recursiveCandidateDiscovery()" : `${names[index + 1] ?? ""}()`}; }`,
          ),
          "function recursiveCandidateDiscovery() { return true; }",
        ].join("\n"),
      },
      () => true,
      true,
      {
        ...routeQuery(),
        text: "Trace POST /api/items through recursive candidate discovery.",
        maxResults: 64,
      },
    );
    expect(result.atoms.some((atom) => atom.lineRange?.startLine === names.length + 2)).toBe(true);
  });

  it("finishes a certified cycle within the admitted target capacity", async () => {
    const result = await traceFixture({
      "src/implementation.ts": [
        "export function handlePostItem() { return first(); }",
        "function first() { return second(); }",
        "function second() { return first(); }",
      ].join("\n"),
    });
    expect(
      result.atoms.filter((atom) => atom.provenance.tool === "discovered-symbol-definition"),
    ).toHaveLength(3);
    expect(result.uncertainty.some((marker) => marker.claim.includes("depth-cap"))).toBe(false);
  });

  it("retains a continuation beyond the symbol-search record cap when the query permits it", async () => {
    const names = Array.from({ length: 50 }, (_value, index) => `delegate${String(index)}`);
    const result = await traceFixture(
      {
        "src/implementation.ts": [
          'import { actualDelegate } from "./actual.js";',
          `export async function handlePostItem() { ${names.map((name) => `await ${name}();`).join(" ")} const result = await actualDelegate(); return result; }`,
          ...names.map((name) => `async function ${name}() { return true; }`),
        ].join("\n"),
        "src/actual.ts": "export async function actualDelegate() { return true; }",
      },
      () => true,
      true,
      { ...routeQuery(), maxResults: 64 },
    );
    expect(result.atoms.some((atom) => atom.scopePath === "src/actual.ts")).toBe(true);
  });

  it("reports a refused fifth continuation under a smaller accepted query capacity", async () => {
    const result = await traceFixture(
      {
        "src/implementation.ts": [
          'import { actualDelegate } from "./actual.js";',
          "export async function handlePostItem() { await first(); await second(); await third(); await fourth(); const result = await actualDelegate(); return result; }",
          "async function first() { return true; }",
          "async function second() { return true; }",
          "async function third() { return true; }",
          "async function fourth() { return true; }",
        ].join("\n"),
        "src/actual.ts": "export async function actualDelegate() { return true; }",
      },
      () => true,
      true,
      { ...routeQuery(), maxResults: 4 },
    );
    expect(result.atoms.some((atom) => atom.scopePath === "src/actual.ts")).toBe(false);
    expect(
      result.atoms.filter((atom) => atom.provenance.tool === "discovered-symbol-definition").length,
    ).toBeLessThanOrEqual(4);
    expect(result.uncertainty.some((marker) => marker.claim.includes("frontier-width"))).toBe(true);
  });

  it("observes a retained thirteenth sibling before traversing its actual delegate", async () => {
    const names = Array.from({ length: 13 }, (_value, index) => `branch${String(index)}`);
    const result = await traceFixture({
      "src/implementation.ts": [
        'import { actualDelegate } from "./actual.js";',
        `export function handlePostItem() { ${names.map((name) => `${name}();`).join(" ")} }`,
        ...names.map(
          (name, index) =>
            `function ${name}() { return ${index === names.length - 1 ? "actualDelegate()" : "true"}; }`,
        ),
      ].join("\n"),
      "src/actual.ts": "export function actualDelegate() { return true; }",
    });
    expect(result.atoms.some((atom) => atom.scopePath === "src/actual.ts")).toBe(true);
  });

  it("retains a fifth actual delegate inside the accepted request grants", async () => {
    const result = await traceFixture({
      "src/implementation.ts": [
        'import { actualDelegate } from "./actual.js";',
        "export async function handlePostItem() { await first(); await second(); await third(); await fourth(); const result = await actualDelegate(); return result; }",
        "async function first() { return true; }",
        "async function second() { return true; }",
        "async function third() { return true; }",
        "async function fourth() { return true; }",
      ].join("\n"),
      "src/actual.ts": "export async function actualDelegate() { return true; }",
    });
    expect(result.atoms.some((atom) => atom.scopePath === "src/actual.ts")).toBe(true);
  });

  it("reports omitted certified calls at the finite continuation bound", async () => {
    const names = Array.from({ length: 80 }, (_value, index) => `delegate${String(index)}`);
    const result = await traceFixture({
      "src/implementation.ts": [
        `export async function handlePostItem() { ${names.map((name) => `await ${name}();`).join(" ")} }`,
        ...names.map((name) => `async function ${name}() { return true; }`),
      ].join("\n"),
    });
    expect(result.uncertainty.some((marker) => marker.claim.includes("frontier-width"))).toBe(true);
    const definitions = result.atoms.filter(
      (atom) => atom.provenance.tool === "discovered-symbol-definition",
    );
    expect(definitions.length).toBeGreaterThan(4);
    expect(definitions.length).toBeLessThan(names.length);
  });
});

function cycleEntryIdentity(
  result: Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>,
  startLine: number,
): string {
  const entry = result.routeCoverage?.entries.find(
    (candidate) =>
      candidate.atom.scopePath === "src/implementation.ts" &&
      candidate.atom.lineRange?.startLine === startLine,
  );
  expect(entry).toBeDefined();
  if (entry === undefined) throw new TypeError("The actual selected definition is required.");
  expect(result.routeCoverage?.isCurrent(entry.atom)).toBe(true);
  return entry.definitionIdentity;
}

function cycleParentMapIsAcyclic(
  result: Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>,
): void {
  const entries = new Map(
    result.routeCoverage?.entries.map((entry) => [entry.definitionIdentity, entry]),
  );
  for (const entry of entries.values()) {
    const seen = new Set<string>();
    let current: typeof entry | undefined = entry;
    while (current !== undefined) {
      expect(seen.has(current.definitionIdentity)).toBe(false);
      seen.add(current.definitionIdentity);
      current =
        current.parentIdentity === undefined ? undefined : entries.get(current.parentIdentity);
    }
  }
}

describe("observed owned source call cycles", () => {
  it("retains a real self-call after definition dedup without cycling its evidence parent", async () => {
    const result = await traceFixture({
      "src/implementation.ts": [
        "export function handlePostItem() { visit(3); }",
        "function visit(depth) { if (depth > 0) visit(depth - 1); }",
      ].join("\n"),
    });
    const visit = cycleEntryIdentity(result, 2);
    expect(result.routeCoverage).toMatchObject({ ownedCycles: [[visit]] });
    cycleParentMapIsAcyclic(result);
  });

  it("retains assigned and statement mutual calls before seen-target suppression", async () => {
    const result = await traceFixture({
      "src/implementation.ts": [
        "export function handlePostItem() { walk(3); }",
        "function walk(depth) { const found = inspect(depth); return found; }",
        "function inspect(depth) { if (depth > 0) walk(depth - 1); return depth; }",
      ].join("\n"),
    });
    const walk = cycleEntryIdentity(result, 2);
    const inspect = cycleEntryIdentity(result, 3);
    expect(result.routeCoverage).toMatchObject({ ownedCycles: [[walk, inspect]] });
    cycleParentMapIsAcyclic(result);
  });

  it.each([
    ["export function handlePostItem() { walk(); }", "function walk() { return 1; }"],
    [
      "export function handlePostItem() { return () => walk(); }",
      "function walk() { return () => handlePostItem(); }",
    ],
    [
      "export function handlePostItem() { function walk() { return 1; } walk(); }",
      "function walk() { handlePostItem(); }",
    ],
  ])("does not promote acyclic, reference-only or shadowed cycles: %s", async (...lines) => {
    const result = await traceFixture({ "src/implementation.ts": lines.join("\n") });
    cycleEntryIdentity(result, 1);
    expect(result.routeCoverage).toMatchObject({ ownedCycles: [] });
    cycleParentMapIsAcyclic(result);
  });
});

function expectImportedValueEvidence(
  result: Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>,
): void {
  const coverage = result.routeCoverage;
  expect(coverage).toBeDefined();
  if (coverage === undefined) throw new TypeError("The actual coverage is required.");
  const parent = coverage.entries.find((entry) => entry.atom.scopePath === "src/implementation.ts");
  const value = coverage.entries.find((entry) => entry.atom.scopePath === "src/capacity.ts");
  expect(parent).toBeDefined();
  expect(value).toBeDefined();
  if (parent === undefined || value === undefined)
    throw new TypeError("The actual source declarations are required.");
  expect(value.atom.edge).toMatchObject({
    kind: "reference",
    source: {
      scopePath: "src/implementation.ts",
      lineRange: { startLine: 3, endLine: 3 },
      symbol: "ceiling",
    },
    target: {
      scopePath: "src/capacity.ts",
      lineRange: { startLine: 1, endLine: 1 },
      symbol: "payloadCeiling",
    },
    confidence: "resolved",
  });
  expect(value.parentIdentity).toBe(parent.definitionIdentity);
  expect(value.parentWitness?.targetIdentity).toBe(value.definitionIdentity);
  expect(value.parentWitness?.ownedSourceCall).toBeUndefined();
  expect(value.observedBytes).toBeGreaterThan(0);
  expect(value.atom.provenance.tool).toBe("discovered-symbol-definition");
  expect(coverage.isCurrent(value.atom)).toBe(true);
  expect(coverage.ownedCycles?.flat()).not.toContain(value.definitionIdentity);
}

function expectCompactConnectorEvidence(
  result: Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>,
): void {
  const entries = result.routeCoverage?.entries ?? [];
  const parent = entries.find((entry) => entry.atom.scopePath === "src/implementation.ts");
  const target = entries.find((entry) => entry.atom.scopePath === "src/actual.ts");
  expect(parent).toBeDefined();
  expect(target).toBeDefined();
  if (parent === undefined || target === undefined)
    throw new TypeError("The actual connector declarations are required.");
  const witness = target.parentWitness;
  if (witness === undefined) throw new TypeError("The actual connector witness is required.");
  expect(witness.parentIdentity).toBe(parent.definitionIdentity);
  expect(witness.targetIdentity).toBe(target.definitionIdentity);
  expect(witness.lineRange).toEqual({ startLine: 3, endLine: 5 });
  expect(witness.callerSpan.endLine).toBe(5);
  expect(target.atom.edge?.kind).toBe("reference");
  expect(
    result.uncertainty.some((marker) => marker.claim.includes("source-graph-incomplete")),
  ).toBe(true);
}

function importedValueOwnerProjection(
  index: CodeIntelligenceIndex,
  mode: "missing" | "stale",
): CodeIntelligenceIndex {
  return {
    ...index,
    references: index.references.map((reference) => {
      if (reference.referenceName !== "ceiling") return reference;
      const owner = reference.referencerDefinition;
      expect(owner?.declarationSpan).toBeDefined();
      if (owner?.declarationSpan === undefined) throw new TypeError("Actual owner is required.");
      return {
        ...reference,
        referencerDefinition:
          mode === "missing"
            ? undefined
            : {
                ...owner,
                declarationSpan: {
                  ...owner.declarationSpan,
                  endColumn: owner.declarationSpan.endColumn + 1,
                },
              },
      };
    }),
  };
}

async function staleImportedValueFixture(): Promise<
  Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>
> {
  const files = {
    "src/routes.ts": ROUTE_CONTENT,
    "src/implementation.ts":
      'import { payloadCeiling as ceiling } from "./capacity.js";\nexport function handlePostItem(payload) { return payload.bytes < ceiling; }',
    "src/capacity.ts": "export const payloadCeiling = 6143;",
  };
  const fs = memFs(WORKSPACE_ROOT, files);
  const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
  const requestContext = createStructuralAdapterRequestContext(
    searchScope,
    GROUNDED_TRACE_SEARCH_LIMITS,
    fs,
    { nowMs: () => NOW },
  );
  await requestContext.codeIntelligenceIndex();
  expect(requestContext.isCodeIntelligenceSourceCurrent("src/capacity.ts")).toBe(true);
  files["src/capacity.ts"] = "export const changedValue = 8191;\n";
  expect(requestContext.isCodeIntelligenceSourceCurrent("src/capacity.ts")).toBe(false);
  return collectDiscoveredSymbolTraceEvidence({
    scope: selectedScope(),
    query: routeQuery(),
    anchors: [],
    retrievalIntent: "targeted-code-search",
    searchScope,
    fs,
    nowMs: () => NOW,
    atoms: [routeAtom()],
    requestContext,
  });
}

describe("certified imported source values", () => {
  it.each([
    { declaration: "export const payloadCeiling = 6143;", expression: "ceiling" },
    { declaration: "export const payloadCeiling = { bytes: 6143 };", expression: "ceiling.bytes" },
  ])(
    "retains the bound declaration for a non-call value use: $expression",
    async ({ declaration, expression }) => {
      const result = await traceFixture({
        "src/implementation.ts": [
          'import { payloadCeiling as ceiling } from "./capacity.js";',
          "export function handlePostItem(payload) {",
          `  const decision = { admissible: payload.bytes < ${expression} };`,
          "  return decision.admissible;",
          "}",
        ].join("\n"),
        "src/capacity.ts": declaration,
      });
      expectImportedValueEvidence(result);
    },
  );

  it.each([
    "export function handlePostItem(ceiling) { return ceiling; }",
    "export function handlePostItem() { function dormant() { return ceiling; } return true; }",
    "export function handlePostItem() { return () => ceiling; }",
    "export function handlePostItem() { const dormant = () => ceiling; return true; }",
  ])("does not attribute a shadowed or uninvoked value use to the handler: %s", async (body) => {
    const result = await traceFixture({
      "src/implementation.ts": `import { payloadCeiling as ceiling } from "./capacity.js";\n${body}`,
      "src/capacity.ts": "export const payloadCeiling = 6143;",
    });
    expect(result.atoms.some((atom) => atom.scopePath === "src/capacity.ts")).toBe(false);
  });

  it.each(["missing", "stale"] as const)(
    "fails closed for %s source owner metadata",
    async (mode) => {
      const result = await traceFixture(
        {
          "src/implementation.ts":
            'import { payloadCeiling as ceiling } from "./capacity.js";\nexport function handlePostItem(payload) { return payload.bytes < ceiling; }',
          "src/capacity.ts": "export const payloadCeiling = 6143;",
        },
        () => true,
        true,
        routeQuery(),
        (index) => importedValueOwnerProjection(index, mode),
      );
      expect(result.atoms.some((atom) => atom.scopePath === "src/capacity.ts")).toBe(false);
      if (mode === "missing")
        expect(
          result.uncertainty.some((marker) => marker.claim.includes("source-graph-incomplete")),
        ).toBe(true);
    },
  );

  it("retains only the actual imported declaration among equal-named current sources", async () => {
    const result = await traceFixture({
      "src/implementation.ts":
        'import { payloadCeiling as ceiling } from "./limits/current.js";\nexport function handlePostItem(payload) { return payload.bytes < ceiling; }',
      "src/limits/current.ts": "export const payloadCeiling = 6143;",
      "src/other/current.ts": "export const payloadCeiling = 8191;",
    });
    const values = result.routeCoverage?.entries.filter(
      (entry) => entry.atom.edge?.target.symbol === "payloadCeiling",
    );
    expect(values?.map((entry) => entry.atom.scopePath)).toEqual(["src/limits/current.ts"]);
    expect(values?.[0]?.atom.edge?.kind).toBe("reference");
    expect(values?.[0]?.parentWitness?.ownedSourceCall).toBeUndefined();
  });

  it("keeps actual calls ahead of value references within the same finite target grant", async () => {
    const result = await traceFixture(
      {
        "src/implementation.ts":
          'import { validate } from "./worker.js";\nimport { payloadCeiling as ceiling } from "./capacity.js";\nexport function handlePostItem() { return validate(ceiling); }',
        "src/worker.ts": "export function validate(limit) { return limit > 0; }",
        "src/capacity.ts": "export const payloadCeiling = 6143;",
      },
      () => true,
      true,
      { ...routeQuery(), maxResults: 2 },
    );
    expect(certifiedPaths(result)).toContain("src/worker.ts");
    expect(certifiedPaths(result)).not.toContain("src/capacity.ts");
    expect(result.uncertainty.some((marker) => marker.claim.includes("frontier-width"))).toBe(true);
  });

  it("does not reuse a value declaration after its indexed source changes", async () => {
    const result = await staleImportedValueFixture();
    expect(result.atoms.some((atom) => atom.scopePath === "src/capacity.ts")).toBe(false);
  });

  it("does not certify an enum without a lexical runtime export target", async () => {
    const result = await traceFixture({
      "src/implementation.ts":
        'import { SubmissionLimit } from "./capacity.js";\nexport function handlePostItem(payload) { return payload.bytes < SubmissionLimit.Bytes; }',
      "src/capacity.ts": "export enum SubmissionLimit { Bytes = 6143 }",
    });
    expect(result.atoms.some((atom) => atom.scopePath === "src/capacity.ts")).toBe(false);
  });

  it("does not choose an ambiguous re-exported value", async () => {
    const result = await traceFixture({
      "src/implementation.ts":
        'import { payloadCeiling as ceiling } from "./capacity.js";\nexport function handlePostItem(payload) { return payload.bytes < ceiling; }',
      "src/capacity.ts": 'export * from "./east.js";\nexport * from "./west.js";',
      "src/east.ts": "export const payloadCeiling = 6143;",
      "src/west.ts": "export const payloadCeiling = 8191;",
    });
    expect(
      result.atoms.some((atom) =>
        ["src/capacity.ts", "src/east.ts", "src/west.ts"].includes(atom.scopePath),
      ),
    ).toBe(false);
  });

  it("does not invent a target for a dynamic module property", async () => {
    const result = await traceFixture({
      "src/implementation.ts":
        'import * as limits from "./capacity.js";\nexport function handlePostItem(key) { return limits[key]; }',
      "src/capacity.ts": "export const payloadCeiling = 6143;",
    });
    expect(result.atoms.some((atom) => atom.scopePath === "src/capacity.ts")).toBe(false);
  });
});

function fixtureComparisonQuery(): RetrievalQuery {
  return {
    ...routeQuery(),
    text: "Which sample counts does POST /api/items accept, and which imported setting bounds it? Compare the current setting with the test fixtures.",
  };
}

function fixtureComparisonFiles(): Record<string, string> {
  return {
    "src/routes.ts": ROUTE_CONTENT,
    "src/implementation.ts": [
      'import { packetThreshold as boundary } from "./operatingLimit.js";',
      "export function handlePostItem(samples) {",
      "  return Number.isInteger(samples) && samples >= 0 && samples <= boundary;",
      "}",
    ].join("\n"),
    "src/operatingLimit.ts": "export const packetThreshold = 29;",
    "tests/scenarios/overflowValues.ts": "export const packetThreshold = 193;",
    ...Object.fromEntries(
      Array.from({ length: 24 }, (_, ordinal) => [
        `src/samplePolicy${String(ordinal)}.ts`,
        `export function sampleCounts${String(ordinal)}(samples) { return Number.isInteger(samples) && samples >= 0; }`,
      ]),
    ),
  };
}

async function publicFixtureComparison(
  query: RetrievalQuery,
): ReturnType<typeof retrieveConnectedContextPack> {
  return retrieveConnectedContextPack(
    {
      scope: selectedScope(),
      query,
      workspaceRoot: WORKSPACE_ROOT,
      budget: DEFAULT_EXPLORATION_BUDGET,
    },
    {
      correlationId: undefined,
      fs: memFs(WORKSPACE_ROOT, fixtureComparisonFiles()),
      nowMs: () => NOW,
      detectWorkspace: workspaceInfo,
      answerer: { answer: () => Promise.resolve("observed source") },
    },
  );
}

function expectFixtureComparisonConsumers(
  result: Awaited<ReturnType<typeof retrieveConnectedContextPack>>,
  query: RetrievalQuery,
): void {
  expect(
    result.pack.files
      .filter((file) => file.scopePath === "src/operatingLimit.ts")
      .flatMap((file) => file.excerpts)
      .map((excerpt) => excerpt.content)
      .join("\n"),
  ).toContain("export const packetThreshold = 29;");
  const expected = "export const packetThreshold = 193;";
  const excerpts = result.pack.files
    .filter((file) => file.scopePath === "tests/scenarios/overflowValues.ts")
    .flatMap((file) => file.excerpts);
  expect(excerpts.map((excerpt) => excerpt.content).join("\n")).toContain(expected);
  const prompt = buildGroundedGatewayMessages(query.text, result.pack, (value) => value)
    .map((message) => message.content)
    .join("\n");
  expect(prompt).toContain(`1 | ${expected}`);
}

describe("requested imported-value fixture comparisons", () => {
  it("includes the independently exported test declaration in the public pack and numbered prompt", async () => {
    const query = fixtureComparisonQuery();
    expectFixtureComparisonConsumers(await publicFixtureComparison(query), query);
  });

  it("includes independently exported comparison evidence for a German test-data request", async () => {
    const query = {
      ...routeQuery(),
      text: "Welche Stichprobenzahlen lässt POST /api/items zu? Vergleiche die aktuelle importierte Grenze mit den Testdaten.",
    };
    expectFixtureComparisonConsumers(await publicFixtureComparison(query), query);
  });

  it("keeps the comparison declaration independent of the current handler's binding and cycles", async () => {
    const result = await traceFixture(
      fixtureComparisonFiles(),
      () => true,
      true,
      fixtureComparisonQuery(),
    );
    const entry = result.routeCoverage?.entries.find(
      (candidate) => candidate.atom.scopePath === "tests/scenarios/overflowValues.ts",
    );
    expect(entry).toBeDefined();
    if (entry === undefined)
      throw new TypeError("The observed comparison declaration is required.");
    expect(entry.atom.lineRange).toEqual({ startLine: 1, endLine: 1 });
    expect(entry.observedBytes).toBe(Buffer.byteLength("export const packetThreshold = 193;"));
    expect(result.routeCoverage?.isCurrent(entry.atom)).toBe(true);
    expect(entry.atom.edge).toBeUndefined();
    expect(entry.parentIdentity).toBeUndefined();
    expect(entry.parentWitness).toBeUndefined();
    expect(result.routeCoverage?.ownedCycles?.flat()).not.toContain(entry.definitionIdentity);
  });

  it.each([
    "export const unrelatedThreshold = 193;",
    "const packetThreshold = 193;",
    "export function makeThreshold() { const packetThreshold = 193; return packetThreshold; }",
    "const localThreshold = 193; export { localThreshold as packetThreshold };",
    "export const packetThreshold = 193; export const packetThreshold = 197;",
  ])(
    "refuses unrelated, local, nested, aliased or ambiguous test declarations: %s",
    async (declaration) => {
      const files = fixtureComparisonFiles();
      files["tests/scenarios/overflowValues.ts"] = declaration;
      const result = await traceFixture(files, () => true, true, fixtureComparisonQuery());
      expect(certifiedPaths(result)).not.toContain("tests/scenarios/overflowValues.ts");
      expect(certifiedPaths(result)).toContain("src/operatingLimit.ts");
    },
  );

  it.each([
    routeQuery(),
    { ...fixtureComparisonQuery(), kind: "regex" as const },
    { ...fixtureComparisonQuery(), kind: "exact-symbol" as const, text: "packetThreshold" },
    {
      ...fixtureComparisonQuery(),
      text: 'Trace POST /api/items and find "compare test fixtures".',
    },
    {
      ...fixtureComparisonQuery(),
      text: 'Trace POST /api/items und finde "Vergleiche Testdaten".',
    },
  ])(
    "does not broaden retrieval without unquoted natural-language comparison intent: $text",
    async (query) => {
      const result = await traceFixture(fixtureComparisonFiles(), () => true, true, query);
      expect(certifiedPaths(result)).not.toContain("tests/scenarios/overflowValues.ts");
    },
  );

  it("does not infer a comparison seed from an unresolved imported setting", async () => {
    const files = fixtureComparisonFiles();
    files["src/operatingLimit.ts"] = 'export * from "./east.js";\nexport * from "./west.js";';
    files["src/east.ts"] = "export const packetThreshold = 29;";
    files["src/west.ts"] = "export const packetThreshold = 31;";
    const result = await traceFixture(files, () => true, true, fixtureComparisonQuery());
    expect(certifiedPaths(result)).not.toContain("tests/scenarios/overflowValues.ts");
  });

  it("does not broaden a source comparison to an equal-named unrelated production declaration", async () => {
    const files = fixtureComparisonFiles();
    files["src/unrelatedPolicy.ts"] = "export const packetThreshold = 197;";
    const result = await traceFixture(files, () => true, true, fixtureComparisonQuery());
    expect(certifiedPaths(result)).toContain("tests/scenarios/overflowValues.ts");
    expect(certifiedPaths(result)).not.toContain("src/unrelatedPolicy.ts");
  });

  it("keeps the current imported setting ahead of comparison evidence inside the finite frontier", async () => {
    const result = await traceFixture(fixtureComparisonFiles(), () => true, true, {
      ...fixtureComparisonQuery(),
      maxResults: 2,
    });
    expect(certifiedPaths(result)).toContain("src/operatingLimit.ts");
    expect(certifiedPaths(result)).not.toContain("tests/scenarios/overflowValues.ts");
    expect(result.uncertainty.some((marker) => marker.claim.includes("frontier-width"))).toBe(true);
  });

  it("keeps comparison declarations inside the actual selected search scope", async () => {
    const result = await scopedComparisonTrace(fixtureComparisonFiles(), ["src"]);
    expect(certifiedPaths(result)).toContain("src/operatingLimit.ts");
    expect(certifiedPaths(result)).not.toContain("tests/scenarios/overflowValues.ts");
  });

  it("refuses a comparison declaration when its indexed source changes", async () => {
    const files = fixtureComparisonFiles();
    const result = await scopedComparisonTrace(files, [], () => {
      files["tests/scenarios/overflowValues.ts"] = "export const changedThreshold = 199;";
    });
    expect(certifiedPaths(result)).toContain("src/operatingLimit.ts");
    expect(certifiedPaths(result)).not.toContain("tests/scenarios/overflowValues.ts");
    expect(
      result.uncertainty.some((marker) => marker.claim.includes("source-graph-incomplete")),
    ).toBe(true);
  });
});

async function scopedComparisonTrace(
  files: Record<string, string>,
  relativePaths: readonly string[],
  mutateIndexed?: () => void,
): Promise<Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>> {
  const fs = memFs(WORKSPACE_ROOT, files);
  const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths };
  const requestContext = createStructuralAdapterRequestContext(
    searchScope,
    GROUNDED_TRACE_SEARCH_LIMITS,
    fs,
    { nowMs: () => NOW },
  );
  await requestContext.codeIntelligenceIndex();
  mutateIndexed?.();
  return collectDiscoveredSymbolTraceEvidence({
    scope: selectedScope(),
    query: fixtureComparisonQuery(),
    anchors: [],
    retrievalIntent: "targeted-code-search",
    searchScope,
    fs,
    nowMs: () => NOW,
    atoms: [routeAtom()],
    requestContext,
  });
}
