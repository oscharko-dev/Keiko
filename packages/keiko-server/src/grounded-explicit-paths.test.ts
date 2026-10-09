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
