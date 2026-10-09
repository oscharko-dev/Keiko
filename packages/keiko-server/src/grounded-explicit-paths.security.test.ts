import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  type ExplorationBudget,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  DEFAULT_SEARCH_LIMITS,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { INCIDENT_RETRIEVAL_FILES } from "../../../scripts/check-retrieval-quality.mjs";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";

const NOW = 1_700_000_000_000;
const TARGET = "src/Feature/validation.ts";
const PRIVATE_BODY = "PRIVATE_REJECTED_FILE_BODY";
let root = "";
let outside = "";

interface RetrievalOptions {
  readonly fs?: WorkspaceFs;
  readonly budget?: ExplorationBudget;
  readonly kind?: SelectedScope["kind"];
  readonly relativePaths?: readonly string[];
}

function workspace(): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "explicit-path security fixture",
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: ["ignored/"],
  };
}

function request(text: string, options: RetrievalOptions): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "explicit-path-security",
      workspaceRoot: root,
      kind: options.kind ?? "workspace-root",
      relativePaths: options.relativePaths ?? [],
      conversationId: "security-chat",
      connectedAtMs: NOW,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text,
      caseSensitive: false,
      maxResults: 100,
      emittedAtMs: NOW,
    },
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  };
}

async function retrieve(
  text: string,
  options: RetrievalOptions = {},
): Promise<{
  readonly output: Awaited<ReturnType<typeof retrieveConnectedContextPack>>;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
}> {
  const log = createBufferedServerLogSink();
  const output = await retrieveConnectedContextPack(request(text, options), {
    correlationId: "explicit-path-security-0001",
    activityLog: log,
    fs: options.fs ?? nodeWorkspaceFs,
    detectWorkspace: workspace,
    nowMs: (): number => NOW,
    answerer: { answer: (): Promise<string> => Promise.resolve("") },
  });
  return { output, log };
}

function writeFixture(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function watchedSyncReads(fs: WorkspaceFs, reads: string[]): void {
  vi.spyOn(fs, "readFileUtf8").mockImplementation((path): string => {
    reads.push(path);
    return nodeWorkspaceFs.readFileUtf8(path);
  });
  const descriptor = nodeWorkspaceFs.readFileUtf8SameDescriptor;
  if (descriptor !== undefined) {
    vi.spyOn(fs, "readFileUtf8SameDescriptor").mockImplementation((...args) => {
      reads.push(args[0]);
      return descriptor(...args);
    });
  }
  const prefix = nodeWorkspaceFs.readFileUtf8Prefix;
  if (prefix !== undefined) {
    vi.spyOn(fs, "readFileUtf8Prefix").mockImplementation((...args): string => {
      reads.push(args[0]);
      return prefix(...args);
    });
  }
}

function watchedFs(reads: string[]): WorkspaceFs {
  const fs = { ...nodeWorkspaceFs };
  watchedSyncReads(fs, reads);
  const bytes = nodeWorkspaceFs.readFileBytes;
  if (bytes !== undefined) {
    vi.spyOn(fs, "readFileBytes").mockImplementation((...args): Promise<Uint8Array> => {
      reads.push(args[0]);
      return bytes(...args);
    });
  }
  const openReader = nodeWorkspaceFs.openFileReader;
  if (openReader !== undefined) {
    vi.spyOn(fs, "openFileReader").mockImplementation((...args) => {
      reads.push(args[0]);
      return openReader(...args);
    });
  }
  return fs;
}

function expectPrivateRejection(
  result: Awaited<ReturnType<typeof retrieve>>,
  path: string,
  reason: string,
): void {
  expect(result.output.pack.files.map((file) => file.scopePath)).not.toContain(path);
  const sourceDetails = result.log.events.find(
    (event) => event.op === "search.connected-context.source-details",
  );
  expect(sourceDetails?.extra).toMatchObject({
    explicitPathRejectedCount: 1,
    explicitPathRejectionReasons: [reason],
  });
  const persisted = JSON.stringify(result.log.events);
  expect(persisted).not.toContain(path);
  expect(persisted).not.toContain(PRIVATE_BODY);
}

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-explicit-security-"));
  outside = mkdtempSync(join(tmpdir(), "keiko-explicit-outside-"));
  writeFixture(TARGET, "export const retainedFact = 73;\n");
});

