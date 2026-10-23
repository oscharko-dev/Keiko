import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  type ExplorationBudget,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { normalizedExplicitReferencePath } from "./grounded-explicit-paths.js";

const ROOT = "/explicit-path-fixture";
const TARGET = "src/Form/feature/validation.ts";
const NOW = 1_700_000_000_000;
const WORKSPACE: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "explicit path fixture",
  version: undefined,
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: ["ignored/"],
};

interface FixtureOptions {
  readonly files?: Readonly<Record<string, string>>;
  readonly budget?: ExplorationBudget;
  readonly kind?: SelectedScope["kind"];
  readonly relativePaths?: readonly string[];
}

async function retrieve(
  text: string,
  options: FixtureOptions = {},
): Promise<{
  readonly output: Awaited<ReturnType<typeof retrieveConnectedContextPack>>;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
}> {
  const log = createBufferedServerLogSink();
  const output = await retrieveConnectedContextPack(
    {
      workspaceRoot: ROOT,
      scope: {
        schemaVersion: "1",
        scopeId: "explicit-path-fixture",
        workspaceRoot: ROOT,
        kind: options.kind ?? "workspace-root",
        relativePaths: options.relativePaths ?? [],
        conversationId: undefined,
        connectedAtMs: NOW,
        explicitConnection: true,
      },
      query: {
        kind: "natural-language",
        text,
        caseSensitive: false,
        maxResults: 50,
        emittedAtMs: NOW,
      },
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    },
    {
      correlationId: "explicit-path-admission-0001",
      activityLog: log,
      fs: memFs(ROOT, options.files ?? { [TARGET]: "export const requirement = true;\n" }),
      detectWorkspace: (): WorkspaceInfo => WORKSPACE,
      nowMs: (): number => NOW,
      answerer: { answer: (): Promise<string> => Promise.resolve("") },
    },
  );
  return { output, log };
}

