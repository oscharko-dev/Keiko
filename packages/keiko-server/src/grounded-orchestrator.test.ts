import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
// Tests for the grounded Q&A orchestrator (Issue #185). Verifies the deterministic linear
// composition of the connected-context layers, the clarification-needed escape hatch, and
// the budget-exhaustion → uncertainty-marker propagation produced by #183.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileListingClassifierForTests as repoSearchScan } from "@oscharko-dev/keiko-workspace/testing";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type ConnectedContextPack,
  type EvidenceAtom,
  type RetrievalQuery,
  type SelectedScope,
  type UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts/connected-context";
import * as workspace from "@oscharko-dev/keiko-workspace";
import {
  gitHistoryAdapter,
  symbolGraphAdapter,
  createWorkspaceIndex,
  WorkspaceNotFoundError,
  type SemanticSearchProvider,
  type SearchScope,
  type WorkspaceFs,
  type WorkspaceDirEntry,
  type WorkspaceInfo,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";
import {
  buildMatcher,
  importGraphAdapter,
  repositorySourceLines,
  repositorySourceMaxLineScore,
  testSourcePairingAdapter,
} from "@oscharko-dev/keiko-workspace/code-intelligence";
import type { MicroIndex, RerankerSeam } from "@oscharko-dev/keiko-workflows";
import { DEFAULT_CONTEXT_PROFILE } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { validateContextBudget } from "@oscharko-dev/keiko-contracts/runtime/context-engineering-validation";

import { CancelledError } from "@oscharko-dev/keiko-model-gateway";

import {
  ClarificationNeededError,
  DEFAULT_SEARCH_LIMITS,
  _RING_DISCOVERY_SENTINEL_ENTRIES_FOR_TESTS,
  _fileStateCacheIdentityForTests,
  _readKeptExcerptsForTests,
  _ringDiscoveryFsForTests,
  type ExcerptReadSummary,
  clarificationUserMessage,
  isSymbolDefinitionPath,
  retrieveConnectedContextPack,
  runGroundedExploration,
  scanFirstSymbolLine,
  type GroundedAnswerer,
  type OrchestratorInput,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";
import {
  nodeWorkspaceFs,
  type WorkspaceDescriptorReadCompleteness,
  type WorkspaceDescriptorUtf8Read,
  type WorkspaceFileReader,
  type WorkspaceHardLinkPolicy,
} from "@oscharko-dev/keiko-workspace/internal/fs";
import type { GitFileHistoryEvidenceProvider } from "./grounded-git-history-evidence.js";
import { fittedGroundedGatewayPrompt } from "./grounded-qa.js";

const NOW = 1_700_000_000_000;
const listingGuardPhase = new AsyncLocalStorage<boolean>();
const excerptReadPhase = new AsyncLocalStorage<boolean>();
let ROOT = "";

const echoAnswerer: GroundedAnswerer = {
  answer: (question, pack) => {
    const filePaths = pack.files.map((f) => f.scopePath).join(", ");
    const summary =
      `Inspected ${String(pack.files.length)} file(s) for: ${question}. ` +
      `Findings include: ${filePaths.length === 0 ? "(no evidence)" : filePaths}.`;
    return Promise.resolve(summary);
  },
};

function fakeWorkspace(): WorkspaceInfo {
  return {
    root: realpathSync(ROOT),
    selectedRoot: ROOT,
    name: "demo",
    version: "0.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function seedRepoAt(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(
    join(root, "src/foo.ts"),
    "export function MyClass() {\n  return 'foo body';\n}\n// MyClass call site here\n",
  );
  writeFileSync(
    join(root, "src/bar.ts"),
    "// unrelated content with no MyClass anchor\nexport const bar = 1;\n",
  );
  writeFileSync(
    join(root, "tests/foo.test.ts"),
    "import { MyClass } from '../src/foo';\nMyClass();\nMyClass();\nMyClass();\n",
  );
}

function seedRepo(): void {
  seedRepoAt(ROOT);
}

function seedOverflowImplementations(root: string, count: number): void {
  const term = "OverflowProbe";
  for (let index = 0; index < count; index += 1) {
    const dir = join(root, "packages", `overflow-${index.toString()}`, "src");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${term}.ts`),
      `export function ${term}(): number {\n  return ${index.toString()};\n}\n`,
    );
  }
}

function coverageLimitedReadFs(ioError: boolean): WorkspaceFs {
  const read = nodeWorkspaceFs.readFileBytes;
  if (read === undefined) throw new Error("physical read fixture missing");
  return {
    ...nodeWorkspaceFs,
    readFileBytes: (...args): Promise<Uint8Array> =>
      ioError && args[0].endsWith("/c.ts")
        ? Promise.reject(Object.assign(new Error("fixture read failed"), { code: "EIO" }))
        : read(...args),
  };
}

function expectRetainedMatchCoverage(pack: ConnectedContextPack, ioError: boolean): void {
  const coverage = pack.diagnostics?.coverage;
  const marker = pack.uncertainty.find((entry) => entry.claim.startsWith("repository search"));
  if (coverage === undefined || marker === undefined) throw new Error("coverage fixture missing");
  expect(coverage.reasons).toContain("match-cap");
  expect(marker.kind).toBe(ioError ? "scope-incomplete" : "budget-clipped");
  if (ioError) {
    expect(coverage.reasons).toContain("io-error");
    expect(marker.claim).toContain("coverage was incomplete");
    expect(marker.claim).not.toContain("all eligible files were searched");
  } else {
    expect(coverage.filesScanned).toBe(3);
    expect(coverage.filesAfterPolicy).toBe(3);
    expect(marker.claim).toContain("all eligible files were searched");
    expect(marker.claim).toContain("additional matching results were omitted");
  }
}

const TRAVERSAL_SYMBOLS = [
  "TraversalAlpha",
  "TraversalBeta",
  "TraversalGamma",
  "TraversalDelta",
  "TraversalEpsilon",
  "TraversalZeta",
  "TraversalEta",
  "TraversalTheta",
] as const;

function seedTraversalImplementations(root: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const symbol = TRAVERSAL_SYMBOLS[index % TRAVERSAL_SYMBOLS.length] ?? "TraversalAlpha";
    const dir = join(root, "packages", `traversal-${index.toString()}`, "src");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${symbol}.ts`),
      `export function ${symbol}(): number {\n  return ${index.toString()};\n}\n`,
    );
  }
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  for (const reference of ["ADR-1001", "ADR-1002", "RFC-2001", "RFC-2002"]) {
    writeFileSync(join(docsDir, `${reference}.md`), `# ${reference}\n`);
  }
}

function countFixtureDirectories(root: string): number {
  let count = 1;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFixtureDirectories(join(root, entry.name));
    }
  }
  return count;
}

function countFixtureFiles(root: string): number {
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    count += entry.isDirectory()
      ? countFixtureFiles(join(root, entry.name))
      : Number(entry.isFile());
  }
  return count;
}

interface FixtureByteStats {
  readonly totalBytes: number;
  readonly largestFileBytes: number;
}

function fixtureByteStats(root: string): FixtureByteStats {
  let totalBytes = 0;
  let largestFileBytes = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = fixtureByteStats(absolutePath);
      totalBytes += nested.totalBytes;
      largestFileBytes = Math.max(largestFileBytes, nested.largestFileBytes);
    } else if (entry.isFile()) {
      const sizeBytes = statSync(absolutePath).size;
      totalBytes += sizeBytes;
      largestFileBytes = Math.max(largestFileBytes, sizeBytes);
    }
  }
  return { totalBytes, largestFileBytes };
}

function seedIssue672Repo(): void {
  mkdirSync(join(ROOT, "packages/keiko-server/src"), { recursive: true });
  writeFileSync(
    join(ROOT, "packages/keiko-server/src/deps.ts"),
    "// handleGroundedAsk exact file reference only\n",
  );
  writeFileSync(
    join(ROOT, "packages/keiko-server/src/files.ts"),
    "// file implements route evidence for grounded chats\n",
  );
  writeFileSync(
    join(ROOT, "packages/keiko-server/src/grounded-orchestrator.test.ts"),
    "// POST grounded route evidence\n",
  );
  writeFileSync(
    join(ROOT, "packages/keiko-server/src/grounded-qa.ts"),
    "export async function handleGroundedAsk(): Promise<void> { return; }\n",
  );
  writeFileSync(
    join(ROOT, "packages/keiko-server/src/routes.ts"),
    "import { handleGroundedAsk } from './grounded-qa.js';\n" +
      "const routes = [\n" +
      '  { method: "PATCH", pattern: "/api/chats/messages", handler: handleUpdateMessage },\n' +
      "  // Grounded repository-aware Q&A.\n" +
      '  { method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },\n' +
      "];\n",
  );
}

function seedCrowdedHandlerTraceRepo(): void {
  writeFileSync(
    join(ROOT, "src/routes.ts"),
    'import { dispatchWorkUnit } from "./service.js";\n' +
      'const routes = [{ method: "POST", pattern: "/api/opaque/x7", handler: dispatchWorkUnit }];\n',
  );
  writeFileSync(
    join(ROOT, "src/service.ts"),
    'import { runPipeline } from "./pipeline.js";\n' +
      "export async function dispatchWorkUnit(): Promise<void> {\n  await runPipeline();\n}\n",
  );
  writeFileSync(
    join(ROOT, "src/pipeline.ts"),
    "export async function runPipeline(): Promise<void> {\n  await executeStages();\n}\n",
  );
  for (let index = 0; index < 16; index += 1) {
    writeFileSync(
      join(ROOT, `src/a-reference-${String(index).padStart(2, "0")}.ts`),
      "export async function referenceOnly(): Promise<void> { await dispatchWorkUnit(); }\n",
    );
  }
}

function seedLateRelevantDelegationRepo(): string {
  const names = Array.from({ length: 32 }, (_value, index) => `refusal${String(index)}`);
  const noise = "unrelated bookkeeping ".repeat(30);
  const fact =
    "const next = candidates.flatMap((candidate) => candidate.recursiveDiscovery ? candidate.children : []);";
  const body = [
    "function opaqueStage(candidates: readonly { children: readonly string[]; recursiveDiscovery: boolean }[]) {",
    `  ${fact}`,
    "  return next;",
    "}",
  ].join("\n");
  writeFileSync(
    join(ROOT, "src/routes.ts"),
    'import { dispatchWorkUnit } from "./service.js";\n' +
      'const routes = [{ method: "POST", pattern: "/api/opaque/x7", handler: dispatchWorkUnit }];\n',
  );
  writeFileSync(
    join(ROOT, "src/service.ts"),
    [
      `export async function dispatchWorkUnit() { ${names.map((name) => `await ${name}();`).join(" ")} return opaqueStage([]); }`,
      ...names.map(
        (name) =>
          `async function ${name}() {\n  const recursive = "${noise}";\n  return recursive;\n}\n\n\n\n\n`,
      ),
      body,
    ].join("\n"),
  );
  return fact;
}

function seedIssue876Repo(): void {
  mkdirSync(join(ROOT, "src"), { recursive: true });
  mkdirSync(join(ROOT, ".keiko/evidence/qi"), { recursive: true });
  writeFileSync(
    join(ROOT, "src/grounded-qa.ts"),
    "export async function handleGroundedAsk() {\n" +
      "  return 'real route handler';\n" +
      "}\n" +
      "export const GROUNDED_HANDLER_NAME = 'handleGroundedAsk';\n",
  );
  writeFileSync(
    join(ROOT, "src/zod-config.ts"),
    "import { z } from 'zod';\n" +
      "export const ZodConfigSchema = z.object({ PORT: z.string() });\n" +
      "export function parseZodConfig(input: unknown) {\n" +
      "  return ZodConfigSchema.parse(input);\n" +
      "}\n",
  );
  writeFileSync(
    join(ROOT, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n" +
      "packages:\n" +
      "  zod@3.23.8:\n" +
      "    resolution: {integrity: sha512-zod}\n" +
      "importers:\n" +
      "  .:\n" +
      "    dependencies:\n" +
      "      zod:\n" +
      "        specifier: ^3.23.8\n" +
      "        version: 3.23.8\n",
  );
  writeFileSync(
    join(ROOT, ".keiko/evidence/qi/run.candidates.json"),
    JSON.stringify({
      finding: "handleGroundedAsk grounded route handler",
      summary: "handleGroundedAsk appears in cached evidence only",
      packageName: "zod",
    }) + "\n",
  );
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "keiko-grounded-orch-"));
  seedRepo();
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function happyScope(overrides: Partial<SelectedScope> = {}): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "scope-1",
    workspaceRoot: ROOT,
    kind: "directory",
    relativePaths: ["src"],
    conversationId: undefined,
    connectedAtMs: NOW,
    ...overrides,
  };
}

function happyQuery(overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "Investigate src/foo.ts behaviour of `MyClass`",
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: NOW,
    ...overrides,
  };
}

function gitHistoryAtom(scopePath: string, nowMs: number): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: `git-${scopePath}`,
    scopePath,
    lineRange: undefined,
    score: 1,
    provenance: { kind: "git-history", tool: "git-file-history", queryFingerprint: "fp-git" },
    metrics: { gitRecency: 1, gitChurn: 0.75 },
    redactionState: "redacted",
    emittedAtMs: nowMs,
    ledgerRef: undefined,
  };
}

function structuralEdgeAtom(stableId: string, targetScopePath: string): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId,
    scopePath: "src/foo.ts",
    lineRange: { startLine: 1, endLine: 1 },
    score: 1,
    provenance: {
      kind: "structural",
      tool: "structural-cancellation-fixture",
      queryFingerprint: "fp-structural-cancellation",
    },
    edge: {
      kind: "import",
      source: { scopePath: "src/foo.ts", lineRange: { startLine: 1, endLine: 1 } },
      target: { scopePath: targetScopePath, lineRange: { startLine: 1, endLine: 1 } },
      confidence: "resolved",
    },
    redactionState: "redacted",
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

function issue672Workspace(): WorkspaceInfo {
  return {
    ...fakeWorkspace(),
    sourceDirs: ["packages/keiko-server/src"],
    testDirs: ["packages/keiko-server/src"],
  };
}

function issue672Scope(): SelectedScope {
  return happyScope({
    kind: "directory",
    relativePaths: ["packages/keiko-server/src"],
  });
}

function issue672Input(text: string): OrchestratorInput {
  return input({
    scope: issue672Scope(),
    query: happyQuery({ text }),
  });
}

function input(overrides: Partial<OrchestratorInput> = {}): OrchestratorInput {
  return {
    scope: happyScope(),
    query: happyQuery(),
    workspaceRoot: ROOT,
    ...overrides,
  };
}

// A supported optional-compatible port: every bounded lane the Node port offers EXCEPT
// `readFileUtf8SameDescriptor`, which `WorkspaceFs` declares optional. Each call to the unbounded
// `readFileUtf8` is recorded, so a test can pin that no advisory-metadata lane falls back to it —
// a fallback that only checks the byte cap once the whole file is already resident is not a bound
// (ADR-0005 D1).
function descriptorlessWorkspaceFs(unboundedReads: string[]): WorkspaceFs {
  // Omit rather than assign undefined: `exactOptionalPropertyTypes` rejects the latter.
  const { readFileUtf8SameDescriptor: omitted, ...withoutDescriptorRead } = nodeWorkspaceFs;
  if (omitted === undefined) {
    throw new Error("nodeWorkspaceFs always provides readFileUtf8SameDescriptor");
  }
  return {
    ...withoutDescriptorRead,
    readFileUtf8: (absolutePath): string => {
      unboundedReads.push(absolutePath);
      return nodeWorkspaceFs.readFileUtf8(absolutePath);
    },
  };
}

function throwingReadFs(): WorkspaceFs {
  return {
    readFileUtf8: (): never => {
      throw new Error("readFileUtf8 should not be called");
    },
    stat: (): never => {
      throw new Error("stat should not be called");
    },
    readDir: (): never => {
      throw new Error("readDir should not be called");
    },
    realPath: (path): string => path,
    exists: (): boolean => true,
    readFileBytes: (): Promise<Uint8Array> =>
      Promise.reject(new Error("readFileBytes should not be called")),
  };
}

interface FsOperationCounts {
  readonly readFileUtf8: number;
  readonly readFileUtf8SameDescriptor: number;
  readonly readFileUtf8WithinRootSameDescriptor: number;
  readonly readFileBytes: number;
  readonly readFileUtf8Prefix: number;
  readonly readFileRange: number;
  readonly openFileReader: number;
  readonly readerReadRange: number;
  readonly stat: number;
  readonly readDir: number;
  readonly unboundedReadDir: number;
  readonly streamedReadDir: number;
  readonly streamedReadDirEntries: number;
  readonly readDirEntries: number;
  readonly realPath: number;
  readonly exists: number;
  readonly contentReadBytes: number;
}

function countingNodeFs(): {
  readonly fs: WorkspaceFs;
  readonly counts: () => FsOperationCounts;
  readonly excerptReads: () => { readonly readCalls: number; readonly contentReadBytes: number };
  readonly listingGuards: () => {
    readonly contentReadBytes: number;
    readonly stat: number;
    readonly realPath: number;
    readonly readCalls: number;
  };
} {
  const iterate = nodeWorkspaceFs.iterateDirectory;
  let readFileUtf8Calls = 0;
  let descriptorUtf8Calls = 0;
  let containedDescriptorUtf8Calls = 0;
  let readFileBytesCalls = 0;
  let readFileUtf8PrefixCalls = 0;
  let readFileRangeCalls = 0;
  let openFileReaderCalls = 0;
  let readerReadRangeCalls = 0;
  let statCalls = 0;
  let listingGuardStats = 0;
  let listingGuardRealPaths = 0;
  let listingGuardReads = 0;
  let listingGuardBytes = 0;
  let readDirCalls = 0;
  let unboundedReadDirCalls = 0;
  let streamedReadDirCalls = 0;
  let streamedReadDirEntries = 0;
  let readDirEntries = 0;
  let realPathCalls = 0;
  let existsCalls = 0;
  let contentReadBytes = 0;
  let excerptReadCalls = 0;
  let excerptReadBytes = 0;
  const recordExcerptRead = (bytes: number): void => {
    if (excerptReadPhase.getStore() !== true) return;
    excerptReadCalls += 1;
    excerptReadBytes += bytes;
  };
  const descriptorUtf8 = nodeWorkspaceFs.readFileUtf8SameDescriptor;
  const containedDescriptorUtf8 = nodeWorkspaceFs.readFileUtf8WithinRootSameDescriptor;
  const readFileBytes = nodeWorkspaceFs.readFileBytes;
  const readFileUtf8Prefix = nodeWorkspaceFs.readFileUtf8Prefix;
  const readFileRange = nodeWorkspaceFs.readFileRange;
  const openFileReader = nodeWorkspaceFs.openFileReader;
  return {
    fs: {
      ...nodeWorkspaceFs,
      readFileUtf8: (absolutePath): string => {
        readFileUtf8Calls += 1;
        const value = nodeWorkspaceFs.readFileUtf8(absolutePath);
        contentReadBytes += Buffer.byteLength(value, "utf8");
        recordExcerptRead(Buffer.byteLength(value, "utf8"));
        return value;
      },
      stat: (absolutePath): WorkspaceStat => {
        statCalls += 1;
        if (listingGuardPhase.getStore() === true) listingGuardStats += 1;
        return nodeWorkspaceFs.stat(absolutePath);
      },
      ...(iterate === undefined
        ? {}
        : {
            iterateDirectory: async function* (path): AsyncIterable<WorkspaceDirEntry> {
              readDirCalls += 1;
              streamedReadDirCalls += 1;
              for await (const entry of iterate.call(nodeWorkspaceFs, path)) {
                readDirEntries += 1;
                streamedReadDirEntries += 1;
                yield entry;
              }
            },
          }),
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        readDirCalls += 1;
        if (maxEntries === undefined) unboundedReadDirCalls += 1;
        const entries = nodeWorkspaceFs.readDir(absolutePath, maxEntries);
        readDirEntries += entries.length;
        return entries;
      },
      realPath: (absolutePath): string => {
        realPathCalls += 1;
        if (listingGuardPhase.getStore() === true) listingGuardRealPaths += 1;
        return nodeWorkspaceFs.realPath(absolutePath);
      },
      exists: (absolutePath): boolean => {
        existsCalls += 1;
        return nodeWorkspaceFs.exists(absolutePath);
      },
      ...(descriptorUtf8 === undefined
        ? {}
        : {
            readFileUtf8SameDescriptor: (
              absolutePath: string,
              maxBytes: number,
              hardLinkPolicy: WorkspaceHardLinkPolicy,
              expected: WorkspaceStat,
            ): WorkspaceDescriptorUtf8Read => {
              descriptorUtf8Calls += 1;
              const value = descriptorUtf8(absolutePath, maxBytes, hardLinkPolicy, expected);
              contentReadBytes += value.sizeBytes;
              recordExcerptRead(value.sizeBytes);
              return value;
            },
          }),
      ...(containedDescriptorUtf8 === undefined
        ? {}
        : {
            readFileUtf8WithinRootSameDescriptor: (
              canonicalRoot: string,
              absolutePath: string,
              maxBytes: number,
              hardLinkPolicy: WorkspaceHardLinkPolicy,
              completeness: WorkspaceDescriptorReadCompleteness,
            ): WorkspaceDescriptorUtf8Read => {
              containedDescriptorUtf8Calls += 1;
              const value = containedDescriptorUtf8(
                canonicalRoot,
                absolutePath,
                maxBytes,
                hardLinkPolicy,
                completeness,
              );
              contentReadBytes += value.sizeBytes;
              recordExcerptRead(value.sizeBytes);
              return value;
            },
          }),
      ...(readFileBytes === undefined
        ? {}
        : {
            readFileBytes: async (
              absolutePath: string,
              maxBytes: number,
              hardLinkPolicy: WorkspaceHardLinkPolicy,
              expected: WorkspaceStat,
            ): Promise<Uint8Array> => {
              readFileBytesCalls += 1;
              if (listingGuardPhase.getStore() === true) listingGuardReads += 1;
              const value = await readFileBytes(absolutePath, maxBytes, hardLinkPolicy, expected);
              if (listingGuardPhase.getStore() === true) listingGuardBytes += value.byteLength;
              contentReadBytes += value.byteLength;
              recordExcerptRead(value.byteLength);
              return value;
            },
          }),
      ...(readFileUtf8Prefix === undefined
        ? {}
        : {
            readFileUtf8Prefix: (
              absolutePath: string,
              maxBytes: number,
              hardLinkPolicy: WorkspaceHardLinkPolicy,
              expected: WorkspaceStat,
            ): string => {
              readFileUtf8PrefixCalls += 1;
              const value = readFileUtf8Prefix(absolutePath, maxBytes, hardLinkPolicy, expected);
              contentReadBytes += Buffer.byteLength(value, "utf8");
              recordExcerptRead(Buffer.byteLength(value, "utf8"));
              return value;
            },
          }),
      ...(readFileRange === undefined
        ? {}
        : {
            readFileRange: async (
              absolutePath: string,
              startByte: number,
              length: number,
              hardLinkPolicy: WorkspaceHardLinkPolicy,
              expected: WorkspaceStat,
            ): Promise<Uint8Array> => {
              readFileRangeCalls += 1;
              const value = await readFileRange(
                absolutePath,
                startByte,
                length,
                hardLinkPolicy,
                expected,
              );
              contentReadBytes += value.byteLength;
              recordExcerptRead(value.byteLength);
              return value;
            },
          }),
      ...(openFileReader === undefined
        ? {}
        : {
            openFileReader: async (
              absolutePath: string,
              hardLinkPolicy: WorkspaceHardLinkPolicy,
              expected: WorkspaceStat,
            ): Promise<WorkspaceFileReader> => {
              openFileReaderCalls += 1;
              const reader = await openFileReader.call(
                nodeWorkspaceFs,
                absolutePath,
                hardLinkPolicy,
                expected,
              );
              return {
                close: (): Promise<void> => reader.close(),
                readRange: async (startByte: number, length: number): Promise<Uint8Array> => {
                  readerReadRangeCalls += 1;
                  const value = await reader.readRange(startByte, length);
                  contentReadBytes += value.byteLength;
                  recordExcerptRead(value.byteLength);
                  return value;
                },
              };
            },
          }),
    },
    excerptReads: () => ({ readCalls: excerptReadCalls, contentReadBytes: excerptReadBytes }),
    listingGuards: () => ({
      contentReadBytes: listingGuardBytes,
      stat: listingGuardStats,
      realPath: listingGuardRealPaths,
      readCalls: listingGuardReads,
    }),
    counts: () => ({
      readFileUtf8: readFileUtf8Calls,
      readFileUtf8SameDescriptor: descriptorUtf8Calls,
      readFileUtf8WithinRootSameDescriptor: containedDescriptorUtf8Calls,
      readFileBytes: readFileBytesCalls,
      readFileUtf8Prefix: readFileUtf8PrefixCalls,
      readFileRange: readFileRangeCalls,
      openFileReader: openFileReaderCalls,
      readerReadRange: readerReadRangeCalls,
      stat: statCalls,
      readDir: readDirCalls,
      unboundedReadDir: unboundedReadDirCalls,
      streamedReadDir: streamedReadDirCalls,
      streamedReadDirEntries,
      readDirEntries,
      realPath: realPathCalls,
      exists: existsCalls,
      contentReadBytes,
    }),
  };
}

function deadlineProbeReader(reader: WorkspaceFileReader, record: () => void): WorkspaceFileReader {
  return {
    close: (): Promise<void> => reader.close(),
    readRange: (startByte, length): Promise<Uint8Array> => {
      record();
      return reader.readRange(startByte, length);
    },
  };
}

function deadlineProbeOptionalReads(fs: WorkspaceFs, record: () => void): Partial<WorkspaceFs> {
  const descriptorUtf8 = fs.readFileUtf8SameDescriptor;
  const readFileBytes = fs.readFileBytes;
  const readFileUtf8Prefix = fs.readFileUtf8Prefix;
  const readFileRange = fs.readFileRange;
  return {
    ...(descriptorUtf8 === undefined
      ? {}
      : {
          readFileUtf8SameDescriptor: (
            path: string,
            maxBytes: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): WorkspaceDescriptorUtf8Read => {
            record();
            return descriptorUtf8.call(fs, path, maxBytes, hardLinkPolicy, expected);
          },
        }),
    ...(readFileBytes === undefined
      ? {}
      : {
          readFileBytes: (
            path: string,
            maxBytes: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): Promise<Uint8Array> => {
            record();
            return readFileBytes.call(fs, path, maxBytes, hardLinkPolicy, expected);
          },
        }),
    ...(readFileUtf8Prefix === undefined
      ? {}
      : {
          readFileUtf8Prefix: (
            path: string,
            maxBytes: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): string => {
            record();
            return readFileUtf8Prefix.call(fs, path, maxBytes, hardLinkPolicy, expected);
          },
        }),
    ...(readFileRange === undefined
      ? {}
      : {
          readFileRange: (
            path: string,
            start: number,
            length: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): Promise<Uint8Array> => {
            record();
            return readFileRange.call(fs, path, start, length, hardLinkPolicy, expected);
          },
        }),
  };
}

function deadlineProbeOptionalWorkspace(fs: WorkspaceFs, record: () => void): Partial<WorkspaceFs> {
  const canonicalWorkspaceRoot = fs.canonicalWorkspaceRoot;
  const openFileReader = fs.openFileReader;
  return {
    ...(canonicalWorkspaceRoot === undefined
      ? {}
      : {
          canonicalWorkspaceRoot: (root: string): string => {
            record();
            return canonicalWorkspaceRoot.call(fs, root);
          },
        }),
    ...(openFileReader === undefined
      ? {}
      : {
          openFileReader: async (
            path: string,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): Promise<WorkspaceFileReader> => {
            record();
            return deadlineProbeReader(
              await openFileReader.call(fs, path, hardLinkPolicy, expected),
              record,
            );
          },
        }),
  };
}