afterEach((): void => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("explicit-path trust boundary", () => {
  it.each([
    { kind: "escaping", reason: "outside-scope" },
    { kind: "dangling", reason: "missing" },
    { kind: "denied-alias", reason: "denied" },
    { kind: "hard-link", reason: "outside-scope" },
  ])(
    "rejects $kind without reading its target or failing the retrieval",
    async ({ kind, reason }) => {
      const path = "src/alias.ts";
      writeFileSync(join(outside, "target.ts"), PRIVATE_BODY);
      writeFixture(".env", PRIVATE_BODY);
      if (kind === "hard-link") linkSync(join(outside, "target.ts"), join(root, path));
      else
        symlinkSync(
          kind === "denied-alias"
            ? join(root, ".env")
            : join(outside, kind === "dangling" ? "missing.ts" : "target.ts"),
          join(root, path),
        );
      const reads: string[] = [];
      const result = await retrieve(`Explain ${path}`, { fs: watchedFs(reads) });
      expectPrivateRejection(result, path, reason);
      expect(reads).not.toContain(join(root, path));
      expect(reads).not.toContain(join(root, ".env"));
      expect(reads).not.toContain(join(outside, "target.ts"));
    },
  );

  it("rejects a file under a symlinked parent directory without target reads", async () => {
    writeFileSync(join(outside, "target.ts"), PRIVATE_BODY);
    symlinkSync(outside, join(root, "linked"));
    const reads: string[] = [];
    const result = await retrieve("Explain linked/target.ts", { fs: watchedFs(reads) });
    expectPrivateRejection(result, "linked/target.ts", "outside-scope");
    expect(reads).not.toContain(join(outside, "target.ts"));
  });

  it.each([
    { path: "src/oversized.ts", reason: "size-exceeded" },
    { path: "docs/unsupported.ppt", reason: "unsupported-format" },
    { path: ".env", reason: "denied" },
  ])("rejects $reason before content reads", async ({ path, reason }) => {
    writeFixture(
      path,
      reason === "size-exceeded"
        ? new Uint8Array(DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned + 1)
        : PRIVATE_BODY,
    );
    const reads: string[] = [];
    const result = await retrieve(`Explain ${path}`, { fs: watchedFs(reads) });
    expectPrivateRejection(result, path, reason);
    expect(reads).not.toContain(join(root, path));
  });

  it("classifies binary content without admitting or exposing it", async () => {
    const path = "src/binary.ts";
    writeFixture(path, Buffer.from(PRIVATE_BODY + "\u0000".repeat(32)));
    const result = await retrieve(`Explain ${path}`);
    expectPrivateRejection(result, path, "binary");
    expect(result.output.pack.files.flatMap((file) => file.excerpts)).not.toContainEqual(
      expect.objectContaining({ content: PRIVATE_BODY }),
    );
  });

  it.each([
    { kind: "directory" as const, paths: ["src/Feature"], rejected: "src/FeatureOther/other.ts" },
    { kind: "files" as const, paths: [TARGET], rejected: "src/Feature/other.ts" },
  ])("enforces the selected $kind boundary with segment-aware matching", async (fixture) => {
    writeFixture(fixture.rejected, PRIVATE_BODY);
    const reads: string[] = [];
    const result = await retrieve(`Explain ${fixture.rejected}`, {
      fs: watchedFs(reads),
      kind: fixture.kind,
      relativePaths: fixture.paths,
    });
    expectPrivateRejection(result, fixture.rejected, "outside-scope");
    expect(reads).not.toContain(join(root, fixture.rejected));
  });

  it("keeps query ignore rules while preserving a human Files selection", async () => {
    const path = "ignored/selected.ts";
    writeFixture(path, "export const manuallySelectedFact = 19;\n");
    expectPrivateRejection(await retrieve(`Explain ${path}`), path, "ignored");
    const selected = await retrieve("Explain this selected file", {
      kind: "files",
      relativePaths: [path],
    });
    expect(selected.output.pack.files.map((file) => file.scopePath)).toEqual([path]);
  });
});

describe("bounded explicit basename discovery", () => {
  it("caps discovery deterministically when more than ninety-six matches exist", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 100 }, (_value, index) => [
        `src/directory-${String(index).padStart(3, "0")}/probe.ts`,
        `export const fact${String(index)} = ${String(index)};\n`,
      ]),
    );
    const first = await retrieve("Explain probe.ts", { fs: memFs(root, files) });
    const second = await retrieve("Explain probe.ts", { fs: memFs(root, files) });
    for (const result of [first, second]) {
      expect(
        result.log.events.find((event) => event.op === "search.connected-context.source-details")
          ?.extra,
      ).toMatchObject({
        basenameDiscoveryTermCount: 1,
        basenameDiscoveryMatchCount: 96,
        explicitPathAdmittedCount: 96,
      });
    }
    expect(first.output.pack.files.map((file) => file.scopePath)).toEqual(
      second.output.pack.files.map((file) => file.scopePath),
    );
  });

  it("preserves all five incident matches without admitting generated dependencies", async () => {
    const result = await retrieve("Explain validation.ts", {
      fs: memFs(root, INCIDENT_RETRIEVAL_FILES),
    });
    const paths = result.output.pack.files.map((file) => file.scopePath);
    expect(paths).toEqual(
      expect.arrayContaining([
        "src/form/busObj/feature/feature-conditions/validation.ts",
        "src/form/factories/field-date/validation.ts",
        "src/form/factories/field-numeric/validation.ts",
        "src/form/factories/field-binary-choice/validation.ts",
        "src/form/busObj/other/other-conditions/validation.ts",
      ]),
    );
    expect(paths.some((path) => path.includes("node_modules") || path.startsWith("dist/"))).toBe(
      false,
    );
    expect(result.output.pack.omitted.filter((entry) => paths.includes(entry.scopePath))).toEqual(
      [],
    );
    expect(
      result.log.events.find((event) => event.op === "search.connected-context.source-details")
        ?.extra,
    ).toMatchObject({
      basenameDiscoveryTermCount: 1,
      basenameDiscoveryMatchCount: 5,
      explicitPathAdmittedCount: 5,
    });
  });

  it("reports every admitted but unread basename under a one-file grant", async () => {
    const files = {
      "src/a/probe.ts": "export const first = 1;",
      "src/b/probe.ts": "export const second = 2;",
    };
    const result = await retrieve("Explain probe.ts", {
      fs: memFs(root, files),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 1 },
    });
    expect(result.output.pack.files).toHaveLength(1);
    const unread = Object.keys(files).find(
      (path) => !result.output.pack.files.some((file) => file.scopePath === path),
    );
    expect(unread).toBeDefined();
    expect(result.output.pack.omitted).toContainEqual({
      scopePath: unread,
      reason: "budget-exhausted",
      omittedAtMs: NOW,
    });
  });
});