describe("query-named explicit path admission", () => {
  it.each([
    ["README.md", 0],
    ["README.md", 3],
    ["README.md", 6],
    ["docs/accepted.md", 0],
    ["docs/accepted.md", 3],
    ["docs/accepted.md", 6],
  ] as const)(
    "admits every requested file with %s at position %s beyond the planning reference preview",
    async (requirementsPath, position) => {
      const sources = Array.from({ length: 6 }, (_, index) => `frontend/source${String(index)}.ts`);
      const paths = [...sources.slice(0, position), requirementsPath, ...sources.slice(position)];
      const { output, log } = await retrieve(`Generate tests using ${paths.join(", ")}.`, {
        files: {
          ...Object.fromEntries(sources.map((path) => [path, "export const value = 7;\n"])),
          [requirementsPath]: "Accepted behavior: only the submit control is disabled.\n",
        },
      });
      expect(output.pack.files.map((file) => file.scopePath)).toEqual(
        expect.arrayContaining(paths),
      );
      expect(
        output.pack.files.find((file) => file.scopePath === requirementsPath)?.excerpts[0]?.content,
      ).toContain("only the submit control is disabled");
      expect(
        log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
      ).toMatchObject({
        referenceChannelCount: 6,
        explicitPathAdmittedCount: paths.length,
        explicitPathRejectedCount: 0,
      });
      expect(JSON.stringify(log.events)).not.toContain(requirementsPath);
    },
  );

  it.each([{ filesReadMax: 6 }, { searchCallsMax: 6 }, { excerptBytesMax: 64 }])(
    "retains the actual grant when explicit references exceed the preview: %j",
    async (limit) => {
      const paths = Array.from({ length: 7 }, (_, index) => `src/source${String(index)}.ts`);
      const budget = { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 20, ...limit };
      const { output } = await retrieve(`Generate tests using ${paths.join(", ")}.`, {
        files: Object.fromEntries(paths.map((path) => [path, "export const requiredValue = 7;\n"])),
        budget,
      });
      expect(output.pack.usage.filesRead).toBeLessThanOrEqual(budget.filesReadMax);
      expect(output.pack.usage.searchCalls).toBeLessThanOrEqual(budget.searchCallsMax);
      expect(output.pack.usage.excerptBytes).toBeLessThanOrEqual(budget.excerptBytesMax);
      expect(output.pack.uncertainty.some((marker) => marker.kind === "budget-clipped")).toBe(true);
      const unread = paths.filter(
        (path) => !output.pack.files.some((file) => file.scopePath === path),
      );
      expect(unread.length).toBeGreaterThan(0);
      for (const path of unread)
        expect(output.pack.omitted).toContainEqual({
          scopePath: path,
          reason: "budget-exhausted",
          omittedAtMs: NOW,
        });
    },
  );

  it.each([
    [".env", "denied"],
    ["../outside.ts", "outside-scope"],
    ["ignored/hidden.ts", "ignored"],
    ["dist/generated.ts", "generated"],
  ])(
    "rejects the seventh named path %s through the existing admission policy",
    async (path, reason) => {
      const sources = Array.from({ length: 6 }, (_, index) => `src/source${String(index)}.ts`);
      const { output, log } = await retrieve(
        `Generate tests using ${[...sources, path].join(", ")}.`,
        {
          files: {
            ...Object.fromEntries(sources.map((source) => [source, "export const value = 7;\n"])),
            [path]: "private rejected fixture text",
          },
        },
      );
      expect(output.pack.files.map((file) => file.scopePath)).not.toContain(path);
      expect(JSON.stringify(output.pack)).not.toContain("private rejected fixture text");
      expect(
        log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
      ).toMatchObject({ explicitPathRejectedCount: 1, explicitPathRejectionReasons: [reason] });
    },
  );

  it("reports an exhausted search grant before discovering an overflow basename", async () => {
    const paths = Array.from({ length: 6 }, (_, index) => `src/source${String(index)}.ts`);
    const { output } = await retrieve(
      `Generate tests using ${[...paths, "README.md"].join(", ")}.`,
      {
        files: {
          ...Object.fromEntries(paths.map((path) => [path, "export const requiredValue = 7;\n"])),
          "README.md": "Accepted behavior: preserve customer input.\n",
        },
        budget: { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: 6 },
      },
    );
    expect(output.pack.usage.searchCalls).toBeLessThanOrEqual(6);
    expect(output.pack.files.map((file) => file.scopePath)).not.toContain("README.md");
    expect(output.pack.uncertainty.some((marker) => marker.kind === "budget-clipped")).toBe(true);
  });

  it("canonicalizes a leading current-directory segment before strict literal-at path admission", async () => {
    const path = "@src/checker.ts";
    const { output, log } = await retrieve(`Explain ./@src/checker.ts`, {
      files: { [path]: "export const checker = 937;\n" },
    });
    expect(output.pack.files.map((file) => file.scopePath)).toContain(path);
    expect(
      log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
    ).toMatchObject({ explicitPathAdmittedCount: 1, explicitPathRejectedCount: 0 });
  });

  it.each(["./../outside.ts", "././../outside.ts", "./.env", "src/./checker.ts"])(
    "preserves strict parent/interior validation and canonical sensitive names: %s",
    (path) => {
      const normalized = normalizedExplicitReferencePath({ path, origin: "query" }, ROOT);
      if (path === "./.env") expect(normalized).toBe(".env");
      else expect(normalized).toBeUndefined();
    },
  );
  it("formats correlated content-free admission and read evidence", async () => {
    const { log } = await retrieve(`Why does ${TARGET}:1 fail?`);
    const source = log.events.find(
      (event) => event.op === "search.connected-context.source-details",
    );
    const completed = log.events.find((event) => event.op === "search.connected-context.completed");
    expect(source?.correlationId).toBe(completed?.correlationId);
    const line = formatActivityLogProofLine(source ?? {});
    expect(line).not.toContain(TARGET);
    expectActivityLogProof("search.connected-context.explicit-admission.line", line);
  });
  it.each([TARGET, `${TARGET}:301:5`, `${ROOT}/${TARGET}`, `file://${ROOT}/${TARGET}:301:5`])(
    "reads the case-preserving named path without a content match: %s",
    async (path) => {
      const { output, log } = await retrieve(`Why does ${path} fail?`);
      expect(output.pack.files.map((file) => file.scopePath)).toContain(TARGET);
      expect(output.pack.files[0]?.excerpts[0]?.content).toContain("requirement = true");
      expect(
        log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
      ).toMatchObject({ explicitPathAdmittedCount: 1, explicitPathRejectedCount: 0 });
    },
  );

  it("centres the excerpt on a named physical source line", async () => {
    const content = "// unrelated padding\n".repeat(300) + "export const selectedFact = 73;\n";
    const { output, log } = await retrieve(`Why does ${TARGET}:301:5 fail?`, {
      files: { [TARGET]: content },
      budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 512 },
    });
    const excerpt = output.pack.files.find((file) => file.scopePath === TARGET)?.excerpts[0];
    expect(excerpt?.content).toContain("selectedFact = 73");
    expect(excerpt?.atom.lineRange?.startLine).toBeLessThanOrEqual(301);
    expect(excerpt?.atom.lineRange?.endLine).toBeGreaterThanOrEqual(301);
    expect(
      log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
    ).toMatchObject({ explicitLineHintCount: 1 });
    expect(
      log.events.find((event) => event.op === "search.connected-context.completed")?.extra,
    ).toMatchObject({ excerptAnchoredWindowCount: 1 });
  });

  it.each([
    { path: "../outside/file.ts", reason: "outside-scope" },
    { path: "/different-scope/file.ts", reason: "outside-scope" },
    { path: "missing/file.ts", reason: "missing" },
    { path: ".env", reason: "denied" },
    { path: "ignored/file.ts", reason: "ignored" },
    { path: "dist/file.js", reason: "generated" },
  ])("rejects a $reason path before injecting evidence", async ({ path, reason }) => {
    const { output, log } = await retrieve(`Why does ${path} fail?`, {
      files: { "ignored/file.ts": "ignored body", "dist/file.js": "generated body" },
    });
    expect(output.pack.files.map((file) => file.scopePath)).not.toContain(path);
    expect(
      log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
    ).toMatchObject({ explicitPathRejectedCount: 1, explicitPathRejectionReasons: [reason] });
    expect(JSON.stringify(log.events)).not.toContain(path);
  });

  it("retains the existing human Files-scope exemption for safe ignored files", async () => {
    const path = "ignored/file.ts";
    const { output } = await retrieve("Explain the selected file", {
      files: { [path]: "export const selectedFact = 73;\n" },
      kind: "files",
      relativePaths: [path],
    });
    expect(output.pack.files.map((file) => file.scopePath)).toEqual([path]);
  });

  it.each(["ignored/selected.ts", "selected.ts"])(
    "reports a human-selected ignored file as admitted when named: %s",
    async (name) => {
      const path = "ignored/selected.ts";
      const { output, log } = await retrieve(`Explain ${name}`, {
        files: { [path]: "export const selectedFact = 73;\n" },
        kind: "files",
        relativePaths: [path],
      });
      expect(output.pack.files.map((file) => file.scopePath)).toEqual([path]);
      expect(output.pack.omitted).not.toContainEqual(expect.objectContaining({ scopePath: path }));
      expect(
        log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
      ).toMatchObject({ explicitPathAdmittedCount: 1, explicitPathRejectedCount: 0 });
    },
  );

  it("reports unread admitted explicit files under a finite read budget", async () => {
    const other = "src/Form/other/validation.ts";
    const { output, log } = await retrieve(`Why do ${TARGET} and ${other} fail?`, {
      files: {
        [TARGET]: "export const firstFact = 73;\n",
        [other]: "export const secondFact = 81;\n",
      },
      budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 1 },
    });
    expect(output.pack.files).toHaveLength(1);
    const unread = [TARGET, other].filter(
      (path) => !output.pack.files.some((file) => file.scopePath === path),
    );
    expect(unread).toHaveLength(1);
    expect(output.pack.omitted).toContainEqual({
      scopePath: unread[0],
      reason: "budget-exhausted",
      omittedAtMs: NOW,
    });
    expect(
      log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
    ).toMatchObject({ explicitPathAdmittedCount: 2, explicitPathRejectedCount: 0 });
  });
});