function deadlineFsProbe(
  fs: WorkspaceFs,
  deadlineReached: () => boolean,
): { readonly fs: WorkspaceFs; readonly accessesAfterDeadline: () => number } {
  let lateAccesses = 0;
  const record = (): void => {
    if (deadlineReached()) lateAccesses += 1;
  };
  return {
    fs: {
      ...fs,
      readFileUtf8: (path): string => {
        record();
        return fs.readFileUtf8(path);
      },
      stat: (path): WorkspaceStat => {
        record();
        return fs.stat(path);
      },
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        record();
        return fs.readDir(path, maxEntries);
      },
      realPath: (path): string => {
        record();
        return fs.realPath(path);
      },
      exists: (path): boolean => {
        record();
        return fs.exists(path);
      },
      ...deadlineProbeOptionalReads(fs, record),
      ...deadlineProbeOptionalWorkspace(fs, record),
    },
    accessesAfterDeadline: () => lateAccesses,
  };
}

interface TraversalMeasurement {
  readonly directoryCount: number;
  readonly fileCount: number;
  readonly fixtureContentBytes: number;
  readonly maxReadableFixtureFileBytes: number;
  readonly foundTraversalSymbols: readonly string[];
  readonly searchBudgetClipped: boolean;
  readonly packValid: boolean;
  readonly operations: FsOperationCounts;
  readonly excerptReadOperations: FsOperationCounts;
  readonly actualExcerptReads: { readonly readCalls: number; readonly contentReadBytes: number };
  readonly listingGuardOperations: {
    readonly contentReadBytes: number;
    readonly stat: number;
    readonly realPath: number;
    readonly readCalls: number;
    readonly classifierCalls: number;
  };
  readonly workspaceIo: WorkspaceIoCounts;
  readonly searchCalls: number;
  readonly contextCount: number;
  readonly candidateInventoryBuildCount: number;
  readonly codeIndexBuildCount: number;
  readonly symbolGraphBuildCount: number;
  readonly importGraphBuildCount: number;
  readonly endpointGraphBuildCount: number;
  readonly fileSearchCount: number;
}

interface WorkspaceIoCounts {
  readonly readDirCalls: number;
  readonly readDirEntries: number;
  readonly statCalls: number;
  readonly realPathCalls: number;
  readonly existsCalls: number;
  readonly contentReadCalls: number;
  readonly contentReadBytes: number;
}

type TraversalQueryShape = "single-anchor" | "multi-anchor";

function traversalQueryText(shape: TraversalQueryShape): string {
  if (shape === "single-anchor") {
    return "Trace TraversalAlpha implementations";
  }
  return `Trace ${TRAVERSAL_SYMBOLS.join(" ")} ADR-1001 ADR-1002 RFC-2001 RFC-2002 implementations`;
}

function numericEventExtra(
  extra: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number {
  const value = extra?.[key];
  if (typeof value !== "number") throw new TypeError(`expected numeric activity field: ${key}`);
  return value;
}

function recordEventExtra(
  extra: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> {
  if (extra === undefined) throw new TypeError(`expected activity fields for: ${key}`);
  if (key === "structural") {
    return Object.fromEntries(
      Object.entries(extra)
        .filter(([name]) => name.startsWith("structural"))
        .map(([name, value]) => [`${name[10]?.toLowerCase() ?? ""}${name.slice(11)}`, value]),
    );
  }
  if (key === "workspaceIo") {
    return Object.fromEntries(
      Object.entries(extra)
        .filter(([name]) => name.startsWith("workspaceIo"))
        .map(([name, value]) => [`${name[11]?.toLowerCase() ?? ""}${name.slice(12)}`, value]),
    );
  }
  if (key === "uncertainty") {
    return {
      scopeIncompleteUncertaintyCount: extra.scopeIncompleteUncertaintyCount,
      budgetClippedUncertaintyCount: extra.budgetClippedUncertaintyCount,
      toolUnavailableUncertaintyCount: extra.toolUnavailableUncertaintyCount,
      unsupportedClaimUncertaintyCount: extra.unsupportedClaimUncertaintyCount,
      entailmentUnavailableUncertaintyCount: extra.entailmentUnavailableUncertaintyCount,
    };
  }
  throw new TypeError(`unknown activity field group: ${key}`);
}

function workspaceIoCounts(extra: Readonly<Record<string, unknown>>): WorkspaceIoCounts {
  return {
    readDirCalls: numericEventExtra(extra, "readDirCalls"),
    readDirEntries: numericEventExtra(extra, "readDirEntries"),
    statCalls: numericEventExtra(extra, "statCalls"),
    realPathCalls: numericEventExtra(extra, "realPathCalls"),
    existsCalls: numericEventExtra(extra, "existsCalls"),
    contentReadCalls: numericEventExtra(extra, "contentReadCalls"),
    contentReadBytes: numericEventExtra(extra, "contentReadBytes"),
  };
}

async function measureRetrievalTraversal(
  entryCount: number,
  shape: TraversalQueryShape,
): Promise<TraversalMeasurement> {
  const fixtureRoot = join(ROOT, `traversal-${entryCount.toString()}-${shape}`);
  seedRepoAt(fixtureRoot);
  seedTraversalImplementations(fixtureRoot, entryCount);
  writeFileSync(
    join(fixtureRoot, "package.json"),
    JSON.stringify({ name: "retrieval-traversal-fixture", version: "1.0.0" }),
  );
  const fixtureBytes = fixtureByteStats(fixtureRoot);
  const counted = countingNodeFs();
  const activityLog = createBufferedServerLogSink();
  let classifierCalls = 0;
  const nativeClassification = repoSearchScan.fileListingTextIsReadable;
  const classification = vi
    .spyOn(repoSearchScan, "fileListingTextIsReadable")
    .mockImplementation((...args) => {
      classifierCalls += 1;
      return listingGuardPhase.run(true, () => nativeClassification(...args));
    });
  const nativeExcerpt = workspace.readExcerpt;
  let excerptCalls = 0;
  const excerpt = vi.spyOn(workspace, "readExcerpt").mockImplementation((...args) => {
    excerptCalls += 1;
    return excerptReadPhase.run(true, () => nativeExcerpt(...args));
  });
  const out = await retrieveConnectedContextPack(
    input({
      workspaceRoot: fixtureRoot,
      scope: happyScope({
        workspaceRoot: fixtureRoot,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
      }),
      query: happyQuery({ text: traversalQueryText(shape) }),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: 32 },
    }),
    {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      fs: counted.fs,
      activityLog,
    },
  ).finally(() => {
    classification.mockRestore();
    excerpt.mockRestore();
  });
  expect(excerptCalls).toBeGreaterThan(0);
  expect(counted.excerptReads().readCalls).toBeGreaterThan(0);
  expect(classifierCalls).toBeGreaterThan(0);
  expect(counted.listingGuards().readCalls).toBeGreaterThan(0);
  expect(counted.listingGuards().readCalls).toBeLessThanOrEqual(classifierCalls);
  // This phase is subtracted below, so it needs its own pin: the live classification checks
  // admission and the pre/post-read snapshot. Repeated containment walks must not disappear.
  expect(counted.listingGuards().stat).toBeGreaterThan(0);
  expect(counted.listingGuards().realPath).toBeGreaterThan(0);
  expect(counted.listingGuards().stat).toBeLessThanOrEqual(3 * classifierCalls);
  expect(counted.listingGuards().realPath).toBeLessThanOrEqual(3 * classifierCalls);
  expect(classifierCalls).toBeLessThanOrEqual(countFixtureFiles(fixtureRoot));
  const completedDetails = activityLog.events.find(
    (event) => event.op === "search.connected-context.completion-details",
  );
  const completed = activityLog.events.find(
    (event) => event.op === "search.connected-context.completed",
  );
  const structural = recordEventExtra(completedDetails?.extra, "structural");
  const workspaceIo = recordEventExtra(completedDetails?.extra, "workspaceIo");
  const packPaths = out.pack.files.map((file) => file.scopePath);
  return {
    directoryCount: countFixtureDirectories(fixtureRoot),
    fileCount: countFixtureFiles(fixtureRoot),
    fixtureContentBytes: fixtureBytes.totalBytes,
    maxReadableFixtureFileBytes: Math.min(
      fixtureBytes.largestFileBytes,
      DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
    ),
    foundTraversalSymbols: TRAVERSAL_SYMBOLS.filter((symbol) =>
      packPaths.some((scopePath) => scopePath.endsWith(`/${symbol}.ts`)),
    ),
    searchBudgetClipped: out.pack.uncertainty.some(
      (marker) => marker.kind === "budget-clipped" && marker.claim.includes("searchCalls"),
    ),
    packValid: validateConnectedContextPack(out.pack).ok,
    operations: counted.counts(),
    excerptReadOperations: await measureAcceptedExcerptReads(fixtureRoot, out, completed?.extra),
    actualExcerptReads: counted.excerptReads(),
    listingGuardOperations: { ...counted.listingGuards(), classifierCalls },
    workspaceIo: workspaceIoCounts(workspaceIo),
    searchCalls: out.pack.usage.searchCalls,
    contextCount: numericEventExtra(structural, "contextCount"),
    candidateInventoryBuildCount: numericEventExtra(structural, "candidateInventoryBuildCount"),
    codeIndexBuildCount: numericEventExtra(structural, "codeIndexBuildCount"),
    symbolGraphBuildCount: numericEventExtra(structural, "symbolGraphBuildCount"),
    importGraphBuildCount: numericEventExtra(structural, "importGraphBuildCount"),
    endpointGraphBuildCount: numericEventExtra(structural, "endpointGraphBuildCount"),
    fileSearchCount: numericEventExtra(structural, "fileSearchCount"),
  };
}

async function measureAcceptedExcerptReads(
  fixtureRoot: string,
  output: RetrievalOnlyOutput,
  completion: Readonly<Record<string, unknown>> | undefined,
): Promise<FsOperationCounts> {
  const counted = countingNodeFs();
  const reads = await _readKeptExcerptsForTests(
    output.pack.files.map((file) => file.scopePath),
    {
      searchScope: {
        workspace: { ...fakeWorkspace(), root: fixtureRoot, selectedRoot: fixtureRoot },
        scopeId: "scope-1",
        relativePaths: [],
      },
      fs: counted.fs,
      budget: output.plan.budget,
      initialUsage: ZERO_EXPLORATION_USAGE,
      atomsByPath: new Map(
        output.pack.files.map((file) => [
          file.scopePath,
          file.excerpts.map((excerpt) => excerpt.atom),
        ]),
      ),
      nowMs: () => NOW,
      deadlineAtMs: Number.POSITIVE_INFINITY,
    },
  );
  expect(reads.excerpts.size).toBe(output.pack.usage.filesRead);
  expect(reads.readWindowCount).toBe(numericEventExtra(completion, "excerptReadWindowCount"));
  expect(counted.counts().readDir).toBe(0);
  return counted.counts();
}

function expectVerifiedTargetAudit(
  output: RetrievalOnlyOutput,
  log: ReturnType<typeof createBufferedServerLogSink>,
  measured: ReturnType<typeof countingNodeFs>,
): void {
  const completion = log.events.find(
    (event) => event.op === "search.connected-context.completed",
  )?.extra;
  const details = log.events.find(
    (event) => event.op === "search.connected-context.completion-details",
  )?.extra;
  expect(output.plan.targetDecision?.kind).toBe("contextual");
  expect(completion?.ringSkipReasons).toEqual(["verified-target-context"]);
  expect(details?.augmentationSkipReason).toBe("verified-target-context");
  expect(details?.structuralCandidateInventoryBuildCount).toBe(0);
  expect(details?.structuralCodeIndexBuildCount).toBe(0);
  expect(measured.counts().unboundedReadDir).toBe(0);
  expect(measured.counts().readDir).toBe(measured.counts().streamedReadDir);
}

function expectBoundedRetrievalProducts(measurement: TraversalMeasurement): void {
  expect(measurement.contextCount).toBeGreaterThan(0);
  expect(measurement.contextCount).toBeLessThanOrEqual(3);
  expect(measurement.candidateInventoryBuildCount).toBeGreaterThan(0);
  expect(measurement.candidateInventoryBuildCount).toBeLessThanOrEqual(3);
  expect(measurement.codeIndexBuildCount).toBe(1);
  expect(measurement.symbolGraphBuildCount).toBeGreaterThan(0);
  expect(measurement.symbolGraphBuildCount).toBeLessThanOrEqual(2);
  expect(measurement.importGraphBuildCount).toBe(1);
  expect(measurement.endpointGraphBuildCount).toBe(1);
  expect(measurement.workspaceIo).toEqual({
    readDirCalls: measurement.operations.readDir,
    readDirEntries: measurement.operations.readDirEntries,
    statCalls: measurement.operations.stat,
    realPathCalls: measurement.operations.realPath,
    existsCalls: measurement.operations.exists,
    contentReadCalls: workspaceReadOperationCount(measurement.operations),
    contentReadBytes: measurement.operations.contentReadBytes,
  });
}

function workspaceContentReadOperationCount(operations: FsOperationCounts): number {
  return (
    operations.readFileUtf8 +
    operations.readFileUtf8SameDescriptor +
    operations.readFileUtf8WithinRootSameDescriptor +
    operations.readFileBytes +
    operations.readFileUtf8Prefix +
    operations.readFileRange +
    operations.readerReadRange
  );
}

function workspaceReadOperationCount(operations: FsOperationCounts): number {
  return workspaceContentReadOperationCount(operations) + operations.openFileReader;
}

// Calibrated against the production Node adapter at both fixture sizes with roughly 30% headroom.
// The paired size and anchor-shape checks catch query-invariant work being repeated; these ceilings
// intentionally pin bounded growth, rather than claiming a general asymptotic proof.
//
// #3347 keeps one shared structural inventory. Lexical retrieval, symbol filename discovery,
// and document references each stream the admitted tree once, regardless of their anchor count.
// Count iterator work separately from inventory work; each distinct work type has one traversal.
// The original structural and content-read ceilings remain unchanged.
function expectAbsoluteRetrievalIoBound(measurement: TraversalMeasurement): void {
  const { directoryCount, fileCount, operations } = measurement;
  const contentReadByteCeiling =
    16 * measurement.fixtureContentBytes + 32 * measurement.maxReadableFixtureFileBytes;
  expect(operations.unboundedReadDir).toBe(0);
  expect(operations.readDir - operations.streamedReadDir).toBeLessThanOrEqual(directoryCount + 16);
  expect(operations.streamedReadDir).toBeLessThanOrEqual(3 * directoryCount + 16);
  expect(operations.readDirEntries - operations.streamedReadDirEntries).toBeLessThanOrEqual(
    2 * directoryCount + 32,
  );
  expect(operations.streamedReadDirEntries).toBeLessThanOrEqual(6 * directoryCount + 32);
  expect(workspaceReadOperationCount(operations)).toBeLessThanOrEqual(16 * fileCount + 32);
  expect(operations.contentReadBytes).toBeLessThanOrEqual(contentReadByteCeiling);
  expect(operations.stat - measurement.listingGuardOperations.stat).toBeLessThanOrEqual(
    22 * fileCount + 14 * directoryCount,
  );
  expect(operations.realPath - measurement.listingGuardOperations.realPath).toBeLessThanOrEqual(
    48 * fileCount + 14 * directoryCount,
  );
  expect(operations.exists).toBeLessThanOrEqual(64);
}

function expectLinearRetrievalGrowth(
  small: TraversalMeasurement,
  large: TraversalMeasurement,
): void {
  const addedDirectories = large.directoryCount - small.directoryCount;
  const addedFiles = large.fileCount - small.fileCount;
  const addedFixtureBytes = large.fixtureContentBytes - small.fixtureContentBytes;
  const largestReadableFileBytes = Math.max(
    small.maxReadableFixtureFileBytes,
    large.maxReadableFixtureFileBytes,
  );
  const delta = (key: keyof FsOperationCounts): number =>
    large.operations[key] - small.operations[key];
  const addedReadOperations =
    workspaceReadOperationCount(large.operations) - workspaceReadOperationCount(small.operations);
  // Preserve one structural snapshot and one stream per lexical/symbol/document work type.
  expect(delta("readDir") - delta("streamedReadDir")).toBeLessThanOrEqual(addedDirectories + 16);
  expect(delta("streamedReadDir")).toBeLessThanOrEqual(3 * addedDirectories + 16);
  expect(delta("unboundedReadDir")).toBeLessThanOrEqual(4 * addedDirectories);
  expect(delta("readDirEntries") - delta("streamedReadDirEntries")).toBeLessThanOrEqual(
    2 * addedDirectories + 32,
  );
  expect(delta("streamedReadDirEntries")).toBeLessThanOrEqual(6 * addedDirectories + 32);
  expect(addedReadOperations).toBeLessThanOrEqual(16 * addedFiles + 16);
  expect(delta("contentReadBytes")).toBeLessThanOrEqual(
    16 * addedFixtureBytes + 16 * largestReadableFileBytes,
  );
  expect(
    delta("stat") - (large.listingGuardOperations.stat - small.listingGuardOperations.stat),
  ).toBeLessThanOrEqual(22 * addedFiles + 14 * addedDirectories);
  expect(
    delta("realPath") -
      (large.listingGuardOperations.realPath - small.listingGuardOperations.realPath),
  ).toBeLessThanOrEqual(48 * addedFiles + 14 * addedDirectories);
  expect(delta("exists")).toBe(0);
}

function recordingMicroIndex(): { index: MicroIndex; gets: () => number; sets: () => number } {
  const entries = new Map<string, ConnectedContextPack>();
  let getCalls = 0;
  let setCalls = 0;
  return {
    index: {
      get: (key): ConnectedContextPack | undefined => {
        getCalls += 1;
        return entries.get(key);
      },
      set: (key, pack): void => {
        setCalls += 1;
        entries.set(key, pack);
      },
      delete: (key): void => {
        entries.delete(key);
      },
      clear: (): void => {
        entries.clear();
      },
      size: (): number => entries.size,
    },
    gets: (): number => getCalls,
    sets: (): number => setCalls,
  };
}

describe("scanFirstSymbolLine", () => {
  it("stops inside a large synchronous scan at the absolute request deadline", () => {
    let now = 0;
    const result = scanFirstSymbolLine(
      `${Array.from({ length: 20 }, (_, index) => `const line${String(index)} = 1;`).join("\n")}\n` +
        "export function DeadlineProbe(): void {}\n",
      "DeadlineProbe",
      { signal: undefined, nowMs: () => now++, deadlineMs: 4 },
    );

    expect(result).toEqual({ lineNumber: undefined, deadlineReached: true });
    expect(now).toBe(5);
  });

  it("observes cancellation between individual source lines", () => {
    const controller = new AbortController();
    let clockCalls = 0;
    const nowMs = (): number => {
      clockCalls += 1;
      if (clockCalls === 1) controller.abort();
      return 0;
    };

    expect(() =>
      scanFirstSymbolLine("first line\nexport function CancelProbe(): void {}\n", "CancelProbe", {
        signal: controller.signal,
        nowMs,
        deadlineMs: 100,
      }),
    ).toThrow(CancelledError);
    expect(clockCalls).toBe(1);
  });
});

describe("runGroundedExploration", () => {
  it.each([false, true])(
    "keeps unreadable eligible HTML uncertain with valid matches present: %s",
    async (withValid) => {
      writeFileSync(join(ROOT, "unreadable.html"), "<p>LAB_UNAVAILABLE_PROBE 750 hours</p>\n");
      if (withValid)
        writeFileSync(join(ROOT, "valid.html"), "<p>LAB_UNAVAILABLE_PROBE 1250 hours</p>\n");
      const read = nodeWorkspaceFs.readFileBytes;
      if (read === undefined) throw new Error("missing bounded production byte reader");
      const fs: WorkspaceFs = {
        ...nodeWorkspaceFs,
        readFileBytes: async (...args): Promise<Uint8Array> => {
          if (args[0].endsWith("/unreadable.html"))
            throw Object.assign(new Error("fixture read failed"), { code: "EACCES" });
          return read(...args);
        },
      };
      const activityLog = createBufferedServerLogSink();
      const out = await retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "workspace-root",
            relativePaths: [],
            explicitConnection: true,
          }),
          query: happyQuery({
            text: "Find the exact identifier LAB_UNAVAILABLE_PROBE and its documented value.",
          }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          fs,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
          activityLog,
        },
      );
      expect(out.pack.diagnostics?.coverage?.incomplete).toBe(true);
      expect(out.pack.diagnostics?.coverage?.reasons).toContain("io-error");
      expect(
        out.pack.uncertainty.some(
          (marker) => marker.kind === "scope-incomplete" && marker.claim.includes("io-error"),
        ),
      ).toBe(true);
      expect(out.pack.files.some((file) => file.scopePath === "valid.html")).toBe(withValid);
      expect(out.pack.files.some((file) => file.scopePath === "unreadable.html")).toBe(false);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
      const extra = activityLog.events.find(
        (event) => event.op === "search.connected-context.completed",
      )?.extra;
      expect(extra?.coverageStatus).toBe("incomplete");
      expect(extra?.coverageReasons).toContain("io-error");
      expect(JSON.stringify(activityLog.events)).not.toContain("LAB_UNAVAILABLE_PROBE");
    },
  );

  it("avoids unrelated graph and history work for a complete exact factual lookup in Git", async () => {
    const measured = countingNodeFs();
    const activityLog = createBufferedServerLogSink();
    mkdirSync(join(ROOT, ".git"));
    mkdirSync(join(ROOT, "src/überprüfung"), { recursive: true });
    writeFileSync(
      join(ROOT, "src/überprüfung/status.ts"),
      'export const LAB_UNICODE_MARKER = "Grüße aus dem Suchlabor";\n',
    );
    const history = vi.fn<GitFileHistoryEvidenceProvider>(() => Promise.resolve([]));
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Suche rekursiv nach der exakten Kennung LAB_UNICODE_MARKER. Welche Information steht dort? Nenne den tatsächlichen Unicode-Dateipfad und die belegte Zeile.",
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        fs: measured.fs,
        activityLog,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        gitFileHistoryEvidence: history,
      },
    );
    const file = out.pack.files.find((entry) => entry.scopePath === "src/überprüfung/status.ts");
    expect(file?.excerpts[0]?.content).toContain("Grüße aus dem Suchlabor");
    expect(file?.excerpts[0]?.atom.lineRange?.startLine).toBe(1);
    expect(out.pack.diagnostics?.coverage?.incomplete).toBe(false);
    expectVerifiedTargetAudit(out, activityLog, measured);
    expect(out.pack.usage.searchCalls).toBe(1);
    expect(history).not.toHaveBeenCalled();
    expect(out.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(false);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("preserves retained-result uncertainty for an exact factual lookup in Git", async () => {
    mkdirSync(join(ROOT, ".git"));
    for (const name of ["first", "second"])
      writeFileSync(
        join(ROOT, "src", `${name}.ts`),
        'export const LAB_UNICODE_MARKER = "value";\n',
      );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Find the exact identifier LAB_UNICODE_MARKER and its value.",
          maxResults: 1,
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.diagnostics?.coverage?.incomplete).toBe(true);
    expect(out.pack.diagnostics?.coverage?.reasons).toEqual(["match-cap"]);
    expect(out.pack.diagnostics?.coverage?.filesScanned).toBe(5);
    expect(out.pack.diagnostics?.coverage?.filesAfterPolicy).toBe(5);
    expect(out.pack.uncertainty.some((marker) => marker.kind === "budget-clipped")).toBe(true);
    expect(out.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(false);
  });

  it.each([
    "Which functions reference the exact identifier LAB_UNICODE_MARKER?",
    "Show recent git history for the exact identifier LAB_UNICODE_MARKER.",
  ])(
    "preserves explicitly requested relationship and history work in Git: %s",
    async (question) => {
      mkdirSync(join(ROOT, ".git"));
      writeFileSync(join(ROOT, "src/status.ts"), 'export const LAB_UNICODE_MARKER = "value";\n');
      const history = vi.fn<GitFileHistoryEvidenceProvider>(() => Promise.resolve([]));
      const out = await retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "workspace-root",
            relativePaths: [],
            explicitConnection: true,
          }),
          query: happyQuery({ text: question }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
          gitFileHistoryEvidence: history,
        },
      );
      expect(out.pack.usage.searchCalls).toBeGreaterThan(1);
      expect(history).toHaveBeenCalled();
      expect(out.pack.files.some((file) => file.scopePath === "src/status.ts")).toBe(true);
    },
  );

  it.each(["chapters/35/page-3599.html", "build/service.html", "dist/service.html"])(
    "prioritizes an independently named HTML marker in %s over query prose",
    async (path) => {
      for (let index = 0; index < 60; index += 1) {
        const directory = join(ROOT, "chapters/00");
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, `page-${String(index).padStart(4, "0")}.html`),
          "<p>HTML-Handbuchordner Wartungsintervall Datei Zeile</p>\n",
        );
      }
      mkdirSync(join(ROOT, path.slice(0, path.lastIndexOf("/"))), { recursive: true });
      writeFileSync(
        join(ROOT, path),
        "<h1>Wartung</h1>\n<p>LAB_MANUAL_SERVICE_INTERVAL: Ölwechsel alle 750 Betriebsstunden.</p>\n",
      );
      writeFileSync(
        join(ROOT, "index.html"),
        "<h1>HTML-Handbuchordner</h1>\n<p>Handbuch Datei Zeile Wartungsintervall.</p>\n",
      );
      const out = await retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "workspace-root",
            relativePaths: [],
            explicitConnection: true,
          }),
          query: happyQuery({
            text: "Suche im verbundenen HTML-Handbuchordner rekursiv nach LAB_MANUAL_SERVICE_INTERVAL. Welches Wartungsintervall steht dort? Nenne die belegte Datei und die Zeile.",
          }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          fs: nodeWorkspaceFs,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );
      const target = out.pack.files.find((file) => file.scopePath === path);
      expect(target).toBeDefined();
      expect(target?.excerpts.map((excerpt) => excerpt.content).join("\n")).toContain(
        "750 Betriebsstunden",
      );
      expect(
        target?.excerpts.some((excerpt) => {
          const range = excerpt.atom.lineRange;
          return range !== undefined && range.startLine <= 2 && range.endLine >= 2;
        }),
      ).toBe(true);
      expect(out.pack.omitted.some((entry) => entry.scopePath === path)).toBe(false);
      expect(out.pack.usage.searchCalls).toBe(1);
      expect(out.pack.uncertainty.some((marker) => marker.claim.includes("git-history"))).toBe(
        false,
      );
    },
  );

  it("retains both independently requested HTML facts in a same-filename cluster", async () => {
    for (const [folder, marker, pressure] of [
      ["build", "LAB_DIRECTORY_BUILD", 17],
      ["dist", "LAB_DIRECTORY_DIST", 23],
      ["out", "LAB_DIRECTORY_OUT", 41],
      ["tmp", "LAB_DIRECTORY_TMP", 53],
    ] as const) {
      mkdirSync(join(ROOT, folder), { recursive: true });
      writeFileSync(
        join(ROOT, folder, "service.html"),
        `<p>${marker} Der Prüfwert beträgt ${String(pressure)} bar.</p>\n`,
      );
    }
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Suche im verbundenen Handbuchordner nach LAB_DIRECTORY_BUILD und LAB_DIRECTORY_DIST. Welcher Druck ist jeweils dokumentiert? Nenne beide Dateien und belegte Zeilen.",
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        fs: nodeWorkspaceFs,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    for (const [folder, marker, pressure] of [
      ["build", "LAB_DIRECTORY_BUILD", 17],
      ["dist", "LAB_DIRECTORY_DIST", 23],
    ] as const) {
      const path = `${folder}/service.html`;
      const file = out.pack.files.find((entry) => entry.scopePath === path);
      expect(file?.excerpts.map((entry) => entry.content).join("\n")).toContain(
        `${marker} Der Prüfwert beträgt ${String(pressure)} bar.`,
      );
      expect(file?.excerpts[0]?.atom.lineRange?.startLine).toBe(1);
      expect(out.pack.omitted.some((entry) => entry.scopePath === path)).toBe(false);
    }
    expect(out.plan.targetDecision?.kind).toBe("contextual");
    expect(out.pack.usage.searchCalls).toBe(11);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("accepts a full planner-envelope question with repeated quoted and identifier targets", async () => {
    const marker = `LAB_${"X".repeat(2006)}`;
    const question = `Finde "${marker}" und ${marker} im Handbuch.`.padEnd(4096, " ");
    writeFileSync(join(ROOT, "manual.html"), `<p>${marker}: 750 hours.</p>\n`);
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: question }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        fs: nodeWorkspaceFs,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(
      out.pack.files.find((file) => file.scopePath === "manual.html")?.excerpts[0]?.content,
    ).toContain("750 hours");
    expect(out.pack.usage.searchCalls).toBe(1);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("does not substitute shared identifier fragments for an explicitly quoted absent target", async () => {
    writeFileSync(
      join(ROOT, "manual.html"),
      "<p>LAB_SCALE_TARGET: Ölwechsel alle 1250 Betriebsstunden.</p>\n",
    );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: 'Prüfe rekursiv den exakten Suchbegriff "LAB_SCALE_NOT_PRESENT_924617" im aktuell verbundenen Ordner. Gibt es dafür einen belegten Treffer? Wenn nicht, sage das klar und erfinde keine Fundstelle.',
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        fs: nodeWorkspaceFs,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.files).toEqual([]);
    expect(out.pack.diagnostics?.coverage?.matchesReturned).toBe(0);
    expect(out.pack.diagnostics?.coverage?.incomplete).toBe(false);
    expect(out.plan.targetDecision?.kind).toBe("contextual");
    expect(out.pack.usage.searchCalls).toBe(2);
  });

  it("keeps a complete ordinary-folder literal absence free of unrelated code scan warnings", async () => {
    writeFileSync(join(ROOT, "manual.html"), "<p>Service interval: 750 hours</p>\n");
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: 'Finde rekursiv "LAB_MANUAL_MISSING". Ist dieser Marker im HTML-Handbuch vorhanden?',
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.diagnostics?.coverage?.incomplete).toBe(false);
    expect(out.pack.diagnostics?.coverage?.matchesReturned).toBe(0);
    expect(out.pack.files).toEqual([]);
    expect(out.plan.targetDecision?.kind).toBe("contextual");
    expect(out.pack.usage.searchCalls).toBe(2);
    expect(out.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(false);
    expect(out.pack.uncertainty.some((marker) => marker.kind === "no-evidence")).toBe(true);
  });

  it("preserves requested Git history diagnostics for an ordinary HTML folder", async () => {
    writeFileSync(join(ROOT, "manual.html"), "<p>LAB_MANUAL_SERVICE_INTERVAL: 750 hours</p>\n");
    const provider = vi.fn<GitFileHistoryEvidenceProvider>(() => Promise.resolve([]));
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Show recent git history for LAB_MANUAL_SERVICE_INTERVAL in manual.html",
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        gitFileHistoryEvidence: provider,
      },
    );
    expect(provider).not.toHaveBeenCalled();
    expect(out.pack.uncertainty.some((marker) => marker.claim.includes("git-history"))).toBe(true);
  });

  it.each([
    ["MinifiedStartProbe", "START-VALUE-17"],
    ["MinifiedMiddleProbe", "MIDDLE-VALUE-29"],
    ["MinifiedEndProbe", "END-VALUE-43"],
  ])(
    "retains %s and its value from a near-2MiB one-line ordinary HTML file",
    async (marker, value) => {
      const start = "<html><body><p>MinifiedStartProbe=START-VALUE-17</p>";
      const middle = "<p>MinifiedMiddleProbe=MIDDLE-VALUE-29</p>";
      const end = "<p>MinifiedEndProbe=END-VALUE-43</p></body></html>";
      const targetBytes = 2_097_120;
      const paddingBytes = targetBytes - Buffer.byteLength(start + middle + end);
      const firstPadding = Math.floor(paddingBytes / 2);
      const content =
        start + " ".repeat(firstPadding) + middle + " ".repeat(paddingBytes - firstPadding) + end;
      writeFileSync(join(ROOT, "manual.html"), content);
      expect(statSync(join(ROOT, "manual.html")).size).toBe(targetBytes);
      const activityLog = createBufferedServerLogSink();
      const out = await retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "workspace-root",
            relativePaths: [],
            explicitConnection: true,
          }),
          query: happyQuery({ kind: "exact-symbol", text: marker }),
        }),
        {
          correlationId: undefined,
          activityLog,
          answerer: echoAnswerer,
          fs: nodeWorkspaceFs,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
      const file = out.pack.files.find((candidate) => candidate.scopePath === "manual.html");
      expect(file).toBeDefined();
      const excerpts = file?.excerpts.map((excerpt) => excerpt.content).join("\n") ?? "";
      expect(excerpts).toContain(marker);
      expect(excerpts).toContain(value);
      expect(
        file?.excerpts.every(
          (excerpt) =>
            excerpt.atom.lineRange?.startLine === 1 && excerpt.atom.lineRange.endLine === 1,
        ),
      ).toBe(true);
      expect(out.pack.usage.excerptBytes).toBeLessThanOrEqual(out.pack.budget.excerptBytesMax);
      const completed = activityLog.events.find(
        (event) => event.op === "search.connected-context.completed",
      );
      expect(completed?.extra).toMatchObject({
        excerptAnchoredWindowCount: marker === "MinifiedStartProbe" ? 0 : 1,
      });
      expect(JSON.stringify(completed?.extra).includes(marker)).toBe(false);
      expect(JSON.stringify(completed?.extra).includes(value)).toBe(false);
    },
  );

  it.each([DEFAULT_EXPLORATION_BUDGET.excerptBytesMax, 8192])(
    "keeps disjoint minified values as separate evidence within %i total bytes",
    async (excerptBytesMax) => {
      const start = "<html><body><p>MinifiedStartProbe=START-VALUE-17</p><div>";
      const end = "</div><p>MinifiedEndProbe=END-VALUE-43</p></body></html>";
      writeFileSync(
        join(ROOT, "manual.html"),
        start + "x".repeat(2_097_120 - Buffer.byteLength(start + end)) + end,
      );
      const activityLog = createBufferedServerLogSink();
      const out = await retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "workspace-root",
            relativePaths: [],
            explicitConnection: true,
          }),
          query: happyQuery({
            text: "Vergleiche MinifiedStartProbe und MinifiedEndProbe in manual.html. Welche Werte haben beide?",
          }),
          budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax },
        }),
        {
          correlationId: undefined,
          activityLog,
          contextProfile: DEFAULT_CONTEXT_PROFILE,
          answerer: echoAnswerer,
          fs: nodeWorkspaceFs,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );
      const excerpts =
        out.pack.files.find((file) => file.scopePath === "manual.html")?.excerpts ?? [];
      expect(excerpts.some((excerpt) => excerpt.content.includes("START-VALUE-17"))).toBe(true);
      expect(excerpts.some((excerpt) => excerpt.content.includes("END-VALUE-43"))).toBe(true);
      expect(excerpts).toHaveLength(2);
      expect(new Set(excerpts.map((excerpt) => excerpt.atom.stableId)).size).toBe(2);
      expect(
        excerpts.every(
          (excerpt) =>
            excerpt.atom.lineRange?.startLine === 1 && excerpt.atom.lineRange.endLine === 1,
        ),
      ).toBe(true);
      expect(out.pack.usage.filesRead).toBe(1);
      expect(out.pack.usage.excerptBytes).toBe(
        excerpts.reduce((sum, excerpt) => sum + excerpt.contentBytes, 0),
      );
      expect(out.pack.usage.excerptBytes).toBeLessThanOrEqual(out.pack.budget.excerptBytesMax);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
      const completed = activityLog.events.find(
        (event) => event.op === "search.connected-context.completed",
      );
      expect(completed?.extra).toMatchObject({
        excerptReadWindowCount: 2,
        excerptAnchoredWindowCount: 1,
        contextSelectedExcerptCount: 2,
        usageFilesRead: 1,
      });
      expect(JSON.stringify(completed?.extra).includes("MinifiedStartProbe")).toBe(false);
      expect(JSON.stringify(completed?.extra).includes("END-VALUE-43")).toBe(false);
      expect(JSON.stringify(completed?.extra).includes(ROOT)).toBe(false);
    },
  );

  it("composes plan → search → rank → excerpts → assemble → answer deterministically", async () => {
    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(out.pack.schemaVersion).toBe(CONNECTED_CONTEXT_SCHEMA_VERSION);
    expect(out.pack.scope.scopeId).toBe("scope-1");
    expect(out.pack.query.text).toBe("Investigate src/foo.ts behaviour of `MyClass`");
    expect(out.assistantContent).toContain("Inspected");
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(out.plan?.state).toBe("ready");
    // The pack must always carry uncertainty + omitted as readonly arrays even when empty.
    expect(Array.isArray(out.pack.uncertainty)).toBe(true);
    expect(Array.isArray(out.pack.omitted)).toBe(true);
  });

  it("threads an injected context-pack reranker into assembly when budget allows", async () => {
    let rerankCalls = 0;
    const observedCandidateCounts: number[] = [];
    const reranker: RerankerSeam = {
      name: "test-model-reranker",
      isAvailable: () => Promise.resolve({ available: true, modelLabel: "test-reranker" }),
      rerank: (candidates, atomsByPath, topK) => {
        rerankCalls += 1;
        observedCandidateCounts.push(candidates.length);
        expect(topK).toBe(candidates.length);
        expect(atomsByPath.size).toBeGreaterThan(0);
        return Promise.resolve([...candidates].reverse());
      },
    };

    const out = await runGroundedExploration(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
        query: happyQuery({ text: "Investigate src/foo.ts and src/bar.ts MyClass" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        contextPackReranker: reranker,
      },
    );

    expect(rerankCalls).toBe(1);
    expect(observedCandidateCounts[0]).toBeGreaterThan(0);
    expect(out.pack.usage.rerankCalls).toBe(1);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("threads an injected repository semantic-search provider into lexical retrieval", async () => {
    let semanticCalls = 0;
    const semanticProvider: SemanticSearchProvider = {
      name: "local fixture",
      search: (request) => {
        semanticCalls += 1;
        expect(request.documents.map((document) => document.scopePath)).toContain("src/bar.ts");
        return Promise.resolve([
          {
            scopePath: "src/bar.ts",
            line: 2,
            score: 0.99,
          },
        ]);
      },
    };

    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
      repoSemanticSearchProvider: semanticProvider,
    });

    expect(semanticCalls).toBeGreaterThan(0);
    expect(out.pack.files.some((file) => file.scopePath === "src/bar.ts")).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("runs structural adapters over planner anchors instead of the full natural-language prompt", async () => {
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.files.some((file) => file.scopePath === "tests/foo.test.ts")).toBe(true);
    expect(
      out.pack.files
        .find((file) => file.scopePath === "tests/foo.test.ts")
        ?.excerpts.some((excerpt) => excerpt.content.includes("MyClass")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("follows structural edges for one bounded second hop", async () => {
    writeFileSync(join(ROOT, "src/root.ts"), 'import { midValue } from "./mid";\nmidValue();\n');
    writeFileSync(join(ROOT, "src/mid.ts"), 'import { leafValue } from "./leaf";\nleafValue();\n');
    writeFileSync(join(ROOT, "src/leaf.ts"), "export const leafValue = 42;\n");
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
        query: happyQuery({ text: "Investigate src/root.ts data flow" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.files.some((file) => file.scopePath === "src/leaf.ts")).toBe(true);
    expect(
      out.pack.files
        .find((file) => file.scopePath === "src/leaf.ts")
        ?.excerpts.some((excerpt) => excerpt.content.includes("leafValue")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("surfaces structural adapter unavailability through sanitized uncertainty", async () => {
    const adapter = importGraphAdapter as {
      isAvailable: typeof importGraphAdapter.isAvailable;
    };
    const originalIsAvailable = adapter.isAvailable;
    adapter.isAvailable = (): Promise<boolean> => Promise.resolve(false);
    try {
      const out = await retrieveConnectedContextPack(input(), {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      });
      const marker = out.pack.uncertainty.find(
        (entry) => entry.kind === "tool-unavailable" && entry.claim.includes("import-graph"),
      );
      expect(marker?.claim).toBe("structural adapter unavailable: import-graph");
      expect(marker?.claim).not.toContain(ROOT);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    } finally {
      adapter.isAvailable = originalIsAvailable;
    }
  });

  it("surfaces incomplete structural coverage through sanitized uncertainty", async () => {
    writeFileSync(
      join(ROOT, "src/huge.ts"),
      `export const HugeGraphOnly = 1;\n${"x".repeat(2_200_000)}\n`,
    );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Investigate HugeGraphOnly data flow" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    const marker = out.pack.uncertainty.find(
      (entry) =>
        entry.kind === "scope-incomplete" &&
        entry.claim.includes("structural adapter coverage was incomplete") &&
        entry.claim.includes("import-graph indexed"),
    );
    expect(marker?.claim).toContain("import-graph indexed");
    expect(marker?.claim).toContain("skipped 0 file(s)");
    expect(marker?.claim).toContain("partially indexed 1 file(s)");
    expect(marker?.claim).not.toContain(ROOT);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("records the exploration plan before workspace detection or repository exploration", async () => {
    const events: string[] = [];
    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      recordPlan: (plan) => {
        events.push(`record:${plan.planId}`);
      },
      detectWorkspace: () => {
        events.push("detect");
        return fakeWorkspace();
      },
    });
    const plan = out.plan;
    if (plan === undefined) {
      throw new Error("expected orchestrator output to expose the recorded plan");
    }
    expect(events).toEqual([`record:${plan.planId}`, "detect"]);
  });

  it("rethrows an existing WorkspaceNotFoundError from workspace-root admission instead of flattening it", async () => {
    // #3347 P2: assertGroundedWorkspaceRootAllowed's catch block previously replaced ANY non-denial
    // error — including one that was already a typed WorkspaceNotFoundError — with a brand new,
    // generic WorkspaceNotFoundError. Force resolveRecordedWorkspaceRoot's underlying realPath call
    // to throw an already-typed WorkspaceNotFoundError carrying a distinguishing marker and assert
    // that exact error (not a replacement) is what the request rejects with.
    const marker = "existing-workspace-not-found-marker";
    const failingFs: WorkspaceFs = {
      ...countingNodeFs().fs,
      realPath: (path): never => {
        throw new WorkspaceNotFoundError(marker, path, [path]);
      },
    };

    const expectation = retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which package manager does this repository use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        fs: failingFs,
      },
    );

    await expect(expectation).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(expectation).rejects.toMatchObject({ message: marker });
  });

  it("rethrows a cancellation from workspace-root admission instead of flattening it into WorkspaceNotFoundError", async () => {
    // Same catch-block flattening bug (#3347 P2), for the CancelledError case cursor's review
    // specifically named: any CancelledError that realPath might surface must propagate as a real
    // cancellation, never get replaced with a generic "workspace root is unavailable" error.
    const controller = new AbortController();
    const failingFs: WorkspaceFs = {
      ...countingNodeFs().fs,
      realPath: (): never => {
        throw new CancelledError("grounded repository request cancelled");
      },
    };

    const expectation = retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which package manager does this repository use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        fs: failingFs,
        signal: controller.signal,
      },
    );

    await expect(expectation).rejects.toBeInstanceOf(CancelledError);
  });

  it("passes the question and the full pack to the injected answerer", async () => {
    let observedQuestion = "";
    let observedPack: ConnectedContextPack | undefined;
    const recordingAnswerer: GroundedAnswerer = {
      answer: (question, pack) => {
        observedQuestion = question;
        observedPack = pack;
        return Promise.resolve("recorded");
      },
    };
    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: recordingAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(observedQuestion).toBe("Investigate src/foo.ts behaviour of `MyClass`");
    if (observedPack === undefined)
      throw new Error("expected answerer to receive the context pack");
    expect({ ...out.pack, uncertainty: observedPack.uncertainty }).toStrictEqual(observedPack);
    // The recording answerer cites nothing: that is an uncited answer, not a fabricated citation.
    expect(out.pack.uncertainty).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "uncited-answer" })]),
    );
    expect(out.pack.uncertainty.some((marker) => marker.kind === "unsupported-citation")).toBe(
      false,
    );
    expect(out.assistantContent).toBe("recorded");
  });

  it("uses answer-only context for generation while retaining the original retrieval query", async () => {
    let observedQuestion = "";
    const original = input();
    const out = await runGroundedExploration(
      {
        ...original,
        answerQuestion:
          "User question:\nInvestigate src/foo.ts\n\nIncluded memory context:\nPrefer concise answers.",
      },
      {
        correlationId: undefined,
        answerer: {
          answer: (question) => {
            observedQuestion = question;
            return Promise.resolve("recorded");
          },
        },
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(observedQuestion).toContain("Prefer concise answers");
    expect(out.pack.query.text).toBe(original.query.text);
    expect(out.pack.query.text).not.toContain("Prefer concise answers");
  });

  it("prefers grounded-qa.ts for exact symbol-definition questions from issue #672", async () => {
    seedIssue672Repo();
    const out = await retrieveConnectedContextPack(
      issue672Input("Where is handleGroundedAsk defined? Cite the exact file."),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => issue672Workspace(),
      },
    );
    expect(out.pack.files[0]?.scopePath).toBe("packages/keiko-server/src/grounded-qa.ts");
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) => excerpt.content.includes("handleGroundedAsk")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it.each([
    [
      "Where is handleGroundedAsk defined? Cite the exact file.",
      "grounded-qa.ts",
      "function handleGroundedAsk",
    ],
    [
      "Which file implements the POST /api/chats/messages/grounded route? Cite evidence.",
      "routes.ts",
      'method: "POST"',
    ],
  ])(
    "preserves the explicit implementation priority under a one-file budget: %s",
    async (question, filename, evidence) => {
      seedIssue672Repo();
      const requested = issue672Input(question);
      const out = await retrieveConnectedContextPack(
        { ...requested, budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 1 } },
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => issue672Workspace(),
        },
      );
      expect(out.pack.files.map((file) => file.scopePath)).toEqual([
        `packages/keiko-server/src/${filename}`,
      ]);
      expect(
        out.pack.files[0]?.excerpts.some((excerpt) => excerpt.content.includes(evidence)),
      ).toBe(true);
      expect(out.pack.usage.filesRead).toBe(1);
      expect(validateConnectedContextPack(out.pack)).toEqual({ ok: true });
    },
  );

  it("prefers routes.ts for exact route-implementation questions from issue #672", async () => {
    seedIssue672Repo();
    const out = await retrieveConnectedContextPack(
      issue672Input(
        "Which file implements the POST /api/chats/messages/grounded route? Answer briefly and cite evidence.",
      ),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => issue672Workspace(),
      },
    );
    expect(out.pack.files[0]?.scopePath).toBe("packages/keiko-server/src/routes.ts");
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) =>
        excerpt.content.includes("/api/chats/messages/grounded"),
      ),
    ).toBe(true);
    expect(out.pack.files.map((file) => file.scopePath)).toContain(
      "packages/keiko-server/src/grounded-qa.ts",
    );
    expect(
      out.pack.files
        .find((file) => file.scopePath === "packages/keiko-server/src/grounded-qa.ts")
        ?.excerpts.some((excerpt) => excerpt.content.includes("function handleGroundedAsk")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("follows route-discovered handlers through one workspace index on cold and warm retrieval", async () => {
    seedCrowdedHandlerTraceRepo();
    const workspaceIndex = createWorkspaceIndex();
    const activityLog = createBufferedServerLogSink();
    let workspaceIndexFactoryCalls = 0;
    const retrieve = (): ReturnType<typeof retrieveConnectedContextPack> =>
      retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "workspace-root",
            relativePaths: [],
            explicitConnection: true,
          }),
          query: happyQuery({
            text: "Welche Datei registriert POST /api/opaque/x7, welcher Handler steht dort und wo ist er definiert?",
          }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
          activityLog,
          workspaceIndexForRoot: () => {
            workspaceIndexFactoryCalls += 1;
            return workspaceIndex;
          },
        },
      );

    const cold = await retrieve();
    const warm = await retrieve();

    for (const out of [cold, warm]) {
      expect(out.pack.files.map((file) => file.scopePath)).toContain("src/service.ts");
      expect(
        out.pack.files
          .find((file) => file.scopePath === "src/service.ts")
          ?.excerpts.some(
            (excerpt) =>
              excerpt.content.includes("function dispatchWorkUnit") &&
              excerpt.content.includes("runPipeline"),
          ),
      ).toBe(true);
      expect(out.pack.files.map((file) => file.scopePath)).toContain("src/pipeline.ts");
    }
    const completedDetails = activityLog.events.filter(
      (event) => event.op === "search.connected-context.completion-details",
    );
    expect(workspaceIndexFactoryCalls).toBe(2);
    expect(completedDetails).toHaveLength(2);
    expect(
      numericEventExtra(
        recordEventExtra(completedDetails[1]?.extra, "structural"),
        "textSearchCount",
      ),
    ).toBe(1);
  });

  it("sends a deep query-matching definition instead of shallow unrelated same-file helpers", async () => {
    const fact = seedLateRelevantDelegationRepo();
    const query = happyQuery({
      text: "Trace POST /api/opaque/x7 through recursive candidate discovery.",
      maxResults: 100,
    });
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
        query,
        budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192 },
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    const selected = out.pack.files.find((file) => file.scopePath === "src/service.ts");
    expect(selected?.excerpts.some((excerpt) => excerpt.content.includes(fact))).toBe(true);
    const sent = fittedGroundedGatewayPrompt(
      query.text,
      out.pack,
      (value: unknown): unknown => value,
    );
    expect(sent.messages.some((message) => message.content.includes(fact))).toBe(true);
    const matcher = buildMatcher(query);
    const evidence = selected?.excerpts.find((excerpt) => excerpt.content.includes(fact));
    const source = repositorySourceLines(evidence?.content ?? "", "src/service.ts");
    const expected = repositorySourceMaxLineScore(
      source.map((line) => ({ score: matcher.match(line.raw, line) })),
    );
    expect(expected).toBeGreaterThan(0);
    expect(evidence?.atom.lineRange).toBeDefined();
    expect(out.pack.usage.excerptBytes).toBeLessThanOrEqual(out.pack.budget.excerptBytesMax);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("runs one bounded structural adapter pass for an exact route trace", async () => {
    seedCrowdedHandlerTraceRepo();
    const adapter = importGraphAdapter as { lookup: typeof importGraphAdapter.lookup };
    const originalLookup = adapter.lookup;
    let calls = 0;
    adapter.lookup = (...args): ReturnType<typeof originalLookup> => {
      calls += 1;
      return originalLookup(...args);
    };
    try {
      await retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "workspace-root",
            relativePaths: [],
            explicitConnection: true,
          }),
          query: happyQuery({
            text: "Welche Datei registriert POST /api/opaque/x7, welcher Handler steht dort und wo ist er definiert?",
          }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );
    } finally {
      adapter.lookup = originalLookup;
    }

    expect(calls).toBe(1);
  });

  it.each([
    { text: "Wo ist KeikoNonexistentQuantumHandler987 definiert?", contextual: false },
    {
      text: "Wo ist KeikoNonexistentQuantumHandler987 definiert? Erfinde nichts.",
      contextual: true,
    },
  ])(
    "distinguishes strict missing-definition absence from secondary context: $text",
    async ({ text, contextual }) => {
      const adapter = importGraphAdapter as { lookup: typeof importGraphAdapter.lookup };
      const originalLookup = adapter.lookup;
      let calls = 0;
      let semanticCalls = 0;
      const semanticSearchProvider: SemanticSearchProvider = {
        name: "irrelevant exact-definition fallback",
        search: () => {
          semanticCalls += 1;
          return Promise.resolve([{ scopePath: "src/foo.ts", score: 0.99, line: 1 }]);
        },
      };
      adapter.lookup = (...args): ReturnType<typeof originalLookup> => {
        calls += 1;
        return originalLookup(...args);
      };
      const out = await (async (): Promise<
        Awaited<ReturnType<typeof retrieveConnectedContextPack>>
      > => {
        try {
          return await retrieveConnectedContextPack(
            input({
              scope: happyScope({
                kind: "workspace-root",
                relativePaths: [],
                explicitConnection: true,
              }),
              query: happyQuery({
                text,
              }),
            }),
            {
              correlationId: undefined,
              answerer: echoAnswerer,
              nowMs: () => NOW,
              detectWorkspace: () => fakeWorkspace(),
              semanticSearchProvider,
            },
          );
        } finally {
          adapter.lookup = originalLookup;
        }
      })();

      if (contextual) {
        expect(calls).toBeGreaterThan(0);
        expect(semanticCalls).toBe(1);
        expect(out.pack.files.map((file) => file.scopePath)).toEqual(["src/foo.ts"]);
        expect(
          out.pack.files
            .flatMap((file) => file.excerpts)
            .every((excerpt) => excerpt.atom.provenance.tool.startsWith("repo.semanticSearch:")),
        ).toBe(true);
        expect(
          out.pack.files
            .flatMap((file) => file.excerpts)
            .some((excerpt) => excerpt.content.includes("KeikoNonexistentQuantumHandler987")),
        ).toBe(false);
      } else {
        expect(out.pack.files).toEqual([]);
        expect(calls).toBe(0);
        expect(semanticCalls).toBe(0);
        expect(out.pack.uncertainty.some((marker) => marker.kind === "no-evidence")).toBe(true);
      }
    },
  );

  it("retrieves Express-style API route declarations through the full context-pack path", async () => {
    mkdirSync(join(ROOT, "src/http"), { recursive: true });
    mkdirSync(join(ROOT, "docs"), { recursive: true });
    writeFileSync(
      join(ROOT, "src/http/routes.ts"),
      'router.post("/api/payments/:id/refund", async (req, res) => refundPayment(req, res));\n',
    );
    writeFileSync(
      join(ROOT, "docs/routes.md"),
      "The POST /api/payments/:id/refund endpoint refunds a payment.\n",
    );

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Which file implements the POST /api/payments/:id/refund route?",
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files[0]?.scopePath).toBe("src/http/routes.ts");
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) =>
        excerpt.content.includes("/api/payments/:id/refund"),
      ),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("retrieves the source file for a test-class lookup through the full context-pack path", async () => {
    mkdirSync(join(ROOT, "src/payments"), { recursive: true });
    mkdirSync(join(ROOT, "tests/payments"), { recursive: true });
    writeFileSync(
      join(ROOT, "src/payments/PaymentService.ts"),
      "export class PaymentService {\n  authorize(): boolean { return true; }\n}\n",
    );
    writeFileSync(
      join(ROOT, "tests/payments/PaymentService.test.ts"),
      'describe("PaymentServiceTest", () => it("covers authorize", () => {}));\n',
    );

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Where is the source implementation for PaymentServiceTest?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files[0]?.scopePath).toBe("src/payments/PaymentService.ts");
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) => excerpt.content.includes("PaymentService")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it.each([
    "Was siehst du?",
    "What can you see?",
    "Give me an overview of this codebase structure.",
  ])("explores a connected repository with no metadata or matching prose: %s", async (text) => {
    seedRepo();
    const log = createBufferedServerLogSink();
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text }),
      }),
      {
        correlationId: "connected-orientation",
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        activityLog: log,
      },
    );
    expect(out.pack.files.map((file) => file.scopePath)).toContain("src/foo.ts");
    expect(
      out.pack.files
        .flatMap((file) => file.excerpts)
        .some((excerpt) => excerpt.content.includes("export function MyClass")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    expect(log.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: "search.connected-context.completed",
          correlationId: "connected-orientation",
        }),
      ]),
    );
    expect(log.lines().join("\n")).not.toContain("export function MyClass");
  });

  it("keeps targeted overview terms and semantic retrieval beyond the shallow listing output", async () => {
    mkdirSync(join(ROOT, "src/auth/deep/nested"), { recursive: true });
    for (let index = 0; index < 220; index += 1)
      writeFileSync(join(ROOT, `shallow-${String(index)}.ts`), "export const unrelated = 0;\n");
    const target = "src/auth/deep/nested/session.ts";
    writeFileSync(join(ROOT, target), "export const authentication = 'module session renewal';\n");
    let semanticCalls = 0;
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "How is the authentication module structured?", maxResults: 50 }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        repoSemanticSearchProvider: {
          name: "targeted-overview-review",
          search: ({ documents }) => {
            semanticCalls += 1;
            return Promise.resolve(
              documents.some((document) => document.scopePath === target)
                ? [{ scopePath: target, score: 1, line: 1 }]
                : [],
            );
          },
        },
      },
    );
    expect(out.pack.files.map((file) => file.scopePath)).toContain(target);
    expect(semanticCalls).toBe(1);
  });

  it("records executed and skipped rings plus augmentation decisions without source bodies", async () => {
    writeFileSync(join(ROOT, "manual.html"), "<p>other information</p>\n");
    const log = createBufferedServerLogSink();
    await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: 'Find the exact identifier "MISSING_REVIEW_PROBE".' }),
      }),
      {
        correlationId: "review-ring-skip",
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        activityLog: log,
      },
    );
    const event = log.events.find((item) => item.op === "search.connected-context.completed");
    expect(event?.extra).toMatchObject({
      executedRingKinds: ["lexical"],
      skippedRingKinds: ["git-history"],
      ringSkipReasons: ["no-git-metadata"],
      augmentationSkipped: true,
    });
    expect(
      log.events.find((item) => item.op === "search.connected-context.completion-details")?.extra
        ?.augmentationSkipReason,
    ).toBe("literal-absence");
    expect(log.lines().join("\n")).not.toContain("MISSING_REVIEW_PROBE");
  });

  it("grounds direct package.json metadata requests without leaking internal .keiko evidence", async () => {
    writeFileSync(join(ROOT, "package.json"), '{\n  "packageManager": "npm@11.16.0"\n}\n');
    mkdirSync(join(ROOT, ".keiko/evidence/qi"), { recursive: true });
    writeFileSync(
      join(ROOT, ".keiko/evidence/qi/run.candidates.json"),
      '{"packageManager":"stale-internal-value","connected":"repository","context":"evidence"}\n',
    );

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Using only the connected repository context, what is the exact packageManager value in package.json? Reply with the exact value only.",
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files[0]?.scopePath).toBe("package.json");
    expect(out.pack.files.every((file) => !file.scopePath.startsWith(".keiko/"))).toBe(true);
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) =>
        excerpt.content.includes('"packageManager": "npm@11.16.0"'),
      ),
    ).toBe(true);
    expect(JSON.stringify(out.pack)).not.toContain(".keiko/evidence");
    expect(JSON.stringify(out.pack)).not.toContain("stale-internal-value");
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("uses directory entries instead of stat probes for absent metadata candidates", async () => {
    writeFileSync(join(ROOT, "package.json"), '{\n  "packageManager": "npm@11.16.0"\n}\n');
    const base = countingNodeFs();
    const absentLockfiles = new Set([
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
    ]);
    let absentLockfileStats = 0;
    const fs: WorkspaceFs = {
      ...base.fs,
      stat: (absolutePath): WorkspaceStat => {
        const relPath = relative(ROOT, absolutePath).replace(/\\/gu, "/");
        if (absentLockfiles.has(relPath)) {
          absentLockfileStats += 1;
        }
        return base.fs.stat(absolutePath);
      },
    };

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Using only the connected repository context, what is the exact packageManager value in package.json?",
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs,
      },
    );

    expect(out.pack.files.map((file) => file.scopePath)).toContain("package.json");
    expect(absentLockfileStats).toBe(0);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("does not trust a regular-file Dirent as hardlink-safe manifest evidence", async () => {
    writeFileSync(join(ROOT, "package.json"), JSON.stringify({ packageManager: "npm@11.16.0" }));
    writeFileSync(join(ROOT, ".env"), "<project>private manifest bytes</project>\n");
    const manifestPath = join(ROOT, "pom.xml");
    linkSync(join(ROOT, ".env"), manifestPath);
    let hardlinkDescriptorReads = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileUtf8SameDescriptor: (
        absolutePath,
        maxBytes,
        hardLinkPolicy,
        expected,
      ): WorkspaceDescriptorUtf8Read => {
        if (absolutePath === realpathSync(manifestPath)) hardlinkDescriptorReads += 1;
        const read = nodeWorkspaceFs.readFileUtf8SameDescriptor;
        if (read === undefined) throw new Error("same-descriptor read is unavailable");
        return read(absolutePath, maxBytes, hardLinkPolicy, expected);
      },
    };

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which Java version does this workspace use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs,
      },
    );

    expect(hardlinkDescriptorReads).toBe(0);
    expect(out.pack.files.map((file) => file.scopePath)).not.toContain("pom.xml");
  });

  it.each([false, true])(
    "discovers workspace packages from UTF-16 manifests (bigEndian=%s)",
    async (bigEndian) => {
      mkdirSync(join(ROOT, "custom-services/payments"), { recursive: true });
      const bytes = Buffer.from(
        "\uFEFF" + JSON.stringify({ workspaces: ["custom-services/*"] }),
        "utf16le",
      );
      writeFileSync(join(ROOT, "package.json"), bigEndian ? bytes.swap16() : bytes);
      writeFileSync(
        join(ROOT, "custom-services/payments/pom.xml"),
        "<project><java.version>21</java.version></project>\n",
      );
      const out = await retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "workspace-root",
            relativePaths: [],
            explicitConnection: true,
          }),
          query: happyQuery({
            text: "Welche Technologien und Abhängigkeiten verwendet dieses Projekt?",
          }),
        }),
        { correlationId: undefined, answerer: echoAnswerer, nowMs: () => NOW },
      );
      expect(out.pack.files.map((file) => file.scopePath)).toContain(
        "custom-services/payments/pom.xml",
      );
      expect(
        out.pack.uncertainty.some((marker) => marker.claim.includes("workspace-manifest-")),
      ).toBe(false);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    },
  );

  it("classifies an undecodable workspace manifest in metadata coverage", async () => {
    writeFileSync(join(ROOT, "package.json"), Buffer.from([0xff, 0xfe, 0x00, 0xd8]));
    const activityLog = createBufferedServerLogSink();
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Welche Technologien und Abhängigkeiten verwendet dieses Projekt?",
        }),
      }),
      { correlationId: "manifest-codec", answerer: echoAnswerer, nowMs: () => NOW, activityLog },
    );
    expect(
      out.pack.uncertainty.some((marker) =>
        marker.claim.includes("workspace-manifest-shape-unsupported:1"),
      ),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    const completed = activityLog.events.find(
      (event) => event.op === "search.connected-context.completed",
    );
    expect(completed?.correlationId).toBe("manifest-codec");
    const incompleteCount = out.pack.uncertainty.filter(
      (marker) => marker.kind === "scope-incomplete",
    ).length;
    expect(numericEventExtra(completed?.extra, "scopeIncompleteUncertaintyCount")).toBe(
      incompleteCount,
    );
    const line = activityLog
      .lines()
      .find((entry) => entry.includes('"op":"search.connected-context.completed"'));
    expect(line).toContain('"correlationId":"manifest-codec"');
    expect(line).toContain(`"scopeIncompleteUncertaintyCount":${String(incompleteCount)}`);
    expect(line).not.toContain("package.json");
  });

  it("reads workspace patterns through the bounded same-descriptor byte port", async () => {
    mkdirSync(join(ROOT, "custom-services/payments"), { recursive: true });
    writeFileSync(
      join(ROOT, "package.json"),
      JSON.stringify({ workspaces: ["custom-services/*"] }),
    );
    writeFileSync(
      join(ROOT, "custom-services/payments/pom.xml"),
      "<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>\n",
    );
    const descriptorCaps: number[] = [];
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileBytes: (absolutePath, maxBytes, hardLinkPolicy, expected) => {
        if (absolutePath === realpathSync(join(ROOT, "package.json"))) {
          descriptorCaps.push(maxBytes);
        }
        const read = nodeWorkspaceFs.readFileBytes;
        if (read === undefined) throw new Error("bounded descriptor byte port missing");
        return read(absolutePath, maxBytes, hardLinkPolicy, expected);
      },
    };

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which Java version does the payments service use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs,
      },
    );

    expect(descriptorCaps).toContain(2_097_152);
    expect(out.pack.files.map((file) => file.scopePath)).toContain(
      "custom-services/payments/pom.xml",
    );
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("does not stat or read a workspace manifest alias that resolves into a denied path", async () => {
    mkdirSync(join(ROOT, ".aws"), { recursive: true });
    writeFileSync(join(ROOT, "package.json"), JSON.stringify({ workspaces: [] }));
    writeFileSync(
      join(ROOT, ".aws/credentials"),
      JSON.stringify({ workspaces: ["private-services/*"] }),
    );
    const lexicalManifest = join(ROOT, "package.json");
    const deniedTarget = realpathSync(join(ROOT, ".aws/credentials"));
    const realRoot = realpathSync(ROOT);
    let deniedStats = 0;
    let deniedReads = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      realPath: (absolutePath): string =>
        absolutePath === lexicalManifest ? deniedTarget : nodeWorkspaceFs.realPath(absolutePath),
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] =>
        nodeWorkspaceFs
          .readDir(absolutePath, maxEntries)
          .map((entry) =>
            absolutePath === realRoot && entry.name === "package.json"
              ? { ...entry, isFile: false, isSymbolicLink: true }
              : entry,
          ),
      stat: (absolutePath): WorkspaceStat => {
        if (absolutePath === deniedTarget) deniedStats += 1;
        return nodeWorkspaceFs.stat(absolutePath);
      },
      readFileBytes: (absolutePath, maxBytes, hardLinkPolicy, expected): Promise<Uint8Array> => {
        if (absolutePath === deniedTarget) deniedReads += 1;
        const read = nodeWorkspaceFs.readFileBytes;
        if (read === undefined) throw new Error("bounded descriptor byte port missing");
        return read(absolutePath, maxBytes, hardLinkPolicy, expected);
      },
      readFileUtf8SameDescriptor: (
        absolutePath,
        maxBytes,
        hardLinkPolicy,
        expected,
      ): WorkspaceDescriptorUtf8Read => {
        if (absolutePath === deniedTarget) deniedReads += 1;
        const read = nodeWorkspaceFs.readFileUtf8SameDescriptor;
        if (read === undefined) throw new Error("same-descriptor read is unavailable");
        return read(absolutePath, maxBytes, hardLinkPolicy, expected);
      },
    };

    await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which package manager does this workspace use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs,
      },
    );

    expect(deniedStats).toBe(0);
    expect(deniedReads).toBe(0);
  });

  it("does not enumerate a safe directory alias that resolves into a denied directory", async () => {
    mkdirSync(join(ROOT, "packages"), { recursive: true });
    mkdirSync(join(ROOT, ".aws/private-service"), { recursive: true });
    writeFileSync(join(ROOT, ".aws/private-service/pom.xml"), "<project>private</project>\n");
    const lexicalPackages = join(ROOT, "packages");
    const deniedDirectory = realpathSync(join(ROOT, ".aws"));
    let deniedStats = 0;
    let deniedListings = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      realPath: (absolutePath): string =>
        absolutePath === lexicalPackages ? deniedDirectory : nodeWorkspaceFs.realPath(absolutePath),
      stat: (absolutePath): WorkspaceStat => {
        if (absolutePath === deniedDirectory) deniedStats += 1;
        return nodeWorkspaceFs.stat(absolutePath);
      },
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        if (absolutePath === deniedDirectory) deniedListings += 1;
        return nodeWorkspaceFs.readDir(absolutePath, maxEntries);
      },
    };

    await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which Java version does this workspace use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs,
      },
    );

    expect(deniedStats).toBe(0);
    expect(deniedListings).toBe(0);
  });

  it("treats genuinely missing safe metadata directories as complete", async () => {
    writeFileSync(
      join(ROOT, "package.json"),
      JSON.stringify({ workspaces: ["missing-services/*"] }),
    );

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which package manager does this workspace use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(
      out.pack.uncertainty.some(
        (marker) =>
          marker.kind === "scope-incomplete" && marker.claim.includes("could not enumerate"),
      ),
    ).toBe(false);
  });

  // The cap this pins is the PRE-read one: `stat.size > WORKSPACE_MANIFEST_BYTES_MAX` refuses the
  // manifest before any read primitive is chosen, so it is unaffected by ADR-0005 D1's rule that a
  // port without the bounded same-descriptor lane yields absent advisory metadata (the case the
  // next test covers). The compatibility port below therefore still reports the byte-limit reason.
  it("uses the compatibility stat cap before reading a workspace manifest", async () => {
    mkdirSync(join(ROOT, "hidden-services/payments"), { recursive: true });
    writeFileSync(
      join(ROOT, "package.json"),
      JSON.stringify({ workspaces: ["hidden-services/*"] }),
    );
    writeFileSync(
      join(ROOT, "hidden-services/payments/pom.xml"),
      "<project><properties><maven.compiler.release>99</maven.compiler.release></properties></project>\n",
    );
    const base = countingNodeFs();
    const packagePath = realpathSync(join(ROOT, "package.json"));
    const compatibilityFs: WorkspaceFs = {
      readFileUtf8: base.fs.readFileUtf8,
      stat: base.fs.stat,
      readDir: base.fs.readDir,
      ...(base.fs.iterateDirectory === undefined
        ? {}
        : { iterateDirectory: base.fs.iterateDirectory }),
      realPath: base.fs.realPath,
      exists: base.fs.exists,
      ...(base.fs.readFileBytes === undefined ? {} : { readFileBytes: base.fs.readFileBytes }),
    };
    const fs: WorkspaceFs = {
      ...compatibilityFs,
      stat: (absolutePath): WorkspaceStat => {
        const stat = compatibilityFs.stat(absolutePath);
        return absolutePath === packagePath ? { ...stat, size: 2_097_153 } : stat;
      },
    };

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which Java version does the hidden service use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs,
      },
    );

    expect(
      out.pack.uncertainty.some(
        (marker) =>
          marker.kind === "scope-incomplete" &&
          marker.claim.includes("workspace-manifest-byte-limit:1"),
      ),
    ).toBe(true);
  });

  it.each([1_200_000, 2_097_152])("admits valid workspace manifests of %i bytes", async (size) => {
    mkdirSync(join(ROOT, "custom-services/payments"), { recursive: true });
    const manifest = JSON.stringify({ workspaces: ["custom-services/*"] });
    writeFileSync(join(ROOT, "package.json"), manifest.padEnd(size, " "));
    writeFileSync(
      join(ROOT, "custom-services/payments/pom.xml"),
      "<project><java.version>21</java.version></project>\n",
    );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Welche Technologien und Abhängigkeiten verwendet dieses Projekt?",
        }),
      }),
      { correlationId: undefined, answerer: echoAnswerer, nowMs: () => NOW },
    );
    expect(
      out.pack.files.some((file) => file.scopePath === "custom-services/payments/pom.xml"),
    ).toBe(true);
    expect(
      out.pack.uncertainty.some((marker) => marker.claim.includes("workspace-manifest-byte-limit")),
    ).toBe(false);
  });

  it("excludes physical workspace manifests above the shared 2 MiB eligibility ceiling", async () => {
    mkdirSync(join(ROOT, "custom-services/payments"), { recursive: true });
    const manifest = JSON.stringify({ workspaces: ["custom-services/*"] });
    writeFileSync(join(ROOT, "package.json"), manifest.padEnd(2_097_153, " "));
    writeFileSync(
      join(ROOT, "custom-services/payments/pom.xml"),
      "<project><java.version>21</java.version></project>\n",
    );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Welche Technologien und Abhängigkeiten verwendet dieses Projekt?",
        }),
      }),
      { correlationId: undefined, answerer: echoAnswerer, nowMs: () => NOW },
    );
    expect(out.pack.files.some((file) => file.scopePath === "package.json")).toBe(false);
    // Eligible recursive context remains readable independently of the oversized manifest;
    // file-listing provenance does not assert that the root declares this child workspace.
    const child = out.pack.files.find(
      (file) => file.scopePath === "custom-services/payments/pom.xml",
    );
    expect(child).toBeDefined();
    expect(child?.excerpts.length).toBeGreaterThan(0);
    expect(
      child?.excerpts.every(
        (excerpt) =>
          excerpt.atom.provenance.kind === "file-listing" &&
          excerpt.atom.provenance.tool === "repo.findFiles",
      ),
    ).toBe(true);
    expect(child?.excerpts.map((excerpt) => excerpt.content).join("\n")).toContain(
      "<java.version>21</java.version>",
    );
    expect(out.pack.usage.excerptBytes).toBeLessThanOrEqual(out.pack.budget.excerptBytesMax);
    expect(
      out.pack.uncertainty.some((marker) => marker.claim.includes("workspace-manifest-byte-limit")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("omits manifest metadata rather than reading it unbounded without a same-descriptor byte lane", async () => {
    mkdirSync(join(ROOT, "hidden-services/payments"), { recursive: true });
    writeFileSync(
      join(ROOT, "package.json"),
      JSON.stringify({ workspaces: ["hidden-services/*"] }),
    );
    writeFileSync(
      join(ROOT, "hidden-services/payments/pom.xml"),
      "<project><properties><maven.compiler.release>99</maven.compiler.release></properties></project>\n",
    );
    const manifestPath = realpathSync(join(ROOT, "package.json"));
    const unboundedReads: string[] = [];
    const { readFileBytes, ...fs } = descriptorlessWorkspaceFs(unboundedReads);
    expect(readFileBytes).toBeDefined();

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which Java version does the hidden service use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs,
      },
    );

    expect(unboundedReads).not.toContain(manifestPath);
    expect(
      out.pack.uncertainty.some(
        (marker) =>
          marker.kind === "scope-incomplete" &&
          marker.claim.includes("workspace-manifest-read-unavailable:1"),
      ),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("checks every admitted workspace pattern and reports only supported-shape failures", async () => {
    mkdirSync(join(ROOT, "custom-services/payments"), { recursive: true });
    mkdirSync(join(ROOT, "overflow-services/hidden"), { recursive: true });
    writeFileSync(
      join(ROOT, "custom-services/payments/pom.xml"),
      "<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>\n",
    );
    writeFileSync(
      join(ROOT, "overflow-services/hidden/pom.xml"),
      "<project>overflow-secret</project>\n",
    );
    const workspaces: unknown[] = [
      "custom-services/*",
      42,
      "sensitive-pattern".repeat(80),
      "unsupported/**",
      ...Array.from({ length: 28 }, () => "custom-services/*"),
      "overflow-services/*",
    ];
    writeFileSync(join(ROOT, "package.json"), JSON.stringify({ workspaces }));

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which Java version does the payments service use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    const paths = out.pack.files.map((file) => file.scopePath);
    const marker = out.pack.uncertainty.find(
      (entry) =>
        entry.kind === "scope-incomplete" && entry.claim.includes("workspace-pattern-length-limit"),
    );
    expect(paths).toContain("custom-services/payments/pom.xml");
    expect(paths).toContain("overflow-services/hidden/pom.xml");
    expect(marker?.claim).not.toContain("workspace-pattern-count-limit");
    expect(marker?.claim).toContain("workspace-pattern-length-limit:1");
    expect(marker?.claim).toContain("workspace-pattern-shape-unsupported:2");
    expect(marker?.claim).not.toContain("sensitive-pattern");
    expect(marker?.claim).not.toContain("overflow-services");
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("reports unsupported workspace manifest shapes without echoing manifest content", async () => {
    writeFileSync(
      join(ROOT, "package.json"),
      JSON.stringify({ workspaces: { packages: "private-workspace-pattern" } }),
    );

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which package manager does this project use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    const marker = out.pack.uncertainty.find(
      (entry) =>
        entry.kind === "scope-incomplete" &&
        entry.claim.includes("workspace-manifest-shape-unsupported"),
    );
    expect(marker?.claim).not.toContain("private-workspace-pattern");
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("falls back to exact manifest stats and reports unavailable metadata directories", async () => {
    const log = createBufferedServerLogSink();
    writeFileSync(join(ROOT, "package.json"), JSON.stringify({ packageManager: "npm@11.16.0" }));
    writeFileSync(
      join(ROOT, "pom.xml"),
      "<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>\n",
    );
    const rootPath = realpathSync(ROOT);
    let rootIterations = 0;
    let metadataClosed = false;
    const iterate = nodeWorkspaceFs.iterateDirectory;
    if (iterate === undefined) throw new Error("streaming port missing");
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path): AsyncIterable<WorkspaceDirEntry> {
        const metadata = path === rootPath && ++rootIterations === 2;
        try {
          for await (const entry of iterate(path)) {
            yield entry;
            if (metadata) throw new Error("simulated metadata enumeration failure");
          }
        } finally {
          if (metadata) metadataClosed = true;
        }
      },
    };

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Which Java version and package manager does this project use?",
        }),
      }),
      {
        correlationId: "metadata-enumeration-failure",
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs,
        activityLog: log,
      },
    );

    expect(out.pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining(["package.json", "pom.xml"]),
    );
    expect(
      out.pack.uncertainty.some(
        (marker) =>
          marker.kind === "scope-incomplete" &&
          marker.claim.includes("could not enumerate") &&
          marker.claim.includes("exact manifest probes were used"),
      ),
    ).toBe(true);
    expect(metadataClosed).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    const completion = log.events.find(
      (event) => event.op === "search.connected-context.completed",
    );
    expect(completion?.correlationId).toBe("metadata-enumeration-failure");
    expect(completion?.extra?.scopeIncompleteUncertaintyCount).toBe(1);
    expect(log.lines().join("\n")).not.toContain("simulated metadata enumeration failure");
    expect(log.lines().join("\n")).not.toContain("maven.compiler.release");
  });

  it("retrieves the service-local Java manifest in a polyglot monorepo (not only the root manifest)", async () => {
    mkdirSync(join(ROOT, "services/payments"), { recursive: true });
    mkdirSync(join(ROOT, "services/gateway"), { recursive: true });
    // Root aggregator pom (shallower) + a service-local pom declaring the real Java version + an
    // unrelated Go service manifest. Before the ecosystem registry, only package.json was injected
    // in service dirs, so the service-local pom.xml was invisible to project-metadata questions.
    writeFileSync(
      join(ROOT, "pom.xml"),
      "<project><modules><module>payments</module></modules></project>\n",
    );
    writeFileSync(
      join(ROOT, "services/payments/pom.xml"),
      "<project>\n  <properties>\n    <maven.compiler.release>21</maven.compiler.release>\n  </properties>\n</project>\n",
    );
    writeFileSync(join(ROOT, "services/gateway/go.mod"), "module acme/gateway\n\ngo 1.22\n");

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which Java version does the payments service use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    const paths = out.pack.files.map((file) => file.scopePath);
    // The service-local Java manifest is surfaced (the core polyglot-monorepo acceptance criterion).
    expect(paths).toContain("services/payments/pom.xml");
    // Discovery is ecosystem-aware, not package.json-only: the sibling Go service manifest is found too.
    expect(paths).toContain("services/gateway/go.mod");
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("streams every metadata entry while retaining bounded manifest output", async () => {
    const realRoot = realpathSync(ROOT);
    writeFileSync(
      join(ROOT, "zproject.csproj"),
      "<Project><TargetFramework>net8.0</TargetFramework></Project>\n",
    );
    const iterate = nodeWorkspaceFs.iterateDirectory;
    if (iterate === undefined) throw new Error("streaming port missing");
    let rootIterations = 0;
    let streamedNoise = 0;
    let metadataClosed = false;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path): AsyncIterable<WorkspaceDirEntry> {
        const metadata = path === realRoot && ++rootIterations === 2;
        try {
          if (metadata)
            for (let index = 0; index < 10_000; index += 1) {
              streamedNoise += 1;
              yield {
                name: `noise-${index.toString()}.txt`,
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
              };
            }
          yield* iterate(path);
        } finally {
          if (metadata) metadataClosed = true;
        }
      },
    };
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Welche Technologien und Abhängigkeiten verwendet dieses Projekt?",
        }),
      }),
      { correlationId: undefined, answerer: echoAnswerer, nowMs: () => NOW, fs },
    );
    expect(streamedNoise).toBe(10_000);
    expect(metadataClosed).toBe(true);
    expect(out.pack.files.some((file) => file.scopePath === "zproject.csproj")).toBe(true);
    expect(
      out.pack.uncertainty.some((marker) => marker.claim.includes("bounded directory reads")),
    ).toBe(false);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  // Behavioral coverage for a workspaces entry with a long trailing-slash run: the S8786 linearity
  // pin lives on `stripTrailingSlashes` / `normalizeWorkspacePattern` (#3347), not on this pipeline.
  it("still retrieves a valid pack when a workspaces pattern carries a long trailing-slash run", async () => {
    writeFileSync(
      join(ROOT, "package.json"),
      JSON.stringify({ workspaces: [`packages/pkg${"/".repeat(20_000)}`] }),
    );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "what is the exact packageManager value in package.json?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("carries explainable ranking diagnostics on the pack for a project-metadata question (M2)", async () => {
    writeFileSync(
      join(ROOT, "pom.xml"),
      "<project>\n  <properties>\n    <maven.compiler.release>21</maven.compiler.release>\n  </properties>\n</project>\n",
    );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which Java version does this project use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    const ranked = out.pack.diagnostics?.rankedCandidates ?? [];
    const pom = ranked.find((entry) => entry.scopePath === "pom.xml");
    expect(pom).toBeDefined();
    expect(pom?.bucket).toBe("canonical-metadata");
    expect(pom?.ecosystem).toBeDefined();
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("includes deeply nested eligible sources without an artificial depth cutoff", async () => {
    const deepDir = join(ROOT, ...Array.from({ length: 45 }, (_, i) => `depth-${String(i)}`));
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(join(deepDir, "deep.ts"), "export const DepthProbe = 'hidden';\n");
    writeFileSync(join(ROOT, "src/top.ts"), "export const DepthProbe = 'visible';\n");

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Where is DepthProbe in deep.ts defined?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    const coverage = out.pack.diagnostics?.coverage;
    expect(coverage?.incomplete).toBe(false);
    expect(coverage?.reasons).not.toContain("depth-pruned");
    expect(coverage?.depthPrunedByDiscovery).toBe(0);
    expect(out.pack.omitted.filter((entry) => entry.scopePath.endsWith("deep.ts"))).toEqual([]);
    expect(out.pack.files.map((file) => file.scopePath)).toContain(
      relative(ROOT, join(deepDir, "deep.ts")),
    );
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("discloses retained-match truncation separately from intentional discovery exclusions", async () => {
    writeFileSync(join(ROOT, "src/coverage-a.ts"), "export const coverageMarker = 'alpha';\n");
    writeFileSync(join(ROOT, "src/coverage-b.ts"), "export const coverageMarker = 'beta';\n");
    writeFileSync(join(ROOT, ".env"), "SECRET=value\n");
    mkdirSync(join(ROOT, "ignored"), { recursive: true });
    writeFileSync(join(ROOT, "ignored/coverage-c.ts"), "export const coverageMarker = 'gamma';\n");
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Investigate coverageMarker coverage truncation",
          maxResults: 1,
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => ({ ...fakeWorkspace(), ignoreLines: ["ignored/"] }),
      },
    );
    const coverage = out.pack.diagnostics?.coverage;
    expect(coverage).toMatchObject({
      truncated: true,
      reasons: ["match-cap"],
      filesScanned: 5,
      filesAfterPolicy: 5,
    });
    expect(coverage?.ignoredByDiscovery).toBeGreaterThan(0);
    expect(coverage?.deniedByDiscovery).toBeGreaterThan(0);
    expect(
      out.pack.uncertainty.some(
        (marker) =>
          marker.kind === "budget-clipped" &&
          marker.claim.includes("all eligible files were searched") &&
          marker.claim.includes("scanned") &&
          marker.claim.includes("ignored") &&
          marker.claim.includes("denied"),
      ),
    ).toBe(true);
    expect(out.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(false);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it.each([false, true])(
    "distinguishes retained-match limits from unread files (ioError=%s)",
    async (ioError) => {
      mkdirSync(join(ROOT, "coverage-matches"));
      for (const name of ["a.ts", "b.ts", "c.ts"]) {
        writeFileSync(
          join(ROOT, "coverage-matches", name),
          "export const CoverageOnlyMatchesProbe = 17;\n",
        );
      }
      const out = await retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "directory",
            relativePaths: ["coverage-matches"],
            explicitConnection: true,
          }),
          query: happyQuery({ text: "Find CoverageOnlyMatchesProbe", maxResults: 1 }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
          fs: coverageLimitedReadFs(ioError),
        },
      );
      expectRetainedMatchCoverage(out.pack, ioError);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    },
  );

  it("excludes files above the per-file limit instead of citing a scanned prefix", async () => {
    writeFileSync(join(ROOT, "src/oversized.ts"), `oversizedNeedle\n${"x".repeat(2_200_000)}`);
    const counted = countingNodeFs();
    const out = await retrieveConnectedContextPack(
      input({
        query: happyQuery({ text: "Find oversizedNeedle" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        fs: counted.fs,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.files.some((file) => file.scopePath === "src/oversized.ts")).toBe(false);
    expect(out.pack.diagnostics?.coverage?.oversizedFilesScanned).toBe(0);
    expect(out.pack.uncertainty.some((marker) => marker.claim.includes("oversized-prefix 1"))).toBe(
      false,
    );
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it.each([
    { directory: "generated", rescued: 1 },
    { directory: "dist", rescued: 1 },
    { directory: "build", rescued: 1 },
    { directory: "coverage", rescued: 1 },
    // Snapshot directories are searched in the primary pass, but ranking also marks them generated.
    { directory: "__snapshots__", rescued: 0 },
  ])(
    "reports low-value rescue coverage when $directory source is the only evidence",
    async ({ directory, rescued }) => {
      writeFileSync(join(ROOT, ".git"), "gitdir: ../fixture.git\n");
      const sourcePath = `${directory}/client.ts`;
      mkdirSync(join(ROOT, directory), { recursive: true });
      writeFileSync(join(ROOT, sourcePath), "export const GeneratedNeedle = 1;\n");
      const out = await retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "workspace-root",
            relativePaths: [],
            explicitConnection: true,
          }),
          query: happyQuery({ text: "Where is GeneratedNeedle defined?" }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );
      expect(out.pack.files.some((file) => file.scopePath === sourcePath)).toBe(true);
      expect(out.pack.omitted.some((entry) => entry.scopePath === sourcePath)).toBe(false);
      expect(out.pack.diagnostics?.coverage?.lowValueRescueFilesDiscovered).toBe(rescued);
      expect(out.pack.diagnostics?.coverage?.lowValueRescueFilesScanned).toBe(rescued);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    },
  );

  it("injects a root-level glob manifest (*.csproj) for a project-metadata question (M4 root glob scan)", async () => {
    // *.csproj has no fixed basename, so the exact-name injection list cannot enumerate it; the
    // bounded root glob sweep must surface it.
    writeFileSync(
      join(ROOT, "Service.csproj"),
      "<Project>\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n",
    );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which .NET target framework does this project use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.files.map((file) => file.scopePath)).toContain("Service.csproj");
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("finds glob manifests in ordinary directories with many unrelated entries", async () => {
    writeFileSync(
      join(ROOT, "zproject.csproj"),
      "<Project><TargetFramework>net8.0</TargetFramework></Project>\n",
    );
    for (let index = 0; index < 120; index += 1)
      writeFileSync(join(ROOT, `filler-${index.toString()}.txt`), "plain text\n");
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Welche Technologien und Abhängigkeiten verwendet dieses Projekt?",
        }),
      }),
      { correlationId: undefined, answerer: echoAnswerer, nowMs: () => NOW },
    );
    expect(out.pack.files.some((file) => file.scopePath === "zproject.csproj")).toBe(true);
    expect(
      out.pack.uncertainty.some((marker) => marker.claim.includes("bounded directory reads")),
    ).toBe(false);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("finds a late service manifest beyond unrelated workspace directory counts", async () => {
    mkdirSync(join(ROOT, "packages"));
    for (let index = 0; index < 120; index += 1)
      mkdirSync(join(ROOT, "packages", `filler-${index.toString()}`));
    const target = join(ROOT, "packages/z-service");
    mkdirSync(target);
    writeFileSync(
      join(target, "pom.xml"),
      "<project><properties><java.version>21</java.version></properties></project>\n",
    );
    for (let index = 0; index < 40; index += 1)
      writeFileSync(join(target, `filler-${index.toString()}.txt`), "plain text\n");
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Welche Technologien und Abhängigkeiten verwendet dieses Projekt?",
        }),
      }),
      { correlationId: undefined, answerer: echoAnswerer, nowMs: () => NOW },
    );
    expect(out.pack.files.some((file) => file.scopePath === "packages/z-service/pom.xml")).toBe(
      true,
    );
    expect(
      out.pack.uncertainty.some((marker) => marker.claim.includes("bounded directory reads")),
    ).toBe(false);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("retains primary root manifests when nested manifests exceed the accepted evidence budget", async () => {
    writeFileSync(
      join(ROOT, "zproject.csproj"),
      "<Project><TargetFramework>net8.0</TargetFramework></Project>\n",
    );
    for (let index = 0; index < 40; index += 1) {
      const dir = join(ROOT, "packages", `service-${index.toString()}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pom.xml"), "<project><java.version>21</java.version></project>\n");
    }
    const iterate = nodeWorkspaceFs.iterateDirectory;
    if (iterate === undefined) throw new Error("streaming port missing");
    let serviceInspections = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path): AsyncIterable<WorkspaceDirEntry> {
        if (path.startsWith(join(realpathSync(ROOT), "packages/service-"))) serviceInspections += 1;
        yield* iterate(path);
      },
    };
    const out = await retrieveConnectedContextPack(
      input({
        budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 32 },
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Welche Technologien und Abhängigkeiten verwendet dieses Projekt?",
        }),
      }),
      { correlationId: undefined, answerer: echoAnswerer, nowMs: () => NOW, fs },
    );
    expect(out.pack.files.some((file) => file.scopePath === "zproject.csproj")).toBe(true);
    expect(out.pack.budget.filesReadMax).toBe(32);
    expect(out.pack.files.length).toBeLessThanOrEqual(32);
    expect(serviceInspections).toBe(80);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it.each([
    ["Config", "AppConfig"],
    ["PaymentService", "SuperPaymentService"],
  ])(
    "prioritizes the exact %s basename over %s in grouped symbol discovery",
    async (term, decoy) => {
      writeFileSync(join(ROOT, `src/${term}.ts`), `export class ${term} {}\n`);
      writeFileSync(
        join(ROOT, `src/${decoy}.ts`),
        `import { ${term} } from './${term}';\nexport class ${decoy} extends ${term} {}\n`,
      );
      const activityLog = createBufferedServerLogSink();
      const symbolReads: string[] = [];
      const fs: WorkspaceFs = {
        ...nodeWorkspaceFs,
        readFileUtf8SameDescriptor: (path, maxBytes, hardLinkPolicy, expected) => {
          if (path.endsWith(`/${term}.ts`) || path.endsWith(`/${decoy}.ts`)) {
            symbolReads.push(relative(realpathSync(ROOT), path));
          }
          const read = nodeWorkspaceFs.readFileUtf8SameDescriptor;
          if (read === undefined) throw new Error("bounded descriptor port missing");
          return read(path, maxBytes, hardLinkPolicy, expected);
        },
      };
      const out = await retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "workspace-root",
            relativePaths: [],
            explicitConnection: true,
          }),
          query: happyQuery({ text: `Where are \`${term}\` and ${decoy} defined?` }),
        }),
        {
          correlationId: "symbol-basename",
          answerer: echoAnswerer,
          nowMs: () => NOW,
          activityLog,
          fs,
        },
      );
      expect(symbolReads).toEqual([`src/${term}.ts`, `src/${decoy}.ts`]);
      expect(out.pack.files.map((file) => file.scopePath)).toEqual(
        expect.arrayContaining([`src/${term}.ts`, `src/${decoy}.ts`]),
      );
      expect(
        out.pack.files
          .find((file) => file.scopePath === `src/${term}.ts`)
          ?.excerpts.some((excerpt) => excerpt.content.includes(`class ${term}`)),
      ).toBe(true);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
      const details = activityLog.events.find(
        (event) => event.op === "search.connected-context.completion-details",
      );
      expect(details?.correlationId).toBe("symbol-basename");
      expect(
        numericEventExtra(recordEventExtra(details?.extra, "structural"), "fileSearchCount"),
      ).toBe(1);
      const line = activityLog.lines().find((entry) => entry.includes("completion-details"));
      expect(line).toContain('"correlationId":"symbol-basename"');
      expect(line).toContain('"structuralFileSearchCount":1');
      expect(line).not.toContain(`src/${term}.ts`);
      expect(line).not.toContain(`src/${decoy}.ts`);
    },
  );

  it("reads symbol definitions through the bounded same-descriptor port", async () => {
    writeFileSync(
      join(ROOT, "src/DescriptorProbe.ts"),
      "// preface\n// another line\nexport function DescriptorProbe(): number { return 1; }\n",
    );
    const targetPath = realpathSync(join(ROOT, "src/DescriptorProbe.ts"));
    const descriptorCaps: number[] = [];
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileUtf8SameDescriptor: (absolutePath, maxBytes, hardLinkPolicy, expected) => {
        if (absolutePath === targetPath) descriptorCaps.push(maxBytes);
        return (
          nodeWorkspaceFs.readFileUtf8SameDescriptor?.(
            absolutePath,
            maxBytes,
            hardLinkPolicy,
            expected,
          ) ?? {
            rawText: readFileSync(absolutePath, "utf8"),
            sizeBytes: statSync(absolutePath).size,
            stat: nodeWorkspaceFs.stat(absolutePath),
          }
        );
      },
    };

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Where is DescriptorProbe defined?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs,
      },
    );

    const descriptorExcerpt = out.pack.files
      .find((file) => file.scopePath === "src/DescriptorProbe.ts")
      ?.excerpts.find((excerpt) => excerpt.content.includes("export function DescriptorProbe"));
    expect(descriptorCaps).toContain(2_097_152);
    expect(descriptorExcerpt).toBeDefined();
    expect(descriptorExcerpt?.atom.lineRange).toEqual({ startLine: 3, endLine: 4 });
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("omits symbol-line evidence rather than reading it unbounded without a same-descriptor lane", async () => {
    writeFileSync(
      join(ROOT, "src/DescriptorProbe.ts"),
      "// preface\n// another line\nexport function DescriptorProbe(): number { return 1; }\n",
    );
    const targetPath = realpathSync(join(ROOT, "src/DescriptorProbe.ts"));
    const unboundedReads: string[] = [];

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Where is DescriptorProbe defined?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs: descriptorlessWorkspaceFs(unboundedReads),
      },
    );

    // The symbol-line scan has no bounded lane on this port, so it contributes no evidence at all;
    // the request still answers, and the file is simply absent from the symbol-discovery excerpts.
    expect(unboundedReads).not.toContain(targetPath);
    expect(
      out.pack.files
        .find((file) => file.scopePath === "src/DescriptorProbe.ts")
        ?.excerpts.some((excerpt) => excerpt.atom.provenance.tool === "repo.symbolFileDiscovery"),
    ).not.toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  // #3347 / ADR-0005 D1: `readFileUtf8SameDescriptor` is OPTIONAL on `WorkspaceFs`, so a port that
  // implements the bounded prefix/byte lanes but not that one is a SUPPORTED shape, not a broken
  // one. The workspace read lane reports it as an unavailable read, and every ring must degrade it
  // to one skipped file: the request still answers, the file is absent, and the absence is stated
  // in `uncertainty` rather than being silent. This pin is load-bearing on the excerpt lane's
  // degrade — drop it and the read lane's error fails the whole grounded answer instead.
  it("answers with the file absent when the port omits the optional same-descriptor lane", async () => {
    const unboundedReads: string[] = [];

    const out = await retrieveConnectedContextPack(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
      fs: descriptorlessWorkspaceFs(unboundedReads),
    });

    expect(out.pack.files.map((file) => file.scopePath)).not.toContain("src/foo.ts");
    expect(
      out.pack.uncertainty.some((marker) =>
        marker.claim.includes("files unavailable during excerpt reading"),
      ),
    ).toBe(true);
    expect(out.pack.omitted).toContainEqual(
      expect.objectContaining({
        scopePath: "src/foo.ts",
        reason: "tool-unavailable",
      }),
    );
    expect(unboundedReads).toEqual([]);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("prioritizes exact symbol filename matches for workspace-root code questions", async () => {
    mkdirSync(join(ROOT, "docs/adr"), { recursive: true });
    mkdirSync(join(ROOT, "packages/keiko-ui/src/app/components/desktop/windows"), {
      recursive: true,
    });
    writeFileSync(
      join(ROOT, "docs/adr/ADR-0026-workspace-substrate.md"),
      "The DOM renderer uses WindowFrame.tsx.\n",
    );
    writeFileSync(
      join(ROOT, "packages/keiko-ui/src/app/components/desktop/windows/WindowFrame.tsx"),
      "import type { ReactNode } from 'react';\n" +
        "interface WindowFrameProps { readonly title: string; }\n" +
        "const filler = [\n" +
        Array.from({ length: 260 }, (_, index) => `  "line-${index.toString()}",\n`).join("") +
        "];\n" +
        "export function WindowFrame(props: WindowFrameProps): ReactNode {\n" +
        "  return props.title;\n" +
        "}\n",
    );

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Wo ist WindowFrame implementiert?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.plan.retrievalIntent).toBe("targeted-code-search");
    expect(out.pack.files[0]?.scopePath).toBe(
      "packages/keiko-ui/src/app/components/desktop/windows/WindowFrame.tsx",
    );
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) =>
        excerpt.content.includes("export function WindowFrame"),
      ),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("keeps deterministic symbol-file discovery beyond the first three identifier anchors", async () => {
    for (const symbol of ["AlphaOne", "BetaTwo", "GammaThree", "ZetaFour"]) {
      writeFileSync(
        join(ROOT, "src", `${symbol}.ts`),
        `export function ${symbol}(): string {\n  return "${symbol}";\n}\n`,
      );
    }

    const adapter = symbolGraphAdapter as {
      isAvailable: typeof symbolGraphAdapter.isAvailable;
    };
    const originalIsAvailable = adapter.isAvailable;
    adapter.isAvailable = (): Promise<boolean> => Promise.resolve(false);
    try {
      const out = await retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "workspace-root",
            relativePaths: [],
            explicitConnection: true,
          }),
          query: happyQuery({
            text: "Trace AlphaOne BetaTwo GammaThree ZetaFour implementations",
          }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );

      expect(out.pack.files.map((file) => file.scopePath)).toContain("src/ZetaFour.ts");
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    } finally {
      adapter.isAvailable = originalIsAvailable;
    }
  });

  it("adds follow-symbol trace evidence across a three-package TypeScript chain", async () => {
    mkdirSync(join(ROOT, "packages/a/src"), { recursive: true });
    mkdirSync(join(ROOT, "packages/b/src"), { recursive: true });
    mkdirSync(join(ROOT, "packages/c/src"), { recursive: true });
    writeFileSync(
      join(ROOT, "packages/a/src/app.ts"),
      'import { runPayment } from "../../b/src/service";\nexport function start(): void {\n  runPayment();\n}\n',
    );
    writeFileSync(
      join(ROOT, "packages/b/src/service.ts"),
      'import { settlePayment } from "../../c/src/domain";\nexport function runPayment(): string {\n  return settlePayment();\n}\n',
    );
    writeFileSync(
      join(ROOT, "packages/c/src/domain.ts"),
      'export function settlePayment(): string {\n  return "settled";\n}\n',
    );

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Trace settlePayment through packages" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining([
        "packages/a/src/app.ts",
        "packages/b/src/service.ts",
        "packages/c/src/domain.ts",
      ]),
    );
    expect(
      out.pack.files.some((file) =>
        file.excerpts.some((excerpt) => excerpt.content.includes("settlePayment")),
      ),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("adds endpoint contract evidence for Java routes linked to TypeScript clients", async () => {
    mkdirSync(join(ROOT, "src/main/java/com/acme"), { recursive: true });
    mkdirSync(join(ROOT, "src/client"), { recursive: true });
    writeFileSync(
      join(ROOT, "src/main/java/com/acme/OrderController.java"),
      '@RestController\n@RequestMapping("/api")\nclass OrderController {\n' +
        '  @GetMapping("/orders/{id}")\n' +
        "  public OrderDto getOrder(String id) { return null; }\n" +
        "}\nrecord OrderDto(String status) {}\n",
    );
    writeFileSync(
      join(ROOT, "src/client/orders.ts"),
      'import axios from "axios";\n' +
        "interface OrderDto { status: string; }\n" +
        "export const loadOrder = (id: string) => axios.get<OrderDto>(`/api/orders/${id}`);\n",
    );

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Which frontend client calls the OrderDto API route?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining([
        "src/main/java/com/acme/OrderController.java",
        "src/client/orders.ts",
      ]),
    );
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("adds approved semantic provider evidence without direct token overlap", async () => {
    mkdirSync(join(ROOT, "src/billing"), { recursive: true });
    writeFileSync(
      join(ROOT, "README.md"),
      "CheckoutMismatch reports the wrong purchase sum in production.\n",
    );
    writeFileSync(
      join(ROOT, "src/billing/calculateCharge.ts"),
      "export function deriveCharge(amount: number, tax: number): number {\n  return amount + tax;\n}\n",
    );
    const semanticSearchProvider: SemanticSearchProvider = {
      name: "local fixture",
      search: ({ documents }) =>
        Promise.resolve(
          documents.some((document) => document.scopePath === "src/billing/calculateCharge.ts")
            ? [{ scopePath: "src/billing/calculateCharge.ts", score: 0.98, line: 1 }]
            : [],
        ),
    };

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Investigate CheckoutMismatch purchase sum" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        semanticSearchProvider,
      },
    );

    expect(out.pack.files[0]?.scopePath).toBe("src/billing/calculateCharge.ts");
    expect(out.pack.diagnostics?.rankedCandidates[0]?.signals.map((signal) => signal.name)).toEqual(
      expect.arrayContaining(["semantic-score", "rrf:semantic"]),
    );
    expect(JSON.stringify(out.pack.diagnostics)).not.toContain("embedding");
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("bounds full retrieval I/O and linear workspace growth for issue #3347", async () => {
    const small = await measureRetrievalTraversal(16, "multi-anchor");
    const large = await measureRetrievalTraversal(65, "multi-anchor");
    for (const measurement of [small, large]) {
      expect(measurement.foundTraversalSymbols).toEqual(
        expect.arrayContaining(["TraversalAlpha", "TraversalBeta"]),
      );
      expect(measurement.foundTraversalSymbols.length).toBeGreaterThanOrEqual(6);
      expect(measurement.searchBudgetClipped).toBe(false);
      expect(measurement.packValid).toBe(true);
      expect(measurement.searchCalls).toBeLessThan(32);
      expect(measurement.fileSearchCount).toBeGreaterThan(0);
      expectBoundedRetrievalProducts(measurement);
      expectAbsoluteRetrievalIoBound(measurement);
    }
    expectLinearRetrievalGrowth(small, large);
  });

  it("prevents multi-anchor queries from multiplying workspace-boundary discovery work", async () => {
    const single = await measureRetrievalTraversal(24, "single-anchor");
    const multi = await measureRetrievalTraversal(24, "multi-anchor");
    expect(single.searchBudgetClipped).toBe(false);
    expect(multi.searchBudgetClipped).toBe(false);
    expect(single.foundTraversalSymbols).toContain("TraversalAlpha");
    expect(multi.foundTraversalSymbols).toEqual(
      expect.arrayContaining(["TraversalAlpha", "TraversalBeta"]),
    );
    expect(multi.foundTraversalSymbols.length).toBeGreaterThanOrEqual(6);
    expect(single.fileSearchCount).toBe(1);
    expect(multi.fileSearchCount).toBe(2);
    expect(multi.searchCalls).toBeGreaterThan(single.searchCalls);
    expectBoundedRetrievalProducts(single);
    expectBoundedRetrievalProducts(multi);
    expect(multi.operations.readDir - single.operations.readDir).toBeLessThanOrEqual(8);
    expect(multi.operations.readDirEntries - single.operations.readDirEntries).toBeLessThanOrEqual(
      16,
    );
    expect(multi.operations.exists).toBe(single.operations.exists);
    // Delegated live excerpt reads (delta 42) and selected-file classification (delta 21)
    // account for additional accepted evidence. The remaining 21 declaration reads stay
    // within the original 32-read discovery allowance; no phase is inferred from file counts.
    expect(
      workspaceReadOperationCount(multi.operations) -
        multi.actualExcerptReads.readCalls -
        multi.listingGuardOperations.readCalls -
        (workspaceReadOperationCount(single.operations) -
          single.actualExcerptReads.readCalls -
          single.listingGuardOperations.readCalls),
    ).toBeLessThanOrEqual(32);
    expect(
      multi.operations.contentReadBytes -
        multi.actualExcerptReads.contentReadBytes -
        multi.listingGuardOperations.contentReadBytes -
        (single.operations.contentReadBytes -
          single.actualExcerptReads.contentReadBytes -
          single.listingGuardOperations.contentReadBytes),
    ).toBeLessThanOrEqual(32 * multi.maxReadableFixtureFileBytes);
    // Replay the production excerpt-read phase for the actually selected files and ranges. Its
    // containment and identity checks scale with the accepted read budget, not discovery work.
    const discoveryStatDelta =
      multi.operations.stat -
      multi.excerptReadOperations.stat -
      multi.listingGuardOperations.stat -
      (single.operations.stat -
        single.excerptReadOperations.stat -
        single.listingGuardOperations.stat);
    const additionalDiscoveryContentReads =
      workspaceContentReadOperationCount(multi.operations) -
      workspaceContentReadOperationCount(multi.excerptReadOperations) -
      (workspaceContentReadOperationCount(single.operations) -
        workspaceContentReadOperationCount(single.excerptReadOperations));
    // Other bounded content reads retain their post-read snapshot allowance; directory discovery
    // keeps the original ceiling. The replay does not spend or repeat any directory traversal.
    expect(discoveryStatDelta).toBeLessThanOrEqual(16 + additionalDiscoveryContentReads);
    const discoveryRealPathDelta =
      multi.operations.realPath -
      multi.excerptReadOperations.realPath -
      multi.listingGuardOperations.realPath -
      (single.operations.realPath -
        single.excerptReadOperations.realPath -
        single.listingGuardOperations.realPath);
    expect(discoveryRealPathDelta).toBeLessThanOrEqual(32 + additionalDiscoveryContentReads);
    expect(multi.operations.unboundedReadDir - single.operations.unboundedReadDir).toBe(0);
  });

  it("inspects definition lines for all 96 retained symbol candidates without a second count cap", async () => {
    seedOverflowImplementations(ROOT, 96);
    const read = nodeWorkspaceFs.readFileUtf8SameDescriptor;
    if (read === undefined) throw new Error("bounded descriptor fixture missing");
    let definitionReads = 0;

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({
          kind: "workspace-root",
          relativePaths: [],
          explicitConnection: true,
        }),
        query: happyQuery({ text: "Trace OverflowProbe implementations" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs: {
          ...nodeWorkspaceFs,
          readFileUtf8SameDescriptor: (
            ...args
          ): ReturnType<NonNullable<WorkspaceFs["readFileUtf8SameDescriptor"]>> => {
            // Shared FS primitives also perform eligibility/excerpt reads; count this production
            // stage alone rather than imposing an incorrect total-I/O expectation.
            if (new Error().stack?.includes("boundedSymbolFileText") === true) definitionReads += 1;
            return read(...args);
          },
        },
      },
    );

    const definitions = out.pack.files.filter((file) =>
      file.scopePath.endsWith("/OverflowProbe.ts"),
    );
    expect(definitions).toHaveLength(96);
    expect(definitionReads).toBe(96);
    expect(
      definitions.filter((file) =>
        file.excerpts.some((excerpt) => excerpt.content.includes("export function OverflowProbe")),
      ),
    ).toHaveLength(96);
    expect(
      out.pack.uncertainty.some((entry) => entry.claim.includes("Symbol line lookup skipped")),
    ).toBe(false);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  }, 15_000);

  it("processes a user stop between symbol definition file scans", async () => {
    seedOverflowImplementations(ROOT, 96);
    const read = nodeWorkspaceFs.readFileUtf8SameDescriptor;
    if (read === undefined) throw new TypeError("Missing bounded descriptor fixture");
    const caller = new AbortController();
    const activityLog = createBufferedServerLogSink();
    let definitionReads = 0;
    const pending = retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Trace OverflowProbe implementations" }),
      }),
      {
        correlationId: "symbol-scan-stop",
        activityLog,
        signal: caller.signal,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs: {
          ...nodeWorkspaceFs,
          readFileUtf8SameDescriptor: (...args): WorkspaceDescriptorUtf8Read => {
            if (new Error().stack?.includes("boundedSymbolFileText") === true) {
              definitionReads += 1;
              if (definitionReads === 1)
                setImmediate(() => {
                  caller.abort();
                });
            }
            return read(...args);
          },
        },
      },
    );
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(definitionReads).toBe(1);
    const cancelled = activityLog.events.find(
      (event) => event.op === "search.connected-context.failed",
    );
    expect(cancelled).toMatchObject({
      correlationId: "symbol-scan-stop",
      errorKind: "cancelled",
      extra: { outcome: "cancelled" },
    });
  });

  it("keeps large lockfiles bounded when grounding package-manager metadata", async () => {
    writeFileSync(
      join(ROOT, "package.json"),
      JSON.stringify({ packageManager: "npm@11.16.0" }, null, 2),
    );
    writeFileSync(join(ROOT, "package-lock.json"), `${"x".repeat(100_000)}\n`);

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({ text: "Welcher Package Manager wird verwendet?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    const lockfile = out.pack.files.find((file) => file.scopePath === "package-lock.json");
    expect(lockfile).toBeDefined();
    const totalLockfileBytes =
      lockfile?.excerpts.reduce((sum, excerpt) => sum + excerpt.contentBytes, 0) ?? 0;
    expect(totalLockfileBytes).toBeLessThanOrEqual(8192);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("adds truncation evidence when a selected code window exceeds excerpt bytes", async () => {
    const body = Array.from(
      { length: 100 },
      (_, index) => `  const line${index.toString()} = "needle ${"x".repeat(180)}";`,
    ).join("\n");
    writeFileSync(join(ROOT, "src/large-trace.ts"), `export function LargeTrace() {\n${body}\n}\n`);

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "directory", relativePaths: ["src"], explicitConnection: true }),
        query: happyQuery({ text: "Inspect the needle handling in LargeTrace" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    const marker = out.pack.uncertainty.find(
      (entry) =>
        entry.kind === "scope-incomplete" && entry.claim.includes("excerpt byte limit truncated"),
    );
    expect(marker).toBeDefined();
    expect(out.pack.files.some((file) => file.scopePath === "src/large-trace.ts")).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("includes package and test config metadata for connected-folder test-environment questions", async () => {
    mkdirSync(join(ROOT, "packages/keiko-ui/src/app/components/desktop"), { recursive: true });
    writeFileSync(
      join(ROOT, "packages/keiko-ui/package.json"),
      JSON.stringify(
        {
          name: "@oscharko-dev/keiko-ui",
          scripts: { test: "vitest run" },
          devDependencies: { vitest: "4.1.8", vite: "8.0.16" },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(ROOT, "packages/keiko-ui/vitest.config.ts"),
      "import { defineConfig } from 'vitest/config';\n" +
        "export default defineConfig({ test: { environment: 'jsdom' } });\n",
    );
    writeFileSync(
      join(ROOT, "packages/keiko-ui/src/app/components/desktop/AppShell.tsx"),
      "export function AppShell() {\n  return 'app shell';\n}\n",
    );

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({
          kind: "directory",
          relativePaths: ["packages/keiko-ui"],
          explicitConnection: true,
        }),
        query: happyQuery({
          text: "Kannst du die App sehen und mir sagen welche Testumgebung genutzt wird?",
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    const paths = out.pack.files.map((file) => file.scopePath);
    expect(paths).toContain("packages/keiko-ui/package.json");
    expect(paths).toContain("packages/keiko-ui/vitest.config.ts");
    expect(
      out.pack.files
        .find((file) => file.scopePath === "packages/keiko-ui/package.json")
        ?.excerpts.some((excerpt) => excerpt.content.includes('"test": "vitest run"')),
    ).toBe(true);
    expect(
      out.pack.files
        .find((file) => file.scopePath === "packages/keiko-ui/vitest.config.ts")
        ?.excerpts.some((excerpt) => excerpt.content.includes("environment: 'jsdom'")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("omits .keiko evidence artifacts when real source files answer a normal repository question", async () => {
    seedIssue876Repo();

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "Where is handleGroundedAsk implemented? Cite the source file.",
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files[0]?.scopePath).toBe("src/grounded-qa.ts");
    expect(out.pack.files.every((file) => !file.scopePath.startsWith(".keiko/evidence/"))).toBe(
      true,
    );
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("demotes lockfiles behind ordinary repository files for code-usage questions", async () => {
    seedIssue876Repo();

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [], explicitConnection: true }),
        query: happyQuery({
          text: "How is ZodConfigSchema used in this repository? Cite the relevant code.",
        }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files[0]?.scopePath).toBe("src/zod-config.ts");
    const lockfileIndex = out.pack.files.findIndex((file) => file.scopePath === "pnpm-lock.yaml");
    expect(lockfileIndex).not.toBe(0);
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) => excerpt.content.includes("ZodConfigSchema")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("reads an explicitly connected single file even when the question has no lexical hit", async () => {
    mkdirSync(join(ROOT, "src/pages"), { recursive: true });
    writeFileSync(
      join(ROOT, "src/pages/index.vue"),
      "<template>\n" +
        '  <main class="landing-page">\n' +
        "    <h1>Willkommen</h1>\n" +
        "  </main>\n" +
        "</template>\n" +
        "\n" +
        '<script setup lang="ts">\n' +
        "const title = 'Digitalisierung';\n" +
        "</script>\n",
    );
    writeFileSync(
      join(ROOT, "src/pages/sibling.vue"),
      "<template>\n  <section>optimieren code sibling decoy</section>\n</template>\n",
    );

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({
          kind: "files",
          relativePaths: ["src/pages/index.vue"],
          explicitConnection: true,
        }),
        query: happyQuery({ text: "Kannst du diesen Code optimieren?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files.map((file) => file.scopePath)).toEqual(["src/pages/index.vue"]);
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) => excerpt.content.includes("<template>")),
    ).toBe(true);
    expect(
      out.pack.files[0]?.excerpts.some((excerpt) => excerpt.content.includes("Digitalisierung")),
    ).toBe(true);
    expect(JSON.stringify(out.pack)).not.toContain("sibling decoy");
    expect(out.pack.uncertainty.some((marker) => marker.kind === "no-evidence")).toBe(false);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("adds a no-evidence uncertainty marker when retrieval finds no matching atoms", async () => {
    const out = await runGroundedExploration(
      input({
        scope: happyScope({ kind: "files", relativePaths: ["src/bar.ts"] }),
        query: happyQuery({ text: "Investigate `CompletelyMissingSymbol`" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(out.pack.files).toEqual([]);
    expect(out.pack.uncertainty.some((marker) => marker.kind === "no-evidence")).toBe(true);
    expect(out.pack.uncertainty.some((marker) => marker.claim.includes("matched"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it.each([
    ["Investigate `CompletelyMissingSymbol`", "No matching evidence was found for this search."],
    [
      "Ist `CompletelyMissingSymbol` vorhanden?",
      "Keine passenden Belege für diese Suche gefunden.",
    ],
  ])(
    "RB-4 GEN-AI-GROUNDING-002/-003: localizes empty-evidence abstention before the model call: %s",
    async (text, expected) => {
      let answererCalled = false;
      const trackingAnswerer: GroundedAnswerer = {
        answer: () => {
          answererCalled = true;
          return Promise.resolve("A confident but ungrounded fabricated answer.");
        },
      };
      const out = await runGroundedExploration(
        input({
          scope: happyScope({ kind: "files", relativePaths: ["src/bar.ts"] }),
          query: happyQuery({ text }),
        }),
        {
          correlationId: undefined,
          answerer: trackingAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );
      expect(answererCalled).toBe(false);
      expect(out.noEvidence).toBe(true);
      expect(out.assistantContent).toBe(expected);
      expect(out.pack.files).toEqual([]);
    },
  );

  it("uses the current English question for abstention after German retrieval continuity", async () => {
    const out = await runGroundedExploration(
      input({
        scope: happyScope({ kind: "files", relativePaths: ["src/bar.ts"] }),
        query: happyQuery({
          text: "Where was `CompletelyMissingSymbol` defined?\nIst es vorhanden?",
        }),
        currentQuestion: "Where was `CompletelyMissingSymbol` defined?",
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.noEvidence).toBe(true);
    expect(out.assistantContent).toBe("No matching evidence was found for this search.");
  });

  it("answers from explicit governed personal context without projecting source evidence", async () => {
    let receivedQuestion = "";
    const out = await runGroundedExploration(
      input({
        scope: happyScope({ kind: "files", relativePaths: ["src/bar.ts"] }),
        query: happyQuery({ text: "What package manager do I prefer?" }),
        answerQuestion:
          "User question:\nWhat package manager do I prefer?\n\nIncluded memory context:\nUse pnpm.",
        answerOnlyContextAvailable: true,
      }),
      {
        correlationId: undefined,
        answerer: {
          answer: (question) => {
            receivedQuestion = question;
            return Promise.resolve("You prefer pnpm [src/preferences.ts:42].");
          },
        },
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    expect(receivedQuestion).toContain("Use pnpm");
    expect(out.assistantContent).toContain("src/preferences.ts:42");
    expect(out.noEvidence).toBe(true);
    expect(out.modelInvoked).toBe(true);
    expect(out.pack.files).toEqual([]);
    expect(out.pack.uncertainty.some((marker) => marker.kind === "unsupported-citation")).toBe(
      true,
    );
  });

  it.each(["[src/secret/keys.ts:40-55]", "`src/secret/keys.ts:40-55`", "src/secret/keys.ts:40-55"])(
    "flags a location not present in the sent single-source pack: %s",
    async (fabricated) => {
      const fabricatingAnswerer: GroundedAnswerer = {
        answer: (_question, pack) => {
          const realPath = pack.files[0]?.scopePath ?? "src/foo.ts";
          return Promise.resolve(
            `Grounded in [${realPath}:1-2], but also cites ${fabricated} which was never retrieved.`,
          );
        },
      };
      const out = await runGroundedExploration(input(), {
        correlationId: undefined,
        answerer: fabricatingAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      });
      const marker = out.pack.uncertainty.find((m) => m.kind === "unsupported-citation");
      expect(marker).toBeDefined();
      expect(marker?.claim).toContain("secret/keys.ts");
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    },
  );

  it("RB-4 (GEN-AI-GROUNDING-001): does NOT flag when every inline citation is in the pack", async () => {
    const faithfulAnswerer: GroundedAnswerer = {
      answer: (_question, pack) => {
        const realPath = pack.files[0]?.scopePath ?? "src/foo.ts";
        return Promise.resolve(`The behaviour is defined in [${realPath}].`);
      },
    };
    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: faithfulAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(out.pack.uncertainty.some((m) => m.kind === "unsupported-citation")).toBe(false);
  });

  it("flags a source-backed answer that omits citations entirely", async () => {
    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: { answer: () => Promise.resolve("A confident answer without source markers.") },
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });

    expect(out.pack.files.length).toBeGreaterThan(0);
    expect(out.pack.uncertainty).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "uncited-answer",
          claim: expect.stringContaining("without a supported inline citation") as unknown,
        }),
      ]),
    );
    expect(out.pack.uncertainty.some((marker) => marker.kind === "unsupported-citation")).toBe(
      false,
    );
  });

  it("does not flag a refusal for lacking citations", async () => {
    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: {
        answer: () =>
          Promise.resolve(
            "In den bereitgestellten Dokumenten wurden keine Informationen zur Java-Version gefunden.",
          ),
      },
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });

    expect(out.pack.files.length).toBeGreaterThan(0);
    expect(out.pack.uncertainty.some((m) => m.kind === "uncited-answer")).toBe(false);
    expect(out.pack.uncertainty.some((m) => m.kind === "unsupported-citation")).toBe(false);
  });

  it("RB-4 (GEN-AI-GATEWAY-001): surfaces an incomplete-answer marker for a truncated completion", async () => {
    const truncatedAnswerer: GroundedAnswerer = {
      answer: () =>
        Promise.resolve({
          content: "A partial answer that was cut off",
          usage: { promptTokens: 10, completionTokens: 5 },
          finishReason: "length",
        }),
    };
    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: truncatedAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(out.pack.uncertainty.some((m) => m.kind === "incomplete-answer")).toBe(true);
  });

  it("throws ClarificationNeededError when the planner asks for clarification", async () => {
    // A vague single-word query yields zero/low-weight anchors and trips the planner's
    // "no-anchors" / "too-generic" branches. The orchestrator MUST refuse to run any
    // retrieval before the user resolves the prompt.
    const tooGeneric = happyQuery({ text: "help" });
    await expect(
      runGroundedExploration(input({ query: tooGeneric }), {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      }),
    ).rejects.toBeInstanceOf(ClarificationNeededError);
  });

  it("never invokes the answerer when clarification is needed", async () => {
    let answererCalls = 0;
    const tracking: GroundedAnswerer = {
      answer: () => {
        answererCalls += 1;
        return Promise.resolve("");
      },
    };
    await expect(
      runGroundedExploration(input({ query: happyQuery({ text: "help" }) }), {
        correlationId: undefined,
        answerer: tracking,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      }),
    ).rejects.toBeInstanceOf(ClarificationNeededError);
    expect(answererCalls).toBe(0);
  });

  it("does not rerun structural adapters through the git-history ring", async () => {
    mkdirSync(join(ROOT, ".git", "logs"), { recursive: true });
    writeFileSync(join(ROOT, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(ROOT, ".git", "logs", "HEAD"),
      "0000000000000000000000000000000000000000 abc123def456 Alice <alice@example.com> 1700000000 +0000\tcommit: seed\n",
    );
    const pairAdapter = testSourcePairingAdapter as {
      lookup: typeof testSourcePairingAdapter.lookup;
    };
    const importAdapter = importGraphAdapter as { lookup: typeof importGraphAdapter.lookup };
    const gitAdapter = gitHistoryAdapter as { lookup: typeof gitHistoryAdapter.lookup };
    const originalPairLookup = pairAdapter.lookup;
    const originalImportLookup = importAdapter.lookup;
    const originalGitLookup = gitAdapter.lookup;
    let pairCalls = 0;
    let importCalls = 0;
    let gitCalls = 0;
    pairAdapter.lookup = (...args): ReturnType<typeof originalPairLookup> => {
      pairCalls += 1;
      return originalPairLookup(...args);
    };
    importAdapter.lookup = (...args): ReturnType<typeof originalImportLookup> => {
      importCalls += 1;
      return originalImportLookup(...args);
    };
    gitAdapter.lookup = (...args): ReturnType<typeof originalGitLookup> => {
      gitCalls += 1;
      return originalGitLookup(...args);
    };
    try {
      await runGroundedExploration(
        input({
          scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
          query: happyQuery({ text: "Investigate src/foo.ts and tests/foo.test.ts" }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );
    } finally {
      pairAdapter.lookup = originalPairLookup;
      importAdapter.lookup = originalImportLookup;
      gitAdapter.lookup = originalGitLookup;
    }
    expect(pairCalls).toBeGreaterThan(0);
    expect(importCalls).toBeGreaterThan(0);
    expect(gitCalls).toBe(1);
  });

  it("does not send git-history metadata paths into excerpt selection", async () => {
    mkdirSync(join(ROOT, ".git", "logs"), { recursive: true });
    writeFileSync(join(ROOT, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(ROOT, ".git", "logs", "HEAD"),
      "0000000000000000000000000000000000000000 abc123def456 Alice <alice@example.com> 1700000000 +0000\tcommit: seed\n",
    );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
        query: happyQuery({ text: "Investigate src/foo.ts and recent git history" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.files.every((file) => !file.scopePath.startsWith(".git/"))).toBe(true);
    expect(out.pack.uncertainty.every((marker) => !marker.claim.includes(".git/HEAD"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("uses file-scoped git-history atoms as rankable evidence", async () => {
    mkdirSync(join(ROOT, ".git"));
    writeFileSync(join(ROOT, "src/recent.ts"), "export const recentlyChanged = true;\n");
    const gitFileHistoryEvidence: GitFileHistoryEvidenceProvider = ({ nowMs }) =>
      Promise.resolve([gitHistoryAtom("src/recent.ts", nowMs())]);
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
        // The recent file is introduced by history, rather than by an explicit-path atom that
        // correctly owns the retained excerpt when both sources describe the same line.
        query: happyQuery({ text: "Investigate src/foo.ts and recent git history" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        gitFileHistoryEvidence,
      },
    );
    const recent = out.pack.files.find((file) => file.scopePath === "src/recent.ts");
    expect(recent).toBeDefined();
    expect(
      recent?.excerpts.some((excerpt) => excerpt.atom.provenance.tool === "git-file-history"),
    ).toBe(true);
    expect(out.pack.files.every((file) => !file.scopePath.startsWith(".git/"))).toBe(true);
    expect(out.pack.uncertainty.every((marker) => !marker.claim.includes("git-history"))).toBe(
      true,
    );
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("threads the ask's correlation id into the git-history evidence provider", async () => {
    // The provider logs a failed git read on the shared activity log (AGENTS.md §8 Rule 1), and a
    // line stamped with the UNKNOWN_CORRELATION_ID fallback could not be joined back to the ask
    // whose history ring it degraded — which is the only question that line answers. This pins the
    // hop the provider cannot check for itself: OrchestratorDeps -> SearchInputs -> provider input.
    mkdirSync(join(ROOT, ".git"));
    writeFileSync(join(ROOT, "src/recent.ts"), "export const recentlyChanged = true;\n");
    const seen: (string | undefined)[] = [];
    const gitFileHistoryEvidence: GitFileHistoryEvidenceProvider = ({ nowMs, correlationId }) => {
      seen.push(correlationId);
      return Promise.resolve([gitHistoryAtom("src/recent.ts", nowMs())]);
    };

    await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
        query: happyQuery({ text: "Investigate src/foo.ts and src/recent.ts recent git history" }),
      }),
      {
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        gitFileHistoryEvidence,
        correlationId: "corr-orchestrated-01",
      },
    );

    expect(seen).not.toHaveLength(0);
    expect(seen.every((id) => id === "corr-orchestrated-01")).toBe(true);
  });

  it("cancels a non-cooperative git-history provider at the orchestration boundary", async () => {
    mkdirSync(join(ROOT, ".git"));
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let rejectProvider: (error: unknown) => void = () => undefined;
    const pending = new Promise<readonly EvidenceAtom[]>((_resolve, reject) => {
      rejectProvider = reject;
    });
    const gitFileHistoryEvidence: GitFileHistoryEvidenceProvider = ({ signal }) => {
      providerSignal = signal;
      return pending;
    };
    const outcome = retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
        query: happyQuery({ text: "Investigate src/foo.ts and recent git history" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        signal: controller.signal,
        detectWorkspace: () => fakeWorkspace(),
        gitFileHistoryEvidence,
      },
    );
    const expectation = expect(outcome).rejects.toBeInstanceOf(CancelledError);
    await vi.waitFor(() => {
      expect(providerSignal).toBeDefined();
    });

    controller.abort();

    await expectation;
    expect(providerSignal?.aborted).toBe(true);
    rejectProvider(new Error("late git provider rejection"));
    await Promise.resolve();
  });

  it("answers after a source scan crosses 30 seconds without clipping elapsed evidence", async () => {
    let currentMs = NOW;
    let delayed = false;
    const counted = countingNodeFs();
    const answerer = {
      answer: vi.fn(
        (question: string, pack: ConnectedContextPack): ReturnType<GroundedAnswerer["answer"]> =>
          echoAnswerer.answer(question, pack),
      ),
    };
    const fs: WorkspaceFs = {
      ...counted.fs,
      readDir: (path, maxEntries) => {
        const entries = counted.fs.readDir(path, maxEntries);
        if (!delayed && path.endsWith("src")) {
          currentMs += 34_700;
          delayed = true;
        }
        return entries;
      },
    };
    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      fs,
      nowMs: () => currentMs,
      answerer,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(delayed).toBe(true);
    expect(answerer.answer).toHaveBeenCalledOnce();
    expect(out.pack.files.length).toBeGreaterThan(0);
    expect(out.pack.usage.elapsedMs).toBe(34_700);
    expect(
      out.pack.uncertainty.some(
        (marker) => marker.kind === "budget-clipped" && marker.claim.includes("elapsedMs"),
      ),
    ).toBe(false);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("preserves the workspace streaming directory port through Chat request observation", async () => {
    const iterate = nodeWorkspaceFs.iterateDirectory;
    if (iterate === undefined) throw new Error("Node workspace streaming port missing");
    const observed = vi.fn(iterate);
    const log = createBufferedServerLogSink();
    const out = await retrieveConnectedContextPack(input(), {
      correlationId: undefined,
      nowMs: () => NOW,
      answerer: echoAnswerer,
      fs: { ...nodeWorkspaceFs, iterateDirectory: observed },
      detectWorkspace: () => fakeWorkspace(),
      activityLog: log,
    });
    expect(observed).toHaveBeenCalled();
    expect(out.pack.files.length).toBeGreaterThan(0);
    const details = log.events.find(
      (event) => event.op === "search.connected-context.completion-details",
    );
    const io = recordEventExtra(details?.extra, "workspaceIo");
    expect(io.readDirCalls).toBeGreaterThanOrEqual(observed.mock.calls.length);
    expect(io.readDirEntries).toBeGreaterThan(0);
  });

  it("cancels an uncapped source walk promptly before any provider generation", async () => {
    const controller = new AbortController();
    const base = countingNodeFs();
    const answerer = {
      answer: vi.fn(
        (question: string, pack: ConnectedContextPack): ReturnType<GroundedAnswerer["answer"]> =>
          echoAnswerer.answer(question, pack),
      ),
    };
    let cancelled = false;
    const fs: WorkspaceFs = {
      ...base.fs,
      readDir: (path, maxEntries) => {
        const entries = base.fs.readDir(path, maxEntries);
        if (path.endsWith("src")) {
          controller.abort();
          cancelled = true;
        }
        return entries;
      },
    };
    await expect(
      runGroundedExploration(input(), {
        correlationId: undefined,
        fs,
        signal: controller.signal,
        nowMs: () => NOW,
        answerer,
        detectWorkspace: () => fakeWorkspace(),
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(cancelled).toBe(true);
    expect(answerer.answer).not.toHaveBeenCalled();
  });

  it("uses the budget governor to stop before an over-budget retrieval ring", async () => {
    const out = await runGroundedExploration(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
        query: happyQuery({ text: "Investigate src/foo.ts and tests/foo.test.ts MyClass" }),
        budget: { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: 1 },
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    expect(out.pack.usage.searchCalls).toBe(1);
    expect(out.pack.uncertainty.some((u) => u.kind === "budget-clipped")).toBe(true);
    expect(out.pack.uncertainty.some((u) => u.claim.includes("searchCalls"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("starts no retrieval or assembly IO after the absolute elapsed deadline", async () => {
    const activityLog = createBufferedServerLogSink();
    const elapsedMsMax = 100;
    const deadlineAtMs = NOW + elapsedMsMax;
    let nowMs = NOW;
    const fs = deadlineFsProbe(countingNodeFs().fs, () => nowMs >= deadlineAtMs);
    let semanticCalls = 0;
    let gitCalls = 0;
    let rerankerCalls = 0;
    const semanticProvider: SemanticSearchProvider = {
      name: "deadline fixture",
      search: () => {
        semanticCalls += 1;
        nowMs = deadlineAtMs;
        return Promise.resolve([]);
      },
    };
    const reranker: RerankerSeam = {
      name: "deadline reranker fixture",
      isAvailable: () => {
        rerankerCalls += 1;
        return Promise.resolve({ available: true, modelLabel: "fixture" });
      },
      rerank: (candidates) => Promise.resolve(candidates),
    };

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
        budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax },
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => nowMs,
        detectWorkspace: () => fakeWorkspace(),
        fs: fs.fs,
        repoSemanticSearchProvider: semanticProvider,
        activityLog,
        gitFileHistoryEvidence: () => {
          gitCalls += 1;
          return Promise.resolve([]);
        },
        contextPackReranker: reranker,
      },
    );

    expect(semanticCalls).toBe(1);
    expect(gitCalls).toBe(0);
    expect(rerankerCalls).toBe(0);
    expect(fs.accessesAfterDeadline()).toBe(0);
    expect(
      activityLog.events.find((event) => event.op === "search.connected-context.source-details")
        ?.extra?.explicitPathAdmittedCount,
    ).toBe(1);
    expect(out.pack.usage.searchCalls).toBe(2);
    expect(out.pack.usage.elapsedMs).toBe(elapsedMsMax);
    expect(out.pack.uncertainty.some((marker) => marker.claim.includes("elapsedMs"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("starts no further metadata IO when the deadline crosses inside metadata discovery", async () => {
    const elapsedMsMax = 100;
    const deadlineAtMs = NOW + elapsedMsMax;
    let nowMs = NOW;
    const baseFs = countingNodeFs().fs;
    const canonicalRoot = realpathSync(ROOT);
    const iterate = baseFs.iterateDirectory;
    if (iterate === undefined) throw new Error("streaming port missing");
    let rootIterations = 0;
    let metadataClosed = false;
    const crossingFs: WorkspaceFs = {
      ...baseFs,
      iterateDirectory: async function* (path): AsyncIterable<WorkspaceDirEntry> {
        const metadata = path === canonicalRoot && ++rootIterations === 2;
        try {
          for await (const entry of iterate(path)) {
            if (metadata) nowMs = deadlineAtMs;
            yield entry;
          }
        } finally {
          if (metadata) metadataClosed = true;
        }
      },
    };
    const fs = deadlineFsProbe(crossingFs, () => nowMs >= deadlineAtMs);

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({
          kind: "workspace-root",
          relativePaths: [],
          explicitConnection: true,
        }),
        query: happyQuery({ text: "Which package manager does this repository use?" }),
        budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax },
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => nowMs,
        detectWorkspace: () => fakeWorkspace(),
        fs: fs.fs,
      },
    );

    expect(nowMs).toBe(deadlineAtMs);
    expect(metadataClosed).toBe(true);
    expect(fs.accessesAfterDeadline()).toBe(0);
    expect(out.pack.usage.elapsedMs).toBe(elapsedMsMax);
    expect(out.pack.uncertainty.some((marker) => marker.claim.includes("elapsedMs"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("propagates cancellation that arrives inside metadata discovery", async () => {
    const controller = new AbortController();
    const baseFs = countingNodeFs().fs;
    const canonicalRoot = realpathSync(ROOT);
    const iterate = baseFs.iterateDirectory;
    if (iterate === undefined) throw new Error("streaming port missing");
    let rootIterations = 0;
    let metadataClosed = false;
    const cancellingFs: WorkspaceFs = {
      ...baseFs,
      iterateDirectory: async function* (path): AsyncIterable<WorkspaceDirEntry> {
        const metadata = path === canonicalRoot && ++rootIterations === 2;
        try {
          for await (const entry of iterate(path)) {
            if (metadata) controller.abort();
            yield entry;
          }
        } finally {
          if (metadata) metadataClosed = true;
        }
      },
    };
    const fs = deadlineFsProbe(cancellingFs, () => controller.signal.aborted);

    const expectation = retrieveConnectedContextPack(
      input({
        scope: happyScope({
          kind: "workspace-root",
          relativePaths: [],
          explicitConnection: true,
        }),
        query: happyQuery({ text: "Which package manager does this repository use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        fs: fs.fs,
        signal: controller.signal,
      },
    );

    await expect(expectation).rejects.toBeInstanceOf(CancelledError);
    expect(controller.signal.aborted).toBe(true);
    expect(metadataClosed).toBe(true);
    expect(fs.accessesAfterDeadline()).toBe(0);
  });

  it("starts no further filesystem access when the deadline crosses inside workspace detection", async () => {
    // #3347 P2: deadlineAtMs is computed before workspace detection runs, but detection previously
    // received the observed raw filesystem with no request signal or deadline guard — the first
    // elapsed-budget check happened only after `detect` returned. Cross the deadline mid-detection
    // (on the "src" directory stat, which `inspectCanonicalWorkspace` reaches only after the
    // package.json read that precedes it, and well before the ignore-file and language-marker
    // checks that follow it) to prove the guard trips BETWEEN detector filesystem operations, not
    // only at detector return.
    const elapsedMsMax = 100;
    const deadlineAtMs = NOW + elapsedMsMax;
    let nowMs = NOW;
    const baseFs = countingNodeFs().fs;
    const srcDirPath = realpathSync(join(ROOT, "src"));
    const crossingFs: WorkspaceFs = {
      ...baseFs,
      stat: (path): WorkspaceStat => {
        const stat = baseFs.stat(path);
        if (path === srcDirPath) nowMs = deadlineAtMs;
        return stat;
      },
    };
    const fs = deadlineFsProbe(crossingFs, () => nowMs >= deadlineAtMs);

    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({
          kind: "workspace-root",
          relativePaths: [],
          explicitConnection: true,
        }),
        query: happyQuery({ text: "Which package manager does this repository use?" }),
        budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax },
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => nowMs,
        // No detectWorkspace override: this test exercises the REAL detector so the deadline guard
        // added around it is actually on the call path.
        fs: fs.fs,
      },
    );

    expect(nowMs).toBe(deadlineAtMs);
    expect(fs.accessesAfterDeadline()).toBe(0);
    expect(out.pack.usage.elapsedMs).toBe(elapsedMsMax);
    expect(out.pack.uncertainty.some((marker) => marker.claim.includes("elapsedMs"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("propagates cancellation that arrives inside workspace detection", async () => {
    const controller = new AbortController();
    const baseFs = countingNodeFs().fs;
    const srcDirPath = realpathSync(join(ROOT, "src"));
    const cancellingFs: WorkspaceFs = {
      ...baseFs,
      stat: (path): WorkspaceStat => {
        const stat = baseFs.stat(path);
        if (path === srcDirPath) controller.abort();
        return stat;
      },
    };
    const fs = deadlineFsProbe(cancellingFs, () => controller.signal.aborted);

    const expectation = retrieveConnectedContextPack(
      input({
        scope: happyScope({
          kind: "workspace-root",
          relativePaths: [],
          explicitConnection: true,
        }),
        query: happyQuery({ text: "Which package manager does this repository use?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        fs: fs.fs,
        signal: controller.signal,
      },
    );

    await expect(expectation).rejects.toBeInstanceOf(CancelledError);
    expect(controller.signal.aborted).toBe(true);
    expect(fs.accessesAfterDeadline()).toBe(0);
  });

  it("starts no edge-target filesystem operation after structural filtering is cancelled", async () => {
    const edgeDir = join(ROOT, "edge-targets");
    mkdirSync(edgeDir);
    writeFileSync(join(edgeDir, "first.ts"), "export const first = 1;\n");
    writeFileSync(join(edgeDir, "second.ts"), "export const second = 2;\n");
    const firstTarget = realpathSync(join(edgeDir, "first.ts"));
    const controller = new AbortController();
    const counted = countingNodeFs();
    const cancellingFs: WorkspaceFs = {
      ...counted.fs,
      stat: (path): WorkspaceStat => {
        const stat = counted.fs.stat(path);
        if (path === firstTarget) controller.abort();
        return stat;
      },
    };
    const fs = deadlineFsProbe(cancellingFs, () => controller.signal.aborted);
    const pairAdapter = testSourcePairingAdapter as {
      lookup: typeof testSourcePairingAdapter.lookup;
    };
    const originalLookup = pairAdapter.lookup;
    pairAdapter.lookup = (): Promise<readonly EvidenceAtom[]> =>
      Promise.resolve([
        structuralEdgeAtom("structural-cancel-first", "edge-targets/first.ts"),
        structuralEdgeAtom("structural-cancel-second", "edge-targets/second.ts"),
      ]);
    try {
      await expect(
        retrieveConnectedContextPack(input(), {
          correlationId: undefined,
          answerer: echoAnswerer,
          signal: controller.signal,
          fs: fs.fs,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        }),
      ).rejects.toBeInstanceOf(CancelledError);
    } finally {
      pairAdapter.lookup = originalLookup;
    }

    expect(controller.signal.aborted).toBe(true);
    expect(fs.accessesAfterDeadline()).toBe(0);
  });

  it("starts no rankability filesystem operation after git-atom filtering is cancelled", async () => {
    mkdirSync(join(ROOT, ".git"));
    writeFileSync(join(ROOT, ".git/HEAD"), "ref: refs/heads/fixture\n");
    writeFileSync(join(ROOT, "src/recent-first.ts"), "export const recentFirst = true;\n");
    writeFileSync(join(ROOT, "src/recent-second.ts"), "export const recentSecond = true;\n");
    const firstTarget = realpathSync(join(ROOT, "src/recent-first.ts"));
    const controller = new AbortController();
    const counted = countingNodeFs();
    let providerCompleted = false;
    const cancellingFs: WorkspaceFs = {
      ...counted.fs,
      stat: (path): WorkspaceStat => {
        const stat = counted.fs.stat(path);
        if (providerCompleted && path === firstTarget) controller.abort();
        return stat;
      },
    };
    const fs = deadlineFsProbe(cancellingFs, () => controller.signal.aborted);
    const gitFileHistoryEvidence: GitFileHistoryEvidenceProvider = ({ nowMs }) => {
      providerCompleted = true;
      return Promise.resolve([
        gitHistoryAtom("src/recent-first.ts", nowMs()),
        gitHistoryAtom("src/recent-second.ts", nowMs()),
      ]);
    };

    await expect(
      retrieveConnectedContextPack(
        input({
          scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
          query: happyQuery({ text: "Investigate src/foo.ts and recent git history changes" }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          signal: controller.signal,
          fs: fs.fs,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
          gitFileHistoryEvidence,
        },
      ),
    ).rejects.toBeInstanceOf(CancelledError);

    expect(providerCompleted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(fs.accessesAfterDeadline()).toBe(0);
  });

  it("starts no selected-file filesystem operation after scope filtering is cancelled", async () => {
    const firstTarget = realpathSync(join(ROOT, "src/foo.ts"));
    const canonicalSrc = realpathSync(join(ROOT, "src"));
    const controller = new AbortController();
    const counted = countingNodeFs();
    let selectedDirectoryEnumerated = false;
    const cancellingFs: WorkspaceFs = {
      ...counted.fs,
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        const entries = counted.fs.readDir(path, maxEntries);
        // The selected directory's one ring enumeration. Ring retrieval used to read it at the
        // requesting consumer's own cap (25 for this scope) and now reads it once at the shared
        // sentinel cap (#3347 P1), so the trigger names that enumeration through the production
        // constant instead of the cap one consumer happened to ask for. Same event, same moment.
        if (
          path === canonicalSrc &&
          maxEntries === _RING_DISCOVERY_SENTINEL_ENTRIES_FOR_TESTS + 1
        ) {
          selectedDirectoryEnumerated = true;
        }
        return entries;
      },
      stat: (path): WorkspaceStat => {
        const stat = counted.fs.stat(path);
        if (selectedDirectoryEnumerated && path === firstTarget) controller.abort();
        return stat;
      },
    };
    const fs = deadlineFsProbe(cancellingFs, () => controller.signal.aborted);

    await expect(
      retrieveConnectedContextPack(
        input({
          scope: happyScope({
            kind: "files",
            relativePaths: ["src/foo.ts", "src/bar.ts"],
            explicitConnection: true,
          }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          signal: controller.signal,
          fs: fs.fs,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      ),
    ).rejects.toBeInstanceOf(CancelledError);

    expect(selectedDirectoryEnumerated).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(fs.accessesAfterDeadline()).toBe(0);
  });

  it("starts no cache-identity filesystem operation after identity collection is cancelled", async () => {
    const firstTarget = realpathSync(join(ROOT, "src/foo.ts"));
    const controller = new AbortController();
    const counted = countingNodeFs();
    const cancellingFs: WorkspaceFs = {
      ...counted.fs,
      stat: (path): WorkspaceStat => {
        const stat = counted.fs.stat(path);
        if (path === firstTarget) controller.abort();
        return stat;
      },
    };
    const fs = deadlineFsProbe(cancellingFs, () => controller.signal.aborted);
    const searchScope: SearchScope = {
      workspace: fakeWorkspace(),
      scopeId: "cache-identity-cancellation",
      relativePaths: ["src"],
    };

    await expect(
      _fileStateCacheIdentityForTests(
        ["src/foo.ts", "src/bar.ts"],
        searchScope,
        fs.fs,
        () => NOW,
        NOW + 1_000,
        controller.signal,
      ),
    ).rejects.toThrow(CancelledError);
    expect(controller.signal.aborted).toBe(true);
    expect(fs.accessesAfterDeadline()).toBe(0);
  });

  it("charges structural fan-out before running adapters", async () => {
    const pairAdapter = testSourcePairingAdapter as {
      lookup: typeof testSourcePairingAdapter.lookup;
    };
    const importAdapter = importGraphAdapter as { lookup: typeof importGraphAdapter.lookup };
    const originalPairLookup = pairAdapter.lookup;
    const originalImportLookup = importAdapter.lookup;
    let pairCalls = 0;
    let importCalls = 0;
    pairAdapter.lookup = (...args): ReturnType<typeof originalPairLookup> => {
      pairCalls += 1;
      return originalPairLookup(...args);
    };
    importAdapter.lookup = (...args): ReturnType<typeof originalImportLookup> => {
      importCalls += 1;
      return originalImportLookup(...args);
    };
    try {
      const activityLog = createBufferedServerLogSink();
      const out = await retrieveConnectedContextPack(
        input({
          query: happyQuery({
            text: "Investigate src/foo.ts tests/foo.test.ts `MyClass`",
          }),
          budget: { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: 2 },
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
          activityLog,
        },
      );
      expect(out.pack.usage.searchCalls).toBe(2);
      expect(out.pack.uncertainty.some((u) => u.claim.includes("searchCalls"))).toBe(true);
      const completedDetails = activityLog.events.find(
        (event) => event.op === "search.connected-context.completion-details",
      );
      const structural = recordEventExtra(completedDetails?.extra, "structural");
      expect(numericEventExtra(structural, "fileSearchCount")).toBe(0);
      expect(numericEventExtra(structural, "textSearchCount")).toBe(0);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    } finally {
      pairAdapter.lookup = originalPairLookup;
      importAdapter.lookup = originalImportLookup;
    }
    expect(pairCalls).toBe(0);
    expect(importCalls).toBe(0);
  });

  it.each([
    [11, 0],
    [12, 1],
  ])(
    "charges deterministic searches at the %i-call grant boundary",
    async (searchCallsMax, fileSearchCount) => {
      const activityLog = createBufferedServerLogSink();
      const out = await retrieveConnectedContextPack(
        input({
          budget: { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax },
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
          activityLog,
        },
      );
      const completedDetails = activityLog.events.find(
        (event) => event.op === "search.connected-context.completion-details",
      );
      const structural = recordEventExtra(completedDetails?.extra, "structural");

      expect(
        activityLog.events.find((event) => event.op === "search.connected-context.source-details")
          ?.extra?.explicitPathAdmittedCount,
      ).toBe(1);
      expect(out.pack.usage.searchCalls).toBe(searchCallsMax);
      expect(numericEventExtra(structural, "fileSearchCount")).toBe(fileSearchCount);
      expect(numericEventExtra(structural, "textSearchCount")).toBe(0);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    },
  );

  it("clips answer-phase budget overages into a valid pack", async () => {
    let now = NOW;
    const budget: OrchestratorInput["budget"] = {
      ...DEFAULT_EXPLORATION_BUDGET,
      modelInputTokensMax: 10,
      modelOutputTokensMax: 5,
      elapsedMsMax: 100,
    };
    const answerer: GroundedAnswerer = {
      answer: () => {
        now += 250;
        return Promise.resolve({
          content: "answer",
          usage: { promptTokens: 999, completionTokens: 777 },
        });
      },
    };
    const out = await runGroundedExploration(input({ budget }), {
      correlationId: undefined,
      answerer,
      nowMs: () => now,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(out.elapsedMs).toBe(250);
    expect(out.pack.usage.modelInputTokens).toBe(10);
    expect(out.pack.usage.modelOutputTokens).toBe(5);
    expect(out.pack.usage.elapsedMs).toBe(100);
    expect(out.pack.uncertainty.some((u) => u.claim.includes("modelInputTokens"))).toBe(true);
    expect(out.pack.uncertainty.some((u) => u.claim.includes("modelOutputTokens"))).toBe(true);
    expect(out.pack.uncertainty.some((u) => u.claim.includes("elapsedMs"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("preserves repository-search omission reasons in the context pack", async () => {
    writeFileSync(join(ROOT, "src/asset.png"), "\x89PNG\r\n\x1a\n\0binary");
    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(
      out.pack.omitted.some(
        (entry) => entry.scopePath === "src/asset.png" && entry.reason === "binary",
      ),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("reads excerpt windows around late-line evidence instead of only the file header", async () => {
    const filler = Array.from({ length: 239 }, (_, i) => `// filler ${String(i + 1)}`).join("\n");
    writeFileSync(
      join(ROOT, "src/late.ts"),
      `${filler}\nexport const late = 'MyClass late target';\n`,
    );
    const out = await runGroundedExploration(
      input({ query: happyQuery({ text: "Investigate src/late.ts MyClass late target" }) }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );
    const lateFile = out.pack.files.find((file) => file.scopePath === "src/late.ts");
    expect(
      lateFile?.excerpts.some((excerpt) => excerpt.content.includes("MyClass late target")),
    ).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("reads a discovered handler definition before a higher-scoring lexical decoy", async () => {
    const lines = [
      "// MyClass lexical decoy",
      ...Array.from(
        { length: 68 },
        (_value, index) => `// filler ${String(index + 1)} ${"x".repeat(180)}`,
      ),
      "export async function LateHandler(): Promise<void> {",
      "  await runPipeline();",
      "}",
    ];
    writeFileSync(join(ROOT, "src/prioritized.ts"), `${lines.join("\n")}\n`);
    const adapter = importGraphAdapter as { lookup: typeof importGraphAdapter.lookup };
    const originalLookup = adapter.lookup;
    adapter.lookup = (): ReturnType<typeof originalLookup> =>
      Promise.resolve([
        {
          schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
          stableId: "discovered-handler-definition",
          scopePath: "src/prioritized.ts",
          lineRange: { startLine: 70, endLine: 72 },
          score: 0.1,
          provenance: {
            kind: "structural",
            tool: "discovered-symbol-definition",
            queryFingerprint: "fp-discovered-definition",
          },
          redactionState: "redacted",
          emittedAtMs: NOW,
          ledgerRef: undefined,
        } satisfies EvidenceAtom,
      ]);
    try {
      const out = await retrieveConnectedContextPack(
        input({
          scope: happyScope({ kind: "files", relativePaths: ["src/prioritized.ts"] }),
          query: happyQuery({ text: "Investigate MyClass in src/prioritized.ts" }),
          budget: {
            ...DEFAULT_EXPLORATION_BUDGET,
            filesReadMax: 1,
            excerptBytesMax: 260,
          },
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );
      const target = out.pack.files.find((file) => file.scopePath === "src/prioritized.ts");
      expect(target?.excerpts.some((excerpt) => excerpt.content.includes("LateHandler"))).toBe(
        true,
      );
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    } finally {
      adapter.lookup = originalLookup;
    }
  });

  it("keeps the complete wrapped Markdown statement around a matching line", async () => {
    mkdirSync(join(ROOT, "docs/adr"), { recursive: true });
    writeFileSync(
      join(ROOT, "docs/adr/ADR-0129-authority.md"),
      "# ADR-0129 authority\n" +
        "\n" +
        "The three autonomy modes are product-wide.\n" +
        "They are defined in ADR-0129 as Ask for approval,\n" +
        "Supervised workspace, and\n" +
        "Full access.\n",
    );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "directory", relativePaths: ["docs/adr"] }),
        query: happyQuery({ text: "Which three autonomy modes are defined in ADR-0129?" }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    const document = out.pack.files.find((file) => file.scopePath.includes("ADR-0129"));
    expect(document?.excerpts.map((excerpt) => excerpt.content)).toEqual(
      expect.arrayContaining([expect.stringContaining("Full access")]),
    );
  });

  it("reads a bounded referenced ADR even when the requested fact is far from its title", async () => {
    mkdirSync(join(ROOT, "docs/adr"), { recursive: true });
    const filler = Array.from({ length: 78 }, (_value, index) => `context ${String(index + 1)}`);
    writeFileSync(
      join(ROOT, "docs/adr/ADR-0129-authority.md"),
      [
        "# ADR-0129 authority",
        ...filler,
        "Machine value: autonomous-delivery means Full access.",
      ].join("\n"),
    );
    const out = await retrieveConnectedContextPack(
      input({
        scope: happyScope({ kind: "directory", relativePaths: ["docs/adr"] }),
        query: happyQuery({ text: "Summarize ADR-0129 precisely." }),
      }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      },
    );

    const document = out.pack.files.find((file) => file.scopePath.includes("ADR-0129"));
    expect(document?.excerpts.map((excerpt) => excerpt.content)).toEqual(
      expect.arrayContaining([expect.stringContaining("autonomous-delivery")]),
    );
  });

  it("retains repeated same-file evidence windows without a false incomplete marker", async () => {
    const lines = Array.from({ length: 96 }, (_unused, i) =>
      i % 10 === 0
        ? `export const hit${String(i)} = 'MyClass repeated target';`
        : `// filler ${String(i)}`,
    );
    writeFileSync(join(ROOT, "src/repeated.ts"), `${lines.join("\n")}\n`);
    const adapter = importGraphAdapter as { lookup: typeof importGraphAdapter.lookup };
    const originalLookup = adapter.lookup;
    adapter.lookup = (): ReturnType<typeof originalLookup> =>
      Promise.resolve(
        Array.from(
          { length: 10 },
          (_unused, i) =>
            ({
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId: `structural-src/repeated.ts-${String(i)}`,
              scopePath: "src/repeated.ts",
              lineRange: { startLine: i * 10 + 1, endLine: i * 10 + 1 },
              score: i === 9 ? 1 : 0.5,
              provenance: {
                kind: "structural",
                tool: "import-graph",
                queryFingerprint: "fp-repeated",
              },
              redactionState: "redacted",
              emittedAtMs: NOW,
              ledgerRef: undefined,
            }) satisfies EvidenceAtom,
        ),
      );
    try {
      const out = await runGroundedExploration(
        input({
          query: happyQuery({ text: "Investigate src/repeated.ts MyClass repeated target" }),
        }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => NOW,
          detectWorkspace: () => fakeWorkspace(),
        },
      );
      const repeatedFile = out.pack.files.find((file) => file.scopePath === "src/repeated.ts");
      expect(repeatedFile?.excerpts.some((excerpt) => excerpt.content.includes("hit90"))).toBe(
        true,
      );
      expect(
        repeatedFile?.excerpts.flatMap((excerpt) =>
          excerpt.content.split("\n").filter((line) => line.includes("MyClass repeated")),
        ).length,
      ).toBeGreaterThan(8);
      expect(
        out.pack.uncertainty.every(
          (marker) =>
            !(
              marker.kind === "scope-incomplete" &&
              marker.claim.includes("additional matching range") &&
              marker.claim.includes("src/repeated.ts")
            ),
        ),
      ).toBe(true);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);
    } finally {
      adapter.lookup = originalLookup;
    }
  });

  it("reuses an injected micro-index for repeated context-pack assembly", async () => {
    const microIndex = recordingMicroIndex();
    const first = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
      microIndex: microIndex.index,
    });
    const second = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW + 1_000,
      detectWorkspace: () => fakeWorkspace(),
      microIndex: microIndex.index,
    });
    expect(microIndex.sets()).toBe(1);
    expect(microIndex.gets()).toBe(2);
    expect(second.pack.stableId).toBe(first.pack.stableId);
    expect(second.pack.files).toStrictEqual(first.pack.files);
    expect(second.pack.usage).toStrictEqual(first.pack.usage);
    expect(second.pack.uncertainty.map((marker) => marker.kind)).toStrictEqual(
      first.pack.uncertainty.map((marker) => marker.kind),
    );
  });

  it("hits the micro-index before excerpt assembly when elapsed time changes", async () => {
    const microIndex = recordingMicroIndex();
    const counted = countingNodeFs();
    let now = NOW;
    const nowMs = (): number => {
      now += 10;
      return now;
    };

    const first = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs,
      fs: counted.fs,
      detectWorkspace: () => fakeWorkspace(),
      microIndex: microIndex.index,
    });
    expect(microIndex.gets()).toBe(1);

    const second = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs,
      fs: counted.fs,
      detectWorkspace: () => fakeWorkspace(),
      microIndex: microIndex.index,
    });

    expect(microIndex.sets()).toBe(1);
    expect(microIndex.gets()).toBe(2);
    expect(second.pack.stableId).toBe(first.pack.stableId);
    expect(second.pack.files).toStrictEqual(first.pack.files);
  });

  it("invalidates a cached pack after a same-size atomic replacement with restored mtime", async () => {
    const target = join(ROOT, "src/foo.ts");
    const replacementPath = join(ROOT, "src/foo.ts.replacement");
    const fixedTimestampSeconds = 1_650_000_000;
    utimesSync(target, fixedTimestampSeconds, fixedTimestampSeconds);
    const before = nodeWorkspaceFs.stat(target);
    const original = readFileSync(target, "utf8");
    const replacement = original.replace("foo body", "bar body");
    expect(Buffer.byteLength(replacement, "utf8")).toBe(Buffer.byteLength(original, "utf8"));

    const microIndex = recordingMicroIndex();
    const request = input({
      scope: happyScope({ kind: "files", relativePaths: ["src/foo.ts"] }),
      query: happyQuery({ text: "Investigate src/foo.ts behaviour of MyClass" }),
    });
    const deps = {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: (): number => NOW,
      detectWorkspace: (): WorkspaceInfo => fakeWorkspace(),
      microIndex: microIndex.index,
    };
    const first = await retrieveConnectedContextPack(request, deps);
    expect(
      first.pack.files[0]?.excerpts.some((excerpt) => excerpt.content.includes("foo body")),
    ).toBe(true);

    writeFileSync(replacementPath, replacement);
    renameSync(replacementPath, target);
    utimesSync(target, fixedTimestampSeconds, fixedTimestampSeconds);
    const after = nodeWorkspaceFs.stat(target);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.fileIdentity).not.toBe(before.fileIdentity);

    const second = await retrieveConnectedContextPack(request, deps);
    const secondExcerpts = second.pack.files.flatMap((file) => file.excerpts);
    expect(secondExcerpts.some((excerpt) => excerpt.content.includes("bar body"))).toBe(true);
    expect(secondExcerpts.some((excerpt) => excerpt.content.includes("foo body"))).toBe(false);
    expect(microIndex.sets()).toBe(2);
  });

  it("does not touch workspace file IO when read budgets are zero", async () => {
    const out = await runGroundedExploration(
      input({
        budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 0, excerptBytesMax: 0 },
      }),
      { correlationId: undefined, answerer: echoAnswerer, nowMs: () => NOW, fs: throwingReadFs() },
    );
    expect(out.pack.files).toEqual([]);
    expect(out.pack.usage.filesRead).toBe(0);
    expect(out.pack.usage.excerptBytes).toBe(0);
    expect(out.pack.uncertainty.some((u) => u.claim.includes("filesRead"))).toBe(true);
  });

  it("does not detect, cache, or rerank when the elapsed budget is already exhausted", async () => {
    const microIndex = recordingMicroIndex();
    let detectCalls = 0;
    let rerankerCalls = 0;
    const reranker: RerankerSeam = {
      name: "unused elapsed-budget fixture",
      isAvailable: () => {
        rerankerCalls += 1;
        return Promise.resolve({ available: true, modelLabel: "fixture" });
      },
      rerank: (candidates) => Promise.resolve(candidates),
    };

    const out = await retrieveConnectedContextPack(
      input({ budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 0 } }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => NOW,
        fs: throwingReadFs(),
        detectWorkspace: () => {
          detectCalls += 1;
          return fakeWorkspace();
        },
        microIndex: microIndex.index,
        contextPackReranker: reranker,
      },
    );

    expect(detectCalls).toBe(0);
    expect(microIndex.gets()).toBe(0);
    expect(microIndex.sets()).toBe(0);
    expect(rerankerCalls).toBe(0);
    expect(out.pack.usage.elapsedMs).toBe(0);
    expect(out.pack.uncertainty.some((marker) => marker.claim.includes("elapsedMs"))).toBe(true);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("does not resolve a workspace index after detection consumes the remaining time", async () => {
    let nowMs = NOW;
    const deadlineAtMs = NOW + 100;
    let indexProviderCalls = 0;

    const out = await retrieveConnectedContextPack(
      input({ budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 100 } }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => nowMs,
        detectWorkspace: () => {
          nowMs = deadlineAtMs;
          return fakeWorkspace();
        },
        workspaceIndexForRoot: () => {
          indexProviderCalls += 1;
          return undefined;
        },
      },
    );

    expect(indexProviderCalls).toBe(0);
    expect(out.pack.uncertainty.some((marker) => marker.claim.includes("elapsedMs"))).toBe(true);
  });

  it("starts no second cache lookup or reranker after a cache lookup reaches the deadline", async () => {
    let nowMs = NOW;
    const deadlineAtMs = NOW + 100;
    let cacheGets = 0;
    let cacheSets = 0;
    let rerankerCalls = 0;
    const rerankerCallTimes: number[] = [];
    const microIndex: MicroIndex = {
      get: (): undefined => {
        cacheGets += 1;
        nowMs = deadlineAtMs;
        return undefined;
      },
      set: (): void => {
        cacheSets += 1;
      },
      delete: (): void => undefined,
      clear: (): void => undefined,
      size: (): number => 0,
    };
    const reranker: RerankerSeam = {
      name: "post-cache-deadline fixture",
      isAvailable: () => {
        rerankerCalls += 1;
        rerankerCallTimes.push(nowMs);
        return Promise.resolve({ available: true, modelLabel: "fixture" });
      },
      rerank: (candidates) => Promise.resolve(candidates),
    };

    const out = await retrieveConnectedContextPack(
      input({ budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 100 } }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => nowMs,
        detectWorkspace: () => fakeWorkspace(),
        microIndex,
        contextPackReranker: reranker,
      },
    );

    expect(cacheGets).toBe(1);
    expect(cacheSets).toBe(0);
    // Pre-cut reranking now precedes the cache; no later call may start at the deadline.
    expect(rerankerCalls).toBe(1);
    expect(rerankerCallTimes.every((time) => time < deadlineAtMs)).toBe(true);
    expect(out.pack.uncertainty.some((marker) => marker.claim.includes("elapsedMs"))).toBe(true);
  });

  it("does not start reranking after availability consumes the remaining time", async () => {
    let nowMs = NOW;
    const deadlineAtMs = NOW + 100;
    let availabilityCalls = 0;
    let rerankCalls = 0;
    const reranker: RerankerSeam = {
      name: "availability-deadline fixture",
      isAvailable: () => {
        availabilityCalls += 1;
        nowMs = deadlineAtMs;
        return Promise.resolve({ available: true, modelLabel: "fixture" });
      },
      rerank: (candidates) => {
        rerankCalls += 1;
        return Promise.resolve(candidates);
      },
    };

    await retrieveConnectedContextPack(
      input({ budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 100 } }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => nowMs,
        detectWorkspace: () => fakeWorkspace(),
        contextPackReranker: reranker,
      },
    );

    expect(availabilityCalls).toBe(1);
    expect(rerankCalls).toBe(0);
  });

  it("falls back when reranker availability rejects at the absolute deadline", async () => {
    let nowMs = NOW;
    const deadlineAtMs = NOW + 100;
    let rerankCalls = 0;
    const reranker: RerankerSeam = {
      name: "availability-rejection-at-deadline fixture",
      isAvailable: () => {
        nowMs = deadlineAtMs;
        return Promise.reject(new Error("availability failed after the budget elapsed"));
      },
      rerank: (candidates) => {
        rerankCalls += 1;
        return Promise.resolve(candidates);
      },
    };

    const out = await retrieveConnectedContextPack(
      input({ budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 100 } }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => nowMs,
        detectWorkspace: () => fakeWorkspace(),
        contextPackReranker: reranker,
      },
    );

    expect(rerankCalls).toBe(0);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("settles at the deadline when availability never settles and ignores its late result", async () => {
    vi.useFakeTimers();
    try {
      type Availability = Awaited<ReturnType<RerankerSeam["isAvailable"]>>;
      let nowMs = NOW;
      let markStarted = (): void => undefined;
      let resolveAvailability = (_value: Availability): void => undefined;
      const started = new Promise<void>((resolveStarted) => {
        markStarted = resolveStarted;
      });
      const availability = new Promise<Availability>((resolve) => {
        resolveAvailability = resolve;
      });
      let rerankCalls = 0;
      const reranker: RerankerSeam = {
        name: "never-settling-availability fixture",
        isAvailable: () => {
          markStarted();
          return availability;
        },
        rerank: (candidates) => {
          rerankCalls += 1;
          return Promise.resolve(candidates);
        },
      };
      const pending = retrieveConnectedContextPack(
        input({ budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 25 } }),
        {
          correlationId: undefined,
          answerer: echoAnswerer,
          nowMs: () => nowMs,
          detectWorkspace: () => fakeWorkspace(),
          contextPackReranker: reranker,
        },
      );

      await started;
      nowMs = NOW + 25;
      await vi.advanceTimersByTimeAsync(25);
      const out = await pending;
      expect(rerankCalls).toBe(0);
      expect(validateConnectedContextPack(out.pack).ok).toBe(true);

      resolveAvailability({ available: true, modelLabel: "too-late" });
      await Promise.resolve();
      expect(rerankCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads no excerpts after preselection reranking times out and discards its late result", async () => {
    const request = input({
      scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
      query: happyQuery({ text: "Investigate src/foo.ts and src/bar.ts MyClass" }),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 25 },
    });
    vi.useFakeTimers();
    try {
      type Candidates = Awaited<ReturnType<RerankerSeam["rerank"]>>;
      let nowMs = NOW;
      let markStarted = (): void => undefined;
      let resolveRerank = (_value: Candidates): void => undefined;
      const started = new Promise<void>((resolveStarted) => {
        markStarted = resolveStarted;
      });
      const lateRerank = new Promise<Candidates>((resolve) => {
        resolveRerank = resolve;
      });
      let lateOrder: Candidates = [];
      let executionSignal: AbortSignal | undefined;
      let executionTimeoutMs: number | undefined;
      let candidatePaths: readonly string[] = [];
      const reranker: RerankerSeam = {
        name: "never-settling-rerank fixture",
        isAvailable: () => Promise.resolve({ available: true, modelLabel: "fixture" }),
        rerank: (candidates, _atomsByPath, _topK, context) => {
          candidatePaths = candidates.map((candidate) => candidate.scopePath);
          lateOrder = [...candidates].reverse();
          executionSignal = context?.signal;
          executionTimeoutMs = context?.timeoutMs;
          markStarted();
          return lateRerank;
        },
      };
      const pending = retrieveConnectedContextPack(request, {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: () => nowMs,
        detectWorkspace: () => fakeWorkspace(),
        contextPackReranker: reranker,
      });

      await started;
      expect(executionSignal?.aborted).toBe(false);
      expect(executionTimeoutMs).toBe(25);
      nowMs = NOW + 25;
      await vi.advanceTimersByTimeAsync(25);
      const out = await pending;
      expect(executionSignal?.aborted).toBe(true);
      expect(candidatePaths.length).toBeGreaterThan(0);
      expect(out.pack.files).toEqual([]);
      expect(out.pack.diagnostics?.selection).toMatchObject({
        rerankerDisposition: "skipped-budget",
        reranked: false,
      });

      resolveRerank(lateOrder);
      await Promise.resolve();
      expect(out.pack.files).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts no excerpt reads after preselection reranking rejects at the absolute deadline", async () => {
    const request = input({
      scope: happyScope({ kind: "workspace-root", relativePaths: [] }),
      query: happyQuery({ text: "Investigate src/foo.ts and src/bar.ts MyClass" }),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 100 },
    });
    const baseline = await retrieveConnectedContextPack(request, {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    let nowMs = NOW;
    const deadlineAtMs = NOW + 100;
    const reranker: RerankerSeam = {
      name: "rerank-rejection-at-deadline fixture",
      isAvailable: () => Promise.resolve({ available: true, modelLabel: "fixture" }),
      rerank: () => {
        nowMs = deadlineAtMs;
        return Promise.reject(new Error("rerank failed after the budget elapsed"));
      },
    };

    const out = await retrieveConnectedContextPack(request, {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => nowMs,
      detectWorkspace: () => fakeWorkspace(),
      contextPackReranker: reranker,
    });

    expect(baseline.pack.files.length).toBeGreaterThan(0);
    expect(out.pack.files).toEqual([]);
    expect(out.pack.diagnostics?.selection).toMatchObject({
      rerankerDisposition: "skipped-budget",
      reranked: false,
    });
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("cancels a never-settling reranker without waiting for the elapsed deadline", async () => {
    const controller = new AbortController();
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    let executionSignal: AbortSignal | undefined;
    const reranker: RerankerSeam = {
      name: "cancelled-availability fixture",
      isAvailable: (context) => {
        executionSignal = context?.signal;
        markStarted();
        return new Promise<Awaited<ReturnType<RerankerSeam["isAvailable"]>>>(() => undefined);
      },
      rerank: (candidates) => Promise.resolve(candidates),
    };
    const pending = retrieveConnectedContextPack(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      signal: controller.signal,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
      contextPackReranker: reranker,
    });

    await started;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(executionSignal?.aborted).toBe(true);
  });

  it("rejects with CancelledError before the answerer is called when the signal is already aborted", async () => {
    // Mutation guard: removing the throwIfCancelled call at the orchestrator entry point
    // must fail this test because the answerer would be invoked instead.
    const controller = new AbortController();
    controller.abort();
    let answererCalls = 0;
    const trackingAnswerer: GroundedAnswerer = {
      answer: () => {
        answererCalls += 1;
        return Promise.resolve("should not reach here");
      },
    };
    await expect(
      runGroundedExploration(input(), {
        correlationId: undefined,
        answerer: trackingAnswerer,
        signal: controller.signal,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(answererCalls).toBe(0);
  });

  it("stops the lexical scan after the active file when cancellation arrives during IO", async () => {
    const controller = new AbortController();
    const counted = countingNodeFs();
    let binaryProbeReads = 0;
    const fs: WorkspaceFs = {
      ...counted.fs,
      readFileBytes: (absolutePath, maxBytes, hardLinkPolicy, expected): Promise<Uint8Array> => {
        binaryProbeReads += 1;
        controller.abort();
        return (
          counted.fs.readFileBytes?.(absolutePath, maxBytes, hardLinkPolicy, expected) ??
          Promise.resolve(new Uint8Array())
        );
      },
    };

    await expect(
      retrieveConnectedContextPack(input(), {
        correlationId: undefined,
        answerer: echoAnswerer,
        signal: controller.signal,
        fs,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(binaryProbeReads).toBe(1);
  });
});

// PR4-W1 (ADR-0055 D1/D5/D6): the grounded diagnostics observer threaded through OrchestratorDeps.
describe("runGroundedExploration — context diagnostics observer (PR4-W1)", () => {
  it("noProfileUnchanged: omits diagnostics.contextBudget when no profile is threaded", async () => {
    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(out.pack.diagnostics?.contextBudget).toBeUndefined();
  });

  it("diagnosticsPresent: populates a valid ContextBudget when a profile is threaded", async () => {
    const out = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    const budget = out.pack.diagnostics?.contextBudget;
    expect(budget).toBeDefined();
    expect(validateContextBudget(budget).ok).toBe(true);
    expect(budget?.profile).toBe(DEFAULT_CONTEXT_PROFILE);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  });

  it("noProfileUnchanged: pack is otherwise byte-identical with vs without the profile", async () => {
    const withoutProfile = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    const withProfile = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(withProfile.pack.stableId).toBe(withoutProfile.pack.stableId);
    expect(withProfile.pack.files).toEqual(withoutProfile.pack.files);
    expect(withProfile.pack.budget).toEqual(withoutProfile.pack.budget);
    expect(withProfile.pack.usage).toEqual(withoutProfile.pack.usage);
    expect(withProfile.assistantContent).toBe(withoutProfile.assistantContent);
  });

  it("firstRingPreserved: rankedCandidates survives the observer when the lexical ring populated it", async () => {
    const withoutProfile = await retrieveConnectedContextPack(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    const withProfile = await retrieveConnectedContextPack(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(withProfile.pack.diagnostics?.rankedCandidates).toEqual(
      withoutProfile.pack.diagnostics?.rankedCandidates ?? [],
    );
  });
});

describe("echoAnswerer", () => {
  it("summarises pack file count and paths deterministically", async () => {
    const pack: ConnectedContextPack = {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId: "pack-1",
      scope: happyScope(),
      query: happyQuery(),
      budget: {
        searchCallsMax: 1,
        filesReadMax: 1,
        excerptBytesMax: 1024,
        modelInputTokensMax: 1024,
        modelOutputTokensMax: 256,
        elapsedMsMax: 1000,
        rerankCallsMax: 0,
      },
      usage: {
        searchCalls: 0,
        filesRead: 0,
        excerptBytes: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
        elapsedMs: 0,
        rerankCalls: 0,
      },
      files: [
        {
          scopePath: "src/foo.ts",
          role: "read-only",
          selectionReason: "ranked by alpha",
          excerpts: [],
        },
      ],
      omitted: [],
      uncertainty: [],
      emittedAtMs: NOW,
      ledgerRef: undefined,
    };
    const out = await echoAnswerer.answer("what does MyClass do", pack);
    expect(out).toContain("Inspected 1 file(s)");
    expect(out).toContain("what does MyClass do");
    expect(out).toContain("src/foo.ts");
  });

  it("emits a (no evidence) marker when the pack carries no files", async () => {
    const pack: ConnectedContextPack = {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId: "pack-empty",
      scope: happyScope(),
      query: happyQuery(),
      budget: {
        searchCallsMax: 1,
        filesReadMax: 1,
        excerptBytesMax: 1024,
        modelInputTokensMax: 1024,
        modelOutputTokensMax: 256,
        elapsedMsMax: 1000,
        rerankCallsMax: 0,
      },
      usage: {
        searchCalls: 0,
        filesRead: 0,
        excerptBytes: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
        elapsedMs: 0,
        rerankCalls: 0,
      },
      files: [],
      omitted: [],
      uncertainty: [],
      emittedAtMs: NOW,
      ledgerRef: undefined,
    };
    const out = await echoAnswerer.answer("anything", pack);
    expect(out).toContain("(no evidence)");
  });
});

describe("retrieveConnectedContextPack (Epic #532 M1)", () => {
  it("produces the same pack runGroundedExploration produces for the same input+deps", async () => {
    const retrieved = await retrieveConnectedContextPack(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    const explored = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect({ ...explored.pack, uncertainty: retrieved.pack.uncertainty }).toStrictEqual(
      retrieved.pack,
    );
    expect(explored.pack.uncertainty).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "uncited-answer" })]),
    );
    expect(retrieved.plan).toStrictEqual(explored.plan);
    expect(retrieved.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("does NOT invoke the answerer (retrieval-only contract)", async () => {
    let answerCalls = 0;
    const countingAnswerer: GroundedAnswerer = {
      answer: (): Promise<string> => {
        answerCalls += 1;
        return Promise.resolve("should not run");
      },
    };
    await retrieveConnectedContextPack(input(), {
      correlationId: undefined,
      answerer: countingAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(answerCalls).toBe(0);
  });

  it("AC5: runGroundedExploration still returns identical pack and assistantContent", async () => {
    // Two independent runs over the same deterministic fixture must agree byte-for-byte on the
    // wire-observable fields, proving the retrieval/answer split did not perturb the single path.
    const first = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    const second = await runGroundedExploration(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      detectWorkspace: () => fakeWorkspace(),
    });
    expect(first.pack).toStrictEqual(second.pack);
    expect(first.assistantContent).toBe(second.assistantContent);
    expect(first.plan).toStrictEqual(second.plan);
  });

  it("propagates a cancelled signal without answering", async () => {
    const controller = new AbortController();
    controller.abort();
    let answerCalls = 0;
    const countingAnswerer: GroundedAnswerer = {
      answer: (): Promise<string> => {
        answerCalls += 1;
        return Promise.resolve("nope");
      },
    };
    await expect(
      retrieveConnectedContextPack(input(), {
        correlationId: undefined,
        answerer: countingAnswerer,
        nowMs: () => NOW,
        detectWorkspace: () => fakeWorkspace(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(answerCalls).toBe(0);
  });
});

describe("isSymbolDefinitionPath", () => {
  it.each([
    ["src/AppConfig.ts", "config"],
    ["src/SuperPaymentService.ts", "PaymentService"],
    ["nested/UserService.java", "Service"],
    ["nested/ErrorHandler.cs", "Handler"],
  ])("rejects basename suffix collision %s for %s", (scopePath, term) => {
    expect(isSymbolDefinitionPath(scopePath, term)).toBe(false);
  });

  it("accepts a code definition file matching term.<ext> at any depth, case-insensitively", () => {
    expect(isSymbolDefinitionPath("packages/core/src/PaymentService.tsx", "PaymentService")).toBe(
      true,
    );
    expect(isSymbolDefinitionPath("src/windowFrame.ts", "WindowFrame")).toBe(true);
    expect(isSymbolDefinitionPath("a/b/Foo.vue", "foo")).toBe(true);
    expect(
      isSymbolDefinitionPath("src/main/java/com/acme/PaymentService.java", "PaymentService"),
    ).toBe(true);
    expect(isSymbolDefinitionPath("app/payment_service.py", "payment_service")).toBe(true);
    expect(isSymbolDefinitionPath("cmd/api/payment_service.go", "payment_service")).toBe(true);
    expect(
      isSymbolDefinitionPath("backend/src/main/java/com/acme/OrderService.java", "OrderService"),
    ).toBe(true);
    expect(isSymbolDefinitionPath("services/api/order_service.py", "order_service")).toBe(true);
    expect(isSymbolDefinitionPath("cmd/orders/OrderService.go", "orderservice")).toBe(true);
    expect(isSymbolDefinitionPath("src/PaymentService.cs", "PaymentService")).toBe(true);
    expect(isSymbolDefinitionPath("crates/core/src/OrderService.rs", "OrderService")).toBe(true);
  });

  it("rejects co-named spec/story/non-code files the broad `**/term.*` glob over-matches", () => {
    // The single-walk regression guard: these must NOT be treated as the symbol's definition file.
    expect(isSymbolDefinitionPath("src/PaymentService.test.tsx", "PaymentService")).toBe(false);
    expect(isSymbolDefinitionPath("src/PaymentService.stories.tsx", "PaymentService")).toBe(false);
    expect(isSymbolDefinitionPath("docs/PaymentService.md", "PaymentService")).toBe(false);
    expect(isSymbolDefinitionPath("src/PaymentService.d.ts", "PaymentService")).toBe(false);
    expect(
      isSymbolDefinitionPath("src/test/java/com/acme/PaymentServiceTest.java", "PaymentService"),
    ).toBe(false);
  });
});

describe("clarificationUserMessage", () => {
  it("maps scope-empty to the 'nothing searchable' intro with no anchor hint", () => {
    const message = clarificationUserMessage(
      new ClarificationNeededError({
        reason: "scope-empty",
        suggestedQuestions: [],
        minimumAnchorCount: 1,
      }),
    );
    expect(message).toBe("Die verbundene Quelle enthält nichts Durchsuchbares.");
  });

  it("maps scope-invalid to the 'could not be searched' intro with no anchor hint", () => {
    const message = clarificationUserMessage(
      new ClarificationNeededError({
        reason: "scope-invalid",
        suggestedQuestions: [],
        minimumAnchorCount: 1,
      }),
    );
    expect(message).toBe("Die verbundene Quelle konnte nicht durchsucht werden.");
  });
});

// ─── #3347 P1: one request-wide directory snapshot for ring retrieval ─────────

interface RecordedDirectoryRead {
  readonly path: string;
  readonly maxEntries: number | undefined;
}

// A directory-only port. Ring retrieval asks the SAME directory for several different bounded
// listings in one request, and only `readDir` is under test here — every other operation stays the
// throwing port so an accidental widening of the wrapper surfaces as a failure. The port answers
// exactly the way the Node port does: a bounded read returns the first `maxEntries` entries.
function fanOutWorkspaceFs(
  _directory: string,
  entryCount: number,
  reads: RecordedDirectoryRead[],
): WorkspaceFs {
  const entryAt = (index: number): WorkspaceDirEntry => ({
    name: `entry-${String(index)}.ts`,
    isDirectory: false,
    isFile: true,
    isSymbolicLink: false,
  });
  return {
    ...throwingReadFs(),
    readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
      reads.push({ path: absolutePath, maxEntries });
      const served = maxEntries === undefined ? entryCount : Math.min(entryCount, maxEntries);
      return Array.from({ length: served }, (_value, index) => entryAt(index));
    },
  };
}

describe("ring-retrieval directory snapshot (#3347 P1)", () => {
  const DIRECTORY = "/workspace/wide";
  const SENTINEL = _RING_DISCOVERY_SENTINEL_ENTRIES_FOR_TESTS;

  it("answers every ring cap from ONE enumeration when the fan-out reaches the smallest cap", () => {
    const wrapped: RecordedDirectoryRead[] = [];
    const direct: RecordedDirectoryRead[] = [];
    // Above the smallest cap below, so the first consumer's listing comes back AT its cap — the
    // case the previous cache discarded and every later consumer then re-enumerated.
    const fanOut = 12_000;
    const ringFs = _ringDiscoveryFsForTests(fanOutWorkspaceFs(DIRECTORY, fanOut, wrapped));
    const unwrapped = fanOutWorkspaceFs(DIRECTORY, fanOut, direct);
    const caps: readonly (number | undefined)[] = [10_001, fanOut, 30_701, 100_001, undefined];

    for (const cap of caps) {
      // The expectation is the production port's own answer for the same cap, never a restated
      // slice rule: whatever a real read would return is what the snapshot has to return.
      expect(ringFs.readDir(DIRECTORY, cap)).toEqual(unwrapped.readDir(DIRECTORY, cap));
    }

    expect(wrapped).toEqual([{ path: DIRECTORY, maxEntries: SENTINEL + 1 }]);
    expect(direct).toHaveLength(caps.length);
  });

  it("re-reads rather than serving a subset when the request runs past an overflowed snapshot", () => {
    const wrapped: RecordedDirectoryRead[] = [];
    const ringFs = _ringDiscoveryFsForTests(fanOutWorkspaceFs(DIRECTORY, SENTINEL + 2, wrapped));

    expect(ringFs.readDir(DIRECTORY, SENTINEL + 1)).toHaveLength(SENTINEL + 1);
    // Beyond what the snapshot captured: the overflow bit says the snapshot cannot prove it holds
    // the whole directory, so the caller gets a real read instead of a silently truncated listing.
    expect(ringFs.readDir(DIRECTORY, undefined)).toHaveLength(SENTINEL + 2);
    expect(ringFs.readDir(DIRECTORY, SENTINEL + 2)).toHaveLength(SENTINEL + 2);

    expect(wrapped).toEqual([
      { path: DIRECTORY, maxEntries: SENTINEL + 1 },
      { path: DIRECTORY, maxEntries: undefined },
      { path: DIRECTORY, maxEntries: SENTINEL + 2 },
    ]);
  });

  // Measure every entry on the complete streaming port as well as the bounded snapshot read.
  // The separate sentinel+2 tests above pin cache overflow; streaming has no corpus cutoff.
  const WIDE_ROOT_ENTRY_COUNT = 12_000;

  it("enumerates a high-fan-out workspace root once, not once per ring consumer", async () => {
    const fixtureRoot = realpathSync(ROOT);
    writeFileSync(
      join(fixtureRoot, "package.json"),
      JSON.stringify({ name: "wide-root-fixture", version: "1.0.0" }),
    );
    for (let index = 0; index < WIDE_ROOT_ENTRY_COUNT; index += 1) {
      writeFileSync(join(fixtureRoot, `wide-${index.toString()}.txt`), "x");
    }
    const actualRootEntryCount = nodeWorkspaceFs.readDir(fixtureRoot).length;
    expect(actualRootEntryCount).toBeGreaterThan(WIDE_ROOT_ENTRY_COUNT);
    const rootReads: (number | undefined)[] = [];
    const rootStreams: { entries: number }[] = [];
    const iterate = nodeWorkspaceFs.iterateDirectory;
    if (iterate === undefined) throw new TypeError("Physical directory iteration is required.");
    const countingFs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path) {
        const observation = { entries: 0 };
        if (path === fixtureRoot) rootStreams.push(observation);
        for await (const entry of iterate(path)) {
          observation.entries += 1;
          yield entry;
        }
      },
      readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
        if (absolutePath === fixtureRoot) rootReads.push(maxEntries);
        return nodeWorkspaceFs.readDir(absolutePath, maxEntries);
      },
    };

    const out = await retrieveConnectedContextPack(
      input({
        workspaceRoot: fixtureRoot,
        scope: happyScope({
          workspaceRoot: fixtureRoot,
          kind: "workspace-root",
          relativePaths: [],
          explicitConnection: true,
        }),
        query: happyQuery({ text: "Trace MyClass implementations" }),
      }),
      { correlationId: undefined, answerer: echoAnswerer, nowMs: () => NOW, fs: countingFs },
    );

    expect(rootStreams).toHaveLength(2);
    for (const stream of rootStreams) {
      expect(stream.entries).toBe(actualRootEntryCount);
      expect(stream.entries).toBeGreaterThan(WIDE_ROOT_ENTRY_COUNT);
    }
    expect(out.pack.diagnostics?.coverage?.filesScanned).toBeGreaterThanOrEqual(
      WIDE_ROOT_ENTRY_COUNT,
    );
    expect(out.pack.diagnostics?.coverage?.maxFilesPrunedByDiscovery).toBe(0);
    expect(rootReads).toEqual([SENTINEL + 1]);
    expect(validateConnectedContextPack(out.pack).ok).toBe(true);
  }, 20_000);
});

// ─── #3347 P1: the pack cache key must describe the bytes that were actually read ─

interface CapturingMicroIndex {
  readonly index: MicroIndex;
  readonly publishedKeys: () => readonly string[];
  readonly entryFor: (key: string) => ConnectedContextPack | undefined;
}

// Records what a run publishes, and offers a seam at the exact point between the pre-read
// cache-identity capture and the excerpt reads: `cachedGroundedPack` performs the first micro-index
// read of a run, after the identity has been captured and before any excerpt byte is read.
function capturingMicroIndex(onFirstGet?: () => void): CapturingMicroIndex {
  const entries = new Map<string, ConnectedContextPack>();
  const published: string[] = [];
  let gets = 0;
  return {
    index: {
      get: (key): ConnectedContextPack | undefined => {
        gets += 1;
        if (gets === 1) onFirstGet?.();
        return entries.get(key);
      },
      set: (key, pack): void => {
        published.push(key);
        entries.set(key, pack);
      },
      delete: (key): void => {
        entries.delete(key);
      },
      clear: (): void => {
        entries.clear();
      },
      size: (): number => entries.size,
    },
    publishedKeys: (): readonly string[] => published,
    entryFor: (key): ConnectedContextPack | undefined => entries.get(key),
  };
}

describe("pack cache identity after the excerpt reads (#3347 P1)", () => {
  const REPLACEMENT_BODY =
    "export function MyClass() {\n  return 'replacement body';\n}\n// MyClass call site here\n";

  function excerptText(pack: ConnectedContextPack, scopePath: string): string {
    return (pack.files.find((file) => file.scopePath === scopePath)?.excerpts ?? [])
      .map((excerpt) => excerpt.content)
      .join("\n");
  }

  function retrieveWith(microIndex: MicroIndex): Promise<RetrievalOnlyOutput> {
    return retrieveConnectedContextPack(input(), {
      correlationId: undefined,
      answerer: echoAnswerer,
      nowMs: () => NOW,
      microIndex,
    });
  }

  it("never publishes a replacement's excerpt under the identity proven before the read", async () => {
    const stash = mkdtempSync(join(tmpdir(), "keiko-grounded-orch-stash-"));
    const target = join(ROOT, "src/foo.ts");
    const originalAside = join(stash, "original.ts");
    const replacementAside = join(stash, "replacement.ts");
    try {
      // A: the run that establishes what "src/foo.ts is cached" means.
      const clean = capturingMicroIndex();
      const first = await retrieveWith(clean.index);
      const identityKey = clean.publishedKeys()[0];
      expect(identityKey).toBeDefined();
      expect(excerptText(first.pack, "src/foo.ts")).toContain("foo body");

      // B: a replacement lands after the identity was captured and before the excerpt is read.
      // A rename gives the path a genuinely different file, exactly as a concurrent editor would.
      writeFileSync(replacementAside, REPLACEMENT_BODY);
      const poisoned = capturingMicroIndex(() => {
        renameSync(target, originalAside);
        renameSync(replacementAside, target);
      });
      const second = await retrieveWith(poisoned.index);
      // The run really did assemble the replacement's bytes — without this the rest is vacuous.
      expect(excerptText(second.pack, "src/foo.ts")).toContain("replacement body");
      expect(identityKey).toBeDefined();
      if (identityKey === undefined) throw new Error("unreachable");
      // …and published nothing under the original's identity, so restoring A cannot be answered
      // with B out of the micro-index.
      expect(poisoned.entryFor(identityKey)).toBeUndefined();
      expect(poisoned.publishedKeys()).not.toContain(identityKey);

      // A again: the restored original reads as itself, and the poisoned key is still absent.
      renameSync(target, replacementAside);
      renameSync(originalAside, target);
      const third = await retrieveWith(poisoned.index);
      expect(excerptText(third.pack, "src/foo.ts")).toContain("foo body");
      expect(poisoned.entryFor(identityKey)).toBeUndefined();
    } finally {
      rmSync(stash, { recursive: true, force: true });
    }
  });
});

// ─── #3347 P1: a result observed after the absolute deadline is not evidence ──

const EXCERPT_DEADLINE_AT_MS = NOW + 5_000;

const ZERO_EXPLORATION_USAGE = {
  searchCalls: 0,
  filesRead: 0,
  excerptBytes: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  elapsedMs: 0,
  rerankCalls: 0,
} as const;

interface ScriptedExcerptClockOptions {
  readonly lateMs?: number;
  // 1-based clock read from which the request is past its deadline.
  readonly crossAtClockRead?: number;
  // Move the deadline while the facade still holds the file open, so it stops its own read.
  readonly crossDuringContentRead?: boolean;
  // Leave the crossing disabled until `arm()` — used when the clock drives a whole request and only
  // the excerpt phase may move it.
  readonly startArmed?: boolean;
}

interface ScriptedExcerptClock {
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly clockReads: () => number;
  readonly arm: () => void;
}

function scriptedExcerptClock(options: ScriptedExcerptClockOptions): ScriptedExcerptClock {
  const lateMs = options.lateMs ?? EXCERPT_DEADLINE_AT_MS + 1_000;
  let armed = options.startArmed ?? true;
  let reads = 0;
  let late = false;
  const nowMs = (): number => {
    reads += 1;
    if (!late && armed && options.crossAtClockRead !== undefined) {
      late = reads >= options.crossAtClockRead;
    }
    return late ? lateMs : NOW;
  };
  const onContentRead = (): void => {
    if (armed && options.crossDuringContentRead === true) late = true;
  };
  const descriptorBytes = nodeWorkspaceFs.readFileBytes;
  const descriptorUtf8 = nodeWorkspaceFs.readFileUtf8SameDescriptor;
  const containedDescriptorUtf8 = nodeWorkspaceFs.readFileUtf8WithinRootSameDescriptor;
  return {
    nowMs,
    clockReads: (): number => reads,
    arm: (): void => {
      armed = true;
    },
    fs: {
      ...nodeWorkspaceFs,
      ...(descriptorBytes === undefined
        ? {}
        : {
            readFileBytes: async (
              absolutePath: string,
              maxBytes: number,
              hardLinkPolicy: WorkspaceHardLinkPolicy,
              expected: WorkspaceStat,
            ): Promise<Uint8Array> => {
              const bytes = await descriptorBytes(absolutePath, maxBytes, hardLinkPolicy, expected);
              onContentRead();
              return bytes;
            },
          }),
      ...(descriptorUtf8 === undefined
        ? {}
        : {
            readFileUtf8SameDescriptor: (
              absolutePath: string,
              maxBytes: number,
              hardLinkPolicy: WorkspaceHardLinkPolicy,
              expected: WorkspaceStat,
            ): WorkspaceDescriptorUtf8Read => {
              onContentRead();
              return descriptorUtf8(absolutePath, maxBytes, hardLinkPolicy, expected);
            },
          }),
      ...(containedDescriptorUtf8 === undefined
        ? {}
        : {
            readFileUtf8WithinRootSameDescriptor: (
              canonicalRoot: string,
              absolutePath: string,
              maxBytes: number,
              hardLinkPolicy: WorkspaceHardLinkPolicy,
              completeness: WorkspaceDescriptorReadCompleteness,
            ): WorkspaceDescriptorUtf8Read => {
              onContentRead();
              return containedDescriptorUtf8(
                canonicalRoot,
                absolutePath,
                maxBytes,
                hardLinkPolicy,
                completeness,
              );
            },
          }),
    },
  };
}

describe("excerpt reads past the absolute deadline (#3347 P1)", () => {
  function readOneExcerpt(clock: ScriptedExcerptClock): Promise<ExcerptReadSummary> {
    return _readKeptExcerptsForTests(["src/foo.ts"], {
      searchScope: { workspace: fakeWorkspace(), scopeId: "scope-1", relativePaths: ["src"] },
      fs: clock.fs,
      budget: DEFAULT_EXPLORATION_BUDGET,
      initialUsage: ZERO_EXPLORATION_USAGE,
      atomsByPath: new Map(),
      nowMs: clock.nowMs,
      signal: undefined,
      deadlineAtMs: EXCERPT_DEADLINE_AT_MS,
    });
  }

  function elapsedBudgetClaims(markers: readonly UncertaintyMarker[]): readonly string[] {
    return markers
      .filter((marker) => marker.kind === "budget-clipped")
      .map((marker) => marker.claim)
      .filter((claim) => claim.includes("elapsedMs"));
  }

  it("keeps the window of a read that finished inside the deadline", async () => {
    const summary = await readOneExcerpt(scriptedExcerptClock({}));

    expect(summary.excerpts.get("src/foo.ts")).toHaveLength(1);
    expect(summary.elapsedBudgetBlocked).toBe(false);
    expect(elapsedBudgetClaims(summary.uncertainty)).toEqual([]);
  });

  it("drops a window whose read only came back after the deadline", async () => {
    // Calibrated against the production step rather than a hardcoded call index: on the success
    // path the LAST clock read of the whole step is the deadline re-check taken once the facade has
    // already returned its result, so crossing exactly there is a read that completes just after
    // the deadline.
    const control = scriptedExcerptClock({});
    const clean = await readOneExcerpt(control);
    expect(clean.excerpts.get("src/foo.ts")).toHaveLength(1);

    const summary = await readOneExcerpt(
      scriptedExcerptClock({ crossAtClockRead: control.clockReads() }),
    );

    expect(summary.excerpts.size).toBe(0);
    expect(summary.elapsedBudgetBlocked).toBe(true);
    expect(elapsedBudgetClaims(summary.uncertainty).length).toBeGreaterThan(0);
  });

  it("reports a read the facade stopped on the elapsed budget as an elapsed-budget stop", async () => {
    const summary = await readOneExcerpt(scriptedExcerptClock({ crossDuringContentRead: true }));

    expect(summary.excerpts.size).toBe(0);
    expect(summary.elapsedBudgetBlocked).toBe(true);
    expect(elapsedBudgetClaims(summary.uncertainty).length).toBeGreaterThan(0);
  });

  it("reports the elapsed-budget stop on the completed retrieval status", async () => {
    // End to end: the completion status the activity log carries must not claim an unblocked
    // elapsed budget while the pack it describes lost its excerpts to that budget. The micro-index
    // read is the seam — it happens after the ring phase and immediately before the excerpt reads —
    // so no earlier phase can move this clock.
    const clock = scriptedExcerptClock({
      lateMs: NOW + 30_000,
      crossDuringContentRead: true,
      startArmed: false,
    });
    const cache = capturingMicroIndex(() => {
      clock.arm();
    });
    const activityLog = createBufferedServerLogSink();

    const out = await retrieveConnectedContextPack(
      input({ budget: { ...DEFAULT_EXPLORATION_BUDGET, elapsedMsMax: 30_000 } }),
      {
        correlationId: undefined,
        answerer: echoAnswerer,
        nowMs: clock.nowMs,
        microIndex: cache.index,
        fs: clock.fs,
        activityLog,
      },
    );

    expect(out.pack.files.flatMap((file) => file.excerpts)).toEqual([]);
    expect(out.pack.usage.excerptBytes).toBe(0);
    expect(elapsedBudgetClaims(out.pack.uncertainty).length).toBeGreaterThan(0);
    expect(
      activityLog.events.find((event) => event.op === "search.connected-context.completed")?.extra
        ?.retrievalElapsedBudgetBlocked,
    ).toBe(true);
  });
});
